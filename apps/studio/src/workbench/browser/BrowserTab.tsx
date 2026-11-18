// A browser tab's body (features/browser-tab.md 머리, 불러오기와 오류): a one-line head (back,
// forward, reload or stop, the address field, ⋯) over the page's place. The page itself is the
// desktop's native view, laid over that place; what the place shows besides (an empty new tab, a
// page that could not open, one that closed itself, an ended preview) is drawn here.
import {
  Button,
  EmptyState,
  Input,
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
  Tooltip,
} from '@corral/react/design-kit';
import { ArrowLeft, ArrowRight, Ellipsis, RefreshCw, X } from '@corral/react/icons';
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useTranslations } from 'use-intl';
import type { BrowserFailure, BrowserTabState } from '../../../../desktop/src/browser-bridge.ts';
import { desktop } from '../../desktop.tsx';
import { type BrowserTab as Tab, useBrowserPage, useBrowserTabsContext } from './browserTabs.tsx';

const useBrowserT = () => useTranslations('Browser');
type Translate = ReturnType<typeof useBrowserT>;

export function BrowserTab({ tab, visible }: { tab: Tab; visible: boolean }) {
  const t = useBrowserT();
  const tabs = useBrowserTabsContext();
  const page = useBrowserPage(tab.browserId);
  const preview = Boolean(tab.lease);
  const address = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLDivElement>(null);
  // What the field shows: the page's address until the person edits it.
  const [draft, setDraft] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const shown = page?.url ?? (tab.at ? `${tab.at.origin}${tab.at.path}` : '');
  const hasPage = Boolean(page && page.page !== 'none');
  const live = page?.page === 'live';

  // The address field takes the focus when asked (a new tab, Shift+Escape from the page).
  const asked = tabs?.pages.focusAsked(tab.browserId) ?? 0;
  useEffect(() => {
    if (asked > 0) address.current?.focus();
  }, [asked]);

  // The view lies over the page's place while the tab is on screen with a live page; otherwise
  // it is hidden (features/browser-tab.md 앱 화면과 겹칠 때).
  const bridge = tabs?.bridge;
  useLayoutEffect(() => {
    const element = area.current;
    if (!bridge || !element) return;
    const tabId = tab.browserId;
    if (!visible || !live) {
      void bridge.place(tabId, null).catch(() => {});
      return;
    }
    const send = () => {
      const box = element.getBoundingClientRect();
      void bridge
        .place(tabId, { x: box.left, y: box.top, width: box.width, height: box.height })
        .catch(() => {});
    };
    send();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(send);
    observer?.observe(element);
    window.addEventListener('resize', send);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', send);
      void bridge.place(tabId, null).catch(() => {});
    };
  }, [bridge, tab.browserId, visible, live]);

  if (!tabs) return null;
  const tabId = tab.browserId;
  const act = (run: (id: string) => Promise<unknown>) => () => void run(tabId).catch(() => {});
  const { bridge: b } = tabs;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (preview || draft === null) return;
    const typed = draft;
    void tabs.navigate(tabId, typed).then(
      (result) => {
        setUnsupported(!result.ok);
        if (result.ok) setDraft(null);
      },
      () => {},
    );
  };
  const openSystem = () => {
    if (page?.url) void desktop?.openExternal(page.url).catch(() => {});
  };
  const copy = () => {
    if (shown) void navigator.clipboard?.writeText(shown).catch(() => {});
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-slot="browser-tab">
      <div className="relative flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
        <Tooltip content={t('back')}>
          <Button
            size="icon"
            variant="ghost"
            aria-label={t('back')}
            disabled={!hasPage || !page?.canGoBack}
            onClick={act((id) => b.back(id))}
          >
            <ArrowLeft />
          </Button>
        </Tooltip>
        <Tooltip content={t('forward')}>
          <Button
            size="icon"
            variant="ghost"
            aria-label={t('forward')}
            disabled={!hasPage || !page?.canGoForward}
            onClick={act((id) => b.forward(id))}
          >
            <ArrowRight />
          </Button>
        </Tooltip>
        {page?.loading ? (
          <Tooltip content={t('stop')}>
            <Button
              size="icon"
              variant="ghost"
              aria-label={t('stop')}
              onClick={act((id) => b.stop(id))}
            >
              <X />
            </Button>
          </Tooltip>
        ) : (
          <Tooltip content={t('reload')}>
            <Button
              size="icon"
              variant="ghost"
              aria-label={t('reload')}
              disabled={!hasPage}
              onClick={act((id) => b.reload(id))}
            >
              <RefreshCw />
            </Button>
          </Tooltip>
        )}
        <form className="min-w-0 flex-1" onSubmit={submit}>
          <Input
            ref={address}
            data-browser-address=""
            aria-label={t('address')}
            aria-invalid={unsupported || undefined}
            readOnly={preview}
            value={draft ?? shown}
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              setUnsupported(false);
            }}
            onBlur={() => {
              if (!unsupported) setDraft(null);
            }}
            spellCheck={false}
            autoComplete="off"
          />
        </form>
        <Menu>
          <Tooltip content={t('more')}>
            <MenuTrigger render={<Button size="icon" variant="ghost" aria-label={t('more')} />}>
              <Ellipsis />
            </MenuTrigger>
          </Tooltip>
          <MenuPopup align="end">
            <MenuItem
              disabled={preview || !page?.url}
              description={preview ? t('previewInside') : undefined}
              onClick={openSystem}
            >
              {t('openSystem')}
            </MenuItem>
            <MenuItem disabled={!shown} onClick={copy}>
              {t('copyAddress')}
            </MenuItem>
          </MenuPopup>
        </Menu>
        {page?.loading ? (
          <div
            aria-hidden="true"
            data-slot="browser-progress"
            className="pulse-soft absolute inset-x-0 bottom-0 h-0.5 bg-primary"
          />
        ) : null}
      </div>
      {unsupported ? (
        <p role="alert" className="px-3 py-1 text-caption text-danger">
          {t('onlyWeb')}
        </p>
      ) : null}
      {/* Polite news of the page: loading, failing, closing itself, ending. */}
      <p role="status" className="sr-only">
        {announce(page, t)}
      </p>
      <div
        ref={area}
        data-slot="browser-page"
        data-live={live ? '' : undefined}
        className="relative min-h-0 flex-1"
      >
        <PagePlace
          page={page}
          onRetry={act((id) => b.reload(id))}
          onReopen={act((id) => b.reopen(id))}
          onBack={act((id) => b.back(id))}
          onProceed={(challengeId) =>
            void tabs.bridge.proceedCertificate(tabId, challengeId).catch(() => {})
          }
          onSystem={preview ? null : openSystem}
        />
      </div>
    </div>
  );
}

function announce(page: BrowserTabState | undefined, t: Translate): string {
  if (!page) return '';
  if (page.loading) return t('loading');
  if (page.page === 'failed') return failureText(page.failure, t);
  if (page.page === 'closed-itself') return t('closedItself');
  if (page.page === 'ended') return t('ended');
  return '';
}

function failureText(failure: BrowserFailure | null, t: Translate): string {
  if (failure?.certificate) return t('certificate.title');
  switch (failure?.kind) {
    case 'name-not-resolved':
      return t('failure.nameNotResolved');
    case 'connection-refused':
      return t('failure.connectionRefused');
    case 'timed-out':
      return t('failure.timedOut');
    case 'offline':
      return t('failure.offline');
    case 'crashed':
      return t('failure.crashed');
    default:
      return t('failure.other');
  }
}

function certificateReason(
  reason: NonNullable<BrowserFailure['certificate']>['reason'],
  t: Translate,
): string {
  switch (reason) {
    case 'expired':
      return t('certificate.expired');
    case 'name-mismatch':
      return t('certificate.nameMismatch');
    case 'self-signed':
      return t('certificate.selfSigned');
    case 'untrusted':
      return t('certificate.untrusted');
    case 'revoked':
      return t('certificate.revoked');
    default:
      return t('certificate.other');
  }
}

/** What the page's place shows when no live page is over it. */
function PagePlace({
  page,
  onRetry,
  onReopen,
  onBack,
  onProceed,
  onSystem,
}: {
  page: BrowserTabState | undefined;
  onRetry: () => void;
  onReopen: () => void;
  onBack: () => void;
  onProceed: (challengeId: string) => void;
  onSystem: (() => void) | null;
}) {
  const t = useBrowserT();
  const reopen = useRef<HTMLButtonElement>(null);
  // The page closed itself while it had the focus: the focus goes to "다시 열기".
  const closedWithFocus = page?.page === 'closed-itself' && page.pageFocused;
  useEffect(() => {
    if (closedWithFocus) reopen.current?.focus();
  }, [closedWithFocus]);
  if (!page || page.page === 'none' || page.page === 'live') return null;
  const system = onSystem ? (
    <Button variant="tertiary" onClick={onSystem}>
      {t('openSystem')}
    </Button>
  ) : null;
  let body: ReactNode;
  if (page.page === 'failed' && page.failure?.certificate) {
    const { reason, challengeId } = page.failure.certificate;
    body = (
      <EmptyState
        title={t('certificate.title')}
        text={certificateReason(reason, t)}
        action={
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            <Button variant="secondary" onClick={onBack}>
              {t('goBack')}
            </Button>
            {system}
            {challengeId ? (
              <Button variant="ghost" onClick={() => onProceed(challengeId)}>
                {t('openAnyway')}
              </Button>
            ) : null}
          </div>
        }
      />
    );
  } else if (page.page === 'failed')
    body = (
      <EmptyState
        title={failureText(page.failure, t)}
        action={
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            <Button variant="secondary" onClick={onRetry}>
              {t('tryAgain')}
            </Button>
            {system}
          </div>
        }
      />
    );
  else if (page.page === 'closed-itself')
    body = (
      <EmptyState
        title={t('closedItself')}
        action={
          <div className="mt-3 flex justify-center">
            <Button ref={reopen} variant="secondary" onClick={onReopen}>
              {t('reopen')}
            </Button>
          </div>
        }
      />
    );
  else body = <EmptyState title={t('ended')} />;
  return <div className="flex h-full items-center justify-center p-6">{body}</div>;
}
