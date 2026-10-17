import { EditTextRequest, EditTextResult } from '@corral/contracts';
import { createEditTool } from '@earendil-works/pi-coding-agent';
import { processPort } from './worker-process.ts';

const port = processPort();
let started = false;
port.onFrame((raw) => {
  if (started) {
    port.kill();
    return;
  }
  started = true;
  void (async () => {
    try {
      const request = EditTextRequest.parse(raw);
      let text = request.text;
      const tool = createEditTool('/corral-virtual', {
        operations: {
          access: async () => {},
          readFile: async () => Buffer.from(request.text, 'utf8'),
          writeFile: async (_path, content) => {
            text = content;
          },
        },
      });
      const result = await tool.execute('edit', { path: request.path, edits: request.edits });
      port.send({ type: 'edited', result: EditTextResult.parse({ text, result }) });
    } catch (error) {
      port.send({
        type: 'error',
        message:
          error instanceof Error && error.name !== 'ZodError'
            ? error.message.slice(0, 2000)
            : 'invalid edit input or result',
      });
    } finally {
      port.kill();
    }
  })();
});
port.send({ type: 'ready' });
