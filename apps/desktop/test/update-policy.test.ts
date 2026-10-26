import { expect, it } from 'vitest';
import { compatibleUpdate, updateChannel } from '../src/update-policy.ts';

it('updater requires an explicit HTTPS feed and Windows publisher', () => {
  expect(() => updateChannel({ url: 'http://example.com', channel: 'latest' }, 'win32')).toThrow();
  expect(() =>
    updateChannel({ url: 'https://user:secret@example.com', channel: 'latest' }, 'win32'),
  ).toThrow();
  expect(() => updateChannel({ url: 'https://example.com', channel: 'latest' }, 'win32')).toThrow();
  expect(
    updateChannel(
      { url: 'https://example.com/releases/', channel: 'stable', publisherName: 'Corral Owner' },
      'win32',
    ).channel,
  ).toBe('stable');
});

it('schema-unknown releases and insecure downloads cannot reach installation', () => {
  const info = {
    corralSchemaVersions: ['0.1'],
    corralStorage: { minVersion: 5, maxVersion: 8 },
    files: [{ url: 'Corral.exe', sha512: 'digest' }],
  };
  expect(compatibleUpdate(info, 7)).toBe(true);
  expect(compatibleUpdate(info, 9)).toBe(false);
  expect(compatibleUpdate(info, 4)).toBe(false);
  expect(compatibleUpdate({ ...info, corralStorage: undefined }, 7)).toBe(false);
  expect(compatibleUpdate({ ...info, corralSchemaVersions: ['future'] }, 7)).toBe(false);
  expect(compatibleUpdate({ files: info.files }, 7)).toBe(false);
  expect(
    compatibleUpdate(
      { ...info, files: [{ url: 'http://example.com/app.exe', sha512: 'digest' }] },
      7,
    ),
  ).toBe(false);
});
