import { evaluateCandidate, literalFraction, measureSteps, verifyQuine } from './mastra/utils/quine';

/**
 * Sanity tests for the quine verifier and metrics: known-good quines must
 * pass, cheats and near-misses must fail, and the deterministic metrics must
 * behave. Run with: npm run test:verify
 */

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------------------
// Validity (verifyQuine)
// ---------------------------------------------------------------------------

interface Case {
  name: string;
  source: string;
  expectOk: boolean;
  expectReasonIncludes?: string;
}

// Classic Function.prototype.toString quine — console.log adds the trailing
// newline, so the file must end with exactly one.
const toStringQuine = 'function quine() { console.log(quine.toString() + "\\nquine()") }\nquine()\n';

// process.stdout.write variant — no trailing newline anywhere.
const writeQuine = 'function q(){process.stdout.write(q.toString()+"\\nq()")}\nq()';

// Data-driven quine: payload string + substitution.
const dataQuine = 's="s=%j;console.log(s.replace(/%j/,JSON.stringify(s)))";console.log(s.replace(/%j/,JSON.stringify(s)))\n';

const cases: Case[] = [
  { name: 'toString quine', source: toStringQuine, expectOk: true },
  { name: 'stdout.write quine (no trailing newline)', source: writeQuine, expectOk: true },
  { name: 'data/substitution quine', source: dataQuine, expectOk: true },
  {
    name: 'read-own-file cheat',
    source: 'console.log(require("fs").readFileSync(__filename, "utf8").trimEnd())\n',
    expectOk: false,
    expectReasonIncludes: 'banned token',
  },
  {
    name: 'import cheat',
    source: 'const t = await import("node:" + "f" + "s");\n',
    expectOk: false,
    expectReasonIncludes: 'banned token',
  },
  {
    name: 'getBuiltinModule cheat (banned token)',
    source: 'const q = process.getBuiltinModule("f" + "s");\n',
    expectOk: false,
    expectReasonIncludes: 'banned token',
  },
  {
    name: 'Error stack cheat (banned token)',
    source: 'console.log(new Error().stack)\n',
    expectOk: false,
    expectReasonIncludes: 'banned token',
  },
  {
    name: 'nondeterminism (banned token)',
    source: 'console.log(Math.random())\n',
    expectOk: false,
    expectReasonIncludes: 'banned token',
  },
  {
    // The review-proven bypass, obfuscated past every banned token: recovers
    // its own path from the stack and reads itself. Under stdin verification
    // the stack has no on-disk path, so this must die at runtime.
    name: 'obfuscated self-read cheat (stdin defense)',
    source:
      'const g = process["get" + "Builtin" + "Mod" + "ule"];\n' +
      'const f = g("f" + "s");\n' +
      'const p = new Error()["sta" + "ck"].match(/\\((\\/[^)]+):\\d+:\\d+\\)/);\n' +
      'process.stdout.write(f["read" + "F" + "ile" + "Sync"](p[1], "utf8"));\n',
    expectOk: false,
    expectReasonIncludes: 'exited with code',
  },
  {
    name: 'not a quine',
    source: 'console.log("hello")\n',
    expectOk: false,
    expectReasonIncludes: 'does not match',
  },
  {
    name: 'wrong trailing newline',
    source: 'function q(){process.stdout.write(q.toString()+"\\nq()")}\nq()\n',
    expectOk: false,
    expectReasonIncludes: 'does not match',
  },
  {
    name: 'crashing program',
    source: 'throw new Error("boom")\n',
    expectOk: false,
    expectReasonIncludes: 'exited with code',
  },
  {
    name: 'empty program',
    source: '',
    expectOk: false,
    expectReasonIncludes: 'empty',
  },
  {
    name: 'infinite loop',
    source: 'for(;;);\n',
    expectOk: false,
    expectReasonIncludes: 'did not finish',
  },
];

for (const c of cases) {
  const verdict = await verifyQuine(Buffer.from(c.source, 'utf-8'));
  const okMatch = verdict.ok === c.expectOk;
  const reasonMatch =
    !c.expectReasonIncludes || verdict.reason.includes(c.expectReasonIncludes);
  check(
    c.name,
    okMatch && reasonMatch,
    `expected ok=${c.expectOk}${c.expectReasonIncludes ? ` reason~"${c.expectReasonIncludes}"` : ''}; got ok=${verdict.ok} reason=${JSON.stringify(verdict.reason.slice(0, 300))}`,
  );
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

{
  const f = literalFraction('var a = "xxxx";\n');
  check('literalFraction basic', Math.abs(f - 6 / 16) < 1e-9, `got ${f}, expected ${6 / 16}`);
}

{
  // measureSteps byte-checks stdout against the source (defense in depth), so
  // it only accepts real quines — use a loop-bearing quine vs the plain one.
  const loopQuine =
    'function quine() { let x = 0; for (let i = 0; i < 1000; i++) x += i; console.log(quine.toString() + "\\nquine()") }\nquine()\n';
  const a = await measureSteps(Buffer.from(loopQuine));
  const b = await measureSteps(Buffer.from(loopQuine));
  const c = await measureSteps(Buffer.from(toStringQuine));
  check('measureSteps deterministic', a.ok && b.ok && a.steps === b.steps, `run1=${a.steps} run2=${b.steps} ok=${a.ok}/${b.ok} ${a.reason || b.reason}`);
  check('measureSteps sees loop work', a.ok && c.ok && a.steps > c.steps + 500, `loop=${a.steps} straight=${c.steps}`);
}

{
  const good = await evaluateCandidate(Buffer.from(toStringQuine), { bestBytes: 0, bestSteps: 0 });
  check(
    'evaluateCandidate accepts low-literal quine',
    good.ok && good.metrics.steps > 0 && good.metrics.literalFraction < 0.5,
    `ok=${good.ok} reason=${good.reason.slice(0, 200)} metrics=${JSON.stringify(good.metrics)}`,
  );

  const tooShort = await evaluateCandidate(Buffer.from(toStringQuine), { bestBytes: 100000, bestSteps: 0 });
  check('evaluateCandidate enforces bytes', !tooShort.ok && tooShort.reason.includes('bytes'), tooShort.reason.slice(0, 200));

  const tooFewSteps = await evaluateCandidate(Buffer.from(toStringQuine), { bestBytes: 0, bestSteps: 10 ** 15 });
  check('evaluateCandidate enforces steps', !tooFewSteps.ok && tooFewSteps.reason.includes('steps'), tooFewSteps.reason.slice(0, 200));

  // Literal-heavy program: the cap is a static check, so it fires before the
  // program even needs to be a valid quine.
  const literalHeavy = `const s = \`${'x'.repeat(200)}\`;\nconsole.log(s.length);\n`;
  const capped = await evaluateCandidate(Buffer.from(literalHeavy), { bestBytes: 0, bestSteps: 0 });
  check('evaluateCandidate enforces literal cap', !capped.ok && capped.reason.includes('literal'), capped.reason.slice(0, 200));
}

if (failures > 0) {
  console.log(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nall verifier tests passed');
