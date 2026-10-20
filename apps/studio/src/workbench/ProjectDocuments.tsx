import { TEXT_ATTACHMENT_MAX_COUNT, type TextAttachment } from '@corral/contracts';
import { Button, Select } from '@corral/react/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale } from 'use-intl';
import { type ProjectMaterial, projectRequest } from '../projects-api.ts';
import { useServices } from '../services.tsx';

function useMaterials(projectId: string) {
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
      if (request.current === requestId)
        setError(e instanceof Error ? e.message : 'Could not load documents.');
    }
  }, [projectId, mode]);
  useEffect(() => {
    void reload();
    return () => {
      request.current++;
    };
  }, [reload]);
  return { materials, error, setError, reload, mode };
}

/** Explicit selection only; immutable attachment contents are submitted through the existing request path. */
export function ProjectDocumentPicker({
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
  const ko = useLocale().startsWith('ko');
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
        label={ko ? '이번 요청에 프로젝트 자료 첨부' : 'Attach project document to this request'}
        className="max-w-52"
        variant="chip"
        size="xs"
        disabled={disabled || busy || value.length >= TEXT_ATTACHMENT_MAX_COUNT}
        value={null}
        placeholder={ko ? '프로젝트 자료 첨부' : 'Attach project document'}
        options={
          materials.length
            ? materials.map((item) => ({
                value: item.id,
                label: `${item.name} · v${item.revision}`,
              }))
            : [
                {
                  value: '',
                  disabled: true,
                  label: ko
                    ? '프로젝트 폴더 탭에서 자료를 추가하세요'
                    : 'Add documents in the Project folder tab',
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
              !value.some(
                (item) => item.name === attachment.name && item.sha256 === attachment.sha256,
              )
            )
              onChange([...value, attachment]);
          } catch (e) {
            if (alive.current)
              setError(e instanceof Error ? e.message : 'Could not attach document.');
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

export function ProjectDocuments({ projectId }: { projectId: string }) {
  const ko = useLocale().startsWith('ko');
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
    <section
      className="mt-4 flex flex-col gap-3 border-t border-line pt-4"
      aria-label={ko ? '프로젝트 자료' : 'Project documents'}
    >
      <h3 className="text-sm font-semibold">{ko ? '지침과 메모리' : 'Instructions and memory'}</h3>
      <p className="text-xs text-muted">
        {ko
          ? '요청 입력창에서 직접 선택한 자료만 첨부됩니다. 수정하거나 삭제해도 이전 요청의 자료는 유지됩니다.'
          : 'Only documents you select in the composer are attached. Editing or deleting preserves earlier request snapshots.'}
      </p>
      <ul className="flex flex-col gap-2">
        {materials.map((item) => (
          <li key={item.id} className="flex items-center gap-2 text-sm">
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left underline"
              onClick={() => {
                setEditing(item);
                setName(item.name);
                setText(item.text);
                setKind(item.kind);
              }}
            >
              {item.name} · v{item.revision}
            </button>
            <Button
              size="sm"
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
                  setError(e instanceof Error ? e.message : 'Could not remove document.');
                } finally {
                  setBusy(false);
                }
              }}
            >
              {ko ? '보관' : 'Archive'}
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
            setError(e instanceof Error ? e.message : 'Could not save document.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="flex flex-col gap-1 text-xs">
          {ko ? '자료 이름' : 'Document name'}
          <input
            required
            maxLength={90}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="rounded fill-control px-2 py-1 text-sm"
          />
        </label>
        <div className="flex flex-col gap-1 text-xs">
          <span>{ko ? '종류' : 'Kind'}</span>
          <Select<'instructions' | 'memory'>
            label={ko ? '종류' : 'Kind'}
            value={kind}
            onValueChange={setKind}
            options={[
              { value: 'instructions', label: ko ? '지침' : 'Instructions' },
              { value: 'memory', label: ko ? '메모리' : 'Memory' },
            ]}
            className="self-start"
          />
        </div>
        <label className="flex flex-col gap-1 text-xs">
          {ko ? '내용' : 'Contents'}
          <textarea
            required
            rows={5}
            maxLength={65536}
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="rounded fill-control px-2 py-1 text-sm"
          />
        </label>
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={busy}>
            {ko
              ? editing
                ? '새 버전 저장'
                : '자료 추가'
              : editing
                ? 'Save new version'
                : 'Add document'}
          </Button>
          {editing ? (
            <Button type="button" variant="ghost" size="sm" onClick={clear}>
              {ko ? '편집 취소' : 'Cancel edit'}
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
