import type {
  VoiceClient,
  VoiceConfiguration,
  VoiceTarget,
  VoiceTranscript,
  VoiceTranscriptReceipt,
} from '@corral/client';
import { Mic } from '@corral/react/icons';
import {
  Button,
  Dialog,
  DialogDescription,
  DialogPopup,
  DialogTitle,
  Select,
} from '@corral/react/ui';
import { useEffect, useRef, useState } from 'react';
import { useLocale } from '../locale.tsx';
import { LiveVoiceRuntime, type VoiceSnapshot } from './live-voice-runtime.ts';

export function LiveVoice({
  api,
  target,
  targetLabel,
  onTranscript,
}: {
  api: VoiceClient | null;
  target: VoiceTarget;
  targetLabel: string;
  onTranscript: (input: VoiceTranscript) => Promise<VoiceTranscriptReceipt>;
}) {
  const { locale } = useLocale();
  const ko = locale === 'ko';
  const [open, setOpen] = useState(false);
  const [configuration, setConfiguration] = useState<VoiceConfiguration>();
  const [profile, setProfile] = useState('');
  const [model, setModel] = useState('');
  const [error, setError] = useState('');
  const [pinned, setPinned] = useState<{ target: VoiceTarget; label: string }>();
  const [snapshot, setSnapshot] = useState<VoiceSnapshot>({
    state: 'idle',
    elapsedSeconds: 0,
    inputTokens: 0,
    outputTokens: 0,
    utterances: [],
  });
  const runtime = useRef<LiveVoiceRuntime>(undefined);
  const trigger = useRef<HTMLButtonElement>(null);
  const callback = useRef(onTranscript);
  callback.current = onTranscript;
  const active = ['connecting', 'listening', 'responding'].includes(snapshot.state);
  useEffect(() => {
    if (!open || !api) return;
    let current = true;
    api
      .configuration()
      .then((value) => {
        if (current) {
          setConfiguration(value);
          setModel(value.models[0]?.id ?? '');
        }
      })
      .catch(
        () =>
          current &&
          setError(ko ? '음성 설정을 불러오지 못했습니다.' : 'Could not load voice configuration.'),
      );
    return () => {
      current = false;
    };
  }, [open, api, ko]);
  useEffect(() => {
    const stop = () => void runtime.current?.stop();
    window.addEventListener('pagehide', stop);
    return () => {
      window.removeEventListener('pagehide', stop);
      stop();
    };
  }, []);
  useEffect(() => {
    const call = runtime.current;
    if (
      call &&
      (call.target.hostId !== target.hostId || call.target.sessionId !== target.sessionId)
    )
      void call.stop();
  }, [target.hostId, target.sessionId]);
  const start = async () => {
    if (!api || !profile || !model || active) return;
    await runtime.current?.stop();
    const fixed = { ...target };
    setPinned({ target: fixed, label: targetLabel });
    setError('');
    const next = new LiveVoiceRuntime(api, fixed, (input) => callback.current(input), setSnapshot);
    runtime.current = next;
    await next.start(profile, model);
  };
  const changed =
    pinned &&
    (pinned.target.hostId !== target.hostId ||
      pinned.target.sessionId !== target.sessionId ||
      pinned.target.runId !== target.runId);
  const states: Record<VoiceSnapshot['state'], string> = ko
    ? {
        idle: '연결 전',
        connecting: '연결 중',
        listening: '듣는 중',
        responding: '응답 중',
        ended: '종료됨',
        error: '연결 끊김',
      }
    : {
        idle: 'Not connected',
        connecting: 'Connecting',
        listening: 'Listening',
        responding: 'Responding',
        ended: 'Ended',
        error: 'Disconnected',
      };
  return (
    <>
      <Button
        ref={trigger}
        variant="ghost"
        size="icon-sm"
        aria-label={ko ? '라이브 음성' : 'Live voice'}
        onClick={() => setOpen(true)}
      >
        <Mic />
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          if (!value) void runtime.current?.stop();
        }}
      >
        <DialogPopup className="max-w-lg overflow-y-auto p-6" finalFocus={trigger}>
          <DialogTitle>{ko ? '라이브 음성' : 'Live voice'}</DialogTitle>
          <DialogDescription>
            {ko
              ? '마이크 음성은 선택한 OpenAI 계정으로 전송되며 사용 요금이 발생합니다. Corral은 녹음을 저장하지 않습니다. 확정된 발화는 세션에 일반 요청으로 기록됩니다.'
              : 'Microphone audio is sent to the selected OpenAI account and incurs usage charges. Corral does not store recordings. Final transcripts are recorded as ordinary session requests.'}
          </DialogDescription>
          <div className="mt-4 flex flex-col gap-3 text-ui">
            <p>
              {ko ? '대상' : 'Destination'}: {pinned?.label ?? targetLabel} ·{' '}
              {pinned?.target.runId ?? target.runId ?? (ko ? '다음 요청' : 'Next request')}
            </p>
            {changed && (
              <p role="status">
                {ko
                  ? '대상 화면이 변경되었습니다. 기존 통화의 대상은 고정됩니다. 종료 후 다시 연결하면 현재 대상으로 전환됩니다.'
                  : 'The visible destination changed. This call remains pinned. End and reconnect to switch explicitly.'}
              </p>
            )}
            {!api ? (
              <p>
                {ko
                  ? '실제 Corral 서버에 연결해야 음성을 사용할 수 있습니다.'
                  : 'Connect to a real Corral server to use voice.'}
              </p>
            ) : (
              <>
                <Select
                  label={ko ? '기존 API 키 프로필' : 'Existing API-key profile'}
                  value={profile}
                  onValueChange={setProfile}
                  disabled={active}
                  options={[
                    { value: '', label: ko ? '프로필 선택' : 'Choose a profile' },
                    ...(configuration?.profiles ?? [])
                      .filter((item) => item.available)
                      .map((item) => ({ value: item.id, label: item.id })),
                  ]}
                />
                <Select
                  label={ko ? '음성 모델' : 'Voice model'}
                  value={model}
                  onValueChange={setModel}
                  disabled={active}
                  options={(configuration?.models ?? []).map((item) => ({
                    value: item.id,
                    label: item.name,
                  }))}
                />
                {configuration && !configuration.profiles.some((item) => item.available) && (
                  <p>
                    {ko
                      ? 'OpenAI 공식 API 키가 설정된 프로필이 없습니다. 구독 로그인과 사용자 지정 엔드포인트는 음성을 지원하지 않습니다.'
                      : 'No profile has an official OpenAI API key. Subscription logins and custom endpoints are unsupported for voice.'}
                  </p>
                )}
                <p role="status">
                  {states[snapshot.state]} · {snapshot.elapsedSeconds}s /{' '}
                  {configuration?.maxDurationSeconds ?? 300}s
                </p>
                <p className="text-muted">
                  {ko ? '음성 사용량' : 'Voice usage'}: {snapshot.inputTokens}{' '}
                  {ko ? '입력' : 'input'} / {snapshot.outputTokens}{' '}
                  {ko ? '출력 토큰' : 'output tokens'} · {ko ? '응답당 최대' : 'Per-response cap'}{' '}
                  {configuration?.maxOutputTokensPerResponse ?? 384}.{' '}
                  {ko
                    ? '전사 요금은 별도이며 비용은 계정의 청구 내역에서 확인하세요.'
                    : 'Transcription is billed separately; see account billing for cost.'}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button disabled={active || !profile || !model} onClick={() => void start()}>
                    {ko ? '연결' : 'Connect'}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={snapshot.state !== 'responding'}
                    onClick={() => runtime.current?.interrupt()}
                  >
                    {ko ? '응답 중단' : 'Interrupt'}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={!active}
                    onClick={() => void runtime.current?.stop()}
                  >
                    {ko ? '통화 종료' : 'End call'}
                  </Button>
                </div>
              </>
            )}
            {(error || snapshot.error) && <p role="alert">{error || snapshot.error}</p>}
            <div className="max-h-52 overflow-y-auto" aria-live="polite">
              {snapshot.utterances.map((utterance) => (
                <div className="border-t border-line py-2" key={utterance.commandId}>
                  <p>{utterance.text}</p>
                  <p className="text-muted">
                    {utterance.receipt?.message ??
                      utterance.receipt?.status ??
                      (ko ? '접수 확인 중' : 'Confirming receipt')}
                  </p>
                  {utterance.receipt?.status === 'rejected' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void runtime.current?.retry(utterance.commandId)}
                    >
                      {ko ? '같은 요청 재시도' : 'Retry same request'}
                    </Button>
                  )}
                  {utterance.receipt?.alternatives?.map((delivery) => (
                    <Button
                      key={delivery}
                      size="sm"
                      variant="ghost"
                      onClick={() => void runtime.current?.retry(utterance.commandId, delivery)}
                    >
                      {delivery === 'queue'
                        ? ko
                          ? '대기열에 추가'
                          : 'Add to queue'
                        : ko
                          ? '다음 요청으로 보내기'
                          : 'Send as next request'}
                    </Button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </DialogPopup>
      </Dialog>
    </>
  );
}
