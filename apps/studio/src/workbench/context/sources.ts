import type { FileSideView } from '@corral/client';
import {
  canonicalJson,
  type TextAttachment,
  type TextAttachmentProvenance,
  type WorkspaceTarget,
} from '@corral/contracts';
import { createTextAttachment } from '@corral/core';
import type { StudioServices } from '../../services.tsx';
import { documentKey, documentStore } from '../documents/store.ts';
import { terminalStore } from '../terminals/store.ts';
import type { ContextSourceStatus } from './ContextAttachments.tsx';
import { captureDocumentAttachment } from './documents.ts';

type CodeSource = Extract<TextAttachmentProvenance, { kind: 'code' }>;
export interface SourceRead extends ContextSourceStatus {
  current?: TextAttachment;
}
const unavailable = (): SourceRead => ({ state: 'unavailable' });
type Applies = NonNullable<ContextSourceStatus['applies']>;
const sameSide = (left: FileSideView, right: FileSideView) =>
  canonicalJson(left) === canonicalJson(right);

/** Whether the file a frozen hunk changed is still as its `to` tree has it in the copy now. */
async function hunkApplies(
  client: NonNullable<StudioServices['workspaces']>,
  source: Extract<TextAttachmentProvenance, { kind: 'hunk' }>,
): Promise<Applies> {
  try {
    const now = await client.changes(source.sessionId, { kind: 'session' });
    if (!now.to) return 'unknown';
    if (now.to === source.to) return 'yes';
    const sides = await client.fileVersions(source.sessionId, source.to, now.to, source.path);
    return sameSide(sides.before, sides.after) ? 'yes' : 'files_changed';
  } catch {
    return 'unknown';
  }
}
const sameTarget = (left: WorkspaceTarget, right: WorkspaceTarget) =>
  canonicalJson(left) === canonicalJson(right);
const ownsSource = (services: StudioServices, source: TextAttachmentProvenance) =>
  services.mode === 'server' &&
  services.workspaceId === ('target' in source ? source.target.hostId : source.hostId);

async function readCode(
  services: StudioServices,
  item: TextAttachment,
  source: CodeSource,
): Promise<SourceRead> {
  const client = services.workspaces;
  if (!client) return unavailable();
  const file = await client.readDocument(source.target.sessionId, source.path);
  if (!sameTarget(file.target, source.target) || file.path !== source.path) return unavailable();
  const owner = documentStore(client);
  const key = documentKey(source.target, source.path);
  const entry = owner.getState().documents[key];
  const local = entry && (entry.dirty || entry.saving || entry.pendingSave) ? entry : null;
  if (!local && file.content.kind !== 'text') return unavailable();
  const snapshot = local ?? {
    target: file.target,
    path: file.path,
    text: file.content.kind === 'text' ? file.content.text : '',
    baseHash: file.version?.sha256 ?? null,
    editVersion: entry?.editVersion ?? 0,
    dirty: false,
    saving: false,
    pendingSave: null,
  };
  const text = snapshot.text;
  const current = await captureDocumentAttachment(snapshot, source.range);
  const changedWhileReading = local && owner.getState().documents[key]?.text !== text;
  return {
    state:
      !changedWhileReading &&
      current.provenance?.kind === 'code' &&
      current.provenance.bufferHash === source.bufferHash &&
      current.sha256 === item.sha256
        ? 'current'
        : 'stale',
    current,
  };
}

/** Inspection only reads the original source and never edits the frozen attachment or its owners. */
export async function readAttachmentSource(
  services: StudioServices,
  item: TextAttachment,
): Promise<SourceRead> {
  const source = item.provenance;
  if (!source || !ownsSource(services, source)) return unavailable();
  try {
    if (source.kind === 'code') return await readCode(services, item, source);
    if (source.kind === 'terminal')
      return services.terminals
        ? { state: terminalStore(services.terminals).inspectSelection(source) }
        : unavailable();
    const client = services.workspaces;
    if (!client) return unavailable();
    if (source.kind === 'hunk') {
      const hunks = await client.hunks(source.sessionId, {
        from: source.from,
        to: source.to,
        path: source.path,
      });
      if (hunks.from !== source.from || hunks.to !== source.to || hunks.path !== source.path)
        return unavailable();
      const selected = source.hunkIds.map((id) => hunks.hunks.find((hunk) => hunk.id === id));
      if (selected.some((hunk) => !hunk)) return unavailable();
      const current = createTextAttachment(
        item.name,
        item.mime,
        selected.map((hunk) => hunk?.patch ?? '').join('\n'),
        { ...source, patchHash: hunks.patchHash },
      );
      return {
        state:
          current.sha256 === item.sha256 && hunks.patchHash === source.patchHash
            ? 'current'
            : 'stale',
        applies: await hunkApplies(client, source),
        current,
      };
    }
    const result = (await client.verifications(source.sessionId)).find(
      (entry) => entry.verificationId === source.verificationId,
    );
    if (
      !result ||
      result.tree !== source.tree ||
      result.commandId !== source.commandId ||
      result.state === 'running'
    )
      return unavailable();
    const report = result.report;
    if (
      report &&
      (report.sessionId !== source.sessionId ||
        report.verificationId !== source.verificationId ||
        report.state === 'queued' ||
        report.state === 'running')
    )
      return unavailable();
    const provenance: Extract<TextAttachmentProvenance, { kind: 'check' }> = {
      kind: 'check',
      hostId: source.hostId,
      projectId: source.projectId,
      sessionId: source.sessionId,
      verificationId: result.verificationId,
      commandId: result.commandId,
      tree: result.tree,
      ...(report
        ? {
            fingerprint: report.fingerprint,
            configRevision: report.configRevision,
            outputHash: report.output.hash,
            outputTruncated: report.output.truncated,
          }
        : {}),
    };
    // A whole displayed output capture never substitutes the report's unredacted text.
    if (source.range) return unavailable();
    const current = createTextAttachment(item.name, item.mime, result.output, provenance);
    const changed = (
      ['fingerprint', 'configRevision', 'outputHash', 'outputTruncated'] as const
    ).some((key) => source[key] !== undefined && source[key] !== provenance[key]);
    return {
      state: !changed && current.sha256 === item.sha256 ? 'current' : 'stale',
      applies: result.stale ? 'files_changed' : result.configChanged ? 'config_changed' : 'yes',
      current,
    };
  } catch {
    return unavailable();
  }
}

/** Called only for an explicit open/replace action; never retarget a capture to another copy/process. */
export async function recaptureAttachmentSource(
  services: StudioServices,
  item: TextAttachment,
): Promise<TextAttachment | null> {
  const source = item.provenance;
  if (!source || !ownsSource(services, source)) return null;
  if (source.kind === 'code') {
    if (!services.workspaces) return null;
    const file = await services.workspaces.readDocument(source.target.sessionId, source.path);
    if (!sameTarget(file.target, source.target) || file.path !== source.path) return null;
    const owner = documentStore(services.workspaces);
    const key = await owner.open(source.target.sessionId, source.path);
    if (key !== documentKey(source.target, source.path)) return null;
    const entry = owner.getState().documents[key];
    return entry ? captureDocumentAttachment(entry, source.range) : null;
  }
  if (source.kind === 'terminal') {
    if (!services.terminals) return null;
    const selection = await terminalStore(services.terminals).captureSelection(source.terminalId);
    if (
      !selection ||
      !sameTarget(selection.provenance.target, source.target) ||
      selection.provenance.generation !== source.generation
    )
      return null;
    return createTextAttachment(item.name, item.mime, selection.text, selection.provenance);
  }
  return (await readAttachmentSource(services, item)).current ?? null;
}
