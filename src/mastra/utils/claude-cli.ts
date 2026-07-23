import { spawn, execFileSync, type ChildProcess } from 'node:child_process';

/**
 * Minimal wrapper around the Claude Code CLI in print mode (`claude -p`),
 * following the pattern from hotseat-executor's ClaudeCodeAdapter: spawn the
 * binary with stream-json output, parse events line-by-line, and surface the
 * final `result` event (which carries the session id used for `--resume`).
 *
 * No Anthropic API calls happen here — everything goes through the locally
 * installed `claude` binary and whatever auth it already has.
 */

export type Effort = 'low' | 'medium' | 'high' | 'max';

export interface RunClaudeOptions {
  effort?: Effort;
  model?: string;
  /** Resume a previous session (feedback turns). */
  resumeSessionId?: string;
  appendSystemPrompt?: string;
  /** Hard wall-clock limit for the session. */
  timeoutMs?: number;
  /** Streaming text callback (assistant text deltas), for live logging. */
  onText?: (text: string) => void;
  /** Abort signal — kills the child process tree when fired. */
  signal?: AbortSignal;
}

export interface RunClaudeResult {
  success: boolean;
  /** Final assistant text (the `result` field of the result event). */
  result: string;
  /** Session id, usable with `--resume` on a follow-up call. */
  sessionId?: string;
  exitCode: number;
  timedOut: boolean;
}

/** Resolve the full path to the `claude` binary once at module load. */
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

/** SIGKILL every live claude process group. Used on forced shutdown. */
export function killAllClaudeProcesses(): void {
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
  if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);
  args.push('-p', prompt);
  return args;
}

export function runClaude(
  prompt: string,
  cwd: string,
  opts: RunClaudeOptions = {},
): Promise<RunClaudeResult> {
  const timeoutMs = opts.timeoutMs ?? 15 * 60 * 1000;

  // Build env: strip CLAUDECODE (nested-session detection) and
  // ANTHROPIC_API_KEY (use subscription billing) — same as hotseat.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'CLAUDECODE' || k === 'ANTHROPIC_API_KEY') continue;
    if (v !== undefined) env[k] = v;
  }

  return new Promise((resolve) => {
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
        // the real message in errors[] (mirrors the reference buildResult).
        const text =
          resultEvent.result ||
          lastAssistantText ||
          (resultEvent.errors?.length ? resultEvent.errors.join('; ') : '') ||
          stderr.trim();
        resolve({
          success,
          result: text,
          sessionId: resultEvent.session_id ?? initSessionId,
          exitCode,
          timedOut,
        });
      } else {
        resolve({
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

    proc.stdout.on('data', (data: Buffer) => {
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
            }
          }
        }
      }
    });

    proc.stderr.on('data', (data: Buffer) => {
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
