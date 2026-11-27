import type { AgentRole, LibraryAgentRole } from '@corral/contracts';
import { agentDescription, builtinSkillName } from '@corral/core';
import {
  type ReactNode,
  type RefObject,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslations } from 'use-intl';
import {
  Button,
  Input,
  KitDialog,
  KitDialogContent,
  KitDialogFooter,
  KitDialogHeader,
  KitDialogTitle,
  TabItem,
  TabPanel,
  Tabs,
  TabsList,
  Textarea,
} from '../design-kit/index.ts';
import { fontWeights } from '../design-kit/lib/font-weight.ts';
import { defaultAgentRole } from '../editor/model.ts';
import type { AgentSource, ReplacementChange, TeamReference } from './commands.ts';
import type { TeamEditorProps } from './TeamEditor.tsx';

export type SaveAgent = (
  role: LibraryAgentRole,
) => Promise<{ ok: true } | { ok: false; message: string }>;
interface DialogActions {
  onClose(): void;
  returnFocus(): HTMLElement | true;
}
function AgentDialog({
  title,
  initialFocus,
  children,
  onClose,
  returnFocus,
  busy = false,
  small = false,
  scrollList = false,
}: DialogActions & {
  title: string;
  initialFocus: RefObject<HTMLInputElement | null>;
  children: ReactNode;
  busy?: boolean;
  small?: boolean;
  scrollList?: boolean;
}) {
  const composing = useRef(false);
  return (
    <KitDialog
      open
      onOpenChange={(open, details) => {
        const event = details.event;
        if (
          busy ||
          composing.current ||
          (event instanceof KeyboardEvent && (event.isComposing || event.keyCode === 229))
        )
          details.cancel();
        else if (!open) onClose();
      }}
    >
      <KitDialogContent
        size={small ? 'sm' : 'lg'}
        initialFocus={initialFocus}
        finalFocus={returnFocus}
        showCloseButton={false}
        className={
          scrollList
            ? 'flex max-h-[85dvh] min-w-0 flex-col overflow-hidden'
            : 'max-h-[85dvh] min-w-0 overflow-y-auto'
        }
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onKeyDownCapture={(event) => {
          if (
            (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) &&
            ['Enter', 'Escape'].includes(event.key)
          ) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
        onClickCapture={(event) => {
          if (composing.current) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
      >
        <KitDialogHeader className="shrink-0">
          <KitDialogTitle>{title}</KitDialogTitle>
        </KitDialogHeader>
        <div className={scrollList ? 'flex min-h-0 min-w-0 flex-col gap-3' : 'grid min-w-0 gap-3'}>
          {children}
        </div>
      </KitDialogContent>
    </KitDialog>
  );
}

type Choice = { key: string; source: AgentSource; team?: string };
export type ReplacementPreview = { error: string } | { changed: readonly ReplacementChange[] };

export function AgentPicker({
  agentLibrary,
  skillLabel,
  presets,
  teams,
  preview,
  onChoose,
  onClose,
  returnFocus,
}: DialogActions &
  Pick<TeamEditorProps, 'agentLibrary' | 'skillLabel'> & {
    presets: readonly AgentRole[];
    teams: readonly TeamReference[];
    preview?: ((source: AgentSource) => ReplacementPreview) | undefined;
    onChoose(source: AgentSource): void;
  }) {
  const t = useTranslations('TeamEditor.agentPicker');
  const presetText = useTranslations('TeamTemplates.presets');
  const [chosenTab, setTab] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [face, setFace] = useState<'list' | 'custom' | AgentSource>('list');
  const [name, setName] = useState('');
  const [task, setTask] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const rowPrefix = useId();
  const back = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (face === 'list' || face === 'custom') input.current?.focus();
    else back.current?.focus();
  }, [face]);
  const choices = useMemo(
    () => ({
      mine: (agentLibrary?.agents ?? [])
        .filter((a) => !a.archivedAt && !a.role.allowedCollaborationTools.includes('advise'))
        .map(
          (a): Choice => ({
            key: a.agentId,
            source: {
              role: a.role,
              origin: { kind: 'library', agentId: a.agentId, revision: a.revision },
            },
          }),
        ),
      builtin: presets.map(
        (role): Choice => ({
          key: role.id,
          source: {
            role,
            origin: { kind: 'preset', presetId: role.id },
            stepInstruction: presetText(`${role.id}.duty`),
          },
        }),
      ),
      others: teams.flatMap((team) =>
        (team.agents ?? []).map(
          (source): Choice => ({
            key: `${team.corralId}:${source.role.id}`,
            team: team.name,
            source,
          }),
        ),
      ),
    }),
    [agentLibrary?.agents, presets, presetText, teams],
  );
  const tab =
    chosenTab ??
    (!agentLibrary || (agentLibrary.status === 'ready' && !choices.mine.length)
      ? 'builtin'
      : 'mine');
  const text = query.trim().toLocaleLowerCase();
  const rows = choices[tab as keyof typeof choices].filter(
    ({ source }) =>
      !text ||
      source.role.name.toLocaleLowerCase().includes(text) ||
      !!agentDescription(source.role)?.toLocaleLowerCase().includes(text) ||
      (source.stepInstruction ?? source.role.prompt).toLocaleLowerCase().includes(text),
  );
  const result = typeof face === 'object' ? preview?.(face) : undefined;
  const title =
    face === 'custom'
      ? t('custom')
      : typeof face === 'object'
        ? t('preview', { name: face.role.name })
        : t(preview ? 'replaceTitle' : 'add');
  return (
    <AgentDialog
      title={title}
      onClose={onClose}
      returnFocus={returnFocus}
      initialFocus={input}
      scrollList={face === 'list'}
    >
      {face === 'list' ? (
        <>
          <Input
            ref={input}
            className="shrink-0"
            aria-label={t('search')}
            placeholder={t('search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 min-w-0 flex-col gap-2">
            <TabsList aria-label={t('sources')} className="max-w-full shrink-0 self-start">
              <TabItem value="mine" label={t('mine')} />
              <TabItem value="builtin" label={t('builtin')} />
              <TabItem value="others" label={t('others')} />
            </TabsList>
            {tab === 'mine' && agentLibrary?.projectName && (
              <p className="shrink-0 break-words text-caption text-muted-foreground">
                {t('project', { name: agentLibrary.projectName })}
              </p>
            )}
            <TabPanel
              value={tab}
              tabIndex={-1}
              className="-m-1 min-h-0 min-w-0 scroll-py-2 overflow-y-auto overscroll-contain p-1"
            >
              {tab === 'mine' && agentLibrary?.status === 'failed' ? (
                <div className="grid justify-items-start gap-2">
                  <p role="alert" className="text-body text-destructive">
                    {t('failed')}
                  </p>
                  <Button variant="secondary" onClick={agentLibrary.retry}>
                    {t('retry')}
                  </Button>
                </div>
              ) : tab === 'mine' && agentLibrary?.status === 'loading' ? (
                <p role="status" className="text-body text-muted-foreground">
                  {t('loading')}
                </p>
              ) : !rows.length ? (
                <p role="status" className="text-body text-muted-foreground">
                  {t(text ? 'noMatch' : tab === 'mine' ? 'empty' : 'emptyTeams')}
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {rows.map(({ key, source, team }) => {
                    const skills = source.role.skills ?? [];
                    // A built-in agent's skills are known by name even before the library loads.
                    const labels = skills.map(
                      (skill) =>
                        skillLabel?.(skill) ??
                        (source.origin?.kind === 'preset' ? builtinSkillName(skill) : null),
                    );
                    const id = `${rowPrefix}-${key}`;
                    return (
                      <li key={key}>
                        <Button
                          variant="ghost"
                          aria-label={source.role.name}
                          aria-describedby={`${id}-detail`}
                          onClick={() => (preview ? setFace(source) : onChoose(source))}
                          className="h-auto w-full min-w-0 justify-start whitespace-normal px-2 py-2 text-left"
                        >
                          <span className="grid min-w-0 gap-1">
                            <span
                              className="break-words text-body text-foreground"
                              style={{ fontVariationSettings: fontWeights.semibold }}
                            >
                              {source.role.name}
                            </span>
                            <span id={`${id}-detail`} className="grid gap-1 text-muted-foreground">
                              {team && <span className="text-caption">{team}</span>}
                              <span className="line-clamp-2 whitespace-pre-line break-words text-body">
                                {source.stepInstruction ??
                                  agentDescription(source.role) ??
                                  source.role.prompt}
                              </span>
                              {skills.length > 0 && (
                                <span className="break-words text-caption">
                                  {labels.every(Boolean)
                                    ? labels.join(' · ')
                                    : t('skillCount', { count: skills.length })}
                                </span>
                              )}
                            </span>
                          </span>
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </TabPanel>
          </Tabs>
        </>
      ) : face === 'custom' ? (
        <>
          <label className="grid gap-1 text-caption">
            {t('name')}
            <Input ref={input} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="grid gap-1 text-caption">
            {t('task')}
            <Textarea value={task} maxLength={20000} onChange={(e) => setTask(e.target.value)} />
          </label>
        </>
      ) : (
        result &&
        ('error' in result ? (
          <p role="alert" className="text-body text-destructive">
            {result.error}
          </p>
        ) : (
          <>
            <section className="grid gap-1">
              <h3 className="text-subtitle" style={{ fontVariationSettings: fontWeights.semibold }}>
                {t('changes')}
              </h3>
              {result.changed.length ? (
                <ul className="list-disc pl-5 text-body">
                  {result.changed.map((change) => (
                    <li key={change}>{t(`fields.${change}`)}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-body">{t('sameSettings')}</p>
              )}
            </section>
            <section className="grid gap-1">
              <h3 className="text-subtitle" style={{ fontVariationSettings: fontWeights.semibold }}>
                {t('stays')}
              </h3>
              <p className="text-body">
                {t('retained', { task: result.changed.includes('task') ? 'changed' : 'kept' })}
              </p>
            </section>
          </>
        ))
      )}
      <KitDialogFooter className="mt-2 shrink-0 flex-wrap">
        {face === 'list' && !preview && (
          <Button variant="tertiary" onClick={() => setFace('custom')}>
            {t('custom')}
          </Button>
        )}
        {face !== 'list' && (
          <Button ref={back} variant="ghost" onClick={() => setFace('list')}>
            {t('back')}
          </Button>
        )}
        <Button variant="ghost" onClick={onClose}>
          {t('cancel')}
        </Button>
        {face === 'custom' && (
          <Button
            disabled={!name.trim() || !task.trim()}
            onClick={() => onChoose({ role: defaultAgentRole(name.trim(), task.trim()) })}
          >
            {t('add')}
          </Button>
        )}
        {typeof face === 'object' && result && !('error' in result) && (
          <Button onClick={() => onChoose(face)}>{t('replace')}</Button>
        )}
      </KitDialogFooter>
    </AgentDialog>
  );
}

export function SaveAgentDialog({
  role,
  initialPrompt,
  save,
  onClose,
  onSaved,
  returnFocus,
}: DialogActions & { role: AgentRole; initialPrompt: string; save: SaveAgent; onSaved(): void }) {
  const t = useTranslations('TeamEditor.agentPicker');
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(role.name);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    const { id: _id, origin: _origin, ...fields } = role;
    const original: LibraryAgentRole = { ...fields, name: name.trim(), prompt: prompt.trim() };
    setBusy(true);
    setError('');
    try {
      const result = await save(original);
      if (result.ok) onSaved();
      else setError(result.message);
    } catch {
      setError(t('saveFailed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AgentDialog
      title={t('saveTitle')}
      initialFocus={input}
      onClose={onClose}
      returnFocus={returnFocus}
      busy={busy}
      small
    >
      <label className="grid gap-1 text-caption">
        {t('name')}
        <Input ref={input} disabled={busy} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="grid gap-1 text-caption">
        {t('base')}
        <Textarea
          disabled={busy}
          value={prompt}
          maxLength={20000}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </label>
      {error && (
        <p role="alert" className="text-body text-destructive">
          {error}
        </p>
      )}
      <KitDialogFooter className="mt-2">
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button disabled={busy || !name.trim() || !prompt.trim()} onClick={() => void submit()}>
          {t('save')}
        </Button>
      </KitDialogFooter>
    </AgentDialog>
  );
}
