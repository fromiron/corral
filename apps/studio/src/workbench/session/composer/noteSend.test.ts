import type { AnnotationMaterial } from '@corral/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createNoteSender, type NoteSendDeps } from './noteSend.ts';

// A note sent at once keeps its own command (features/browser-annotate.md 계약: 보내기): a lost
// answer is sent again under the same ID, never a new one.

const material: AnnotationMaterial = {
  page: { kind: 'page', origin: 'https://a.example', path: '/' },
  pickedAt: '2026-11-18T12:00:00.000Z',
  generation: 2,
  pickId: 'pick_1',
  note: 'Make the button larger',
  element: {
    tag: 'button',
    label: 'button.pay 120×32',
    role: null,
    selector: 'body > button:nth-of-type(1)',
    text: 'Pay',
    bounds: { x: 10, y: 20, width: 120, height: 32 },
    styles: {},
  },
  styles: [],
  console: null,
  screenshot: null,
};

function harness() {
  const started: { commandId: string; choice?: unknown }[] = [];
  const answers: (() => Promise<unknown>)[] = [];
  const startAuto = vi.fn(async (request: { commandId: string; choice?: unknown }) => {
    started.push(structuredClone(request));
    const next = answers.shift();
    if (next) return next();
    return { runId: `run_${started.length}`, receipt: { commandId: request.commandId } };
  });
  const uploadImage = vi.fn();
  let choice = { modelProfile: 'model-a' };
  const session = {
    sessionId: 'session',
    projectId: 'project',
    corralId: null,
    auto: null,
    title: 'Session',
    objective: '',
    pinned: false,
    revision: 1,
    createdAt: '2026-10-21T00:00:00Z',
    updatedAt: '2026-10-21T00:00:00Z',
    archivedAt: null,
    autoStart: true,
    entries: [],
  };
  const services = {
    mode: 'server',
    live: true,
    startAuto,
    transport: { sendCommand: vi.fn() },
    repository: { addSessionEntry: vi.fn(async () => ({ ok: true, session })) },
    workspaces: { uploadImage },
  };
  const deps = (): NoteSendDeps =>
    ({
      services,
      sessionId: 'session',
      projectId: 'project',
      sendDeps: () => ({
        services,
        session,
        choice,
        teamMode: 'none',
        missingTeam: false,
        messages: { selectedTeamMissing: 'team missing', failed: (m: string) => m },
        onTitleChange: () => {},
        team: null,
        ownActive: null,
        runMode: 'live',
        invalidate: async () => {},
        onChange: () => {},
      }),
      how: () => ({ intent: 'next', delivery: null }),
      unavailable: () => false,
      steerTarget: () => '',
      permissionMode: () => undefined,
      advisorConfirmed: async () => true,
      refusalText: (kind: string) => `refusal:${kind}`,
      advisorUnconfirmed: 'advisor',
      imageFailed: 'image failed',
      imageLimit: 'image limit',
      lostNote: 'lost note',
    }) as unknown as NoteSendDeps;
  return {
    sender: createNoteSender(deps),
    started,
    answers,
    uploadImage,
    choose(next: string) {
      choice = { modelProfile: next };
    },
  };
}
const lost = () => async () => {
  throw new TypeError('Failed to fetch');
};

describe('a note sent at once', () => {
  it('"다시 보내기" after the settings changed goes under the same command, with the settings it first went with', async () => {
    const h = harness();
    h.answers.push(lost());
    const request = { noteId: 'note_1', material, via: 'send' as const, again: false };
    expect(await h.sender.sendNote(request)).toEqual({ kind: 'unconfirmed' });
    h.choose('model-b');
    expect(await h.sender.sendNote({ ...request, again: true })).toEqual({ kind: 'accepted' });
    expect(h.started).toHaveLength(2);
    expect(h.started[1]?.commandId).toBe(h.started[0]?.commandId);
    expect(h.started[1]?.choice).toEqual(h.started[0]?.choice);
  });

  it('"다시 보내기" with no command kept for the note sends nothing, never under a new command (반례)', async () => {
    const h = harness();
    const request = { noteId: 'note_1', material, via: 'send' as const, again: true };
    expect(await h.sender.sendNote(request)).toEqual({ kind: 'refused', reason: 'lost note' });
    // A closed note forgets its command: sent again, it is the same refusal.
    h.answers.push(lost());
    await h.sender.sendNote({ ...request, noteId: 'note_2', again: false });
    h.sender.forgetNote('note_2');
    expect(await h.sender.sendNote({ ...request, noteId: 'note_2' })).toEqual({
      kind: 'refused',
      reason: 'lost note',
    });
    expect(h.started).toHaveLength(1);
    expect(h.uploadImage).not.toHaveBeenCalled();
  });
});
