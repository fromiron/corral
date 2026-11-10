// @vitest-environment jsdom
import {
  type createHastElement,
  createNoNewlineElement,
  createSeparator,
  type createTextNodeElement,
} from '@pierre/diffs';
import { createTranslator } from 'use-intl';
import { expect, it } from 'vitest';
import en from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import ko from '../../../../packages/react/src/messages/ko.json' with { type: 'json' };
import { type DiffLabels, localizeDiffLabels } from './diffLabels.ts';

type Hast = ReturnType<typeof createHastElement> | ReturnType<typeof createTextNodeElement>;

/** The diff renderer's own markup, as its shadow root holds it. */
function dom(node: Hast): Node {
  if (node.type === 'text') return document.createTextNode(node.value);
  const element = document.createElement(node.tagName);
  for (const [name, value] of Object.entries(node.properties ?? {}))
    if (value !== undefined && value !== null) element.setAttribute(name, String(value));
  for (const child of node.children ?? []) element.append(dom(child as Hast));
  return element;
}

function labels(locale: 'en' | 'ko'): DiffLabels {
  const t = createTranslator({
    locale,
    messages: locale === 'en' ? en : ko,
    namespace: 'Review.diff',
  });
  return {
    unmodifiedLines: (count) => t('unmodifiedLines', { count }),
    moreContext: t('moreContext'),
    expandAll: t('expandAll'),
    noNewline: t('noNewline'),
  };
}

function renderedDiff() {
  const root = document.createElement('div');
  // The library's English words for one, several and an unknown number of hidden lines.
  for (const content of [
    '1 unmodified line',
    '5 unmodified lines',
    'More unchanged context may be available',
  ])
    root.append(
      dom(
        createSeparator({
          type: 'line-info',
          content,
          expandIndex: 1,
          chunked: true,
          isFirstHunk: false,
          isLastHunk: false,
        }) as Hast,
      ),
    );
  root.append(dom(createNoNewlineElement('change-addition') as Hast));
  return root;
}

const texts = (root: ParentNode, selector: string) =>
  [...root.querySelectorAll(selector)].map((node) => node.textContent);

it('says the diff viewer’s own words in Korean, counted', () => {
  const root = renderedDiff();
  localizeDiffLabels(root, labels('ko'));
  expect(texts(root, '[data-unmodified-lines]')).toEqual([
    '변경 없는 줄 1개',
    '변경 없는 줄 5개',
    ko.Review.diff.moreContext,
  ]);
  expect(texts(root, '[data-expand-all-button]')).toEqual(Array(3).fill(ko.Review.diff.expandAll));
  expect(texts(root, '[data-no-newline]')).toEqual([ko.Review.diff.noNewline]);
  expect(root.textContent).not.toMatch(/unmodified|Expand all|No newline|unchanged context/);
  // A second pass after a render that kept the nodes changes nothing.
  const once = root.innerHTML;
  localizeDiffLabels(root, labels('ko'));
  expect(root.innerHTML).toBe(once);
});

it('keeps English singular and plural', () => {
  const root = renderedDiff();
  localizeDiffLabels(root, labels('en'));
  expect(texts(root, '[data-unmodified-lines]')).toEqual([
    '1 unmodified line',
    '5 unmodified lines',
    en.Review.diff.moreContext,
  ]);
});
