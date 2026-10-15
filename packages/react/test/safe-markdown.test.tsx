import { render } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { describe, expect, it } from 'vitest';
import { SafeMarkdown } from '../src/components/SafeMarkdown.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };

const show = (text: string) =>
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <SafeMarkdown text={text} />
    </IntlProvider>,
  ).container;

describe('SafeMarkdown (C-025, Spec §10.2)', () => {
  it('renders no raw HTML from model output', () => {
    const view = show('Hello <script>alert(1)</script><img src=x onerror="alert(2)"> <b>bold</b>');
    expect(view.querySelector('script')).toBeNull();
    expect(view.querySelector('img')).toBeNull();
    expect(view.querySelector('b')).toBeNull();
    expect(view.innerHTML).not.toContain('onerror');
    expect(view.textContent).toContain('Hello');
  });

  it('drops dangerous link targets and opens the rest safely', () => {
    const view = show(
      '[run](javascript:alert(1)) [data](data:text/html;base64,PHNjcmlwdD4=) [ok](https://example.org/a)',
    );
    const links = [...view.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://example.org/a']);
    expect(links[0]?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(links[0]?.getAttribute('target')).toBe('_blank');
    expect(view.textContent).toContain('run');
  });

  it('does not load remote images; it names them instead', () => {
    const view = show('![chart of results](https://tracker.example/pixel.png)');
    expect(view.querySelector('img')).toBeNull();
    expect(view.textContent).toContain('chart of results');
    expect(view.textContent).toContain('tracker.example');
  });

  it('keeps ordinary Markdown structure', () => {
    const view = show('# Title\n\n- one\n- two\n\n`code`');
    expect(view.querySelector('h1')?.textContent).toBe('Title');
    expect(view.querySelectorAll('li')).toHaveLength(2);
    expect(view.querySelector('code')?.textContent).toBe('code');
  });
});
