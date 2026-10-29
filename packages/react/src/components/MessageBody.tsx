import { useId, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '../design-kit/index.ts';
import { CopyTextButton } from './CopyTextButton.tsx';
import { SafeMarkdown } from './SafeMarkdown.tsx';

/** Collapse the preview only: copy always includes the original, complete message. */
export function MessageBody({
  text,
  markdown = false,
  actions,
}: {
  text: string;
  markdown?: boolean;
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
    <div className="min-w-0 space-y-2">
      <div id={id}>
        {markdown ? (
          <SafeMarkdown text={preview} />
        ) : (
          <p className="whitespace-pre-wrap wrap-anywhere">{preview}</p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
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
        <CopyTextButton text={text} />
        {actions}
      </div>
    </div>
  );
}
