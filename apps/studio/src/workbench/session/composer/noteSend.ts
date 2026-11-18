// A browser annotation sent at once (features/browser-annotate.md 바로 보내기, 계약: 보내기):
// the composer's own send path, with the note's own command ID beside the composer's slot. The
// draft (its text, chips, fixed target and its own unconfirmed command) is never read or
// changed; the send settings are read as the composer would send now. A lost answer keeps the
// note's command, its frozen request and the settings it went with while the note is open, so
// "다시 보내기" sends the same request under the same ID and uploads nothing again; an accepted or
// refused send ends it. Without a kept command, "다시 보내기" sends nothing: never a new ID.
import { ApiError } from '@corral/client';
import {
  type AnnotationMaterial,
  ImageAttachment,
  type TextAttachmentProvenance,
  type WorkspaceTarget,
} from '@corral/contracts';
import { useRef, useState } from 'react';
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

interface NewNoteRequest {
  noteId: string;
  material: AnnotationMaterial;
  /** The key that sent it, or the note's button. */
  via: 'send' | 'interrupt' | 'queue' | 'button';
  again: false;
}

/** Recovery only identifies the command the composer already holds. */
export type NoteSendRequest = NewNoteRequest | { noteId: string; again: true };

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
  /** The sentence for a conversation whose input images are at the server's limit. */
  imageLimit: string;
}

type SendSettings = ReturnType<NoteSendDeps['sendDeps']>;

interface KeptNote {
  slot: CommandSlot;
  input: SendInput;
  settings: SendSettings;
}

/** A command slot of the note's own: never the composer's per-conversation one. */
function noteSlot(sessionId: string): CommandSlot {
  const commandId = newCommandId();
  const kept = new Map<string, PendingCommand>();
  return {
    sessionId,
    pending: { current: null },
    store: kept,
    newId: () => commandId,
    sending: { current: false },
  };
}

/**
 * The screenshot in the conversation's image store, or the sentence for why the server did not
 * take it: the session's image limit has its own, any other refusal the composer's.
 */
export async function uploadScreenshot(
  now: Pick<NoteSendDeps, 'services' | 'sessionId' | 'imageFailed' | 'imageLimit'>,
  shot: NonNullable<AnnotationMaterial['screenshot']>,
  name: string,
  signal?: AbortSignal,
): Promise<ImageAttachment | { refused: string }> {
  if (!now.services.workspaces) return { refused: now.imageFailed };
  try {
    const image = ImageAttachment.parse(
      await now.services.workspaces.uploadImage(
        now.sessionId,
        name,
        screenshotBlob(shot.data),
        signal,
      ),
    );
    return image.width === shot.width && image.height === shot.height
      ? image
      : { refused: now.imageFailed };
  } catch (error) {
    const full = error instanceof ApiError && error.code === 'LIMIT_REACHED';
    return { refused: full ? now.imageLimit : now.imageFailed };
  }
}

/** A preview note's provenance, against the conversation's Paddock and the lease now. */
export async function previewProvenance(
  now: Pick<NoteSendDeps, 'services' | 'sessionId' | 'projectId'>,
  material: AnnotationMaterial,
  screenshotHash: string | undefined,
): Promise<TextAttachmentProvenance | null> {
  const { services, sessionId, projectId } = now;
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
}

/** The note's sender, reading the composer's deps as they are at each call. */
export function createNoteSender(read: () => NoteSendDeps) {
  /** Notes whose answer was lost, by note: their command and request, while the note is open. */
  const kept = new Map<string, KeptNote>();
  let keptFor = read().sessionId;
  const keptNow = () => {
    const sessionId = read().sessionId;
    if (keptFor !== sessionId) {
      keptFor = sessionId;
      kept.clear();
    }
    return kept;
  };

  /** The note's request: its text, its attachment and, for a new or next request, its image. */
  const prepare = async (request: NewNoteRequest): Promise<SendInput | AnnotateOutcome> => {
    const now = read();
    const { material } = request;
    const body = material.note.trim();
    const role: SendKeyRole = request.via === 'button' ? 'send' : request.via;
    const how = now.how(role);
    if (!body || now.unavailable(how.intent, role === 'queue'))
      return { kind: 'refused', reason: now.refusalText('other') };
    // An image rides a new or a next request only: a join or an interrupt takes no screenshot.
    // A screenshot the server does not take sends nothing: it is left out only when the person
    // turns it off.
    const forNew = how.intent === 'next' || how.intent === 'queue';
    let image: ImageAttachment | null = null;
    if (forNew && material.screenshot) {
      const uploaded = await uploadScreenshot(now, material.screenshot, 'annotation.png');
      if ('refused' in uploaded) return { kind: 'refused', reason: uploaded.refused };
      image = uploaded;
    }
    const provenance =
      pageProvenance(material, image?.sha256) ??
      (await previewProvenance(now, material, image?.sha256));
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
    const now = read();
    const sessionId = now.sessionId;
    let note = keptNow().get(request.noteId);
    if (!note) {
      if (request.again) return { kind: 'unconfirmed' };
      if (!(await now.advisorConfirmed()))
        return { kind: 'refused', reason: now.advisorUnconfirmed };
      const prepared = await prepare(request);
      if ('kind' in prepared) return prepared;
      const slot = noteSlot(sessionId);
      if (prepared.intent === 'queue') prepared.queueCommandId = slot.newId();
      note = { slot, input: prepared, settings: now.sendDeps() };
    } else if (note.input.queueCommandId) {
      const commandId = note.input.queueCommandId;
      // The saved entry may already have left the queue and acquired a run ID.
      // Its presence is the receipt for this enqueue, whichever state it has now.
      try {
        const session = await note.settings.services.repository.getSession(sessionId);
        if (session?.entries.some((entry) => entry.commandId === commandId)) {
          keptNow().delete(request.noteId);
          return { kind: 'accepted' };
        }
      } catch {
        return { kind: 'unconfirmed' };
      }
    }
    let refusal: Refusal | null = null;
    let error: string | null = null;
    const autoRequest: { current: AutoRequest | null } = { current: null };
    const outcome = await sendRequest(
      {
        // The settings the note first went with: a changed team or model is not a new command.
        ...note.settings,
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
      keptNow().delete(request.noteId);
      return { kind: 'accepted' };
    }
    if (said?.network) {
      if (read().sessionId === sessionId) keptNow().set(request.noteId, note);
      return { kind: 'unconfirmed' };
    }
    keptNow().delete(request.noteId);
    if (said) return { kind: 'refused', reason: now.refusalText(refusalKind(said)) };
    return { kind: 'refused', reason: error ?? now.refusalText('other') };
  };

  return {
    sendNote,
    /** The note closed: its way to send again under the same ID goes with it. */
    forgetNote: (noteId: string) => void keptNow().delete(noteId),
  };
}

export function useNoteSender(deps: NoteSendDeps) {
  const latest = useRef(deps);
  latest.current = deps;
  const [sender] = useState(() => createNoteSender(() => latest.current));
  return sender;
}
