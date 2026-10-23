import { Button } from '@corral/react/design-kit';
import { useCallback, useEffect, useState } from 'react';
import { useLocale } from 'use-intl';
import { type CloneOperation, projectRequest } from '../projects-api.ts';

export function GitCloneFolder({ onSelect }: { onSelect(path: string): void }) {
  const ko = useLocale().startsWith('ko');
  const [source, setSource] = useState('');
  const [destination, setDestination] = useState('');
  const [operations, setOperations] = useState<CloneOperation[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setOperations(
        (await projectRequest<{ operations: CloneOperation[] }>('/project-clones')).operations,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load clone operations.');
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const running = operations.some((op) => op.state === 'running');
  useEffect(() => {
    if (!running) return;
    const interval = setInterval(() => void refresh(), 1000);
    return () => clearInterval(interval);
  }, [running, refresh]);
  return (
    <details className="rounded fill-group p-3 text-sm">
      <summary className="cursor-pointer font-medium">
        {ko ? 'Git 저장소 복제' : 'Clone Git repository'}
      </summary>
      <div className="mt-3 flex flex-col gap-2">
        <p className="text-xs text-muted-foreground">
          {ko
            ? '새 폴더에 복제한 뒤 프로젝트에 연결하세요. 복제만으로 저장소가 신뢰되거나 코드가 실행되지는 않습니다.'
            : 'Clone into a new folder, then link it to the project. Cloning does not grant trust or execute repository code.'}
        </p>
        <label className="flex flex-col gap-1 text-xs">
          {ko ? '저장소 주소' : 'Repository URL'}
          <input
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="https://github.com/owner/repository.git"
            className="rounded fill-control px-2 py-1 text-sm"
            spellCheck={false}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          {ko ? '새 폴더의 전체 경로' : 'Absolute path of new folder'}
          <input
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            className="rounded fill-control px-2 py-1 text-sm"
            spellCheck={false}
          />
        </label>
        <Button
          type="button"
          size="compact"
          className="self-start"
          disabled={busy || !source.trim() || !destination.trim()}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              await projectRequest('/project-clones', {
                commandId: `clone_${crypto.randomUUID()}`,
                source: source.trim(),
                destination: destination.trim(),
              });
              await refresh();
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Could not start clone.');
            } finally {
              setBusy(false);
            }
          }}
        >
          {ko ? '복제 시작' : 'Start clone'}
        </Button>
        <ul className="flex flex-col gap-2">
          {operations
            .slice(-6)
            .reverse()
            .map((op) => (
              <li
                key={op.id}
                className="flex flex-wrap items-center gap-2 border-t border-line pt-2"
              >
                <div className="min-w-0 flex-1 text-xs">
                  <div className="truncate" title={op.destination}>
                    {op.destination}
                  </div>
                  <span
                    role={op.state === 'running' ? 'status' : undefined}
                    className="text-muted-foreground"
                  >
                    {op.progress}
                  </span>
                </div>
                {op.state === 'running' ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="compact"
                    onClick={async () => {
                      try {
                        await projectRequest(`/project-clones/${op.id}/cancel`, {});
                        await refresh();
                      } catch (e) {
                        setError(e instanceof Error ? e.message : 'Cancellation failed.');
                      }
                    }}
                  >
                    {ko ? '취소' : 'Cancel'}
                  </Button>
                ) : null}
                {op.state === 'completed' ? (
                  <Button
                    type="button"
                    variant="tertiary"
                    size="compact"
                    onClick={() => onSelect(op.destination)}
                  >
                    {ko ? '이 폴더 선택' : 'Use this folder'}
                  </Button>
                ) : null}
                {op.state !== 'running' &&
                op.state !== 'completed' &&
                op.partialDirectory &&
                op.cleanupConfirmed ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="compact"
                    onClick={async () => {
                      try {
                        await projectRequest(`/project-clones/${op.id}/remove-partial`, {});
                        await refresh();
                      } catch (e) {
                        setError(e instanceof Error ? e.message : 'Cleanup failed.');
                      }
                    }}
                  >
                    {ko ? '미완료 폴더 정리' : 'Remove partial folder'}
                  </Button>
                ) : null}
              </li>
            ))}
        </ul>
        {error ? (
          <p role="alert" className="text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </details>
  );
}
