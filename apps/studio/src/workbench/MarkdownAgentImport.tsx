import type { EffectiveHarnessSnapshot } from '@corral/contracts';
import type { EditorDraft, EditorStore } from '@corral/react';
import { Dialog, DialogPopup, DialogTitle, Select } from '@corral/react/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocale } from 'use-intl';
import { useStore } from 'zustand';
import { useServices } from '../services.tsx';
import {
  importMarkdownAgent,
  MAX_AGENT_MARKDOWN_BYTES,
  parseMarkdownAgent,
  toolTargets,
} from './markdownAgentImport.ts';
import type { ProfileInfo } from './useModels.ts';

export function MarkdownAgentImport({
  editor,
  profiles,
  projectId,
}: {
  editor: EditorStore;
  profiles: ProfileInfo[] | null;
  projectId: string;
}) {
  const ko = useLocale().startsWith('ko');
  const { harnesses } = useServices();
  const text = (english: string, korean: string) => (ko ? korean : english);
  const draft = useStore(editor, (state) => state.draft);
  const parents = draft.definition.nodes.filter((node) => node.type === 'agent');
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState('');
  const [parentNodeId, setParent] = useState('');
  const [modelProfile, setModel] = useState('');
  const [mappings, setMappings] = useState<Record<string, string>>({});
  const [fileError, setFileError] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [status, setStatus] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const candidate = useMemo(() => parseMarkdownAgent(source), [source]);
  const suffix = useRef(crypto.randomUUID());
  const parent = parents.find((node) => node.id === parentNodeId);
  const role = draft.definition.roles.find((role) => role.id === parent?.roleId);
  const harnessKey = `${projectId}:${parentNodeId}:${role?.harness?.profileId ?? ''}:${role?.harness?.revision ?? ''}`;
  const [harness, setHarness] = useState<{
    key: string;
    snapshot?: EffectiveHarnessSnapshot;
    error?: string;
  } | null>(null);
  const currentHarness = harness?.key === harnessKey ? harness : null;
  useEffect(() => {
    const binding = role?.harness;
    setHarness(null);
    if (!open || !binding || !harnesses) return;
    let active = true;
    void harnesses.preview(binding, projectId).then(
      (value) => active && setHarness({ key: harnessKey, snapshot: value.snapshot }),
      () =>
        active && setHarness({ key: harnessKey, error: 'Could not verify the parent work style.' }),
    );
    return () => {
      active = false;
    };
  }, [open, harnessKey, harnesses, projectId, role?.harness]);
  const available = profiles?.filter((profile) => profile.available) ?? [];
  let preview: EditorDraft | null = null;
  let error = '';
  if (source.trim()) {
    try {
      preview = importMarkdownAgent({
        draft,
        candidate,
        parentNodeId,
        modelProfile,
        profiles: profiles ?? [],
        mappings,
        suffix: suffix.current,
        parentHarness: currentHarness?.snapshot,
      });
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
  }
  const importedRole = preview?.definition.roles.at(-1);
  const close = () => {
    setOpen(false);
  };
  const updateSource = (value: string) => {
    setSource(value);
    setMappings({});
    setConfirmed(false);
    setFileError('');
  };
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="rounded-md fill-control px-3 py-1.5 text-sm"
        onClick={() => {
          suffix.current = crypto.randomUUID();
          setConfirmed(false);
          setStatus('');
          setOpen(true);
        }}
      >
        {text('Import Markdown agent', 'Markdown 에이전트 가져오기')}
      </button>
      {status ? (
        <span role="status" className="text-xs text-muted">
          {status}
        </span>
      ) : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup
          aria-label={text('Import a callable agent', '위임할 에이전트 가져오기')}
          showCloseButton={false}
          finalFocus={trigger}
          className="max-h-[85dvh] w-[min(42rem,calc(100vw-2rem))] max-w-none overflow-y-auto p-4"
        >
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <DialogTitle className="text-base font-semibold">
                {text('Import a callable agent', '위임할 에이전트 가져오기')}
              </DialogTitle>
              <button
                type="button"
                className="rounded fill-control px-2 py-1 text-sm"
                onClick={close}
              >
                {text('Close', '닫기')}
              </button>
            </div>
            <p className="text-xs text-muted">
              {text(
                'Review the prompt, model and tool translations. Import adds a callable node and a delegation link to this team. Save the team to use it on the next run.',
                '프롬프트·모델·도구 변환을 검토하세요. 현재 팀에 호출형 노드와 위임 연결을 추가합니다. 팀을 저장하면 다음 실행에 적용됩니다.',
              )}
            </p>
            <label className="flex flex-col gap-1 text-sm">
              {text('Markdown file (up to 32 KiB)', 'Markdown 파일 (최대 32 KiB)')}
              <input
                type="file"
                accept=".md,.markdown,text/markdown,text/plain"
                onChange={async (event) => {
                  const file = event.currentTarget.files?.[0];
                  if (!file) return;
                  if (file.size > MAX_AGENT_MARKDOWN_BYTES) {
                    setFileError(text('File exceeds 32 KiB.', '파일 크기는 최대 32 KiB입니다.'));
                    return;
                  }
                  try {
                    updateSource(await file.text());
                  } catch {
                    setFileError(text('Could not read the file.', '파일을 읽지 못했습니다.'));
                  }
                }}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              {text('Markdown source', 'Markdown 원문')}
              <textarea
                value={source}
                onChange={(event) => updateSource(event.target.value)}
                rows={7}
                maxLength={MAX_AGENT_MARKDOWN_BYTES}
                spellCheck={false}
                className="rounded fill-control p-2 font-mono text-xs"
              />
            </label>
            {source ? (
              <section
                className="flex flex-col gap-2 rounded fill-group p-3 text-sm"
                aria-label={text('Import preview', '가져오기 미리보기')}
              >
                <strong>{candidate.name}</strong>
                <p className="whitespace-pre-wrap">{candidate.description}</p>
                <details>
                  <summary className="cursor-pointer">{text('Prompt', '프롬프트')}</summary>
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-xs">
                    {candidate.prompt}
                  </pre>
                </details>
                <p className="text-xs text-muted">
                  {text('Requested model', '문서에 지정된 모델')}:{' '}
                  {candidate.model || text('Not specified', '없음')}
                </p>
              </section>
            ) : null}
            <div className="flex flex-col gap-1 text-sm">
              <span>{text('Parent agent', '위임하는 부모 에이전트')}</span>
              <Select
                label={text('Parent agent', '위임하는 부모 에이전트')}
                value={parentNodeId}
                onValueChange={(value) => {
                  setParent(value);
                  setConfirmed(false);
                }}
                options={[
                  { value: '', label: text('Choose a parent', '부모 선택') },
                  ...parents.map((node) => ({ value: node.id, label: node.label })),
                ]}
              />
            </div>
            {role ? (
              <p className="text-xs text-muted">
                {text('Parent tools', '부모에게 허용된 도구')}: {role.allowedWorkTools.join(', ')}.{' '}
                {text(
                  'To grant more tools, close this dialog and edit the parent’s capabilities in Properties.',
                  '도구를 추가로 허용하려면 이 창을 닫고 부모의 속성에서 권한을 수정하세요.',
                )}
              </p>
            ) : null}
            {role?.harness ? (
              <p className="text-xs text-muted">
                {text('Inherited work style', '상속할 작업 방식')}: {role.harness.profileId} · r
                {role.harness.revision}
                {currentHarness?.snapshot
                  ? ` · ${currentHarness.snapshot.policy}`
                  : ` · ${text('Verifying…', '확인 중…')}`}
              </p>
            ) : (
              <p className="text-xs text-muted">
                {text(
                  'No explicit parent work style. Shell tools require a verified trusted-native work style selected on the parent.',
                  '부모에 명시적으로 선택된 작업 방식이 없습니다. 셸 도구는 부모에게 선택된 trusted-native 작업 방식의 검증이 필요합니다.',
                )}
              </p>
            )}
            {currentHarness?.error ? (
              <p role="alert" className="text-xs text-danger">
                {currentHarness.error}
              </p>
            ) : null}
            <div className="flex flex-col gap-1 text-sm">
              <span>{text('Connected model profile', '연결된 모델 프로필')}</span>
              <Select
                label={text('Connected model profile', '연결된 모델 프로필')}
                value={modelProfile}
                onValueChange={(value) => {
                  setModel(value);
                  setConfirmed(false);
                }}
                options={[
                  { value: '', label: text('Map to a connected model', '연결된 모델에 매핑') },
                  ...available.map((profile) => ({
                    value: profile.profileId,
                    label: profile.label,
                  })),
                ]}
              />
            </div>
            {!available.length ? (
              <p className="text-xs text-muted">
                {text(
                  'Connect a model in Settings → Models before importing.',
                  '설정 → 모델에서 모델을 연결한 뒤 가져오세요.',
                )}
              </p>
            ) : null}
            {candidate.tools.map((tool) => {
              const excluded = tool === 'ask_user' || tool === 'update_plan';
              const targets = toolTargets(tool);
              return (
                <div
                  key={tool}
                  className="flex flex-wrap items-center justify-between gap-2 text-sm"
                >
                  <span>{tool}</span>
                  {excluded ? (
                    <span className="text-xs text-muted">
                      {text('Excluded: handled by parent', '제외됨: 부모가 처리')}
                    </span>
                  ) : (
                    <Select
                      label={`${tool} ${text('mapping', '매핑')}`}
                      value={Object.hasOwn(mappings, tool) ? (mappings[tool] ?? '') : ''}
                      onValueChange={(value) => {
                        setMappings((previous) => ({ ...previous, [tool]: value }));
                        setConfirmed(false);
                      }}
                      options={[
                        { value: '', label: text('Choose a mapping', '매핑 선택') },
                        ...targets.map((target) => ({
                          value: target,
                          disabled:
                            target !== 'ask' &&
                            !(
                              [
                                ...(role?.allowedWorkTools ?? []),
                                ...(role?.allowedCollaborationTools ?? []),
                              ] as string[]
                            ).includes(target),
                          label:
                            tool === 'Edit' && target === 'write_file'
                              ? text('write_file + Hashline editing', 'write_file + Hashline 편집')
                              : target,
                        })),
                        {
                          value: 'omit',
                          label: text('Exclude this tool', '이 도구 제외'),
                          disabled:
                            tool === 'write_artifact' || tool === 'submit_result' || tool === 'ask',
                        },
                      ]}
                    />
                  )}
                </div>
              );
            })}
            {candidate.tools.includes('Glob') ? (
              <p className="text-xs text-muted">
                {text(
                  'list_files lists paths under a folder; it does not implement glob patterns. The agent must inspect the returned paths.',
                  'list_files는 폴더 아래 경로를 나열하며 glob 패턴을 실행하지 않습니다. 에이전트가 반환된 경로를 확인해야 합니다.',
                )}
              </p>
            ) : null}
            {candidate.tools.includes('Edit') ? (
              <p className="text-xs text-muted">
                {text(
                  'Edit selects Hashline mode with the parent’s read_file and write_file permissions. The worker offers read_hashline and edit_hashline; read the current file before editing.',
                  'Edit는 부모의 read_file·write_file 권한으로 Hashline 모드를 선택합니다. 실행 중 read_hashline·edit_hashline이 제공되며 편집 전에 현재 파일을 읽어야 합니다.',
                )}
              </p>
            ) : null}
            {candidate.tools.some(
              (tool) => !toolTargets(tool).length && tool !== 'ask_user' && tool !== 'update_plan',
            ) ? (
              <p className="text-xs text-muted">
                {text(
                  'A tool with no supported equivalent must be explicitly excluded. Unknown tool names must be corrected in the document.',
                  '대응하는 도구가 없으면 명시적으로 제외해야 합니다. 알 수 없는 도구 이름은 문서에서 수정하세요.',
                )}
              </p>
            ) : null}
            {importedRole ? (
              <p className="text-xs">
                {text('Effective child tools', '자식에게 허용할 도구')}:{' '}
                {[...importedRole.allowedWorkTools, ...importedRole.allowedCollaborationTools].join(
                  ', ',
                )}
              </p>
            ) : null}
            <p className="text-xs text-muted">
              {text(
                'Returning a result requires write_artifact and submit_result from the parent. Existing delegation depth, spawn and budget limits remain in force.',
                '결과 반환에는 부모에게 허용된 write_artifact와 submit_result가 필요합니다. 기존 위임 깊이·호출 횟수·예산 한도를 따릅니다.',
              )}
            </p>
            <p className="text-xs text-muted">
              {text(
                'The child can ask this parent for clarification and continue after the reply. Questions do not finish either task or grant user approval.',
                '자식은 이 부모에게 질문하고 답변을 받은 뒤 같은 작업을 이어갑니다. 질문·답변은 작업을 완료하거나 사용자 승인을 부여하지 않습니다.',
              )}
            </p>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              {text(
                'I reviewed the mapping and allow delegation and parent questions (parent: spawn_subagents / await_tasks / ask / reply; child: ask).',
                '매핑을 검토했으며 위임과 부모 질문을 허용합니다 (부모: spawn_subagents / await_tasks / ask / reply, 자식: ask).',
              )}
            </label>
            {fileError || error ? (
              <p role="alert" className="whitespace-pre-wrap text-xs text-danger">
                {fileError || error}
              </p>
            ) : null}
            <button
              type="button"
              disabled={!preview || !confirmed || !!fileError}
              className="self-end rounded bg-accent px-3 py-2 text-sm font-medium text-on-accent disabled:opacity-50"
              onClick={() => {
                if (!preview || !confirmed) return;
                editor.getState().applyDraft(preview);
                editor.getState().select(`import_${suffix.current}`);
                setStatus(
                  text(
                    'Agent added. Save the team to keep this change.',
                    '에이전트를 추가했습니다. 팀을 저장해 변경을 보관하세요.',
                  ),
                );
                close();
                updateSource('');
              }}
            >
              {text('Add to team', '팀에 추가')}
            </button>
          </div>
        </DialogPopup>
      </Dialog>
    </>
  );
}
