import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import type { RunSessionStore } from '../run/session.ts';

/** Committed references and hashes only; previews never stand in for what actually ran. */
export function HarnessDetails({ session }: { session: RunSessionStore }) {
  const t = useTranslations('Harness');
  const events = useStore(session, (s) => s.events);
  const definition = useStore(session, (s) => s.definition);
  const harnesses = events.find((event) => event.type === 'run.started')?.payload.harnesses;
  const requests = events.filter((event) => event.type === 'model.request_recorded');
  const payloads = new Map(
    events
      .filter((event) => event.type === 'model.payload_recorded')
      .map((event) => [event.payload.modelCallId, event.payload]),
  );
  const tools = new Map(
    events
      .filter((event) => event.type === 'tool.requested')
      .map((event) => [event.payload.toolCallId, event.payload.name]),
  );
  const native = events
    .filter((event) => event.type === 'tool.started')
    .filter((event) => event.payload.management === 'unmanaged_native');
  const loads = events.filter(
    (event) =>
      event.type === 'harness.loaded' ||
      event.type === 'harness.tools_updated' ||
      event.type === 'harness.load_failed',
  );
  const uiHistory = events.filter((event) => event.type.startsWith('extension.ui_'));
  if (!harnesses && !requests.length && !uiHistory.length) return null;
  return (
    <details className="mb-4 rounded-lg border border-line p-3" data-testid="harness-details">
      <summary className="cursor-pointer text-sm font-semibold">{t('applied')}</summary>
      <div className="mt-3 flex flex-col gap-3">
        {uiHistory.length ? (
          <details>
            <summary className="cursor-pointer text-xs">{t('uiHistory')}</summary>
            <ul className="text-2xs">
              {uiHistory.map((event) => (
                <li key={event.eventId}>
                  {event.executionId} ·{' '}
                  {'requestId' in event.payload ? event.payload.requestId : ''} · {event.type}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {Object.entries(harnesses ?? {}).map(([roleId, snapshot]) => (
          <section key={roleId} className="flex flex-col gap-1 border-b border-line pb-3">
            <h3 className="text-sm font-medium">
              {definition?.roles.find((role) => role.id === roleId)?.name ?? roleId} ·{' '}
              {snapshot.binding.profileId} · r{snapshot.binding.revision}
            </h3>
            <p className="text-xs">{t(snapshot.policy)}</p>
            {snapshot.policy === 'trusted-native' ? (
              <p className="text-xs text-warning">{t('nativeWarning')}</p>
            ) : null}
            {snapshot.resources.map((resource, index) => (
              <div key={`${resource.hash}:${resource.entry ?? index}`}>
                <p className="text-xs">
                  {resource.name} · {resource.version}
                </p>
                <p className="text-xs text-muted">
                  {resource.skillName} {resource.skillMode ? t(resource.skillMode) : ''}
                </p>
                <code className="break-all text-2xs">{resource.hash}</code>
              </div>
            ))}
            <p className="break-all font-mono text-2xs text-muted">{snapshot.snapshotHash}</p>
          </section>
        ))}
        {loads.map((event) => (
          <details key={event.eventId}>
            <summary className="cursor-pointer text-xs">
              {event.executionId} ·{' '}
              {event.type === 'harness.loaded'
                ? t('loaded')
                : event.type === 'harness.tools_updated'
                  ? t('toolsUpdated', { revision: event.payload.revision })
                  : t('loadFailed')}
            </summary>
            {event.type !== 'harness.load_failed' ? (
              <ul className="text-xs">
                {event.payload.tools.map((tool) => (
                  <li key={tool.name}>
                    {tool.name} · {tool.source} · {tool.sideEffect}
                  </li>
                ))}
                {(event.type === 'harness.loaded' ? (event.payload.commands ?? []) : []).map(
                  (command) => (
                    <li key={command.alias}>
                      /{command.alias} · {command.source} · {t('startupOnly')}
                    </li>
                  ),
                )}
              </ul>
            ) : (
              <p className="text-xs text-danger">{event.payload.code}</p>
            )}
          </details>
        ))}
        <h3 className="text-xs font-semibold">{t('requests', { count: requests.length })}</h3>
        <div className="max-h-80 overflow-auto">
          {requests.slice(-200).map((event) => {
            const request = event.payload;
            const payload = payloads.get(request.modelCallId);
            return (
              <details key={event.eventId} className="border-b border-line py-2">
                <summary className="cursor-pointer text-xs">
                  {request.modelCallId} · {request.purpose} · {request.contextBytes} B
                </summary>
                <div className="flex flex-col gap-1 p-2 text-2xs">
                  <p>{event.executionId}</p>
                  <p>{t('contextHash')}</p>
                  <code className="break-all">{request.contextHash}</code>
                  {request.sections.map((section) => (
                    <p key={`${section.name}:${section.hash}`}>
                      {section.name} · {section.source} · {section.bytes} B ·{' '}
                      <code className="break-all">{section.hash}</code>
                    </p>
                  ))}
                  {payload ? (
                    <>
                      <p>
                        {t('payloadHash')} · {payload.payloadBytes} B
                      </p>
                      <code className="break-all">{payload.payloadHash}</code>
                    </>
                  ) : (
                    <p>{t('payloadAbsent')}</p>
                  )}
                </div>
              </details>
            );
          })}
        </div>
        {native.map((event) => (
          <p key={event.eventId} className="text-xs text-warning">
            {tools.get(event.payload.toolCallId) ?? event.payload.toolCallId} · {t('unmanaged')} ·{' '}
            {event.payload.executionId}
          </p>
        ))}
      </div>
    </details>
  );
}
