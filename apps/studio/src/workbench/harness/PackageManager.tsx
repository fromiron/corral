import type { HarnessApi } from '@corral/client';
import { Button, Input, Select } from '@corral/react/ui';
import { Link } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useSettingsNavigation } from '../navigation.ts';
import { useManagementConfirmation } from './ConfirmAction.tsx';
import { operationId } from './Target.tsx';

type PackageView = Awaited<ReturnType<HarnessApi['packages']>>[number];
type PackageReview = Awaited<ReturnType<HarnessApi['reviewPackage']>>;

/** Installation reviews immutable bytes; activation still uses existing trust and profiles. */
export function PackageManager({ api, onChanged }: { api: HarnessApi; onChanged: () => void }) {
  const t = useTranslations('Packages');
  const resourcesText = useTranslations('Resources');
  const h = useTranslations('Harness');
  const n = useTranslations('Navigation');
  const navigation = useSettingsNavigation();
  const confirmation = useManagementConfirmation();
  const sourceId = useId();
  const [packages, setPackages] = useState<PackageView[] | null>(null);
  const [kind, setKind] = useState<'local' | 'package'>('local');
  const [source, setSource] = useState('');
  const [previousHash, setPreviousHash] = useState('');
  const [review, setReview] = useState<PackageReview | null>(null);
  const reviewId = useRef<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const pendingManagement = useRef<{ key: string; operationId: string } | null>(null);
  const pendingRegistration = useRef<{
    key: string;
    expectedRevision: number;
    operationId: string;
  } | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (reviewId.current) void api.cancelReview(reviewId.current).catch(() => {});
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

  async function work(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  function refresh() {
    if (!alive.current) return;
    setRevision((value) => value + 1);
    onChanged();
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
      <div>
        <h3 className="text-lg font-semibold">{t('title')}</h3>
        <p className="mt-1 text-sm text-muted">{t('intro')}</p>
      </div>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void work(async () => {
            const result = await api.reviewPackage(kind, source.trim(), previousHash || undefined);
            if (alive.current) {
              reviewId.current = result.reviewId;
              setReview(result);
            } else await api.cancelReview(result.reviewId);
          });
        }}
      >
        <fieldset disabled={busy || review !== null} className="flex flex-wrap items-end gap-3">
          <Select
            label={t('sourceKind')}
            value={kind}
            onValueChange={setKind}
            disabled={busy || review !== null}
            options={[
              { value: 'local', label: t('local') },
              { value: 'package', label: t('package') },
            ]}
          />
          <label htmlFor={sourceId} className="flex min-w-52 flex-1 flex-col gap-1 text-sm">
            {t('source')}
            <Input
              id={sourceId}
              value={source}
              onChange={(event) => setSource(event.target.value)}
              required
            />
          </label>
          <Select
            label={t('compare')}
            value={previousHash}
            onValueChange={setPreviousHash}
            disabled={busy || review !== null}
            options={[
              { value: '', label: t('newPackage') },
              ...(packages ?? []).map((item) => ({
                value: item.resource.hash,
                label: `${item.resource.name} · ${item.resource.version}`,
              })),
            ]}
          />
          <Button
            type="submit"
            variant="outline"
            disabled={busy || review !== null || !source.trim()}
          >
            {t('review')}
          </Button>
        </fieldset>
      </form>
      {review ? (
        <section className="settings-surface flex flex-col gap-3" aria-label={t('reviewed')}>
          <h4 className="font-medium">
            {t('reviewed')} · {review.resource.name} · {review.resource.version}
          </h4>
          {review.previous ? (
            <p className="text-xs text-muted">
              {t('compare')}: {review.previous.name} · {review.previous.version}
            </p>
          ) : null}
          <PackageMetadata resource={review.resource} manifest={review.manifest} />
          {review.changes ? (
            <div className="flex flex-col gap-2 text-xs">
              {(['added', 'changed', 'removed'] as const).map((kind) =>
                review.changes?.[kind].length ? (
                  <div key={kind}>
                    <h5 className="font-medium">{t(kind === 'removed' ? 'deleted' : kind)}</h5>
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
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy}
              onClick={() =>
                void work(async () => {
                  await api.install(review.reviewId);
                  reviewId.current = null;
                  if (alive.current) setReview(null);
                  refresh();
                })
              }
            >
              {t('install')}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void work(async () => {
                  await api.cancelReview(review.reviewId);
                  reviewId.current = null;
                  if (alive.current) setReview(null);
                })
              }
            >
              {t('changeSource')}
            </Button>
          </div>
        </section>
      ) : null}
      <section aria-label={t('installed')} className="flex flex-col gap-3">
        <h4 className="font-medium">{t('installed')}</h4>
        <p className="text-xs text-muted">{t('nextRun')}</p>
        {packages === null ? (
          <p role="status">{t('busy')}</p>
        ) : packages.length === 0 ? (
          <p className="text-sm text-muted">{t('empty')}</p>
        ) : (
          <ul className="settings-list divide-y divide-line">
            {packages.map((item) => (
              <li key={item.resource.hash} className="flex flex-col gap-3 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">
                    {item.resource.name} · {item.resource.version}
                  </span>
                  <span className="text-xs text-muted">
                    {t(item.status)} · {t(item.resource.trustedAt ? 'trusted' : 'untrusted')}
                  </span>
                  <div className="ml-auto flex flex-wrap gap-1">
                    {item.status !== 'removed' ? (
                      <>
                        <Button
                          variant="outline"
                          size="xs"
                          disabled={busy}
                          onClick={() =>
                            void work(async () => {
                              await api.trust(item.resource.hash, !item.resource.trustedAt);
                              refresh();
                            })
                          }
                        >
                          {h(item.resource.trustedAt ? 'revoke' : 'trust')}
                        </Button>
                        <Button
                          variant="outline"
                          size="xs"
                          disabled={busy}
                          onClick={() =>
                            void manage(item, item.status === 'enabled' ? 'disabled' : 'enabled')
                          }
                        >
                          {t(item.status === 'enabled' ? 'disable' : 'enable')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="xs"
                          disabled={busy}
                          onClick={() =>
                            confirmation.request(
                              t('removeConfirm'),
                              () => void manage(item, 'removed'),
                            )
                          }
                        >
                          {t('remove')}
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="outline"
                        size="xs"
                        disabled={busy}
                        onClick={() => void manage(item, 'disabled')}
                      >
                        {resourcesText('restore')}
                      </Button>
                    )}
                  </div>
                </div>
                {item.resource.extensions.length && !item.resource.trustedAt ? (
                  <p className="text-xs text-muted">{h('nativeWarning')}</p>
                ) : null}
                <details>
                  <summary className="cursor-pointer text-xs">{t('declarations')}</summary>
                  <div className="mt-2">
                    <PackageMetadata
                      resource={item.resource}
                      manifest={item.manifest}
                      onRegisterMcp={(id) => void registerMcp(item, id)}
                      registerDisabled={busy || item.status !== 'enabled' || !navigation.projectId}
                    />
                    {item.manifest?.mcpServers.length && !navigation.projectId ? (
                      <p className="mt-2 text-xs text-muted">{t('chooseProject')}</p>
                    ) : null}
                  </div>
                  <p className="mt-2 text-xs text-muted">
                    {t('profiles')}:{' '}
                    {item.profiles.length
                      ? item.profiles
                          .map((profile) => `${profile.name} · r${profile.revision}`)
                          .join(', ')
                      : t('unused')}
                  </p>
                </details>
              </li>
            ))}
          </ul>
        )}
      </section>
      <Button
        variant="outline"
        className="self-start"
        render={<Link to="/settings/harness" search={navigation.search} />}
      >
        {n('addToWorkStyle')}
      </Button>
      {notice ? (
        <p role="status" className="text-sm">
          {notice}{' '}
          <Link to="/settings/mcp" search={navigation.search} className="underline">
            {t('mcpSettings')}
          </Link>
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {confirmation.dialog}
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
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted">{t('license')}</dt>
        <dd>{resource.license ?? t('unknown')}</dd>
        <dt className="text-muted">{t('skills')}</dt>
        <dd>{resource.skills.map((skill) => skill.name).join(', ') || '—'}</dd>
        <dt className="text-muted">{t('extensions')}</dt>
        <dd className="break-all">{resource.extensions.join(', ') || '—'}</dd>
        <dt className="text-muted">{t('permissions')}</dt>
        <dd className="break-all">
          {manifest ? manifest.requestedCapabilities.join(', ') || '—' : t('unknown')}
        </dd>
      </dl>
      {manifest?.mcpServers.length ? (
        <section aria-label={t('mcp')} className="text-xs">
          <h5 className="font-medium">{t('mcp')}</h5>
          <ul className="mt-1 flex flex-col gap-1">
            {manifest.mcpServers.map((server) => (
              <li key={server.id}>
                {server.name} · {server.transport}
                <p className="break-all font-mono text-muted">
                  {server.transport === 'http' ? server.url : server.argv.join(' ')}
                </p>
                {onRegisterMcp ? (
                  <Button
                    variant="outline"
                    size="xs"
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
        <section key={detail.id} className="text-xs">
          <h5 className="font-medium">{detail.title}</h5>
          <p className="mt-1 whitespace-pre-wrap break-words text-muted">{detail.body}</p>
        </section>
      ))}
    </div>
  );
}
