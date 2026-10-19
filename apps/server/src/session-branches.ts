import { createHash } from 'node:crypto';
import {
  type Clock,
  canonicalJson,
  type ImageInput,
  type MessageBranchRequest,
  type RuntimeFiles,
} from '@corral/contracts';
import { planSessionCreate } from '@corral/core';
import type { Db } from '@corral/storage-sqlite';
import type { WorkspaceService } from './files/service.ts';
import type { ImageStore } from './images.ts';

/** The durable command binding lets an interrupted preparation reuse only its own empty copy. */
export async function prepareBranchSession(
  db: Db,
  clock: Clock,
  files: WorkspaceService,
  images: ImageStore,
  request: MessageBranchRequest,
  plan: {
    sourceRunId: string;
    sourceSessionId: string | null;
    files: RuntimeFiles | null;
    images: ImageInput[];
  },
): Promise<{ sessionId: string }> {
  if (!plan.sourceSessionId) throw new Error('a message branch requires a source session');
  const requestHash = createHash('sha256').update(canonicalJson(request)).digest('hex');
  const sessionId = db.transaction(() => {
    const prior = db
      .prepare('SELECT request_hash,session_id FROM message_branches WHERE command_id=?')
      .get(request.commandId) as { request_hash: string; session_id: string } | undefined;
    if (prior) {
      if (prior.request_hash !== requestHash) throw new Error('branch command changed');
      return prior.session_id;
    }
    const source = db
      .prepare(
        "SELECT s.title,s.project_id,c.id AS corral_id FROM work_sessions s JOIN projects p ON p.id=s.project_id JOIN runs r ON r.id=? LEFT JOIN corrals c ON c.id=json_extract(r.snapshot_json,'$.source.corralId') WHERE s.id=? AND s.archived_at IS NULL AND p.archived_at IS NULL",
      )
      .get(plan.sourceRunId, plan.sourceSessionId) as
      | { title: string; project_id: string; corral_id: string | null }
      | undefined;
    if (!source) throw new Error('source session unavailable');
    const id = `session_branch_${createHash('sha256').update(request.commandId).digest('hex').slice(0, 32)}`;
    const created = planSessionCreate(
      {
        projectId: source.project_id,
        title: `${source.title.slice(0, 100)} · branch`,
        corralId: source.corral_id,
      },
      { now: clock.nowIso(), sessionId: id },
    );
    if (!created.ok) throw new Error(created.message);
    const session = created.session;
    db.prepare(
      'INSERT INTO work_sessions (id,project_id,corral_id,title,objective,pinned,revision,created_at,updated_at,archived_at,entries_json,auto_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)',
    ).run(
      id,
      session.projectId,
      session.corralId,
      session.title,
      '',
      0,
      1,
      session.createdAt,
      session.updatedAt,
      null,
      '[]',
    );
    db.prepare('INSERT INTO message_branches VALUES (?,?,?,?,?,?)').run(
      request.commandId,
      requestHash,
      plan.sourceRunId,
      request.artifactVersionId ?? 'request_start',
      id,
      clock.nowIso(),
    );
    return id;
  })();
  for (const image of plan.images)
    images.put(sessionId, image.name, Buffer.from(image.data, 'base64'));
  if (plan.files) await files.branchRuntimeFiles(plan.sourceRunId, plan.files, sessionId);
  return { sessionId };
}
