import { describe, expect, it } from 'vitest';
import { isSendKey, parsePreferences } from './preferences.ts';

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
