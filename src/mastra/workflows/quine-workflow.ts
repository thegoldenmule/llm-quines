import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runClaude, type Effort } from '../utils/claude-cli';
import { verifyQuine } from '../utils/quine';
import { WORKSPACE_DIR, commitQuine } from '../utils/state';
import { shutdownRequested, shutdownSignal } from '../utils/shutdown';
import { SYSTEM_PROMPT, bootstrapPrompt, growPrompt, feedbackPrompt } from '../prompts';

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const EFFORT = (process.env.QUINER_EFFORT ?? 'medium') as Effort;
const MODEL = process.env.QUINER_MODEL || undefined;
const MAX_ATTEMPTS = intEnv('QUINER_MAX_ATTEMPTS', 3);
const SESSION_TIMEOUT_MS = intEnv('QUINER_SESSION_TIMEOUT_MS', 15 * 60 * 1000);
const STREAM = process.env.QUINER_STREAM !== '0';

const CANDIDATE = join(WORKSPACE_DIR, 'candidate.js');

const generateAndVerify = createStep({
  id: 'generate-and-verify',
  description: 'Ask claude -p for a quine, independently verify it, retry with feedback on failure',
  inputSchema: z.object({
    seq: z.number(),
    bestLength: z.number(),
    bestFile: z.string().optional(),
    bestSource: z.string().optional(),
  }),
  outputSchema: z.object({
    seq: z.number(),
    bestLength: z.number(),
    sourceB64: z.string(),
  }),
  execute: async ({ inputData }) => {
    const { seq, bestLength, bestFile, bestSource } = inputData;

    // A stale candidate from a previous iteration must never count.
    rmSync(CANDIDATE, { force: true });

    const firstPrompt =
      bestFile === undefined || bestLength === 0
        ? bootstrapPrompt()
        : growPrompt(bestLength, bestFile, bestSource);

    let sessionId: string | undefined;
    let lastFailure = 'no attempts made';

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (shutdownRequested()) throw new Error('shutdown requested');

      const prompt = attempt === 0 ? firstPrompt : feedbackPrompt(lastFailure, bestLength);
      console.log(`\n[quiner] seq=${seq} attempt ${attempt + 1}/${MAX_ATTEMPTS}${sessionId ? ' (resuming session)' : ''}`);

      const res = await runClaude(prompt, WORKSPACE_DIR, {
        effort: EFFORT,
        model: MODEL,
        resumeSessionId: sessionId,
        appendSystemPrompt: SYSTEM_PROMPT,
        timeoutMs: SESSION_TIMEOUT_MS,
        signal: shutdownSignal(),
        onText: STREAM ? (t) => process.stdout.write(t) : undefined,
      });
      if (STREAM) process.stdout.write('\n');
      sessionId = res.sessionId ?? sessionId;

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
      const verdict = await verifyQuine(source);
      if (!verdict.ok) {
        lastFailure = verdict.reason;
        console.log(`[quiner] verification failed: ${verdict.reason.split('\n')[0]}`);
        continue;
      }
      if (verdict.byteLength <= bestLength) {
        lastFailure = `your program IS a valid quine, but it is only ${verdict.byteLength} bytes — it must be STRICTLY MORE than ${bestLength} bytes`;
        console.log(`[quiner] valid quine but too short (${verdict.byteLength}b <= ${bestLength}b)`);
        continue;
      }

      console.log(`[quiner] verified quine: ${verdict.byteLength} bytes`);
      return { seq, bestLength, sourceB64: source.toString('base64') };
    }

    throw new Error(`no verified quine after ${MAX_ATTEMPTS} attempts (last failure: ${lastFailure.split('\n')[0]})`);
  },
});

const commitStep = createStep({
  id: 'commit-quine',
  description: 'Re-verify and commit the quine into completed/ with git',
  inputSchema: z.object({
    seq: z.number(),
    bestLength: z.number(),
    sourceB64: z.string(),
  }),
  outputSchema: z.object({
    seq: z.number(),
    file: z.string(),
    byteLength: z.number(),
  }),
  execute: async ({ inputData }) => {
    const source = Buffer.from(inputData.sourceB64, 'base64');
    // Defense in depth: the bytes we commit are the bytes we verified.
    const verdict = await verifyQuine(source);
    if (!verdict.ok) throw new Error(`quine failed re-verification at commit time: ${verdict.reason}`);
    if (verdict.byteLength <= inputData.bestLength) {
      throw new Error(`quine shrank below best (${verdict.byteLength}b <= ${inputData.bestLength}b) at commit time`);
    }
    const { file, byteLength } = commitQuine(source, inputData.seq);
    console.log(`[quiner] committed ${file} (${byteLength} bytes)`);
    return { seq: inputData.seq, file, byteLength };
  },
});

export const quineWorkflow = createWorkflow({
  id: 'quine-workflow',
  description: 'One iteration of the quine loop: generate a strictly-longer verified quine and commit it',
  inputSchema: z.object({
    seq: z.number(),
    bestLength: z.number(),
    bestFile: z.string().optional(),
    bestSource: z.string().optional(),
  }),
  outputSchema: z.object({
    seq: z.number(),
    file: z.string(),
    byteLength: z.number(),
  }),
})
  .then(generateAndVerify)
  .then(commitStep)
  .commit();
