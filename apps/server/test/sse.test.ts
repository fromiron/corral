import { expect, it } from 'vitest';
import { boundedSseWriter, flushSseRecord } from '../src/sse.ts';

it('bounds the buffer including the next UTF-8 frame and disconnects once', () => {
  const sink = {
    writableLength: 0,
    write(chunk: string) {
      this.writableLength += Buffer.byteLength(chunk);
    },
  };
  let closed = 0;
  const send = boundedSseWriter(sink, () => closed++, 10);
  expect(send('1234567')).toBe(true);
  expect(send('한글')).toBe(false);
  expect(sink.writableLength).toBe(7);
  expect(send('ping')).toBe(false);
  expect(closed).toBe(1);
});

it('flushes the prefix before writing one bounded UTF-8 chunk at a time', async () => {
  const frame = `event: domain\ndata: ${'한글🌱'.repeat(100_000)}\n\n`;
  const chunks: Uint8Array[] = [];
  let flushPrefix: () => void = () => {};
  let pending = 0;
  let maximumPending = 0;
  const writing = flushSseRecord(
    {
      write(chunk: Uint8Array, done?: (error?: Error | null) => void) {
        chunks.push(chunk);
        pending++;
        maximumPending = Math.max(maximumPending, pending);
        const finish = () => {
          pending--;
          done?.();
        };
        if (chunks.length === 1) flushPrefix = finish;
        else queueMicrotask(finish);
        return false;
      },
    },
    frame,
  );
  await Promise.resolve();
  expect(chunks).toHaveLength(1);
  expect(chunks[0]?.byteLength).toBe(0);
  flushPrefix();
  await writing;
  expect(maximumPending).toBe(1);
  expect(chunks.every((chunk) => chunk.byteLength <= 64 * 1024)).toBe(true);
  expect(Buffer.concat(chunks).toString('utf8')).toBe(frame);
});

it('stops writing when a disconnected reader fails a chunk', async () => {
  let writes = 0;
  await expect(
    flushSseRecord(
      {
        write(_chunk: Uint8Array, done?: (error?: Error | null) => void) {
          writes++;
          done?.(writes === 2 ? new Error('reader disconnected') : null);
          return false;
        },
      },
      'x'.repeat(2 * 1024 * 1024),
    ),
  ).rejects.toThrow('reader disconnected');
  expect(writes).toBe(2);
});
