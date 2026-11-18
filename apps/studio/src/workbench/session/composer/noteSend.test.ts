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

function harness(intent: 'next' | 'queue' = 'next') {
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
    repository: {
      getSession: vi.fn(async () => session),
      addSessionEntry: vi.fn(async () => ({ ok: true, session })),
    },
    workspaces: { uploadImage },
  };
  const advisorConfirmed = vi.fn(async () => true);
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
      how: () => ({ intent, delivery: null }),
      unavailable: () => false,
      steerTarget: () => '',
      permissionMode: () => undefined,
      advisorConfirmed,
      refusalText: (kind: string) => `refusal:${kind}`,
      advisorUnconfirmed: 'advisor',
      imageFailed: 'image failed',
      imageLimit: 'image limit',
    }) as unknown as NoteSendDeps;
  return {
    sender: createNoteSender(deps),
    advisorConfirmed,
    repository: services.repository,
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
    const request = { noteId: 'note_1', material, via: 'send' as const, again: false as const };
    expect(await h.sender.sendNote(request)).toEqual({ kind: 'unconfirmed' });
    h.choose('model-b');
    h.advisorConfirmed.mockResolvedValue(false);
    expect(await h.sender.sendNote({ noteId: request.noteId, again: true })).toEqual({
      kind: 'accepted',
    });
    expect(h.started).toHaveLength(2);
    expect(h.started[1]?.commandId).toBe(h.started[0]?.commandId);
    expect(h.started[1]?.choice).toEqual(h.started[0]?.choice);
  });

  it('ends recovery on a confirmed refusal and assigns a fresh ID only to the edited note', async () => {
    const h = harness();
    h.answers.push(lost(), async () => ({
      runId: null,
      receipt: { error: { code: 'LIMIT_REACHED', message: 'Limit' } },
    }));
    const request = { noteId: 'note', material, via: 'button', again: false } as const;
    expect((await h.sender.sendNote(request)).kind).toBe('unconfirmed');
    expect((await h.sender.sendNote({ noteId: request.noteId, again: true })).kind).toBe('refused');
    expect(
      (await h.sender.sendNote({ ...request, material: { ...material, note: 'Edited' } })).kind,
    ).toBe('accepted');
    expect(h.started[1]?.commandId).toBe(h.started[0]?.commandId);
    expect(h.started[2]?.commandId).not.toBe(h.started[0]?.commandId);
  });

  it('recovers a queued note whose lost receipt arrives after the entry has started', async () => {
    const h = harness('queue');
    h.repository.addSessionEntry.mockRejectedValueOnce(new TypeError('response lost'));
    const first = await h.sender.sendNote({
      noteId: 'queue-1',
      material,
      via: 'queue',
      again: false,
    });
    expect(first.kind).toBe('unconfirmed');
    const calls = h.repository.addSessionEntry.mock.calls as unknown as [
      string,
      { commandId: string },
    ][];
    const commandId = calls[0]?.[1].commandId;
    expect(commandId).toEqual(expect.any(String));
    h.repository.getSession.mockResolvedValueOnce({
      entries: [{ commandId, intent: 'queue', state: 'started', runId: 'already-started' }],
    } as never);
    expect(await h.sender.sendNote({ noteId: 'queue-1', again: true })).toEqual({
      kind: 'accepted',
    });
    expect(h.repository.addSessionEntry).toHaveBeenCalledTimes(1);
  });

  it('"다시 보내기" with no command kept for the note sends nothing, never under a new command (반례)', async () => {
    const h = harness();
    const request = { noteId: 'note_1', material, via: 'send' as const, again: true as const };
    expect(await h.sender.sendNote(request)).toEqual({ kind: 'unconfirmed' });
    // A closed note forgets its command and a late retry stays unconfirmed.
    h.answers.push(lost());
    await h.sender.sendNote({ ...request, noteId: 'note_2', again: false });
    h.sender.forgetNote('note_2');
    expect(await h.sender.sendNote({ ...request, noteId: 'note_2' })).toEqual({
      kind: 'unconfirmed',
    });
    expect(h.started).toHaveLength(1);
    expect(h.uploadImage).not.toHaveBeenCalled();
  });
});
