import {
  ApplyWorkspaceEditRequest,
  createProtocolConnection,
  DefinitionRequest,
  DidOpenTextDocumentNotification,
  DocumentDiagnosticRequest,
  ExitNotification,
  InitializedNotification,
  InitializeRequest,
  PublishDiagnosticsNotification,
  ReferencesRequest,
  ShutdownRequest,
} from 'vscode-languageserver-protocol/node';

const mode = process.argv[2] ?? 'normal';
const connection = createProtocolConnection(process.stdin, process.stdout);
let document;
const diagnostic = {
  range: { start: { line: 0, character: 2 }, end: { line: 0, character: 4 } },
  severity: 2,
  message: 'Fixture diagnostic',
};
connection.onRequest(InitializeRequest.type, () => {
  if (mode === 'initialize_hang') return new Promise(() => {});
  if (mode === 'initialize_error') throw new Error('language server /private/example sk-privatefixture12345 refused initialization');
  return {
    capabilities: {
      positionEncoding: mode === 'utf8' ? 'utf-8' : 'utf-16',
      definitionProvider: true,
      referencesProvider: true,
      textDocumentSync: 1,
      ...(mode === 'pull'
        ? { diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } }
        : {}),
    },
  };
});
connection.onNotification(InitializedNotification.type, () => {});
connection.onNotification(DidOpenTextDocumentNotification.type, async (params) => {
  document = params.textDocument;
  process.stderr.write('READY\n');
  if (mode === 'no_diagnostics' || mode === 'query_hang') return;
  if (mode === 'oversized') {
    process.stdout.write('x'.repeat(9 * 1024 * 1024));
    return;
  }
  if (mode === 'apply_edit') {
    const reply = await connection.sendRequest(ApplyWorkspaceEditRequest.type, {
      edit: { changes: { [document.uri]: [{ range: diagnostic.range, newText: 'changed' }] } },
    });
    diagnostic.message = `applied=${reply.applied}`;
  }
  await connection.sendNotification(PublishDiagnosticsNotification.type, {
    uri: document.uri,
    version: mode === 'wrong_version' ? 2 : document.version,
    diagnostics: [diagnostic],
  });
});
connection.onRequest(DefinitionRequest.type, (params) => {
  if (mode === 'query_hang') return new Promise(() => {});
  return {
    uri:
      mode === 'out_of_scope'
        ? 'file:///outside-the-worktree.txt'
        : mode === 'other_file'
          ? new URL('./b.txt', document.uri).href
          : document.uri,
    range: { start: params.position, end: params.position },
  };
});
connection.onRequest(ReferencesRequest.type, (params) => [
  { uri: document.uri, range: { start: params.position, end: params.position } },
]);
connection.onRequest(DocumentDiagnosticRequest.type, () => ({ kind: 'full', items: [diagnostic] }));
connection.onRequest(ShutdownRequest.type, () => null);
connection.onNotification(ExitNotification.type, () => process.exit(0));
connection.listen();
