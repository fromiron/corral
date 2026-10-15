export const MAX_SSE_BUFFER_BYTES = 1024 * 1024;

/** Stop slow readers before Node's outgoing buffer can grow without bound. */
export function boundedSseWriter(
  sink: { readonly writableLength: number; write(chunk: string): unknown },
  overflow: () => void,
  maxBytes = MAX_SSE_BUFFER_BYTES,
): (chunk: string) => boolean {
  let stopped = false;
  return (chunk) => {
    if (stopped) return false;
    if (sink.writableLength + Buffer.byteLength(chunk) > maxBytes) {
      stopped = true;
      overflow();
      return false;
    }
    sink.write(chunk);
    return true;
  };
}

/** The caller unsubscribes first: retain one committed record, never a queue of records. */
export async function flushSseRecord(
  sink: { write(chunk: Uint8Array, callback: (error?: Error | null) => void): unknown },
  frame: string,
): Promise<void> {
  const write = (chunk: Uint8Array) =>
    new Promise<void>((resolve, reject) => {
      sink.write(chunk, (error) => (error ? reject(error) : resolve()));
    });
  await write(new Uint8Array());
  const bytes = Buffer.from(frame);
  for (let offset = 0; offset < bytes.length; offset += 64 * 1024)
    await write(bytes.subarray(offset, offset + 64 * 1024));
}
