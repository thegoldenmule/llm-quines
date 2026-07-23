import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import * as acorn from 'acorn';
import { simple as walkSimple } from 'acorn-walk';

/**
 * Independent quine verification + deterministic work metrics.
 *
 * Validity (verifyQuine): the source, piped to `node -` over STDIN (CommonJS)
 * from an empty temp dir with a minimal env, must write itself byte-for-byte
 * to stdout and exit 0. Running from stdin is the load-bearing defense: the
 * source never exists on disk during the validity run, so no self-reading
 * trick has anything to read. A token blacklist sits on top for fast,
 * explainable feedback (the generator prompt lists the same tokens).
 *
 * Metrics (evaluateCandidate): candidates must also be computationally dense,
 * not just long. Two deterministic measures:
 *  - literalFraction: bytes inside string/template literals ÷ total bytes,
 *    from the AST (acorn). Caps "grow by pasting a bigger payload".
 *  - steps: exact V8 block-execution counts from a second, file-based run
 *    under NODE_V8_COVERAGE (built into Node; no source transformation, so
 *    toString-based quines are unaffected and stdout stays byte-exact).
 *    Deterministic because candidates are required to be deterministic (the
 *    ban list includes random/Date/hrtime/performance).
 */

export interface QuineMetrics {
  bytes: number;
  steps: number;
  literalFraction: number;
  stepsPerByte: number;
}

export interface VerifyResult {
  ok: boolean;
  /** Human/model-readable failure explanation, empty on success. */
  reason: string;
  byteLength: number;
}

export interface EvaluateResult {
  ok: boolean;
  reason: string;
  metrics: QuineMetrics;
}

export interface Thresholds {
  /** Byte length the candidate must strictly exceed. */
  bestBytes: number;
  /** Executed-step count the candidate must strictly exceed. */
  bestSteps: number;
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
  { re: /\bstack\b/, label: 'Error stack introspection' },
  { re: /\bDeno\b/, label: 'Deno' },
  { re: /\bBun\b/, label: 'Bun' },
  // Determinism: step counts must be reproducible run-to-run.
  { re: /\brandom\b/, label: 'Math.random (nondeterministic)' },
  { re: /\bDate\b/, label: 'Date (nondeterministic)' },
  { re: /\bhrtime\b/, label: 'process.hrtime (nondeterministic)' },
  { re: /\bperformance\b/, label: 'performance timers (nondeterministic)' },
];

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const RUN_TIMEOUT_MS = intEnv('QUINER_RUN_TIMEOUT_MS', 10_000);
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
/** At most this fraction of the file may live inside string/template literals. */
export const MAX_LITERAL_FRACTION = 0.5;

export function checkBannedTokens(source: string): string | null {
  for (const { re, label } of BANNED) {
    const m = source.match(re);
    if (m) {
      return `banned token "${m[0]}" (${label}) found — the quine must not read its own source, and must be fully deterministic`;
    }
  }
  return null;
}

/**
 * Fraction of the source's characters that sit inside string or template
 * literals (including quotes/backticks). Nested literals inside template
 * expressions are handled by interval-merging so nothing double-counts.
 * Throws on syntax errors (with acorn's message).
 */
export function literalFraction(source: string): number {
  if (source.length === 0) return 0;
  const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  const spans: Array<[number, number]> = [];
  walkSimple(ast, {
    Literal(node: any) {
      if (typeof node.value === 'string') spans.push([node.start, node.end]);
    },
    TemplateLiteral(node: any) {
      spans.push([node.start, node.end]);
    },
  });
  spans.sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let cursor = 0;
  for (const [start, end] of spans) {
    const s = Math.max(start, cursor);
    if (end > s) {
      covered += end - s;
      cursor = end;
    }
  }
  return covered / source.length;
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

/** Validity only: banned tokens + byte-exact stdin execution. */
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
    const run = await runNode(['--no-warnings', '-'], dir, source, {});
    const failure = runFailureReason(run, source);
    if (failure) return { ok: false, reason: failure, byteLength };
    return { ok: true, reason: '', byteLength };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Full gate: validity + literal-fraction cap + deterministic step count +
 * strict improvement over `thresholds`. This is the single authoritative
 * check shared by the verify_candidate MCP tool, the workflow, and the
 * commit-time re-check.
 */
export async function evaluateCandidate(source: Buffer, thresholds: Thresholds): Promise<EvaluateResult> {
  const bytes = source.length;
  const metrics: QuineMetrics = { bytes, steps: 0, literalFraction: 0, stepsPerByte: 0 };
  const fail = (reason: string): EvaluateResult => ({ ok: false, reason, metrics });

  // Static checks first (cheap, precise feedback).
  const validityPrecheck =
    bytes === 0
      ? 'candidate is empty'
      : bytes > MAX_OUTPUT_BYTES
        ? `candidate is ${bytes} bytes, over the ${MAX_OUTPUT_BYTES / (1024 * 1024)} MB limit`
        : checkBannedTokens(source.toString('utf-8'));
  if (validityPrecheck) return fail(validityPrecheck);

  try {
    metrics.literalFraction = literalFraction(source.toString('utf-8'));
  } catch (err) {
    return fail(`source does not parse: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (metrics.literalFraction > MAX_LITERAL_FRACTION) {
    return fail(
      `${(metrics.literalFraction * 100).toFixed(1)}% of the file is inside string/template literals — the cap is ${MAX_LITERAL_FRACTION * 100}%. Generate your payload computationally instead of hardcoding it.`,
    );
  }

  const validity = await verifyQuine(source);
  if (!validity.ok) return fail(validity.reason);

  const measured = await measureSteps(source);
  if (!measured.ok) return fail(measured.reason);
  metrics.steps = measured.steps;
  metrics.stepsPerByte = metrics.steps / bytes;

  if (bytes <= thresholds.bestBytes) {
    return fail(
      `valid quine, but only ${bytes} bytes — it must be STRICTLY MORE than the current best ${thresholds.bestBytes} bytes`,
    );
  }
  if (metrics.steps <= thresholds.bestSteps) {
    return fail(
      `valid quine of ${bytes} bytes, but it executes only ${metrics.steps} steps — it must execute STRICTLY MORE than the current best ${thresholds.bestSteps} steps (V8 block-execution counts). Add real computation (loops, recursion, procedural payload generation), not just more text.`,
    );
  }

  return { ok: true, reason: '', metrics };
}

/**
 * Deterministic work measurement: run the (already-validated) source from a
 * file under NODE_V8_COVERAGE and sum the block-execution counts of its
 * script. stdout is byte-checked again so a program cannot behave differently
 * in the metrics run without being caught.
 */
export async function measureSteps(source: Buffer): Promise<{ ok: boolean; reason: string; steps: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'quiner-steps-'));
  const covDir = join(dir, 'coverage');
  const file = join(dir, `q${randomBytes(6).toString('hex')}.js`);
  try {
    writeFileSync(join(dir, 'package.json'), '{ "type": "commonjs" }\n');
    writeFileSync(file, source);
    const run = await runNode(['--no-warnings', file], dir, null, { NODE_V8_COVERAGE: covDir });
    const failure = runFailureReason(run, source);
    if (failure) return { ok: false, reason: `metrics run failed: ${failure}`, steps: 0 };

    // realpath: V8 records the resolved main-module path, and tmpdir() is a
    // symlink on macOS (/var -> /private/var).
    const wanted = pathToFileURL(realpathSync(file)).href;
    let steps = 0;
    let found = false;
    for (const name of readdirSync(covDir)) {
      if (!name.endsWith('.json')) continue;
      const report = JSON.parse(readFileSync(join(covDir, name), 'utf-8'));
      for (const script of report.result ?? []) {
        if (script.url !== wanted) continue;
        found = true;
        for (const fn of script.functions ?? []) {
          for (const range of fn.ranges ?? []) {
            steps += range.count ?? 0;
          }
        }
      }
    }
    if (!found) return { ok: false, reason: 'metrics run produced no coverage data for the candidate', steps: 0 };
    return { ok: true, reason: '', steps };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runFailureReason(
  run: { exitCode: number; stdout: Buffer; stderr: string; timedOut: boolean; tooLarge: boolean },
  source: Buffer,
): string | null {
  if (run.timedOut) return `program did not finish within ${RUN_TIMEOUT_MS}ms`;
  if (run.tooLarge) return `program printed more than the ${MAX_OUTPUT_BYTES / (1024 * 1024)} MB output limit`;
  if (run.exitCode !== 0) {
    return `node exited with code ${run.exitCode}${run.stderr ? `; stderr:\n${run.stderr.slice(0, 2000)}` : ''}`;
  }
  if (!run.stdout.equals(source)) {
    return `stdout does not match the source exactly:\n${diffReport(source, run.stdout)}`;
  }
  return null;
}

function runNode(
  args: string[],
  cwd: string,
  stdin: Buffer | null,
  extraEnv: Record<string, string>,
): Promise<{ exitCode: number; stdout: Buffer; stderr: string; timedOut: boolean; tooLarge: boolean }> {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, args, {
      cwd,
      env: { PATH: process.env.PATH ?? '', ...extraEnv },
      stdio: [stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
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

    if (stdin !== null && proc.stdin) {
      proc.stdin.on('error', () => {
        // Program may exit without reading stdin; EPIPE here is fine.
      });
      proc.stdin.end(stdin);
    }

    proc.stdout!.on('data', (d: Buffer) => {
      stdoutBytes += d.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        tooLarge = true;
        proc.kill('SIGKILL');
        return;
      }
      stdoutChunks.push(d);
    });
    proc.stderr!.on('data', (d: Buffer) => {
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
