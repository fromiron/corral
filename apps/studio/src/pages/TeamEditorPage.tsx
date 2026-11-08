import { TeamEditor } from '@corral/react';
import { Button, KitBadge } from '@corral/react/design-kit';
import { Redo2, Undo2 } from '@corral/react/icons';
import { useBlocker, useNavigate, useRouter } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { projectsChanged, setCurrentProject } from '../projects.ts';
import { composeRoute } from '../router.tsx';
import { useServices } from '../services.tsx';
import {
  blocksLeaving,
  discardEditorCopy,
  editorWorkingCopy,
  saveEditorCopy,
} from '../workbench/editorDraft.ts';
import { settingsInteractionBlocked, settingsOnlyTransition } from '../workbench/navigation.ts';
import { useModelProfiles } from '../workbench/useModels.ts';

/**
 * The team composer: the structure-first editor on the same working copy as the classic editor,
 * so a draft, its undo history and Save are one whichever editor made the change.
 */
export function TeamEditorPage() {
  const record = composeRoute.useLoaderData();
  const { repository } = useServices();
  const t = useTranslations('TeamEditor');
  const e = useTranslations('Editor');
  const router = useRouter();
  const navigate = useNavigate();
  const profiles = useModelProfiles();
  useEffect(() => setCurrentProject(record.projectId), [record.projectId]);
  const copy = useMemo(() => editorWorkingCopy(repository, record), [repository, record]);
  const { editor, saved, saving, message } = useStore(copy);
  const draft = useStore(editor, (s) => s.draft);
  const canUndo = useStore(editor, (s) => s.canUndo);
  const canRedo = useStore(editor, (s) => s.canRedo);
  const dirty = saving || draft !== saved.draft;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useBlocker({
    shouldBlockFn: ({ current, next }) => {
      // The classic editor shares this working copy, so moving between the two keeps the draft.
      if (next.pathname === `/corrals/${record.corralId}/edit`) return false;
      if (
        !blocksLeaving(dirtyRef.current, false) ||
        next.pathname.startsWith('/settings') ||
        settingsOnlyTransition(current, next)
      )
        return false;
      if (!window.confirm(e('leaveUnsaved'))) return true;
      discardEditorCopy(repository, record);
      return false;
    },
    enableBeforeUnload: () => dirtyRef.current,
  });

  const save = useCallback(async () => {
    const result = await saveEditorCopy(copy, repository, {
      noChanges: e('noChanges'),
      saved: (changed) =>
        e('savedResult', {
          definition: String(changed.definition),
          layout: String(changed.layout),
        }),
    });
    if (result?.wrote) {
      projectsChanged();
      await router.invalidate();
    }
  }, [copy, repository, router, e]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (settingsInteractionBlocked()) return;
      if (event.isComposing || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's')
        return;
      event.preventDefault();
      void save();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [save]);

  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border pr-3 pl-4">
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-body">
          <span className="text-muted-foreground">{t('teams')}</span>
          <span aria-hidden className="text-muted-foreground">
            /
          </span>
          <span className="truncate font-semibold text-foreground">{draft.definition.name}</span>
        </nav>
        <span aria-live="polite">
          <KitBadge size="compact" color={dirty ? 'amber' : 'gray'}>
            {saving ? t('saving') : dirty ? t('unsaved') : t('saved')}
          </KitBadge>
        </span>
        {message ? (
          <p
            role={message.error ? 'alert' : 'status'}
            className={`min-w-0 truncate text-caption ${message.error ? 'text-destructive' : 'text-muted-foreground'}`}
          >
            {message.text}
          </p>
        ) : null}
        <span className="grow" />
        <Button
          variant="ghost"
          size="icon-compact"
          aria-label={t('undo')}
          disabled={!canUndo}
          onClick={() => editor.getState().undo()}
        >
          <Undo2 />
        </Button>
        <Button
          variant="ghost"
          size="icon-compact"
          aria-label={t('redo')}
          disabled={!canRedo}
          onClick={() => editor.getState().redo()}
        >
          <Redo2 />
        </Button>
        <Button
          variant="tertiary"
          size="compact"
          onClick={() =>
            void navigate({ to: '/corrals/$corralId/edit', params: { corralId: record.corralId } })
          }
        >
          {t('classicEditor')}
        </Button>
        <Button
          variant="primary"
          size="compact"
          disabled={saving || !dirty}
          onClick={() => void save()}
        >
          {saving ? t('saving') : t('save')}
        </Button>
      </header>
      <TeamEditor editor={editor} profiles={profiles} />
    </div>
  );
}
