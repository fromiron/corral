import type { HarnessApi } from '@corral/client';
import type {
  HarnessPreviewRole,
  RegisteredMcpServer,
  RoleMcpToolProblem,
  RoleMcpToolRef,
} from '@corral/contracts';
import { Button } from '@corral/react/design-kit';
import { Plus, X } from '@corral/react/icons';
import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';
import { useSettingsNavigation } from './navigation.ts';
import { RoleToolPicker, roleToolKey } from './RoleToolPicker.tsx';

const noTools: readonly RoleMcpToolRef[] = [];
const noServers: readonly RegisteredMcpServer[] = [];
interface Props {
  role: HarnessPreviewRole;
  projectId: string;
  sessionId?: string | undefined;
  mode: 'seat' | 'original';
  targetLabel: string;
  revealPolicy(): void;
  onApply(next: RoleMcpToolRef[]): void;
}

export function RoleTools(props: Props) {
  const { harnesses } = useServices();
  const t = useTranslations('Library.resources');
  return harnesses ? (
    <ServerRoleTools key={props.projectId} {...props} api={harnesses} />
  ) : (
    <p className="text-caption text-muted-foreground">{t('localOnly')}</p>
  );
}

function ServerRoleTools({
  api,
  role: { id, harness, skills, mcpTools },
  projectId,
  sessionId,
  mode,
  targetLabel,
  onApply,
  revealPolicy,
}: Props & { api: HarnessApi }) {
  const t = useTranslations('TeamEditor.roleTools');
  const l = useTranslations('Library');
  const navigation = useSettingsNavigation();
  const selected = mcpTools ?? noTools;
  const [open, setOpen] = useState(false);
  const add = useRef<HTMLButtonElement>(null);
  const [catalog, setCatalog] = useState<readonly RegisteredMcpServer[] | 'loading' | 'failed'>(
    'loading',
  );
  const [problem, setProblem] = useState<RoleMcpToolProblem | 'failed' | null>(null);
  // Raw probe names are display-only and live no longer than the seat form.
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const needsCatalog = open || selected.length > 0;
  const paused = Boolean(navigation.overlay);
  useEffect(() => {
    void catalogAttempt;
    if (!needsCatalog) return;
    setCatalog('loading');
    if (paused) return;
    let active = true;
    void api.projectTools(projectId).then(
      (config) => active && setCatalog(config?.mcpServers ?? noServers),
      () => active && setCatalog('failed'),
    );
    return () => {
      active = false;
    };
  }, [api, projectId, needsCatalog, paused, catalogAttempt]);
  useEffect(() => {
    void previewAttempt;
    setProblem(null);
    if (!mcpTools?.length || paused) return;
    let active = true;
    void api.preview({ id, harness, skills, mcpTools }, projectId).then(
      (preview) => {
        if (active)
          setProblem(
            preview.snapshot ? null : (preview.mcpProblem ?? (preview.problem ? null : 'failed')),
          );
      },
      () => active && setProblem('failed'),
    );
    return () => {
      active = false;
    };
  }, [api, projectId, id, harness, skills, mcpTools, paused, previewAttempt]);
  const servers = typeof catalog === 'string' ? noServers : catalog;
  const manageConnections = (
    <Button
      variant="tertiary"
      size="compact"
      render={<Link {...navigation.link('mcp', projectId)} />}
    >
      {t('manage')}
    </Button>
  );
  return (
    <div className="grid min-w-0 gap-2">
      {selected.map((ref) => {
        const { name, serverId } = ref;
        const serverName = servers.find((s) => s.id === serverId)?.name ?? serverId;
        const key = roleToolKey(serverId, name);
        const label = `${serverName} · ${names.get(key) ?? name.slice(`mcp__${serverId}__`.length)}`;
        const reason =
          problem && problem !== 'failed'
            ? problem.tools.find((p) => p.name === name && p.serverId === serverId)?.reason
            : undefined;
        return (
          <div key={key} className="grid min-w-0 gap-1">
            <div className="flex min-w-0 items-center justify-between gap-1">
              <span className="min-w-0 break-words text-body">{label}</span>
              <Button
                variant="ghost"
                size="icon-compact"
                aria-label={t('deselect', { name: label })}
                onClick={() =>
                  onApply(
                    selected.filter((item) => item.serverId !== serverId || item.name !== name),
                  )
                }
              >
                <X aria-hidden />
              </Button>
            </div>
            {reason ? (
              <div className="flex flex-wrap items-center gap-2 text-caption">
                <span role="alert" className="text-destructive">
                  {t(`reason.${reason}`)}
                </span>
                {reason === 'server_missing' || reason === 'server_disabled' ? (
                  manageConnections
                ) : (
                  <Button variant="tertiary" size="compact" onClick={revealPolicy}>
                    {t('policy')}
                  </Button>
                )}
              </div>
            ) : null}
          </div>
        );
      })}
      {selected.length && catalog === 'failed' ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-caption">
          {t('catalogFailed')}
          <Button variant="tertiary" size="compact" onClick={() => setCatalogAttempt((n) => n + 1)}>
            {l('retry')}
          </Button>
        </div>
      ) : null}
      {problem === 'failed' ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-caption">
          {t('unconfirmed')}
          <Button variant="tertiary" size="compact" onClick={() => setPreviewAttempt((n) => n + 1)}>
            {l('retry')}
          </Button>
        </div>
      ) : null}
      {selected.length && mode === 'seat' ? (
        <p className="text-caption text-muted-foreground">{t('mock')}</p>
      ) : null}
      <Button
        ref={add}
        variant="tertiary"
        className="justify-self-start"
        onClick={() => setOpen(true)}
      >
        <Plus aria-hidden />
        {t('add')}
      </Button>
      {open ? (
        <RoleToolPicker
          api={api}
          projectId={projectId}
          servers={servers}
          sessionId={sessionId}
          catalogState={typeof catalog === 'string' ? catalog : 'ready'}
          onRetry={() => setCatalogAttempt((n) => n + 1)}
          value={selected}
          mode={mode}
          targetLabel={targetLabel}
          opener={add.current}
          manageConnections={manageConnections}
          onClose={() => setOpen(false)}
          onApply={(next, labels) => {
            setNames((old) => new Map([...old, ...labels]));
            onApply(next);
            setOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}
