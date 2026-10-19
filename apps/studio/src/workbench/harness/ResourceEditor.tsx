import type { HarnessApi } from '@corral/client';
import type { HarnessDocumentDraft, HarnessEntryView, ManagedHook } from '@corral/contracts';
import {
  Button,
  Dialog,
  DialogDescription,
  DialogPopup,
  DialogTitle,
  Select,
} from '@corral/react/ui';
import { useBlocker } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { desktop } from '../../desktop.tsx';
import { field } from './Target.tsx';

const EXTENSION_TEMPLATE = `export default function (pi) {
  pi.on('session_start', async (_event, ctx) => {
    ctx.ui.notify('Ready', 'info');
  });
}
`;

export function ResourceEditor({
  api,
  kind,
  entry,
  onClose,
  onSaved,
}: {
  api: HarnessApi;
  kind: 'skill' | 'extension';
  entry?: HarnessEntryView;
  onClose(): void;
  onSaved(hash: string, entry?: string): void;
}) {
  const t = useTranslations('Resources'),
    h = useTranslations('Harness');
  const [mode, setMode] = useState(entry ? 'edit' : 'new');
  const [builtin, setBuiltin] = useState('core');
  const [name, setName] = useState(entry?.name ?? '');
  const [description, setDescription] = useState(''),
    [content, setContent] = useState('');
  const [hook, setHook] = useState<ManagedHook | null>(
    kind === 'extension' && !entry ? { template: 'notify', title: '', message: '' } : null,
  );
  const [source, setSource] = useState(''),
    [packageKind, setPackageKind] = useState('npm'),
    [pin, setPin] = useState('');
  const [review, setReview] = useState<Awaited<ReturnType<HarnessApi['review']>> | null>(null);
  const [busy, setBusy] = useState(Boolean(entry)),
    [error, setError] = useState(''),
    [dirty, setDirty] = useState(false);
  const skillId = useRef(`skill-${crypto.randomUUID().slice(0, 12)}`);
  const alive = useRef(true),
    reviewRef = useRef(review);
  reviewRef.current = review;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useBlocker({
    shouldBlockFn: () => dirtyRef.current && !window.confirm(t('leaveUnsaved')),
    enableBeforeUnload: () => dirtyRef.current,
  });
  useEffect(() => {
    alive.current = true;
    if (entry) {
      setBusy(true);
      void api
        .readEntry({ resourceHash: entry.resourceHash, entry: entry.entry, kind: entry.kind })
        .then(
          (value) => {
            if (alive.current) {
              setContent(value.content);
              setHook(value.hook);
            }
          },
          (e) => alive.current && setError(e.message),
        )
        .finally(() => alive.current && setBusy(false));
    }
    return () => {
      alive.current = false;
      if (reviewRef.current) void api.cancelReview(reviewRef.current.reviewId).catch(() => {});
    };
  }, [api, entry]);
  function change(action: () => void) {
    if (review) void api.cancelReview(review.reviewId).catch(() => {});
    setReview(null);
    setError('');
    setDirty(true);
    action();
  }
  function close() {
    if (!busy && (!dirty || window.confirm(t('leaveUnsaved')))) onClose();
  }
  async function inspect() {
    setBusy(true);
    setError('');
    try {
      let result: Awaited<ReturnType<HarnessApi['review']>>;
      if (['local', 'pi-home', 'package', 'builtin'].includes(mode))
        result = await api.review(
          mode as 'local' | 'pi-home' | 'package' | 'builtin',
          mode === 'builtin'
            ? builtin
            : mode === 'package'
              ? `${packageKind}:${source.trim()}@${pin.trim()}`
              : source.trim(),
        );
      else {
        const text =
          mode === 'new' && kind === 'skill'
            ? `---\nname: ${skillId.current}\ndescription: ${JSON.stringify(description.trim())}\n---\n${content}`
            : content;
        const draft: HarnessDocumentDraft = {
          kind,
          name,
          content: hook ? 'generated' : text,
          ...(hook ? { hook } : {}),
          ...(entry
            ? { base: { resourceHash: entry.resourceHash, entry: entry.entry, kind: entry.kind } }
            : {}),
        };
        result = await api.reviewDocument(draft);
      }
      if (alive.current) setReview(result);
      else await api.cancelReview(result.reviewId);
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup className="max-w-3xl p-6" showCloseButton={false}>
        <DialogTitle>
          {entry ? t('editCopy') : t(kind === 'skill' ? 'addSkill' : 'addHook')}
        </DialogTitle>
        <DialogDescription>{t('copyHint')}</DialogDescription>
        <form
          onKeyDown={(event) => {
            if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault();
          }}
          className="mt-4 flex max-h-[70vh] flex-col gap-4 overflow-y-auto pr-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy && !review) void inspect();
          }}
        >
          <fieldset disabled={busy} className="flex min-w-0 flex-col gap-4">
            {!entry ? (
              <div className="flex flex-col gap-1 text-sm">
                {t('addMethod')}
                <Select
                  className="h-9 w-full justify-between"
                  label={t('addMethod')}
                  value={mode}
                  onValueChange={(value) =>
                    change(() => {
                      setMode(value);
                      setHook(
                        value === 'new' && kind === 'extension'
                          ? { template: 'notify', title: '', message: '' }
                          : null,
                      );
                    })
                  }
                  options={[
                    ...(kind === 'skill' ? [{ value: 'builtin', label: t('builtin') }] : []),
                    { value: 'new', label: t('create') },
                    { value: 'file', label: t('importFile') },
                    { value: 'local', label: t('importFolder') },
                    { value: 'pi-home', label: h('piHome') },
                    { value: 'package', label: t('importPackage') },
                  ]}
                />
              </div>
            ) : null}
            {mode === 'file' ? (
              <label className="flex flex-col gap-1 text-sm">
                {t('chooseFile')}
                <input
                  type="file"
                  accept={kind === 'skill' ? '.md' : '.ts,.js,.mjs'}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    change(() => {
                      setName(file.name);
                      setContent('');
                    });
                    if (file.size > 65536) {
                      setError(t('sizeLimit'));
                      return;
                    }
                    setBusy(true);
                    void file
                      .arrayBuffer()
                      .then((bytes) => new TextDecoder('utf-8', { fatal: true }).decode(bytes))
                      .then((text) => {
                        if (alive.current) change(() => setContent(text));
                      })
                      .catch(() => {
                        if (alive.current) setError(t('fileFailed'));
                      })
                      .finally(() => alive.current && setBusy(false));
                  }}
                />
                <span className="text-xs text-muted">{t('fileHint')}</span>
              </label>
            ) : null}
            {['local', 'package'].includes(mode) ? (
              <>
                {mode === 'package' ? (
                  <Select
                    className="h-9 w-full justify-between"
                    label={t('packageType')}
                    value={packageKind}
                    onValueChange={(value) => change(() => setPackageKind(value))}
                    options={[
                      { value: 'npm', label: 'npm' },
                      { value: 'git', label: 'Git HTTPS' },
                    ]}
                  />
                ) : null}
                <label className="flex flex-col gap-1 text-sm">
                  {t(mode === 'local' ? 'folderPath' : 'packageSource')}
                  <input
                    className={field}
                    required
                    value={source}
                    onChange={(e) => change(() => setSource(e.target.value))}
                  />
                </label>
                {mode === 'local' && desktop ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      void desktop?.pickFolder().then((path) => {
                        if (path && alive.current) change(() => setSource(path));
                      });
                    }}
                  >
                    {t('chooseFolder')}
                  </Button>
                ) : null}
                {mode === 'package' ? (
                  <label className="flex flex-col gap-1 text-sm">
                    {t(packageKind === 'npm' ? 'exactVersion' : 'exactCommit')}
                    <input
                      className={field}
                      required
                      value={pin}
                      onChange={(e) => change(() => setPin(e.target.value))}
                    />
                  </label>
                ) : (
                  <p className="text-xs text-muted">{t('folderHint')}</p>
                )}
              </>
            ) : mode === 'builtin' ? (
              <div className="flex flex-col gap-2 text-sm">
                <Select
                  label={t('builtin')}
                  value={builtin}
                  onValueChange={(value) => change(() => setBuiltin(value))}
                  options={['core', 'coding', 'design', 'browser'].map((value) => ({
                    value,
                    label: t(`builtinPacks.${value}`),
                  }))}
                />
                <p className="text-xs text-muted">{t('builtinHint')}</p>
              </div>
            ) : mode === 'pi-home' ? (
              <p className="text-sm text-muted">{h('piHomeHint', { folder: '~/.pi/agent' })}</p>
            ) : (
              <>
                <label className="flex flex-col gap-1 text-sm">
                  {t('displayName')}
                  <input
                    className={field}
                    required
                    maxLength={100}
                    value={name}
                    onChange={(e) => change(() => setName(e.target.value))}
                  />
                </label>
                {hook ? (
                  <>
                    <div className="flex flex-col gap-1 text-sm">
                      {t('hookTemplate')}
                      <Select
                        className="h-9 w-full justify-between"
                        label={t('hookTemplate')}
                        value={hook.template}
                        onValueChange={(value) =>
                          change(() =>
                            setHook({ ...hook, template: value as ManagedHook['template'] }),
                          )
                        }
                        options={[
                          { value: 'notify', label: t('notifyHook') },
                          { value: 'confirm', label: t('confirmHook') },
                        ]}
                      />
                    </div>
                    <label className="flex flex-col gap-1 text-sm">
                      {t('hookTitle')}
                      <input
                        className={field}
                        required
                        maxLength={300}
                        value={hook.title}
                        onChange={(e) => change(() => setHook({ ...hook, title: e.target.value }))}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                      {t('hookMessage')}
                      <textarea
                        className={field}
                        rows={4}
                        value={hook.message}
                        onChange={(e) =>
                          change(() => setHook({ ...hook, message: e.target.value }))
                        }
                      />
                    </label>
                    <p className="text-xs text-muted">{t('managedHookHint')}</p>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() =>
                        change(() => {
                          setHook(null);
                          if (!entry) setContent(EXTENSION_TEMPLATE);
                        })
                      }
                    >
                      {t('rawEdit')}
                    </Button>
                  </>
                ) : (
                  <>
                    {mode === 'new' && kind === 'skill' ? (
                      <label className="flex flex-col gap-1 text-sm">
                        {t('description')}
                        <input
                          className={field}
                          required
                          value={description}
                          onChange={(e) => change(() => setDescription(e.target.value))}
                        />
                      </label>
                    ) : null}
                    <label className="flex flex-col gap-1 text-sm">
                      {t(mode === 'new' && kind === 'skill' ? 'instructions' : 'sourceCode')}
                      <textarea
                        className={`${field} min-h-48 font-mono`}
                        rows={10}
                        required
                        value={content}
                        placeholder={kind === 'skill' ? t('skillTemplate') : t('extensionTemplate')}
                        onChange={(e) => change(() => setContent(e.target.value))}
                      />
                    </label>
                    <p className="text-xs text-muted">{t('rawHint')}</p>
                  </>
                )}
              </>
            )}
            {kind === 'extension' ? (
              <p className="rounded-lg bg-warning/10 p-3 text-sm text-warning">
                {h('nativeWarning')}
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            ) : null}
            {review ? (
              <section className="rounded-lg bg-surface p-3 text-sm" aria-label={h('review')}>
                <p className="font-medium">{t('reviewReady')}</p>
                <ul className="mt-2 list-inside list-disc">
                  {review.resource.skills.map((skill) => (
                    <li key={skill.entry}>
                      {skill.name} — {skill.description}
                    </li>
                  ))}
                  {review.resource.extensions.map((path) => (
                    <li key={path}>{path}</li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-muted">{t('reviewHint')}</p>
                <details className="mt-2">
                  <summary>{h('files', { count: review.resource.files.length })}</summary>
                  <ul className="max-h-32 overflow-auto text-xs">
                    {review.resource.files.map((file) => (
                      <li key={file.path}>
                        {file.path} · {file.bytes} B
                      </li>
                    ))}
                  </ul>
                </details>
              </section>
            ) : null}
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="ghost" onClick={close}>
                {t('cancel')}
              </Button>
              {review ? (
                <Button
                  type="button"
                  onClick={() => {
                    setBusy(true);
                    setError('');
                    void api
                      .install(review.reviewId)
                      .then(
                        (resource) => {
                          if (alive.current) {
                            setDirty(false);
                            dirtyRef.current = false;
                            onSaved(resource.hash, entry?.entry);
                          }
                        },
                        (e) => alive.current && setError(e.message),
                      )
                      .finally(() => alive.current && setBusy(false));
                  }}
                >
                  {t('saveLibrary')}
                </Button>
              ) : (
                <Button type="submit">{busy ? h('busy') : h('review')}</Button>
              )}
            </div>
          </fieldset>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
