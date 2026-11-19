import type { HarnessApi } from '@corral/client';
import type {
  HarnessEntryKey,
  HarnessEntryView,
  HarnessResource,
  ManagedHook,
} from '@corral/contracts';
import { Button } from '@corral/react/design-kit';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';

export const entryId = (entry: HarnessEntryKey) => `${entry.resourceHash}:${entry.entry}`;
export const entryKey = ({ resourceHash, entry, kind }: HarnessEntryKey): HarnessEntryKey => ({
  resourceHash,
  entry,
  kind,
});

export function EntryContent({
  api,
  entry,
  onRead,
}: {
  api: HarnessApi;
  entry: HarnessEntryView;
  onRead?: (entry: HarnessEntryKey) => void;
}) {
  const t = useTranslations('Resources'),
    h = useTranslations('Harness'),
    l = useTranslations('Library');
  const [filesOpen, setFilesOpen] = useState(false);
  const [value, setValue] = useState<{
    content: string;
    hook: ManagedHook | null;
    files: HarnessResource['files'];
  } | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, retry] = useState(0);
  const { resourceHash, entry: path, kind } = entry;
  useEffect(() => {
    let active = true;
    void attempt;
    setFailed(false);
    void Promise.all([
      api.readEntry({ resourceHash, entry: path, kind }),
      api.resource(resourceHash),
    ]).then(
      ([document, resource]) => {
        if (!active) return;
        setValue({ ...document, files: resource.files });
        onRead?.({ resourceHash, entry: path, kind });
      },
      () => active && setFailed(true),
    );
    return () => {
      active = false;
    };
  }, [api, resourceHash, path, kind, attempt, onRead]);
  const content =
    kind === 'skill'
      ? value?.content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')
      : value?.content;
  return (
    <>
      {kind === 'extension' ? (
        <p className="text-caption text-muted-foreground">
          {t(value?.hook ? 'managedHook' : 'externalExtension')}
        </p>
      ) : (
        <h3 className="text-subtitle">{t('instructions')}</h3>
      )}
      {failed ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-body text-destructive">
          {t('readFailed')}
          <Button variant="tertiary" onClick={() => retry((n) => n + 1)}>
            {l('retry')}
          </Button>
        </div>
      ) : (
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-subtle p-4 font-mono text-caption">
          {content ?? t('loadingContent')}
        </pre>
      )}
      <details
        className="min-w-0 text-caption text-muted-foreground"
        onToggle={(e) => setFilesOpen(e.currentTarget.open)}
      >
        <summary>
          {t('advanced')} · {h('files', { count: entry.resource.fileCount })}
        </summary>
        <p className="mt-2 break-words">
          {entry.resource.name} · {entry.resource.version}
        </p>
        <p className="break-all font-mono">{path}</p>
        <p className="my-2 break-all font-mono">{resourceHash}</p>
        {filesOpen ? (
          <ul className="max-h-40 overflow-auto">
            {value?.files.map((file) => (
              <li key={file.path}>
                {file.path} · {file.bytes} B
              </li>
            ))}
          </ul>
        ) : null}
      </details>
    </>
  );
}
