# opencode-clojure

[OpenCode](https://opencode.ai) v2 plugin for Clojure development:
auto-repairs Clojure delimiter errors when the model writes or edits
Clojure files (zero extra LLM tokens), and exposes a `clojure-nrepl-eval`
tool that evaluates code against the project's nREPL server. It is
self-contained: delimiter repair runs in-process through the
[parinfer](https://www.npmjs.com/package/parinfer) npm package
(`indentMode` — Parinfer's indent mode), the nREPL client (bencode wire
protocol) is implemented in-process, and formatting runs
[`cljfmt`](https://github.com/weavejester/cljfmt) directly when it is on
`PATH`. No babashka, no external repair tool.

## Behavior

| Tool | Before the call | After the call |
|------|-----------------|----------------|
| `write` | Content is repaired in-process (and formatted, if cljfmt is available) and replaced in the tool input. Unfixable content **rejects the write** (`Tool.Error`) before anything hits disk. | When the content was modified, the result carries a change note (current on-disk content, or a diff for large files) so the model does not act on a stale view. |
| `edit` | The file is backed up in memory (keyed by the tool call ID). | The on-disk file is repaired and formatted. Unfixable → the backup is restored and the result tells the model to fix the delimiters and retry. Changed → the result carries a change note with the current on-disk content (small files) or a diff of the changed lines (large files). |
| `patch` | Every existing Clojure file the patch will update or move-from is backed up. | Each resulting Clojure file is repaired and formatted. Unfixable → per-op revert (update/move: restore the backup, move also removes the destination; add: delete the new file) and the result lists what was restored, removed, and left in place. Changed → per-file change notes under a size budget (a file whose note does not fit gets a re-read notice instead). |

Details:

- **Balanced code is never touched.** A small Clojure-aware scanner
  (strings, char literals, line comments, regex literals, delimiter stack)
  only runs the repair engine when delimiters are actually unbalanced, so
  valid files are never rewritten.
- **Non-Clojure files are ignored.** A file counts as Clojure when its name
  ends in `.clj`, `.cljs`, `.cljc`, `.cljd`, `.bb`, `.lpy`, or `.edn`
  (case-insensitive), or its first line is a `#!/.../bb` or `#!/.../env bb`
  shebang.
- **cljfmt is optional.** When a `cljfmt` executable is found on `PATH`,
  every repaired (or clean) Clojure result is formatted with `cljfmt fix -`
  (stdin to stdout, 30s timeout). Otherwise formatting is skipped and only
  delimiter repair happens.
- **Fail open.** If repair or formatting fails for any reason, the operation
  proceeds with the un-repaired content and a warning is logged.
- **Relative paths** (e.g. `foo.clj`) are resolved against the session's
  working directory.

## REPL evaluation

The plugin registers a `clojure-nrepl-eval` tool so the model can evaluate
Clojure against the project's nREPL server without any external binary or
custom-instructions teaching:

- **State persists between calls.** One persistent nREPL session per
  host:port (created with `clone`, re-validated with `ls-sessions` after any
  reconnect), so a namespace required in one call is available in the next —
  the same statefulness `clj-nrepl-eval` gives from the command line.
- **Repair first.** The same delimiter repair runs on the code before
  evaluation; unfixable code is rejected with an error instead of being
  evaluated.
- **Port discovery.** An explicit `port` input, otherwise `.nrepl-port` (or
  `.shadow-cljs/.nrepl-port`) in the session's working directory.
- **Timeouts.** 120s by default, per-call `timeoutMs`; on timeout the running
  evaluation is interrupted via nREPL's `interrupt` op.

Input: `{ code, port?, host? (default 127.0.0.1), timeoutMs? }`. Results
carry the evaluated values (`=>`), stdout/stderr, the active namespace, and
any exception with a truncated trace. Evaluation errors (an exception thrown
by the code) are returned as normal results so the model can read them;
operational failures (no port, connection refused, timeout, unfixable
code) fail the tool call with a `Tool.Error`.

## Requirements

- [OpenCode](https://opencode.ai) v2
- Node.js 23.6+ (or any OpenCode v2 runtime) — the plugin is plain
  TypeScript loaded natively, no build step.
- Optionally, [`cljfmt`](https://github.com/weavejester/cljfmt) on `PATH`
  for formatting (standalone binary, `clj -Ttools`, or any wrapper exposing
  a `cljfmt` command that accepts `fix -`).

## Setup

Install the plugin's dependencies once:

```bash
cd opencode-clojure
npm ci
```

Point OpenCode at the plugin from your project's `opencode.json` (see
[settings_example/opencode.json.example](../settings_example/opencode.json.example)):

```json
{
  "plugins": ["./opencode-clojure"]
}
```

Relative paths resolve against the config file's directory; the plugin's
entrypoint is `opencode-clojure/index.ts`. The plugin takes no options.

## Live reload

Edits to the plugin are picked up by a running OpenCode background service
without a restart (verified against opencode v2.0.8 with the plugin
referenced from a project `opencode.json` as above). If a change is not
picked up, `opencode service restart` (or restart the OpenCode session)
loads it.

## Development

```bash
cd opencode-clojure
npm test         # node --test: unit tests + integration tests
npm run typecheck  # strict tsc, no build step
```

The integration tests run the real in-process parinfer, the real `cljfmt`
when it is on `PATH` (skipped gracefully otherwise), and a fake in-process
bencode nREPL server for the `clojure-nrepl-eval` tool.

## Acknowledgements

[clojure-mcp-light](https://github.com/bhauman/clojure-mcp-light) provided the
inspiration for this project, aiming to provide a more streamlined setup story
with Opencode.

[Exoscale's On-Demand
Inference](https://www.exoscale.com/ai-cloud-infrastructure/inference/on-demand/)
provided tokens that enabled this plugin to exist.
