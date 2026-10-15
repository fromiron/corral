#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { runCli } from './index.ts';

const controller = new AbortController();
const interrupt = () => controller.abort();
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
try {
  process.exitCode = await runCli(process.argv.slice(2), {
    cwd: process.cwd(),
    signal: controller.signal,
    write: (line) => console.log(line),
    ...(process.stdin.isTTY
      ? {
          onLine: (listener: (line: string) => void) => {
            const lines = createInterface({ input: process.stdin, output: process.stdout });
            lines.on('line', listener);
            lines.on('SIGINT', interrupt);
            return () => lines.close();
          },
        }
      : {}),
  });
} finally {
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', interrupt);
}
