// A browser annotation sent at once (features/browser-annotate.md 바로 보내기, 계약: 보내기):
// the composer's own send path, with the note's own command ID beside the composer's slot. The
// draft (its text, chips, fixed target and its own unconfirmed command) is never read or
// changed; the send settings are read as the composer would send now. A lost answer keeps the
// note's command and its frozen request while the note is open, so "다시 보내기" sends the same
// request under the same ID and uploads nothing again; an accepted or refused send ends it.
import {
  type AnnotationMaterial,
  ImageAttachment,
  type TextAttachmentProvenance,
  type WorkspaceTarget,
} from '@corral/contracts';
import { useRef } from 'react';
import type { AnnotateOutcome } from '../../../annotate/protocol.ts';
import type { StudioServices } from '../../../services.tsx';
import { noteAttachment, pageProvenance, screenshotBlob } from '../../browser/noteAttachment.ts';
import type { SendKeyRole } from '../../composerIntent.ts';
import { refusalKind } from '../../refusal.ts';
import {
  type AutoRequest,
  type CommandSlot,
  newCommandId,
  type PendingCommand,
  type Refusal,
  type SendDeps,
  type SendInput,
  sendRequest,
} from './send.ts';

export interface NoteSendRequest {
  noteId: string;
  material: AnnotationMaterial;
  /** The key that sent it, or the note's button. */
  via: 'send' | 'interrupt' | 'queue' | 'button';
  /** "다시 보내기": the note's kept request again. */
  again: boolean;
}

export interface NoteSendDeps {
  services: StudioServices;
  sessionId: string;
  projectId: string;
  /** The composer's send deps now: settings, team, run; its slot and draft are not used. */
  sendDeps: () => Omit<
    SendDeps,
    | 'commands'
    | 'autoRequest'
    | 'onChoosingAuto'
    | 'setBusy'
    | 'setError'
    | 'setRefusal'
    | 'clearDraft'
  >;
  /** What the send key (or the note's key) means now. */
  how: (role: SendKeyRole) => { intent: SendInput['intent']; delivery: SendInput['delivery'] };
  /** Whether that intent can be sent now. */
  unavailable: (intent: SendInput['intent'], explicitQueue: boolean) => boolean;
  steerTarget: () => string;
  permissionMode: () => SendInput['permissionMode'];
  /** The composer's Outrider re-check before a send; false sends nothing. */
  advisorConfirmed: () => Promise<boolean>;
  /** Sentences: a refusal's kind, and the Outrider's unconfirmed send. */
  refusalText: (kind: ReturnType<typeof refusalKind>) => string;
  advisorUnconfirmed: string;
  /** The composer's sentence for an image the server did not take. */
  imageFailed: string;
}

interface KeptNote {
  slot: CommandSlot;
  input: SendInput;
}

/** A command slot of the note's own: never the composer's per-conversation one. */
function noteSlot(sessionId: string): CommandSlot {
  const kept = new Map<string, PendingCommand>();
  return {
    sessionId,
    pending: { current: null },
    store: kept,
    newId: newCommandId,
    sending: { current: false },
  };
}

export function useNoteSender(deps: NoteSendDeps) {
  const latest = useRef(deps);
  latest.current = deps;
  /** Notes whose answer was lost, by note: their command and request, while the note is open. */
  const kept = useRef(new Map<string, KeptNote>());
  const keptFor = useRef(deps.sessionId);
  if (keptFor.current !== deps.sessionId) {
    keptFor.current = deps.sessionId;
    kept.current.clear();
  }

  /** A preview note's provenance, against the conversation's Paddock and the lease now. */
  const previewProvenance = async (
    material: AnnotationMaterial,
    screenshotHash: string | undefined,
  ): Promise<TextAttachmentProvenance | null> => {
    const { services, sessionId, projectId } = latest.current;
    const { page } = material;
    const client = services.workspaces;
    if (page.kind !== 'preview' || !client || !services.workspaceId) return null;
    const [copy, leases] = await Promise.all([
      client.worktree(sessionId),
      client.previews(sessionId),
    ]);
    const lease = leases.find((item) => item.leaseId === page.leaseId);
    if (!copy || copy.missing || copy.removedAt || !lease || lease.state !== 'ready') return null;
    const target: WorkspaceTarget = {
      hostId: services.workspaceId,
      projectId,
      sessionId,
      bindingId: copy.bindingId,
      copyGeneration: copy.copyGeneration,
    };
    return {
      kind: 'preview',
      target,
      leaseId: lease.leaseId,
      ...(lease.operationId ? { operationId: lease.operationId } : {}),
      url: `${page.origin}${page.path}`,
      capturedAt: material.pickedAt,
      pageRevision: material.generation,
      sourceRevision: null,
      ...(screenshotHash ? { screenshotHash } : {}),
    };
  };

  /** The note's request: its text, its attachment and, for a new or next request, its image. */
  const prepare = async (request: NoteSendRequest): Promise<SendInput | AnnotateOutcome> => {
    const now = latest.current;
    const { material } = request;
    const body = material.note.trim();
    const role: SendKeyRole = request.via === 'button' ? 'send' : request.via;
    const how = now.how(role);
    if (!body || now.unavailable(how.intent, role === 'queue'))
      return { kind: 'refused', reason: now.refusalText('other') };
    // An image rides a new or a next request only: a join or an interrupt takes no screenshot.
    const forNew = how.intent === 'next' || how.intent === 'queue';
    let image: ImageAttachment | null = null;
    const shot = material.screenshot;
    if (forNew && shot) {
      if (!now.services.workspaces) return { kind: 'refused', reason: now.refusalText('other') };
      // A screenshot the server does not take sends nothing: it is left out only when the
      // person turns it off. Its own sentence is not shown; the composer's localized one is.
      try {
        image = ImageAttachment.parse(
          await now.services.workspaces.uploadImage(
            now.sessionId,
            'annotation.png',
            screenshotBlob(shot.data),
          ),
        );
      } catch {
        return { kind: 'refused', reason: now.imageFailed };
      }
      if (image.width !== shot.width || image.height !== shot.height)
        return { kind: 'refused', reason: now.refusalText('other') };
    }
    const provenance =
      pageProvenance(material, image?.sha256) ?? (await previewProvenance(material, image?.sha256));
    if (!provenance) return { kind: 'refused', reason: now.refusalText('other') };
    let attachment: ReturnType<typeof noteAttachment>;
    try {
      attachment = noteAttachment(material, 'annotation.json', provenance);
    } catch {
      return { kind: 'refused', reason: now.refusalText('limit') };
    }
    return {
      body,
      intent: how.intent,
      delivery: how.delivery,
      steerTarget: now.steerTarget(),
      references: [],
      attachments: [attachment],
      images: image ? [image] : [],
      permissionMode: now.permissionMode(),
      revision: 0,
    };
  };

  const sendNote = async (request: NoteSendRequest): Promise<AnnotateOutcome> => {
    const now = latest.current;
    const sessionId = now.sessionId;
    if (!(await now.advisorConfirmed())) return { kind: 'refused', reason: now.advisorUnconfirmed };
    let note = request.again ? kept.current.get(request.noteId) : undefined;
    if (!note) {
      const prepared = await prepare(request);
      if ('kind' in prepared) return prepared;
      note = { slot: noteSlot(sessionId), input: prepared };
    }
    let refusal: Refusal | null = null;
    let error: string | null = null;
    const autoRequest: { current: AutoRequest | null } = { current: null };
    const outcome = await sendRequest(
      {
        ...now.sendDeps(),
        commands: note.slot,
        autoRequest,
        onChoosingAuto: () => {},
        // The composer stays as it is: its busy state, its error and its refusal are its own.
        setBusy: () => {},
        setError: (message) => {
          error = message;
        },
        setRefusal: (next) => {
          refusal = next;
        },
        clearDraft: () => {},
      },
      note.input,
    );
    const said = refusal as Refusal | null;
    if (outcome.sent) {
      kept.current.delete(request.noteId);
      return { kind: 'accepted' };
    }
    if (said?.network) {
      if (keptFor.current === sessionId) kept.current.set(request.noteId, note);
      return { kind: 'unconfirmed' };
    }
    kept.current.delete(request.noteId);
    if (said) return { kind: 'refused', reason: now.refusalText(refusalKind(said)) };
    return { kind: 'refused', reason: error ?? now.refusalText('other') };
  };

  return {
    sendNote,
    /** The note closed: its way to send again under the same ID goes with it. */
    forgetNote: (noteId: string) => void kept.current.delete(noteId),
  };
}
