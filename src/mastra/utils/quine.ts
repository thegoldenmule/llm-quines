import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Independent quine verification. A candidate passes when:
 *  1. It contains none of the banned "read your own source" escape hatches.
 *  2. Its source, piped to `node -` over STDIN (CommonJS) from an empty temp
 *     dir with a minimal env, is written byte-for-byte to stdout with exit 0.
 *
 * Running from stdin is the load-bearing defense: during verification the
 * source never exists on disk, so no self-reading technique — however
 * obfuscated — has anything to read. The token blacklist exists on top of
 * that to give the model fast, explainable feedback (and the generator
 * prompt lists the same tokens, so every rejection is actionable).
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
  { re: /\bgetBuiltinModule\b/, label: 'process.getBuiltinModule' },
  { re: /\bmodule\b/, label: 'module' },
  { re: /\bchild_process\b/, label: 'child_process' },
  { re: /\breadFile\w*\b/, label: 'readFile*' },
  { re: /\bopenSync\b/, label: 'fs.openSync' },
  { re: /\bfs\b/, label: 'fs' },
  { re: /\bDeno\b/, label: 'Deno' },
  { re: /\bBun\b/, label: 'Bun' },
];

const RUN_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

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
  if (byteLength > MAX_OUTPUT_BYTES) {
    return {
      ok: false,
      reason: `candidate is ${byteLength} bytes, over the ${MAX_OUTPUT_BYTES / (1024 * 1024)} MB verification limit`,
      byteLength,
    };
  }

  const banned = checkBannedTokens(source.toString('utf-8'));
  if (banned) return { ok: false, reason: banned, byteLength };

  // Empty temp dir as cwd; the source itself is piped over stdin and never
  // touches disk, so it cannot be read back by the program under test.
  const dir = mkdtempSync(join(tmpdir(), 'quiner-verify-'));
  try {
    // Pin CommonJS for any relative resolution, matching the workspace the
    // agent self-tests in (stdin input is CommonJS by default anyway).
    writeFileSync(join(dir, 'package.json'), '{ "type": "commonjs" }\n');
    const run = await runNodeStdin(source, dir);
    if (run.timedOut) {
      return { ok: false, reason: `program did not finish within ${RUN_TIMEOUT_MS}ms`, byteLength };
    }
    if (run.tooLarge) {
      return {
        ok: false,
        reason: `program printed more than the ${MAX_OUTPUT_BYTES / (1024 * 1024)} MB output limit`,
        byteLength,
      };
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

function runNodeStdin(
  source: Buffer,
  cwd: string,
): Promise<{ exitCode: number; stdout: Buffer; stderr: string; timedOut: boolean; tooLarge: boolean }> {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, ['--no-warnings', '-'], {
      cwd,
      env: { PATH: process.env.PATH ?? '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = '';
    let timedOut = false;
    let tooLarge = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, RUN_TIMEOUT_MS);

    proc.stdin.on('error', () => {
      // Program may exit without reading stdin; EPIPE here is fine.
    });
    proc.stdin.end(source);

    proc.stdout.on('data', (d: Buffer) => {
      stdoutBytes += d.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        tooLarge = true;
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
      resolve({ exitCode: 1, stdout: Buffer.concat(stdoutChunks), stderr: 'failed to spawn node', timedOut, tooLarge });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout: Buffer.concat(stdoutChunks), stderr: stderr.trim(), timedOut, tooLarge });
    });
  });
}
