import { spawn, execFileSync } from 'node:child_process';

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
  /** Abort signal — kills the child process when fired. */
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
    const proc = spawn(CLAUDE_BIN, buildArgs(prompt, opts), {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let lineBuffer = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let resultEvent: {
      subtype?: string;
      result?: string;
      session_id?: string;
      is_error?: boolean;
    } | null = null;
    let lastAssistantText = '';

    const killTimer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 5_000).unref();
    }, timeoutMs);
    killTimer.unref();

    const onAbort = () => {
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 5_000).unref();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const settle = (r: RunClaudeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve(r);
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
      settle({
        success: false,
        result: `failed to spawn ${CLAUDE_BIN}: ${err.message}`,
        exitCode: 1,
        timedOut,
      });
    });

    proc.on('close', (code) => {
      const exitCode = code ?? 1;
      if (resultEvent) {
        const success = !resultEvent.is_error && resultEvent.subtype === 'success' && exitCode === 0;
        settle({
          success,
          result: resultEvent.result ?? lastAssistantText,
          sessionId: resultEvent.session_id,
          exitCode,
          timedOut,
        });
      } else {
        settle({
          success: false,
          result:
            lastAssistantText ||
            stderr.trim() ||
            (timedOut ? `session timed out after ${timeoutMs}ms` : `claude exited with code ${exitCode} and no result event`),
          exitCode,
          timedOut,
        });
      }
    });
  });
}
