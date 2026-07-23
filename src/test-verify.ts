import { verifyQuine } from './mastra/utils/quine';

/**
 * Sanity tests for the quine verifier: known-good quines must pass, cheats and
 * near-misses must fail. Run with: npm run test:verify
 */

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

let failures = 0;
for (const c of cases) {
  const verdict = await verifyQuine(Buffer.from(c.source, 'utf-8'));
  const okMatch = verdict.ok === c.expectOk;
  const reasonMatch =
    !c.expectReasonIncludes || verdict.reason.includes(c.expectReasonIncludes);
  if (okMatch && reasonMatch) {
    console.log(`PASS  ${c.name}`);
  } else {
    failures++;
    console.log(`FAIL  ${c.name}`);
    console.log(`      expected ok=${c.expectOk}${c.expectReasonIncludes ? ` reason~"${c.expectReasonIncludes}"` : ''}`);
    console.log(`      got ok=${verdict.ok} reason=${JSON.stringify(verdict.reason.slice(0, 300))}`);
  }
}

if (failures > 0) {
  console.log(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nall verifier tests passed');
