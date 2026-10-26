import { parseDiffFromFile } from '@pierre/diffs';

// Line diffs off the page's thread: the review screen stops waiting after a
// few seconds and offers the source instead of spinning forever.
self.onmessage = (event: MessageEvent<{ path: string; before: string; after: string }>) => {
  try {
    const { path, before, after } = event.data;
    self.postMessage({
      diff: parseDiffFromFile({ name: path, contents: before }, { name: path, contents: after }),
    });
  } catch {
    self.postMessage({ error: true });
  }
};
