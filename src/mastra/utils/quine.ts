import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Independent quine verification. A candidate passes when:
 *  1. It contains none of the banned "read your own source" escape hatches.
 *  2. `node <file>` — run under a random filename, in an empty temp dir, with
 *     a minimal env — writes the file's exact bytes to stdout and exits 0.
 *
 * The token blacklist is a guardrail against lazy cheating (reading the file
 * from disk), not a security boundary; the generator prompt lists the same
 * tokens so failures come with an explanation the model can act on.
 */

export interface VerifyResult {
  ok: boolean;
  /** Human/model-readable failure explanation, empty on success. */
  reason: string;
  byteLength: number;
}

const BANNED: Array<{ re: RegExp; label: string }> = [
  { re: /\brequire\b/, label: 'require' },
  { re: /\bimport\b/, label: 'import' },
  { re: /\b__filename\b/, label: '__filename' },
  { re: /\b__dirname\b/, label: '__dirname' },
  { re: /\bargv\b/, label: 'process.argv' },
  { re: /\bmainModule\b/, label: 'process.mainModule' },
  { re: /\bbinding\b/, label: 'process.binding' },
  { re: /\bmodule\b/, label: 'module' },
  { re: /\bchild_process\b/, label: 'child_process' },
  { re: /\breadFile\w*\b/, label: 'readFile*' },
  { re: /\bopenSync\b/, label: 'fs.openSync' },
  { re: /\bfs\b/, label: 'fs' },
  { re: /\bDeno\b/, label: 'Deno' },
  { re: /\bBun\b/, label: 'Bun' },
];

const RUN_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export function checkBannedTokens(source: string): string | null {
  for (const { re, label } of BANNED) {
    const m = source.match(re);
    if (m) {
      return `banned token "${m[0]}" (${label}) found — the quine must not read its own source from disk or the runtime environment`;
    }
  }
  return null;
}

/** Render a precise first-difference report for the feedback prompt. */
export function diffReport(expected: Buffer, actual: Buffer): string {
  const n = Math.min(expected.length, actual.length);
  let i = 0;
  while (i < n && expected[i] === actual[i]) i++;
  if (i === n && expected.length === actual.length) return 'outputs are identical';
  const ctx = (buf: Buffer) =>
    JSON.stringify(buf.subarray(Math.max(0, i - 20), i + 20).toString('utf-8'));
  const lines = [
    `source is ${expected.length} bytes, stdout was ${actual.length} bytes`,
    `first difference at byte ${i}:`,
    `  source around it:  ${ctx(expected)}`,
    `  stdout around it:  ${ctx(actual)}`,
  ];
  if (expected.length !== actual.length && i === n) {
    lines.push(
      actual.length > expected.length
        ? `stdout has ${actual.length - expected.length} extra trailing byte(s): ${JSON.stringify(actual.subarray(n, n + 40).toString('utf-8'))}`
        : `stdout is missing the final ${expected.length - actual.length} byte(s) of the source: ${JSON.stringify(expected.subarray(n, n + 40).toString('utf-8'))}`,
    );
  }
  return lines.join('\n');
}

export async function verifyQuine(source: Buffer): Promise<VerifyResult> {
  const byteLength = source.length;

  if (byteLength === 0) {
    // The empty program technically prints itself, but it's not a quine we accept.
    return { ok: false, reason: 'candidate is empty', byteLength };
  }

  const banned = checkBannedTokens(source.toString('utf-8'));
  if (banned) return { ok: false, reason: banned, byteLength };

  // Run a copy under a random name in an empty temp dir so the program cannot
  // find its source at any path it could have memorized. The temp dir pins
  // CommonJS to match the workspace the agent self-tests in.
  const dir = mkdtempSync(join(tmpdir(), 'quiner-verify-'));
  const file = join(dir, `q${randomBytes(6).toString('hex')}.js`);
  try {
    writeFileSync(join(dir, 'package.json'), '{ "type": "commonjs" }\n');
    writeFileSync(file, source);
    const run = await runNode(file, dir);
    if (run.timedOut) {
      return { ok: false, reason: `program did not finish within ${RUN_TIMEOUT_MS}ms`, byteLength };
    }
    if (run.exitCode !== 0) {
      return {
        ok: false,
        reason: `node exited with code ${run.exitCode}${run.stderr ? `; stderr:\n${run.stderr.slice(0, 2000)}` : ''}`,
        byteLength,
      };
    }
    if (!run.stdout.equals(source)) {
      return {
        ok: false,
        reason: `stdout does not match the source exactly:\n${diffReport(source, run.stdout)}`,
        byteLength,
      };
    }
    return { ok: true, reason: '', byteLength };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runNode(
  file: string,
  cwd: string,
): Promise<{ exitCode: number; stdout: Buffer; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, ['--no-warnings', file], {
      cwd,
      env: { PATH: process.env.PATH ?? '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, RUN_TIMEOUT_MS);

    proc.stdout.on('data', (d: Buffer) => {
      stdoutBytes += d.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        timedOut = false;
        proc.kill('SIGKILL');
        return;
      }
      stdoutChunks.push(d);
    });
    proc.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 10_000) stderr += d.toString();
    });

    proc.on('error', () => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout: Buffer.concat(stdoutChunks), stderr: 'failed to spawn node', timedOut });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout: Buffer.concat(stdoutChunks), stderr: stderr.trim(), timedOut });
    });
  });
}
