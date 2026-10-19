import type { HarnessApi, McpProbeResult } from '@corral/client';
import type { ProjectToolConfigRevision, RegisteredMcpServer } from '@corral/contracts';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { McpConnection } from './McpSettings.tsx';

export function HarnessMcpTools({
  api,
  projectId,
  config,
  selectedIds,
  allowedTools,
  onChange,
}: {
  api: HarnessApi;
  projectId: string;
  config: ProjectToolConfigRevision;
  selectedIds: string[];
  allowedTools: string[];
  onChange(names: string[]): void;
}) {
  return config.mcpServers
    ?.filter((server) => selectedIds.includes(server.id))
    .map((server) => (
      <ServerTools
        key={server.id}
        api={api}
        projectId={projectId}
        server={server}
        revision={config.revision}
        allowedTools={allowedTools}
        onChange={onChange}
      />
    ));
}

function ServerTools({
  api,
  projectId,
  server,
  revision,
  allowedTools,
  onChange,
}: {
  api: HarnessApi;
  projectId: string;
  server: RegisteredMcpServer;
  revision: number;
  allowedTools: string[];
  onChange(names: string[]): void;
}) {
  const t = useTranslations('Resources');
  const [probe, setProbe] = useState<McpProbeResult | null>(null);
  const verified = probe?.configRevision === revision ? probe : null;
  return (
    <section className="flex flex-col gap-3 border-t border-line pt-3">
      <h3 className="font-medium">{server.name}</h3>
      <McpConnection
        api={api}
        projectId={projectId}
        server={server}
        manage={false}
        onProbe={setProbe}
      />
      {verified ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium">{t('selectTools')}</legend>
          {!verified.tools.length ? <p className="text-sm text-muted">{t('probeEmpty')}</p> : null}
          {verified.tools.map((tool) => (
            <label key={tool.name} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={allowedTools.includes(tool.name)}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...new Set([...allowedTools, tool.name])]
                      : allowedTools.filter((name) => name !== tool.name),
                  )
                }
              />
              <span>
                {tool.title}
                <span className="block text-xs text-muted">{tool.description}</span>
              </span>
            </label>
          ))}
          <p className="text-xs text-muted">{t('nextRun')}</p>
        </fieldset>
      ) : null}
    </section>
  );
}
