import type { HarnessApi, McpProbeResult } from '@corral/client';
import type { ProjectToolConfigRevision, RegisteredMcpServer } from '@corral/contracts';
import { Checkbox, fontWeights } from '@corral/react/design-kit';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { McpConnection } from './McpConnection.tsx';

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
    <section className="flex flex-col gap-3">
      <h3 className="text-subtitle" style={{ fontVariationSettings: fontWeights.semibold }}>
        {server.name}
      </h3>
      <McpConnection
        api={api}
        projectId={projectId}
        server={server}
        manage={false}
        onProbe={setProbe}
      />
      {verified ? (
        <fieldset className="flex flex-col gap-2">
          <legend
            className="mb-2 text-subtitle"
            style={{ fontVariationSettings: fontWeights.semibold }}
          >
            {t('selectTools')}
          </legend>
          {!verified.tools.length ? (
            <p className="text-body text-muted-foreground">{t('probeEmpty')}</p>
          ) : null}
          {verified.tools.map((tool) => (
            <div key={tool.name} className="settings-row flex-col items-start gap-1">
              <Checkbox
                label={tool.title || tool.name}
                checked={allowedTools.includes(tool.name)}
                onToggle={() =>
                  onChange(
                    allowedTools.includes(tool.name)
                      ? allowedTools.filter((name) => name !== tool.name)
                      : [...new Set([...allowedTools, tool.name])],
                  )
                }
              />
              {tool.description ? <p className="text-caption">{tool.description}</p> : null}
            </div>
          ))}
          <p className="text-caption text-muted-foreground">{t('nextRun')}</p>
        </fieldset>
      ) : null}
    </section>
  );
}
