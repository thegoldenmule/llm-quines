import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyQuine } from '../utils/quine';

/**
 * Stdio MCP server exposing ONE tool to the claude session: verify_candidate.
 * It runs the exact same verifier the harness runs (utils/quine.ts) against
 * workspace/candidate.js, so the agent never has to invent its own test — the
 * tool's PASS/FAIL is authoritative.
 *
 * Config comes from env (set in the per-iteration --mcp-config file):
 *   QUINER_WORKSPACE    directory containing candidate.js (default: cwd)
 *   QUINER_BEST_LENGTH  byte length the candidate must strictly exceed
 */

const WORKSPACE = process.env.QUINER_WORKSPACE || process.cwd();
const BEST_LENGTH = parseInt(process.env.QUINER_BEST_LENGTH ?? '0', 10) || 0;
const CANDIDATE = join(WORKSPACE, 'candidate.js');

const server = new McpServer({ name: 'quiner', version: '1.0.0' });

server.registerTool(
  'verify_candidate',
  {
    description:
      `Run the authoritative quine verifier against candidate.js in your working directory. ` +
      `This is the EXACT check the harness applies after your turn: banned-token scan, then the source is piped to \`node -\` over stdin ` +
      `(CommonJS, empty temp dir, minimal env, 10s/64MB limits) and stdout must equal the source byte-for-byte. ` +
      `Also checks the strictly-longer-than-${BEST_LENGTH}-bytes requirement. ` +
      `Call it after every edit of candidate.js; only stop when it returns PASS.`,
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
  const verdict = await verifyQuine(source);
  if (!verdict.ok) {
    return `FAIL (${verdict.byteLength} bytes): ${verdict.reason}\n\nFix candidate.js and call verify_candidate again.`;
  }
  if (verdict.byteLength <= BEST_LENGTH) {
    return `FAIL: candidate.js IS a valid quine, but at ${verdict.byteLength} bytes it does not STRICTLY EXCEED the current best of ${BEST_LENGTH} bytes. Make it longer (it must still reproduce itself exactly) and call verify_candidate again.`;
  }
  return `PASS: candidate.js is a valid quine of ${verdict.byteLength} bytes (> best ${BEST_LENGTH}). You are done — end your turn now; the harness will run this same verifier and commit it.`;
}

await server.connect(new StdioServerTransport());
