/**
 * Prompt builders for the quine loop. The rules block mirrors exactly what
 * `utils/quine.ts` enforces so verification failures always map to a rule the
 * model was told about.
 */

export const SYSTEM_PROMPT = `You are "quiner", an automated JavaScript quine builder running non-interactively inside an agent loop. There is no human to ask — never ask questions, never wait for confirmation. Always finish by writing your final program to candidate.js in your current working directory.`;

const RULES = `HARD RULES — an independent verifier checks every one of these:
1. Node.js only. The verifier runs your program as CommonJS by PIPING its source to \`node -\` over stdin, from an empty temp directory with a minimal environment. Your source never exists on disk during verification, so reading your own file is impossible by construction. It must exit 0.
2. stdout must be byte-for-byte identical to the file's own contents — including the trailing newline if (and only if) the file ends with one.
3. It must be a true quine: the program may not read its own source from disk or the runtime. These tokens are BANNED anywhere in the file, even inside strings or comments (matched as whole words): require, import, __filename, __dirname, argv, mainModule, binding, getBuiltinModule, module, child_process, readFile, openSync, fs, Deno, Bun.
4. It must finish in under 10 seconds and print at most 64 MB.

Allowed techniques: string self-substitution, JSON.stringify of a data payload, Function.prototype.toString, eval — anything self-contained.

DELIVERABLE: write the program to \`candidate.js\` in your current working directory (overwrite whatever is there). Only that file's bytes count.

Before finishing, ALWAYS self-verify:
  node candidate.js | diff - candidate.js
Empty output means success. If diff prints anything at all, fix candidate.js and re-check. Also check the byte count with: wc -c < candidate.js`;

export function bootstrapPrompt(): string {
  return `Write a simple, minimal JavaScript quine — a program that prints EXACTLY its own source code to stdout.

You may recall or look up classic quine techniques, but the final program must satisfy every rule below.

${RULES}`;
}

export function growPrompt(bestLength: number, bestFile: string, bestSource: string | undefined): string {
  const inline =
    bestSource !== undefined && bestSource.length <= 4000
      ? `Its source, for reference:\n\`\`\`js\n${bestSource}\`\`\`\n`
      : `It is too large to inline here — read it from that path if useful.\n`;
  return `The current best verified quine is ${bestLength} bytes, stored at:
  ${bestFile}
${inline}
Write a NEW JavaScript quine that is STRICTLY MORE than ${bestLength} bytes. Do not resubmit the old program.

Any valid longer quine is accepted, but prefer interesting growth over raw padding: a different technique, embedded ASCII art in the payload, self-describing commentary, layered self-reference — whatever you like, as long as the program still reproduces itself exactly.

${RULES}`;
}

export function feedbackPrompt(reason: string, bestLength: number): string {
  return `Your candidate.js FAILED verification:

${reason}

Fix candidate.js in place and self-verify again with:
  node candidate.js | diff - candidate.js
Remember: the final file must be a valid quine, contain no banned tokens, and be STRICTLY MORE than ${bestLength} bytes (check with: wc -c < candidate.js).`;
}

/**
 * Retry prompt for a FRESH session (no --resume available, e.g. the previous
 * attempt timed out before yielding a session id). Unlike feedbackPrompt it
 * restates the full task and rules, since the new session has no context.
 */
export function freshRetryPrompt(firstPrompt: string, reason: string): string {
  return `${firstPrompt}

---
NOTE: a previous attempt at this task failed verification with:

${reason}

Take a different approach where relevant, and self-verify before finishing.`;
}
