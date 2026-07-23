import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import * as acorn from 'acorn';
import { simple as walkSimple } from 'acorn-walk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

/**
 * quiner — an infinite agent loop that evolves JavaScript quines.
 *
 * This single file is both entrypoints:
 *   tsx src/quiner.ts                 the loop
 *   tsx src/quiner.ts verify-server   the MCP server given to claude sessions
 *
 * Every LLM call goes through the local `claude` CLI in print mode — never
 * the Anthropic API. Prompt templates live in prompts/*.md ({{var}}
 * placeholders), read fresh on every use so edits apply without a restart.
 *
 * Each iteration: ask claude (with the verify_candidate MCP tool) for a quine
 * that strictly beats the incumbent in bytes AND executed steps under a
 * literal-fraction cap; verify independently; have an LLM judge confirm it is
 * genuinely more interesting; commit it to completed/ and push. Durable state
 * is completed/ + git — state.json is only a cache — so the process can be
 * killed and restarted at any time.
 */

// ---------------------------------------------------------------------------
// Paths and config
// ---------------------------------------------------------------------------

const __dir = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(__dir, '..');
export const COMPLETED_DIR = join(PROJECT_ROOT, 'completed');
export const WORKSPACE_DIR = join(PROJECT_ROOT, 'workspace');
export const STATE_FILE = join(PROJECT_ROOT, 'state.json');
const PROMPTS_DIR = join(PROJECT_ROOT, 'prompts');
const LOCK_FILE = join(PROJECT_ROOT, '.quiner.pid');
const CANDIDATE = join(WORKSPACE_DIR, 'candidate.js');
const MCP_CONFIG = join(WORKSPACE_DIR, '.quiner-mcp.json');

export type Effort = 'low' | 'medium' | 'high' | 'max';

function intEnv(name: string, fallback: number, allowZero = false): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && (allowZero ? n >= 0 : n > 0) ? n : fallback;
}

const EFFORT = (process.env.QUINER_EFFORT ?? 'max') as Effort;
const MODEL = process.env.QUINER_MODEL || 'fable';
const MAX_ATTEMPTS = intEnv('QUINER_MAX_ATTEMPTS', 3);
const SESSION_TIMEOUT_MS = intEnv('QUINER_SESSION_TIMEOUT_MS', 15 * 60 * 1000);
const STREAM = process.env.QUINER_STREAM !== '0';
const DELAY_MS = intEnv('QUINER_DELAY_MS', 2_000, true);
const MAX_ITERATIONS = intEnv('QUINER_MAX_ITERATIONS', 0, true) || Infinity;
const JUDGE_ENABLED = process.env.QUINER_JUDGE !== '0';
const JUDGE_EFFORT = (process.env.QUINER_JUDGE_EFFORT ?? 'high') as Effort;
const JUDGE_MODEL = process.env.QUINER_JUDGE_MODEL || 'opus';
const JUDGE_TIMEOUT_MS = intEnv('QUINER_JUDGE_TIMEOUT_MS', 5 * 60 * 1000);
const JUDGE_RETRIES = intEnv('QUINER_JUDGE_RETRIES', 2);
const PUSH_ENABLED = process.env.QUINER_PUSH !== '0';

const RUN_TIMEOUT_MS = intEnv('QUINER_RUN_TIMEOUT_MS', 10_000);
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
export const MAX_LITERAL_FRACTION = 0.5;

// ---------------------------------------------------------------------------
// Prompt templates (prompts/*.md, {{var}} placeholders, read fresh per use)
// ---------------------------------------------------------------------------

function loadPrompt(name: string, vars: Record<string, string> = {}): string {
  const template = readFileSync(join(PROMPTS_DIR, `${name}.md`), 'utf-8');
  // Single pass over the template only — substituted values are never
  // re-scanned, so quine sources containing "{{...}}" cannot inject.
  return template.replace(/\{\{(\w+)\}\}/g, (m, key) => vars[key] ?? m).trimEnd();
}

function bootstrapPrompt(): string {
  return loadPrompt('bootstrap', { rules: loadPrompt('rules') });
}

function growPrompt(bestBytes: number, bestSteps: number, bestFile: string, bestSource?: string): string {
  const inline =
    bestSource !== undefined && bestSource.length <= 4000
      ? `Its source, for reference:\n\`\`\`js\n${bestSource}\`\`\`\n`
      : `It is too large to inline here — read it from that path if useful.\n`;
  return loadPrompt('grow', {
    bestBytes: String(bestBytes),
    bestSteps: String(bestSteps),
    bestFile,
    inline,
    rules: loadPrompt('rules'),
  });
}

function feedbackPrompt(reason: string, bestBytes: number, bestSteps: number): string {
  return loadPrompt('feedback', { reason, bestBytes: String(bestBytes), bestSteps: String(bestSteps) });
}

function freshRetryPrompt(firstPrompt: string, reason: string): string {
  return loadPrompt('fresh-retry', { firstPrompt, reason });
}

// ---------------------------------------------------------------------------
// Shutdown latch
// ---------------------------------------------------------------------------

const shutdownController = new AbortController();
let shutdownFlag = false;

function requestShutdown(): void {
  shutdownFlag = true;
  shutdownController.abort();
}

function shutdownRequested(): boolean {
  return shutdownFlag;
}

// ---------------------------------------------------------------------------
// Claude CLI wrapper (print mode; the only LLM transport in this project)
// ---------------------------------------------------------------------------

export interface RunClaudeOptions {
  effort?: Effort;
  model?: string;
  resumeSessionId?: string;
  appendSystemPrompt?: string;
  timeoutMs?: number;
  mcpConfigPath?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  onText?: (text: string) => void;
  onToolUse?: (name: string) => void;
  signal?: AbortSignal;
}

export interface RunClaudeResult {
  success: boolean;
  result: string;
  sessionId?: string;
  exitCode: number;
  timedOut: boolean;
}

function resolveClaudeBin(): string {
  try {
    return execFileSync('which', ['claude'], { encoding: 'utf-8' }).trim() || 'claude';
  } catch {
    return 'claude';
  }
}

const CLAUDE_BIN = resolveClaudeBin();

/** Live child processes, so a hard shutdown can reap the whole tree. */
const liveProcs = new Set<ChildProcess>();

/** Kill a detached child's entire process group (falls back to the child). */
function killTree(proc: ChildProcess, sig: NodeJS.Signals): void {
  if (proc.pid == null) return;
  try {
    process.kill(-proc.pid, sig);
  } catch {
    try {
      proc.kill(sig);
    } catch {
      // already gone
    }
  }
}

function killAllClaudeProcesses(): void {
  for (const proc of liveProcs) killTree(proc, 'SIGKILL');
}

export function buildArgs(prompt: string, opts: RunClaudeOptions): string[] {
  const args: string[] = [
    '--dangerously-skip-permissions',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
  ];
  if (opts.effort) args.push('--effort', opts.effort);
  if (opts.model) args.push('--model', opts.model);
  if (opts.appendSystemPrompt) args.push('--append-system-prompt', opts.appendSystemPrompt);
  if (opts.allowedTools && opts.allowedTools.length > 0) args.push('--allowed-tools', opts.allowedTools.join(','));
  if (opts.disallowedTools && opts.disallowedTools.length > 0) args.push('--disallowed-tools', opts.disallowedTools.join(','));
  if (opts.mcpConfigPath) args.push('--mcp-config', opts.mcpConfigPath, '--strict-mcp-config');
  if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);
  args.push('-p', prompt);
  return args;
}

export function runClaude(prompt: string, cwd: string, opts: RunClaudeOptions = {}): Promise<RunClaudeResult> {
  const timeoutMs = opts.timeoutMs ?? 15 * 60 * 1000;

  // Strip CLAUDECODE (nested-session detection) and ANTHROPIC_API_KEY
  // (subscription billing) from the child env.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'CLAUDECODE' || k === 'ANTHROPIC_API_KEY') continue;
    if (v !== undefined) env[k] = v;
  }

  return new Promise((resolvePromise) => {
    // detached: own process group, so timeout/abort can kill claude AND any
    // subprocesses its agent spawned, not just the direct child.
    const proc = spawn(CLAUDE_BIN, buildArgs(prompt, opts), {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    liveProcs.add(proc);

    let lineBuffer = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let exitFallbackTimer: NodeJS.Timeout | undefined;
    let resultEvent: {
      subtype?: string;
      result?: string;
      session_id?: string;
      is_error?: boolean;
      errors?: string[];
    } | null = null;
    let initSessionId: string | undefined;
    let lastAssistantText = '';

    const killTimer = setTimeout(() => {
      timedOut = true;
      killTree(proc, 'SIGTERM');
      setTimeout(() => killTree(proc, 'SIGKILL'), 5_000).unref();
    }, timeoutMs);
    killTimer.unref();

    const onAbort = () => {
      killTree(proc, 'SIGTERM');
      setTimeout(() => killTree(proc, 'SIGKILL'), 5_000).unref();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const settle = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      if (exitFallbackTimer) clearTimeout(exitFallbackTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      liveProcs.delete(proc);

      if (resultEvent) {
        const success = !resultEvent.is_error && resultEvent.subtype === 'success' && exitCode === 0;
        // `||` on purpose: error-subtype result events carry result: "" with
        // the real message in errors[].
        const text =
          resultEvent.result ||
          lastAssistantText ||
          (resultEvent.errors?.length ? resultEvent.errors.join('; ') : '') ||
          stderr.trim();
        resolvePromise({ success, result: text, sessionId: resultEvent.session_id ?? initSessionId, exitCode, timedOut });
      } else {
        resolvePromise({
          success: false,
          result:
            lastAssistantText ||
            stderr.trim() ||
            (timedOut ? `session timed out after ${timeoutMs}ms` : `claude exited with code ${exitCode} and no result event`),
          sessionId: initSessionId,
          exitCode,
          timedOut,
        });
      }
    };

    proc.stdout!.on('data', (data: Buffer) => {
      lineBuffer += data.toString();
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let parsed: any;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue; // not valid JSON, skip
        }
        if (parsed.type === 'result') {
          resultEvent = parsed;
        } else if (parsed.type === 'system' && parsed.subtype === 'init') {
          // Captured so a session that dies before its result event (e.g.
          // timeout) is still resumable on the next attempt.
          if (typeof parsed.session_id === 'string') initSessionId = parsed.session_id;
        } else if (parsed.type === 'stream_event') {
          const delta = parsed.event?.delta;
          if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
            opts.onText?.(delta.text);
          }
        } else if (parsed.type === 'assistant') {
          const content = parsed.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text' && block.text) lastAssistantText = block.text;
              if (block.type === 'tool_use' && block.name) opts.onToolUse?.(String(block.name));
            }
          }
        }
      }
    });

    proc.stderr!.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('error', (err) => {
      resultEvent = null;
      stderr = stderr || `failed to spawn ${CLAUDE_BIN}: ${err.message}`;
      settle(1);
    });

    // Normal path: 'close' fires once the process exits and its stdio drains.
    proc.on('close', (code) => settle(code ?? 1));

    // Fallback: if a surviving grandchild holds the stdout pipe open, 'close'
    // never fires — settle shortly after 'exit' with whatever we parsed.
    proc.on('exit', (code) => {
      exitFallbackTimer = setTimeout(() => settle(code ?? 1), 1_500);
    });
  });
}

// ---------------------------------------------------------------------------
// Quine verification + deterministic metrics
// ---------------------------------------------------------------------------

export interface QuineMetrics {
  bytes: number;
  steps: number;
  literalFraction: number;
  stepsPerByte: number;
}

export interface VerifyResult {
  ok: boolean;
  reason: string;
  byteLength: number;
}

export interface EvaluateResult {
  ok: boolean;
  reason: string;
  metrics: QuineMetrics;
}

export interface Thresholds {
  bestBytes: number;
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
 * Fraction of the source's characters inside string or template literals
 * (including quotes/backticks), from the AST; interval-merged so nested
 * literals never double-count. Throws on syntax errors.
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
  // touches disk, so it cannot be read back by the program under test. This
  // is the load-bearing anti-cheat defense — do not switch to a file run.
  const dir = mkdtempSync(join(tmpdir(), 'quiner-verify-'));
  try {
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
 * Full deterministic gate: validity + literal cap + step count + strict
 * improvement on both axes. Shared verbatim by the verify_candidate MCP tool,
 * the generation loop, and the commit-time re-check — never fork it.
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
  return new Promise((resolvePromise) => {
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
      resolvePromise({ exitCode: 1, stdout: Buffer.concat(stdoutChunks), stderr: 'failed to spawn node', timedOut, tooLarge });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: code ?? 1, stdout: Buffer.concat(stdoutChunks), stderr: stderr.trim(), timedOut, tooLarge });
    });
  });
}

// ---------------------------------------------------------------------------
// State: completed/ + git are durable; state.json is a cache
// ---------------------------------------------------------------------------

// quine-<seq>-<bytes>b[-<steps>s].js — the steps suffix is absent on legacy
// files committed before the steps gate existed.
const FILE_RE = /^quine-(\d+)-(\d+)b(?:-(\d+)s)?\.js$/;

export interface QuinerState {
  nextSeq: number;
  bestBytes: number;
  bestSteps: number;
  bestFile?: string;
}

/** Crash-safe file write: temp file in the same dir, then atomic rename. */
function writeFileAtomic(path: string, data: Buffer | string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export function ensureDirs(): void {
  mkdirSync(COMPLETED_DIR, { recursive: true });
  mkdirSync(WORKSPACE_DIR, { recursive: true });
  // The project root is "type": "module"; pin the workspace to CommonJS so
  // the agent's self-test (`node candidate.js`) matches the verifier.
  const pkg = join(WORKSPACE_DIR, 'package.json');
  if (!existsSync(pkg)) {
    writeFileSync(pkg, '{ "type": "commonjs" }\n');
  }
}

function readStateCache(): { bestFile?: string; bestSteps?: number } {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    return { bestFile: parsed.bestFile, bestSteps: parsed.bestSteps };
  } catch {
    return {};
  }
}

function writeStateCache(state: QuinerState): void {
  writeFileAtomic(
    STATE_FILE,
    JSON.stringify(
      {
        nextSeq: state.nextSeq,
        bestFile: state.bestFile,
        bestBytes: state.bestBytes,
        bestSteps: state.bestSteps,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );
}

/**
 * Rebuild state from a scan of completed/. The incumbent is the highest-seq
 * valid file — the both-axes rule makes the accepted chain totally ordered.
 */
export async function scanState(): Promise<QuinerState> {
  ensureDirs();
  let nextSeq = 0;
  let best: { seq: number; bytes: number; steps?: number; path: string } | undefined;
  for (const name of readdirSync(COMPLETED_DIR)) {
    const m = name.match(FILE_RE);
    if (!m) continue;
    const seq = parseInt(m[1], 10);
    if (seq + 1 > nextSeq) nextSeq = seq + 1;
    const path = join(COMPLETED_DIR, name);
    const bytes = statSync(path).size;
    if (bytes !== parseInt(m[2], 10)) {
      // Likely truncated by a hard kill mid-write; never trust it as "best".
      // (The seq above still advances so we don't reuse its number.)
      console.warn(`[quiner] WARNING: ${name} is ${bytes} bytes but its name claims ${m[2]} — ignoring as best candidate`);
      continue;
    }
    if (best === undefined || seq > best.seq) {
      best = { seq, bytes, steps: m[3] !== undefined ? parseInt(m[3], 10) : undefined, path };
    }
  }

  if (!best) return { nextSeq, bestBytes: 0, bestSteps: 0 };

  let bestSteps = best.steps;
  if (bestSteps === undefined) {
    // Legacy file from before the steps gate: measure once, memoized in
    // state.json so restarts don't pay the run again.
    const cache = readStateCache();
    if (cache.bestFile === best.path && typeof cache.bestSteps === 'number') {
      bestSteps = cache.bestSteps;
    } else {
      console.log(`[quiner] measuring steps for legacy best ${best.path}...`);
      const measured = await measureSteps(readFileSync(best.path));
      bestSteps = measured.ok ? measured.steps : 0;
      if (!measured.ok) {
        console.warn(`[quiner] WARNING: could not measure legacy best (${measured.reason}); treating as 0 steps`);
      }
    }
  }

  const state: QuinerState = { nextSeq, bestBytes: best.bytes, bestSteps, bestFile: best.path };
  writeStateCache(state);
  return state;
}

function git(args: string[]): string {
  return execFileSync('git', args, {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    timeout: 30_000,
    killSignal: 'SIGKILL',
  }).trim();
}

function ensureGitRepo(): void {
  if (!existsSync(join(PROJECT_ROOT, '.git'))) {
    git(['init', '-b', 'main']);
  }
  // Make sure commits work even without a global identity.
  try {
    git(['config', 'user.email']);
  } catch {
    git(['config', 'user.email', 'quiner@localhost']);
    git(['config', 'user.name', 'quiner']);
  }
}

/**
 * Best-effort push after each commit. A failure (network, auth, no remote)
 * must never fail the iteration — the commit is safe locally and the next
 * successful push carries the whole backlog anyway.
 */
function pushBestEffort(): void {
  if (!PUSH_ENABLED) return;
  try {
    const remote = git(['remote']).split('\n')[0]?.trim();
    if (!remote) {
      console.log('[quiner] no git remote configured — skipping push');
      return;
    }
    git(['push', remote, 'HEAD']);
    console.log(`[quiner] pushed to ${remote}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
    console.warn(`[quiner] WARNING: git push failed (${msg}) — commit is safe locally; next push will retry`);
  }
}

/** Write the verified quine into completed/, update state.json, commit, push. */
export function commitQuine(source: Buffer, seq: number, steps: number, note?: string): { file: string; byteLength: number } {
  ensureDirs();
  const byteLength = source.length;
  const name = `quine-${String(seq).padStart(4, '0')}-${byteLength}b-${steps}s.js`;
  const path = join(COMPLETED_DIR, name);
  writeFileAtomic(path, source);
  writeStateCache({ nextSeq: seq + 1, bestBytes: byteLength, bestSteps: steps, bestFile: path });
  // `add -A` on the whole folder sweeps in any quine a previous crash left
  // written-but-unstaged, so no completed quine can be lost to git forever.
  git(['add', '-A', '--', COMPLETED_DIR, STATE_FILE]);
  // --no-verify/--no-gpg-sign: a global hook or gpg config must not be able
  // to wedge the loop.
  git([
    'commit', '--no-verify', '--no-gpg-sign',
    '-m', `quine #${seq}: ${byteLength} bytes, ${steps} steps`,
    ...(note ? ['-m', note] : []),
  ]);
  pushBestEffort();
  return { file: path, byteLength };
}

// ---------------------------------------------------------------------------
// LLM interestingness judge (claude -p, tools disallowed, strict-JSON verdict)
// ---------------------------------------------------------------------------

export interface JudgeVerdict {
  interesting: boolean;
  score: number;
  reasoning: string;
  critique: string;
}

export type JudgeResult = { ok: true; verdict: JudgeVerdict } | { ok: false; failure: string };

const JUDGE_DISALLOWED_TOOLS = [
  'Bash', 'Write', 'Edit', 'Read', 'Glob', 'Grep',
  'WebFetch', 'WebSearch', 'Task', 'NotebookEdit', 'TodoWrite',
];

const JUDGE_MAX_INLINE_CHARS = 20_000;

function judgeExcerpt(source: string): string {
  if (source.length <= JUDGE_MAX_INLINE_CHARS) return source;
  return (
    source.slice(0, 12_000) +
    `\n/* … ${source.length - 18_000} chars TRUNCATED … */\n` +
    source.slice(-6_000)
  );
}

/** Extract the first top-level JSON object from a text reply. Throws if none parses. */
export function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object found in reply');
  return JSON.parse(text.slice(start, end + 1));
}

/** Validate + gently coerce a judge verdict object. Returns null when unusable. */
function validateVerdict(raw: unknown): JudgeVerdict | null {
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  let interesting = obj.interesting;
  if (typeof interesting === 'string') {
    const t = interesting.trim().toLowerCase();
    if (t === 'true' || t === 'yes') interesting = true;
    else if (t === 'false' || t === 'no') interesting = false;
  }
  if (typeof interesting !== 'boolean') return null;
  const rawScore = typeof obj.score === 'string' ? Number(obj.score) : obj.score;
  const score =
    typeof rawScore === 'number' && Number.isFinite(rawScore) ? Math.max(0, Math.min(10, rawScore)) : 0;
  return {
    interesting,
    score,
    reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : '',
    critique: typeof obj.critique === 'string' ? obj.critique : '',
  };
}

function judgeMetricsLine(m: QuineMetrics): string {
  return `${m.bytes} bytes, ${m.steps} executed steps (${m.stepsPerByte.toFixed(1)}/byte), ${(m.literalFraction * 100).toFixed(1)}% literal`;
}

export async function judgeCandidate(
  candidate: { source: string; metrics: QuineMetrics },
  incumbent: { source: string; metrics: QuineMetrics },
): Promise<JudgeResult> {
  const prompt = loadPrompt('judge', {
    criteria: loadPrompt('judge-criteria'),
    incumbentMetrics: judgeMetricsLine(incumbent.metrics),
    incumbentSource: judgeExcerpt(incumbent.source),
    candidateMetrics: judgeMetricsLine(candidate.metrics),
    candidateSource: judgeExcerpt(candidate.source),
  });
  const reinforcement =
    'Your previous reply was not a single valid JSON object. Reply with ONLY the JSON object described earlier — no prose, no code fences, nothing else.';

  let sessionId: string | undefined;
  let lastFailure = 'no attempts made';

  for (let attempt = 0; attempt <= JUDGE_RETRIES; attempt++) {
    const res = await runClaude(attempt === 0 ? prompt : reinforcement, PROJECT_ROOT, {
      effort: JUDGE_EFFORT,
      model: JUDGE_MODEL,
      resumeSessionId: sessionId,
      disallowedTools: JUDGE_DISALLOWED_TOOLS,
      timeoutMs: JUDGE_TIMEOUT_MS,
      signal: shutdownController.signal,
    });
    sessionId = res.sessionId ?? (res.success ? sessionId : undefined);

    if (!res.success) {
      lastFailure = `judge transport failure: ${res.result.slice(0, 300)}`;
      continue;
    }

    try {
      const verdict = validateVerdict(extractJson(res.result));
      if (!verdict) {
        lastFailure = 'judge verdict failed validation (missing/invalid "interesting")';
        continue;
      }
      return { ok: true, verdict };
    } catch (err) {
      lastFailure = `judge reply was not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return { ok: false, failure: lastFailure };
}

// ---------------------------------------------------------------------------
// One iteration: generate → verify → judge → commit
// ---------------------------------------------------------------------------

/**
 * Per-iteration MCP config giving the claude session the `verify_candidate`
 * tool — this same file in verify-server mode, with thresholds in env.
 */
function writeMcpConfig(bestBytes: number, bestSteps: number): string {
  writeFileSync(
    MCP_CONFIG,
    JSON.stringify(
      {
        mcpServers: {
          quiner: {
            command: join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx'),
            args: [join(PROJECT_ROOT, 'src', 'quiner.ts'), 'verify-server'],
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

/** Runs one full iteration. Returns the committed file, or throws on failure. */
async function runIteration(state: QuinerState): Promise<{ file: string; byteLength: number; steps: number }> {
  const { nextSeq: seq, bestBytes, bestSteps, bestFile } = state;

  // A stale candidate from a previous iteration must never count.
  rmSync(CANDIDATE, { force: true });

  const mcpConfigPath = writeMcpConfig(bestBytes, bestSteps);

  const bestSource = bestFile && existsSync(bestFile) ? readFileSync(bestFile, 'utf-8') : undefined;
  const firstPrompt =
    bestFile === undefined || bestBytes === 0
      ? bootstrapPrompt()
      : growPrompt(bestBytes, bestSteps, bestFile, bestSource);

  let sessionId: string | undefined;
  let lastFailure = 'no attempts made';

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (shutdownRequested()) throw new Error('shutdown requested');

    // Resumed retries get terse feedback; a fresh session (first attempt, or
    // the previous session died without a session id) needs the full task.
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
      appendSystemPrompt: loadPrompt('system'),
      timeoutMs: SESSION_TIMEOUT_MS,
      mcpConfigPath,
      signal: shutdownController.signal,
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

    // Semantic layer: judge only after the deterministic gate. A rejection
    // becomes feedback for the next attempt; judge unavailability fails OPEN
    // (with a loud note) so an outage cannot wedge the loop.
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

    // Defense in depth: re-run the deterministic gate on the exact bytes we
    // commit. (The judge is NOT re-run — it is nondeterministic by nature.)
    const recheck = await evaluateCandidate(source, { bestBytes, bestSteps });
    if (!recheck.ok) throw new Error(`quine failed re-verification at commit time: ${recheck.reason}`);
    const { file, byteLength } = commitQuine(source, seq, recheck.metrics.steps, judgeNote);
    console.log(`[quiner] committed ${file} (${byteLength} bytes, ${recheck.metrics.steps} steps)`);
    return { file, byteLength, steps: recheck.metrics.steps };
  }

  throw new Error(`no verified quine after ${MAX_ATTEMPTS} attempts (last failure: ${lastFailure.split('\n')[0]})`);
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/** Sleep that wakes immediately when shutdown is requested. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      shutdownController.signal.removeEventListener('abort', done);
      resolvePromise();
    }
    shutdownController.signal.addEventListener('abort', done, { once: true });
  });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Refuse to run two loops at once — they'd race on workspace/, seq numbers, and git. */
function acquireLock(): void {
  try {
    writeFileSync(LOCK_FILE, `${process.pid}\n`, { flag: 'wx' });
  } catch {
    const prev = parseInt(readFileSync(LOCK_FILE, 'utf-8'), 10);
    if (Number.isFinite(prev) && prev !== process.pid && pidAlive(prev)) {
      console.error(`[quiner] another quiner loop (pid ${prev}) is already running — exiting`);
      process.exit(1);
    }
    writeFileSync(LOCK_FILE, `${process.pid}\n`);
  }
  process.on('exit', () => {
    try {
      if (parseInt(readFileSync(LOCK_FILE, 'utf-8'), 10) === process.pid) rmSync(LOCK_FILE);
    } catch {
      // lock already gone
    }
  });
}

async function mainLoop(): Promise<void> {
  let signals = 0;
  const onSignal = (sig: string) => {
    signals++;
    if (signals === 1) {
      console.log(`\n[quiner] ${sig} received — aborting in-flight session and stopping (state is safe; restart with npm start)`);
      requestShutdown();
    } else {
      console.log(`\n[quiner] ${sig} received again — killing children and exiting immediately`);
      killAllClaudeProcesses();
      process.exit(130);
    }
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  ensureDirs();
  ensureGitRepo();
  acquireLock();

  let iterations = 0;
  let consecutiveFailures = 0;

  while (!shutdownRequested() && iterations < MAX_ITERATIONS) {
    const state = await scanState();
    console.log(
      `\n[quiner] ── iteration ${state.nextSeq} ── best so far: ${state.bestBytes > 0 ? `${state.bestBytes} bytes / ${state.bestSteps} steps (${state.bestFile})` : 'none'}`,
    );

    try {
      const result = await runIteration(state);
      consecutiveFailures = 0;
      console.log(`[quiner] ✓ quine #${state.nextSeq} complete: ${result.byteLength} bytes, ${result.steps} steps → ${result.file}`);
    } catch (err) {
      consecutiveFailures++;
      console.log(`[quiner] ✗ iteration failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    iterations++;
    if (shutdownRequested()) break;
    if (consecutiveFailures > 0) {
      const backoff = Math.min(5_000 * consecutiveFailures, 60_000);
      console.log(`[quiner] backing off ${Math.round(backoff / 1000)}s after ${consecutiveFailures} consecutive failure(s)`);
      await sleep(backoff);
    } else {
      await sleep(DELAY_MS);
    }
  }

  console.log('[quiner] loop stopped');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// verify-server mode: the MCP tool given to claude sessions
// ---------------------------------------------------------------------------

async function runVerifyServer(): Promise<void> {
  const workspace = process.env.QUINER_WORKSPACE || process.cwd();
  const bestBytes = parseInt(process.env.QUINER_BEST_LENGTH ?? '0', 10) || 0;
  const bestSteps = parseInt(process.env.QUINER_BEST_STEPS ?? '0', 10) || 0;
  const candidatePath = join(workspace, 'candidate.js');

  const server = new McpServer({ name: 'quiner', version: '1.0.0' });

  server.registerTool(
    'verify_candidate',
    {
      description:
        `Run the authoritative quine gate against candidate.js in your working directory. ` +
        `This is the EXACT check the harness applies after your turn: banned-token scan; string/template-literal fraction must be <= ${MAX_LITERAL_FRACTION * 100}% of the file; ` +
        `the source is piped to \`node -\` over stdin (CommonJS, empty temp dir, minimal env, 10s/64MB limits) and stdout must equal the source byte-for-byte; ` +
        `then executed steps are measured deterministically via V8 block-execution counts. ` +
        `The candidate must STRICTLY EXCEED the current best on BOTH axes: > ${bestBytes} bytes AND > ${bestSteps} steps. ` +
        `Returns PASS or a precise failure report plus the measured metrics. Call it after every edit of candidate.js; only stop when it returns PASS. ` +
        `Note: this tool covers the deterministic gate; after your turn an LLM judge additionally compares your program against the incumbent for INTERESTINGNESS (see the criteria in your task prompt) — design for that bar from the start.`,
      inputSchema: {},
    },
    async () => {
      let report: string;
      if (!existsSync(candidatePath)) {
        report = `FAIL: candidate.js does not exist in ${workspace} — write your program there first, then call verify_candidate again.`;
      } else {
        const source = readFileSync(candidatePath);
        const verdict = await evaluateCandidate(source, { bestBytes, bestSteps });
        const m = verdict.metrics;
        const metricsLine =
          `metrics: ${m.bytes} bytes (best ${bestBytes}), ${m.steps} steps (best ${bestSteps}), ` +
          `${m.stepsPerByte.toFixed(1)} steps/byte, ${(m.literalFraction * 100).toFixed(1)}% literal (cap ${MAX_LITERAL_FRACTION * 100}%)`;
        report = verdict.ok
          ? `PASS: candidate.js is a valid quine beating the best on both axes.\n${metricsLine}\nYou are done — end your turn now; the harness will run this same gate and commit it.`
          : `FAIL: ${verdict.reason}\n${metricsLine}\n\nFix candidate.js and call verify_candidate again.`;
      }
      return { content: [{ type: 'text', text: report }] };
    },
  );

  await server.connect(new StdioServerTransport());
}

// ---------------------------------------------------------------------------
// Entrypoint dispatch (guarded so importing this file never starts anything)
// ---------------------------------------------------------------------------

const invokedDirectly = (() => {
  try {
    return (
      process.argv[1] !== undefined &&
      pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url
    );
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  if (process.argv[2] === 'verify-server') {
    await runVerifyServer();
  } else {
    await mainLoop();
  }
}
