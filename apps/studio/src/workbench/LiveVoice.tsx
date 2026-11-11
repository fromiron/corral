import type {
  VoiceClient,
  VoiceConfiguration,
  VoiceTarget,
  VoiceTranscript,
  VoiceTranscriptReceipt,
} from '@corral/client';
import {
  Button,
  Dialog,
  DialogDescription,
  DialogPopup,
  DialogTitle,
  Select,
  Tooltip,
} from '@corral/react/design-kit';
import { Mic } from '@corral/react/icons';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
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
  const t = useTranslations('LiveVoice');
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
      .catch(() => current && setError(t('loadFailed')));
    return () => {
      current = false;
    };
  }, [open, api, t]);
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
  return (
    <>
      <Tooltip content={t('title')}>
        <Button
          ref={trigger}
          variant="ghost"
          size="icon-compact"
          aria-label={t('title')}
          onClick={() => setOpen(true)}
        >
          <Mic />
        </Button>
      </Tooltip>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          if (!value) void runtime.current?.stop();
        }}
      >
        <DialogPopup className="max-w-lg overflow-y-auto p-6" finalFocus={trigger}>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
          <div className="mt-4 flex flex-col gap-3 text-ui">
            <p>
              {t('destination', {
                target: pinned?.label ?? targetLabel,
                run: pinned?.target.runId ?? target.runId ?? t('nextRequest'),
              })}
            </p>
            {changed && <p role="status">{t('destinationChanged')}</p>}
            {!api ? (
              <p>{t('serverOnly')}</p>
            ) : (
              <>
                <Select
                  label={t('profile')}
                  value={profile}
                  onValueChange={setProfile}
                  disabled={active}
                  options={[
                    { value: '', label: t('chooseProfile') },
                    ...(configuration?.profiles ?? [])
                      .filter((item) => item.available)
                      .map((item) => ({ value: item.id, label: item.id })),
                  ]}
                />
                <Select
                  label={t('model')}
                  value={model}
                  onValueChange={setModel}
                  disabled={active}
                  options={(configuration?.models ?? []).map((item) => ({
                    value: item.id,
                    label: item.name,
                  }))}
                />
                {configuration && !configuration.profiles.some((item) => item.available) && (
                  <p>{t('noProfile')}</p>
                )}
                <p role="status">
                  {t(`state.${snapshot.state}`)} · {snapshot.elapsedSeconds}s /{' '}
                  {configuration?.maxDurationSeconds ?? 300}s
                </p>
                <p className="text-muted-foreground">
                  {t('usage', {
                    input: snapshot.inputTokens,
                    output: snapshot.outputTokens,
                    cap: configuration?.maxOutputTokensPerResponse ?? 384,
                  })}{' '}
                  {t('transcriptionBilling')}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button disabled={active || !profile || !model} onClick={() => void start()}>
                    {t('connect')}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={snapshot.state !== 'responding'}
                    onClick={() => runtime.current?.interrupt()}
                  >
                    {t('interrupt')}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={!active}
                    onClick={() => void runtime.current?.stop()}
                  >
                    {t('endCall')}
                  </Button>
                </div>
              </>
            )}
            {(error || snapshot.error) && <p role="alert">{error || snapshot.error}</p>}
            <div className="max-h-52 overflow-y-auto" aria-live="polite">
              {snapshot.utterances.map((utterance) => (
                <div className="border-t border-line py-2" key={utterance.commandId}>
                  <p>{utterance.text}</p>
                  <p className="text-muted-foreground">
                    {utterance.receipt?.message ?? utterance.receipt?.status ?? t('confirming')}
                  </p>
                  {utterance.receipt?.status === 'rejected' && (
                    <Button
                      size="compact"
                      variant="ghost"
                      onClick={() => void runtime.current?.retry(utterance.commandId)}
                    >
                      {t('retry')}
                    </Button>
                  )}
                  {utterance.receipt?.alternatives?.map((delivery) => (
                    <Button
                      key={delivery}
                      size="compact"
                      variant="ghost"
                      onClick={() => void runtime.current?.retry(utterance.commandId, delivery)}
                    >
                      {t(delivery === 'queue' ? 'addToQueue' : 'sendNext')}
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
