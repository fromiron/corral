import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  changePreferences,
  isSendKey,
  PREFERENCES_KEY,
  parsePreferences,
  preferences,
} from './preferences.ts';

describe('DW-02 workbench preferences', () => {
  it('reads explicit themes and clamps an off-screen sidebar', () => {
    expect(
      parsePreferences('{"version":1,"theme":"dark","sidebarWidth":900,"sidebarOpen":false}'),
    ).toEqual({
      version: 1,
      theme: 'dark',
      sidebarWidth: 420,
      sidebarOpen: false,
      sendKey: 'enter',
      notify: false,
      chatDensity: 'basic',
    });
  });
  it('ignores corrupt and future preferences without losing access to navigation', () => {
    for (const raw of [
      null,
      '{',
      '{"version":2}',
      '{"version":1,"theme":"unknown","sidebarWidth":"300"}',
    ]) {
      expect(parsePreferences(raw)).toEqual({
        version: 1,
        theme: 'system',
        sidebarWidth: 256,
        sidebarOpen: true,
        sendKey: 'enter',
        notify: false,
        chatDensity: 'basic',
      });
    }
  });
  it('keeps the chosen send key and reads anything else as Enter', () => {
    expect(parsePreferences('{"version":1,"sendKey":"mod-enter"}').sendKey).toBe('mod-enter');
    expect(parsePreferences('{"version":1,"sendKey":"space"}').sendKey).toBe('enter');
  });
});

describe('Workbench polish: send key', () => {
  const key = (patch: Partial<Parameters<typeof isSendKey>[0]>) => ({
    key: 'Enter',
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...patch,
  });
  it('sends on Enter and adds a line on Shift+Enter by default', () => {
    expect(isSendKey(key({}), 'enter')).toBe(true);
    expect(isSendKey(key({ shiftKey: true }), 'enter')).toBe(false);
    expect(isSendKey(key({ key: 'a' }), 'enter')).toBe(false);
  });
  it('sends only on Ctrl/⌘+Enter when chosen', () => {
    expect(isSendKey(key({}), 'mod-enter')).toBe(false);
    expect(isSendKey(key({ ctrlKey: true }), 'mod-enter')).toBe(true);
    expect(isSendKey(key({ metaKey: true }), 'mod-enter')).toBe(true);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  preferences.setState(parsePreferences(null));
});
it('[TC-WBD-007-H] persists presentation density and defaults old or invalid preferences to basic', () => {
  expect(parsePreferences('{"version":1}').chatDensity).toBe('basic');
  expect(parsePreferences('{"version":1,"chatDensity":"unknown"}').chatDensity).toBe('basic');
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  for (const chatDensity of ['results', 'basic', 'detailed'] as const) {
    changePreferences({ chatDensity });
    expect(parsePreferences(values.get(PREFERENCES_KEY) ?? null).chatDensity).toBe(chatDensity);
  }
});
