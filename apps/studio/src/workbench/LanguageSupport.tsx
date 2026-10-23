import { Button, Select } from '@corral/react/ui';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { useServices } from '../services.tsx';
import type { DocumentBuffer, DocumentStore } from './documents/store.ts';
import { type LanguageStore, languageCopyKey, languageStore } from './language/store.ts';
import { useSettingsNavigation } from './navigation.ts';

export function LanguageSupport({
  owner,
  documentKey,
}: {
  owner: DocumentStore;
  documentKey: string;
}) {
  const { workspaces, mode } = useServices();
  const entry = useStore(owner, (state) => state.documents[documentKey]);
  if (!workspaces || mode !== 'server' || !entry) return null;
  return (
    <LanguageControls key={documentKey} entry={entry} store={languageStore(workspaces, owner)} />
  );
}

function LanguageControls({ entry, store }: { entry: DocumentBuffer; store: LanguageStore }) {
  const t = useTranslations('Language');
  const navigation = useSettingsNavigation();
  const target = entry.target;
  const key = languageCopyKey(target);
  const copy = useStore(store, (state) => state.copies[key]);
  const [selected, select] = useState('');
  useEffect(() => store.retain(target), [store, target]);
  const state = copy?.state;
  const session = state?.session;
  const languageId = entry.model?.getLanguageId();
  const servers = (state?.servers ?? []).filter(
    (server) =>
      server.fileExtensions.some((extension) => entry.path.endsWith(extension)) ||
      (languageId && server.languageIds.includes(languageId)),
  );
  const serverId = servers.some((server) => server.id === selected)
    ? selected
    : (servers[0]?.id ?? '');
  const inspection =
    copy?.inspection?.server.id === serverId && languageCopyKey(copy.inspection.target) === key
      ? copy.inspection
      : null;
  const error = copy?.error ?? session?.error;
  const capabilities = session?.capabilities;
  return (
    <section aria-label={t('label')} className="flex min-w-0 flex-col gap-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted">{t('label')}</span>
        {session ? (
          <>
            <span role="status">
              {state?.servers.find((server) => server.id === session.serverId)?.name ??
                session.serverId}
              {' · '}
              {t(session.state)}
            </span>
            <Button
              size="xs"
              variant="outline"
              disabled={copy?.busy}
              onClick={() => void store.stop(target)}
            >
              {t('stop')}
            </Button>
          </>
        ) : state && !state.available ? (
          <span className="text-muted">
            {t(state.unavailableReason === 'platform' ? 'unsupportedPlatform' : 'untrustedCopy')}
          </span>
        ) : servers.length ? (
          <>
            <Select
              label={t('server')}
              size="xs"
              value={serverId}
              onValueChange={select}
              options={servers.map((server) => ({ value: server.id, label: server.name }))}
              disabled={copy?.busy}
            />
            <Button
              size="xs"
              variant="outline"
              disabled={copy?.busy}
              onClick={() => void store.inspect(target, serverId)}
            >
              {t('review')}
            </Button>
            {inspection ? (
              <Button
                size="xs"
                disabled={copy?.busy}
                onClick={() => void store.start(target, !inspection.trusted)}
              >
                {t(inspection.trusted ? 'start' : 'trustStart')}
              </Button>
            ) : null}
          </>
        ) : state ? (
          <>
            <span className="text-muted">{t('noServer')}</span>
            <Link
              {...navigation.link('workspace', target.projectId)}
              className="text-accent underline"
            >
              {t('settings')}
            </Link>
          </>
        ) : !error ? (
          <span role="status" className="text-muted">
            {t('loading')}
          </span>
        ) : null}
      </div>
      {!session && state?.available && inspection ? (
        <div className="flex min-w-0 flex-col gap-1 rounded-md fill-group p-2">
          <code className="break-all whitespace-pre-wrap">
            {JSON.stringify(inspection.server.argv)}
          </code>
          <span className="break-all text-muted">
            {t('fingerprint')}: {inspection.fingerprint}
          </span>
          {!inspection.trusted ? <p className="text-muted">{t('trustNote')}</p> : null}
        </div>
      ) : null}
      {session?.state === 'running' && session.clientId !== store.clientId ? (
        <p className="text-muted">{t('otherWindow')}</p>
      ) : null}
      {session?.state === 'failed' || session?.state === 'uncertain' ? (
        <p className="text-muted">{t('recoveryNote')}</p>
      ) : session?.state === 'running' && capabilities ? (
        <p className="text-muted">
          {(['completion', 'definition', 'references', 'diagnostics'] as const)
            .filter((capability) => capabilities[capability])
            .map((capability) => t(capability))
            .join(' · ')}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}
