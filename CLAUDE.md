# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An infinite agent loop that evolves JavaScript quines. Each iteration asks the local `claude` CLI to produce a quine that strictly beats the incumbent in **bytes AND executed steps**, passes a **literal-fraction cap**, and convinces an **LLM judge** it is more interesting — then commits it to `completed/` with git and pushes.

Everything lives in **one file**, `src/quiner.ts`, which is both entrypoints: `npm start` runs the loop; `tsx src/quiner.ts verify-server` runs the MCP server handed to claude sessions (an entrypoint guard keeps imports side-effect-free, which is how the tests import it). Prompt text lives in `prompts/*.md` templates with `{{var}}` placeholders, read fresh on every use — editing them takes effect next iteration without a restart.

## Commands

```sh
npm start            # run the loop (Ctrl-C stops cleanly; restart resumes from last commit)
npm run typecheck    # tsc
npm run test:verify  # full test suite (single tsx script, no per-test selection; ~30s, spawns node repeatedly)
```

Useful env knobs on `npm start`: `QUINER_MAX_ITERATIONS=1` (single iteration / smoke test), `QUINER_EFFORT=low` (cheap generator; default is `fable`/`max`, judge is `opus`/`high`), `QUINER_STREAM=0` (quiet logs), `QUINER_JUDGE=0` (skip LLM judge). Full table in README.md.

Note: macOS has no `timeout` command, and `/var` is a symlink to `/private/var` (already handled in `measureSteps` via `realpathSync` — keep that in mind for any new tmpdir-path comparisons).

## Hard constraints (do not regress)

- **Never call the Anthropic API.** All LLM calls go through the local `claude` CLI in print mode via `runClaude()`, which spawns `claude --output-format stream-json … -p <prompt>`, parses events line-by-line (the terminal `result` event carries the text and the session id used by `--resume`), and strips `ANTHROPIC_API_KEY` (subscription billing) and `CLAUDECODE` (allows nesting) from the child env.
- **The gate lives in exactly one function**: `evaluateCandidate()`. It is shared verbatim by the `verify_candidate` MCP tool (verify-server mode), the generation loop, and the commit-time re-check. Never fork or approximate it.
- **Validity runs from stdin on purpose**: candidates are piped to `node -` from an empty temp dir, so their source never exists on disk during verification — this is the load-bearing defense against read-your-own-source cheats (an obfuscated bypass was proven against the earlier file-based approach; `src/test-verify.ts` has the regression test). Do not switch the validity run to a file. The metrics run (`measureSteps`) is file-based (V8 coverage needs a script URL) but byte-checks stdout again.
- **Prompts mirror the verifier exactly.** Every enforced rule is stated in `prompts/rules.md`, and `prompts/judge-criteria.md` goes verbatim to both generator (via rule 7) and judge. When changing the gate, update the templates and the `verify_candidate` tool description in the same change. Template substitution is a single pass over the template only, so program text containing `{{…}}` cannot inject — keep it that way.
- **The commit-time re-check is deterministic only.** The LLM judge runs once per candidate (after the deterministic gate); re-running it at commit would make commits flaky on a nondeterministic check. Judge transport failures fail OPEN (accept + loud note) so an outage can't wedge the loop.

## Architecture (sections of src/quiner.ts, top to bottom)

1. **Config** — all `QUINER_*` env knobs resolve once at module load.
2. **Prompt templates** — `loadPrompt(name, vars)` reads `prompts/<name>.md` per call.
3. **Claude CLI wrapper** — `runClaude()`: detached spawn (own process group, so timeout/abort kill claude *and* its subprocesses), settle-on-close with an exit fallback (a surviving grandchild holding the pipe can't hang the loop), session id captured from the `init` event too (so timed-out sessions stay resumable), live-process registry for hard shutdown.
4. **Verification + metrics** — banned-token regexes (incl. determinism bans: `random`, `Date`, `hrtime`, `performance`, `stack`) → acorn literal fraction ≤ 0.5 (merged intervals) → stdin validity run (byte-exact, 10s/64MB) → `NODE_V8_COVERAGE` step count → strict `>` on both bytes and steps, all composed in `evaluateCandidate()`.
5. **State** — `scanState()` rebuilds from `completed/` each turn; git + that folder are the only durable state; `state.json` is a cache (also memoizes measured steps for legacy files without the `-<steps>s` filename suffix). The incumbent is the **highest-seq** valid file (the both-axes rule totally orders the chain). `commitQuine()` writes atomically (tmp + rename), stages with `git add -A` on `completed/` (sweeps crash orphans), commits `--no-verify --no-gpg-sign` with the judge note in the message body, then best-effort pushes `HEAD` to the first remote.
6. **Judge** — fresh `claude -p` session per candidate, all tools disallowed, both program texts framed as data (prompt-injection guard), strict-JSON verdict with retry-on-malformed.
7. **Iteration** (`runIteration`) — writes the per-iteration MCP config (`workspace/.quiner-mcp.json`) pointing back at this file in verify-server mode with thresholds in env; attempt loop resumes the same generator session on failure (judge critiques included); failure state is per-iteration.
8. **Loop** (`mainLoop`) — pidfile lock (`.quiner.pid`), abortable sleeps, failure backoff, two-stage signal handling (first SIGINT aborts in-flight sessions via a shared `AbortController`; second reaps children and exits).
9. **verify-server mode** — the MCP server exposing `verify_candidate`, reading `QUINER_WORKSPACE`/`QUINER_BEST_LENGTH`/`QUINER_BEST_STEPS` from env.

The agent works in `workspace/` (gitignored, pinned to CommonJS via its own package.json so self-tests match the verifier) and delivers `workspace/candidate.js`.

## Testing notes

`src/test-verify.ts` is assertion-style PASS/FAIL, no framework. Tests that exercise `measureSteps`/`evaluateCandidate` must use **real quines** (both byte-check stdout against the source); known-good specimens live at the top of the file. The obfuscated-cheat case and the determinism case are regression tests for real bugs — keep them.

A live end-to-end smoke test costs one real claude session: `QUINER_MAX_ITERATIONS=1 QUINER_EFFORT=low QUINER_STREAM=0 npm start`. A free smoke of the loop machinery: prepend a stub `claude` script that exits 1 to `PATH` and run the same command — all attempts fail fast and the loop exits cleanly.
