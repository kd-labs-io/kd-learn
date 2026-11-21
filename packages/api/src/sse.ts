// Server-sent events framing for `Frame`. Pure string work, shared by server and client.
import { Schema } from 'effect';
import { Frame } from './contract.ts';

const encodeJson = Schema.encodeSync(Frame);

/** One SSE message: `event: <tag>` and a single-line JSON `data`. */
export const encodeFrame = (frame: Frame): string =>
  `event: ${frame._tag}\ndata: ${JSON.stringify(encodeJson(frame))}\n\n`;

export interface SseMessage {
  readonly event: string;
  readonly data: string;
}

/**
 * Incremental SSE parser. Feed it text chunks as they arrive (a chunk may end mid-line or
 * mid-message); it returns the messages completed by each chunk. Handles LF, CRLF and CR line
 * ends, multi-line `data`, comment lines (`:`) and ignores fields other than `event` and `data`.
 */
export const makeSseParser = () => {
  let buffer = '';
  let event = '';
  let data: Array<string> = [];
  let sawData = false;

  const push = (chunk: string): Array<SseMessage> => {
    buffer += chunk;
    const messages: Array<SseMessage> = [];
    // A trailing CR may be the first half of CRLF: keep it until the next chunk.
    const lines = buffer.split(/\r\n|\n|\r(?!$)/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line === '') {
        if (sawData) {
          messages.push({ event: event === '' ? 'message' : event, data: data.join('\n') });
        }
        event = '';
        data = [];
        sawData = false;
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      const raw = colon === -1 ? '' : line.slice(colon + 1);
      const value = raw.startsWith(' ') ? raw.slice(1) : raw;
      if (field === 'event') event = value;
      else if (field === 'data') {
        data.push(value);
        sawData = true;
      }
    }
    return messages;
  };
  return { push };
};
