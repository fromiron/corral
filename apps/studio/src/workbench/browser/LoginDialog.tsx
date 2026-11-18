// A site's HTTP sign-in (features/browser-tab.md 불러오기와 오류: HTTP 인증): "{origin}에 로그인",
// a user name and a hidden password, 취소 then 로그인, the focus first on the user name. Cancel
// or Escape answers null, so the site's 401 page shows. What was typed goes to the desktop's
// answer only: it is held in this dialog's state and nowhere else, and it goes with the dialog.
import {
  Button,
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  InputField,
  InputGroup,
} from '@corral/react/design-kit';
import { type FormEvent, useId, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import type { BrowserBridge } from '../../../../desktop/src/browser-bridge.ts';
import { useBrowserLogins } from './browserTabs.tsx';

export function LoginDialog({
  bridge,
  tabId,
  visible,
}: {
  bridge: BrowserBridge;
  tabId: string;
  /** Only the tab on screen asks; another tab's request waits until it is chosen. */
  visible: boolean;
}) {
  const logins = useBrowserLogins(tabId);
  const login = visible ? logins[0] : undefined;
  if (!login) return null;
  // A new request is a new dialog: nothing typed for the last one carries over.
  return <LoginForm key={login.requestId} bridge={bridge} tabId={tabId} {...login} />;
}

function LoginForm({
  bridge,
  tabId,
  requestId,
  origin,
}: {
  bridge: BrowserBridge;
  tabId: string;
  requestId: string;
  origin: string;
}) {
  const t = useTranslations('Browser');
  const id = useId();
  const form = useRef<HTMLFormElement>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  // Answered: the dialog waits for main's word that the request is over.
  const [answered, setAnswered] = useState(false);
  const answer = (credentials: { username: string; password: string } | null) => {
    if (answered) return;
    setAnswered(true);
    void bridge.answerLogin(tabId, requestId, credentials).catch(() => {});
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    answer({ username, password });
  };
  return (
    <Dialog
      open={!answered}
      onOpenChange={(open) => {
        if (!open) answer(null);
      }}
    >
      <DialogPopup
        initialFocus={() => form.current?.querySelector('input') ?? true}
        className="w-[min(95vw,420px)]"
      >
        <form ref={form} onSubmit={submit} aria-labelledby={`${id}-title`}>
          <DialogHeader>
            <DialogTitle id={`${id}-title`}>{t('signInTitle', { origin })}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <InputGroup className="w-full">
              <InputField
                index={0}
                label={t('userName')}
                value={username}
                onChange={setUsername}
                autoComplete="off"
                spellCheck={false}
              />
              <InputField
                index={1}
                type="password"
                label={t('password')}
                value={password}
                onChange={setPassword}
                autoComplete="off"
              />
            </InputGroup>
          </DialogPanel>
          <DialogFooter>
            <Button variant="tertiary" onClick={() => answer(null)}>
              {t('cancel')}
            </Button>
            <Button type="submit">{t('signIn')}</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
