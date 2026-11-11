import { describe, expect, it } from 'vitest';
import { parseTheme, readThemeFile, serializeTheme, THEME_FILE_MAX_BYTES } from './json.ts';

/** A valid Corral theme file as plain data; each case breaks one thing. */
function file(): Record<string, unknown> {
  return {
    corralTheme: 1,
    name: 'Harbor',
    base: 'dark',
    ui: {
      background: '#272822',
      foreground: '#F8F8F2',
      muted: '#b0ad9a',
      emphasis: '#66d9ef',
      selection: '#49483e',
      error: '#ff6188',
      success: '#a6e22e',
      warning: '#e6db74',
      info: '#78dce8',
    },
    syntax: {
      comment: '#88846f',
      keyword: '#f92672',
      string: '#e6db74',
      number: '#ae81ff',
      function: '#a6e22e',
      type: '#66d9ef',
      variable: '#f8f8f2',
      constant: '#ae81ff',
    },
    terminal: Array.from(
      { length: 16 },
      (_, index) => `#0${index.toString(16)}0${index.toString(16)}0a`,
    ),
  };
}
const text = (value: unknown) => JSON.stringify(value);
const ui = (value: Record<string, unknown>) => value.ui as Record<string, unknown>;

describe('Corral theme JSON', () => {
  it('accepts a valid file, trims the name and lower-cases every color', () => {
    const result = parseTheme(text({ ...file(), name: '  Harbor  ' }));
    if (!result.ok) throw new Error(result.error);
    expect(result.palette.name).toBe('Harbor');
    expect(result.palette.base).toBe('dark');
    expect(result.palette.ui.foreground).toBe('#f8f8f2');
    expect(result.palette.terminal).toHaveLength(16);
  });

  it.each([
    [
      'a color that carries CSS',
      (f: Record<string, unknown>) => {
        ui(f).error = 'red; background: url(x)';
      },
    ],
    [
      'a 3-digit hex',
      (f: Record<string, unknown>) => {
        ui(f).error = '#f00';
      },
    ],
    [
      'an 8-digit hex',
      (f: Record<string, unknown>) => {
        ui(f).error = '#ff0000ff';
      },
    ],
    [
      'a named color',
      (f: Record<string, unknown>) => {
        (f.syntax as Record<string, unknown>).comment = 'gray';
      },
    ],
    [
      'a terminal color that is not hex',
      (f: Record<string, unknown>) => {
        (f.terminal as unknown[])[3] = 'rgb(0 0 0)';
      },
    ],
    [
      'an extra top-level field',
      (f: Record<string, unknown>) => {
        f.author = 'someone';
      },
    ],
    [
      'an extra field inside ui',
      (f: Record<string, unknown>) => {
        ui(f).link = '#00ff00';
      },
    ],
    [
      'an extra field inside syntax',
      (f: Record<string, unknown>) => {
        (f.syntax as Record<string, unknown>).operator = '#00ff00';
      },
    ],
    [
      'a missing ui field',
      (f: Record<string, unknown>) => {
        delete ui(f).info;
      },
    ],
    [
      'a missing top-level field',
      (f: Record<string, unknown>) => {
        delete f.syntax;
      },
    ],
    [
      'fifteen terminal colors',
      (f: Record<string, unknown>) => {
        (f.terminal as unknown[]).pop();
      },
    ],
    [
      'seventeen terminal colors',
      (f: Record<string, unknown>) => {
        (f.terminal as unknown[]).push('#000000');
      },
    ],
    [
      'corralTheme 2',
      (f: Record<string, unknown>) => {
        f.corralTheme = 2;
      },
    ],
    [
      'corralTheme as a string',
      (f: Record<string, unknown>) => {
        f.corralTheme = '1';
      },
    ],
    [
      'a name of 0 characters',
      (f: Record<string, unknown>) => {
        f.name = '   ';
      },
    ],
    [
      'a name of 41 characters',
      (f: Record<string, unknown>) => {
        f.name = 'n'.repeat(41);
      },
    ],
    [
      'a name that is not text',
      (f: Record<string, unknown>) => {
        f.name = 7;
      },
    ],
    [
      'an unknown base',
      (f: Record<string, unknown>) => {
        f.base = 'system';
      },
    ],
    [
      'ui as an array',
      (f: Record<string, unknown>) => {
        f.ui = Object.values(ui(f));
      },
    ],
  ])('rejects the whole file for %s', (_name, breakIt) => {
    const value = file();
    breakIt(value);
    expect(parseTheme(text(value)).ok).toBe(false);
  });

  it('accepts a name of exactly 40 characters after trimming', () => {
    const result = parseTheme(text({ ...file(), name: ` ${'한'.repeat(40)} ` }));
    expect(result.ok).toBe(true);
  });

  it('rejects a JSON array, invalid JSON and null', () => {
    expect(parseTheme(text([file()]))).toEqual({ ok: false, error: 'not-object' });
    expect(parseTheme('{"corralTheme": 1,')).toEqual({ ok: false, error: 'not-json' });
    expect(parseTheme('null')).toEqual({ ok: false, error: 'not-object' });
  });

  it('rejects a file over 64KB before reading it, and the same text when it is passed in', async () => {
    const padded = `${text(file())}${' '.repeat(THEME_FILE_MAX_BYTES)}`;
    expect(parseTheme(padded)).toEqual({ ok: false, error: 'too-large' });
    let read = false;
    const big = new Blob([padded]);
    const spy = Object.assign(big, {
      text: () => {
        read = true;
        return Promise.resolve(padded);
      },
    });
    expect(await readThemeFile(spy)).toEqual({ ok: false, error: 'too-large' });
    expect(read).toBe(false);
    // Exactly 64KB of valid JSON is still accepted.
    const exact = text(file());
    const fitted = `${exact}${' '.repeat(THEME_FILE_MAX_BYTES - new TextEncoder().encode(exact).length)}`;
    expect(parseTheme(fitted).ok).toBe(true);
  });

  it('exports what it imports: the same name and every color, lower-cased', async () => {
    const first = parseTheme(text(file()));
    if (!first.ok) throw new Error(first.error);
    const exported = serializeTheme(first.palette);
    expect(Object.keys(JSON.parse(exported))).toEqual([
      'corralTheme',
      'name',
      'base',
      'ui',
      'syntax',
      'terminal',
    ]);
    const again = await readThemeFile(new Blob([exported]));
    if (!again.ok) throw new Error(again.error);
    expect(again.palette).toEqual(first.palette);
    expect(exported).not.toMatch(/[A-F]/);
  });

  it('never carries a field it was not given into the exported file', () => {
    const result = parseTheme(text(file()));
    if (!result.ok) throw new Error(result.error);
    const tampered = { ...result.palette, id: 'x', ui: { ...result.palette.ui, extra: '#000000' } };
    const exported = JSON.parse(serializeTheme(tampered as typeof result.palette));
    expect(exported.id).toBeUndefined();
    expect(exported.ui.extra).toBeUndefined();
  });
});
