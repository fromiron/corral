import { createHash } from 'node:crypto';
import { type Clock, canonicalJson, type SubSessionRequest } from '@corral/contracts';
import { planSessionCreate } from '@corral/core';
import type { Db } from '@corral/storage-sqlite';
import { WorkspaceError, type WorkspaceService } from './files/service.ts';

interface Parent {
  title: string;
  project_id: string;
  corral_id: string | null;
  auto_json: string | null;
}

export async function openSubSession(
  db: Db,
  clock: Clock,
  files: WorkspaceService,
  parentId: string,
  request: SubSessionRequest,
): Promise<{ sessionId: string; created: boolean }> {
  const requestHash = createHash('sha256')
    .update(canonicalJson({ parentId, ...request }))
    .digest('hex');
  const prior = db
    .prepare('SELECT request_hash, session_id FROM sub_session_commands WHERE command_id=?')
    .get(request.commandId) as { request_hash: string; session_id: string } | undefined;
  if (prior && prior.request_hash !== requestHash)
    throw new WorkspaceError('REVISION_CONFLICT', 'the sub-session command changed');
  const parent = db
    .prepare(
      `SELECT s.title, s.project_id, s.corral_id, s.auto_json FROM work_sessions s
         JOIN projects p ON p.id = s.project_id
        WHERE s.id = ? AND s.archived_at IS NULL AND p.archived_at IS NULL`,
    )
    .get(parentId) as Parent | undefined;
  if (!parent) throw new WorkspaceError('TARGET_NOT_FOUND', 'the parent session is unavailable');
  if (!prior) {
    const copy = files.worktreeView(parentId);
    if (!copy) throw new WorkspaceError('CAPABILITY_DENIED', 'the parent session has no Paddock');
    if (copy.missing)
      throw new WorkspaceError('TARGET_NOT_FOUND', 'the parent working copy is missing');
  }
  const sessionId = prior?.session_id ?? insert(db, clock, parentId, parent, request, requestHash);
  await files.branchFromCopy(parentId, sessionId, parent.title);
  return { sessionId, created: !prior };
}

function insert(
  db: Db,
  clock: Clock,
  parentId: string,
  parent: Parent,
  request: SubSessionRequest,
  requestHash: string,
): string {
  const id = `session_sub_${createHash('sha256').update(request.commandId).digest('hex').slice(0, 32)}`;
  const created = planSessionCreate(
    {
      projectId: parent.project_id,
      title: request.title,
      corralId: parent.corral_id,
      autoTitle: true,
    },
    { now: clock.nowIso(), sessionId: id },
  );
  if (!created.ok) throw new WorkspaceError('SCHEMA_INVALID', created.message);
  const session = created.session;
  db.transaction(() => {
    db.prepare(
      `INSERT INTO work_sessions (id, project_id, corral_id, title, objective, pinned, revision,
         created_at, updated_at, archived_at, entries_json, auto_json, auto_title, parent_session_id)
       VALUES (?, ?, ?, ?, '', 0, 1, ?, ?, NULL, '[]', ?, 1, ?)`,
    ).run(
      id,
      session.projectId,
      session.corralId,
      session.title,
      session.createdAt,
      session.updatedAt,
      parent.auto_json,
      parentId,
    );
    db.prepare('INSERT INTO sub_session_commands VALUES (?, ?, ?, ?, ?)').run(
      request.commandId,
      requestHash,
      parentId,
      id,
      session.createdAt,
    );
  })();
  return id;
}
