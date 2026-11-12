import type { AutoModelChoice, StartRunRequest } from '@corral/contracts';
import { describe, expect, it } from 'vitest';
import { conversationDefinition, createAutoStarter } from '../src/index.ts';

// A trusted linked folder is the session's direct workspace. A working copy stays the
// isolated mode. The lead is told which one it has, or why it has no file tools, without
// an absolute path.

const CHOICE: AutoModelChoice = { modelProfile: 'model-a' };
const base = {
  id: 'conversation_direct',
  brief: 'Read the notes',
  choice: CHOICE,
  commandTools: true,
};

function lead(input: Parameters<typeof conversationDefinition>[0]) {
  const role = conversationDefinition(input).roles.find((item) => item.name === 'Assistant');
  if (!role) throw new Error('missing lead');
  return role;
}

describe('direct folder for the conversation lead', () => {
  it('gives list, read and commands, and says the project source folder', () => {
    const role = lead({
      ...base,
      fileTools: true,
      workspace: { mode: 'direct' },
    });
    expect(role.allowedWorkTools).toEqual(
      expect.arrayContaining(['list_files', 'read_file', 'run_command']),
    );
    for (const tool of ['write_file', 'delete_file', 'move_file', 'preview_file'] as const)
      expect(role.allowedWorkTools).not.toContain(tool);
    expect(role.prompt).toContain('work directly in the project source folder');
    expect(role.prompt).not.toContain('The session has a working copy');
    expect(role.prompt).not.toMatch(/\/(?:home|tmp|Users)\//);
  });

  it('a working copy still writes in the copy, not the project source folder', () => {
    const role = lead({
      ...base,
      fileTools: true,
      workspace: { mode: 'copy' },
    });
    expect(role.allowedWorkTools).toEqual(
      expect.arrayContaining(['list_files', 'read_file', 'write_file', 'run_command']),
    );
    expect(role.prompt).toContain("this session's working copy");
    expect(role.prompt).toContain('not in the project source folder');
  });

  it('keeps the historical file-tool prompt when no workspace is named', () => {
    const role = lead({ ...base, fileTools: true });
    expect(role.allowedWorkTools).toContain('write_file');
    expect(role.prompt).toContain('The session has a working copy');
    expect(role.prompt).not.toContain('project source folder');
  });

  it('an unlinked folder gives no file tools and tells the person to link one', () => {
    const role = lead({
      ...base,
      fileTools: true,
      workspace: { mode: 'none', reason: 'unlinked' },
    });
    for (const tool of ['list_files', 'read_file', 'write_file', 'run_command'] as const)
      expect(role.allowedWorkTools).not.toContain(tool);
    expect(role.prompt).toContain('no linked folder');
    expect(role.prompt).toContain('links a folder');
    expect(role.prompt).not.toMatch(/\/(?:home|tmp|Users)\//);
  });

  it('an untrusted folder gives no file tools and tells the person to trust it', () => {
    const role = lead({
      ...base,
      fileTools: false,
      workspace: { mode: 'none', reason: 'untrusted' },
    });
    expect(role.allowedWorkTools).not.toContain('read_file');
    expect(role.prompt).toContain('not trusted');
    expect(role.prompt).toContain('trusts the folder');
  });

  it('a missing linked folder gives no file tools and tells the person to check the link', () => {
    const role = lead({
      ...base,
      fileTools: false,
      workspace: { mode: 'none', reason: 'missing' },
    });
    expect(role.allowedWorkTools).not.toContain('read_file');
    expect(role.prompt).toContain('unavailable');
    expect(role.prompt).toContain('folder link');
  });

  it('review-only direct work does not gain a command', () => {
    const role = lead({
      ...base,
      fileTools: true,
      taskScope: 'review_only',
      workspace: { mode: 'direct' },
    });
    expect(role.allowedWorkTools).toContain('read_file');
    expect(role.allowedWorkTools).not.toContain('run_command');
    expect(role.allowedWorkTools).not.toContain('write_file');
  });

  it('the next run start reads the folder mode and does not keep tools the folder lost', async () => {
    const captured: StartRunRequest[] = [];
    const starter = createAutoStarter({
      startRun: (request) => {
        captured.push(request);
        return {
          runId: 'run_1',
          receipt: {
            commandId: request.commandId,
            runId: 'run_1',
            status: 'applied',
            acceptedSeq: 1,
            target: 'run:run_1',
            requestedBoundary: 'immediate',
            relatedEventIds: [],
          },
        };
      },
      fileTools: async () => ({ mode: 'none', reason: 'untrusted' }),
      sessionHarness: () => ({ profileId: 'session-default', revision: 1 }),
    });
    await starter.start(
      {
        commandId: 'cmd_direct',
        sessionId: 'session_1',
        brief: 'Read the notes',
        mode: 'live',
        choice: CHOICE,
        team: 'none',
      },
      { fileTools: true },
    );
    const role = captured[0]?.definition.roles.find((item) => item.name === 'Assistant');
    expect(role?.allowedWorkTools).not.toContain('read_file');
    expect(role?.allowedWorkTools).not.toContain('run_command');
    expect(role?.prompt).toContain('not trusted');
  });
});
