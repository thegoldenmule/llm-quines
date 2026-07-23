import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runClaude, type Effort } from '../utils/claude-cli';
import { evaluateCandidate, literalFraction } from '../utils/quine';
import { judgeCandidate } from '../llm/judge';
import { PROJECT_ROOT, WORKSPACE_DIR, commitQuine } from '../utils/state';
import { shutdownRequested, shutdownSignal } from '../utils/shutdown';
import { SYSTEM_PROMPT, bootstrapPrompt, growPrompt, feedbackPrompt, freshRetryPrompt } from '../prompts';

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const EFFORT = (process.env.QUINER_EFFORT ?? 'max') as Effort;
const MODEL = process.env.QUINER_MODEL || 'fable';
const MAX_ATTEMPTS = intEnv('QUINER_MAX_ATTEMPTS', 3);
const SESSION_TIMEOUT_MS = intEnv('QUINER_SESSION_TIMEOUT_MS', 15 * 60 * 1000);
const STREAM = process.env.QUINER_STREAM !== '0';
const JUDGE_ENABLED = process.env.QUINER_JUDGE !== '0';

const CANDIDATE = join(WORKSPACE_DIR, 'candidate.js');
const MCP_CONFIG = join(WORKSPACE_DIR, '.quiner-mcp.json');

/**
 * Per-iteration MCP config giving the claude session the `verify_candidate`
 * tool — the same gate the harness runs, with the current thresholds baked
 * in — so the agent tests attempts through an explicit tool instead of
 * inventing its own checks.
 */
function writeMcpConfig(bestBytes: number, bestSteps: number): string {
  writeFileSync(
    MCP_CONFIG,
    JSON.stringify(
      {
        mcpServers: {
          quiner: {
            command: join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx'),
            args: [join(PROJECT_ROOT, 'src', 'mastra', 'tools', 'verify-server.ts')],
            env: {
              PATH: process.env.PATH ?? '',
              QUINER_WORKSPACE: WORKSPACE_DIR,
              QUINER_BEST_LENGTH: String(bestBytes),
              QUINER_BEST_STEPS: String(bestSteps),
            },
          },
        },
      },
      null,
      2,
    ) + '\n',
  );
  return MCP_CONFIG;
}

const generateAndVerify = createStep({
  id: 'generate-and-verify',
  description: 'Ask claude -p for a quine, independently verify it, retry with feedback on failure',
  inputSchema: z.object({
    seq: z.number(),
    bestBytes: z.number(),
    bestSteps: z.number(),
    bestFile: z.string().optional(),
  }),
  outputSchema: z.object({
    seq: z.number(),
    bestBytes: z.number(),
    bestSteps: z.number(),
    sourceB64: z.string(),
    judgeNote: z.string(),
  }),
  execute: async ({ inputData }) => {
    const { seq, bestBytes, bestSteps, bestFile } = inputData;

    // A stale candidate from a previous iteration must never count.
    rmSync(CANDIDATE, { force: true });

    const mcpConfigPath = writeMcpConfig(bestBytes, bestSteps);

    // Read the reference source here rather than receiving it as workflow
    // input, so quine bytes never sit in run snapshots or grow the db.
    const bestSource =
      bestFile && existsSync(bestFile) ? readFileSync(bestFile, 'utf-8') : undefined;
    const firstPrompt =
      bestFile === undefined || bestBytes === 0
        ? bootstrapPrompt()
        : growPrompt(bestBytes, bestSteps, bestFile, bestSource);

    let sessionId: string | undefined;
    let lastFailure = 'no attempts made';

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (shutdownRequested()) throw new Error('shutdown requested');

      // Resumed retries get terse feedback; a fresh session (first attempt,
      // or the previous session died without a session id) needs the full
      // task restated.
      const prompt =
        attempt === 0
          ? firstPrompt
          : sessionId
            ? feedbackPrompt(lastFailure, bestBytes, bestSteps)
            : freshRetryPrompt(firstPrompt, lastFailure);
      console.log(`\n[quiner] seq=${seq} attempt ${attempt + 1}/${MAX_ATTEMPTS}${sessionId ? ' (resuming session)' : ''}`);

      const res = await runClaude(prompt, WORKSPACE_DIR, {
        effort: EFFORT,
        model: MODEL,
        resumeSessionId: sessionId,
        appendSystemPrompt: SYSTEM_PROMPT,
        timeoutMs: SESSION_TIMEOUT_MS,
        mcpConfigPath,
        signal: shutdownSignal(),
        onText: STREAM ? (t) => process.stdout.write(t) : undefined,
        onToolUse: (name) => console.log(`[quiner]   tool: ${name}`),
      });
      if (STREAM) process.stdout.write('\n');
      // Keep the session for feedback turns while it's alive; if a transport
      // failure yielded no id (dead/stale session), drop ours so the next
      // attempt starts fresh instead of resuming a broken id forever.
      sessionId = res.sessionId ?? (res.success ? sessionId : undefined);

      if (shutdownRequested()) throw new Error('shutdown requested');

      if (!res.success) {
        lastFailure = `your previous run did not complete cleanly (${res.result.slice(0, 500)}); candidate.js may or may not have been written`;
        console.log(`[quiner] session failed: ${res.result.slice(0, 200)}`);
        // Fall through — a written candidate can still be valid.
      }

      if (!existsSync(CANDIDATE)) {
        lastFailure = res.success
          ? 'you did not write candidate.js in your working directory'
          : lastFailure;
        console.log('[quiner] no candidate.js written');
        continue;
      }

      const source = readFileSync(CANDIDATE);
      const verdict = await evaluateCandidate(source, { bestBytes, bestSteps });
      if (!verdict.ok) {
        lastFailure = verdict.reason;
        console.log(`[quiner] verification failed: ${verdict.reason.split('\n')[0]}`);
        continue;
      }

      const m = verdict.metrics;
      console.log(
        `[quiner] verified quine: ${m.bytes} bytes, ${m.steps} steps (${m.stepsPerByte.toFixed(1)}/byte), ${(m.literalFraction * 100).toFixed(1)}% literal`,
      );

      // Semantic layer: the deterministic gate passed — now the LLM judge
      // decides whether the candidate is genuinely MORE INTERESTING than the
      // incumbent. Rejections become feedback for the next attempt. Judge
      // unavailability fails OPEN (with a loud note) so an outage cannot
      // wedge the loop.
      let judgeNote = '';
      if (JUDGE_ENABLED && bestSource !== undefined) {
        console.log('[quiner] running interestingness judge...');
        let incumbentLiteral = 0;
        try {
          incumbentLiteral = literalFraction(bestSource);
        } catch {
          // Legacy incumbent that no longer parses cleanly — fraction stays 0.
        }
        const judged = await judgeCandidate(
          { source: source.toString('utf-8'), metrics: m },
          {
            source: bestSource,
            metrics: {
              bytes: bestBytes,
              steps: bestSteps,
              stepsPerByte: bestBytes > 0 ? bestSteps / bestBytes : 0,
              literalFraction: incumbentLiteral,
            },
          },
        );
        if (shutdownRequested()) throw new Error('shutdown requested');
        if (judged.ok && !judged.verdict.interesting) {
          const v = judged.verdict;
          lastFailure = `the deterministic gate PASSED, but the interestingness judge REJECTED your program (score ${v.score}/10): ${v.critique || v.reasoning}`;
          console.log(`[quiner] judge rejected (score ${v.score}/10): ${(v.reasoning || v.critique).split('\n')[0].slice(0, 160)}`);
          continue;
        }
        if (judged.ok) {
          const v = judged.verdict;
          judgeNote = `judge: ${v.score}/10 — ${v.reasoning}`.slice(0, 400);
          console.log(`[quiner] judge accepted (score ${v.score}/10): ${v.reasoning.split('\n')[0].slice(0, 160)}`);
        } else {
          judgeNote = 'judge unavailable — accepted on deterministic gate only';
          console.warn(`[quiner] WARNING: ${judged.failure} — failing open`);
        }
      }

      return { seq, bestBytes, bestSteps, sourceB64: source.toString('base64'), judgeNote };
    }

    throw new Error(`no verified quine after ${MAX_ATTEMPTS} attempts (last failure: ${lastFailure.split('\n')[0]})`);
  },
});

const commitStep = createStep({
  id: 'commit-quine',
  description: 'Re-verify and commit the quine into completed/ with git',
  inputSchema: z.object({
    seq: z.number(),
    bestBytes: z.number(),
    bestSteps: z.number(),
    sourceB64: z.string(),
    judgeNote: z.string(),
  }),
  outputSchema: z.object({
    seq: z.number(),
    file: z.string(),
    byteLength: z.number(),
    steps: z.number(),
  }),
  execute: async ({ inputData }) => {
    const source = Buffer.from(inputData.sourceB64, 'base64');
    // Defense in depth: the bytes we commit are the bytes we verified. Only
    // the deterministic gate re-runs here — re-running the judge would make
    // commits flaky on an inherently nondeterministic check.
    const verdict = await evaluateCandidate(source, {
      bestBytes: inputData.bestBytes,
      bestSteps: inputData.bestSteps,
    });
    if (!verdict.ok) throw new Error(`quine failed re-verification at commit time: ${verdict.reason}`);
    const { file, byteLength } = commitQuine(source, inputData.seq, verdict.metrics.steps, inputData.judgeNote);
    console.log(`[quiner] committed ${file} (${byteLength} bytes, ${verdict.metrics.steps} steps)`);
    return { seq: inputData.seq, file, byteLength, steps: verdict.metrics.steps };
  },
});

export const quineWorkflow = createWorkflow({
  id: 'quine-workflow',
  description: 'One iteration of the quine loop: generate a strictly-better verified quine and commit it',
  inputSchema: z.object({
    seq: z.number(),
    bestBytes: z.number(),
    bestSteps: z.number(),
    bestFile: z.string().optional(),
  }),
  outputSchema: z.object({
    seq: z.number(),
    file: z.string(),
    byteLength: z.number(),
    steps: z.number(),
  }),
  options: {
    // Durable state lives in completed/ + git; snapshots would grow mastra.db
    // by O(quine size) every iteration, forever.
    shouldPersistSnapshot: () => false,
  },
})
  .then(generateAndVerify)
  .then(commitStep)
  .commit();
