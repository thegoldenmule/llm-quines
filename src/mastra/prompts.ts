/**
 * Prompt builders for the quine loop. The rules block mirrors exactly what
 * `utils/quine.ts` enforces so verification failures always map to a rule the
 * model was told about.
 */

export const SYSTEM_PROMPT = `You are "quiner", an automated JavaScript quine builder running non-interactively inside an agent loop. There is no human to ask — never ask questions, never wait for confirmation. Always finish by writing your final program to candidate.js in your current working directory, and always test it with the verify_candidate tool (quiner MCP server) — that tool is the authoritative check; do not invent your own verification procedure.`;

const RULES = `HARD RULES — verify_candidate checks every one of these, and the harness re-checks them after your turn:
1. Node.js only. Your program is run as CommonJS by PIPING its source to \`node -\` over stdin, from an empty temp directory with a minimal environment. Your source never exists on disk during verification, so reading your own file is impossible by construction. It must exit 0.
2. stdout must be byte-for-byte identical to the file's own contents — including the trailing newline if (and only if) the file ends with one.
3. It must be a true, DETERMINISTIC quine. These tokens are BANNED anywhere in the file, even inside strings or comments (matched as whole words): require, import, __filename, __dirname, argv, mainModule, binding, getBuiltinModule, module, child_process, readFile, openSync, fs, stack, Deno, Bun, random, Date, hrtime, performance.
4. It must finish in under 10 seconds and print at most 64 MB.
5. LITERAL CAP: at most 50% of the file's bytes may sit inside string/template literals (measured on the AST). Hardcoding a bigger payload is a dead end — generate your output computationally.
6. PROGRESS ON BOTH AXES: the program must be STRICTLY LONGER in bytes than the current best AND execute STRICTLY MORE steps (deterministic V8 block-execution counts — loops and recursion that do real work drive this number).

Good ways to add real computation: derive the printed payload procedurally (character codes, arithmetic, table-driven generation), self-verifying checksums computed at runtime, recursive structure builders, fixed-point iterations — anything where the program COMPUTES its text rather than pasting it.

DELIVERABLE: write the program to \`candidate.js\` in your current working directory (overwrite whatever is there). Only that file's bytes count.

TESTING: use the \`verify_candidate\` tool (quiner MCP server) — it runs the EXACT gate described above and returns PASS or a precise failure report with your measured metrics (bytes, steps, literal fraction). Workflow: write candidate.js → call verify_candidate → fix and repeat until it returns PASS → end your turn. Do NOT build your own test procedure; verify_candidate is the only check that counts.`;

export function bootstrapPrompt(): string {
  return `Write a JavaScript quine — a program that prints EXACTLY its own source code to stdout.

You may recall or look up classic quine techniques, but the final program must satisfy every rule below (note the literal cap: a plain data-string quine will not pass — the program must compute a substantial part of its own text).

${RULES}`;
}

export function growPrompt(
  bestBytes: number,
  bestSteps: number,
  bestFile: string,
  bestSource: string | undefined,
): string {
  const inline =
    bestSource !== undefined && bestSource.length <= 4000
      ? `Its source, for reference:\n\`\`\`js\n${bestSource}\`\`\`\n`
      : `It is too large to inline here — read it from that path if useful.\n`;
  return `The current best verified quine is ${bestBytes} bytes and executes ${bestSteps} steps. It is stored at:
  ${bestFile}
${inline}
Write a NEW JavaScript quine that beats it on BOTH axes: STRICTLY MORE than ${bestBytes} bytes AND STRICTLY MORE than ${bestSteps} executed steps. Do not resubmit or trivially pad the old program — the literal cap and the steps requirement make "hardcode a longer string" a dead end. Prefer a real jump in computational structure: a different generation technique, deeper procedural derivation of the payload, more genuine work per byte.

${RULES}`;
}

export function feedbackPrompt(reason: string, bestBytes: number, bestSteps: number): string {
  return `Your candidate.js FAILED verification:

${reason}

Fix candidate.js in place, then call the verify_candidate tool and keep iterating until it returns PASS before ending your turn.
Remember: valid deterministic quine, no banned tokens, literal fraction <= 50%, STRICTLY MORE than ${bestBytes} bytes AND STRICTLY MORE than ${bestSteps} executed steps.`;
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

Take a different approach where relevant, and self-verify with verify_candidate before finishing.`;
}
