import { createTranslator } from 'use-intl';
import { expect, it } from 'vitest';
import en from '../../../../packages/react/src/messages/en.json';

it('explains excluded local changes in complete English for zero, one and many', () => {
  const t = createTranslator({ locale: 'en', messages: en });
  expect(t('Files.createHint', { changed: 0 })).toBe(
    'It starts from the last commit. Your folder has no uncommitted changes.',
  );
  expect(t('Files.createHint', { changed: 1 })).toContain('1 uncommitted change is not included');
  expect(t('Files.createHint', { changed: 3 })).toContain('3 uncommitted changes are not included');
});
