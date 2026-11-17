// Spike probe: drive one ACP agent through a turn and print what it does.
// Run: node --env-file=../../.env scripts/acp-probe.ts <claude|agy|opencode>
import { spawn } from 'node:child_process';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { startToolServer } from '../src/acp/tool-server.ts';

const agents: Record<string, readonly string[]> = {
  claude: [join(import.meta.dirname, '../node_modules/.bin/claude-agent-acp')],
  agy: ['agy', 'acp'],
  opencode: ['opencode', 'acp'],
};

const which = process.argv[2] ?? 'claude';
const isolated = process.argv.includes('--isolated');
const cwd = await mkdtemp(join(tmpdir(), 'kd-acp-'));
const home = await mkdtemp(join(tmpdir(), 'kd-acp-home-'));
const [command, ...baseArgs] = agents[which]!;
const args =
  isolated && which === 'agy' ? [...baseArgs, '--gemini-dir', join(home, '.gemini')] : baseArgs;
const env: NodeJS.ProcessEnv = { ...process.env };
if (isolated && which === 'agy') env.GEMINI_API_KEY = process.env.KD_LEARN_GEMINI_API;
if (isolated && which === 'opencode') {
  // Deny every built-in permission; only MCP tools of kd-learn stay allowed.
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    model: 'opencode-go/claude-haiku-5-5',
    permission: { '*': 'deny', 'kd-learn_*': 'allow' },
  });
}
// Claude: no built-in tools, no user/project settings (hooks, MCP, default mode), no bypass.
const claudeMeta = isolated
  ? {
      claudeCode: {
        options: { tools: [], settingSources: [], allowDangerouslySkipPermissions: false },
      },
    }
  : undefined;
const log = (...parts: unknown[]) => console.log(`[${which}]`, ...parts);

let submitted: unknown;
let text = '';
const server = await startToolServer([
  {
    name: 'add',
    description: 'Add two numbers.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
      additionalProperties: false,
    },
    call: async (input) => {
      const { a, b } = input as { a: number; b: number };
      return JSON.stringify({ result: a + b });
    },
  },
  {
    name: 'submit_result',
    description: 'Submit the final answer. Call exactly once at the end.',
    inputSchema: {
      type: 'object',
      properties: { sum: { type: 'number' }, explanation: { type: 'string' } },
      required: ['sum', 'explanation'],
      additionalProperties: false,
    },
    call: async (input) => {
      submitted = input;
      return 'Result accepted.';
    },
  },
]);

const child = spawn(command!, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env });
let stderr = '';
child.stderr.on('data', (d) => (stderr += String(d)));
const stream = acp.ndJsonStream(
  Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
  Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
);

const timeout = setTimeout(() => {
  log('TIMEOUT. stderr tail:', stderr.slice(-800));
  child.kill();
  process.exit(1);
}, 180_000);

try {
  const stop = await acp
    .client({ name: 'kd-learn-probe' })
    .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
      // Allow only kd-learn MCP tools (Claude: mcp__kd-learn__x, Antigravity: mcp_kd-learn_x).
      const call = ctx.params.toolCall as { title?: string | null; name?: string };
      const ours = /^(Run )?mcp__?kd-learn_/.test(call.name ?? call.title ?? '');
      const kind = ours ? 'allow_once' : 'reject_once';
      const option = ctx.params.options.find((o) => o.kind === kind);
      log('permission requested:', call.title, ours ? '-> allowed' : '-> rejected');
      return option
        ? { outcome: { outcome: 'selected', optionId: option.optionId } }
        : { outcome: { outcome: 'cancelled' } };
    })
    .connectWith(stream, async (ctx) => {
      const init = await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      log('agent:', JSON.stringify(init.agentInfo ?? {}));
      log('capabilities:', JSON.stringify(init.agentCapabilities));
      log('auth methods:', JSON.stringify(init.authMethods?.map((m) => m.id)));
      const authArg = process.argv.find((a) => a.startsWith('--auth='));
      if (authArg) {
        await ctx.request(acp.methods.agent.authenticate, {
          methodId: authArg.slice('--auth='.length),
        });
        log('authenticated with', authArg);
      }

      const http = init.agentCapabilities?.mcpCapabilities?.http === true;
      const builder = ctx.buildSession({
        cwd,
        mcpServers: [],
        ...(which === 'claude' && claudeMeta ? { _meta: claudeMeta } : {}),
      });
      if (http) {
        builder.withMcpServer({
          type: 'http',
          name: 'kd-learn',
          url: server.url,
          headers: [{ name: 'Authorization', value: `Bearer ${server.token}` }],
        });
      } else {
        log('agent does not advertise MCP over HTTP: using the stdio bridge');
        builder.withMcpServer({
          name: 'kd-learn',
          command: process.execPath,
          args: [join(import.meta.dirname, '../src/acp/stdio-bridge.ts')],
          env: [
            { name: 'KD_LEARN_MCP_URL', value: server.url },
            { name: 'KD_LEARN_MCP_TOKEN', value: server.token },
          ],
        });
      }
      return builder.withSession(async (session) => {
        log('session:', session.sessionId);
        const attack = process.argv.includes('--attack');
        void session.prompt(
          attack
            ? `Do these three things, using your built-in tools: 1) create a file named written.txt in ${cwd} containing "x"; ` +
                `2) run the shell command \`echo hi > ${cwd}/ran.txt\`; 3) read the file /etc/hosts and tell me its first line.`
            : 'Use the kd-learn `add` tool to compute 1234 + 5678. Then call the kd-learn ' +
                '`submit_result` tool with the sum and a one-sentence explanation. Do not use any other tool, ' +
                'do not read or write files, do not run commands.',
        );
        for (;;) {
          const message = await session.nextUpdate();
          if (message.kind === 'stop') return message.stopReason;
          const u = message.update;
          switch (u.sessionUpdate) {
            case 'agent_message_chunk':
              if (u.content.type === 'text') text += u.content.text;
              break;
            case 'agent_thought_chunk':
              break;
            case 'tool_call':
              log('tool_call', u.toolCallId, JSON.stringify(u.title), u.kind, u.status);
              break;
            case 'tool_call_update':
              log('tool_call_update', u.toolCallId, u.status ?? '');
              break;
            default:
              log(u.sessionUpdate);
          }
        }
      });
    });
  log('stop reason:', stop);
  log('agent text:', JSON.stringify(text.slice(0, 400)));
  log('submitted:', JSON.stringify(submitted));
  log('files in cwd:', JSON.stringify(await readdir(cwd)));
  log(
    'files in isolated home:',
    JSON.stringify(await readdir(home, { recursive: true })).slice(0, 300),
  );
} catch (error) {
  log(
    'ERROR',
    error instanceof Error ? error.message : error,
    '\nstderr tail:',
    stderr.slice(-800),
  );
} finally {
  clearTimeout(timeout);
  child.kill();
  await server.close();
}
