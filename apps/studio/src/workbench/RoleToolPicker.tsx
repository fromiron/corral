import type { HarnessApi, McpProbeResult } from '@corral/client';
import type { RegisteredMcpServer, RoleMcpToolRef } from '@corral/contracts';
import {
  Button,
  CheckboxGroup,
  CheckboxItem,
  cn,
  Dialog,
  DialogFooter,
  DialogPopup,
  DialogTitle,
  Input,
} from '@corral/react/design-kit';
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import {
  inspectMcpConnection,
  McpConnection,
  type McpConnectionCheck,
} from '../pages/McpConnection.tsx';
import { CHOSEN_BUTTON_ROW } from './chosenRow.ts';
import { useSettingsNavigation } from './navigation.ts';

interface PickerProps {
  api: HarnessApi;
  projectId: string;
  servers: readonly RegisteredMcpServer[];
  catalogState: 'loading' | 'ready' | 'failed';
  onRetry(): void;
  sessionId: string | undefined;
  value: readonly RoleMcpToolRef[];
  mode: 'seat' | 'original';
  targetLabel: string;
  onApply(next: RoleMcpToolRef[], labels: ReadonlyMap<string, string>): void;
  manageConnections: ReactNode;
  onClose(): void;
  opener: HTMLElement | null;
}

export const roleToolKey = (serverId: string, name: string) => `${serverId}:${name}`;

export function RoleToolPicker({
  api,
  projectId,
  servers,
  catalogState,
  onRetry,
  sessionId,
  value,
  mode,
  targetLabel,
  onApply,
  manageConnections,
  onClose,
  opener,
}: PickerProps) {
  const t = useTranslations('TeamEditor.toolPicker');
  const role = useTranslations('TeamEditor.roleTools');
  const apply = useTranslations('TeamEditor.skills');
  const r = useTranslations('Resources');
  const l = useTranslations('Library');
  const { overlay } = useSettingsNavigation();
  const inSettings = useRef(overlay);
  inSettings.current = overlay;
  const search = useRef<HTMLInputElement>(null);
  const loading = useRef<HTMLParagraphElement>(null);
  const manage = useRef<HTMLAnchorElement>(null);
  const searchable = catalogState === 'ready' && servers.length > 0;
  const initialTarget = searchable ? search : catalogState === 'loading' ? loading : manage;
  useLayoutEffect(() => {
    if (overlay || catalogState === 'loading') return;
    // If the loading message lost focus when it left, hand it to the first usable action.
    if (document.activeElement === document.body || document.activeElement === opener) {
      initialTarget.current?.focus();
    }
  }, [overlay, catalogState, initialTarget, opener]);
  const composing = useRef(false);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [copies, setCopies] = useState(() => new Map<string, string>());
  const [checks, setChecks] = useState(value);
  const titles = useRef(new Map<string, string>());
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (overlay) return;
    const refresh = () => setRevision((revision) => revision + 1);
    window.addEventListener('focus', refresh);
    window.addEventListener('corral:harness-changed', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('corral:harness-changed', refresh);
    };
  }, [overlay]);
  // Settings owns focus, launch trust and credentials. Unmount any live probe, not the draft.
  if (overlay) return null;
  const checked = new Set(checks.map((ref) => roleToolKey(ref.serverId, ref.name)));
  const changed =
    checked.size !== value.length ||
    value.some((ref) => !checked.has(roleToolKey(ref.serverId, ref.name)));
  const needle = query.trim().toLocaleLowerCase();
  const matches = (server: RegisteredMcpServer) => server.name.toLocaleLowerCase().includes(needle);
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
        } else onClose();
      }}
    >
      <DialogPopup
        size="lg"
        className="grid min-w-0 gap-3"
        aria-label={role('add')}
        initialFocus={initialTarget}
        finalFocus={() => (inSettings.current ? false : opener)}
        showCloseButton={false}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onClickCapture={(event) => {
          if (composing.current) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
        onKeyDownCapture={(event) => {
          if (
            (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) &&
            ['Enter', ' ', 'Escape'].includes(event.key)
          ) {
            // Let the input method commit its text, without activating a tool or dismissing the dialog.
            if (event.target !== search.current) event.preventDefault();
            event.stopPropagation();
          }
        }}
      >
        <DialogTitle>{role('add')}</DialogTitle>
        {searchable ? (
          <Input
            ref={search}
            value={query}
            aria-label={t('search')}
            placeholder={t('search')}
            onChange={(event) => setQuery(event.target.value)}
          />
        ) : null}
        {catalogState === 'loading' ? (
          <p ref={loading} tabIndex={-1} role="status" className="text-body text-muted-foreground">
            {l('resources.loading')}
          </p>
        ) : catalogState === 'failed' ? (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-body">
            {t('loadFailed')}
            <Button variant="tertiary" onClick={onRetry}>
              {l('retry')}
            </Button>
          </div>
        ) : (
          <>
            {!servers.some(matches) && (
              <p className="text-body text-muted-foreground">
                {servers.length ? r('noMatches') : t('none')}
              </p>
            )}
            {servers.map((server) => (
              <ConnectionChoice
                key={`${projectId}:${server.id}:${sessionId ?? ''}`}
                api={api}
                projectId={projectId}
                server={server}
                servers={servers}
                revision={revision}
                copy={
                  server.transport === 'stdio' ? (copies.get(server.id) ?? sessionId ?? '') : ''
                }
                onCopyChange={(id) => setCopies((current) => new Map(current).set(server.id, id))}
                shown={matches(server)}
                selected={server.id === selectedId}
                onSelect={() => setSelectedId(server.id)}
                checked={checked}
                rememberTitles={(tools) => {
                  for (const tool of tools)
                    titles.current.set(roleToolKey(server.id, tool.name), tool.title);
                }}
                onToggle={(name) =>
                  setChecks((items) =>
                    items.some((ref) => ref.serverId === server.id && ref.name === name)
                      ? items.filter((ref) => ref.serverId !== server.id || ref.name !== name)
                      : [...items, { serverId: server.id, name }],
                  )
                }
              />
            ))}
          </>
        )}
        <div
          ref={(element) => {
            manage.current = element?.querySelector('a') ?? null;
          }}
          className="justify-self-start"
        >
          {manageConnections}
        </div>
        <DialogFooter className="flex-wrap">
          <Button variant="ghost" onClick={onClose}>
            {r('cancel')}
          </Button>
          <Button
            disabled={catalogState !== 'ready' || !changed}
            onClick={() => {
              const labels = new Map<string, string>();
              for (const { name, serverId } of checks) {
                const key = roleToolKey(serverId, name);
                const title = titles.current.get(key);
                if (title !== undefined) labels.set(key, title);
              }
              onApply([...checks], labels);
            }}
          >
            {mode === 'seat' ? apply('applySeat', { name: targetLabel }) : apply('applyOriginal')}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

type Inspection = McpConnectionCheck | 'unknown' | 'trust' | 'copy' | null;

function connectionState(server: RegisteredMcpServer, copy: string, inspection: Inspection) {
  if (server.enabled === false) return 'off';
  if (!inspection) return 'checking';
  if (typeof inspection === 'string') return inspection;
  if (inspection.launch.server.enabled === false) return 'off';
  if (server.transport === 'stdio' && !copy) return 'copy';
  if (!inspection.launch.trustedAt) return 'trust';
  return inspection.status.state === 'missing' ? 'signIn' : 'available';
}

function ConnectionChoice({
  api,
  projectId,
  server,
  servers,
  revision,
  copy,
  onCopyChange,
  shown,
  selected,
  checked,
  onSelect,
  onToggle,
  rememberTitles,
}: Pick<PickerProps, 'api' | 'projectId' | 'servers'> & {
  server: RegisteredMcpServer;
  revision: number;
  copy: string;
  onCopyChange(id: string): void;
  shown: boolean;
  selected: boolean;
  checked: ReadonlySet<string>;
  onSelect(): void;
  onToggle(name: string): void;
  rememberTitles(tools: McpProbeResult['tools']): void;
}) {
  const t = useTranslations('TeamEditor.toolPicker');
  const role = useTranslations('TeamEditor.roleTools');
  const r = useTranslations('Resources');
  const detailsId = useId();
  const [observation, setObservation] = useState<{
    servers: readonly RegisteredMcpServer[];
    revision: number;
    copy: string;
    result: NonNullable<Inspection>;
  }>();
  const [probe, setProbe] = useState<McpProbeResult | null>(null);
  useEffect(() => {
    const record = (result: NonNullable<Inspection>) =>
      setObservation({ servers, revision, copy, result });
    if (server.enabled === false) {
      setProbe(null);
      return;
    }
    let current = true;
    void inspectMcpConnection(api, projectId, server.id, copy).then(
      (result) => {
        if (!current) return;
        record(result);
        setProbe((previous) =>
          previous &&
          connectionState(server, copy, result) === 'available' &&
          previous.fingerprint === result.launch.fingerprint &&
          previous.configRevision === result.launch.configRevision
            ? previous
            : null,
        );
      },
      (error: unknown) => {
        if (!current) return;
        const reason = error instanceof Error ? error.message : '';
        if (reason === 'Choose an existing session working copy to test this server.') {
          record('copy');
        } else if (reason === 'trust the repository before inspecting tools') {
          record('trust');
        } else {
          record('unknown');
        }
        setProbe(null);
      },
    );
    return () => {
      current = false;
    };
  }, [api, projectId, server, copy, servers, revision]);
  if (!shown) return null;
  // A new catalog or focus check can mean new auth/trust without a config revision change.
  // Never enable discovery with the previous context while the next one is being inspected.
  const inspection =
    observation?.servers === servers &&
    observation.revision === revision &&
    observation.copy === copy
      ? observation.result
      : null;
  const result = typeof inspection === 'object' ? inspection : null;
  const state = connectionState(server, copy, inspection);
  return (
    <div className="grid min-w-0 gap-2">
      <Button
        variant="ghost"
        aria-pressed={selected}
        onClick={onSelect}
        className={cn(
          'h-auto w-full flex-wrap justify-between gap-x-3 whitespace-normal text-left',
          selected && CHOSEN_BUTTON_ROW,
        )}
      >
        <span className="min-w-0 break-words">{server.name}</span>
        <span className="text-caption text-muted-foreground">{t(state)}</span>
      </Button>
      {selected && (
        <div className="grid min-w-0 gap-2 pl-3">
          <McpConnection
            api={api}
            projectId={projectId}
            server={server}
            manage={false}
            disabled={state === 'off'}
            externalCheck={{ result, sessionId: copy, onSessionChange: onCopyChange }}
            onProbe={(next) => {
              setProbe(next);
              if (next) rememberTitles(next.tools);
            }}
          />
          {state === 'available' && probe ? (
            probe.tools.length ? (
              <CheckboxGroup
                aria-label={role('heading')}
                checkedIndices={
                  new Set(
                    probe.tools.flatMap((tool, index) =>
                      checked.has(roleToolKey(server.id, tool.name)) ? [index] : [],
                    ),
                  )
                }
              >
                {probe.tools.map((tool, index) => (
                  <div key={tool.name} className="relative min-w-0">
                    <CheckboxItem
                      index={index}
                      label={tool.title || tool.name}
                      checked={checked.has(roleToolKey(server.id, tool.name))}
                      aria-describedby={tool.description ? `${detailsId}-${index}` : undefined}
                      onToggle={() => onToggle(tool.name)}
                    />
                    {tool.description && (
                      <p
                        id={`${detailsId}-${index}`}
                        className="break-words pl-9 text-caption text-muted-foreground"
                      >
                        {tool.description}
                      </p>
                    )}
                  </div>
                ))}
              </CheckboxGroup>
            ) : (
              <p role="status" className="text-caption text-muted-foreground">
                {r('probeEmpty')}
              </p>
            )
          ) : null}
        </div>
      )}
    </div>
  );
}
