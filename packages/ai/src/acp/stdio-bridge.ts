// MCP stdio server that forwards every call to the in-process HTTP tool server.
// For agents that only support stdio MCP servers. Tools still run inside kd-learn.
// Env: KD_LEARN_MCP_URL, KD_LEARN_MCP_TOKEN.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const url = process.env.KD_LEARN_MCP_URL;
const token = process.env.KD_LEARN_MCP_TOKEN;
if (!url || !token) {
  console.error('KD_LEARN_MCP_URL and KD_LEARN_MCP_TOKEN are required');
  process.exit(1);
}

const upstream = new Client({ name: 'kd-learn-bridge', version: '0.0.0' });
await upstream.connect(
  new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }),
);

const server = new Server({ name: 'kd-learn', version: '0.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => upstream.listTools());
server.setRequestHandler(CallToolRequestSchema, (request) => upstream.callTool(request.params));
await server.connect(new StdioServerTransport());
