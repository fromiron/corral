import type { HarnessApi } from '@corral/client';
import {
  Badge,
  Button,
  Collapse,
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
  DisclosureChevron,
  focusRingInset,
  fontWeights,
  Input,
  ScrollArea,
  Select,
  Switch,
} from '@corral/react/design-kit';
import { Plus, Trash2 } from '@corral/react/icons';
import { Link } from '@tanstack/react-router';
import { type RefObject, useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useSettingsNavigation } from '../navigation.ts';
import { useSettingsCommand, useSettingsForm, useSettingsTask } from '../SettingsLifecycle.tsx';
import { useManagementConfirmation } from './ConfirmAction.tsx';
import { operationId } from './Target.tsx';

const NOTHING_TO_COMPARE = 'new';
type PackageView = Awaited<ReturnType<HarnessApi['packages']>>[number];
type PackageReview = Awaited<ReturnType<HarnessApi['reviewPackage']>>;

/** Installation reviews immutable bytes; activation still uses existing trust and profiles. */
export function PackageManager({ api, onChanged }: { api: HarnessApi; onChanged: () => void }) {
  const t = useTranslations('Packages');
  const resourcesText = useTranslations('Resources');
  const n = useTranslations('Navigation');
  const navigation = useSettingsNavigation();
  const confirmation = useManagementConfirmation();
  const sourceId = useId();
  const [packages, setPackages] = useState<PackageView[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<'local' | 'package'>('local');
  const [source, setSource] = useState('');
  const [previousHash, setPreviousHash] = useState('');
  const [review, setReview] = useState<PackageReview | null>(null);
  const reviewId = useRef<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const pendingManagement = useSettingsCommand<{ key: string; operationId: string }>(
    'package-management',
  );
  const pendingRegistration = useSettingsCommand<{
    key: string;
    expectedRevision: number;
    operationId: string;
  }>('package-registration');
  const alive = useRef(true);
  const working = useRef(false);
  const add = useRef<HTMLButtonElement>(null);
  const backToSource = useRef(false);
  // Manage on a package row in the library (features/library.md): packages have no list to
  // choose from, so the page goes to that package's line and puts focus there, once.
  const [carried] = useState(navigation.item);
  const arrived = useRef(false);
  const carriedRow = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (reviewId.current && !working.current)
        void api.cancelReview(reviewId.current).catch(() => {});
    };
  }, [api]);
  useEffect(() => {
    let current = true;
    void revision;
    void api.packages().then(
      (value) => {
        if (current) setPackages(value);
      },
      (failure) => {
        if (current) setError(String(failure));
      },
    );
    return () => {
      current = false;
    };
  }, [api, revision]);

  useEffect(() => {
    if (packages === null || arrived.current) return;
    arrived.current = true;
    carriedRow.current?.scrollIntoView({ block: 'nearest' });
    carriedRow.current?.focus({ preventScroll: true });
  }, [packages]);

  const runSettingsTask = useSettingsTask('packages');
  const confirmLeave = useSettingsForm({ dirty: Boolean(source || review), pending: busy });
  async function work(action: () => Promise<void>) {
    if (busy) return;
    working.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await runSettingsTask(action);
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      working.current = false;
      if (alive.current) setBusy(false);
    }
  }
  function refresh() {
    if (!alive.current) return;
    setRevision((value) => value + 1);
    onChanged();
  }
  function forgetSource() {
    reviewId.current = null;
    setReview(null);
    setSource('');
    setPreviousHash('');
    setKind('local');
    setAdding(false);
    add.current?.focus();
  }
  async function closeAdding(event?: Event) {
    if (event instanceof KeyboardEvent && (event.isComposing || event.keyCode === 229)) return;
    if (busy || !(await confirmLeave())) return;
    const abandoned = reviewId.current;
    forgetSource();
    setError('');
    if (abandoned) void api.cancelReview(abandoned).catch(() => {});
  }
  function manage(item: PackageView, status: 'enabled' | 'disabled' | 'removed') {
    return work(async () => {
      const key = JSON.stringify([item.resource.hash, item.managementRevision, status]);
      if (pendingManagement.current?.key !== key)
        pendingManagement.current = { key, operationId: operationId() };
      await api.managePackage(
        item.resource.hash,
        item.managementRevision,
        status,
        pendingManagement.current.operationId,
      );
      pendingManagement.current = null;
      refresh();
    });
  }
  function registerMcp(item: PackageView, contributionId: string) {
    const projectId = navigation.projectId;
    if (!projectId || item.status !== 'enabled') return;
    return work(async () => {
      const key = JSON.stringify([item.resource.hash, contributionId, projectId]);
      if (pendingRegistration.current?.key !== key) {
        const current = await api.projectTools(projectId);
        pendingRegistration.current = {
          key,
          expectedRevision: current?.revision ?? 0,
          operationId: operationId(),
        };
      }
      await api.registerPackageMcp(
        item.resource.hash,
        contributionId,
        projectId,
        pendingRegistration.current.expectedRevision,
        pendingRegistration.current.operationId,
      );
      pendingRegistration.current = null;
      if (alive.current) setNotice(t('registeredMcp'));
    });
  }

  return (
    <section className="flex flex-col gap-4 border-t border-line pt-6" aria-label={t('title')}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-subtitle" style={{ fontVariationSettings: fontWeights.semibold }}>
          {t('title')}
        </h3>
        <Button
          ref={add}
          variant="tertiary"
          onClick={() => {
            setError('');
            setNotice('');
            setAdding(true);
          }}
        >
          <Plus size={16} />
          {t('add')}
        </Button>
      </div>
      <p className="text-caption text-muted-foreground">{t('nextRun')}</p>
      {packages === null ? (
        <p role="status">{t('busy')}</p>
      ) : packages.length === 0 ? (
        <p className="text-body text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul
          aria-label={t('installed')}
          className="settings-list divide-y divide-line overflow-hidden"
        >
          {packages.map((item) => (
            <PackageRow
              key={item.resource.hash}
              item={item}
              busy={busy}
              projectChosen={Boolean(navigation.projectId)}
              carried={carried === item.resource.hash ? carriedRow : undefined}
              onTrust={(trusted) =>
                void work(async () => {
                  await api.trust(item.resource.hash, trusted);
                  refresh();
                })
              }
              onManage={(status) => void manage(item, status)}
              onRemove={() =>
                confirmation.request(t('removeConfirm'), () => void manage(item, 'removed'))
              }
              onRegisterMcp={(id) => void registerMcp(item, id)}
            />
          ))}
        </ul>
      )}
      <Button
        variant="tertiary"
        className="self-start"
        render={<Link {...navigation.link('harness')} />}
      >
        {n('addToWorkStyle')}
      </Button>
      {notice ? (
        <p role="status" className="text-body">
          {notice}{' '}
          <Link {...navigation.link('mcp')} className="underline">
            {t('mcpSettings')}
          </Link>
        </p>
      ) : null}
      {error && !adding ? (
        <p role="alert" className="text-body text-danger">
          {error}
        </p>
      ) : null}
      {adding ? (
        <Dialog
          open
          onOpenChange={(open, details) => {
            if (open) return;
            details.cancel();
            void closeAdding(details.event);
          }}
        >
          <DialogPopup size="lg" className="overflow-hidden" finalFocus={add}>
            <form
              className="grid max-h-[calc(90dvh-3rem)] grid-rows-[auto_minmax(0,1fr)_auto] text-body"
              onSubmit={(event) => {
                event.preventDefault();
                if (review || !source.trim()) return;
                void work(async () => {
                  const result = await api.reviewPackage(
                    kind,
                    source.trim(),
                    previousHash || undefined,
                  );
                  if (alive.current) {
                    reviewId.current = result.reviewId;
                    setReview(result);
                  } else await api.cancelReview(result.reviewId);
                });
              }}
            >
              <DialogHeader>
                <DialogTitle>{t('add')}</DialogTitle>
              </DialogHeader>
              <ScrollArea scrollFade className="-m-1 h-auto w-[calc(100%+0.5rem)]">
                <div className="p-1">
                  {review ? (
                    <ReviewedCopy review={review} />
                  ) : (
                    <fieldset disabled={busy} className="flex min-w-0 flex-col gap-4">
                      <div className="flex flex-col gap-1">
                        {t('sourceKind')}
                        <Select
                          className="h-9 w-full justify-between"
                          label={t('sourceKind')}
                          value={kind}
                          onValueChange={setKind}
                          disabled={busy}
                          options={[
                            { value: 'local', label: t('local') },
                            { value: 'package', label: t('package') },
                          ]}
                        />
                      </div>
                      <label htmlFor={sourceId} className="flex flex-col gap-1">
                        {t('source')}
                        <Input
                          id={sourceId}
                          ref={(field) => {
                            if (!field || !backToSource.current) return;
                            backToSource.current = false;
                            field.focus();
                          }}
                          value={source}
                          onChange={(event) => setSource(event.target.value)}
                          required
                        />
                      </label>
                      <div className="flex flex-col gap-1">
                        {t('compare')}
                        <Select
                          className="h-9 w-full justify-between"
                          label={t('compare')}
                          value={previousHash || NOTHING_TO_COMPARE}
                          onValueChange={(value) =>
                            setPreviousHash(value === NOTHING_TO_COMPARE ? '' : value)
                          }
                          disabled={busy}
                          options={[
                            { value: NOTHING_TO_COMPARE, label: t('newPackage') },
                            ...(packages ?? []).map((item) => ({
                              value: item.resource.hash,
                              label: `${item.resource.name} · ${item.resource.version}`,
                            })),
                          ]}
                        />
                      </div>
                    </fieldset>
                  )}
                </div>
              </ScrollArea>
              <div>
                {error ? (
                  <p role="alert" className="mt-4 text-body text-danger">
                    {error}
                  </p>
                ) : null}
                <DialogFooter className="flex-wrap">
                  {review ? (
                    <Button
                      variant="ghost"
                      className="mr-auto"
                      disabled={busy}
                      onClick={() =>
                        void work(async () => {
                          await api.cancelReview(review.reviewId);
                          reviewId.current = null;
                          backToSource.current = true;
                          if (alive.current) setReview(null);
                        })
                      }
                    >
                      {t('changeSource')}
                    </Button>
                  ) : null}
                  <Button variant="tertiary" disabled={busy} onClick={() => void closeAdding()}>
                    {resourcesText('cancel')}
                  </Button>
                  {review ? (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void work(async () => {
                          await api.install(review.reviewId);
                          if (alive.current) forgetSource();
                          refresh();
                        })
                      }
                    >
                      {t('install')}
                    </Button>
                  ) : (
                    <Button type="submit" disabled={busy || !source.trim()}>
                      {t('review')}
                    </Button>
                  )}
                </DialogFooter>
              </div>
            </form>
          </DialogPopup>
        </Dialog>
      ) : null}
      {confirmation.dialog}
    </section>
  );
}

function PackageRow({
  item,
  busy,
  projectChosen,
  carried,
  onTrust,
  onManage,
  onRemove,
  onRegisterMcp,
}: {
  item: PackageView;
  busy: boolean;
  projectChosen: boolean;
  carried: RefObject<HTMLButtonElement | null> | undefined;
  onTrust: (trusted: boolean) => void;
  onManage: (status: 'enabled' | 'disabled') => void;
  onRemove: () => void;
  onRegisterMcp: (id: string) => void;
}) {
  const t = useTranslations('Packages');
  const h = useTranslations('Harness');
  const resourcesText = useTranslations('Resources');
  const [open, setOpen] = useState(false);
  const row = useRef<HTMLButtonElement | null>(null);
  const keepingFocusOnRow = <T,>(act: (value: T) => void) => {
    return (value: T) => {
      row.current?.focus();
      act(value);
    };
  };
  const id = useId();
  const name = `${id}name`;
  const version = `${id}version`;
  const trust = `${id}trust`;
  const status = `${id}status`;
  const details = `${id}details`;
  const removed = item.status === 'removed';
  const untrusted = !removed && !item.resource.trustedAt;
  const off = item.status !== 'enabled';
  return (
    <li className="@container">
      <div className="relative grid min-h-12 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-4 py-2 transition-colors duration-(--duration-fast) has-[>button:hover]:bg-hover motion-reduce:transition-none @md:grid-cols-[minmax(0,1fr)_auto_auto]">
        <button
          ref={(button) => {
            row.current = button;
            if (carried) carried.current = button;
          }}
          type="button"
          aria-expanded={open}
          aria-controls={details}
          aria-labelledby={[name, version, untrusted ? trust : '', off ? status : '']
            .filter(Boolean)
            .join(' ')}
          className={`absolute inset-0 cursor-pointer ${focusRingInset}`}
          onClick={() => setOpen(!open)}
        />
        <span className="pointer-events-none flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span
            id={name}
            className={`min-w-0 truncate ${removed ? 'text-muted-foreground' : ''}`}
            style={{ fontVariationSettings: fontWeights.semibold }}
          >
            {item.resource.name}
          </span>
          <span id={version} className="shrink-0 text-caption text-muted-foreground">
            {item.resource.version}
          </span>
          {untrusted ? (
            <Badge id={trust} variant="warning" className="shrink-0">
              {t('untrusted')}
            </Badge>
          ) : null}
          {off ? (
            <Badge id={status} className="shrink-0">
              {t(item.status)}
            </Badge>
          ) : null}
        </span>
        {removed || untrusted ? (
          <Button
            variant="secondary"
            size="compact"
            className="relative col-start-1 row-start-2 justify-self-start @md:col-start-2 @md:row-start-1"
            aria-describedby={name}
            disabled={busy}
            onClick={() =>
              removed ? keepingFocusOnRow(onManage)('disabled') : keepingFocusOnRow(onTrust)(true)
            }
          >
            {removed ? resourcesText('restore') : h('trust')}
          </Button>
        ) : null}
        <DisclosureChevron
          open={open}
          className="pointer-events-none col-start-2 row-start-1 @md:col-start-3"
        />
      </div>
      {untrusted && item.resource.extensions.length ? (
        <p className="px-4 pb-3 text-caption text-muted-foreground">{h('nativeWarning')}</p>
      ) : null}
      <Collapse id={details} open={open} hideWhenClosed>
        <fieldset aria-labelledby={name} className="flex min-w-0 flex-col gap-3 px-4 pt-1 pb-4">
          <PackageMetadata
            resource={item.resource}
            manifest={item.manifest}
            onRegisterMcp={onRegisterMcp}
            registerDisabled={busy || off || !projectChosen}
          />
          {item.manifest?.mcpServers.length && !projectChosen ? (
            <p className="text-caption text-muted-foreground">{t('chooseProject')}</p>
          ) : null}
          <p className="text-caption text-muted-foreground">
            {t('profiles')}:{' '}
            {item.profiles.length
              ? item.profiles.map((profile) => `${profile.name} · r${profile.revision}`).join(', ')
              : t('unused')}
          </p>
          {removed ? null : (
            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
              <Switch
                className="pl-0"
                label={t('enabled')}
                checked={!off}
                disabled={busy}
                onToggle={() => onManage(off ? 'enabled' : 'disabled')}
              />
              {untrusted ? null : (
                <Button
                  variant="tertiary"
                  size="compact"
                  disabled={busy}
                  onClick={() => keepingFocusOnRow(onTrust)(false)}
                >
                  {h('revoke')}
                </Button>
              )}
              <Button
                variant="destructive-outline"
                size="compact"
                className="ml-auto"
                disabled={busy}
                onClick={keepingFocusOnRow(onRemove)}
              >
                <Trash2 aria-hidden />
                {t('remove')}
              </Button>
            </div>
          )}
        </fieldset>
      </Collapse>
    </li>
  );
}

function ReviewedCopy({ review }: { review: PackageReview }) {
  const t = useTranslations('Packages');
  return (
    <section
      ref={(reviewed) => reviewed?.focus()}
      tabIndex={-1}
      className="flex flex-col gap-3 outline-none"
      aria-label={t('reviewed')}
    >
      <h3 style={{ fontVariationSettings: fontWeights.semibold }}>
        {t('reviewed')} · {review.resource.name} · {review.resource.version}
      </h3>
      {review.previous ? (
        <p className="text-caption text-muted-foreground">
          {t('compare')}: {review.previous.name} · {review.previous.version}
        </p>
      ) : null}
      <PackageMetadata resource={review.resource} manifest={review.manifest} />
      {review.changes ? (
        <div className="flex flex-col gap-2 text-caption">
          {(['added', 'changed', 'removed'] as const).map((kind) =>
            review.changes?.[kind].length ? (
              <div key={kind}>
                <h4 style={{ fontVariationSettings: fontWeights.semibold }}>
                  {t(kind === 'removed' ? 'deleted' : kind)}
                </h4>
                <ul className="max-h-40 overflow-auto font-mono">
                  {review.changes[kind].map((path) => (
                    <li key={path} className="break-all">
                      {path}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null,
          )}
          {!review.changes.added.length &&
          !review.changes.changed.length &&
          !review.changes.removed.length ? (
            <p>{t('noChanges')}</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function PackageMetadata({
  resource,
  manifest,
  onRegisterMcp,
  registerDisabled,
}: {
  resource: PackageReview['resource'];
  manifest: PackageReview['manifest'];
  onRegisterMcp?: (id: string) => void;
  registerDisabled?: boolean;
}) {
  const t = useTranslations('Packages');
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-caption">
        <dt className="text-muted-foreground">{t('license')}</dt>
        <dd>{resource.license ?? t('unknown')}</dd>
        <dt className="text-muted-foreground">{t('skills')}</dt>
        <dd>{resource.skills.map((skill) => skill.name).join(', ') || '—'}</dd>
        <dt className="text-muted-foreground">{t('extensions')}</dt>
        <dd className="break-all">{resource.extensions.join(', ') || '—'}</dd>
        <dt className="text-muted-foreground">{t('permissions')}</dt>
        <dd className="break-all">
          {manifest ? manifest.requestedCapabilities.join(', ') || '—' : t('unknown')}
        </dd>
      </dl>
      {manifest?.mcpServers.length ? (
        <section aria-label={t('mcp')} className="text-caption">
          <h4 style={{ fontVariationSettings: fontWeights.semibold }}>{t('mcp')}</h4>
          <ul className="mt-1 flex flex-col gap-1">
            {manifest.mcpServers.map((server) => (
              <li key={server.id}>
                {server.name} · {server.transport}
                <p className="break-all font-mono text-muted-foreground">
                  {server.transport === 'http' ? server.url : server.argv.join(' ')}
                </p>
                {onRegisterMcp ? (
                  <Button
                    variant="tertiary"
                    size="compact"
                    className="mt-1"
                    disabled={registerDisabled}
                    onClick={() => onRegisterMcp(server.id)}
                  >
                    {t('registerMcp')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {manifest?.ui.map((detail) => (
        <section key={detail.id} className="text-caption">
          <h4 style={{ fontVariationSettings: fontWeights.semibold }}>{detail.title}</h4>
          <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">
            {detail.body}
          </p>
        </section>
      ))}
    </div>
  );
}
