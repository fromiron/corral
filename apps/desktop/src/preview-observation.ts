import type { DesktopPreviewTarget } from './preview-policy.ts';

export interface SelectedPreviewElement {
  element: {
    tag: string;
    role: string | null;
    selector: string;
    text: string;
    bounds: { x: number; y: number; width: number; height: number };
    styles: Record<string, string>;
  };
  screenshotSafe: boolean;
}

// Runs in a separate world with no preload: neither page scripts nor renderer arguments supply code.
function readElement(x: number, y: number, keyboard: boolean): SelectedPreviewElement | null {
  const element = keyboard ? document.activeElement : document.elementFromPoint(x, y);
  if (
    !(element instanceof HTMLElement || element instanceof SVGElement) ||
    element === document.body ||
    element === document.documentElement
  )
    return null;
  const protectedSelector =
    'input, textarea, select, [contenteditable]:not([contenteditable="false"]), script, style, noscript';
  const protectedElement = Boolean(element.closest(protectedSelector));
  const rect = element.getBoundingClientRect();
  const left = Math.max(0, rect.left),
    top = Math.max(0, rect.top);
  const right = Math.min(innerWidth, rect.right),
    bottom = Math.min(innerHeight, rect.bottom);
  if (right <= left || bottom <= top) return null;
  const bounds = { x: left, y: top, width: right - left, height: bottom - top };
  const parts: string[] = [];
  for (
    let node: Element | null = element;
    node && node !== document.body;
    node = node.parentElement
  ) {
    if (parts.length === 12) break;
    const siblings = node.parentElement
      ? [...node.parentElement.children].filter((other) => other.tagName === node?.tagName)
      : [node];
    parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(node) + 1})`);
  }
  let text = '';
  if (!protectedElement) {
    const walker = document.createTreeWalker(
      element,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (node instanceof Element) {
            const style = getComputedStyle(node);
            return node.matches(protectedSelector) ||
              style.display === 'none' ||
              style.visibility === 'hidden'
              ? NodeFilter.FILTER_REJECT
              : NodeFilter.FILTER_SKIP;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      },
    );
    let count = 0;
    for (
      let node = walker.nextNode();
      node && text.length < 4000 && count++ < 2000;
      node = walker.nextNode()
    )
      text += (node.textContent ?? '').slice(0, 4000 - text.length);
  }
  const style = getComputedStyle(element);
  const styles: Record<string, string> = {};
  for (const name of [
    'display',
    'position',
    'color',
    'background-color',
    'font-family',
    'font-size',
    'font-weight',
    'line-height',
    'padding',
    'margin',
    'border-width',
    'border-color',
    'border-radius',
    'gap',
    'align-items',
    'justify-content',
  ])
    styles[name] = style.getPropertyValue(name).slice(0, 200);
  const screenshotSafe =
    !protectedElement &&
    !element.querySelector(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
    ) &&
    ![
      ...document.querySelectorAll(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
      ),
    ].some((field) => {
      const box = field.getBoundingClientRect();
      const style = getComputedStyle(field);
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        box.width > 0 &&
        box.height > 0 &&
        box.left < right &&
        box.right > left &&
        box.top < bottom &&
        box.bottom > top
      );
    });
  return {
    element: {
      tag: element.tagName.toLowerCase().slice(0, 80),
      role: element.getAttribute('role')?.slice(0, 120) ?? null,
      selector: parts.join(' > ').slice(0, 500),
      text: text.trim(),
      bounds,
      styles,
    },
    screenshotSafe,
  };
}

export function observationScript(x: number, y: number, keyboard: boolean): string {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Invalid preview selection');
  return `(${readElement.toString()})(${x},${y},${keyboard === true})`;
}

export function observationUrl(value: string, target: DesktopPreviewTarget): string {
  const url = new URL(value);
  if (url.origin !== target.origin) throw new Error('Preview page changed');
  let path = url.pathname;
  if (target.pathPrefix) {
    if (!path.startsWith(target.pathPrefix)) throw new Error('Preview page changed');
    path = `/${path.slice(target.pathPrefix.length)}`;
  }
  return `${url.origin}${path}`.slice(0, 2048);
}

export function safeObservationText(value: string, target: DesktopPreviewTarget): string {
  let result = value.replace(/https?:\/\/[^\s<>"'`]+/g, (raw) => {
    try {
      const url = new URL(raw);
      return url.origin === target.origin
        ? observationUrl(raw, target)
        : `${url.origin}${url.pathname}`;
    } catch {
      return '[url]';
    }
  });
  for (const token of Object.values(target.headers))
    result = result.replaceAll(token, '[redacted]');
  if (target.pathPrefix) {
    result = result.replaceAll(target.pathPrefix, '/');
    for (const part of target.pathPrefix.split('/').filter(Boolean))
      result = result.replaceAll(part, '[redacted]');
  }
  return result;
}
