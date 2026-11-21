// AiPort adapter that drives an agent CLI over ACP (plan 2.4: ACP backends, account mode only).
// The agent runs isolated: empty temp cwd, its built-in tools off, the server user's agent config
// not loaded where the agent allows it. kd-learn tools reach the agent through an in-process MCP
// server; a structured result comes back through a `submit_result` tool checked with Effect Schema.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import * as acp from '@agentclientprotocol/sdk';
import { Cause, Effect, Layer, Queue, Schema, Stream } from 'effect';
import {
  AiPort,
  OutputInvalid,
  ProviderError,
  type FinishReason,
  type ModelRef,
  type TurnEvent,
  type TurnRequest,
} from '../port/index.ts';
import { jsonSchemaOf } from '../tanstack/index.ts';
import { startToolServer, type ServedTool } from './tool-server.ts';

// Remove a temp dir; retry while the agent's last writes land, and never fail the turn on cleanup.
const removeDir = (dir: string) =>
  Effect.promise(() =>
    rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => undefined,
    ),
  );

// Kill the agent and wait for it to exit (SIGKILL after 2 s), so it no longer writes to its temp dirs.
const stopChild = (child: ChildProcess) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill();
      }),
  );

export type AcpRef = Extract<ModelRef, { provider: 'acp' }>;

const SUBMIT = 'submit_result';
/** One fix is allowed after a rejected `submit_result` (spike pass criteria). */
const MAX_SUBMIT_ATTEMPTS = 2;

const bridgePath = fileURLToPath(new URL('./stdio-bridge.ts', import.meta.url));
const claudeAgentPath = fileURLToPath(
  new URL(
    './dist/index.js',
    import.meta.resolve('@agentclientprotocol/claude-agent-acp/package.json'),
  ),
);

export interface Launch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly sessionMeta?: Record<string, unknown>;
}

/** How to start each agent isolated from the server user's own agent setup. */
const launchFor = (ref: AcpRef, home: string): Launch => {
  switch (ref.agent) {
    case 'claude-code':
      return {
        command: process.execPath,
        args: [claudeAgentPath],
        env: {
          ...process.env,
          // claude-agent-acp overrides `options.model` with its own pick; ANTHROPIC_MODEL wins over it.
          ...(ref.model ? { ANTHROPIC_MODEL: ref.model } : {}),
          // Without this, every claude.ai connector of the account joins the context (~500k tokens).
          ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
        },
        // No built-in tools, no user/project settings (hooks, MCP servers, default mode), no bypass,
        // no MCP servers but kd-learn's.
        sessionMeta: {
          claudeCode: {
            options: {
              tools: [],
              settingSources: [],
              strictMcpConfig: true,
              allowDangerouslySkipPermissions: false,
            },
          },
        },
      };
    case 'antigravity':
      return {
        command: 'agy',
        // Own data dir: no user hooks, and transcripts stay out of the server user's home.
        args: ['acp', '--gemini-dir', join(home, '.gemini')],
        env: { ...process.env, ...(ref.apiKey ? { GEMINI_API_KEY: ref.apiKey } : {}) },
      };
    case 'opencode':
      return {
        command: 'opencode',
        args: ['acp'],
        env: {
          ...process.env,
          // Deny every built-in permission; only kd-learn MCP tools stay allowed.
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            ...(ref.model ? { model: ref.model } : {}),
            permission: { '*': 'deny', 'kd-learn_*': 'allow' },
          }),
        },
      };
  }
};

/** Claude names MCP tools `mcp__kd-learn__x`, Antigravity `mcp_kd-learn_x`, opencode `kd-learn_x`. */
const isKdLearnTool = (name: string) => /^(Run )?(mcp__?)?kd-learn_/.test(name);

const finishOf = (stop: acp.StopReason): FinishReason => {
  switch (stop) {
    case 'end_turn':
      return 'stop';
    case 'max_tokens':
    case 'max_turn_requests':
      return 'length';
    case 'refusal':
      return 'content_filter';
    default:
      return 'unknown';
  }
};

/** ACP has one prompt per turn: system text and history go in as one transcript. */
const promptText = (request: TurnRequest<unknown>, hasOutput: boolean, toolRule: boolean) => {
  const parts: Array<string> = [];
  if (request.system) parts.push(`<instructions>\n${request.system}\n</instructions>`);
  for (const m of request.messages.slice(0, -1))
    parts.push(`<${m.role}>\n${m.content}\n</${m.role}>`);
  const last = request.messages.at(-1);
  if (last) parts.push(last.content);
  if (hasOutput) {
    parts.push(
      `When you are done, call the kd-learn \`${SUBMIT}\` tool exactly once with your final answer. ` +
        'If it reports an error, fix the input and call it again.',
    );
  }
  if (toolRule)
    parts.push('Use only kd-learn tools. Do not read or write files and do not run commands.');
  return parts.join('\n\n');
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Test hook: start a fake agent instead of the real CLI. */
export interface AcpOverrides {
  readonly launch?: (ref: AcpRef, home: string) => Launch;
  /** Spike hook: called on every `submit_result` call, accepted or not. */
  readonly onSubmit?: (accepted: boolean) => void;
  /** Spike hook: false drops the "use only kd-learn tools" line, to test the technical block alone. */
  readonly toolRule?: boolean;
}

export const runTurn =
  (overrides: AcpOverrides = {}) =>
  <A = never>(
    request: TurnRequest<A>,
  ): Stream.Stream<TurnEvent<A>, ProviderError | OutputInvalid> => {
    const ref = request.model;
    if (ref.provider !== 'acp') {
      return Stream.fail(new ProviderError({ message: `Not an ACP model: ${ref.provider}` }));
    }

    return Stream.callback<TurnEvent<A>, ProviderError | OutputInvalid>((queue) =>
      Effect.gen(function* () {
        const emit = (event: TurnEvent<A>) => Queue.offerUnsafe(queue, event);

        const cwd = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), 'kd-acp-'))),
          removeDir,
        );
        const home = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), 'kd-acp-home-'))),
          removeDir,
        );

        // kd-learn tools, plus `submit_result` when a structured result is wanted.
        let submitted: { value: A } | undefined;
        let attempts = 0;
        let callId = 0;
        const served: Array<ServedTool> = (request.tools ?? []).map((spec) => ({
          name: spec.name,
          description: spec.description,
          inputSchema: jsonSchemaOf(spec.input),
          call: async (args) => {
            const id = `kd-${++callId}`;
            emit({ _tag: 'ToolCall', id, name: spec.name, input: args });
            const program = Schema.decodeUnknownEffect(spec.input)(args).pipe(
              Effect.mapError(
                (issue) => new Error(`Invalid input for ${spec.name}: ${issue.message}`),
              ),
              Effect.flatMap((input) =>
                spec.run(input).pipe(Effect.mapError((error) => new Error(error.message))),
              ),
              Effect.map((out) => JSON.stringify(out)),
            );
            const exit = await Effect.runPromiseExit(program);
            const output = exit._tag === 'Success' ? exit.value : `Error: ${message(exit.cause)}`;
            emit({ _tag: 'ToolResult', id, output });
            if (exit._tag === 'Failure') throw new Error(output);
            return output;
          },
        }));
        const output = request.output;
        if (output) {
          served.push({
            name: SUBMIT,
            description: 'Submit the final answer of this turn. Call exactly once, at the end.',
            inputSchema: jsonSchemaOf(output),
            call: async (args) => {
              attempts++;
              const exit = await Effect.runPromiseExit(Schema.decodeUnknownEffect(output)(args));
              overrides.onSubmit?.(exit._tag === 'Success');
              if (exit._tag === 'Success') {
                submitted = { value: exit.value };
                emit({ _tag: 'StructuredResult', value: exit.value });
                return 'Result accepted.';
              }
              const issue = `Result rejected: ${message(exit.cause)}`;
              if (attempts >= MAX_SUBMIT_ATTEMPTS) {
                // The turn fails now; no further result is taken.
                Queue.failCauseUnsafe(
                  queue,
                  Cause.fail(new OutputInvalid({ message: issue, raw: JSON.stringify(args) })),
                );
              }
              throw new Error(issue);
            },
          });
        }
        const server = yield* Effect.acquireRelease(
          Effect.promise(() => startToolServer(served)),
          (s) => Effect.promise(() => s.close()),
        );

        const launch = (overrides.launch ?? launchFor)(ref, home);
        const child = yield* Effect.acquireRelease(
          Effect.sync((): ChildProcess =>
            spawn(launch.command, [...launch.args], {
              cwd,
              env: launch.env,
              stdio: ['pipe', 'pipe', 'pipe'],
            }),
          ),
          stopChild,
        );
        let stderr = '';
        child.stderr?.on('data', (chunk) => (stderr = (stderr + String(chunk)).slice(-2000)));

        // Cancel the prompt when the stream is interrupted, before the process is killed.
        let cancel: (() => Promise<void>) | undefined;
        // Give the agent up to 2 s to end the prompt before the process is killed.
        let settled: Promise<unknown> = Promise.resolve();
        yield* Effect.addFinalizer(() =>
          cancel
            ? Effect.promise(async () => {
                await cancel!().catch(() => undefined);
                await Promise.race([settled, new Promise((r) => setTimeout(r, 2000))]);
              })
            : Effect.void,
        );

        const stream = acp.ndJsonStream(
          Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
          Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
        );

        const run = acp
          .client({ name: 'kd-learn' })
          .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
            const call = ctx.params.toolCall as { title?: string | null; name?: string };
            const kind = isKdLearnTool(call.name ?? call.title ?? '')
              ? 'allow_once'
              : 'reject_once';
            const option = ctx.params.options.find((o) => o.kind === kind);
            return option
              ? { outcome: { outcome: 'selected' as const, optionId: option.optionId } }
              : { outcome: { outcome: 'cancelled' as const } };
          })
          .connectWith(stream, async (ctx) => {
            // No fs or terminal capability: the agent gets no file or shell access from kd-learn.
            const init = await ctx.request(acp.methods.agent.initialize, {
              protocolVersion: acp.PROTOCOL_VERSION,
              clientCapabilities: {},
            });
            const builder = ctx.buildSession({
              cwd,
              mcpServers: [],
              ...(launch.sessionMeta ? { _meta: launch.sessionMeta } : {}),
            });
            builder.withMcpServer(
              init.agentCapabilities?.mcpCapabilities?.http
                ? {
                    type: 'http',
                    name: 'kd-learn',
                    url: server.url,
                    headers: [{ name: 'Authorization', value: `Bearer ${server.token}` }],
                  }
                : {
                    // stdio only: a bridge process forwards calls to the in-process server.
                    name: 'kd-learn',
                    command: process.execPath,
                    args: [bridgePath],
                    env: [
                      { name: 'KD_LEARN_MCP_URL', value: server.url },
                      { name: 'KD_LEARN_MCP_TOKEN', value: server.token },
                    ],
                  },
            );
            return builder.withSession(async (session) => {
              cancel = () =>
                ctx.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId });
              void session.prompt(
                promptText(
                  request as TurnRequest<unknown>,
                  output !== undefined,
                  overrides.toolRule ?? true,
                ),
              );
              for (;;) {
                const next = await session.nextUpdate();
                if (next.kind === 'stop') return next.stopReason;
                const u = next.update;
                if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text') {
                  emit({ _tag: 'TextDelta', messageId: session.sessionId, delta: u.content.text });
                }
              }
            });
          });

        settled = run.catch(() => undefined);
        const stop = yield* Effect.tryPromise({
          try: () => run,
          catch: (error) =>
            new ProviderError({
              message: `${message(error)}${stderr ? `\n${stderr.slice(-500)}` : ''}`,
            }),
        });
        cancel = undefined;
        if (output && !submitted) {
          return yield* new OutputInvalid({ message: `Agent ended without ${SUBMIT}`, raw: '' });
        }
        emit({ _tag: 'Finish', reason: finishOf(stop) });
        yield* Queue.end(queue);
      }).pipe(Effect.catch((error) => Queue.fail(queue, error))),
    );
  };

export const layer = (overrides: AcpOverrides = {}) =>
  Layer.succeed(AiPort, { runTurn: runTurn(overrides) });
