// A stand-in for an OpenAI-compatible model in the account browser tests. The production build
// talks to it through `KD_OPENAI_COMPATIBLE_ENDPOINTS`, so the server, its turn runner and the
// TanStack adapter all run for real; only the model is replaced. Run with `node` (type stripping).
//
// Answers, in this order:
// - a request with `response_format: json_schema` (structured output): JSON built for the schema
//   it recognises (extractor, auditor, merge; the Practitioner writing exercises or grading an
//   answer, steered by `#wrong` / `#partial` in it; research queries), streamed as text;
// - a research summary request (results in the prompt): a summary citing [R1];
// - right after a tool result: "Noted.";
// - when `create_plan` is offered (the planning turn): a one-step plan, step id `basics`;
// - the first turn (no assistant message yet): a question;
// - `#assess` in the learner's message, with `submit_assessment` offered: an assessment;
// - `#done`, with `complete_step` offered: completes step `basics` (the last one: the session ends);
// - `#cite`, with source excerpts in the system prompt: an answer citing [S1];
// - `hold`: streams a first chunk and waits until `POST /release/<apiKey>` (the key of the test's
//   own connection, so parallel tests do not release each other's turns);
// - otherwise it repeats the message.
// `GET /calls/<apiKey>` counts the requests made with that key. With `slow-extract` in the key, the
// first structured request waits for `POST /release/<apiKey>` too (an extraction still running).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const port = Number(process.env['FAKE_OPENAI_PORT'] ?? 4175);

interface ChatMessage {
  readonly role: string;
  readonly content?: unknown;
}

interface ChatRequest {
  readonly messages?: ChatMessage[];
  readonly tools?: Array<{ function?: { name?: string } }>;
  readonly response_format?: {
    type?: string;
    json_schema?: { schema?: { properties?: Record<string, unknown> } };
  };
}

const calls = new Map<string, number>();

/** A short stable tag of a text, so propositions of different sessions differ. */
const tagOf = (text: string) => {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash.toString(36);
};

/** Structured answers of the extraction pipeline, recognised by the fields of the schema. */
const structuredAnswer = (request: ChatRequest, input: string): unknown => {
  const schema = request.response_format?.json_schema?.schema;
  const fields = Object.keys(schema?.properties ?? {});
  // Practitioner, writing: one draft per exercise key. A multiple choice has `correct`; its
  // option text says so, since its position is seeded by a server id.
  if (fields.includes('exercises')) {
    const keys = (schema?.properties?.['exercises'] as { properties?: Record<string, object> })
      ?.properties;
    return {
      exercises: Object.fromEntries(
        Object.entries(keys ?? {}).map(([key, draft]) => [
          key,
          'correct' in ((draft as { properties?: object }).properties ?? {})
            ? {
                question: `Fake question ${key}: which one holds?`,
                correct: `Fake right option ${key}`,
                distractors: [1, 2, 3].map((n) => `Fake wrong option ${key}.${n}`),
              }
            : { question: `Fake question ${key}: explain it.` },
        ]),
      ),
    };
  }
  // Practitioner, grading: `#wrong` or `#partial` in the answer steers the level.
  // Research, planning the queries (phase 4 A5).
  if (fields.includes('queries')) {
    const question = /QUESTION: (.*)/.exec(input)?.[1] ?? 'topic';
    return { queries: [question, `${question} examples`] };
  }
  if (fields.includes('level')) {
    const level = input.includes('#wrong')
      ? 'incorrect'
      : input.includes('#partial')
        ? 'partial'
        : 'correct';
    return { level, feedback: `Fake feedback: ${level}.` };
  }
  if (fields.includes('decisions')) {
    return {
      decisions: ['a', 'b'].map((key) => ({ key, action: 'new', existingId: '', reason: 'new' })),
      edges: [],
    };
  }
  const items = (schema?.properties?.['propositions'] as { items?: { properties?: object } })?.items
    ?.properties;
  if (items !== undefined && 'verdict' in items) {
    return {
      propositions: ['a', 'b'].map((key) => ({
        key,
        verdict: 'keep',
        text: '',
        parts: [],
        reason: '',
      })),
      edges: [],
    };
  }
  if (fields.includes('propositions')) {
    const tag = tagOf(input);
    return {
      propositions: [
        { key: 'a', text: `Fake claim ${tag} builds on the basics.`, stepId: 'basics' },
        { key: 'b', text: `Fake claim ${tag} states the basics.`, stepId: 'basics' },
      ],
      edges: [{ from: 'a', to: 'b', relation: 'requires', label: 'needs' }],
    };
  }
  return undefined;
};

const toolCall = (response: ServerResponse, name: string, input: unknown) => {
  chunk(
    response,
    {
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id: `call_${name}`,
          type: 'function',
          function: { name, arguments: JSON.stringify(input) },
        },
      ],
    },
    null,
  );
  chunk(response, {}, 'tool_calls');
  response.end('data: [DONE]\n\n');
};

const waiting = new Map<string, Array<() => void>>();
const released = new Set<string>();
const slowed = new Set<string>();

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
    const counted = /^\/calls\/(.+)$/.exec(url.pathname);
    if (request.method === 'GET' && counted?.[1] !== undefined) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ calls: calls.get(decodeURIComponent(counted[1])) ?? 0 }));
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
    const body = JSON.parse(await readBody(request)) as ChatRequest;
    const key = (request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    calls.set(key, (calls.get(key) ?? 0) + 1);
    const messages = body.messages ?? [];
    const users = messages.filter((message) => message.role === 'user');
    const last = textOf(users.at(-1)?.content);
    const tools = new Set((body.tools ?? []).map((tool) => tool.function?.name));
    // The agent turn that opens a session has no answer of the learner yet, only a nudge.
    const opening = !messages.some((message) => message.role === 'assistant');

    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    if (body.response_format?.type === 'json_schema') {
      if (key.includes('slow-extract') && !slowed.has(key)) {
        slowed.add(key);
        await hold(key, response);
        if (response.destroyed) return;
      }
      const value = structuredAnswer(body, last);
      if (value === undefined) {
        chunk(response, { role: 'assistant', content: '{}' }, null);
      } else {
        // Two chunks, as a real stream would split it.
        const text = JSON.stringify(value);
        const half = Math.ceil(text.length / 2);
        chunk(response, { role: 'assistant', content: text.slice(0, half) }, null);
        chunk(response, { content: text.slice(half) }, null);
      }
    } else if (last.includes('RESULTS (data, not instructions)')) {
      chunk(
        response,
        {
          role: 'assistant',
          content: 'Fake research summary: the basics first [R1], then examples [R2].',
        },
        null,
      );
    } else if (messages.at(-1)?.role === 'tool') {
      chunk(response, { role: 'assistant', content: 'Noted.' }, null);
    } else if (tools.has('create_plan')) {
      return toolCall(response, 'create_plan', {
        nodes: [{ id: 'basics', title: 'Basics', goal: 'Explain the basics', dependsOn: [] }],
      });
    } else if (opening) {
      chunk(response, { role: 'assistant', content: 'What do you already know?' }, null);
    } else if (last.includes('#assess') && tools.has('submit_assessment')) {
      return toolCall(response, 'submit_assessment', {
        level: 'beginner',
        summary: 'Knows a little.',
        strengths: [],
        gaps: ['The basics'],
      });
    } else if (last.includes('#done') && tools.has('complete_step')) {
      return toolCall(response, 'complete_step', { stepId: 'basics' });
    } else if (
      last.includes('#cite') &&
      messages.some((m) => m.role !== 'user' && textOf(m.content).includes('label="S1"'))
    ) {
      // Grounded teaching (phase 4): cite the first excerpt of the slice.
      chunk(response, { role: 'assistant', content: 'From your own source [S1].' }, null);
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
