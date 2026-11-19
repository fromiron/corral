import type { HarnessApi } from '@corral/client';
import type {
  HarnessBindingRef,
  HarnessEntryView,
  RoleHarnessPreview,
  RoleMcpToolRef,
  RoleSkillRef,
} from '@corral/contracts';
import {
  Badge,
  Button,
  CheckboxGroup,
  CheckboxItem,
  Dialog,
  DialogFooter,
  DialogPopup,
  DialogTitle,
  Input,
} from '@corral/react/design-kit';
import { Plus, X } from '@corral/react/icons';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';
import { EntryContent } from './harness/EntryContent.tsx';
import { ResourceEditor } from './harness/ResourceEditor.tsx';
import {
  type SkillCatalog as Catalog,
  loadSkillCatalog,
  skillState,
  versionsOf,
} from './harness/skillCatalog.ts';

const none: readonly RoleSkillRef[] = [];
const keyOf = ({ resourceHash, entry }: RoleSkillRef) => `${resourceHash}:${entry}`;
const toRef = ({ resourceHash, entry }: RoleSkillRef): RoleSkillRef => ({ resourceHash, entry });
export interface RoleSkillsProps {
  value: readonly RoleSkillRef[] | undefined;
  onApply(next: RoleSkillRef[]): void;
  revealPolicy(): void;
  targetLabel: string;
  mode: 'seat' | 'original';
  projectId: string;
  roleId?: string;
  harness?: HarnessBindingRef | undefined;
  mcpTools?: RoleMcpToolRef[] | undefined;
}

function useHarnessRevision() {
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((n) => n + 1), []);
  useEffect(() => {
    window.addEventListener('corral:harness-changed', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener('corral:harness-changed', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [refresh]);
  return { revision, refresh };
}

/** Summary surfaces must never turn an unresolved ref into the name of another version. */
export function useSkillLabel() {
  const { harnesses } = useServices();
  const { revision } = useHarnessRevision();
  const [labels, setLabels] = useState<Map<string, string>>();
  useEffect(() => {
    void revision;
    let active = true;
    if (harnesses)
      void harnesses.entries().then(
        (entries) =>
          active &&
          setLabels(
            new Map(entries.filter((e) => e.kind === 'skill').map((e) => [keyOf(e), e.name])),
          ),
        () => active && setLabels(undefined),
      );
    return () => {
      active = false;
    };
  }, [harnesses, revision]);
  return useCallback(
    (ref: RoleSkillRef) => (harnesses && labels?.get(keyOf(ref))) ?? null,
    [harnesses, labels],
  );
}

export function RoleSkills(props: RoleSkillsProps) {
  const { harnesses } = useServices();
  const t = useTranslations('Library.resources');
  return harnesses ? (
    <ServerRoleSkills key={props.projectId} {...props} api={harnesses} />
  ) : (
    <p className="text-caption text-muted-foreground">{t('localOnly')}</p>
  );
}

type Face = { kind: 'pick'; replacing?: RoleSkillRef } | { kind: 'detail'; selected: RoleSkillRef };

function ServerRoleSkills({
  api,
  value,
  roleId = 'role',
  harness,
  mcpTools,
  projectId,
  mode,
  targetLabel,
  onApply,
  revealPolicy,
}: RoleSkillsProps & { api: HarnessApi }) {
  const t = useTranslations('TeamEditor.skills');
  const r = useTranslations('Resources');
  const l = useTranslations('Library');
  const h = useTranslations('Harness');
  const { revision, refresh } = useHarnessRevision();
  const [catalog, setCatalog] = useState<Catalog | 'failed' | null>(null);
  const [preview, setPreview] = useState<RoleHarnessPreview | 'failed' | null>(null);
  const [owners, setOwners] = useState<Map<string, string[]>>(new Map());
  const [sourcesFailed, setSourcesFailed] = useState(false);
  const [face, setFace] = useState<Face | null>(null);
  const add = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const selected = value ?? none;
  const entries = typeof catalog === 'object' && catalog ? catalog.entries : undefined;
  const byKey = useMemo(() => new Map(entries?.map((e) => [keyOf(e), e])), [entries]);
  useEffect(() => {
    void revision;
    let active = true;
    void loadSkillCatalog(api).then(
      (next) => active && setCatalog(next),
      () => active && setCatalog('failed'),
    );
    return () => {
      active = false;
    };
  }, [api, revision]);
  useEffect(() => {
    void revision;
    let active = true;
    setPreview(null);
    setOwners(new Map());
    setSourcesFailed(false);
    if (value !== undefined || harness) {
      const role = {
        id: roleId,
        ...(harness && { harness }),
        ...(value && { skills: [...value] }),
        ...(mcpTools && { mcpTools }),
      };
      void api.preview(role, projectId).then(
        async (result) => {
          if (!active) return;
          setPreview(result);
          if (
            !result.snapshot?.resources.some(
              (item) => item.kind === 'skill' && item.required && !item.selectedByRole,
            )
          )
            return;
          // Only pinned layers can tell which policy required this entry, as opposed to also selecting it.
          const bindings = result.snapshot.layers?.map((layer) => layer.binding) ?? [
            result.snapshot.binding,
          ];
          try {
            const profiles = await Promise.all(bindings.map((binding) => api.profile(binding)));
            const names = new Map<string, string[]>();
            for (const profile of profiles) {
              for (const item of profile.resources) {
                if (item.kind !== 'skill' || (!item.required && item.skillMode !== 'mandatory'))
                  continue;
                const key = keyOf(item);
                names.set(key, [...(names.get(key) ?? []), profile.name]);
              }
            }
            if (active) setOwners(names);
          } catch {
            if (active) setSourcesFailed(true);
          }
        },
        () => active && setPreview('failed'),
      );
    }
    return () => {
      active = false;
    };
  }, [api, harness, roleId, value, mcpTools, projectId, revision]);
  function label(ref: RoleSkillRef) {
    const known = byKey.get(keyOf(ref))?.name;
    if (known) return known;
    const parts = ref.entry.split('/');
    const stem = parts.at(-1)?.replace(/\.md$/i, '');
    const name = stem?.toLowerCase() === 'skill' ? parts.at(-2) : stem;
    return name && name.toLowerCase() !== 'skills'
      ? name
      : t('unknown', { number: selected.findIndex((s) => keyOf(s) === keyOf(ref)) + 1 });
  }
  const verified = preview && preview !== 'failed' ? preview : null;
  const problem = verified && !verified.snapshot ? verified.problem : null;
  const problems = new Map(problem?.entries.map((item) => [keyOf(item), item.reason]));
  const inherited = verified?.snapshot?.resources.filter(
    (item) =>
      item.kind === 'skill' &&
      item.required &&
      !selected.some((s) => s.resourceHash === item.hash && s.entry === item.entry),
  );
  const required = new Map(
    inherited?.flatMap((item) => {
      if (!item.entry) return [];
      const key = keyOf({ resourceHash: item.hash, entry: item.entry });
      const policies = owners.get(key);
      return [
        [
          key,
          policies?.length ? t('requiredBy', { policy: policies.join(', ') }) : t('required'),
        ] as const,
      ];
    }),
  );
  const applyLabel = mode === 'seat' ? t('applySeat', { name: targetLabel }) : t('applyOriginal');
  function open(next: Face, trigger: HTMLElement) {
    opener.current = trigger;
    setFace(next);
  }
  function close() {
    setFace(null);
  }
  const restoreFocus = () => (opener.current?.isConnected ? opener.current : add.current);
  function apply(next: RoleSkillRef[]) {
    onApply(next);
    close();
  }
  return (
    <div className="grid min-w-0 gap-2">
      {selected.map((ref) => {
        const key = keyOf(ref),
          name = label(ref),
          reason = problems.get(key);
        return (
          <div key={key} className="grid min-w-0 gap-1">
            <div className="flex min-w-0 items-center justify-between gap-1">
              {byKey.has(key) ? (
                <Button
                  variant="ghost"
                  className="min-w-0 justify-start whitespace-normal break-words text-left"
                  onClick={(e) => open({ kind: 'detail', selected: ref }, e.currentTarget)}
                >
                  {name}
                </Button>
              ) : (
                <span className="min-w-0 break-words text-body">{name}</span>
              )}
              <Button
                variant="ghost"
                size="icon-compact"
                aria-label={t('deselect', { name })}
                onClick={() => onApply(selected.filter((s) => keyOf(s) !== key))}
              >
                <X aria-hidden />
              </Button>
            </div>
            {reason ? (
              <div className="flex flex-wrap items-center gap-2 text-caption">
                <span role="alert" className="text-destructive">
                  {reason === 'untrusted'
                    ? r('needsTrust')
                    : reason === 'disabled'
                      ? r('skillDisabled')
                      : t(reason === 'missing' ? 'missing' : 'nameConflict')}
                </span>
                <Button
                  variant="tertiary"
                  onClick={(e) =>
                    open(
                      reason === 'untrusted' && byKey.has(key)
                        ? { kind: 'detail', selected: ref }
                        : { kind: 'pick', replacing: ref },
                      e.currentTarget,
                    )
                  }
                >
                  {t('reconnect', { name })}
                </Button>
              </div>
            ) : null}
          </div>
        );
      })}
      {inherited?.map((item) => {
        if (!item.entry) return null;
        const key = keyOf({ resourceHash: item.hash, entry: item.entry });
        return (
          <div key={key} className="grid gap-1">
            <span className="break-words text-body">
              {byKey.get(key)?.name ?? item.skillName ?? item.name}
            </span>
            <span className="text-caption text-muted-foreground">{required.get(key)}</span>
          </div>
        );
      })}
      {problem?.reason === 'execution_policy_required' ? (
        <div role="alert" className="grid gap-1 text-caption">
          <span>{h('roleNeedsPolicy')}</span>
          <Button variant="tertiary" className="justify-self-start" onClick={revealPolicy}>
            {t('policyLink')}
          </Button>
        </div>
      ) : null}
      {preview === 'failed' || sourcesFailed ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-caption">
          {t('unconfirmed')}
          <Button variant="tertiary" onClick={refresh}>
            {l('retry')}
          </Button>
        </div>
      ) : null}
      {catalog === 'failed' && !face ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-caption">
          {l('loadFailed')}
          <Button variant="tertiary" onClick={refresh}>
            {l('retry')}
          </Button>
        </div>
      ) : null}
      <Button
        ref={add}
        variant="tertiary"
        className="justify-self-start"
        onClick={(e) => open({ kind: 'pick' }, e.currentTarget)}
      >
        <Plus aria-hidden />
        {t('add')}
      </Button>
      {face?.kind === 'pick' ? (
        <Picker
          key={JSON.stringify(selected)}
          api={api}
          catalog={catalog}
          selected={selected}
          required={required}
          replacing={face.replacing}
          label={label}
          applyLabel={applyLabel}
          onApply={apply}
          onClose={close}
          restoreFocus={restoreFocus}
          refresh={refresh}
        />
      ) : null}
      {face?.kind === 'detail' ? (
        <SkillDetail
          api={api}
          catalog={catalog}
          selected={selected}
          pinned={face.selected}
          label={label(face.selected)}
          mode={mode}
          targetLabel={targetLabel}
          applyLabel={applyLabel}
          onApply={apply}
          onClose={close}
          restoreFocus={restoreFocus}
          refresh={refresh}
        />
      ) : null}
    </div>
  );
}

interface DialogProps {
  api: HarnessApi;
  catalog: Catalog | 'failed' | null;
  selected: readonly RoleSkillRef[];
  applyLabel: string;
  onApply(next: RoleSkillRef[]): void;
  onClose(): void;
  restoreFocus(): HTMLElement | null;
  refresh(): void;
}
const usable = (entry: HarnessEntryView, catalog: Catalog) =>
  !entry.archivedAt &&
  !catalog.disabled.has(entry.resourceHash) &&
  Boolean(entry.resource.trustedAt);

function Picker({
  api,
  catalog,
  selected,
  required,
  replacing,
  label,
  applyLabel,
  onApply,
  onClose,
  restoreFocus,
  refresh,
}: DialogProps & {
  required: ReadonlyMap<string, string>;
  replacing?: RoleSkillRef | undefined;
  label(ref: RoleSkillRef): string;
}) {
  const t = useTranslations('TeamEditor.skills'),
    r = useTranslations('Resources'),
    l = useTranslations('Library');
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [checks, setChecks] = useState<readonly RoleSkillRef[]>(selected);
  const [created, setCreated] = useState<RoleSkillRef | null>(null);
  const awaitingInstall = useRef(false);
  const [saved, setSaved] = useState('');
  const [replacement, setReplacement] = useState(replacing);
  const id = useId();
  const search = useRef<HTMLInputElement>(null);
  const rows = useRef<HTMLDivElement>(null);
  const createButton = useRef<HTMLButtonElement>(null);
  const back = useRef<((event?: Event) => void) | null>(null);
  const composing = useRef(false);
  const before = new Set(selected.map(keyOf));
  const checked = new Set(checks.map(keyOf));
  const ready = catalog && catalog !== 'failed' ? catalog : null;
  const needle = query.trim().toLocaleLowerCase();
  const filtered =
    ready?.entries.filter(
      (e) =>
        (!e.archivedAt || before.has(keyOf(e))) &&
        `${e.name} ${e.description} ${e.resource.name}`.toLocaleLowerCase().includes(needle),
    ) ?? [];
  function select(item: HarnessEntryView) {
    if (!ready || composing.current) return;
    const key = keyOf(item);
    if (required.has(key)) return;
    if (checked.has(key)) {
      setChecks(checks.filter((s) => keyOf(s) !== key));
      if (replacement && keyOf(replacement) === key) setReplacement(undefined);
      return;
    }
    if (!usable(item, ready)) return;
    if (replacement) {
      setChecks(checks.map((s) => (keyOf(s) === keyOf(replacement) ? toRef(item) : s)));
      setReplacement(undefined);
    } else setChecks([...checks, toRef(item)]);
  }
  useEffect(() => {
    if (!ready || !created || !awaitingInstall.current) return;
    const key = keyOf(created);
    const installed = ready.entries.find((e) => keyOf(e) === key);
    if (!installed) return;
    awaitingInstall.current = false;
    if (usable(installed, ready)) {
      setChecks((current) => {
        if (current.some((s) => keyOf(s) === key)) return current;
        if (replacement) return current.map((s) => (keyOf(s) === keyOf(replacement) ? created : s));
        return [...current, created];
      });
      setReplacement(undefined);
      setSaved(key);
    }
    const row = [...(rows.current?.querySelectorAll<HTMLElement>('[data-entry]') ?? [])].find(
      (row) => row.dataset.entry === key,
    );
    row?.focus();
  }, [ready, created, replacement]);
  useEffect(() => {
    if (!saved) return;
    const timeout = window.setTimeout(() => setSaved(''), 4500);
    return () => window.clearTimeout(timeout);
  }, [saved]);
  const changed = checked.size !== before.size || checks.some((s) => !before.has(keyOf(s)));
  const canApply =
    ready &&
    changed &&
    checks.every(
      (ref) =>
        before.has(keyOf(ref)) ||
        ready.entries.some((entry) => keyOf(entry) === keyOf(ref) && usable(entry, ready)),
    );
  return (
    <Dialog
      open
      onOpenChange={(open, details) => {
        if (open) return;
        if (
          composing.current ||
          (details.event instanceof KeyboardEvent &&
            (details.event.isComposing || details.event.keyCode === 229))
        ) {
          details.cancel();
          return;
        }
        if (creating) {
          details.cancel();
          back.current?.(details.event);
        } else onClose();
      }}
    >
      <DialogPopup
        className="grid gap-3"
        size="lg"
        initialFocus={search}
        finalFocus={restoreFocus}
        showCloseButton={false}
        aria-label={creating ? r('createSkill') : t('add')}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onClickCapture={(e) => {
          if (composing.current) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
        onKeyDownCapture={(e) => {
          if (
            (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) &&
            ['Enter', ' ', 'Escape'].includes(e.key)
          ) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
      >
        {creating ? (
          <ResourceEditor
            embedded
            backRef={back}
            kind="skill"
            api={api}
            onClose={() => {
              setCreating(false);
              requestAnimationFrame(() => createButton.current?.focus());
            }}
            onSaved={(resourceHash, entry) => {
              setQuery('');
              setCreating(false);
              awaitingInstall.current = true;
              setCreated({ resourceHash, entry: entry ?? 'skills/SKILL.md' });
              window.dispatchEvent(new Event('corral:harness-changed'));
            }}
          />
        ) : (
          <>
            <DialogTitle>{t('add')}</DialogTitle>
            {replacement ? (
              <p className="text-caption">{t('replacing', { name: label(replacement) })}</p>
            ) : null}
            <Input
              ref={search}
              aria-label={r('skillSearch')}
              placeholder={r('skillSearch')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {catalog === 'failed' ? (
              <div role="alert" className="flex items-center gap-2 text-body">
                {l('loadFailed')}
                <Button variant="tertiary" onClick={refresh}>
                  {l('retry')}
                </Button>
              </div>
            ) : !ready ? (
              <p role="status" className="text-caption">
                {l('resources.loading')}
              </p>
            ) : filtered.length ? (
              <CheckboxGroup
                ref={rows}
                aria-label={r('skills')}
                checkedIndices={
                  new Set(
                    filtered.flatMap((entry, i) =>
                      checked.has(keyOf(entry)) || required.has(keyOf(entry)) ? [i] : [],
                    ),
                  )
                }
                className="w-full"
              >
                {filtered.map((entry, index) => {
                  const key = keyOf(entry),
                    policy = required.get(key),
                    isChecked = checked.has(key) || Boolean(policy),
                    disabled = Boolean(policy) || (!isChecked && !usable(entry, ready));
                  const state = skillState(entry, ready.disabled);
                  const mark =
                    policy ?? (saved === key && !state ? t('saved') : state ? r(state) : null);
                  return (
                    <div key={key} className="relative min-w-0 py-1">
                      <CheckboxItem
                        index={index}
                        label={entry.name}
                        checked={isChecked}
                        disabled={disabled}
                        tabIndex={disabled && created && keyOf(created) === key ? -1 : undefined}
                        aria-describedby={`${id}-${index}`}
                        data-entry={key}
                        onToggle={() => select(entry)}
                      />
                      <div
                        id={`${id}-${index}`}
                        className="relative z-10 flex flex-wrap items-center gap-x-2 gap-y-1 px-3 pb-1 pl-9 text-caption text-muted-foreground"
                      >
                        <span className="break-words">{entry.description}</span>
                        {mark ? <Badge variant="secondary">{mark}</Badge> : null}
                      </div>
                    </div>
                  );
                })}
              </CheckboxGroup>
            ) : (
              <p className="text-body text-muted-foreground">
                {needle ? r('noMatches') : t('noSkills')}
              </p>
            )}
            <Button
              ref={createButton}
              variant="tertiary"
              className="justify-self-start"
              onClick={() => setCreating(true)}
            >
              <Plus aria-hidden />
              {r('createSkill')}
            </Button>
            <DialogFooter>
              <Button variant="ghost" onClick={onClose}>
                {r('cancel')}
              </Button>
              <Button disabled={!canApply} onClick={() => onApply([...checks])}>
                {applyLabel}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogPopup>
    </Dialog>
  );
}

function SkillDetail({
  api,
  catalog,
  selected,
  pinned,
  label,
  mode,
  targetLabel,
  applyLabel,
  onApply,
  onClose,
  restoreFocus,
  refresh,
}: DialogProps &
  Pick<RoleSkillsProps, 'mode' | 'targetLabel'> & { pinned: RoleSkillRef; label: string }) {
  const t = useTranslations('TeamEditor.skills'),
    r = useTranslations('Resources'),
    l = useTranslations('Library'),
    h = useTranslations('Harness');
  const [adopting, setAdopting] = useState(false);
  const [read, setRead] = useState<RoleSkillRef | null>(null);
  const [trusting, setTrusting] = useState(false),
    [trustFailed, setTrustFailed] = useState(false);
  const ready = catalog && catalog !== 'failed' ? catalog : null;
  const original = ready?.entries.find((e) => keyOf(e) === keyOf(pinned));
  const versions = ready && original ? versionsOf(original, ready.entries) : null;
  const newer =
    versions && versions.index < versions.chain.length - 1 ? versions.chain.at(-1) : null;
  const entry = adopting ? newer : original;
  const canAdopt =
    ready &&
    entry &&
    usable(entry, ready) &&
    read &&
    keyOf(read) === keyOf(entry) &&
    !selected.some((s) => keyOf(s) === keyOf(entry));
  const reviewButton = useRef<HTMLButtonElement>(null);
  function back() {
    setAdopting(false);
    setRead(null);
    requestAnimationFrame(() => reviewButton.current?.focus());
  }
  return (
    <Dialog
      open
      onOpenChange={(open, details) => {
        if (open) return;
        if (
          details.event instanceof KeyboardEvent &&
          (details.event.isComposing || details.event.keyCode === 229)
        ) {
          details.cancel();
          return;
        }
        if (adopting) {
          details.cancel();
          back();
        } else onClose();
      }}
    >
      <DialogPopup
        className="grid gap-3"
        size="lg"
        finalFocus={restoreFocus}
        showCloseButton={!adopting}
      >
        <DialogTitle>{entry?.name ?? label}</DialogTitle>
        {entry && versions && ready ? (
          <>
            {versions.chain.length > 1 ? (
              <p className="text-caption text-muted-foreground">
                {r('versionNumber', {
                  number: adopting ? versions.chain.length : versions.index + 1,
                })}
              </p>
            ) : null}
            <p className="break-words text-body">{entry.description}</p>
            <EntryContent key={keyOf(entry)} api={api} entry={entry} onRead={setRead} />
            {adopting || !entry.resource.trustedAt ? (
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary">
                  {entry.resource.trustedAt ? h('trusted') : r('needsTrust')}
                </Badge>
                {!entry.resource.trustedAt ? (
                  <Button
                    variant="tertiary"
                    disabled={trusting || !read || keyOf(read) !== keyOf(entry)}
                    onClick={async () => {
                      setTrusting(true);
                      setTrustFailed(false);
                      try {
                        await api.trust(entry.resourceHash, true);
                        window.dispatchEvent(new Event('corral:harness-changed'));
                      } catch {
                        setTrustFailed(true);
                      } finally {
                        setTrusting(false);
                      }
                    }}
                  >
                    {r('trustSkill')}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {!entry.resource.trustedAt && entry.resource.fileCount > 1 ? (
              <p className="text-caption text-muted-foreground">{r('packageTrust')}</p>
            ) : null}
            {trustFailed ? (
              <p role="alert" className="text-caption text-destructive">
                {h('error')}
              </p>
            ) : null}
            {adopting ? (
              <DialogFooter>
                <Button variant="ghost" onClick={back}>
                  {l('back')}
                </Button>
                <Button
                  disabled={!canAdopt}
                  onClick={() =>
                    onApply(selected.map((s) => (keyOf(s) === keyOf(pinned) ? toRef(entry) : s)))
                  }
                >
                  {applyLabel}
                </Button>
              </DialogFooter>
            ) : newer ? (
              <Button
                ref={reviewButton}
                variant="tertiary"
                onClick={() => {
                  setAdopting(true);
                  setRead(null);
                }}
              >
                {mode === 'seat' ? t('adoptSeat', { name: targetLabel }) : t('adoptOriginal')}
              </Button>
            ) : null}
          </>
        ) : (
          <div role="alert" className="flex items-center gap-2 text-caption">
            {catalog === 'failed' ? l('loadFailed') : t('missing')}
            <Button variant="tertiary" onClick={refresh}>
              {l('retry')}
            </Button>
          </div>
        )}
      </DialogPopup>
    </Dialog>
  );
}
