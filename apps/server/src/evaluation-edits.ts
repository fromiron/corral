import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { editText, PiEditError } from '@corral/adapter-pi';
import { type Clock, CodingEvalSuite } from '@corral/contracts';
import { ToolRefusal } from '@corral/core';
import { openDatabase } from '@corral/storage-sqlite';
import { z } from 'zod';
import { WorkspaceError, WorkspaceService } from './files/service.ts';
import { systemClock } from './runtime.ts';

const exec = promisify(execFile);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export const HASHLINE_COMMIT = '647f9fa5dfae227d48a9588251f1a8439811e0e2';
const DriverResult = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    sourceCommit: z.literal(HASHLINE_COMMIT),
    text: z.string().max(1024 * 1024),
  }),
  z.strictObject({
    ok: z.literal(false),
    sourceCommit: z.literal(HASHLINE_COMMIT),
    error: z.literal('hashline_refused'),
  }),
]);
export function hashlineFixtureDriver(
  binary: string,
  text: string,
  patch: string,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      binary,
      [],
      { signal, timeout: 10000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => {
        if (error) {
          reject(new Error('Hashline fixture driver failed'));
          return;
        }
        try {
          const result = DriverResult.parse(JSON.parse(stdout));
          if (!result.ok) reject(new PiEditError('Hashline refused the fixture patch'));
          else resolve(result.text);
        } catch {
          reject(new Error('invalid Hashline fixture driver response'));
        }
      },
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(JSON.stringify({ text, patch }));
  });
}
type Method = 'full_write' | 'pi_edit' | 'hashline';
export interface CodingEvalReport {
  kind: 'coding_tools';
  piVersion: '1.3.0';
  results: {
    fixture: string;
    method: Method;
    status: 'applied' | 'refused' | 'error';
    correct: boolean;
    unchanged: boolean;
    wallMs: number;
    argumentBytes: number;
    sourceBytes: number;
    baseCommit: string;
    resultHash: string;
  }[];
}

/** Deterministic transforms, not LLM performance; every mutation uses the production broker. */
export async function evaluateCodingTools(
  raw: CodingEvalSuite,
  options: {
    signal: AbortSignal;
    hashline: (text: string, patch: string, signal: AbortSignal) => Promise<string>;
    now?: () => number;
    clock?: Clock;
  },
): Promise<CodingEvalReport> {
  const suite = CodingEvalSuite.parse(raw),
    root = mkdtempSync(join(tmpdir(), 'corral-coding-eval-'));
  const now = options.now ?? (() => performance.now());
  const results: CodingEvalReport['results'] = [];
  const cancellation = {
    get aborted() {
      return options.signal.aborted;
    },
    onCancel(fn: () => void) {
      options.signal.addEventListener('abort', fn, { once: true });
      if (options.signal.aborted) fn();
      return () => options.signal.removeEventListener('abort', fn);
    },
  };
  try {
    for (const [index, fixture] of suite.fixtures.entries()) {
      options.signal.throwIfAborted();
      const source = join(root, `source-${index}`);
      mkdirSync(source);
      const git = (...args: string[]) =>
        exec(
          'git',
          ['-c', 'user.name=Corral fixture', '-c', 'user.email=fixture@example.invalid', ...args],
          { cwd: source, signal: options.signal },
        );
      await git('init', '-q');
      writeFileSync(join(source, 'fixture.txt'), fixture.before);
      await git('add', '.');
      await git('commit', '-qm', 'fixture');
      const db = openDatabase(':memory:');
      let method: Method = 'full_write';
      const service = new WorkspaceService({
        db,
        clock: options.clock ?? systemClock,
        worktreeRoot: join(root, `copies-${index}`),
        forbidden: [],
        edit: async (request) => {
          if (method === 'pi_edit') return editText(request, { cancellation });
          const text = await options.hashline(request.text, fixture.hashlinePatch, options.signal);
          return { text, result: { content: [], details: { diff: '', patch: '' } } };
        },
      });
      try {
        await service.bind('default', source);
        await service.configure('default', { trusted: true });
        for (method of ['full_write', 'pi_edit', 'hashline'] as const) {
          options.signal.throwIfAborted();
          const sessionId = `session_${method}`,
            runId = `run_${method}`;
          db.prepare(
            "INSERT INTO work_sessions (id, project_id, corral_id, title, objective, pinned, revision, created_at, updated_at, archived_at, entries_json) VALUES (?, 'default', NULL, 'Fixture', '', 0, 1, 'x', 'x', NULL, '[]')",
          ).run(sessionId);
          db.prepare(
            "INSERT INTO runs (id,corral_id,definition_hash,snapshot_json,status,last_seq,projection_json,started_at,project_id,session_id) VALUES (?,'c','h','{}','running',0,'{}','x','default',?)",
          ).run(runId, sessionId);
          const copy = await service.createWorktree(sessionId, 'default');
          const file = join(service.copyOf(sessionId)!.worktree, 'fixture.txt');
          await service.execute(
            {
              name: 'read_file',
              args: { path: 'fixture.txt' },
              runId,
              executionId: 'execution_fixture',
              toolCallId: 'read',
            },
            cancellation,
          );
          if (fixture.changedBeforeApply !== undefined)
            writeFileSync(file, fixture.changedBeforeApply);
          const before = readFileSync(file, 'utf8');
          const args =
            method === 'full_write'
              ? { path: 'fixture.txt', text: fixture.expected }
              : { path: 'fixture.txt', edits: fixture.edits };
          const modelArgs =
            method === 'hashline'
              ? { input: fixture.hashlinePatch.replace('{tag}', '0000') }
              : args;
          let status: CodingEvalReport['results'][number]['status'] = 'applied';
          const started = now();
          try {
            await service.execute(
              {
                name: method === 'full_write' ? 'write_file' : 'edit',
                args,
                runId,
                executionId: 'execution_fixture',
                toolCallId: 'change',
              },
              cancellation,
            );
          } catch (error) {
            status =
              error instanceof WorkspaceError || error instanceof ToolRefusal ? 'refused' : 'error';
          }
          const wallMs = Math.round((now() - started) * 100) / 100;
          options.signal.throwIfAborted();
          const after = readFileSync(file, 'utf8');
          results.push({
            fixture: fixture.id,
            method,
            status,
            correct:
              fixture.changedBeforeApply !== undefined
                ? status === 'refused' && after === before
                : status === 'applied' && after === fixture.expected,
            unchanged: after === before,
            wallMs,
            argumentBytes: Buffer.byteLength(JSON.stringify(modelArgs)),
            sourceBytes: Buffer.byteLength(fixture.before),
            baseCommit: copy.baseCommit,
            resultHash: hash(after),
          });
        }
      } finally {
        await service.dispose();
        db.close();
      }
    }
    return { kind: 'coding_tools', piVersion: '1.3.0', results };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
