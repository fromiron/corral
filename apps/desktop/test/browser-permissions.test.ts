import { expect, it } from 'vitest';
import { type BrowserFiles, SitePermissionStore } from '../src/browser-permissions.ts';

function memoryFiles() {
  const files = new Map<string, string>();
  const io: BrowserFiles = {
    read: (name) => files.get(name) ?? null,
    write: (name, text) => void files.set(name, text),
    remove: (name) => void files.delete(name),
  };
  return { files, io };
}

it('answers are kept per site and permission and survive a restart', () => {
  const { io } = memoryFiles();
  const first = new SitePermissionStore(io, 'project-a');
  expect(first.get('https://meet.example', 'camera')).toBeUndefined();
  first.set('https://meet.example', 'camera', true);
  first.set('https://meet.example', 'microphone', false);
  first.set('https://news.example', 'notifications', true);
  const restarted = new SitePermissionStore(io, 'project-a');
  expect(restarted.get('https://meet.example', 'camera')).toBe(true);
  expect(restarted.get('https://meet.example', 'microphone')).toBe(false);
  expect(restarted.get('https://meet.example', 'notifications')).toBeUndefined();
  expect(restarted.list('https://meet.example')).toEqual([
    { permission: 'camera', allow: true },
    { permission: 'microphone', allow: false },
  ]);
  // Another project's store is another file.
  expect(new SitePermissionStore(io, 'project-b').get('https://meet.example', 'camera')).toBe(
    undefined,
  );
});

it('forgetting asks again; clearing removes every answer and the file', () => {
  const { files, io } = memoryFiles();
  const store = new SitePermissionStore(io, 'project-a');
  store.set('https://meet.example', 'camera', true);
  store.set('https://meet.example', 'geolocation', true);
  store.forget('https://meet.example', 'camera');
  expect(store.get('https://meet.example', 'camera')).toBeUndefined();
  expect(new SitePermissionStore(io, 'project-a').get('https://meet.example', 'camera')).toBe(
    undefined,
  );
  store.clear();
  expect(store.get('https://meet.example', 'geolocation')).toBeUndefined();
  expect(files.has('project-a')).toBe(false);
});

it('a damaged or foreign file holds no answers, and only known entries are read', () => {
  const { files, io } = memoryFiles();
  for (const text of ['not json', '[]', '{"version":2,"sites":{}}', '{"version":1,"sites":3}']) {
    files.set('p', text);
    expect(new SitePermissionStore(io, 'p').list('https://a.example')).toEqual([]);
  }
  files.set(
    'p',
    JSON.stringify({
      version: 1,
      sites: {
        'https://a.example': { camera: true, sudo: true, microphone: 'yes' },
        'javascript:alert(1)': { camera: true },
        'https://b.example/path': { camera: true },
      },
    }),
  );
  const store = new SitePermissionStore(io, 'p');
  expect(store.list('https://a.example')).toEqual([{ permission: 'camera', allow: true }]);
  expect(store.get('https://b.example', 'camera')).toBeUndefined();
});
