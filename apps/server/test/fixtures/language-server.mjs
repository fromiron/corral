import {
  ApplyWorkspaceEditRequest,
  CodeActionRequest,
  CodeActionResolveRequest,
  CompletionRequest,
  createProtocolConnection,
  DefinitionRequest,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  DocumentDiagnosticRequest,
  ExitNotification,
  InitializeRequest,
  PublishDiagnosticsNotification,
  ReferencesRequest,
  RenameRequest,
  ShutdownRequest,
} from 'vscode-languageserver-protocol/node';

const mode = process.argv[2] ?? 'full';
const connection = createProtocolConnection(process.stdin, process.stdout);
const documents = new Map();
let deniedEdit = false;
const diagnostics = (document) => [
  {
    range: { start: { line: 0, character: 2 }, end: { line: 0, character: 3 } },
    message: `${document.text}; edit=${deniedEdit}`,
  },
];
const publish = (document) =>
  connection.sendNotification(PublishDiagnosticsNotification.type, {
    uri: document.uri,
    version: document.version,
    diagnostics: diagnostics(document),
  });
connection.onRequest(InitializeRequest.type, () => ({
  capabilities: {
    positionEncoding: 'utf-16',
    textDocumentSync: mode === 'incremental' ? 2 : 1,
    completionProvider: { triggerCharacters: ['.'] },
    definitionProvider: true,
    referencesProvider: mode !== 'unsupported',
    renameProvider: mode !== 'unsupported',
    codeActionProvider: mode !== 'unsupported' && { resolveProvider: true },
    ...(mode === 'pull'
      ? { diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } }
      : {}),
  },
}));
connection.onNotification(DidOpenTextDocumentNotification.type, async ({ textDocument }) => {
  if (documents.has(textDocument.uri)) process.exit(2);
  documents.set(textDocument.uri, textDocument);
  const reply = await connection.sendRequest(ApplyWorkspaceEditRequest.type, {
    edit: { changes: {} },
  });
  deniedEdit = reply.applied === false;
  await publish(textDocument);
});
connection.onNotification(
  DidChangeTextDocumentNotification.type,
  async ({ textDocument, contentChanges }) => {
    const previous = documents.get(textDocument.uri);
    const change = contentChanges[0];
    if (!previous || contentChanges.length !== 1 || textDocument.version <= previous.version)
      process.exit(3);
    if (mode === 'incremental') {
      const lines = previous.text.split(/\r\n|\r|\n/);
      if (
        JSON.stringify(change.range) !==
        JSON.stringify({
          start: { line: 0, character: 0 },
          end: { line: lines.length - 1, character: lines.at(-1).length },
        })
      )
        process.exit(4);
    } else if (change.range) process.exit(5);
    const document = { ...previous, version: textDocument.version, text: change.text };
    documents.set(document.uri, document);
    await publish(document);
  },
);
connection.onNotification(DidCloseTextDocumentNotification.type, ({ textDocument }) => {
  documents.delete(textDocument.uri);
});
connection.onRequest(CompletionRequest.type, ({ textDocument, position }) => {
  if (position.character === 99) {
    process.stderr.write('WAITING\n');
    return new Promise(() => {});
  }
  return [{ label: documents.get(textDocument.uri).text, insertText: 'completed' }];
});
connection.onRequest(DefinitionRequest.type, ({ textDocument, position }) => ({
  uri: textDocument.uri,
  range: { start: position, end: position },
}));
connection.onRequest(ReferencesRequest.type, ({ textDocument, position }) => {
  if (mode === 'crash') process.exit(6);
  return [{ uri: textDocument.uri, range: { start: position, end: position } }];
});
connection.onRequest(DocumentDiagnosticRequest.type, ({ textDocument }) => ({
  kind: 'full',
  items: diagnostics(documents.get(textDocument.uri)),
}));
connection.onRequest(RenameRequest.type, ({ textDocument, position, newName }) => ({
  changes: {
    [textDocument.uri]: [{ range: { start: position, end: position }, newText: newName }],
  },
}));
connection.onRequest(CodeActionRequest.type, ({ textDocument, range, context }) => [
  {
    title: context.diagnostics.length
      ? `Resolved edit (${context.diagnostics[0].code})`
      : 'Resolved edit',
    data: { uri: textDocument.uri, range },
  },
  { title: 'Legacy command', command: 'fixture.forbidden' },
  {
    title: 'Edit with command',
    edit: { changes: {} },
    command: { title: 'Forbidden', command: 'fixture.forbidden' },
  },
  { title: 'Disabled action', disabled: { reason: 'Unavailable' } },
  { title: 'No edit' },
  { title: 'Create file', edit: { documentChanges: [{ kind: 'create', uri: textDocument.uri }] } },
]);
connection.onRequest(CodeActionResolveRequest.type, (action) => ({
  ...action,
  edit: {
    changes: {
      [action.data.uri]: [
        { range: action.data.range, newText: documents.get(action.data.uri).text },
      ],
    },
  },
}));
connection.onRequest('workspace/executeCommand', () => process.exit(7));
connection.onRequest(ShutdownRequest.type, () => null);
connection.onNotification(ExitNotification.type, () => process.exit(0));
connection.listen();
