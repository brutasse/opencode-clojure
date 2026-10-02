/**
 * OpenCode plugin: automatic Clojure delimiter repair + nREPL evaluation
 * (self-contained).
 *
 * Delimiter repair runs in-process through the `parinfer` npm package
 * (`indentMode`, Parinfer's indent mode). Formatting runs `cljfmt`
 * directly when it is on
 * PATH (`cljfmt fix -`, stdin to stdout) and is skipped otherwise. The
 * `clojure-nrepl-eval` tool evaluates code against the project's nREPL
 * server through an in-process bencode client (persistent session per
 * host:port); the same repair gate runs on eval code before evaluation.
 * No babashka, no external repair tool.
 *
 * Behavior:
 * - write: content is repaired (and formatted, if cljfmt is available)
 *          before it hits disk; the write is rejected (Tool.Error) when the
 *          content cannot be fixed. When the content was modified, the tool
 *          result carries a change note with the current on-disk content so
 *          the model does not act on a stale view of the file.
 * - edit:  the file is backed up in memory before the edit; after the edit
 *          the on-disk file is repaired/formatted, and the backup is
 *          restored when it cannot be fixed. When the file was modified,
 *          the tool result carries a change note (current content for small
 *          files, a line diff for large ones).
 * - patch: the same per-file flow for the patch tool
 *          (*** Add/Update/Move/Delete File: ops).
 *
 * Balanced code is never touched: a small Clojure-aware scanner
 * (hasDelimiterError) gates the repair engine so balanced files - including
 * valid code with tricky content like char literals - are left alone. When
 * repair or formatting fails for any reason the operation proceeds
 * un-repaired (fail open).
 */

import net from "node:net";
import path from "node:path";
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { Plugin } from "@opencode/plugin";
import { Error as ToolError } from "@opencode/plugin/promise/tool";
import parinfer from "parinfer";

// ============================================================================
// Delimiter balance check (pre-gate for the repair engine)
// ============================================================================

// Scans Clojure source for delimiter imbalance: an unmatched or mismatched
// ()[]{} delimiter, or an unterminated string / regex literal. String
// literals (including multi-line), char literals (like \( and \space),
// line comments (;), and regex literals are skipped. A false negative
// leaves a broken file un-repaired (safe); a false positive would send
// balanced code to the repair engine, so the scanner errs on the side of
// recognizing balanced constructs.
export function hasDelimiterError(text: string): boolean {
  const closingFor = new Map<string, string>([
    [")", "("],
    ["]", "["],
    ["}", "{"],
  ]);
  const stack: string[] = [];
  let inString = false;
  let inRegex = false;
  let inComment = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inComment) {
      if (c === "\n") inComment = false;
    } else if (inString || inRegex) {
      if (c === "\\") i++; // skip the escaped character
      else if (c === '"') {
        inString = false;
        inRegex = false;
      }
    } else if (c === '"') {
      inString = true;
    } else if (c === ";") {
      inComment = true;
    } else if (c === "#" && text[i + 1] === '"') {
      inRegex = true;
      i++;
    } else if (c === "\\") {
      i++; // skip the char literal (\(, \", \newline, ...)
    } else if (c === "(" || c === "[" || c === "{") {
      stack.push(c);
    } else if (closingFor.has(c)) {
      if (stack.pop() !== closingFor.get(c)) return true;
    }
  }
  return stack.length > 0 || inString || inRegex;
}

// ============================================================================
// Repair backend (parinfer, npm - indent mode, in-process)
// ============================================================================

export type RepairResult =
  | { status: "repaired"; text: string } // engine ran; text may equal the input
  | { status: "unfixable"; message: string } // engine reported an error (e.g. unclosed string)
  | { status: "error"; message: string }; // unexpected failure

export function repairText(text: string): RepairResult {
  try {
    const out = parinfer.indentMode(text);
    if (out.error) return { status: "unfixable", message: String(out.error.message ?? out.error) };
    return { status: "repaired", text: out.text };
  } catch (e) {
    return { status: "error", message: String(e) };
  }
}

// ============================================================================
// Optional cljfmt formatting (direct invocation, no babashka)
// ============================================================================

const CLJFMT_TIMEOUT_MS = 30_000;

// One-shot PATH lookup result: undefined = not resolved yet, null = absent.
let cljfmtPath: string | null | undefined;

export function resolveCljfmt(): string | null {
  if (cljfmtPath !== undefined) return cljfmtPath;
  const name = process.platform === "win32" ? "cljfmt.exe" : "cljfmt";
  let found: string | null = null;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        found = candidate;
        break;
      }
    } catch {
      // unreadable PATH entry: skip
    }
  }
  cljfmtPath = found;
  return found;
}

function runCljfmt(bin: string, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    const finish = (err?: Error, out?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(out!);
    };
    const child = spawn(bin, ["fix", "-"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, CLJFMT_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (err) => finish(err));
    child.on("close", (code) => {
      if (timedOut) return finish(new Error(`cljfmt timed out after ${CLJFMT_TIMEOUT_MS}ms`));
      if (code !== 0) return finish(new Error(`cljfmt exited ${code}: ${stderr.trim().slice(0, 200)}`));
      finish(undefined, stdout);
    });
    child.stdin.write(text);
    child.stdin.end();
  });
}

export async function formatWithCljfmt(text: string): Promise<string> {
  const bin = resolveCljfmt();
  if (!bin) return text; // no cljfmt on PATH: repair only
  try {
    return await runCljfmt(bin, text);
  } catch (e) {
    console.warn(`[opencode-clojure] cljfmt failed, content left unformatted: ${String(e)}`);
    return text; // fail open
  }
}

// Hook callbacks run against these so tests can substitute fakes.
const defaultRepairImpl = (text: string): Promise<RepairResult> => Promise.resolve(repairText(text));
let repairImpl: (text: string) => Promise<RepairResult> = defaultRepairImpl;
let formatImpl: (text: string) => Promise<string> = formatWithCljfmt;
export const _internals = {
  setRepair(fn?: (text: string) => Promise<RepairResult>) {
    repairImpl = fn ?? defaultRepairImpl;
  },
  setFormat(fn?: (text: string) => Promise<string>) {
    formatImpl = fn ?? formatWithCljfmt;
  },
  resetCljfmtCache() {
    cljfmtPath = undefined;
  },
  resetNreplPool() {
    closeAllTargets();
    targets.clear();
  },
  dropNreplConnection(host: string, port: number) {
    const target = targets.get(`${host}:${port}`);
    target?.socket?.close();
    if (target) target.socket = null;
  },
};

// ============================================================================
// nREPL client (bencode wire protocol, in-process)
//
// nREPL speaks self-delimiting bencode messages over TCP (no length
// framing). This client implements the ops the plugin needs: clone
// (persistent session), ls-sessions (session validation), eval, interrupt
// (timeout), and close (plugin unload). Responses are matched by the
// request's "id"; a request completes when a response's "status" list
// contains "done".
// ============================================================================

const NREPL_CONNECT_TIMEOUT_MS = 2_000;
const NREPL_SESSION_TIMEOUT_MS = 5_000;
export const NREPL_DEFAULT_TIMEOUT_MS = 120_000;
const NREPL_TRACE_LIMIT = 4_000;

export type BencodeValue = string | number | BencodeValue[] | { [key: string]: BencodeValue };

// Bencode map keys must be sorted lexicographically by byte value.
function sortEntries(entries: [string, unknown][]): [string, unknown][] {
  return entries.sort((a, b) => {
    const ka = Buffer.from(a[0], "utf8");
    const kb = Buffer.from(b[0], "utf8");
    for (let i = 0; i < Math.min(ka.length, kb.length); i++) {
      if (ka[i] !== kb[i]) return ka[i] - kb[i];
    }
    return ka.length - kb.length;
  });
}

export function writeBencode(value: unknown): Buffer {
  if (typeof value === "string") {
    return Buffer.concat([
      Buffer.from(`${Buffer.byteLength(value, "utf8")}:`, "utf8"),
      Buffer.from(value, "utf8"),
    ]);
  }
  if (typeof value === "number") {
    return Buffer.from(`i${Math.trunc(value)}e`, "utf8");
  }
  if (Array.isArray(value)) {
    return Buffer.concat([
      Buffer.from("l", "utf8"),
      Buffer.concat(value.map((item) => writeBencode(item))),
      Buffer.from("e", "utf8"),
    ]);
  }
  if (value !== null && typeof value === "object") {
    const parts: Buffer[] = [Buffer.from("d", "utf8")];
    for (const [key, item] of sortEntries(Object.entries(value as Record<string, unknown>))) {
      parts.push(writeBencode(key), writeBencode(item));
    }
    parts.push(Buffer.from("e", "utf8"));
    return Buffer.concat(parts);
  }
  throw new Error(`nrepl: cannot bencode value of type ${typeof value}`);
}

// Parses one bencode value starting at `pos`. Returns the value and the
// position just past it, or null when the buffer holds an incomplete value.
export function readBencode(buf: Buffer, pos: number): [BencodeValue, number] | null {
  const c = buf[pos];
  if (c === undefined) return null; // empty buffer: need more data
  if (c === 0x64) {
    // map
    const out: Record<string, BencodeValue> = {};
    let p = pos + 1;
    for (;;) {
      if (p >= buf.length) return null;
      if (buf[p] === 0x65) return [out, p + 1]; // 'e'
      const key = readBencode(buf, p);
      if (key === null) return null;
      if (typeof key[0] !== "string") throw new Error("nrepl: bencode map key must be a string");
      const item = readBencode(buf, key[1]);
      if (item === null) return null;
      out[key[0]] = item[0];
      p = item[1];
    }
  }
  if (c === 0x6c) {
    // list
    const out: BencodeValue[] = [];
    let p = pos + 1;
    for (;;) {
      if (p >= buf.length) return null;
      if (buf[p] === 0x65) return [out, p + 1]; // 'e'
      const item = readBencode(buf, p);
      if (item === null) return null;
      out.push(item[0]);
      p = item[1];
    }
  }
  if (c === 0x69) {
    // integer: i<digits>e (the terminator is the first non-digit byte)
    let end = pos + 1;
    while (end < buf.length && buf[end] >= 0x30 && buf[end] <= 0x39) end++;
    if (end >= buf.length) return null;
    if (buf[end] !== 0x65) throw new Error("nrepl: malformed bencode integer");
    return [Number.parseInt(buf.subarray(pos + 1, end).toString("utf8"), 10), end + 1];
  }
  if (c >= 0x30 && c <= 0x39) {
    // string: <decimal byte length>:<bytes>
    const colon = buf.indexOf(0x3a, pos);
    if (colon < 0) return null;
    const len = Number.parseInt(buf.subarray(pos, colon).toString("utf8"), 10);
    const start = colon + 1;
    if (start + len > buf.length) return null;
    return [buf.subarray(start, start + len).toString("utf8"), start + len];
  }
  throw new Error(`nrepl: unexpected bencode byte 0x${c.toString(16)}`);
}

interface PendingRequest {
  msgs: Record<string, BencodeValue>[];
  resolve: (msgs: Record<string, BencodeValue>[]) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  abortSignal?: AbortSignal;
  onAbort?: () => void;
}

class NreplSocket {
  readonly host: string;
  readonly port: number;
  closed = false;
  private socket: net.Socket;
  private buf = Buffer.alloc(0);
  private pending = new Map<string, PendingRequest>();
  private seq = 0;

  private constructor(socket: net.Socket, host: string, port: number) {
    this.socket = socket;
    this.host = host;
    this.port = port;
    socket.on("data", (chunk) => this.onData(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk));
    socket.on("error", (err) => this.failAll(new Error(`nREPL connection to ${host}:${port} was lost: ${err.message}`)));
    socket.on("close", () => {
      this.closed = true;
      this.failAll(new Error(`nREPL connection to ${host}:${port} was lost`));
    });
  }

  static async connect(host: string, port: number, timeoutMs: number): Promise<NreplSocket> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host, port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`connect timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const onError = (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        socket.destroy();
        reject(new Error(err.code === "ECONNREFUSED" ? "connection refused" : err.message));
      };
      socket.once("error", onError);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.removeListener("error", onError);
        resolve(new NreplSocket(socket, host, port));
      });
    });
  }

  request(msg: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<Record<string, BencodeValue>[]> {
    const id = String(++this.seq);
    const entry: PendingRequest = {
      msgs: [],
      resolve: () => undefined,
      reject: () => undefined,
      timer: undefined as unknown as NodeJS.Timeout,
    };
    this.pending.set(id, entry);
    return new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
      entry.timer = setTimeout(() => entry.reject(new Error(`nREPL request timed out after ${timeoutMs}ms`)), timeoutMs);
      if (signal) {
        entry.abortSignal = signal;
        entry.onAbort = () => entry.reject(new Error("nREPL request was cancelled"));
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      try {
        this.socket.write(writeBencode({ ...msg, id }));
      } catch (err) {
        entry.reject(new Error(`nREPL write failed: ${String(err)}`));
      }
    });
  }

  // Fire-and-forget message (e.g. interrupt/close); its response is ignored.
  notify(msg: Record<string, unknown>): void {
    if (this.closed) return;
    try {
      this.socket.write(writeBencode({ ...msg, id: String(++this.seq) }));
    } catch {
      // best effort
    }
  }

  close(): void {
    if (this.closed) return;
    // Flush any pending write (e.g. the close op sent on plugin unload)
    // before tearing the socket down.
    this.socket.end();
    this.socket.destroySoon();
  }

  private settle(id: string, err?: Error): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (entry.abortSignal && entry.onAbort) entry.abortSignal.removeEventListener("abort", entry.onAbort);
    if (err) entry.reject(err);
    else entry.resolve(entry.msgs);
  }

  private failAll(err: Error): void {
    for (const id of [...this.pending.keys()]) this.settle(id, err);
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      let parsed: [BencodeValue, number] | null;
      try {
        parsed = readBencode(this.buf, 0);
      } catch (err) {
        this.failAll(new Error(`nREPL: malformed bencode message: ${String(err)}`));
        return;
      }
      if (parsed === null) return; // incomplete message: wait for more data
      const [value, next] = parsed;
      this.buf = this.buf.subarray(next);
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        this.route(value as Record<string, BencodeValue>);
      }
    }
  }

  private route(msg: Record<string, BencodeValue>): void {
    const id = typeof msg.id === "string" ? msg.id : undefined;
    if (!id || !this.pending.has(id)) return;
    this.pending.get(id)!.msgs.push(msg);
    // bencode has no booleans: the completion marker is the "done" entry
    // in the response's "status" list (per the nREPL protocol spec).
    const status = msg.status;
    if (Array.isArray(status) && status.includes("done")) this.settle(id);
  }
}

// One persistent entry per host:port: the socket plus the nREPL session id
// (state persists between evaluations, as in clj-nrepl-eval).
interface Target {
  host: string;
  port: number;
  socket: NreplSocket | null;
  sessionID: string | null;
  validated: boolean; // sessionID verified against ls-sessions on the current socket
}

const targets = new Map<string, Target>();

async function withNrepl(
  host: string,
  port: number,
  fn: (target: Target) => Promise<Record<string, BencodeValue>[]>,
): Promise<Record<string, BencodeValue>[]> {
  const key = `${host}:${port}`;
  let target = targets.get(key);
  if (!target) {
    target = { host, port, socket: null, sessionID: null, validated: false };
    targets.set(key, target);
  }
  if (!target.socket || target.socket.closed) {
    target.socket = await NreplSocket.connect(host, port, NREPL_CONNECT_TIMEOUT_MS);
    target.validated = false;
  }
  const socket = target.socket;
  // Sessions live on the server: validate the stored session whenever the
  // socket was (re)established, and create it on first use (clone).
  if (target.sessionID !== null && !target.validated) {
    const msgs = await socket.request({ op: "ls-sessions" }, NREPL_SESSION_TIMEOUT_MS);
    const listed = msgs.find((m) => Array.isArray(m.sessions));
    if (listed && !(listed.sessions as BencodeValue[]).includes(target.sessionID)) {
      target.sessionID = null; // server restarted: fall through to clone
    }
    target.validated = true;
  }
  if (target.sessionID === null) {
    const msgs = await socket.request({ op: "clone" }, NREPL_SESSION_TIMEOUT_MS);
    const created = msgs.find((m) => typeof m["new-session"] === "string");
    target.sessionID = created ? (created["new-session"] as string) : null;
    // Servers without clone get sessionless (ephemeral, stateless) evals.
  }
  return fn(target);
}

function closeAllTargets(): void {
  for (const target of targets.values()) {
    if (target.socket && !target.socket.closed) {
      if (target.sessionID) target.socket.notify({ op: "close", session: target.sessionID });
      target.socket.close();
    }
    target.socket = null;
  }
}

function interruptIfPossible(host: string, port: number): void {
  targets.get(`${host}:${port}`)?.socket?.notify({ op: "interrupt" });
}

// ============================================================================
// REPL evaluation (the clojure-nrepl-eval tool backend)
// ============================================================================

export function findNreplPort(dir: string): number | null {
  for (const file of [path.join(dir, ".nrepl-port"), path.join(dir, ".shadow-cljs", ".nrepl-port")]) {
    try {
      const n = Number(readFileSync(file, "utf8").trim());
      if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
    } catch {
      // missing or unreadable: try the next candidate
    }
  }
  return null;
}

interface MergedEval {
  values: string[];
  out: string;
  err: string;
  ns?: string;
  ex?: string;
  trace?: string;
}

function mergeEvalMessages(msgs: Record<string, BencodeValue>[]): MergedEval {
  const values: string[] = [];
  let out = "";
  let err = "";
  let ns: string | undefined;
  let ex: string | undefined;
  let trace: string | undefined;
  for (const m of msgs) {
    if (typeof m.value === "string") values.push(m.value);
    else if (Array.isArray(m.value)) values.push(...m.value.filter((v): v is string => typeof v === "string"));
    if (typeof m.out === "string") out += m.out;
    else if (Array.isArray(m.out)) out += m.out.filter((v): v is string => typeof v === "string").join("");
    if (typeof m.err === "string") err += m.err;
    else if (Array.isArray(m.err)) err += m.err.filter((v): v is string => typeof v === "string").join("");
    if (typeof m.ns === "string") ns = m.ns;
    if (typeof m.ex === "string") ex = m.ex;
    if (typeof m.trace === "string") trace = m.trace;
  }
  return { values, out, err, ns, ex, trace };
}

function formatEvalResult(m: MergedEval, host: string, port: number): string {
  const parts: string[] = [];
  if (m.out.trim()) parts.push(m.out.trimEnd());
  if (m.ex) {
    parts.push(`Exception: ${m.ex}`);
    if (m.err.trim()) parts.push(m.err.trimEnd());
    if (m.trace) {
      parts.push(m.trace.length > NREPL_TRACE_LIMIT ? `${m.trace.slice(0, NREPL_TRACE_LIMIT)}\n... (truncated)` : m.trace.trimEnd());
    }
  } else if (m.err.trim()) {
    parts.push(m.err.trimEnd());
  }
  for (const v of m.values) parts.push(`=> ${v}`);
  if (m.ns) parts.push(`;; namespace: ${m.ns}`);
  if (parts.length === 0) return `Evaluation on ${host}:${port} completed with no output.`;
  return parts.join("\n");
}

export interface EvalOptions {
  code: string;
  dir: string; // working directory for .nrepl-port discovery
  port?: number;
  host?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function evalClojure(opts: EvalOptions): Promise<string> {
  let code = opts.code;
  if (hasDelimiterError(code)) {
    const outcome = await repairImpl(code);
    if (outcome.status === "unfixable") {
      throw new ToolError({
        message: `Clojure delimiter errors in the eval code could not be auto-fixed (${outcome.message}). Fix the delimiters and try again.`,
      });
    }
    if (outcome.status === "error") {
      console.warn(`[opencode-clojure] repair unavailable for eval code: ${outcome.message}`);
    } else {
      code = outcome.text;
    }
  }

  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? findNreplPort(opts.dir);
  if (port === null) {
    throw new ToolError({
      message: `No nREPL server port found: pass a port explicitly or write the port to .nrepl-port in ${opts.dir} (also checked .shadow-cljs/.nrepl-port).`,
    });
  }
  const timeoutMs = opts.timeoutMs ?? NREPL_DEFAULT_TIMEOUT_MS;

  try {
    const msgs = await withNrepl(host, port, (target) =>
      target.socket!.request(
        target.sessionID ? { op: "eval", code, session: target.sessionID } : { op: "eval", code },
        timeoutMs,
        opts.signal,
      ),
    );
    return formatEvalResult(mergeEvalMessages(msgs), host, port);
  } catch (err) {
    if (err instanceof ToolError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("nREPL request timed out")) {
      interruptIfPossible(host, port);
      throw new ToolError({
        message: `Evaluation timed out after ${timeoutMs}ms and was interrupted. Try a smaller evaluation or a larger timeoutMs.`,
      });
    }
    if (message === "nREPL request was cancelled") {
      interruptIfPossible(host, port);
      throw new ToolError({ message: "Evaluation cancelled." });
    }
    if (message === "connection refused" || message.startsWith("connect timed out")) {
      throw new ToolError({
        message: `Could not connect to the nREPL server at ${host}:${port} (${message}). Start an nREPL server for the project and try again; pass the port explicitly when it is not in .nrepl-port.`,
      });
    }
    throw new ToolError({
      message: `nREPL evaluation at ${host}:${port} did not complete: ${message}. Try the evaluation again.`,
    });
  }
}

// ============================================================================
// Clojure file detection
// ============================================================================

const CLOJURE_EXTENSIONS = [".clj", ".cljs", ".cljc", ".cljd", ".bb", ".lpy", ".edn"];
const BB_SHEBANG = /^#![^\s]+\/(bb|env\s{1,3}bb)(\s.*)?$/;

export function isClojureFile(filePath: string, content?: string): boolean {
  const lower = filePath.toLowerCase();
  if (CLOJURE_EXTENSIONS.some((ext) => lower.endsWith(ext))) return true;
  if (content !== undefined) {
    const firstLine = content.split(/\r?\n/, 1)[0] ?? "";
    if (BB_SHEBANG.test(firstLine)) return true;
  }
  return false;
}

// ============================================================================
// Patch op parsing
// ============================================================================

export type PatchOp =
  | { op: "update"; path: string }
  | { op: "add"; path: string }
  | { op: "delete"; path: string }
  | { op: "move"; from: string; to: string };

const DIRECTIVES: [string, "update" | "move-to" | "add" | "delete"][] = [
  ["*** Update File: ", "update"],
  ["*** Move to: ", "move-to"],
  ["*** Add File: ", "add"],
  ["*** Delete File: ", "delete"],
];

export function parsePatch(patchText: string): PatchOp[] {
  const directives: { kind: "update" | "move-to" | "add" | "delete"; path: string }[] = [];
  for (const line of patchText.split(/\r?\n/)) {
    for (const [prefix, kind] of DIRECTIVES) {
      if (line.startsWith(prefix)) {
        const p = line.slice(prefix.length).trim();
        if (p) directives.push({ kind, path: p });
        break;
      }
    }
  }
  const ops: PatchOp[] = [];
  let i = 0;
  while (i < directives.length) {
    const d = directives[i];
    if (d.kind === "update") {
      if (directives[i + 1]?.kind === "move-to") {
        ops.push({ op: "move", from: d.path, to: directives[i + 1].path });
        i += 2;
      } else {
        ops.push({ op: "update", path: d.path });
        i += 1;
      }
    } else if (d.kind === "add" || d.kind === "delete") {
      ops.push({ op: d.kind, path: d.path });
      i += 1;
    } else {
      i += 1; // stray "Move to:" without a preceding update: ignore
    }
  }
  return ops;
}

const opSource = (op: PatchOp): string | null => (op.op === "update" ? op.path : op.op === "move" ? op.from : null);
const opTarget = (op: PatchOp): string | null =>
  op.op === "update" ? op.path : op.op === "move" ? op.to : op.op === "add" ? op.path : null;

// ============================================================================
// Backups (in memory, keyed by tool call id)
// ============================================================================

interface Backup {
  path: string;
  content: string;
}

interface CallState {
  backups: Backup[];
  patchOps?: PatchOp[]; // set for the patch tool
  write?: { path: string; original: string; reasons: ChangeReason[] }; // set for the write tool
  dir: string;
}

const callStates = new Map<string, CallState>();

function stashBackup(callID: string, dir: string, backup: Backup) {
  const state = callStates.get(callID) ?? { backups: [], dir };
  state.backups.push(backup);
  callStates.set(callID, state);
}

function takeState(callID: string): CallState | undefined {
  const state = callStates.get(callID);
  if (state) callStates.delete(callID);
  return state;
}

// ============================================================================
// Tool result rewriting
// ============================================================================

export interface BeforeEvent {
  tool: string;
  sessionID: string;
  id: string;
  input: unknown;
}

export interface AfterEvent {
  tool: string;
  sessionID: string;
  id: string;
  status: "completed" | "error";
  input: unknown;
  result?: { content?: string | readonly { type: string; text?: string }[] };
}

function setResultText(event: AfterEvent, text: string) {
  if (event.result) event.result.content = text;
}

function appendResultText(event: AfterEvent, text: string) {
  const result = event.result;
  if (!result) return;
  const content = result.content;
  if (typeof content === "string") {
    result.content = content === "" ? text : `${content}\n\n${text}`;
    return;
  }
  if (Array.isArray(content)) {
    const parts = content as { type: string; text?: string }[];
    const first = parts.find((part) => part.type === "text");
    if (first && typeof first.text === "string") first.text = first.text === "" ? text : `${first.text}\n\n${text}`;
    else parts.push({ type: "text", text });
  }
}

// ============================================================================
// Change notes (results for calls that modified the model's view of a file)
//
// When the plugin rewrites a file after the model's write/edit/patch, the
// model's in-context view of that file is stale and further edits built on
// it will fail. The tool result therefore carries a change note: the full
// current on-disk content when the file is small enough, otherwise a line
// diff of what changed, so the model can continue editing without acting on
// stale content.
// ============================================================================

export type ChangeReason = "repaired" | "formatted";

export const FULL_MAX_LINES = 200;
export const FULL_MAX_BYTES = 8_192;
export const DIFF_MAX_LINES = 60;
export const NOTE_TOTAL_MAX_BYTES = 16_384;

// Dependency-free line diff: trims the common prefix/suffix and lists the
// changed middle, one side at a time, each line numbered with its position
// in that side's version. "" when the texts are identical.
export function diffText(before: string, after: string): string {
  if (before === after) return "";
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let oldStop = oldLines.length;
  let newStop = newLines.length;
  while (oldStop > start && newStop > start && oldLines[oldStop - 1] === newLines[newStop - 1]) {
    oldStop--;
    newStop--;
  }
  const lines: string[] = [];
  for (let i = start; i < oldStop; i++) lines.push(`-${i + 1}: ${oldLines[i]}`);
  for (let i = start; i < newStop; i++) lines.push(`+${i + 1}: ${newLines[i]}`);
  return lines.join("\n");
}

// Full-file content with line numbers, in the read tool's style.
export function numberedContent(text: string): string {
  return text
    .split("\n")
    .map((line, i) => `${i + 1}: ${line}`)
    .join("\n");
}

function reasonPhrase(reasons: ChangeReason[]): string {
  const repaired = reasons.includes("repaired");
  const formatted = reasons.includes("formatted");
  if (repaired && formatted) return "delimiter errors were repaired and cljfmt reformatted it";
  if (repaired) return "delimiter errors were repaired automatically";
  if (formatted) return "cljfmt reformatted it";
  return "the content was modified";
}

export function buildChangeNote(file: string, before: string, after: string, reasons: ChangeReason[]): string {
  const lines = [
    `⚠ Auto-repair note: ${file}`,
    `Your change was applied, but ${reasonPhrase(reasons)} - the file on disk differs from what you wrote:`,
  ];
  const afterLineCount = after.split("\n").length;
  if (afterLineCount <= FULL_MAX_LINES && Buffer.byteLength(after, "utf8") <= FULL_MAX_BYTES) {
    lines.push("Current on-disk content:", numberedContent(after));
  } else {
    lines.push(
      "Changed lines (- = what your change produced, + = what is on disk now; numbers are line numbers in each side's version):",
    );
    // the cap is split across both sides so the + (current) side is never
    // fully cut off
    const diff = diffText(before, after).split("\n");
    const plusStart = diff.findIndex((line) => line.startsWith("+"));
    const removed = diff.slice(0, plusStart < 0 ? diff.length : plusStart);
    const added = plusStart < 0 ? [] : diff.slice(plusStart);
    const perSide = Math.ceil(DIFF_MAX_LINES / 2);
    const shown = [...removed.slice(0, perSide), ...added.slice(0, perSide)];
    const omitted =
      Math.max(0, removed.length - perSide) + Math.max(0, added.length - perSide);
    lines.push(...shown);
    if (omitted > 0) {
      lines.push(`... (${omitted} more changed lines - re-read the file for the full current content)`);
    }
  }
  return lines.join("\n");
}

// Joins per-file change notes under a byte budget; a file whose note does
// not fit gets a one-line re-read notice instead.
export function assembleChangeNotes(
  changes: { file: string; before: string; after: string; reasons: ChangeReason[] }[],
  budget = NOTE_TOTAL_MAX_BYTES,
): string {
  const parts: string[] = [];
  let used = 0;
  for (const change of changes) {
    const note = buildChangeNote(change.file, change.before, change.after, change.reasons);
    const size = Buffer.byteLength(note, "utf8");
    if (used + size > budget) {
      parts.push(`⚠ Auto-repair note: ${change.file} - further changes omitted; re-read the file.`);
      continue;
    }
    used += size;
    parts.push(note);
  }
  return parts.join("\n\n");
}

// ============================================================================
// Hooks
// ============================================================================

type ProcessedContent =
  | { status: "ok"; text: string; reasons: ChangeReason[] }
  | { status: "unfixable"; message: string };

// Repairs `content` (the content of `label`) and formats it when cljfmt is
// available; `reasons` reports which step actually changed the content. On
// unfixable content, `restore` (when provided) is invoked.
async function processContent(label: string, content: string, restore?: () => void): Promise<ProcessedContent> {
  const reasons: ChangeReason[] = [];
  let out = content;
  if (hasDelimiterError(content)) {
    const outcome = await repairImpl(content);
    if (outcome.status === "error") {
      console.warn(`[opencode-clojure] repair unavailable for ${label}: ${outcome.message}`);
    } else if (outcome.status === "unfixable") {
      restore?.();
      return { status: "unfixable", message: outcome.message };
    } else {
      if (outcome.text !== content) reasons.push("repaired");
      out = outcome.text;
    }
  }
  const formatted = await formatImpl(out);
  if (formatted !== out) reasons.push("formatted");
  return { status: "ok", text: formatted, reasons };
}

export async function handleBefore(event: BeforeEvent, sessionDir: (sessionID: string) => Promise<string>) {
  if (event.tool === "write") {
    const input = event.input as { path?: unknown; content?: unknown } | undefined;
    if (typeof input?.path !== "string" || typeof input.content !== "string") return;
    const dir = await sessionDir(event.sessionID);
    const abs = path.resolve(dir, input.path);
    if (!isClojureFile(abs, input.content)) return;
    const outcome = await processContent(input.path, input.content);
    if (outcome.status === "unfixable") {
      throw new ToolError({
        message: `Clojure delimiter errors in ${input.path} could not be auto-fixed (${outcome.message}). Fix the delimiters and write again.`,
      });
    }
    if (outcome.text !== input.content) {
      // the after-hook attaches a change note to the tool result
      const state = callStates.get(event.id) ?? { backups: [], dir };
      state.write = { path: abs, original: input.content, reasons: outcome.reasons };
      callStates.set(event.id, state);
      input.content = outcome.text;
    }
    return;
  }

  if (event.tool === "edit") {
    const input = event.input as { path?: unknown } | undefined;
    if (typeof input?.path !== "string") return;
    const abs = path.resolve(await sessionDir(event.sessionID), input.path);
    if (!existsSync(abs)) return;
    const content = readFileSync(abs, "utf8");
    if (!isClojureFile(abs, content)) return;
    stashBackup(event.id, await sessionDir(event.sessionID), { path: abs, content });
    return;
  }

  if (event.tool === "patch") {
    const input = event.input as { patchText?: unknown } | undefined;
    if (typeof input?.patchText !== "string") return;
    const dir = await sessionDir(event.sessionID);
    const ops = parsePatch(input.patchText);
    for (const op of ops) {
      const source = opSource(op);
      if (!source) continue;
      const abs = path.resolve(dir, source);
      if (!existsSync(abs)) continue;
      const content = readFileSync(abs, "utf8");
      if (!isClojureFile(abs, content)) continue;
      stashBackup(event.id, dir, { path: abs, content });
    }
    const state = callStates.get(event.id);
    if (state) state.patchOps = ops;
  }
}

export async function handleAfter(event: AfterEvent, sessionDir: (sessionID: string) => Promise<string>) {
  if (event.tool !== "edit" && event.tool !== "patch" && event.tool !== "write") return;
  const state = takeState(event.id);
  if (!state) return;
  if (event.status !== "completed") return; // failed call: nothing was applied

  if (event.tool === "write") {
    const recorded = state.write;
    if (!recorded || !existsSync(recorded.path)) return;
    const onDisk = readFileSync(recorded.path, "utf8");
    if (onDisk === recorded.original) return;
    appendResultText(event, buildChangeNote(recorded.path, recorded.original, onDisk, recorded.reasons));
    return;
  }

  if (event.tool === "edit") {
    const backup = state.backups[0];
    if (!backup || !existsSync(backup.path)) return;
    const before = readFileSync(backup.path, "utf8"); // what the edit produced on disk
    const outcome = await processContent(backup.path, before, () =>
      writeFileSync(backup.path, backup.content, "utf8"),
    );
    if (outcome.status === "unfixable") {
      setResultText(
        event,
        `Edit to ${backup.path} was reverted: delimiter errors could not be auto-fixed. Fix the delimiters and retry the edit.`,
      );
      return;
    }
    if (outcome.text !== before) {
      writeFileSync(backup.path, outcome.text, "utf8");
      appendResultText(event, buildChangeNote(backup.path, before, outcome.text, outcome.reasons));
    }
    return;
  }

  // patch
  const ops = state.patchOps ?? [];
  if (ops.length === 0) return;
  const dir = state.dir;
  const updated: { file: string; before: string; after: string; reasons: ChangeReason[] }[] = [];
  const failures: PatchOp[] = [];
  for (const op of ops) {
    const target = opTarget(op);
    if (!target) continue;
    const abs = path.resolve(dir, target);
    if (!existsSync(abs)) continue;
    const before = readFileSync(abs, "utf8");
    const outcome = await processContent(abs, before, () => {
      if (op.op === "update" || op.op === "move") {
        const source = path.resolve(dir, opSource(op)!);
        const backup = state.backups.find((b) => b.path === source);
        if (backup) writeFileSync(source, backup.content, "utf8");
      }
    });
    if (outcome.status === "unfixable") failures.push(op);
    else if (outcome.text !== before) {
      writeFileSync(abs, outcome.text, "utf8");
      updated.push({ file: abs, before, after: outcome.text, reasons: outcome.reasons });
    }
  }

  if (failures.length > 0) {
    const restored: string[] = [];
    const deleted: string[] = [];
    const kept: string[] = [];
    for (const op of failures) {
      if (op.op === "update" || op.op === "move") {
        const source = path.resolve(dir, opSource(op)!);
        const backup = state.backups.find((b) => b.path === source);
        if (backup) {
          // the per-op restore already ran in processContent; record it here
          restored.push(source);
          if (op.op === "move") safeDelete(path.resolve(dir, op.to));
        } else {
          kept.push(source);
        }
      } else if (op.op === "add") {
        const added = path.resolve(dir, op.path);
        safeDelete(added);
        deleted.push(added);
      }
    }
    const parts = [
      `Delimiter errors could not be auto-fixed in ${failures.map((op) => path.resolve(dir, opTarget(op)!)).join(", ")}.`,
    ];
    if (restored.length > 0) parts.push(`Restored from backup: ${restored.join(", ")}.`);
    if (deleted.length > 0) parts.push(`Removed newly added files: ${deleted.join(", ")}.`);
    if (kept.length > 0) parts.push(`Left in place (no backup): ${kept.join(", ")}.`);
    setResultText(event, parts.join(" "));
  } else if (updated.length > 0) {
    appendResultText(event, assembleChangeNotes(updated));
  }
}

function safeDelete(file: string) {
  try {
    unlinkSync(file);
  } catch {
    // already gone
  }
}

// ============================================================================
// Session directory resolution
// ============================================================================

// Relative tool paths resolve against the session's working directory. The
// session lookup is cached; it falls back to the plugin load location when
// the session is unavailable.
function makeSessionDir(ctx: {
  location: { directory: string };
  session: { get: (input: { sessionID: string }) => Promise<{ location?: { directory?: string } } | undefined> };
}) {
  const cache = new Map<string, string>();
  return async (sessionID: string) => {
    const hit = cache.get(sessionID);
    if (hit) return hit;
    try {
      const session = await ctx.session.get({ sessionID });
      const dir = session?.location?.directory;
      if (typeof dir === "string" && dir !== "") {
        cache.set(sessionID, dir);
        return dir;
      }
    } catch {
      // fall through to the plugin load location
    }
    return ctx.location.directory;
  };
}

// ============================================================================
// Plugin
// ============================================================================

export default Plugin.define({
  id: "opencode-clojure",
  async setup(ctx) {
    const sessionDir = makeSessionDir(ctx);
    await ctx.tool.hook("execute.before", (event) => handleBefore(event, sessionDir));
    await ctx.tool.hook("execute.after", (event) => handleAfter(event, sessionDir));
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "clojure-nrepl-eval",
        description: `Evaluate Clojure code against the project's nREPL server (Clojure, babashka, shadow-cljs, ...). Session state persists between calls, so a namespace required in one call is available in the next. Delimiter errors in the code are repaired automatically before evaluation; unfixable code is rejected without being evaluated. When port is omitted, the port is read from .nrepl-port (or .shadow-cljs/.nrepl-port) in the working directory. If the connection fails, ask the user to start an nREPL server and pass the port explicitly.`,
        input: {
          type: "object",
          properties: {
            code: { type: "string", description: "Clojure code to evaluate (one or more complete forms)" },
            port: { type: "number", description: "nREPL port; omit to read .nrepl-port from the working directory" },
            host: { type: "string", description: "nREPL host (default: 127.0.0.1)" },
            timeoutMs: { type: "number", description: `Evaluation timeout in milliseconds (default: ${NREPL_DEFAULT_TIMEOUT_MS})` },
          },
          required: ["code"],
          additionalProperties: false,
        },
        execute: async (input, context) => {
          const args = (input ?? {}) as Record<string, unknown>;
          const code = typeof args.code === "string" ? args.code : "";
          if (!code.trim()) {
            throw new ToolError({ message: "clojure-nrepl-eval requires a non-empty `code` string." });
          }
          const content = await evalClojure({
            code,
            dir: await sessionDir(context.sessionID),
            port: typeof args.port === "number" ? args.port : undefined,
            host: typeof args.host === "string" ? args.host : undefined,
            timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
            signal: context.signal,
          });
          return { content };
        },
      });
    });
    return () => closeAllTargets();
  },
});
