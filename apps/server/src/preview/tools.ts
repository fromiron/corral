import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BROWSER_TOOLS, createPreviewBrowserTransport } from '@corral/adapter-pi';
import { canonicalJson } from '@corral/contracts';
import type { ToolCancellation } from '@corral/core';
import { ToolRefusal } from '@corral/core';
import { McpClient } from '@earendil-works/pi-mcp';
import { z } from 'zod';
import type { PreviewService } from './service.ts';

type Execution = {
  runId: string;
  executionId: string;
  attemptNo: number;
  effectId: string;
  name: 'preview_file' | 'preview_app' | 'preview_action';
  args: Record<string, unknown>;
};
type Browser = {
  client: McpClient;
  transport: ReturnType<typeof createPreviewBrowserTransport>;
};
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

/** Coordinator is the only caller of execute; public HTTP exposes no browser action endpoint. */
export class PreviewToolsBroker {
  private readonly previews: PreviewService;
  private readonly options: {
    sessionOfRun: (runId: string) => string | null;
    directory: string;
    browserExecutable?: string;
  };
  private readonly browsers = new Map<string, Promise<Browser>>();
  private readonly effects = new Map<
    string,
    { signature: string; result: Promise<Record<string, unknown>> }
  >();
  private readonly actionTails = new Map<string, Promise<void>>();
  private readonly owners = new Map<
    string,
    { runId: string; executionId: string; sessionId: string }
  >();
  private readonly unsubscribe: () => void;
  constructor(previews: PreviewService, options: PreviewToolsBroker['options']) {
    this.previews = previews;
    this.options = options;
    this.unsubscribe = previews.onStop((leaseId) => this.closeBrowser(leaseId));
  }

  execute(input: Execution, cancellation: ToolCancellation): Promise<Record<string, unknown>> {
    const key = `${input.runId}:${input.executionId}:${input.attemptNo}:${input.effectId}`;
    const signature = canonicalJson(input);
    const existing = this.effects.get(key);
    if (existing) {
      if (existing.signature !== signature)
        throw new ToolRefusal('REVISION_CONFLICT', 'preview effect arguments changed');
      return existing.result;
    }
    const leaseKey = input.name === 'preview_action' ? String(input.args.leaseId) : null;
    const result = leaseKey
      ? (this.actionTails.get(leaseKey) ?? Promise.resolve())
          .catch(() => {})
          .then(() => this.perform(input, cancellation))
      : this.perform(input, cancellation);
    if (leaseKey)
      this.actionTails.set(
        leaseKey,
        result.then(
          () => {},
          () => {},
        ),
      );
    this.effects.set(key, { signature, result });
    return result;
  }

  private async perform(
    input: Execution,
    cancellation: ToolCancellation,
  ): Promise<Record<string, unknown>> {
    const sessionId = this.options.sessionOfRun(input.runId);
    if (!sessionId || cancellation.aborted)
      throw new ToolRefusal('TARGET_TERMINAL', 'preview requires a live session execution');
    if (input.name === 'preview_file' || input.name === 'preview_app') {
      const lease = await this.previews.start(
        sessionId,
        input.name === 'preview_file'
          ? { path: String(input.args.path), runId: input.runId }
          : {
              operationId: String(input.args.operationId),
              port: Number(input.args.port),
              ...(input.args.entryPath ? { entryPath: String(input.args.entryPath) } : {}),
            },
      );
      if (cancellation.aborted || lease.runId !== input.runId) {
        await this.previews.stop(sessionId, lease.leaseId);
        throw new ToolRefusal('TARGET_TERMINAL', 'preview target is outside this run');
      }
      this.owners.set(lease.leaseId, {
        runId: input.runId,
        executionId: input.executionId,
        sessionId,
      });
      return {
        leaseId: lease.leaseId,
        kind: lease.kind,
        path: lease.path,
        ...(lease.operationId ? { operationId: lease.operationId } : {}),
      };
    }
    const leaseId = String(input.args.leaseId);
    const tool = String(input.args.tool);
    const args = input.args.args;
    const lease = this.previews.list(sessionId).find((item) => item.leaseId === leaseId);
    if (!lease || lease.runId !== input.runId || lease.state !== 'ready')
      throw new ToolRefusal(
        'CAPABILITY_DENIED',
        'preview lease belongs to another run or has ended',
      );
    if (
      !BROWSER_TOOLS.has(tool) ||
      !args ||
      typeof args !== 'object' ||
      Array.isArray(args) ||
      ['filename', 'paths', 'time'].some((name) => name in args)
    )
      throw new ToolRefusal('CAPABILITY_DENIED', 'preview action is not available');
    const cancel = cancellation.onCancel(() => {
      void this.previews.stop(sessionId, leaseId).catch(() => {});
    });
    try {
      const browser = await this.browser(sessionId, leaseId);
      if (cancellation.aborted)
        throw new ToolRefusal('TARGET_TERMINAL', 'preview action cancelled');
      const callArgs = { ...args } as Record<string, unknown>;
      if (tool === 'browser_navigate' && typeof callArgs.url === 'string') {
        const target = await this.previews.desktopTarget(sessionId, leaseId);
        if (!target) throw new Error('preview lease ended');
        callArgs.url = new URL(callArgs.url, target.url).href;
      }
      const result = await browser.client.callTool(tool, callArgs);
      if (cancellation.aborted)
        throw new ToolRefusal('TARGET_TERMINAL', 'preview action cancelled');
      const text = JSON.stringify(result);
      if (text.length > 4 * 1024 * 1024) throw new Error('preview evidence exceeds storage limit');
      const evidence = {
        sessionId,
        runId: input.runId,
        executionId: input.executionId,
        attemptNo: input.attemptNo,
        effectId: input.effectId,
        leaseId,
        tool,
        result,
      };
      const evidenceId = hash(JSON.stringify(evidence));
      await this.saveEvidence(sessionId, evidenceId, JSON.stringify(evidence));
      const safe = structuredClone(result) as {
        content?: { type: string; data?: string; mimeType?: string; text?: string }[];
        isError?: boolean;
      };
      for (const item of safe.content ?? []) {
        if (item.type === 'image' && item.data) {
          const bytes = Buffer.from(item.data, 'base64');
          const imageId = hash(bytes);
          await this.saveEvidence(
            sessionId,
            imageId,
            JSON.stringify({ sessionId, mimeType: item.mimeType, data: item.data }),
          );
          delete item.data;
          Object.assign(item, {
            evidenceId: imageId,
            url: `/api/v1/sessions/${encodeURIComponent(sessionId)}/preview-evidence/${imageId}`,
          });
        }
        if (item.text) item.text = item.text.replaceAll(this.options.directory, '[preview]');
      }
      if (tool !== 'browser_snapshot') return { evidenceId, result: safe };
      const browserTools = z
        .object({
          tools: z
            .array(
              z.object({
                name: z.string(),
                description: z.string().optional(),
                inputSchema: z.record(z.string(), z.unknown()),
              }),
            )
            .max(128),
        })
        .parse(await browser.client.request('tools/list', {}))
        .tools.filter((item) => BROWSER_TOOLS.has(item.name))
        .map(({ name, description, inputSchema }) => {
          const properties = inputSchema.properties as Record<string, unknown> | undefined;
          return {
            name,
            description,
            inputSchema: {
              ...inputSchema,
              ...(properties
                ? {
                    properties: Object.fromEntries(
                      Object.entries(properties).filter(
                        ([key]) => !['filename', 'paths', 'time'].includes(key),
                      ),
                    ),
                  }
                : {}),
            },
          };
        });
      return { evidenceId, result: safe, browserTools };
    } finally {
      cancel();
    }
  }

  private async saveEvidence(sessionId: string, id: string, body: string) {
    const directory = join(this.options.directory, 'evidence', hash(sessionId));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(join(directory, `${id}.json`), body, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }

  async evidence(
    sessionId: string,
    id: string,
  ): Promise<{ contentType: string; bytes: Buffer } | null> {
    if (!/^[a-f0-9]{64}$/.test(id)) return null;
    try {
      const record = JSON.parse(
        await readFile(
          join(this.options.directory, 'evidence', hash(sessionId), `${id}.json`),
          'utf8',
        ),
      );
      if (record.sessionId !== sessionId) return null;
      if (
        typeof record.data === 'string' &&
        ['image/png', 'image/jpeg', 'image/webp'].includes(record.mimeType)
      )
        return { contentType: record.mimeType, bytes: Buffer.from(record.data, 'base64') };
      return { contentType: 'application/json', bytes: Buffer.from(JSON.stringify(record)) };
    } catch {
      return null;
    }
  }

  private browser(sessionId: string, leaseId: string): Promise<Browser> {
    const existing = this.browsers.get(leaseId);
    if (existing) return existing;
    const starting = (async () => {
      const target = await this.previews.desktopTarget(sessionId, leaseId);
      if (!target) throw new Error('preview is no longer available');
      const executablePath = await findBrowser(this.options.browserExecutable);
      const directory = join(this.options.directory, 'browsers', leaseId);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const transport = createPreviewBrowserTransport(target, {
        executablePath,
        timeoutMs: 15000,
        cwd: directory,
        directory,
        leaseDirectory: join(this.options.directory, 'process-leases'),
        revalidate: () => this.previews.desktopTarget(sessionId, leaseId),
      });
      const client = new McpClient({
        name: 'Corral owned preview',
        version: '1',
        requestTimeoutMs: 20000,
      });
      try {
        await client.connect(transport);
        const navigation = await client.callTool('browser_navigate', { url: target.url });
        if (navigation.isError) throw new Error('preview initial navigation failed');
        return { client, transport };
      } catch (error) {
        await client.close();
        await transport.close();
        throw error;
      }
    })();
    this.browsers.set(leaseId, starting);
    void starting.catch(() => this.browsers.delete(leaseId));
    return starting;
  }

  private async closeBrowser(leaseId: string) {
    const pending = this.browsers.get(leaseId);
    if (!pending) return;
    this.browsers.delete(leaseId);
    const browser = await pending.catch(() => null);
    if (!browser) return;
    try {
      await browser.client.close();
    } finally {
      await browser.transport.close();
    }
  }
  async dispose() {
    this.unsubscribe();
    await Promise.all([...this.browsers.keys()].map((id) => this.closeBrowser(id)));
  }
  async closeRun(runId: string) {
    const sessionId = this.options.sessionOfRun(runId);
    if (!sessionId) return;
    await Promise.all(
      this.previews
        .list(sessionId)
        .filter((lease) => lease.runId === runId && lease.state === 'ready')
        .map((lease) => this.previews.stop(sessionId, lease.leaseId)),
    );
  }
  async closeExecution(runId: string, executionId: string) {
    await Promise.all(
      [...this.owners.entries()]
        .filter(([, owner]) => owner.runId === runId && owner.executionId === executionId)
        .map(async ([leaseId, owner]) => {
          await this.previews.stop(owner.sessionId, leaseId);
          this.owners.delete(leaseId);
        }),
    );
  }
}

async function findBrowser(explicit?: string): Promise<string> {
  const candidates = [
    explicit,
    process.env.CORRAL_BROWSER_EXECUTABLE,
    ...(process.platform === 'win32'
      ? [
          join(
            process.env.ProgramFiles ?? 'C:\\Program Files',
            'Google/Chrome/Application/chrome.exe',
          ),
          join(
            process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
            'Microsoft/Edge/Application/msedge.exe',
          ),
        ]
      : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']),
  ].filter((value): value is string => !!value);
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      /* Try installed candidates. */
    }
  }
  throw new Error('Install a supported Chromium browser or configure CORRAL_BROWSER_EXECUTABLE.');
}
