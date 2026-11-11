import { useId, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '../design-kit/index.ts';
import { CopyTextButton } from './CopyTextButton.tsx';
import { SafeMarkdown } from './SafeMarkdown.tsx';

/**
 * A message's text. Only the preview folds: copy always takes the original, complete message.
 * A host that lays its actions out elsewhere (a row under a bubble or an answer) passes
 * `copy={false}` and renders `CopyTextButton` there.
 */
export function MessageBody({
  text,
  markdown = false,
  size,
  copy = true,
  actions,
}: {
  text: string;
  markdown?: boolean;
  /** The Markdown type step; see SafeMarkdown. */
  size?: 'compact' | 'reader' | 'chat';
  copy?: boolean;
  actions?: React.ReactNode;
}) {
  const t = useTranslations('MessageBody');
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  // Keep assistant code blocks complete so their copy action always copies all source.
  const long = !markdown && (text.length > 2400 || text.split('\n').length > 32);
  const preview =
    long && !expanded ? `${text.slice(0, 2400).split('\n').slice(0, 32).join('\n')}…` : text;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div id={id}>
        {markdown ? (
          <SafeMarkdown text={preview} {...(size ? { size } : {})} />
        ) : (
          <p className="whitespace-pre-wrap wrap-anywhere">{preview}</p>
        )}
      </div>
      {long || copy || actions ? (
        <div className="flex flex-wrap items-center gap-1">
          {long ? (
            <Button
              size="compact"
              variant="ghost"
              aria-expanded={expanded}
              aria-controls={id}
              onClick={() => setExpanded(!expanded)}
            >
              {t(expanded ? 'showLess' : 'showMore')}
            </Button>
          ) : null}
          {copy ? <CopyTextButton text={text} /> : null}
          {actions}
        </div>
      ) : null}
    </div>
  );
}
