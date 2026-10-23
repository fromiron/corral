import { createHash } from 'node:crypto';
import {
  canonicalJson,
  type FileEditProposal,
  FileEditProposalContent,
  type FileEditProposalSummary,
  ProposedTextFile,
} from '@corral/contracts';
import { ToolRefusal } from '@corral/core';
import type { Db } from '@corral/storage-sqlite';

interface ProposalRow {
  id: string;
  session_id: string;
  request_id: string;
  request_hash: string;
  content_json: string;
  content_hash: string;
  dismissed: number;
  operation_id: string | null;
  created_at: string;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const SummaryContent = FileEditProposalContent.omit({ source: true }).extend({
  files: ProposedTextFile.omit({ before: true, after: true }).array().min(1).max(32),
});

export class FileEditProposals {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  private read(row: ProposalRow): FileEditProposal {
    let content: FileEditProposalContent;
    try {
      content = FileEditProposalContent.parse(JSON.parse(row.content_json));
    } catch {
      throw new ToolRefusal('REVISION_CONFLICT', 'file edit proposal content is invalid');
    }
    if (
      content.proposalId !== row.id ||
      content.target.sessionId !== row.session_id ||
      content.createdAt !== row.created_at ||
      hash(canonicalJson(content)) !== row.content_hash
    )
      throw new ToolRefusal('REVISION_CONFLICT', 'file edit proposal content changed');
    return {
      ...content,
      hash: row.content_hash,
      dismissed: row.dismissed === 1,
      operationId: row.operation_id,
    };
  }

  get(sessionId: string, id: string): FileEditProposal {
    const row = this.db
      .prepare('SELECT * FROM file_edit_proposals WHERE session_id=? AND id=?')
      .get(sessionId, id) as ProposalRow | undefined;
    if (!row) throw new ToolRefusal('TARGET_NOT_FOUND', 'file edit proposal is unavailable');
    return this.read(row);
  }

  forRequest(sessionId: string, requestId: string, requestHash: string): FileEditProposal[] {
    const rows = this.db
      .prepare('SELECT * FROM file_edit_proposals WHERE session_id=? AND request_id=? ORDER BY id')
      .all(sessionId, requestId) as ProposalRow[];
    if (rows.some((row) => row.request_hash !== requestHash))
      throw new ToolRefusal('REVISION_CONFLICT', 'file edit proposal request changed');
    return rows.map((row) => this.read(row));
  }

  put(content: FileEditProposalContent, requestId: string, requestHash: string): FileEditProposal {
    const parsed = FileEditProposalContent.parse(content);
    const json = canonicalJson(parsed);
    const contentHash = hash(json);
    return this.db
      .transaction(() => {
        const changed = this.db
          .prepare(
            'SELECT 1 FROM file_edit_proposals WHERE session_id=? AND request_id=? AND request_hash<>? LIMIT 1',
          )
          .get(parsed.target.sessionId, requestId, requestHash);
        if (changed)
          throw new ToolRefusal('REVISION_CONFLICT', 'file edit proposal request changed');
        const prior = this.db
          .prepare('SELECT * FROM file_edit_proposals WHERE id=?')
          .get(parsed.proposalId) as ProposalRow | undefined;
        if (prior) {
          if (
            prior.request_id !== requestId ||
            prior.request_hash !== requestHash ||
            prior.content_hash !== contentHash
          )
            throw new ToolRefusal(
              'REVISION_CONFLICT',
              'file edit proposal request or content changed',
            );
          return this.read(prior);
        }
        this.db
          .prepare(`INSERT INTO file_edit_proposals
        (id,session_id,request_id,request_hash,content_json,content_hash,created_at)
        VALUES (?,?,?,?,?,?,?)`)
          .run(
            parsed.proposalId,
            parsed.target.sessionId,
            requestId,
            requestHash,
            json,
            contentHash,
            parsed.createdAt,
          );
        return this.get(parsed.target.sessionId, parsed.proposalId);
      })
      .immediate();
  }

  list(sessionId: string): FileEditProposalSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id,session_id,created_at,content_hash,dismissed,operation_id,
          json_object(
            'proposalId',json_extract(content_json,'$.proposalId'),
            'target',json_extract(content_json,'$.target'),
            'title',json_extract(content_json,'$.title'),
            'createdAt',json_extract(content_json,'$.createdAt'),
            'files',json((SELECT json_group_array(json_object(
              'path',json_extract(file.value,'$.path'),
              'beforeHash',json_extract(file.value,'$.beforeHash'),
              'afterHash',json_extract(file.value,'$.afterHash')
            )) FROM json_each(content_json,'$.files') AS file))
          ) AS summary_json
        FROM file_edit_proposals WHERE session_id=? ORDER BY created_at DESC,id LIMIT 100`,
      )
      .all(sessionId) as (Pick<
      ProposalRow,
      'id' | 'session_id' | 'created_at' | 'content_hash' | 'dismissed' | 'operation_id'
    > & { summary_json: string })[];
    return rows.map((row) => {
      try {
        const content = SummaryContent.parse(JSON.parse(row.summary_json));
        if (
          content.proposalId !== row.id ||
          content.target.sessionId !== row.session_id ||
          content.createdAt !== row.created_at
        )
          throw new Error('proposal identity changed');
        return {
          ...content,
          hash: row.content_hash,
          dismissed: row.dismissed === 1,
          operationId: row.operation_id,
        };
      } catch {
        throw new ToolRefusal('REVISION_CONFLICT', 'file edit proposal summary is invalid');
      }
    });
  }

  claim(sessionId: string, id: string, operationId: string): FileEditProposal {
    return this.db
      .transaction(() => {
        const proposal = this.get(sessionId, id);
        if (proposal.dismissed)
          throw new ToolRefusal('REVISION_CONFLICT', 'file edit proposal is dismissed');
        if (proposal.operationId !== null && proposal.operationId !== operationId)
          throw new ToolRefusal('REVISION_CONFLICT', 'file edit proposal is already claimed');
        this.db
          .prepare('UPDATE file_edit_proposals SET operation_id=? WHERE session_id=? AND id=?')
          .run(operationId, sessionId, id);
        return { ...proposal, operationId };
      })
      .immediate();
  }

  dismiss(sessionId: string, id: string): FileEditProposal {
    return this.db
      .transaction(() => {
        const proposal = this.get(sessionId, id);
        if (proposal.operationId !== null)
          throw new ToolRefusal('REVISION_CONFLICT', 'file edit proposal is already claimed');
        this.db
          .prepare('UPDATE file_edit_proposals SET dismissed=1 WHERE session_id=? AND id=?')
          .run(sessionId, id);
        return { ...proposal, dismissed: true };
      })
      .immediate();
  }
}
