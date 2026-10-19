import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Error as ToolError } from "@opencode/plugin/promise/tool";
import plugin, {
  isClojureFile,
  parsePatch,
  handleBefore,
  handleAfter,
  hasDelimiterError,
  scanClojure,
  describeScanErrors,
  changedLinesBetween,
  repairSurgically,
  MAX_REPAIR_CHANGED_LINES,
  REPAIR_WINDOW_BEFORE,
  REPAIR_WINDOW_AFTER,
  repairText,
  formatWithCljfmt,
  resolveCljfmt,
  evalClojure,
  findNreplPort,
  readBencode,
  writeBencode,
  diffText,
  numberedContent,
  buildChangeNote,
  assembleChangeNotes,
  _internals,
  type RepairResult,
  type AfterEvent,
  type ChangeReason,
} from "../index.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const tmp = mkdtempSync(path.join(tmpdir(), "cplr-test-"));
const sessionDir = async (_sessionID: string) => tmp;

const openServers: FakeNrepl[] = [];
function startServer() {
  const server = new FakeNrepl();
  openServers.push(server);
  return server;
}

/** Poll until `cond` returns truthy (socket writes are async). */
async function waitFor(cond: () => boolean, ms = 1_000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

let callID = 0;
const nextID = () => `call-${++callID}`;

/** Mock repair keyed by the content it is called with. */
function mockRepair(results: Record<string, RepairResult>) {
  const calls: string[] = [];
  _internals.setRepair(async (text) => {
    calls.push(text);
    return results[text] ?? { status: "error", message: `unexpected content ${text}` };
  });
  return calls;
}

/** Mock formatter; `transform` defaults to the identity. */
function mockFormat(transform?: (text: string) => string) {
  const calls: string[] = [];
  _internals.setFormat(async (text) => {
    calls.push(text);
    return transform ? transform(text) : text;
  });
  return calls;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as { type: string; text?: string }[])
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n");
  }
  return String(content);
}

const beforeEvent = (tool: string, input: unknown, id = nextID()) => ({
  tool,
  sessionID: "ses_1",
  id,
  input,
});
const afterEvent = (
  tool: string,
  input: unknown,
  result: AfterEvent["result"],
  id = nextID(),
  status: "completed" | "error" = "completed",
): AfterEvent => ({
  tool,
  sessionID: "ses_1",
  id,
  input,
  status,
  result,
});

afterEach(async () => {
  _internals.setRepair();
  _internals.setFormat();
  _internals.resetCljfmtCache();
  _internals.resetNreplPool();
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

// ---------------------------------------------------------------------------
// isClojureFile
// ---------------------------------------------------------------------------

test("isClojureFile: recognized extensions", () => {
  for (const ext of [".clj", ".cljs", ".cljc", ".cljd", ".bb", ".lpy", ".edn"]) {
    assert.ok(isClojureFile(`/tmp/file${ext}`), ext);
    assert.ok(isClojureFile(`/tmp/file${ext.toUpperCase()}`), `${ext} case-insensitive`);
  }
});

test("isClojureFile: unrecognized paths", () => {
  assert.equal(isClojureFile("/tmp/file.py"), false);
  assert.equal(isClojureFile("/tmp/noextension"), false);
  assert.equal(isClojureFile("/tmp/file.cljx"), false);
});

test("isClojureFile: bb shebang detection", () => {
  assert.ok(isClojureFile("/tmp/run", "#!/usr/bin/env bb\n(def x 1)"));
  assert.ok(isClojureFile("/tmp/run", "#!/bin/bb\n(def x 1)"));
  assert.equal(isClojureFile("/tmp/run", "#!/bin/sh\necho hi"), false);
  // extension wins even without content
  assert.ok(isClojureFile("/tmp/x.clj"));
  assert.ok(isClojureFile("/tmp/run", "#!/usr/bin/env bb\n(def x 1)"));
  assert.equal(isClojureFile("/tmp/run"), false);
});

// ---------------------------------------------------------------------------
// parsePatch
// ---------------------------------------------------------------------------

const SAMPLE_PATCH = `*** Add File: hello.txt
+hello world

*** Update File: src/app.py
@@ -1,3 +1,4 @@
 def main():
+    pass
     return 0

*** Update File: src/main.py
*** Move to: src/entry.py

*** Delete File: obsolete.txt
`;

test("parsePatch: canonical ops", () => {
  assert.deepEqual(parsePatch(SAMPLE_PATCH), [
    { op: "add", path: "hello.txt" },
    { op: "update", path: "src/app.py" },
    { op: "move", from: "src/main.py", to: "src/entry.py" },
    { op: "delete", path: "obsolete.txt" },
  ]);
});

test("parsePatch: CRLF line endings and trimmed paths", () => {
  const crlf = SAMPLE_PATCH.replace(/\n/g, "\r\n");
  assert.deepEqual(parsePatch(crlf), parsePatch(SAMPLE_PATCH));
  assert.deepEqual(parsePatch("*** Add File:   spaced/path.clj  \n"), [{ op: "add", path: "spaced/path.clj" }]);
});

test("parsePatch: stray move-to is ignored, empty input has no ops", () => {
  assert.deepEqual(parsePatch("*** Move to: nowhere.txt\n"), []);
  assert.deepEqual(parsePatch(""), []);
  assert.deepEqual(parsePatch("just some text\nno directives\n"), []);
});

// ---------------------------------------------------------------------------
// hasDelimiterError (the repair pre-gate)
// ---------------------------------------------------------------------------

test("hasDelimiterError: balanced code is clean", () => {
  assert.equal(hasDelimiterError("(defn foo [x] (* x 2))"), false);
  assert.equal(hasDelimiterError("(defn foo [x] (* x 2))\n"), false);
  assert.equal(hasDelimiterError("{:a [1 2] :b #{3 4}}"), false);
  assert.equal(hasDelimiterError("#(identity (inc %))"), false);
  assert.equal(hasDelimiterError(""), false);
  assert.equal(hasDelimiterError("   \n\n  "), false);
  assert.equal(hasDelimiterError("(:a 1 (\"str\" 2) 3)"), false);
});

test("hasDelimiterError: unbalanced delimiters", () => {
  assert.equal(hasDelimiterError("(+ 1 2 3"), true);
  assert.equal(hasDelimiterError("(def x [1)"), true);
  assert.equal(hasDelimiterError("(def x 1))"), true);
  assert.equal(hasDelimiterError("{:a (1 2}"), true);
  assert.equal(hasDelimiterError("(defn f [a b]\n  (when a\n    (do b c"), true);
});

test("hasDelimiterError: strings do not count", () => {
  assert.equal(hasDelimiterError('(def s "(a b")'), false);
  assert.equal(hasDelimiterError('(def s "a \\" ( b")'), false);
  // multi-line string
  assert.equal(hasDelimiterError('(def s "line1\nline2 (")'), false);
  assert.equal(hasDelimiterError("(def s \"foo"), true); // unterminated
});

test("hasDelimiterError: char literals do not count", () => {
  assert.equal(hasDelimiterError("(def c \\( )"), false);
  assert.equal(hasDelimiterError("(def c \\] )"), false);
  assert.equal(hasDelimiterError("(def c \\space )"), false);
  assert.equal(hasDelimiterError("(def cs \\( \\[ \\{ )"), false);
});

test("hasDelimiterError: comments do not count", () => {
  assert.equal(hasDelimiterError("(def x 1) ; todo: fix (this"), false);
  assert.equal(hasDelimiterError("(def x 1)\n; trailing ( comment\n"), false);
});

test("hasDelimiterError: regex literals do not count", () => {
  assert.equal(hasDelimiterError('(def r #"\\(x\\)")'), false);
  assert.equal(hasDelimiterError('(def s #"abc( def x 1)")'), false);
  // unterminated regex
  assert.equal(hasDelimiterError('(def r #"\\(x'), true);
});

// ---------------------------------------------------------------------------
// scanClojure: the same verdict, plus where the delimiters are wrong
// ---------------------------------------------------------------------------

test("scanClojure: balanced code reports no errors", () => {
  for (const text of [
    "(defn foo [x] (* x 2))",
    "{:a [1 2] :b #{3 4}}",
    '(def s "a \\" ( b")',
    '(def s "line1\nline2 (")',
    "(def c \\( \\[ \\{ )",
    '(def r #"abc( def x 1)")',
    "(def x 1) ; todo: fix (this",
    "#!/usr/bin/env bb\n(def x 1)",
    "#{:a #?(:clj 1 :cljs 2)}",
  ]) {
    assert.deepEqual(scanClojure(text), [], JSON.stringify(text));
  }
});

test("scanClojure: unclosed delimiters are reported outermost first", () => {
  assert.deepEqual(scanClojure("(defn f []\n  (let [x 1]\n    (inc x)\n"), [
    { kind: "unclosed", line: 1, col: 1, char: "(" },
    { kind: "unclosed", line: 2, col: 3, char: "(" },
  ]);
  // a badly truncated file reports at most three openers
  assert.equal(scanClojure("(a\n(b\n(c\n(d\n(e\n").length, 3);
});

test("scanClojure: closer errors and string errors carry line and column", () => {
  assert.deepEqual(scanClojure("(def x 1))\n"), [{ kind: "extra-closer", line: 1, col: 10, char: ")" }]);
  assert.deepEqual(scanClojure("{:a [1 2}"), [
    { kind: "mismatched-closer", line: 1, col: 9, char: "}", opener: { char: "[", line: 1 } },
    { kind: "unclosed", line: 1, col: 1, char: "{" },
  ]);
  assert.deepEqual(scanClojure("(def a 1)\n(def s \"foo\n"), [
    { kind: "unterminated-string", line: 2, col: 8, char: '"' },
    { kind: "unclosed", line: 2, col: 1, char: "(" },
  ]);
  assert.deepEqual(scanClojure("(def a 1)\n(def r #\"foo\n"), [
    { kind: "unterminated-regex", line: 2, col: 8, char: '#"' },
    { kind: "unclosed", line: 2, col: 1, char: "(" },
  ]);
});

test("describeScanErrors: wording an agent can act on", () => {
  assert.equal(
    describeScanErrors(scanClojure("(deftest a []\n  (is (= 1 1)\n")),
    "`(` opened at line 1 is never closed; `(` opened at line 2 is never closed",
  );
  assert.equal(describeScanErrors(scanClojure("(def x 1))")), "unexpected `)` at line 1:10");
});

// ---------------------------------------------------------------------------
// changedLinesBetween: what a rewrite actually touched
// ---------------------------------------------------------------------------

test("changedLinesBetween: ignores whitespace and reports changed lines", () => {
  assert.deepEqual(changedLinesBetween("(a 1)\n(b 2)\n", "(a 1)\n(b 2)\n"), []);
  assert.deepEqual(changedLinesBetween("(a 1)\n(b 2)\n", "(a 1)\n(b 2 3)\n"), [2]);
  // reindent alone is not a change
  assert.deepEqual(changedLinesBetween("(a 1)\n    (b 2)\n", "(a 1)\n  (b 2)\n"), []);
  assert.deepEqual(changedLinesBetween("(a 1)\n(d 4)\n", "(a 1)\n(b 2)\n(c 3)\n(d 4)\n"), [2, 3]);
});

// ---------------------------------------------------------------------------
// repairSurgically: the engine's proposal has to stay next to the error
// ---------------------------------------------------------------------------

test("repairSurgically: balanced code never reaches the repair engine", async () => {
  const calls = mockRepair({});
  assert.deepEqual(await repairSurgically("(defn foo [x] (* x 2))\n"), { status: "clean" });
  assert.deepEqual(calls, []);
});

test("repairSurgically: accepts a fix on the error line", async () => {
  assert.deepEqual(await repairSurgically("(+ 1 2 3"), { status: "repaired", text: "(+ 1 2 3)", rewrote: [1] });
});

test("repairSurgically: declines a fix that rewrites too many lines", async () => {
  const broken = ["(a 1)", "", "(b 2", "", "(c 3", "", "(d 4"].join("\n");
  // one proposal that fixes all three forms at once: 3 lines, cap is 2
  const fixed = ["(a 1)", "", "(b 2)", "", "(c 3)", "", "(d 4)"].join("\n");
  mockRepair({ [broken]: { status: "repaired", text: fixed } });

  const declined = await repairSurgically(broken);
  assert.equal(declined.status, "declined");
  if (declined.status !== "declined") return;
  assert.ok(declined.rewrote.length > MAX_REPAIR_CHANGED_LINES, JSON.stringify(declined.rewrote));
  assert.match(declined.message, /is never closed/);
  assert.match(declined.message, /more than 2/);

  // the same proposal passes once the cap covers it
  assert.equal((await repairSurgically(broken, { maxChangedLines: 4 })).status, "repaired");
});

test("repairSurgically: declines a fix that moves delimiters away from the error", async () => {
  const broken = ["(a 1)", "", "", "", "", "", "", "", "(b 2"].join("\n");
  // a legal repair - balanced, and only one closer moved - but the closer it
  // relocates belongs to a form above the error, which is how indent mode
  // closes a form early
  const fixed = ["(a 1", "", "", "", "", "", "", "", "(b 2))"].join("\n");
  mockRepair({ [broken]: { status: "repaired", text: fixed } });

  const declined = await repairSurgically(broken);
  assert.equal(declined.status, "declined");
  if (declined.status !== "declined") return;
  assert.deepEqual(declined.rewrote, [1, 9]);
  assert.match(declined.message, /away from the error/);

  // the band is asymmetric: below the error is where a missing closer belongs
  assert.ok(REPAIR_WINDOW_AFTER > REPAIR_WINDOW_BEFORE);
  assert.equal((await repairSurgically(broken, { windowBefore: 8 })).status, "repaired");
});

test("repairSurgically: anchors are the caller's own changed lines", async () => {
  const broken = ["(a 1)", "", "", "", "", "", "", "", "(b 2"].join("\n");
  const fixed = ["(a 1", "", "", "", "", "", "", "", "(b 2))"].join("\n");
  mockRepair({ [broken]: { status: "repaired", text: fixed } });
  assert.equal((await repairSurgically(broken, { anchors: [1, 2] })).status, "repaired");
});

test("repairSurgically: a closer that belongs far below its opener is still repaired", async () => {
  const body = Array.from({ length: 20 }, (_, i) => `  (println ${i})`).join("\n");
  const whole = `(defn big []\n${body}\n  (inc 1))\n`;
  const broken = `(defn big []\n${body}\n  (inc 1)\n`;
  assert.deepEqual(scanClojure(broken), [{ kind: "unclosed", line: 1, col: 1, char: "(" }]);

  const result = await repairSurgically(broken);
  assert.equal(result.status, "repaired");
  if (result.status === "repaired") assert.equal(result.text, whole);
  assert.equal((await repairSurgically(broken, { windowAfter: 5 })).status, "declined");
});

test("repairSurgically: a proposal that does not fix the code is declined", async () => {
  const broken = "(+ 1 2 3";
  mockRepair({ [broken]: { status: "repaired", text: "(+ 1 2 (3" } });
  const stillBroken = await repairSurgically(broken);
  assert.equal(stillBroken.status, "declined");
  if (stillBroken.status === "declined") assert.match(stillBroken.message, /still leave delimiter errors/);

  mockRepair({ [broken]: { status: "repaired", text: broken } });
  const unchanged = await repairSurgically(broken);
  assert.equal(unchanged.status, "declined");
  if (unchanged.status === "declined") assert.match(unchanged.message, /changed nothing/);
});

test("repairSurgically: engine status is passed through", async () => {
  const broken = "(+ 1 2 3";
  mockRepair({ [broken]: { status: "error", message: "engine down" } });
  assert.deepEqual(await repairSurgically(broken), { status: "error", message: "engine down" });

  mockRepair({ [broken]: { status: "unfixable", message: "unclosed string" } });
  assert.deepEqual(await repairSurgically(broken), { status: "unfixable", message: "unclosed string" });
});

test("repairSurgically: real parinfer against indentation drift", async () => {
  // the file was balanced and badly indented; the model's edit then dropped a
  // closer. Reading indentation as the truth, parinfer closes the earlier forms
  // where the indentation says they end, which rewrites unrelated code
  const drifted = [
    "(deftest drift-test []", //
    "(when true", //
    "(is true)))", //
    "", //
    "(deftest new-test []", //
    '  (is (= 1', //
    "        (inc 0)))", //
    "", //
  ].join("\n");
  assert.deepEqual(scanClojure(drifted), [{ kind: "unclosed", line: 5, col: 1, char: "(" }]);

  const result = await repairSurgically(drifted, { anchors: [5, 6, 7] });
  assert.equal(result.status, "declined");
  if (result.status !== "declined") return;
  assert.ok(result.rewrote.includes(1), "the drift repair reaches back to line 1");
  assert.match(result.message, /opened at line 5 is never closed/);
  assert.match(result.message, /rewrite \d+ lines/);
});

// ---------------------------------------------------------------------------
// change notes (diff / numbered content / note builders)
// ---------------------------------------------------------------------------

test("diffText: identical texts have an empty diff", () => {
  assert.equal(diffText("(def a 1)\n", "(def a 1)\n"), "");
});

test("diffText: common prefix and suffix are trimmed, lines numbered per side", () => {
  const before = "l1\nl2\nOLD\nl4\nl5";
  const after = "l1\nl2\nNEW\nl4\nl5";
  assert.equal(diffText(before, after), "-3: OLD\n+3: NEW");
});

test("diffText: whole-file replacement lists both sides", () => {
  assert.equal(diffText("a\nb", "c\nd"), "-1: a\n-2: b\n+1: c\n+2: d");
});

test("diffText: insertions number against the after version", () => {
  assert.equal(diffText("a\nb\nc", "a\nb\nx\ny\nc"), "+3: x\n+4: y");
});

test("numberedContent: numbers every line", () => {
  assert.equal(numberedContent("a\nb\n"), "1: a\n2: b\n3: ");
  assert.equal(numberedContent(""), "1: ");
});

test("buildChangeNote: small after-content carries the full current file", () => {
  const note = buildChangeNote("a.clj", "(def a 1 (oops\n", "(def a 1)\n", ["repaired"]);
  assert.match(note, /⚠ Auto-repair note: a\.clj/);
  assert.match(note, /repaired automatically/);
  assert.match(note, /Current on-disk content:/);
  assert.match(note, /1: \(def a 1\)/);
});

test("buildChangeNote: large after-content carries a capped diff instead", () => {
  const before = Array.from({ length: 300 }, (_, i) => `line ${i} OLD`).join("\n");
  const after = Array.from({ length: 300 }, (_, i) => `line ${i} NEW`).join("\n");
  const note = buildChangeNote("big.clj", before, after, ["formatted"]);
  assert.doesNotMatch(note, /Current on-disk content:/);
  assert.match(note, /Changed lines/);
  assert.match(note, /-1: line 0 OLD/);
  assert.match(note, /\+1: line 0 NEW/);
  assert.match(note, /more changed lines - re-read/);
});

test("buildChangeNote: both reasons are reported", () => {
  const note = buildChangeNote("a.clj", "(+ 1 2 3", "(+ 1 2 3)\n", ["repaired", "formatted"]);
  assert.match(note, /repaired and cljfmt reformatted/);
});

test("assembleChangeNotes: files that do not fit the budget get a re-read line", () => {
  const first = { file: "a.clj", before: "(def a 1\n", after: "(def a 1)\n", reasons: ["repaired"] as ChangeReason[] };
  const second = { file: "b.clj", before: "(def b 1\n", after: "(def b 1)\n", reasons: ["repaired"] as ChangeReason[] };
  const firstNote = buildChangeNote(first.file, first.before, first.after, first.reasons);
  const combined = assembleChangeNotes([first, second], Buffer.byteLength(firstNote, "utf8"));
  assert.match(combined, /Auto-repair note: a\.clj/);
  assert.match(combined, /1: \(def a 1\)/);
  assert.match(combined, /Auto-repair note: b\.clj - further changes omitted; re-read/);
});

// ---------------------------------------------------------------------------
// write (execute.before)
// ---------------------------------------------------------------------------

test("write before: broken content is repaired and formatted", async () => {
  const repairs = mockRepair({ "(+ 1 2 3": { status: "repaired", text: "(+ 1 2 3)" } });
  const formats = mockFormat((t) => t + "\n");
  const input = { path: "foo.clj", content: "(+ 1 2 3" };
  await handleBefore(beforeEvent("write", input), sessionDir);
  assert.deepEqual(repairs, ["(+ 1 2 3"]);
  assert.deepEqual(formats, ["(+ 1 2 3)"]);
  assert.equal(input.content, "(+ 1 2 3)\n");
});

test("write before: balanced content skips repair but still formats", async () => {
  const repairs = mockRepair({});
  const formats = mockFormat();
  const input = { path: "foo.clj", content: "(def x 1)\n" };
  await handleBefore(beforeEvent("write", input), sessionDir);
  assert.equal(repairs.length, 0);
  assert.deepEqual(formats, ["(def x 1)\n"]);
  assert.equal(input.content, "(def x 1)\n");
});

test("write before: unfixable content rejects with Tool.Error", async () => {
  mockRepair({ '#("foo': { status: "unfixable", message: "String is missing a closing quote." } });
  mockFormat();
  const input = { path: "foo.clj", content: '#("foo' };
  await assert.rejects(
    () => handleBefore(beforeEvent("write", input), sessionDir),
    (err: unknown) => err instanceof ToolError && err.message.includes("foo.clj"),
  );
});

test("write before: repair failure fails open", async () => {
  mockRepair({ "(+ 1 2 3": { status: "error", message: "boom" } });
  const formats = mockFormat();
  const input = { path: "foo.clj", content: "(+ 1 2 3" };
  await handleBefore(beforeEvent("write", input), sessionDir);
  assert.equal(input.content, "(+ 1 2 3");
  // the un-repaired content still gets the formatting attempt
  assert.deepEqual(formats, ["(+ 1 2 3"]);
});

test("write before: non-Clojure files are skipped", async () => {
  const repairs = mockRepair({});
  const formats = mockFormat();
  await handleBefore(beforeEvent("write", { path: "foo.py", content: "x = 1" }), sessionDir);
  await handleBefore(beforeEvent("write", { path: "foo", content: "no extension" }), sessionDir);
  assert.equal(repairs.length, 0);
  assert.equal(formats.length, 0);
});

test("write before: bb shebang content is processed", async () => {
  const repairs = mockRepair({ "#!/usr/bin/env bb\n(def x 1": { status: "repaired", text: "#!/usr/bin/env bb\n(def x 1)" } });
  mockFormat();
  const input = { path: "scripts/run", content: "#!/usr/bin/env bb\n(def x 1" };
  await handleBefore(beforeEvent("write", input), sessionDir);
  assert.equal(repairs.length, 1);
  assert.equal(input.content, "#!/usr/bin/env bb\n(def x 1)");
});

test("write before: malformed input is ignored", async () => {
  const repairs = mockRepair({});
  const formats = mockFormat();
  await handleBefore(beforeEvent("write", { path: "foo.clj" }), sessionDir);
  await handleBefore(beforeEvent("write", {}), sessionDir);
  await handleBefore(beforeEvent("read", { path: "foo.clj", content: "(+ 1 2 3" }), sessionDir);
  assert.equal(repairs.length, 0);
  assert.equal(formats.length, 0);
});

test("write after: modified content gets a change note in the result", async () => {
  const file = path.join(tmp, "w.clj");
  const id = nextID();
  mockRepair({ "(def w 1": { status: "repaired", text: "(def w 1)" } });
  mockFormat();
  const input = { path: "w.clj", content: "(def w 1" };
  await handleBefore(beforeEvent("write", input, id), sessionDir);
  writeFileSync(file, input.content, "utf8"); // the write tool applied the rewritten input
  const event = afterEvent("write", {}, { content: "The file w.clj has been written." }, id);
  await handleAfter(event, sessionDir);
  const text = resultText(event.result?.content);
  assert.match(text, /Auto-repair note:/);
  assert.match(text, /repaired automatically/);
  assert.match(text, /1: \(def w 1\)/);
});

test("write after: unmodified content gets no note", async () => {
  const file = path.join(tmp, "w2.clj");
  const id = nextID();
  mockRepair({});
  mockFormat();
  const input = { path: "w2.clj", content: "(def w 1)\n" };
  await handleBefore(beforeEvent("write", input), sessionDir);
  writeFileSync(file, input.content, "utf8");
  const event = afterEvent("write", {}, { content: "ok" }, id);
  await handleAfter(event, sessionDir);
  assert.equal(resultText(event.result?.content), "ok");
});

test("write after: failed call gets no note", async () => {
  const file = path.join(tmp, "w3.clj");
  const id = nextID();
  mockRepair({ "(def w 1": { status: "repaired", text: "(def w 1)" } });
  mockFormat();
  const input = { path: "w3.clj", content: "(def w 1" };
  await handleBefore(beforeEvent("write", input), sessionDir);
  const event = afterEvent("write", {}, { content: "n/a" }, id, "error");
  await handleAfter(event, sessionDir);
  assert.equal(resultText(event.result?.content), "n/a");
});

// ---------------------------------------------------------------------------
// edit (before + after)
// ---------------------------------------------------------------------------

test("edit: repaired file gets written back and a change note with the content", async () => {
  const file = path.join(tmp, "a.clj");
  writeFileSync(file, "(def a 1)\n", "utf8");
  const id = nextID();
  await handleBefore(beforeEvent("edit", { path: "a.clj", oldString: "1", newString: "1 (oops" }, id), sessionDir);
  writeFileSync(file, "(def a 1 (oops\n", "utf8"); // simulate the applied edit
  mockRepair({ "(def a 1 (oops\n": { status: "repaired", text: "(def a 1)\n" } });
  mockFormat();
  const event = afterEvent("edit", {}, { content: [{ type: "text", text: "The file a.clj has been edited." }] }, id);
  await handleAfter(event, sessionDir);
  assert.equal(readFileSync(file, "utf8"), "(def a 1)\n");
  const text = resultText(event.result?.content);
  assert.match(text, /Auto-repair note:/);
  assert.match(text, /repaired automatically/);
  assert.match(text, /Current on-disk content:/);
  assert.match(text, /1: \(def a 1\)/);
});

test("edit: cljfmt-only change still gets written back and noticed", async () => {
  const file = path.join(tmp, "a2.clj");
  writeFileSync(file, "(def a 1)\n", "utf8");
  const id = nextID();
  await handleBefore(beforeEvent("edit", { path: "a2.clj", oldString: "1", newString: "2" }, id), sessionDir);
  writeFileSync(file, "(def a 2)\n", "utf8"); // balanced edit, nothing to repair
  mockRepair({});
  mockFormat((t) => t.replace("2", "3")); // simulate a cljfmt change
  const event = afterEvent("edit", {}, { content: "ok" }, id);
  await handleAfter(event, sessionDir);
  assert.equal(readFileSync(file, "utf8"), "(def a 3)\n");
  const text = resultText(event.result?.content);
  assert.match(text, /Auto-repair note:/);
  assert.match(text, /cljfmt reformatted/);
  assert.match(text, /1: \(def a 3\)/);
});

test("edit: balanced and unformatted file is left alone", async () => {
  const file = path.join(tmp, "a3.clj");
  writeFileSync(file, "(def a 2)\n", "utf8");
  const id = nextID();
  await handleBefore(beforeEvent("edit", { path: "a3.clj", oldString: "x", newString: "y" }, id), sessionDir);
  const repairs = mockRepair({});
  mockFormat(); // identity formatting: no change
  const event = afterEvent("edit", {}, { content: "ok" }, id);
  await handleAfter(event, sessionDir);
  assert.equal(repairs.length, 0);
  assert.equal(readFileSync(file, "utf8"), "(def a 2)\n");
  assert.equal(resultText(event.result?.content), "ok"); // no notice added
});

test("edit: unfixable file is restored and the result rewritten", async () => {
  const file = path.join(tmp, "b.clj");
  writeFileSync(file, "(def b 1)\n", "utf8");
  const id = nextID();
  await handleBefore(beforeEvent("edit", { path: "b.clj", oldString: "1", newString: "1 (oops" }, id), sessionDir);
  writeFileSync(file, "(def b 1 (oops\n", "utf8");
  mockRepair({ "(def b 1 (oops\n": { status: "unfixable", message: "unfixable" } });
  mockFormat();
  const event = afterEvent("edit", {}, { content: "The file b.clj has been edited." }, id);
  await handleAfter(event, sessionDir);
  assert.equal(readFileSync(file, "utf8"), "(def b 1)\n");
  assert.match(resultText(event.result?.content), /was reverted/);
  assert.match(resultText(event.result?.content), /retry the edit/);
});

test("write before: a repair that would move unrelated delimiters rejects the write", async () => {
  // a balanced, badly indented file plus a missing closer: parinfer would
  // rewrite the earlier forms to match their indentation instead of fixing the
  // new form, so the write is refused and nothing reaches disk
  const content = "(deftest drift-test []\n(when true\n(is true)))\n\n(deftest new-test []\n  (is (= 1\n        (inc 0)))\n";
  mockFormat();
  await assert.rejects(
    () => handleBefore(beforeEvent("write", { path: "drift.clj", content }), sessionDir),
    (err: unknown) =>
      err instanceof ToolError &&
      /were not auto-fixed/.test(err.message) &&
      /opened at line 5 is never closed/.test(err.message),
  );
});

test("edit: a repair that would move unrelated delimiters restores the file", async () => {
  const before = "(deftest drift-test []\n(when true\n(is true)))\n";
  const edited = "(deftest drift-test []\n(when true\n(is true)))\n\n(deftest new-test []\n  (is (= 1\n        (inc 0)))\n";
  const file = path.join(tmp, "drift.clj");
  writeFileSync(file, before, "utf8");
  const id = nextID();
  await handleBefore(beforeEvent("edit", { path: "drift.clj", oldString: "1", newString: "1" }, id), sessionDir);
  writeFileSync(file, edited, "utf8");
  mockFormat(); // the real parinfer engine decides

  const event = afterEvent("edit", {}, { content: "Edited!" }, id);
  await handleAfter(event, sessionDir);
  assert.equal(readFileSync(file, "utf8"), before, "the pre-edit content is back byte for byte");
  const message = resultText(event.result?.content);
  assert.match(message, /was reverted/);
  assert.match(message, /opened at line 5 is never closed/);
  assert.match(message, /rewrite 4 lines \(1, 2, 3, 7\)/);
});

test("edit: the same missing closer in a well-indented file is repaired", async () => {
  const before = "(deftest a-test []\n  (is (= 1 1)))\n";
  const edited = "(deftest a-test []\n  (is (= 1 1)))\n\n(deftest new-test []\n  (is (= 1\n        (inc 0)))\n";
  const file = path.join(tmp, "clean.clj");
  writeFileSync(file, before, "utf8");
  const id = nextID();
  await handleBefore(beforeEvent("edit", { path: "clean.clj", oldString: "1", newString: "1" }, id), sessionDir);
  writeFileSync(file, edited, "utf8");
  mockFormat();

  const event = afterEvent("edit", {}, { content: "Edited!" }, id);
  await handleAfter(event, sessionDir);
  assert.equal(
    readFileSync(file, "utf8"),
    "(deftest a-test []\n  (is (= 1 1)))\n\n(deftest new-test []\n  (is (= 1\n        (inc 0))))\n",
  );
  const message = resultText(event.result?.content);
  assert.match(message, /Auto-repair note/);
  // the repair stayed inside the region the edit changed, so nothing to flag
  assert.doesNotMatch(message, /outside the lines your change made/);
});

test("edit: a repair that reaches outside the edited lines says so", async () => {
  const before = "(defn f []\n  (let [x 1]\n    (inc x)))\n\n(def g 1)\n";
  const edited = "(defn f []\n  (let [x 1\n    (inc x)))\n\n(def g 1)\n";
  // a legal fix: the bracket returns on the error line, and one unrelated line
  // is rewritten as well, within the guard window
  const repaired = "(defn f []\n  (let [x 1]\n    (inc x)))\n\n(def g 1) ; touched\n";
  const file = path.join(tmp, "wide.clj");
  writeFileSync(file, before, "utf8");
  const id = nextID();
  await handleBefore(beforeEvent("edit", { path: "wide.clj", oldString: "[x 1]", newString: "[x 1" }, id), sessionDir);
  writeFileSync(file, edited, "utf8");
  mockRepair({ [edited]: { status: "repaired", text: repaired } });
  mockFormat();

  const event = afterEvent("edit", {}, { content: "Edited!" }, id);
  await handleAfter(event, sessionDir);
  assert.equal(readFileSync(file, "utf8"), repaired);
  assert.match(resultText(event.result?.content), /outside the lines your change made/);
  assert.match(resultText(event.result?.content), /line\(s\) 5/);
});

test("edit: failed call does not repair or restore", async () => {
  const file = path.join(tmp, "c.clj");
  writeFileSync(file, "(def c 1)\n", "utf8");
  const id = nextID();
  await handleBefore(beforeEvent("edit", { path: "c.clj", oldString: "x", newString: "y" }, id), sessionDir);
  const repairs = mockRepair({});
  mockFormat();
  await handleAfter(afterEvent("edit", {}, { content: "n/a" }, id, "error"), sessionDir);
  assert.equal(repairs.length, 0);
  assert.equal(readFileSync(file, "utf8"), "(def c 1)\n");
});

test("edit: non-Clojure files are not tracked", async () => {
  const file = path.join(tmp, "d.py");
  writeFileSync(file, "x = 1\n", "utf8");
  const id = nextID();
  await handleBefore(beforeEvent("edit", { path: "d.py", oldString: "1", newString: "2" }, id), sessionDir);
  const repairs = mockRepair({});
  mockFormat();
  await handleAfter(afterEvent("edit", {}, { content: "ok" }, id), sessionDir);
  assert.equal(repairs.length, 0);
});

test("edit: missing file is not tracked", async () => {
  const id = nextID();
  await handleBefore(beforeEvent("edit", { path: "ghost.clj", oldString: "", newString: "(def g 1)" }, id), sessionDir);
  const repairs = mockRepair({});
  mockFormat();
  await handleAfter(afterEvent("edit", {}, { content: "ok" }, id), sessionDir);
  assert.equal(repairs.length, 0);
});

// ---------------------------------------------------------------------------
// patch (before + after)
// ---------------------------------------------------------------------------

const PATCH = [
  "*** Update File: b.clj",
  "@@ -1 +1 @@",
  "-(def b 1)",
  "+(def b 1 (broken",
  "*** Add File: c.clj",
  "+(def c 1 (broken",
  "*** Update File: d.clj",
  "*** Move to: e.clj",
  "*** Delete File: f.py",
].join("\n");

const BROKEN = "(def b 1 (broken\n";
const BROKEN_C = "(def c 1 (broken\n";
const BROKEN_D = "(def d 1 (broken\n";

function setupPatchDir(dir: string) {
  writeFileSync(path.join(dir, "b.clj"), "(def b 1)\n", "utf8");
  writeFileSync(path.join(dir, "d.clj"), "(def d 1)\n", "utf8");
  writeFileSync(path.join(dir, "f.py"), "x = 1\n", "utf8");
}

function applyPatch(dir: string) {
  // simulate the patch tool applying the ops on disk
  writeFileSync(path.join(dir, "b.clj"), BROKEN, "utf8");
  writeFileSync(path.join(dir, "c.clj"), BROKEN_C, "utf8");
  writeFileSync(path.join(dir, "e.clj"), "(def d 1)\n", "utf8");
  rmSync(path.join(dir, "d.clj"));
}

test("patch: balanced and repairable files all get updated", async () => {
  const dir = path.join(tmp, "patch-backup");
  mkdirSync(dir);
  setupPatchDir(dir);
  const id = nextID();
  await handleBefore(beforeEvent("patch", { patchText: PATCH }, id), async () => dir);
  // now simulate the patch, then run after with every file repairable
  applyPatch(dir);
  const repairs = mockRepair({
    [BROKEN]: { status: "repaired", text: "(def b 1)\n" },
    [BROKEN_C]: { status: "repaired", text: "(def c 1)\n" },
  });
  mockFormat();
  const event = afterEvent("patch", {}, { content: "Applied 4 operations." }, id);
  await handleAfter(event, async () => dir);
  // b (broken, repaired) and c (broken, repaired) got repair attempts in op order
  assert.deepEqual(repairs, [BROKEN, BROKEN_C]);
  assert.equal(readFileSync(path.join(dir, "b.clj"), "utf8"), "(def b 1)\n");
  const text = resultText(event.result?.content);
  assert.match(text, /Auto-repair note: .*b\.clj/);
  assert.match(text, /Auto-repair note: .*c\.clj/);
  assert.match(text, /1: \(def b 1\)/);
});

test("patch: one unfixable file reverts the whole patch", async () => {
  const dir = path.join(tmp, "patch-update-fail");
  mkdirSync(dir);
  setupPatchDir(dir);
  const id = nextID();
  await handleBefore(beforeEvent("patch", { patchText: PATCH }, id), async () => dir);
  applyPatch(dir);
  mockRepair({
    [BROKEN]: { status: "unfixable", message: "unfixable" },
    [BROKEN_C]: { status: "repaired", text: "(def c 1)\n" },
  });
  mockFormat();
  const event = afterEvent("patch", {}, { content: "Applied 4 operations." }, id);
  await handleAfter(event, async () => dir);
  const message = resultText(event?.result?.content);
  assert.match(message, /prevented this patch: .+b\.clj/);
  assert.match(message, /The whole patch was reverted\./);
  assert.match(message, /Restored from backup: .+b\.clj/);
  // the files that repaired cleanly are rolled back too
  assert.equal(readFileSync(path.join(dir, "b.clj"), "utf8"), "(def b 1)\n");
  assert.equal(existsSync(path.join(dir, "c.clj")), false, "the added file was removed");
  assert.equal(readFileSync(path.join(dir, "d.clj"), "utf8"), "(def d 1)\n");
  assert.equal(existsSync(path.join(dir, "e.clj")), false, "the move destination was removed");
});

test("patch: unfixable move restores source and removes destination", async () => {
  const dir = path.join(tmp, "patch-move-fail");
  mkdirSync(dir);
  setupPatchDir(dir);
  const id = nextID();
  await handleBefore(beforeEvent("patch", { patchText: PATCH }, id), async () => dir);
  applyPatch(dir);
  writeFileSync(path.join(dir, "e.clj"), BROKEN_D, "utf8"); // the moved file has a broken delimiter
  mockRepair({
    [BROKEN]: { status: "repaired", text: "(def b 1)\n" },
    [BROKEN_C]: { status: "repaired", text: "(def c 1)\n" },
    [BROKEN_D]: { status: "unfixable", message: "unfixable" },
  });
  mockFormat();
  const event = afterEvent("patch", {}, { content: "Applied 4 operations." }, id);
  await handleAfter(event, async () => dir);
  assert.equal(readFileSync(path.join(dir, "d.clj"), "utf8"), "(def d 1)\n");
  assert.equal(existsSync(path.join(dir, "e.clj")), false);
  const message = resultText(event.result?.content);
  assert.match(message, /Restored from backup: .+d\.clj/);
  assert.match(message, /Removed move destinations: .+e\.clj/);
});

test("patch: a refused repair reverts the files that repaired fine", async () => {
  const dir = path.join(tmp, "patch-declined");
  mkdirSync(dir);
  setupPatchDir(dir);
  const id = nextID();
  await handleBefore(beforeEvent("patch", { patchText: PATCH }, id), async () => dir);
  applyPatch(dir);
  // a balanced proposal for b.clj, but it rewrites four lines for a one-line
  // form: the guard refuses it, and nothing in this patch may land
  const WIDE = "(a 1)\n(b 2)\n(c 3)\n(d 4)\n";
  mockRepair({
    [BROKEN]: { status: "repaired", text: WIDE },
    [BROKEN_C]: { status: "repaired", text: "(def c 1)\n" },
  });
  mockFormat();
  const event = afterEvent("patch", {}, { content: "Applied 4 operations." }, id);
  await handleAfter(event, async () => dir);
  assert.equal(readFileSync(path.join(dir, "b.clj"), "utf8"), "(def b 1)\n");
  assert.equal(existsSync(path.join(dir, "c.clj")), false, "the cleanly repaired new file never got written");
  assert.match(resultText(event.result?.content), /would have moved delimiters outside what you wrote/);
});

test("patch: unfixable add removes the new file", async () => {
  const dir = path.join(tmp, "patch-add-fail");
  mkdirSync(dir);
  setupPatchDir(dir);
  const id = nextID();
  await handleBefore(beforeEvent("patch", { patchText: PATCH }, id), async () => dir);
  applyPatch(dir);
  mockRepair({
    [BROKEN]: { status: "repaired", text: "(def b 1)\n" },
    [BROKEN_C]: { status: "unfixable", message: "unfixable" },
  });
  mockFormat();
  const event = afterEvent("patch", {}, { content: "Applied 4 operations." }, id);
  await handleAfter(event, async () => dir);
  assert.equal(existsSync(path.join(dir, "c.clj")), false);
  assert.match(resultText(event.result?.content), /Removed newly added files: .+c\.clj/);
});

test("patch: a deleted Clojure file comes back when the patch is reverted", async () => {
  const dir = path.join(tmp, "patch-delete-restore");
  mkdirSync(dir);
  setupPatchDir(dir);
  writeFileSync(path.join(dir, "g.clj"), "(def g 1)\n", "utf8");
  const patch = ["*** Update File: b.clj", "*** Delete File: g.clj"].join("\n");
  const id = nextID();
  await handleBefore(beforeEvent("patch", { patchText: patch }, id), async () => dir);
  // the patch lands: b.clj is left broken and g.clj is gone
  writeFileSync(path.join(dir, "b.clj"), BROKEN, "utf8");
  rmSync(path.join(dir, "g.clj"));
  mockRepair({ [BROKEN]: { status: "unfixable", message: "unfixable" } });
  mockFormat();
  const event = afterEvent("patch", {}, { content: "Applied 2 operations." }, id);
  await handleAfter(event, async () => dir);
  assert.equal(readFileSync(path.join(dir, "g.clj"), "utf8"), "(def g 1)\n");
  assert.match(resultText(event.result?.content), /Restored from backup: .+b\.clj, .+g\.clj/);
});

test("patch: failed call does not repair or revert", async () => {
  const dir = path.join(tmp, "patch-error-status");
  mkdirSync(dir);
  setupPatchDir(dir);
  const id = nextID();
  await handleBefore(beforeEvent("patch", { patchText: PATCH }, id), async () => dir);
  applyPatch(dir);
  const repairs = mockRepair({});
  mockFormat();
  await handleAfter(afterEvent("patch", {}, { content: "n/a" }, id, "error"), async () => dir);
  assert.equal(repairs.length, 0);
  assert.equal(readFileSync(path.join(dir, "b.clj"), "utf8"), BROKEN);
});

// ---------------------------------------------------------------------------
// integration: real repairText (in-process parinfer)
// ---------------------------------------------------------------------------

test("repairText: real parinfer, indent mode", () => {
  const fixed = repairText("(+ 1 2 3");
  assert.deepEqual(fixed, { status: "repaired", text: "(+ 1 2 3)" });

  const multiline = repairText("(defn add [a b]\n  (+ a b");
  assert.deepEqual(multiline, { status: "repaired", text: "(defn add [a b]\n  (+ a b))" });

  const unfixable = repairText("#(\"foo");
  assert.equal(unfixable.status, "unfixable");

  const balanced = repairText("(def x 1)");
  assert.deepEqual(balanced, { status: "repaired", text: "(def x 1)" });
});

// ---------------------------------------------------------------------------
// integration: formatWithCljfmt
// ---------------------------------------------------------------------------

function withPath(dir: string, fn: () => Promise<void>) {
  const oldPath = process.env.PATH;
  process.env.PATH = dir;
  _internals.resetCljfmtCache();
  return fn().finally(() => {
    process.env.PATH = oldPath;
    _internals.resetCljfmtCache();
  });
}

test("formatWithCljfmt: no cljfmt on PATH returns input unchanged", async () => {
  const emptyDir = mkdtempSync(path.join(tmpdir(), "cplr-empty-path-"));
  await withPath(emptyDir, async () => {
    assert.equal(resolveCljfmt(), null);
    assert.equal(await formatWithCljfmt("(def x 1)"), "(def x 1)");
  });
});

test("formatWithCljfmt: invokes cljfmt fix - with stdin", async () => {
  const fakeDir = mkdtempSync(path.join(tmpdir(), "cplr-fake-cljfmt-"));
  // identity formatter in pure shell (the test overrides PATH, so no cat)
  writeFileSync(path.join(fakeDir, "cljfmt"), "#!/bin/sh\nwhile IFS= read -r line; do printf '%s\\n' \"$line\"; done\n", {
    mode: 0o755,
  });
  await withPath(fakeDir, async () => {
    assert.match(resolveCljfmt() ?? "", /cljfmt$/);
    assert.equal(await formatWithCljfmt("(def x 1)\n"), "(def x 1)\n");
  });
});

test("formatWithCljfmt: whitespace-only output is applied", async () => {
  const fakeDir = mkdtempSync(path.join(tmpdir(), "cplr-fake-cljfmt-reindent-"));
  writeFileSync(path.join(fakeDir, "cljfmt"), "#!/bin/sh\nprintf '(def x\\n  1)\\n'\n", { mode: 0o755 });
  await withPath(fakeDir, async () => {
    assert.equal(await formatWithCljfmt("(def x\n1)"), "(def x\n  1)\n");
  });
});

test("formatWithCljfmt: output that changes code is discarded", async () => {
  const fakeDir = mkdtempSync(path.join(tmpdir(), "cplr-fake-cljfmt-code-change-"));
  writeFileSync(path.join(fakeDir, "cljfmt"), "#!/bin/sh\nprintf '(def x 2)\\n'\n", { mode: 0o755 });
  await withPath(fakeDir, async () => {
    // cljfmt moves whitespace; anything else is treated as a broken tool rather
    // than written over the author's code
    assert.equal(await formatWithCljfmt("(def x 1)"), "(def x 1)");
  });
});

test("formatWithCljfmt: empty output cannot empty the file", async () => {
  const fakeDir = mkdtempSync(path.join(tmpdir(), "cplr-fake-cljfmt-empty-"));
  // reads stdin, exits 0, writes nothing: what cljfmt does when it chokes
  writeFileSync(path.join(fakeDir, "cljfmt"), "#!/bin/sh\nwhile IFS= read -r line; do :; done\n", { mode: 0o755 });
  await withPath(fakeDir, async () => {
    assert.equal(await formatWithCljfmt("(def x 1)"), "(def x 1)");
  });
});

test("formatWithCljfmt: unparseable input is reported, not written back", async () => {
  const fakeDir = mkdtempSync(path.join(tmpdir(), "cplr-fake-cljfmt-unparseable-"));
  // real cljfmt exits 0 with empty stdout and this on stderr when it cannot read
  // the forms; writing that back would empty the file
  writeFileSync(
    path.join(fakeDir, "cljfmt"),
    "#!/bin/sh\nwhile IFS= read -r line; do :; done\nprintf 'Failed to format file: STDIN\\n' >&2\n",
    { mode: 0o755 },
  );
  await withPath(fakeDir, async () => {
    assert.equal(await formatWithCljfmt("(def x (1"), "(def x (1");
  });
});

test("formatWithCljfmt: failing cljfmt fails open", async () => {
  const fakeDir = mkdtempSync(path.join(tmpdir(), "cplr-fake-cljfmt-"));
  writeFileSync(path.join(fakeDir, "cljfmt"), "#!/bin/sh\necho broken >&2\nexit 1\n", { mode: 0o755 });
  await withPath(fakeDir, async () => {
    assert.equal(await formatWithCljfmt("(def x 1)"), "(def x 1)");
  });
});

test("formatWithCljfmt: real cljfmt when available", async (t) => {
  _internals.resetCljfmtCache();
  const bin = resolveCljfmt();
  if (!bin) {
    t.skip("cljfmt not on PATH");
    return;
  }
  const out = await formatWithCljfmt("(defn foo [x]\n(* x 2)\n)\n");
  assert.equal(out, "(defn foo [x]\n  (* x 2))\n");
});

// ---------------------------------------------------------------------------
// nREPL: bencode codec
// ---------------------------------------------------------------------------

test("writeBencode: flat map with lexicographically sorted keys", () => {
  const buf = writeBencode({ op: "eval", id: "1", code: "(def a 1)" });
  assert.equal(buf.toString("utf8"), "d4:code9:(def a 1)2:id1:12:op4:evale");
});

test("bencode round-trip: nested maps, lists, integers, multi-byte strings", () => {
  const value = {
    versions: { clojure: { "version-string": "1.11" } },
    ops: ["clone", "eval"],
    count: 42,
    name: "héllo",
  };
  const parsed = readBencode(writeBencode(value), 0);
  assert.deepEqual(parsed?.[0], value);
});

test("readBencode: incomplete buffers return null", () => {
  const buf = writeBencode({ op: "eval", code: "(def a 1)" });
  for (let n = 1; n < buf.length; n++) {
    assert.equal(readBencode(buf.subarray(0, n), 0), null, `prefix of ${n} bytes`);
  }
});

test("bencode: string lengths count bytes, not characters", () => {
  assert.equal(writeBencode("héllo").subarray(0, 2).toString("utf8"), "6:");
});

// ---------------------------------------------------------------------------
// nREPL: fake server (speaks the same bencode wire format)
// ---------------------------------------------------------------------------

class FakeNrepl {
  server: net.Server | null = null;
  port = 0;
  sessions = new Map<string, Map<string, string>>(); // session id -> vars
  private sessionSeq = 0; // monotonic: ids stay unique even after dropSessions
  received: Record<string, unknown>[] = [];
  ignoreEval = false; // for timeout tests
  connectionCount = 0;

  async listen() {
    this.server = net.createServer((sock) => {
      this.connectionCount++;
      sock.on("error", () => {}); // ignore ECONNRESET/EPIPE from client disconnects
      let buf = Buffer.alloc(0);
      sock.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          const parsed = readBencode(buf, 0);
          if (parsed === null) return;
          const [value, next] = parsed;
          buf = buf.subarray(next);
          this.handle(sock, value as Record<string, unknown>);
        }
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.port = (this.server!.address() as net.AddressInfo).port;
  }

  private send(sock: net.Socket, msg: Record<string, unknown>) {
    sock.write(writeBencode(msg));
  }

  private handle(sock: net.Socket, msg: Record<string, unknown>) {
    this.received.push(msg);
    if (this.ignoreEval && msg.op === "eval") return;
    switch (msg.op) {
      case "clone": {
        const session = `sess-${++this.sessionSeq}`;
        this.sessions.set(session, new Map());
        this.send(sock, { "new-session": session, id: msg.id, status: ["done"] });
        break;
      }
      case "ls-sessions":
        this.send(sock, { sessions: [...this.sessions.keys()], id: msg.id, status: ["done"] });
        break;
      case "close":
        this.sessions.delete(String(msg.session));
        this.send(sock, { session: msg.session, id: msg.id, status: ["done"] });
        break;
      case "interrupt":
        this.send(sock, { status: ["interrupted", "done"], id: msg.id });
        break;
      case "eval":
        this.evalReply(sock, msg);
        break;
    }
  }

  private evalReply(sock: net.Socket, msg: Record<string, unknown>) {
    const session = typeof msg.session === "string" ? msg.session : undefined;
    const state = session ? this.sessions.get(session) : undefined;
    const code = String(msg.code);
    const base = { id: msg.id, ...(session ? { session } : {}) };
    if (code.includes("println")) {
      this.send(sock, { ...base, out: "hello\n", status: [] });
      this.send(sock, { ...base, value: "nil", ns: "user", status: ["done"] });
    } else if (code === "boom") {
      this.send(sock, {
        ...base,
        ex: "java.lang.Exception",
        err: "boom at repl1:1\n",
        trace: "user/eval (fake.clj:1)\n".repeat(200),
        ns: "user",
        status: ["done"],
      });
    } else if (code === "(+ 1 2 3)") {
      this.send(sock, { ...base, value: "6", ns: "user", status: ["done"] });
    } else if (code === "(+ 1 1)") {
      this.send(sock, { ...base, value: "2", ns: "user", status: ["done"] });
    } else if (code.startsWith("(def ")) {
      const name = code.match(/\(def (\w+)/)?.[1] ?? "";
      const value = code.match(/\(def \w+ (.+?)\)$/)?.[1] ?? "nil";
      state?.set(name, value);
      this.send(sock, { ...base, value, ns: "user", status: ["done"] });
    } else if (/^\w+$/.test(code) && state?.has(code)) {
      this.send(sock, { ...base, value: state.get(code)!, ns: "user", status: ["done"] });
    } else {
      this.send(sock, { ...base, value: "nil", ns: "user", status: ["done"] });
    }
  }

  dropSessions() {
    this.sessions.clear(); // simulate an nREPL server restart
  }

  async close() {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}

// ---------------------------------------------------------------------------
// nREPL: evalClojure
// ---------------------------------------------------------------------------

test("evalClojure: returns the value and namespace", async () => {
  const server = startServer();
  await server.listen();
  const out = await evalClojure({ code: "(+ 1 2 3)", dir: tmp, port: server.port });
  assert.match(out, /=> 6/);
  assert.match(out, /;; namespace: user/);
});

test("evalClojure: state persists across calls in one session", async () => {
  const server = startServer();
  await server.listen();
  await evalClojure({ code: "(def counter 10)", dir: tmp, port: server.port });
  const out = await evalClojure({ code: "counter", dir: tmp, port: server.port });
  assert.match(out, /=> 10/);
  const clones = server.received.filter((m) => m.op === "clone");
  assert.equal(clones.length, 1);
  const evals = server.received.filter((m) => m.op === "eval");
  assert.equal(evals[0].session, evals[1].session);
});

test("evalClojure: code is repaired before evaluation", async () => {
  const server = startServer();
  await server.listen();
  const out = await evalClojure({ code: "(+ a b", dir: tmp, port: server.port });
  const evals = server.received.filter((m) => m.op === "eval");
  assert.equal(evals[0].code, "(+ a b)");
  assert.match(out, /=> nil/);
});

test("evalClojure: unfixable code is rejected without connecting", async () => {
  const server = startServer();
  await server.listen();
  await assert.rejects(
    () => evalClojure({ code: '#("foo', dir: tmp, port: server.port }),
    (err: unknown) => err instanceof ToolError && err.message.includes("delimiter errors"),
  );
  assert.equal(server.received.length, 0);
});

test("evalClojure: stdout arrives as out before the value", async () => {
  const server = startServer();
  await server.listen();
  const out = await evalClojure({ code: '(println "hello")', dir: tmp, port: server.port });
  assert.match(out, /hello/);
  assert.match(out, /=> nil/);
});

test("evalClojure: exceptions surface with a truncated trace", async () => {
  const server = startServer();
  await server.listen();
  const out = await evalClojure({ code: "boom", dir: tmp, port: server.port });
  assert.match(out, /Exception: java\.lang\.Exception/);
  assert.match(out, /boom at repl1:1/);
  assert.match(out, /\.\.\. \(truncated\)/);
});

test("evalClojure: port discovered from .nrepl-port", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cplr-nrepl-port-"));
  const server = startServer();
  await server.listen();
  writeFileSync(path.join(dir, ".nrepl-port"), `${server.port}\n`);
  const out = await evalClojure({ code: "(+ 1 1)", dir });
  assert.match(out, /=> 2/);
});

test("evalClojure: port discovered from .shadow-cljs/.nrepl-port", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cplr-shadow-port-"));
  mkdirSync(path.join(dir, ".shadow-cljs"));
  const server = startServer();
  await server.listen();
  writeFileSync(path.join(dir, ".shadow-cljs", ".nrepl-port"), String(server.port));
  const out = await evalClojure({ code: "(+ 1 1)", dir });
  assert.match(out, /=> 2/);
});

test("findNreplPort: missing or invalid files yield null", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cplr-nrepl-none-"));
  assert.equal(findNreplPort(dir), null);
  writeFileSync(path.join(dir, ".nrepl-port"), "not-a-port\n");
  assert.equal(findNreplPort(dir), null);
});

test("evalClojure: no port and no port file is an error", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cplr-nrepl-noport-"));
  await assert.rejects(
    () => evalClojure({ code: "1", dir }),
    (err: unknown) => err instanceof ToolError && err.message.includes(".nrepl-port"),
  );
});

test("evalClojure: connection refused is an error", async () => {
  const listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  await assert.rejects(
    () => evalClojure({ code: "1", dir: tmp, port }),
    (err: unknown) => err instanceof ToolError && err.message.includes("Could not connect"),
  );
});

test("evalClojure: timeout interrupts the evaluation", async () => {
  const server = startServer();
  await server.listen();
  server.ignoreEval = true;
  await assert.rejects(
    () => evalClojure({ code: "(Thread/sleep 10000)", dir: tmp, port: server.port, timeoutMs: 100 }),
    (err: unknown) => err instanceof ToolError && err.message.includes("timed out"),
  );
  await waitFor(() => server.received.some((m) => m.op === "interrupt"));
});

test("evalClojure: reconnects and keeps the session", async () => {
  const server = startServer();
  await server.listen();
  await evalClojure({ code: "(def x 42)", dir: tmp, port: server.port });
  _internals.dropNreplConnection("127.0.0.1", server.port);
  const out = await evalClojure({ code: "x", dir: tmp, port: server.port });
  assert.match(out, /=> 42/);
  const evals = server.received.filter((m) => m.op === "eval");
  assert.equal(evals[0].session, evals[1].session);
});

test("evalClojure: server restart creates a fresh session", async () => {
  const server = startServer();
  await server.listen();
  await evalClojure({ code: "(def x 1)", dir: tmp, port: server.port });
  server.dropSessions();
  _internals.dropNreplConnection("127.0.0.1", server.port);
  const out = await evalClojure({ code: "(+ 1 2 3)", dir: tmp, port: server.port });
  assert.match(out, /=> 6/);
  const evals = server.received.filter((m) => m.op === "eval");
  assert.notEqual(evals[0].session, evals[1].session);
});

// ---------------------------------------------------------------------------
// nREPL: tool registration via plugin setup
// ---------------------------------------------------------------------------

test("setup: registers the clojure-nrepl-eval tool end-to-end", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cplr-setup-"));
  const server = startServer();
  await server.listen();
  writeFileSync(path.join(dir, ".nrepl-port"), String(server.port));

  const added: { name: string; execute: (input: unknown, context: unknown) => Promise<{ content: string }> }[] = [];
  const ctx = {
    location: { directory: dir },
    session: { get: async () => ({ location: { directory: dir } }) },
    tool: {
      hook: async () => ({ dispose: async () => {} }),
      transform: async (cb: (editor: { add: (tool: unknown) => void }) => void) => {
        cb({ add: (tool) => added.push(tool as never) });
        return { dispose: async () => {} };
      },
    },
  };

  const cleanup = await plugin.setup(ctx as never);
  assert.equal(added.length, 1);
  assert.equal(added[0].name, "clojure-nrepl-eval");

  const result = await added[0].execute(
    { code: "(+ 1 2 3)" },
    { sessionID: "ses_test", signal: new AbortController().signal, progress: async () => {} },
  );
  assert.match(result.content, /=> 6/);

  if (typeof cleanup === "function") await cleanup();
  await waitFor(() => server.received.some((m) => m.op === "close"));
});

test("setup: empty code is rejected before connecting", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cplr-setup-empty-"));
  const server = startServer();
  await server.listen();

  const added: { execute: (input: unknown, context: unknown) => Promise<{ content: string }> }[] = [];
  const ctx = {
    location: { directory: dir },
    session: { get: async () => ({ location: { directory: dir } }) },
    tool: {
      hook: async () => ({ dispose: async () => {} }),
      transform: async (cb: (editor: { add: (tool: unknown) => void }) => void) => {
        cb({ add: (tool) => added.push(tool as never) });
        return { dispose: async () => {} };
      },
    },
  };

  const cleanup = await plugin.setup(ctx as never);
  await assert.rejects(
    () =>
      added[0].execute(
        { code: "   " },
        { sessionID: "ses_test", signal: new AbortController().signal, progress: async () => {} },
      ),
    (err: unknown) => err instanceof ToolError,
  );
  assert.equal(server.received.length, 0);
  if (typeof cleanup === "function") await cleanup();
});
