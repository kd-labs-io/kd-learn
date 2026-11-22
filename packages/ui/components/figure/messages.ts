// Messages a demo frame may send (plan A2). Model code runs in the frame and can forge any of them,
// so the parent checks the source window, decodes, clamps the height and keeps errors short.
import { Schema } from 'effect';
import { MAX_FRAME_HEIGHT } from './frame-doc.ts';

const FrameMessage = Schema.Union([
  Schema.Struct({ type: Schema.Literal('resize'), height: Schema.Finite }),
  Schema.Struct({ type: Schema.Literal('error'), message: Schema.String }),
  Schema.Struct({ type: Schema.Literal('ready') }),
]);
export type FrameMessage = typeof FrameMessage.Type;

const decode = Schema.decodeUnknownOption(FrameMessage);

/** The message, cleaned; undefined when it is not one of the three kinds. */
export const readFrameMessage = (data: unknown): FrameMessage | undefined => {
  const decoded = decode(data);
  if (decoded._tag === 'None') return undefined;
  const message = decoded.value;
  if (message.type === 'resize') {
    return {
      type: 'resize',
      height: Math.min(Math.max(0, Math.round(message.height)), MAX_FRAME_HEIGHT),
    };
  }
  if (message.type === 'error') return { type: 'error', message: message.message.slice(0, 300) };
  return message;
};
