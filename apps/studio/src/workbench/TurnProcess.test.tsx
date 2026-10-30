// @vitest-environment jsdom
import type { RunEvent } from '@corral/contracts';
import { emptyProjection } from '@corral/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { expect, it } from 'vitest';
import en from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import ko from '../../../../packages/react/src/messages/ko.json' with { type: 'json' };
import { TurnProcess } from './TurnProcess.tsx';

it.each(['en', 'ko'] as const)(
  'names the exact read result version while keeping unknown targets and failure states (%s)',
  (locale) => {
    const projection = emptyProjection('run_process');
    projection.status = 'failed';
    projection.executionOrder = ['lead'];
    projection.artifacts.artv_report = {
      artifactVersionId: 'artv_report',
      artifactId: 'report',
      version: 2,
      parentVersionId: null,
      name: 'Security report',
      contract: 'text',
      contentHash: 'a'.repeat(64),
      byteLength: 12,
      authorExecutionId: 'lead',
      modelCallId: null,
      contextSnapshotId: null,
      submitted: true,
      configRevision: 1,
      criteriaVersionId: null,
      inputArtifactVersionIds: [],
    };
    const events = ['artv_report', 'artv_missing'].flatMap((id) => [
      {
        type: 'tool.requested',
        actor: { kind: 'agent', id: 'lead' },
        payload: {
          executionId: 'lead',
          toolCallId: id,
          name: 'read_artifact',
          validatedArgs: { artifactVersionId: id },
        },
      },
      {
        type: 'tool.finished',
        actor: { kind: 'agent', id: 'lead' },
        payload: { executionId: 'lead', toolCallId: id, error: 'The read failed.' },
      },
    ]) as unknown as RunEvent[];
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(
      <IntlProvider locale={locale} messages={locale === 'en' ? en : ko}>
        <TurnProcess
          events={events}
          projection={projection}
          streams={{}}
          label={(id) => id}
          open
          onOpenChange={() => {}}
        />
      </IntlProvider>,
    );
    expect(container.textContent).toContain(
      locale === 'en'
        ? 'Read · Security report · v2 · failed'
        : '읽기 · Security report · 버전 2 · 실패',
    );
    expect(container.textContent).not.toContain('artv_report');
    expect(container.textContent).toContain('artv_missing');
  },
);
