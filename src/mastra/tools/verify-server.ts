import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateCandidate, MAX_LITERAL_FRACTION } from '../utils/quine';

/**
 * Stdio MCP server exposing ONE tool to the claude session: verify_candidate.
 * It runs the exact same gate the harness runs (utils/quine.ts) against
 * workspace/candidate.js, so the agent never has to invent its own test — the
 * tool's PASS/FAIL is authoritative.
 *
 * Config comes from env (set in the per-iteration --mcp-config file):
 *   QUINER_WORKSPACE    directory containing candidate.js (default: cwd)
 *   QUINER_BEST_LENGTH  byte length the candidate must strictly exceed
 *   QUINER_BEST_STEPS   executed-step count the candidate must strictly exceed
 */

const WORKSPACE = process.env.QUINER_WORKSPACE || process.cwd();
const BEST_BYTES = parseInt(process.env.QUINER_BEST_LENGTH ?? '0', 10) || 0;
const BEST_STEPS = parseInt(process.env.QUINER_BEST_STEPS ?? '0', 10) || 0;
const CANDIDATE = join(WORKSPACE, 'candidate.js');

const server = new McpServer({ name: 'quiner', version: '1.0.0' });

server.registerTool(
  'verify_candidate',
  {
    description:
      `Run the authoritative quine gate against candidate.js in your working directory. ` +
      `This is the EXACT check the harness applies after your turn: banned-token scan; string/template-literal fraction must be <= ${MAX_LITERAL_FRACTION * 100}% of the file; ` +
      `the source is piped to \`node -\` over stdin (CommonJS, empty temp dir, minimal env, 10s/64MB limits) and stdout must equal the source byte-for-byte; ` +
      `then executed steps are measured deterministically via V8 block-execution counts. ` +
      `The candidate must STRICTLY EXCEED the current best on BOTH axes: > ${BEST_BYTES} bytes AND > ${BEST_STEPS} steps. ` +
      `Returns PASS or a precise failure report plus the measured metrics. Call it after every edit of candidate.js; only stop when it returns PASS.`,
    inputSchema: {},
  },
  async () => {
    const report = await buildReport();
    return { content: [{ type: 'text', text: report }] };
  },
);

async function buildReport(): Promise<string> {
  if (!existsSync(CANDIDATE)) {
    return `FAIL: candidate.js does not exist in ${WORKSPACE} — write your program there first, then call verify_candidate again.`;
  }
  const source = readFileSync(CANDIDATE);
  const verdict = await evaluateCandidate(source, { bestBytes: BEST_BYTES, bestSteps: BEST_STEPS });
  const m = verdict.metrics;
  const metricsLine =
    `metrics: ${m.bytes} bytes (best ${BEST_BYTES}), ${m.steps} steps (best ${BEST_STEPS}), ` +
    `${m.stepsPerByte.toFixed(1)} steps/byte, ${(m.literalFraction * 100).toFixed(1)}% literal (cap ${MAX_LITERAL_FRACTION * 100}%)`;
  if (!verdict.ok) {
    return `FAIL: ${verdict.reason}\n${metricsLine}\n\nFix candidate.js and call verify_candidate again.`;
  }
  return `PASS: candidate.js is a valid quine beating the best on both axes.\n${metricsLine}\nYou are done — end your turn now; the harness will run this same gate and commit it.`;
}

await server.connect(new StdioServerTransport());
