// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import {
  observationScript,
  observationUrl,
  safeObservationText,
} from '../src/preview-observation.ts';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function select(element: Element, rect = new DOMRect(12, 18, 100, 40)) {
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: vi.fn(() => element),
  });
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(rect);
}

function observe(x: number, y: number, keyboard: boolean) {
  // biome-ignore lint/security/noGlobalEval: Execute only our fixed capture script against the test DOM.
  return window.eval(observationScript(x, y, keyboard));
}

it('[TC-WBD-020-H] observes the selected element and clips its bounds to the visible viewport', () => {
  document.body.innerHTML =
    '<main><button id="private-id" class="private-class" style="color: rgb(12, 34, 56)">Fix <span>this button</span></button><p>Unselected sibling</p></main>';
  const button = document.querySelector('button')!;
  select(button, new DOMRect(-10, 18, 110, 40));
  const result = observe(20, 30, false);

  expect(result.element).toMatchObject({
    tag: 'button',
    text: 'Fix this button',
    bounds: { x: 0, y: 18, width: 100, height: 40 },
    styles: { color: 'rgb(12, 34, 56)' },
  });
  expect(document.querySelector(result.element.selector)).toBe(button);
  expect(result.element.selector).not.toMatch(/private-id|private-class|[#.]/);
  expect(result.screenshotSafe).toBe(true);

  button.focus();
  expect(observe(0, 0, true).element.selector).toBe(result.element.selector);
  for (const root of [document.body, document.documentElement]) {
    select(root);
    expect(observe(20, 30, false)).toBeNull();
  }
});

it('[TC-WBD-020-N] excludes editable values and strips preview capabilities from observations', () => {
  document.body.innerHTML = `<section>Visible caption
    <input value="input-secret"><textarea>textarea-secret</textarea>
    <div contenteditable="true">editable-secret</div>
    <script>script-secret</script><style>/* style-secret */ .private-class { color: red }</style>
  </section>`;
  select(document.querySelector('section')!);
  const result = observe(20, 30, false);
  expect(result.element.text.trim()).toBe('Visible caption');
  expect(JSON.stringify(result)).not.toMatch(
    /input-secret|textarea-secret|editable-secret|script-secret|style-secret/,
  );
  expect(result.screenshotSafe).toBe(false);

  const target = {
    origin: 'http://127.0.0.2:4321',
    url: 'http://127.0.0.2:4321/capability-secret/index.html',
    pathPrefix: '/capability-secret/',
    headers: { 'x-corral-preview': 'header-secret' },
  };
  const url =
    'http://username:password@127.0.0.2:4321/capability-secret/index.html?token=query-secret#fragment-secret';
  const safeUrl = observationUrl(url, target);
  const safeText = safeObservationText(`Visible caption header-secret ${url}`, target);
  for (const value of [safeUrl, safeText]) {
    expect(value).not.toMatch(
      /header-secret|capability-secret|username|password|query-secret|fragment-secret/,
    );
  }
  expect(safeText).toContain('Visible caption');
  expect(new URL(safeUrl).origin).toBe(target.origin);
});
