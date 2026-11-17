// In-process MCP server over Streamable HTTP, so an ACP agent can call kd-learn tools.
// Bound to 127.0.0.1 with a random port and a per-turn bearer token.
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export interface ServedTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  /** Resolves with the text sent back to the agent; rejects to report a tool error. */
  readonly call: (args: unknown) => Promise<string>;
}

export interface ToolServer {
  readonly url: string;
  readonly token: string;
  readonly close: () => Promise<void>;
}

const mcpServerFor = (tools: ReadonlyArray<ServedTool>) => {
  const server = new Server(
    { name: 'kd-learn', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as { type: 'object' },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const found = tools.find((t) => t.name === request.params.name);
    if (!found) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Unknown tool ${request.params.name}` }],
      };
    }
    try {
      const text = await found.call(request.params.arguments ?? {});
      return { content: [{ type: 'text', text }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { isError: true, content: [{ type: 'text', text: message }] };
    }
  });
  return server;
};

export const startToolServer = async (tools: ReadonlyArray<ServedTool>): Promise<ToolServer> => {
  const token = randomBytes(24).toString('hex');

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }
    // Stateless mode: one MCP server and transport per request.
    const transport = new StreamableHTTPServerTransport({}); // no sessionIdGenerator: stateless
    const server = mcpServerFor(tools);
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  };

  const http = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
};
