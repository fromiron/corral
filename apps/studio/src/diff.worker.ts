import { diffLines } from '@corral/react/diff';

// Line diffs off the page's thread (02-UX-Spec §4): the review screen stops waiting after a
// few seconds and offers the source instead of spinning forever.
self.onmessage = (event: MessageEvent<{ before: string; after: string }>) => {
  self.postMessage(diffLines(event.data.before, event.data.after));
};
