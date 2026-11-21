// A stand-in for an OpenAI-compatible model in the account browser tests. The production build
// talks to it through `KD_OPENAI_COMPATIBLE_ENDPOINTS`, so the server, its turn runner and the
// TanStack adapter all run for real; only the model is replaced. Run with `node` (type stripping).
//
// Every answer is plain text. The first turn (no assistant message yet) asks a question. A request whose last user message contains `hold` streams its first
// chunk and then waits until `POST /release/<apiKey>` (the key of the test's own connection, so
// parallel tests do not release each other's turns).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const port = Number(process.env['FAKE_OPENAI_PORT'] ?? 4175);

interface ChatMessage {
  readonly role: string;
  readonly content?: unknown;
}

const waiting = new Map<string, Array<() => void>>();
const released = new Set<string>();

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => (body += chunk));
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((part: { text?: string }) => part.text ?? '').join('')
      : '';

const chunk = (response: ServerResponse, delta: Record<string, unknown>, finish: string | null) =>
  response.write(
    `data: ${JSON.stringify({
      id: 'fake',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'fake-model',
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`,
  );

/** Waits for a release of `key`. A request whose client went away (a cancelled turn) stops waiting. */
const hold = (key: string, response: ServerResponse): Promise<void> => {
  if (released.delete(key)) return Promise.resolve();
  return new Promise((resolve) => {
    const list = waiting.get(key) ?? [];
    list.push(resolve);
    waiting.set(key, list);
    response.on('close', () => {
      const index = list.indexOf(resolve);
      if (index !== -1) list.splice(index, 1);
      resolve();
    });
  });
};

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const release = /^\/release\/(.+)$/.exec(url.pathname);
    if (request.method === 'POST' && release?.[1] !== undefined) {
      const key = decodeURIComponent(release[1]);
      const list = waiting.get(key);
      if (list === undefined || list.length === 0) released.add(key);
      else list.shift()!();
      response.writeHead(204).end();
      return;
    }
    if (request.method === 'GET' && url.pathname === '/') {
      response.writeHead(200).end('ok');
      return;
    }
    if (request.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
      response.writeHead(404).end();
      return;
    }
    const body = JSON.parse(await readBody(request)) as { messages?: ChatMessage[] };
    const key = (request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const messages = body.messages ?? [];
    const users = messages.filter((message) => message.role === 'user');
    const last = textOf(users.at(-1)?.content);
    // The agent turn that opens a session has no answer of the learner yet, only a nudge.
    const opening = !messages.some((message) => message.role === 'assistant');

    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    if (opening) {
      chunk(response, { role: 'assistant', content: 'What do you already know?' }, null);
    } else if (last.includes('hold')) {
      chunk(response, { role: 'assistant', content: 'Thinking it over' }, null);
      await hold(key, response);
      if (response.destroyed) return;
      chunk(response, { content: ', and here is the answer.' }, null);
    } else {
      chunk(response, { role: 'assistant', content: `You said: ${last}` }, null);
    }
    chunk(response, {}, 'stop');
    response.end('data: [DONE]\n\n');
  })().catch(() => {
    if (!response.headersSent) response.writeHead(500);
    response.end();
  });
});

server.listen(port, () => {
  process.stdout.write(`fake OpenAI-compatible model on http://localhost:${port}\n`);
});
