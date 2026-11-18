import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IntlProvider } from 'use-intl';
import { expect, it } from 'vitest';
import { AnnotationContents } from '../src/components/AnnotationContents.tsx';
import en from '../src/messages/en.json' with { type: 'json' };
import ko from '../src/messages/ko.json' with { type: 'json' };

// What a page annotation carries, shown the same in the note's label popover and the composer's
// chip popover (features/browser-annotate.md 보내는 것: 보이는 것).

const base = {
  page: { origin: 'https://shop.example', path: '/cart' },
  label: 'button.pay 120×32',
  selector: 'body > main:nth-of-type(1) > button:nth-of-type(1)',
  text: 'Pay',
  styles: [],
  console: null,
  screenshot: 'included' as const,
};

function show(props: Partial<Parameters<typeof AnnotationContents>[0]> = {}, locale = 'en') {
  return render(
    <IntlProvider locale={locale} messages={locale === 'ko' ? ko : en} timeZone="UTC">
      <AnnotationContents {...base} {...props} />
    </IntlProvider>,
  );
}

const value = (term: string) =>
  screen.getByText(term, { selector: 'dt' }).nextElementSibling?.textContent ?? null;

it('페이지(origin과 경로), 이름표, 선택자, 글, 스크린샷의 상태를 보인다', () => {
  show();
  expect(value('Page')).toBe('https://shop.example/cart');
  expect(value('Element')).toBe('button.pay 120×32');
  expect(value('Selector')).toBe('body > main:nth-of-type(1) > button:nth-of-type(1)');
  expect(value('Text')).toBe('Pay');
  expect(screen.getByText('Screenshot included')).toBeTruthy();
  // Counterexample: rows with nothing to carry are not drawn.
  expect(screen.queryByText('Style changes')).toBeNull();
  expect(screen.queryByText('Console')).toBeNull();
});

it('스타일 차이는 속성마다 처음 값과 바꾼 값이고, 콘솔은 수준과 글이다', () => {
  show({
    styles: [{ property: 'color', before: 'rgb(23, 23, 23)', after: 'var(--color-gray-900)' }],
    console: [{ level: 'error', message: 'Uncaught TypeError: x is undefined' }],
    screenshot: 'none',
  });
  const styles = screen.getByText('Style changes', { selector: 'dt' }).nextElementSibling;
  expect(styles?.textContent).toContain('color');
  expect(styles?.textContent).toContain('rgb(23, 23, 23)');
  expect(styles?.textContent).toContain('var(--color-gray-900)');
  const console = screen.getByText('Console', { selector: 'dt' }).nextElementSibling;
  expect(console?.textContent).toContain('error');
  expect(console?.textContent).toContain('Uncaught TypeError: x is undefined');
  expect(screen.getByText('No screenshot')).toBeTruthy();
});

it('긴 글은 접혀 있고 더 보기로 편다', async () => {
  const long = 'Washed linen. '.repeat(40).trim();
  show({ text: long });
  const more = screen.getByRole('button', { name: 'Show more' });
  expect(more.getAttribute('aria-expanded')).toBe('false');
  await userEvent.click(more);
  expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  expect(value('Text')).toBe(long);
});

it('짧은 글에는 더 보기가 없다', () => {
  show();
  expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
});

it('스크린샷의 작은 그림을 보인다', () => {
  show({ screenshot: { src: 'data:image/png;base64,AAAA', alt: 'button.pay 120×32' } });
  const image = screen.getByRole('img', { name: 'button.pay 120×32' });
  expect(image.getAttribute('src')).toBe('data:image/png;base64,AAAA');
});

it('페이지의 글은 글로만 그리고 마크업으로 풀지 않는다', () => {
  const { container } = show({ text: '<img src=x onerror="alert(1)">Pay' });
  expect(container.querySelector('img')).toBeNull();
  expect(value('Text')).toBe('<img src=x onerror="alert(1)">Pay');
});

it('한국어로 보인다', () => {
  show({ screenshot: 'none' }, 'ko');
  expect(value('페이지')).toBe('https://shop.example/cart');
  expect(screen.getByText('스크린샷 없음')).toBeTruthy();
});
