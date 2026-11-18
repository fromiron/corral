import type {
  ContextMenuParams,
  Event,
  Input,
  WebContents,
  WebContentsConsoleMessageEventParams,
} from 'electron';
import {
  observationScript,
  observationUrl,
  type SelectedPreviewElement,
  safeObservationText,
} from './preview-observation.ts';
import {
  type DesktopPreviewTarget,
  previewRequestAllowed,
  validatePreviewTarget,
} from './preview-policy.ts';

export interface PreviewCapture {
  sessionId: string;
  leaseId: string;
  capturedAt: string;
  url: string;
  pageRevision: number;
  sourceRevision: null;
  element: SelectedPreviewElement['element'];
  console: { level: string; message: string }[];
  screenshot: { mime: 'image/png'; data: string; width: number; height: number } | null;
}
class PreviewCaptureFailure extends Error {}

/** A preview page that element capture can run on: the preview window or a preview tab. */
export interface PreviewCaptureSurface {
  contents: WebContents;
  target: DesktopPreviewTarget;
  /** Bumped on every navigation start; a capture across one is refused. */
  revision: number;
  captureEpoch: number;
  cancel?: () => void;
}

export function previewCaptureOptions(raw: unknown): { screenshot: boolean; console: boolean } {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).some((key) => key !== 'screenshot' && key !== 'console') ||
    typeof (raw as { screenshot?: unknown }).screenshot !== 'boolean' ||
    typeof (raw as { console?: unknown }).console !== 'boolean'
  )
    throw new Error('Invalid preview capture options');
  return raw as { screenshot: boolean; console: boolean };
}

/**
 * Element capture (workbench.md "미리보기 요소 피드백"): the person picks an element with the
 * context menu; the lease, the view and the navigation must stay the same until the result.
 */
export async function capturePreviewSelection(input: {
  sessionId: string;
  leaseId: string;
  surface: PreviewCaptureSurface;
  options: { screenshot: boolean; console: boolean };
  /** Whether the surface is still the one shown for this lease. */
  alive: () => boolean;
  resolveTarget: () => Promise<unknown>;
  /** Ends this capture the way an explicit cancel does. */
  cancel: () => void;
  /** Shows and focuses what holds the page. */
  reveal: () => void;
}): Promise<PreviewCapture> {
  const { sessionId, leaseId, surface, options } = input;
  const epoch = surface.captureEpoch,
    revision = surface.revision;
  const contents = surface.contents,
    url = contents.getURL();
  const current = () => {
    if (
      !input.alive() ||
      contents.isDestroyed() ||
      surface.captureEpoch !== epoch ||
      surface.revision !== revision ||
      contents.getURL() !== url
    )
      throw new Error('Preview capture was cancelled or the page changed');
    if (!previewRequestAllowed(surface.target, url)) throw new Error('Preview page changed');
  };
  const validate = async () => {
    const target = validatePreviewTarget(await input.resolveTarget());
    current();
    if (JSON.stringify(target) !== JSON.stringify(surface.target))
      throw new Error('Preview lease changed');
  };
  await validate();
  return new Promise<PreviewCapture>((resolve, reject) => {
    let settled = false,
      selecting = false;
    const messages: PreviewCapture['console'] = [];
    const finish = (error?: Error, result?: PreviewCapture) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      contents.off('context-menu', choose);
      contents.off('before-input-event', onKey);
      contents.off('console-message', log);
      contents.off('destroyed', cancel);
      contents.off('render-process-gone', cancel);
      if (surface.cancel === cancel) surface.cancel = undefined;
      if (error) reject(error);
      else if (result) resolve(result);
    };
    const cancel = () => finish(new Error('Preview capture was cancelled'));
    const onKey = (event: Event, key: Input) => {
      if (key.key === 'Escape') {
        event.preventDefault();
        input.cancel();
      }
    };
    const log = (event: Event<WebContentsConsoleMessageEventParams>) => {
      if (options.console && messages.length < 20 && typeof event.message === 'string')
        messages.push({
          level: String(event.level).slice(0, 20),
          message: safeObservationText(event.message, surface.target).slice(0, 1000),
        });
    };
    const choose = (event: Event, params: ContextMenuParams) => {
      if (selecting || settled) return;
      event.preventDefault();
      if (
        params.frame !== contents.mainFrame ||
        !['mouse', 'keyboard', 'touch', 'longPress'].includes(params.menuSourceType)
      ) {
        finish(new Error('Select an element in this preview page'));
        return;
      }
      selecting = true;
      void (async () => {
        current();
        // The menu's point is in the view's DIP; the page reads CSS pixels (its zoom between).
        const zoom = contents.getZoomFactor() || 1;
        const selected: SelectedPreviewElement | null =
          await contents.executeJavaScriptInIsolatedWorld(1001, [
            {
              code: observationScript(
                params.x / zoom,
                params.y / zoom,
                params.menuSourceType === 'keyboard',
              ),
            },
          ]);
        current();
        if (settled) return;
        if (!selected)
          throw new PreviewCaptureFailure('Select a visible element rather than the whole page');
        const element = selected.element;
        element.selector = safeObservationText(element.selector, surface.target).slice(0, 500);
        element.text = safeObservationText(element.text, surface.target).slice(0, 4000);
        element.role =
          element.role === null
            ? null
            : safeObservationText(element.role, surface.target).slice(0, 120);
        for (const [name, value] of Object.entries(element.styles))
          element.styles[name] = safeObservationText(value, surface.target).slice(0, 200);
        let screenshot: PreviewCapture['screenshot'] = null;
        if (options.screenshot) {
          if (!selected.screenshotSafe)
            throw new PreviewCaptureFailure('Screenshots containing input fields are not captured');
          // capturePage takes the view's DIP: the element's CSS box times the page's zoom.
          const bounds = element.bounds;
          const rect = {
            x: Math.ceil(bounds.x * zoom),
            y: Math.ceil(bounds.y * zoom),
            width: Math.floor(bounds.width * zoom),
            height: Math.floor(bounds.height * zoom),
          };
          if (rect.width < 1 || rect.height < 1 || rect.width > 2048 || rect.height > 2048)
            throw new PreviewCaptureFailure('Select an area no larger than 2048 pixels');
          const image = await contents.capturePage(rect);
          current();
          if (settled) return;
          const size = image.getSize(1);
          const bytes = image.toPNG({ scaleFactor: 1 });
          if (
            !size.width ||
            !size.height ||
            size.width > 2048 ||
            size.height > 2048 ||
            bytes.length > 1024 * 1024
          )
            throw new PreviewCaptureFailure('The selected screenshot exceeds the image limit');
          screenshot = { mime: 'image/png', data: bytes.toString('base64'), ...size };
        }
        await validate();
        if (settled) return;
        finish(undefined, {
          sessionId,
          leaseId,
          capturedAt: new Date().toISOString(),
          url: observationUrl(url, surface.target),
          pageRevision: revision,
          sourceRevision: null,
          element,
          console: messages,
          screenshot,
        });
      })().catch((error) =>
        finish(
          error instanceof PreviewCaptureFailure
            ? error
            : new Error(
                'Preview selection could not be captured; the page or lease may have changed',
              ),
        ),
      );
    };
    const deadline = setTimeout(() => {
      input.cancel();
    }, 30000);
    surface.cancel = cancel;
    contents.on('context-menu', choose);
    contents.on('before-input-event', onKey);
    contents.on('console-message', log);
    contents.once('destroyed', cancel);
    contents.once('render-process-gone', cancel);
    input.reveal();
    contents.focus();
  });
}
