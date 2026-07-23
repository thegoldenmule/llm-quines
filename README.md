# quiner

An agent loop that builds ever-larger, ever-more-computational JavaScript quines. One source
file (`src/quiner.ts`) plus plain-text prompt templates (`prompts/*.md`), with all LLM calls
going through the local **Claude Code CLI in print mode** (`claude -p`) — no direct Anthropic
API calls.

Fitness is two-dimensional: each accepted quine must strictly beat the incumbent in **bytes
AND executed steps** (deterministic V8 block-execution counts via `NODE_V8_COVERAGE`), with
at most **50% of the file inside string/template literals** (measured on the acorn AST) — so
"paste a longer payload" is structurally a dead end and growth has to be earned with real
computation. Candidates must be deterministic (`random`/`Date`/`hrtime`/`performance` are
banned along with the self-reading tokens). True asymptotic complexity is undecidable; these
are the deterministic proxies.

On top of the deterministic gate sits a semantic layer: an **LLM interestingness judge**
(also via `claude -p`, tools disallowed, strict-JSON verdict) compares each candidate that
clears the gate against the incumbent and rejects it unless it is *genuinely more
interesting as a quine* — computation must be load-bearing for self-reproduction, accretion
("incumbent + one more bolted-on section") is an automatic NO, and self-reference depth
(programs that analyze/derive/validate their own text at runtime) scores highest. The
criteria live in `prompts/judge-criteria.md` and are shown verbatim to both the generator
and the judge. Rejections feed back into the generator session as critique; the verdict
(score + reasoning) is recorded in the quine's git commit message. If the judge is
unavailable, acceptance fails open on the deterministic gate with a note, so an outage
can't wedge the loop.

## How it works

Each loop iteration (all in `src/quiner.ts`):

1. **generate + verify** — spawns `claude -p` (stream-json, permissions skipped) with
   `workspace/` as its cwd. Iteration 0 asks for a trivial quine; later iterations show the
   current best and demand strict improvement on both axes. The agent writes
   `workspace/candidate.js` and tests it with an explicit MCP tool: each session gets a
   `quiner` stdio MCP server (`--mcp-config --strict-mcp-config` — the same file run as
   `tsx src/quiner.ts verify-server`) exposing `verify_candidate`, which runs the *same*
   gate the harness uses with the current thresholds baked in. Failures — including judge
   rejections with their critique — resume the same claude session (up to
   `QUINER_MAX_ATTEMPTS` tries; if the session died without an id, the retry restates the
   full task in a fresh session).
2. **judge** — a separate `claude -p` session applies `prompts/judge-criteria.md` to the
   candidate vs the incumbent.
3. **commit** — re-runs the deterministic gate on the exact bytes, writes
   `completed/quine-<seq>-<bytes>b-<steps>s.js`, updates `state.json`, commits to git, and
   best-effort pushes to the first configured remote.

Prompt templates are read fresh on every use, so editing `prompts/*.md` takes effect on the
next iteration without restarting the loop. Available templates: `system`, `rules`,
`bootstrap`, `grow`, `feedback`, `fresh-retry`, `judge`, `judge-criteria` (with `{{var}}`
placeholders substituted in a single pass, so program text can never inject).

## Restartability

All durable state is `completed/` + git history; `state.json` is just a cache (it also
memoizes measured steps for legacy files). Every loop turn re-scans `completed/` from
scratch, so you can kill the process (Ctrl-C) at any moment and `npm start` resumes exactly
where it left off — at most the in-flight iteration is lost. First Ctrl-C aborts the
in-flight claude session (killing its whole process group) and stops cleanly; a second one
reaps any children and force-exits. Crash-safety details: quine files are written atomically
(tmp + rename) and staged with `-A`, so a quine orphaned by a crash mid-commit is swept into
the next commit; commits run with `--no-verify --no-gpg-sign` so global hooks/gpg config
can't wedge the loop; a `.quiner.pid` lock refuses to start a second concurrent loop.

## Run

```sh
npm install
npm start            # the loop
npm run test:verify  # verifier + metrics sanity tests
npm run typecheck
```

Requires the `claude` CLI installed and authenticated. The spawned sessions strip
`ANTHROPIC_API_KEY` (subscription billing) and `CLAUDECODE` (allows launching from inside a
Claude Code session).

## Configuration (env)

| var | default | meaning |
| --- | --- | --- |
| `QUINER_EFFORT` | `max` | `--effort` for generator sessions (`low`/`medium`/`high`/`max`) |
| `QUINER_MODEL` | `fable` | `--model` for generator sessions |
| `QUINER_MAX_ATTEMPTS` | `3` | verification attempts per iteration (feedback via `--resume`) |
| `QUINER_SESSION_TIMEOUT_MS` | `900000` | wall-clock kill for one claude session |
| `QUINER_DELAY_MS` | `2000` | pause between iterations |
| `QUINER_MAX_ITERATIONS` | ∞ | stop after N iterations (smoke tests) |
| `QUINER_STREAM` | on | set `0` to silence live token streaming |
| `QUINER_JUDGE` | on | set `0` to disable the LLM interestingness judge |
| `QUINER_JUDGE_EFFORT` | `high` | `--effort` for judge sessions |
| `QUINER_JUDGE_MODEL` | `opus` | `--model` for judge sessions |
| `QUINER_JUDGE_TIMEOUT_MS` | `300000` | wall-clock kill for one judge session |
| `QUINER_PUSH` | on | set `0` to skip the best-effort `git push` after each commit |
| `QUINER_RUN_TIMEOUT_MS` | `10000` | execution limit for candidate verification runs |

## Notes

- Verification pipes the candidate's source to `node -` over stdin from an empty temp dir
  with a minimal env: the source never exists on disk during the validity run, so no
  self-read trick can work regardless of obfuscation. The banned-token list is a fast,
  explainable pre-check on top; the same list is spelled out in `prompts/rules.md` so every
  rejection is actionable feedback.
- `workspace/` is the agent's scratch dir (gitignored, pinned to CommonJS so self-tests
  match the verifier). `completed/` is append-only history.
