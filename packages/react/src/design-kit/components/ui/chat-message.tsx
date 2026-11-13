'use client';

import { type HTMLMotionProps, motion } from 'motion/react';
import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { useTouchPrimary } from '../../hooks/use-touch-primary.tsx';
import { useShape } from '../../lib/shape-context.tsx';
import { type SizeVariant, typeClass, useSize } from '../../lib/size-context.tsx';
import { spring } from '../../lib/springs.ts';
import { cn } from '../../lib/utils.ts';

interface ChatMessageProps extends Omit<HTMLMotionProps<'div'>, 'children'> {
  /** Who sent the message. Drives alignment and bubble colour:
   *  `user` → right-aligned accent bubble, `assistant` → left-aligned plain text. */
  from: 'user' | 'assistant';
  /** Timestamp shown in the hover-revealed meta row, before the actions.
   *  User-message only — ignored on assistant replies. Caller pre-formats it
   *  (e.g. `"Wednesday 6:08 PM"`). */
  time?: ReactNode;
  /** Icon-only action buttons shown in the hover-revealed meta row (e.g. copy,
   *  edit, regenerate). Rendered next to the timestamp. */
  actions?: ReactNode;
  /** Corral adaptation: what became of the message, at the meta row's end and always shown.
   *  It keeps its place while the time and actions are revealed beside it. */
  status?: ReactNode;
  /** Corral adaptation: attributes for the meta row itself (a test or measuring hook). */
  metaProps?: HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, string>;
  /** Message body. When omitted the text bubble is dropped (attachment-only message). */
  children?: ReactNode;
  /** Size step; compact tightens bubble type and padding. Omitted, follows
   *  the surrounding SizeProvider. */
  size?: SizeVariant;
}

// ─── ChatMessage ─────────────────────────────────────────────────────────────
// A single transcript entry. `layout="position"` lets earlier messages slide
// up when a new one is appended.
const ChatMessage = forwardRef<HTMLDivElement, ChatMessageProps>(
  ({ from, time, actions, status, metaProps, children, size, className, ...props }, ref) => {
    const shape = useShape();
    const compact = useSize(size).variant === 'compact';
    const isUser = from === 'user';
    // Hover-reveal is unreachable on touch — keep the meta row visible there.
    const isTouch = useTouchPrimary();
    const showTime = isUser && time != null;

    return (
      <motion.div
        ref={ref}
        layout="position"
        initial={{ opacity: 0, y: 8, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={spring.moderate}
        style={{ transformOrigin: isUser ? 'bottom right' : 'bottom left' }}
        className={cn(
          'group/message flex max-w-[80%] flex-col gap-1.5',
          isUser ? 'items-end self-end' : 'items-start self-start',
          className,
        )}
        {...props}
      >
        {children != null && children !== '' && (
          <div
            className={cn(
              'whitespace-pre-wrap break-words',
              compact ? 'py-1.5' : 'py-2',
              typeClass('subtitle', compact ? 'compact' : 'default'),
              isUser
                ? cn(
                    shape.bg,
                    compact ? 'px-3' : 'px-3.5',
                    // Not on assistant replies: `text-wrap: pretty` re-balances
                    // on every change, so streamed text would visibly reflow.
                    'text-pretty bg-[color-mix(in_oklab,var(--accent),var(--background)_45%)] text-foreground',
                  )
                : 'text-foreground',
            )}
          >
            {children}
          </div>
        )}
        {(showTime || actions != null || status != null) && (
          // Meta row: always rendered so its height is reserved. The time and actions are
          // hidden until the message is hovered or an action is focused; the status after them
          // is always shown, on the same one line, at its end. With a status the hidden part
          // also gives up its width, so the status has the row's room until it is revealed; the
          // row keeps one control line's height either way.
          <div
            {...metaProps}
            className={cn(
              'flex max-w-full min-w-0 flex-nowrap items-center justify-end gap-2 px-1 text-muted-foreground',
              typeClass('caption', compact ? 'compact' : 'default'),
              status != null && (compact ? 'min-h-7' : 'min-h-9'),
              metaProps?.className,
            )}
          >
            {(showTime || actions != null) && (
              <span
                className={cn(
                  'flex shrink-0 items-center gap-2 select-none',
                  !isTouch && [
                    'opacity-0 pointer-events-none transition-opacity duration-160',
                    'group-hover/message:opacity-100 group-hover/message:pointer-events-auto',
                    'group-focus-within/message:opacity-100 group-focus-within/message:pointer-events-auto',
                  ],
                  !isTouch &&
                    status != null && [
                      'max-w-0 overflow-hidden',
                      'group-hover/message:max-w-none group-hover/message:overflow-visible',
                      'group-focus-within/message:max-w-none group-focus-within/message:overflow-visible',
                    ],
                )}
              >
                {showTime && <span className="tabular-nums">{time}</span>}
                {actions != null && <span className="flex items-center gap-0.5">{actions}</span>}
              </span>
            )}
            {status != null && (
              <span className="flex min-w-0 flex-nowrap items-center gap-1">{status}</span>
            )}
          </div>
        )}
      </motion.div>
    );
  },
);

ChatMessage.displayName = 'ChatMessage';

export type { ChatMessageProps };
export { ChatMessage };
export default ChatMessage;
