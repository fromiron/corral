import type { PortableApplication } from '@corral/client';
import { canonicalJson } from '@corral/contracts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { applyPortablePreferences, portablePreferences } from './portable-preferences.ts';
import { PREFERENCES_KEY, parsePreferences, preferences } from './preferences.ts';

let values: Map<string, string>;
beforeEach(() => {
  values = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  vi.stubGlobal('dispatchEvent', () => true);
});
afterEach(() => {
  vi.unstubAllGlobals();
  preferences.setState(parsePreferences(null), true);
});

async function revision(value: PortableApplication) {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalJson(value)),
  );
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
async function importTheme(theme: PortableApplication['theme']) {
  const current = portablePreferences('en');
  delete current.shortcuts;
  const target: PortableApplication = { ...current, theme };
  return applyPortablePreferences(target, await revision(current), 'en', () => {});
}
function named(theme: 'light' | 'dark') {
  preferences.setState({ ...parsePreferences(null), theme, palette: 'builtin:monokai' }, true);
  values.set(PREFERENCES_KEY, JSON.stringify(preferences.getState()));
}

it('exports only the brightness of a named theme, never the theme itself', () => {
  named('dark');
  const exported = portablePreferences('en');
  expect(exported.theme).toBe('dark');
  expect(JSON.stringify(exported)).not.toContain('monokai');
});

it('clears the named theme when the imported preferences change the theme', async () => {
  named('dark');
  await importTheme('light');
  expect(preferences.getState()).toMatchObject({ theme: 'light', palette: null });
  expect(parsePreferences(values.get(PREFERENCES_KEY) ?? null).palette).toBeNull();
});

it('clears it for system as well', async () => {
  named('dark');
  await importTheme('system');
  expect(preferences.getState()).toMatchObject({ theme: 'system', palette: null });
});

it('keeps the named theme when the imported theme is the same as now', async () => {
  named('dark');
  await importTheme('dark');
  expect(preferences.getState()).toMatchObject({ theme: 'dark', palette: 'builtin:monokai' });
});
