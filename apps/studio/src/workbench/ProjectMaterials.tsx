import {
  TEXT_ATTACHMENT_MAX_COUNT,
  type TextAttachment,
  textAttachmentKey,
} from '@corral/contracts';
import { validTextAttachments } from '@corral/core';
import { Button, Input, Select, Textarea } from '@corral/react/design-kit';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { type ProjectMaterial, projectRequest } from '../projects-api.ts';
import { useServices } from '../services.tsx';

function useMaterials(projectId: string) {
  const t = useTranslations('Materials');
  const [materials, setMaterials] = useState<ProjectMaterial[]>([]);
  const [error, setError] = useState('');
  const { mode } = useServices();
  const request = useRef(0);
  const currentProject = useRef(projectId);
  currentProject.current = projectId;
  const reload = useCallback(async () => {
    if (mode !== 'server') return;
    const requestId = ++request.current;
    try {
      const result = await projectRequest<{ materials: ProjectMaterial[] }>(
        `/projects/${projectId}/materials`,
      );
      if (currentProject.current === projectId && request.current === requestId)
        setMaterials(result.materials);
    } catch (e) {
      if (request.current === requestId) setError(e instanceof Error ? e.message : t('loadFailed'));
    }
  }, [projectId, mode, t]);
  useEffect(() => {
    void reload();
    return () => {
      request.current++;
    };
  }, [reload]);
  return { materials, error, setError, reload, mode };
}

/**
 * Project materials are server records (instructions and memory), not workspace files (#87).
 * Explicit selection only; immutable attachment contents are submitted through the existing
 * request path.
 */
export function ProjectMaterialPicker({
  projectId,
  value,
  onChange,
  onBusyChange,
  onErrorChange,
  disabled = false,
}: {
  projectId: string;
  value: TextAttachment[];
  onChange(value: TextAttachment[]): void;
  onBusyChange?(busy: boolean): void;
  /** Keeps request failures visible when a containing options popup is dismissed. */
  onErrorChange?(message: string | null): void;
  disabled?: boolean;
}) {
  const t = useTranslations('Materials');
  const { materials, error, setError, reload, mode } = useMaterials(projectId);
  const [busy, setBusy] = useState(false);
  const latest = useRef({ projectId, value });
  latest.current = { projectId, value };
  const alive = useRef(true);
  useEffect(() => {
    onErrorChange?.(error || null);
  }, [error, onErrorChange]);
  useEffect(
    () => () => {
      onErrorChange?.(null);
    },
    [onErrorChange],
  );
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      onBusyChange?.(false);
    };
  }, [onBusyChange]);
  if (mode !== 'server') return null;
  return (
    <div className="flex flex-col gap-1 text-xs">
      <Select
        label={t('attach')}
        className="max-w-52"
        variant="chip"
        size="xs"
        disabled={disabled || busy || value.length >= TEXT_ATTACHMENT_MAX_COUNT}
        value={null}
        placeholder={t('attachPlaceholder')}
        options={
          materials.length
            ? materials.map((item) => ({
                value: item.id,
                label: t('version', { name: item.name, revision: item.revision }),
              }))
            : [
                {
                  value: '',
                  disabled: true,
                  label: t('empty'),
                },
              ]
        }
        onOpenChange={(open) => {
          if (open) void reload();
        }}
        onValueChange={async (id) => {
          const selected = materials.find((item) => item.id === id);
          if (!selected) return;
          setBusy(true);
          onBusyChange?.(true);
          setError('');
          try {
            const { attachment } = await projectRequest<{ attachment: TextAttachment }>(
              `/projects/${projectId}/materials/attachment`,
              { id: selected.id, revision: selected.revision },
            );
            if (
              alive.current &&
              latest.current.projectId === projectId &&
              latest.current.value === value &&
              !value.some((item) => textAttachmentKey(item) === textAttachmentKey(attachment))
            ) {
              if (!validTextAttachments([...value, attachment]))
                throw new Error(t('attachInvalid'));
              onChange([...value, attachment]);
            }
          } catch (e) {
            if (alive.current) setError(e instanceof Error ? e.message : t('attachFailed'));
          } finally {
            if (alive.current) setBusy(false);
            onBusyChange?.(false);
          }
        }}
      />
      {error ? (
        <span role="alert" className="text-danger">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** The project's instructions and memory entries: server records, kept apart from folder files. */
export function ProjectMaterials({ projectId }: { projectId: string }) {
  const t = useTranslations('Materials');
  const { materials, error, setError, reload, mode } = useMaterials(projectId);
  const [editing, setEditing] = useState<ProjectMaterial | null>(null);
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [kind, setKind] = useState<'instructions' | 'memory'>('instructions');
  const [busy, setBusy] = useState(false);
  if (mode !== 'server') return null;
  const clear = () => {
    setEditing(null);
    setName('');
    setText('');
  };
  return (
    <section className="flex flex-col gap-3" aria-labelledby="project-materials-heading">
      <h3 id="project-materials-heading" className="text-sm font-semibold">
        {t('heading')}
      </h3>
      <p className="text-xs text-muted-foreground">{t('hint')}</p>
      <ul className="flex flex-col gap-2">
        {materials.map((item) => (
          <li key={item.id} className="flex items-center gap-2 text-sm">
            <Button
              variant="ghost"
              size="compact"
              className="min-w-0 flex-1 justify-start"
              onClick={() => {
                setEditing(item);
                setName(item.name);
                setText(item.text);
                setKind(item.kind);
              }}
            >
              <span className="truncate">
                {t('version', { name: item.name, revision: item.revision })}
              </span>
            </Button>
            <Button
              size="compact"
              variant="ghost"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await projectRequest(`/projects/${projectId}/materials/remove`, {
                    id: item.id,
                    expectedRevision: item.revision,
                  });
                  if (editing?.id === item.id) clear();
                  await reload();
                } catch (e) {
                  setError(e instanceof Error ? e.message : t('archiveFailed'));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t('archive')}
            </Button>
          </li>
        ))}
      </ul>
      <form
        className="flex flex-col gap-2"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          try {
            await projectRequest(`/projects/${projectId}/materials`, {
              name,
              text,
              kind,
              ...(editing ? { id: editing.id, expectedRevision: editing.revision } : {}),
            });
            clear();
            await reload();
          } catch (e) {
            setError(e instanceof Error ? e.message : t('saveFailed'));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="flex flex-col gap-1 text-xs">
          {t('name')}
          <Input required maxLength={90} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="flex flex-col gap-1 text-xs">
          <span>{t('kind')}</span>
          <Select<'instructions' | 'memory'>
            label={t('kind')}
            value={kind}
            onValueChange={setKind}
            options={[
              { value: 'instructions', label: t('instructions') },
              { value: 'memory', label: t('memory') },
            ]}
            className="self-start"
          />
        </div>
        <label className="flex flex-col gap-1 text-xs">
          {t('contents')}
          <Textarea
            required
            rows={5}
            maxLength={65536}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <div className="flex gap-2">
          <Button type="submit" size="compact" disabled={busy}>
            {editing ? t('saveVersion') : t('add')}
          </Button>
          {editing ? (
            <Button type="button" variant="ghost" size="compact" onClick={clear}>
              {t('cancelEdit')}
            </Button>
          ) : null}
        </div>
      </form>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}
