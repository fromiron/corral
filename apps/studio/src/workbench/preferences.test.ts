import { describe, expect, it } from 'vitest';
import { parsePreferences } from './preferences.ts';

describe('DW-02 workbench preferences', () => {
  it('reads explicit themes and clamps an off-screen sidebar', () => {
    expect(
      parsePreferences('{"version":1,"theme":"dark","sidebarWidth":900,"sidebarOpen":false}'),
    ).toEqual({ version: 1, theme: 'dark', sidebarWidth: 420, sidebarOpen: false });
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
      });
    }
  });
});
