// A fake ACP agent for adapter tests. Behaviour comes from env:
// FAKE_CALLS: JSON array of [toolName, args] calls made in order through the kd-learn MCP server.
// FAKE_HANG=1: stream text until cancelled. FAKE_MARKER: file written when session/cancel arrives.
import { writeFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const calls = JSON.parse(process.env.FAKE_CALLS ?? '[]') as Array<[string, unknown]>;
let mcp: { url: string; headers: Record<string, string> } | undefined;
let cancelled = false;

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);

await acp
  .agent({ name: 'fake-agent' })
  .onRequest('initialize', () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { mcpCapabilities: { http: true } },
  }))
  .onRequest('session/new', (ctx) => {
    const server = ctx.params.mcpServers.find((s) => 'type' in s && s.type === 'http') as
      { url: string; headers: Array<{ name: string; value: string }> } | undefined;
    if (server) {
      mcp = {
        url: server.url,
        headers: Object.fromEntries(server.headers.map((h) => [h.name, h.value])),
      };
    }
    return { sessionId: 'fake-session' };
  })
  .onRequest('session/prompt', async (ctx) => {
    const say = (text: string) =>
      ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
      });
    if (process.env.FAKE_HANG) {
      while (!cancelled) {
        await say('tick ');
        await new Promise((r) => setTimeout(r, 10));
      }
      return { stopReason: 'cancelled' };
    }
    const client = new Client({ name: 'fake-agent', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(mcp!.url), {
        requestInit: { headers: mcp!.headers },
      }),
    );
    for (const [name, args] of calls) {
      const result = await client.callTool({ name, arguments: args as Record<string, unknown> });
      await say(`${name}: ${JSON.stringify(result.content)}\n`);
    }
    await client.close();
    return { stopReason: 'end_turn' };
  })
  .onNotification('session/cancel', () => {
    cancelled = true;
    if (process.env.FAKE_MARKER) writeFileSync(process.env.FAKE_MARKER, 'cancelled');
  })
  .connect(stream);
