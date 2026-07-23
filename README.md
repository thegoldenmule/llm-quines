# quiner

An agent loop that builds ever-larger JavaScript quines. Built on [Mastra](https://mastra.ai)
workflows, with all LLM calls going through the local **Claude Code CLI in print mode**
(`claude -p`, same pattern as mastra-hotseat's executor) — no direct Anthropic API calls.

## How it works

Each loop iteration runs a two-step Mastra workflow:

1. **generate-and-verify** — spawns `claude -p` (stream-json, permissions skipped) with
   `workspace/` as its cwd. Iteration 0 asks for a trivial quine; later iterations show the
   current best and demand a *strictly longer* one. The agent writes `workspace/candidate.js`
   and tests it with an explicit MCP tool: each session gets a `quiner` stdio MCP server
   (`--mcp-config --strict-mcp-config`, see `src/mastra/tools/verify-server.ts`) exposing
   `verify_candidate`, which runs the *same* verifier the harness uses (current best length
   baked in) and returns PASS or a precise failure report — so the agent never invents its
   own test procedure. The harness then verifies
   independently: bans read-your-own-source tokens (`require`, `import`, `__filename`, `argv`,
   `fs`, `getBuiltinModule`, …) for fast feedback, then pipes the source to `node -` over
   stdin (CommonJS) from an empty temp dir with a minimal env and a 10s/64MB limit, and
   byte-compares stdout to the source. Piping over stdin is the real defense: the source never
   exists on disk during verification, so no self-read trick can work regardless of
   obfuscation. Failures resume the same claude session with a precise diff report (up to
   `QUINER_MAX_ATTEMPTS` tries; if the session died without an id, the retry restates the full
   task in a fresh session).
2. **commit-quine** — re-verifies the exact bytes, writes
   `completed/quine-<seq>-<bytes>b.js`, updates `state.json`, and commits both to git.

Then the loop goes again, forever.

## Restartability

All durable state is `completed/` + git history; `state.json` is just a cache. Every loop
turn re-scans `completed/` from scratch, so you can kill the process (Ctrl-C) at any moment
and `npm start` resumes exactly where it left off — at most the in-flight iteration is lost.
First Ctrl-C aborts the in-flight claude session (killing its whole process group) and stops
cleanly; a second one reaps any children and force-exits. Crash-safety details: quine files
are written atomically (tmp + rename) and `commitQuine` stages `completed/` with `-A`, so a
quine orphaned by a crash mid-commit is swept into the next commit; commits run with
`--no-verify --no-gpg-sign` so global hooks/gpg config can't wedge the loop; a `.quiner.pid`
lock refuses to start a second concurrent loop.

## Run

```sh
npm install
npm start            # the loop
npm run test:verify  # verifier sanity tests
npm run typecheck
npm run dev          # mastra dev playground (optional)
```

Requires the `claude` CLI installed and authenticated. The spawned sessions strip
`ANTHROPIC_API_KEY` (subscription billing) and `CLAUDECODE` (allows launching from inside a
Claude Code session), mirroring mastra-hotseat.

## Configuration (env)

| var | default | meaning |
| --- | --- | --- |
| `QUINER_EFFORT` | `medium` | `--effort` for claude sessions (`low`/`medium`/`high`/`max`) |
| `QUINER_MODEL` | CLI default | `--model` override |
| `QUINER_MAX_ATTEMPTS` | `3` | verification attempts per iteration (feedback via `--resume`) |
| `QUINER_SESSION_TIMEOUT_MS` | `900000` | wall-clock kill for one claude session |
| `QUINER_DELAY_MS` | `2000` | pause between iterations |
| `QUINER_MAX_ITERATIONS` | ∞ | stop after N iterations (smoke tests) |
| `QUINER_STREAM` | on | set `0` to silence live token streaming |

## Notes

- The token blacklist is a guardrail against lazy self-reading cheats, not a security
  boundary; the same list is spelled out in the generator prompt so every rejection is
  actionable feedback.
- `workspace/` is the agent's scratch dir (gitignored, pinned to CommonJS so self-tests match
  the verifier). `completed/` is append-only history.
