import { createTranslator } from 'use-intl';
import { expect, it } from 'vitest';
import en from '../../../../packages/react/src/messages/en.json';

// The empty working-copy view shows this only when the folder has uncommitted changes; with none
// the button, which names the starting commit, is all it says.
it('explains excluded local changes in complete English for one and many', () => {
  const t = createTranslator({ locale: 'en', messages: en });
  expect(t('Files.createHint', { changed: 1 })).toBe(
    'Your folder’s 1 uncommitted change is not included.',
  );
  expect(t('Files.createHint', { changed: 3 })).toBe(
    'Your folder’s 3 uncommitted changes are not included.',
  );
});
