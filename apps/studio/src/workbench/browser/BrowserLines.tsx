// The lines a browser tab shows around its page (features/browser-tab.md 권한, 내려받기, 새 창과
// 팝업): under the head, a page's permission asks and its downloads; under the page's place, a
// preview's blocked move. Each is the kit's full-bleed banner, so it pushes the page rather than
// lying over it, and says its news politely; none takes the focus.
import { Banner, BannerAction, BannerActions, BannerTitle } from '@corral/react/design-kit';
import { useLocale, useTranslations } from 'use-intl';
import type {
  BrowserBridge,
  BrowserDownload,
  SitePermission,
} from '../../../../desktop/src/browser-bridge.ts';
import { useBrowserAsks, useBrowserDownloads } from './browserTabs.tsx';

/** A Korean syllable with a final consonant takes 과 and 을; one without takes 와 and 를. */
function closed(word: string): boolean {
  const code = word.trim().codePointAt(word.trim().length - 1) ?? 0;
  return code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 !== 0;
}

/** The permissions a line names, as the language says a list of them. */
export function permissionList(names: string[], locale: string): string {
  if (locale.startsWith('ko')) {
    // 카메라와 마이크를, 위치를: the object of 쓰려고 합니다, joined as Korean joins nouns.
    const last = names.at(-1) ?? '';
    const before = names.slice(0, -1);
    const head = before.length
      ? `${before
          .slice(0, -1)
          .map((name) => `${name}, `)
          .join('')}${before.at(-1)}${closed(before.at(-1) ?? '') ? '과' : '와'} `
      : '';
    return `${head}${last}${closed(last) ? '을' : '를'}`;
  }
  return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(names);
}

const host = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

export function PermissionLines({ bridge, tabId }: { bridge: BrowserBridge; tabId: string }) {
  const t = useTranslations('Browser');
  const locale = useLocale();
  const asks = useBrowserAsks(tabId);
  const name = (permission: SitePermission) => t(`permission.${permission}`);
  return asks.map((ask) => (
    <Banner key={ask.requestId} variant="fixed" size="compact" data-browser-line="permission">
      <BannerTitle>
        {t('permissionAsk', {
          site: host(ask.origin),
          permissions: permissionList(ask.permissions.map(name), locale),
        })}
      </BannerTitle>
      <BannerActions>
        <BannerAction
          variant="secondary"
          onClick={() => void bridge.answerPermission(tabId, ask.requestId, true).catch(() => {})}
        >
          {t('allow')}
        </BannerAction>
        <BannerAction
          variant="ghost"
          onClick={() => void bridge.answerPermission(tabId, ask.requestId, false).catch(() => {})}
        >
          {t('deny')}
        </BannerAction>
      </BannerActions>
    </Banner>
  ));
}

function downloadText(download: BrowserDownload, t: ReturnType<typeof useTranslations>) {
  const name = download.name;
  if (download.state === 'completed') return t('downloaded', { name });
  if (download.state === 'interrupted') return t('downloadInterrupted', { name });
  if (download.totalBytes <= 0) return t('downloadingNoSize', { name });
  const percent = Math.min(100, Math.floor((download.receivedBytes / download.totalBytes) * 100));
  return t('downloading', { name, percent: String(percent) });
}

export function DownloadLines({ bridge, tabId }: { bridge: BrowserBridge; tabId: string }) {
  const t = useTranslations('Browser');
  const downloads = useBrowserDownloads(tabId);
  return downloads.map((download) => (
    <Banner
      key={download.downloadId}
      variant="fixed"
      size="compact"
      status={download.state === 'interrupted' ? 'warning' : 'default'}
      // A warning banner would interrupt; this news is polite like the rest.
      role="status"
      data-browser-line="download"
    >
      <BannerTitle>{downloadText(download, t)}</BannerTitle>
      {download.state === 'progressing' ? (
        <BannerActions>
          <BannerAction
            variant="ghost"
            onClick={() => void bridge.cancelDownload(download.downloadId).catch(() => {})}
          >
            {t('cancel')}
          </BannerAction>
        </BannerActions>
      ) : download.state === 'completed' ? (
        <BannerActions>
          <BannerAction
            variant="secondary"
            onClick={() => void bridge.showDownload(download.downloadId).catch(() => {})}
          >
            {t('showInFolder')}
          </BannerAction>
        </BannerActions>
      ) : null}
    </Banner>
  ));
}

/** A preview page's latest move off its lease, held where it was; its address may open outside. */
export function BlockedLine({
  bridge,
  tabId,
  blocked,
}: {
  bridge: BrowserBridge;
  tabId: string;
  blocked: { url: string | null } | null;
}) {
  const t = useTranslations('Browser');
  if (!blocked) return null;
  return (
    <Banner variant="fixed" size="compact" data-browser-line="blocked">
      <BannerTitle>{t('blockedMove')}</BannerTitle>
      {blocked.url ? (
        <BannerActions>
          <BannerAction
            variant="secondary"
            onClick={() => void bridge.openBlocked(tabId).catch(() => {})}
          >
            {t('openSystem')}
          </BannerAction>
        </BannerActions>
      ) : null}
    </Banner>
  );
}
