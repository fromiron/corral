import type { WorkspacesApi } from '@corral/client';
import type { CorralRepository, RuntimeTransport } from '@corral/core';
import type { DemoWorkspaceCall } from '../runtime.ts';

// The browser demo's side of the work folder (02-UX-Spec §10): the same calls Studio makes to
// the local server, answered by the demo worker's in-memory folder (demo/workspace.ts).

/** What Studio uses of the server's workspaces API; the demo offers the same. */
export type WorkspacesClient = Pick<WorkspacesApi, keyof WorkspacesApi>;

export function createDemoWorkspaces(
  call: DemoWorkspaceCall,
  repository: CorralRepository,
  transport: RuntimeTransport,
): WorkspacesClient {
  const as = <T>(promise: Promise<unknown>) => promise as Promise<T>;
  const projectOf = async (sessionId: string) => {
    const session = await repository.getSession(sessionId);
    if (!session) throw new Error('no such session');
    return session.projectId;
  };
  const noLsp = async (): Promise<never> => {
    throw new Error('Language server changes require the local backend.');
  };
  const noCheckpoints = async (): Promise<never> => {
    throw new Error('File checkpoints require the local server.');
  };
  const noDocuments = async (): Promise<never> => {
    throw new Error('File editing requires the local server.');
  };
  const noGit = async (): Promise<never> => {
    throw new Error('Git inspection requires the local server.');
  };
  const noTasks = async (): Promise<never> => {
    throw new Error('Development tasks require the local server.');
  };
  return {
    languageState: noTasks,
    inspectLanguage: noTasks,
    startLanguage: noTasks,
    syncLanguage: noTasks,
    queryLanguage: noTasks,
    stopLanguage: noTasks,
    developmentState: noTasks,
    startDevelopment: noTasks,
    finishDevelopment: noTasks,
    commands: async () => [],
    tasks: async () => ({ candidates: { packageManager: null, scripts: [] }, tasks: [] }),
    startTask: noTasks,
    taskOutput: noTasks,
    stopTask: noTasks,
    commandReport: noCheckpoints,
    commandOutput: noCheckpoints,
    stopCommand: noCheckpoints,
    previews: async () => [],
    startPreview: async () => {
      throw new Error('File previews require the local server.');
    },
    stopPreview: async () => {},
    uploadImage: async () => {
      throw new Error('Image attachments require the local server.');
    },
    imageUrl: () => '',
    branchPreview: async () => {
      throw new Error('Message branches require the local server.');
    },
    branchMessage: async () => {
      throw new Error('Message branches require the local server.');
    },
    messageBranches: async () => [],
    searchSessions: async () => {
      throw new Error('Private search requires the local server.');
    },
    rebuildSessionSearch: async () => {
      throw new Error('Private search requires the local server.');
    },
    runtimeCheckpoints: async () => [],
    resumeRuntime: async () => {
      throw new Error('Runtime recovery requires the local server.');
    },
    checkpoints: async () => ({ checkpoints: [], restores: [] }),
    captureCheckpoint: noCheckpoints,
    pinCheckpoint: noCheckpoints,
    pruneCheckpoints: noCheckpoints,
    planCheckpointRestore: noCheckpoints,
    restoreCheckpoint: noCheckpoints,
    hunks: noCheckpoints,
    planHunks: noCheckpoints,
    lspProposals: async () => [],
    lspProposal: noLsp,
    applyLspProposal: noLsp,
    dismissLspProposal: noLsp,
    listFiles: (scope, path) => as(call('listFiles', scope, path)),
    searchFiles: (scope, query, limit) => as(call('searchFiles', scope, query, limit)),
    searchContents: noDocuments,
    readFile: (scope, path) => as(call('readFile', scope, path)),
    gitStatus: noGit,
    gitDiff: noGit,
    gitChange: noGit,
    gitOperation: noGit,
    cancelGitOperation: noGit,
    readDocument: noDocuments,
    changeDocument: noDocuments,
    documentOperation: noDocuments,
    binding: (projectId) => as(call('binding', projectId)),
    bind: (projectId, path) => as(call('bind', projectId, path)),
    configure: (projectId, change) => as(call('configure', projectId, change)),
    unbind: (projectId) => as(call('unbind', projectId)),
    worktree: (sessionId) => as(call('worktree', sessionId)),
    createWorktree: async (sessionId) =>
      as(call('createWorktree', sessionId, await projectOf(sessionId))),
    removeWorktree: (sessionId) => as(call('removeWorktree', sessionId)),
    removalPlan: (sessionId) => as(call('removalPlan', sessionId)),
    changes: (sessionId, scope) => as(call('changes', sessionId, scope)),
    fileVersions: (sessionId, from, to, path) =>
      as(call('fileVersions', sessionId, from, to, path)),
    folderChanges: (projectId) => as(call('folderChanges', projectId)),
    folderFileVersions: (projectId, path) => as(call('folderFileVersions', projectId, path)),
    markReviewed: (sessionId) => as(call('markReviewed', sessionId)),
    verifications: (sessionId) => as(call('verifications', sessionId)),
    verify: () => as(call('verify')),
    cancelVerification: () => as(call('verify')),
    fileOperations: (sessionId) => as(call('fileOperations', sessionId)),
    runSnapshots: (sessionId) => as(call('runSnapshots', sessionId)),
    comments: (sessionId) => as(call('listComments', sessionId)),
    addComment: (sessionId, comment) => as(call('addComment', sessionId, comment)),
    setCommentState: (sessionId, commentId, state) =>
      as(call('setCommentState', sessionId, commentId, state)),
    feedbackText: (sessionId, commentIds) => as(call('feedbackText', sessionId, commentIds)),
    recordFeedback: (sessionId, batch) => as(call('recordFeedback', sessionId, batch)),
    decisions: (sessionId) => as(call('decisions', sessionId)),
    decide: (sessionId, decision) => as(call('decide', sessionId, decision)),
    integrationPlan: (sessionId, decisionId) => as(call('integrationPlan', sessionId, decisionId)),
    integrate: (sessionId, decisionId) => as(call('integrate', sessionId, decisionId)),
    integrations: (sessionId) => as(call('integrations', sessionId)),
    revert: (sessionId, integrationId) => as(call('revert', sessionId, integrationId)),
    /** Decisions and queued tasks come from this browser's sessions; file facts from the worker. */
    inbox: async (projectId) => {
      const sessions = (await repository.listSessions(projectId)).filter((s) => !s.archivedAt);
      const runs = await transport.listRuns();
      const items: Awaited<ReturnType<WorkspacesApi['inbox']>> = [];
      const titles = new Map(sessions.map((s) => [s.sessionId, s.title]));
      for (const run of runs)
        if (run.status === 'awaiting_user' && run.sessionId && titles.has(run.sessionId))
          items.push({
            kind: 'decision',
            sessionId: run.sessionId,
            sessionTitle: titles.get(run.sessionId) ?? '',
            runId: run.runId,
            detail: null,
          });
      for (const s of sessions)
        for (const entry of s.entries.filter((e) => e.state === 'queued'))
          items.push({
            kind: 'queued',
            sessionId: s.sessionId,
            sessionTitle: s.title,
            runId: null,
            detail: entry.text.slice(0, 120),
          });
      const facts = await as<typeof items>(
        call(
          'inboxFacts',
          sessions.map((s) => ({ sessionId: s.sessionId, title: s.title })),
        ),
      );
      return [...items, ...facts];
    },
  };
}
