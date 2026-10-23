'use client';

import { type HTMLMotionProps, motion } from 'motion/react';
import { forwardRef, type ReactNode } from 'react';
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
  /** Message body. When omitted the text bubble is dropped (attachment-only message). */
  children?: ReactNode;
  /** Size step; compact tightens bubble type and padding. Omitted, follows
   *  the surrounding SizeProvider. */
  size?: SizeVariant;
}

// ─── ChatMessage ──────────────────────────────────────────────────────────
// A single transcript entry. `layout="position"` lets earlier messages slide
// up when a new one is appended.
const ChatMessage = forwardRef<HTMLDivElement, ChatMessageProps>(
  ({ from, time, actions, children, size, className, ...props }, ref) => {
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
          'group flex max-w-[80%] flex-col gap-1.5',
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
        {(showTime || actions != null) && (
          // Meta row: always rendered so its height is reserved, but hidden
          // until the message is hovered or an action is focused.
          <div
            className={cn(
              'flex items-center gap-2 px-1 text-muted-foreground select-none',
              typeClass('caption', compact ? 'compact' : 'default'),
              !isTouch && [
                'opacity-0 pointer-events-none transition-opacity duration-150',
                'group-hover:opacity-100 group-hover:pointer-events-auto',
                'group-focus-within:opacity-100 group-focus-within:pointer-events-auto',
              ],
            )}
          >
            {showTime && <span className="tabular-nums">{time}</span>}
            {actions != null && <span className="flex items-center gap-0.5">{actions}</span>}
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
