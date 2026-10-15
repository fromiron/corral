import type { CorralRecord } from '@corral/core';
import {
  ApprovalPanel,
  ArtifactViewer,
  CorralCanvas,
  createEditorStore,
  draftFromDefinition,
  type EditorStore,
  EditorToolbar,
  exportDocuments,
  NodeInspector,
  NodePalette,
  ReinsPanel,
  RunControls,
  RunView,
  type SavedRevision,
  StudioStoresProvider,
  useSteerTarget,
  useStudioStores,
  ValidationPanel,
} from '@corral/react';
import { Link, useBlocker } from '@tanstack/react-router';
import { ReactFlowProvider } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { editorRoute } from '../router.tsx';
import { useServices } from '../services.tsx';

export function EditorPage() {
  const record = editorRoute.useLoaderData();
  // A fresh editor (and undo history) for each Corral.
  const editor = useMemo(
    () => createEditorStore(draftFromDefinition(record.definition, record.layout)),
    [record],
  );
  return <Editor key={record.corralId} record={record} editor={editor} />;
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function Editor({ record, editor }: { record: CorralRecord; editor: EditorStore }) {
  const t = useTranslations('Editor');
  const { repository, session, mode, live } = useServices();
  const draft = useStore(editor, (s) => s.draft);
  const [saved, setSaved] = useState({ record, draft: editor.getState().draft });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  // Undo back to the saved draft returns the same object, so identity is the dirty check.
  const dirty = draft !== saved.draft;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useBlocker({
    shouldBlockFn: () => dirtyRef.current && !window.confirm(t('leaveUnsaved')),
    enableBeforeUnload: () => dirtyRef.current,
  });

  /** Saves the draft; resolves to the saved record, or null when saving failed. */
  const save = useCallback(async (): Promise<CorralRecord | null> => {
    const current = editor.getState().draft;
    if (current === saved.draft) {
      setMessage({ text: t('noChanges'), error: false });
      return saved.record;
    }
    setSaving(true);
    try {
      const result = await repository.save({
        definition: current.definition,
        layout: { nodes: current.layout, viewport: current.viewport },
        expectedDefinitionRevision: saved.record.definitionRevision,
      });
      if (!result.ok) {
        setMessage({ text: result.message, error: true });
        return null;
      }
      setSaved({ record: result.record, draft: current });
      setMessage({
        text: t('savedResult', {
          definition: String(result.changed.definition),
          layout: String(result.changed.layout),
        }),
        error: false,
      });
      return result.record;
    } finally {
      setSaving(false);
    }
  }, [editor, repository, saved, t]);

  // The local server runs saved revisions only, so a run saves first (C-057).
  const beforeStart =
    mode === 'server'
      ? async () => {
          const record = await save();
          return record
            ? { corralId: record.corralId, definitionRevision: record.definitionRevision }
            : null;
        }
      : undefined;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's')
        return;
      event.preventDefault();
      void save();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [save]);

  const exportFiles = () => {
    const files = exportDocuments(editor.getState().draft, saved.record.layoutRevision);
    download(`${record.corralId}.corral.json`, files.definition);
    download(`${record.corralId}.layout.json`, files.layout);
  };

  return (
    <StudioStoresProvider editor={editor} session={session}>
      <ReactFlowProvider>
        <div className="grid h-full grid-rows-[auto_1fr]">
          <div className="flex flex-wrap items-center gap-3 border-b border-line px-3 py-2">
            <label className="flex items-center gap-2 text-sm">
              <span className="sr-only">{t('name')}</span>
              <input
                value={draft.definition.name}
                onChange={(e) => editor.getState().setName(e.target.value)}
                onFocus={() => editor.getState().beginBatch()}
                onBlur={() => editor.getState().endBatch()}
                aria-label={t('name')}
                className="rounded-md border border-line bg-surface px-2 py-1 font-medium"
              />
            </label>
            <span className="text-xs text-muted" data-testid="revisions">
              {t('revisions', {
                definition: saved.record.definitionRevision,
                layout: saved.record.layoutRevision,
              })}
            </span>
            <span className={`text-xs ${dirty ? 'text-warning' : 'text-muted'}`} aria-live="polite">
              {dirty ? `● ${t('unsaved')}` : t('saved')}
            </span>
            <EditorToolbar />
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={exportFiles}
                className="rounded-md border border-line px-3 py-1.5 text-sm"
              >
                {t('export')}
              </button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving}
                className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent disabled:opacity-50"
              >
                {saving ? t('saving') : t('save')}
              </button>
            </div>
            {message ? (
              <p
                role={message.error ? 'alert' : 'status'}
                className={`w-full text-xs ${message.error ? 'text-danger' : 'text-muted'}`}
              >
                {message.text}
              </p>
            ) : null}
          </div>
          <main className="grid min-h-0 grid-cols-[15rem_1fr_22rem] max-[1100px]:grid-cols-[13rem_1fr_19rem]">
            <aside className="flex min-h-0 flex-col gap-6 overflow-auto border-r border-line p-3">
              <NodePalette />
              <ValidationPanel />
            </aside>
            <div className="relative min-h-0">
              <CorralCanvas />
              <CanvasNotice />
            </div>
            <aside className="flex min-h-0 flex-col gap-6 overflow-auto border-l border-line p-3">
              <NodeInspector />
              <RunSide beforeStart={beforeStart} liveAvailable={live} />
            </aside>
          </main>
        </div>
      </ReactFlowProvider>
    </StudioStoresProvider>
  );
}

function RunSide({
  beforeStart,
  liveAvailable,
}: {
  beforeStart?: (() => Promise<SavedRevision | null>) | undefined;
  liveAvailable: boolean;
}) {
  const t = useTranslations('Editor');
  const { session } = useStudioStores();
  const runId = useStore(session, (s) => s.runId);
  const [chosen, setChosen] = useState<string | null>(null);
  const target = useSteerTarget(session, chosen);
  const [viewing, setViewing] = useState<string | null>(null);
  return (
    <section aria-labelledby="run-heading" className="flex flex-col gap-3">
      <RunControls
        onStarted={() => {
          setChosen(null);
          setViewing(null);
        }}
        liveAvailable={liveAvailable}
        {...(beforeStart ? { beforeStart } : {})}
      />
      <RunView session={session} onSteer={setChosen} />
      <ApprovalPanel session={session} onOpenArtifact={setViewing} />
      {viewing ? (
        <ArtifactViewer session={session} versionId={viewing} onClose={() => setViewing(null)} />
      ) : null}
      {runId ? (
        <Link to="/runs/$runId" params={{ runId }} className="text-xs underline">
          {t('openRun')}
        </Link>
      ) : null}
      <ReinsPanel session={session} target={target} />
    </section>
  );
}

function CanvasNotice() {
  const t = useTranslations('Canvas');
  const { editor } = useStudioStores();
  const notice = useStore(editor, (s) => s.notice);
  const nodes = useStore(editor, (s) => s.draft.definition.nodes);
  const labelOf = (id: string) => nodes.find((n) => n.id === id)?.label ?? id;
  const text =
    notice?.kind === 'rejected'
      ? t(`rejected.${notice.reason}`)
      : notice?.kind === 'connected'
        ? t('connected', { source: labelOf(notice.source), target: labelOf(notice.target) })
        : '';
  return (
    <p
      role="status"
      aria-live="polite"
      data-testid="canvas-notice"
      className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-md bg-raised px-3 py-1 text-xs shadow empty:hidden"
    >
      {text}
    </p>
  );
}
