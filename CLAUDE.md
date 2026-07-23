# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An infinite agent loop that evolves JavaScript quines. Each iteration asks the local `claude` CLI to produce a quine that strictly beats the incumbent in **bytes AND executed steps**, passes a **literal-fraction cap**, and convinces an **LLM judge** it is more interesting — then commits it to `completed/` with git.

## Commands

```sh
npm start            # run the loop (Ctrl-C stops cleanly; restart resumes from last commit)
npm run typecheck    # tsc
npm run test:verify  # full test suite (single tsx script, no per-test selection; ~30s, spawns node repeatedly)
npm run dev          # mastra dev playground (optional)
```

Useful env knobs on `npm start`: `QUINER_MAX_ITERATIONS=1` (single iteration / smoke test), `QUINER_EFFORT=low`, `QUINER_STREAM=0` (quiet logs), `QUINER_JUDGE=0` (skip LLM judge). Full table in README.md.

Note: macOS has no `timeout` command, and `/var` is a symlink to `/private/var` (already handled in `measureSteps` via `realpathSync` — keep that in mind for any new tmpdir-path comparisons).

## Hard constraints (do not regress)

- **Never call the Anthropic API.** All LLM calls go through the local `claude` CLI in print mode via `runClaude()` (`src/mastra/utils/claude-cli.ts`), which strips `ANTHROPIC_API_KEY` (subscription billing) and `CLAUDECODE` (allows nesting) from the child env. The pattern is copied from `~/projects/thegoldenmule/hotseat/hotseat-executor/src/adapters/claude-code.ts` — consult that adapter before changing flag handling or stream-json parsing.
- **The gate lives in exactly one place**: `evaluateCandidate()` in `src/mastra/utils/quine.ts`. It is shared verbatim by the `verify_candidate` MCP tool (`src/mastra/tools/verify-server.ts`), the workflow check, and the commit-time re-check. Never fork or approximate it.
- **Validity runs from stdin on purpose**: candidates are piped to `node -` from an empty temp dir, so their source never exists on disk during verification — this is the load-bearing defense against read-your-own-source cheats (an obfuscated bypass was proven against the earlier file-based approach; `src/test-verify.ts` has the regression test). Do not switch the validity run to a file. The metrics run (`measureSteps`) is file-based (V8 coverage needs a script URL) but byte-checks stdout again.
- **Prompts mirror the verifier exactly.** Every enforced rule is stated in `RULES` / `JUDGE_CRITERIA` in `src/mastra/prompts.ts`, and the same criteria text goes to both generator and judge. When changing the gate, update `prompts.ts` and the `verify_candidate` tool description in the same change.
- **Workflow snapshot persistence stays off** (`shouldPersistSnapshot: () => false` in the workflow): snapshots would grow `mastra.db` by O(quine size) every iteration, forever. Don't route quine sources through workflow `inputData` either — the generate step reads the incumbent from `bestFile` itself for the same reason.
- **Commit-time re-check is deterministic only.** The LLM judge runs once per candidate inside `generate-and-verify` (after the deterministic gate); re-running it at commit would make commits flaky on a nondeterministic check. Judge transport failures fail OPEN (accept + loud note) so an outage can't wedge the loop.

## Architecture

`src/loop.ts` runs forever with a pidfile lock (`.quiner.pid`), abortable sleeps, and two-stage signal handling (first SIGINT aborts the in-flight claude session via a shared `AbortController` in `utils/shutdown.ts` and process-group kills; second reaps children and exits). Each turn:

1. `scanState()` (`src/mastra/utils/state.ts`) rebuilds state from a scan of `completed/` — git + that folder are the only durable state; `state.json` is a cache (it also memoizes measured steps for legacy files). The incumbent is the **highest-seq** valid file: the both-axes rule makes the chain totally ordered. Filenames encode everything: `quine-<seq>-<bytes>b-<steps>s.js`.
2. The Mastra workflow (`src/mastra/workflows/quine-workflow.ts`) runs `generate-and-verify` → `commit-quine`:
   - Writes a per-iteration MCP config (`workspace/.quiner-mcp.json`) so the generator session gets the `verify_candidate` tool with current thresholds baked in (loaded with `--mcp-config --strict-mcp-config`). The agent works in `workspace/` (gitignored, pinned to CommonJS via its own package.json so self-tests match the verifier), writes `candidate.js`, and iterates against the tool.
   - Attempt loop (`QUINER_MAX_ATTEMPTS`): failures — including judge rejections with their critique — resume the *same* generator session via `--resume`; if the session died without an id, the retry restates the full task in a fresh session (`freshRetryPrompt`). Failure state is per-iteration; nothing carries across iterations except the committed incumbent.
   - The judge (`src/mastra/llm/judge.ts`) is its own fresh `claude -p` session per candidate, all tools disallowed, strict-JSON verdict with retry-on-malformed; both program texts are framed as data (prompt-injection guard). Verdict lands in the git commit message.
3. `commitQuine()` writes atomically (tmp + rename), stages with `git add -A` on `completed/` (sweeps orphans from crashes), commits with `--no-verify --no-gpg-sign`.

Evaluation layers in `evaluateCandidate`, in order: banned tokens (whole-word regexes — includes determinism bans: `random`, `Date`, `hrtime`, `performance`, plus `stack`) → acorn literal fraction ≤ 0.5 (merged intervals) → stdin validity run (byte-exact, 10s/64MB) → `NODE_V8_COVERAGE` step count (deterministic because candidates must be deterministic) → strict `>` on both bytes and steps.

## Testing notes

`src/test-verify.ts` is assertion-style PASS/FAIL, no framework. Tests that exercise `measureSteps`/`evaluateCandidate` must use **real quines** (both byte-check stdout against the source); known-good specimens live at the top of the file. The obfuscated-cheat case and the determinism case are regression tests for real bugs — keep them.

A live end-to-end smoke test costs one real claude session: `QUINER_MAX_ITERATIONS=1 QUINER_EFFORT=low QUINER_STREAM=0 npm start`.
