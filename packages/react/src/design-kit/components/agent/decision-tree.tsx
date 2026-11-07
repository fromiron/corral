'use client';

// A branching decision: the agent's question, numbered options with its pick
// highlighted, and a nested follow-up under the pick. Number keys choose.

import { forwardRef, type HTMLAttributes, type ReactNode, useEffect, useState } from 'react';
import { focusRing } from '../../lib/focus.ts';
import { fontWeights } from '../../lib/font-weight.ts';
import { useShape } from '../../lib/shape-context.tsx';
import { type SizeVariant, useSize } from '../../lib/size-context.tsx';
import { cn } from '../../lib/utils.ts';
import { Badge } from '../ui/badge.tsx';
import {
  AgentCard,
  AgentIdentity,
  type AgentMark,
  Keycap,
  SizeScope,
  ToolStack,
} from './agent-primitives.tsx';

interface DecisionOption {
  id: string;
  label: string;
  /** Leading mark. */
  icon?: AgentMark;
  /** Effect lines under the option. */
  effects?: ReactNode[];
  /** Apps the option touches. */
  apps?: AgentMark[];
  /** Follow-up decision shown beside this option. */
  followUp?: DecisionNode;
}

interface DecisionNode {
  question: string;
  options: DecisionOption[];
  /** Id of the agent's recommended option. */
  pickId?: string;
}

interface DecisionTreeProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onSelect'> {
  /** Risk badge above the question. */
  risk?: 'high' | 'medium' | 'low';
  agent: { name: string; model?: string; logo?: AgentMark };
  /** Context line under the question. */
  context?: ReactNode;
  decision: DecisionNode;
  /** Controlled top-level choice (defaults to the agent's pick). */
  selectedId?: string | null;
  /** Observe a recorded branch without proposing or dispatching choices. */
  readOnly?: boolean;
  /** Host wording for the recorded inspector. */
  labels?: { options?: string; selected?: string; unknown?: string };
  onSelect?: (id: string) => void;
  /** Controlled follow-up choice under the selected option (undefined = still asking). */
  followUpId?: string | null;
  /** Choice in the follow-up decision. */
  onSelectFollowUp?: (optionId: string, followUpId: string) => void;
  /** Listen for number keys on the window. */
  keyboard?: boolean;
  /** Density for the whole tree; omitted, it inherits the nearest SizeProvider. */
  size?: SizeVariant;
}

const riskColor = { high: 'red', medium: 'amber', low: 'green' } as const;
const riskLabel = { high: 'High risk', medium: 'Medium risk', low: 'Low risk' } as const;

function OptionButton({
  option,
  n,
  pick,
  active,
  onClick,
  compact,
  readOnly,
}: {
  option: DecisionOption;
  n?: number;
  pick: boolean;
  active: boolean;
  onClick: () => void;
  compact?: boolean;
  readOnly?: boolean;
}) {
  const size = useSize();
  const shape = useShape();
  const Tag = readOnly ? 'div' : 'button';
  return (
    <Tag
      type={readOnly ? undefined : 'button'}
      onClick={readOnly ? undefined : onClick}
      aria-keyshortcuts={n ? String(n) : undefined}
      aria-label={readOnly ? undefined : pick ? `${option.label} – the agent's pick` : option.label}
      aria-pressed={readOnly ? undefined : active}
      data-selected={active || undefined}
      className={cn(
        'grid gap-0.5 border px-3 py-2 text-left transition-colors duration-160',
        shape.bg,
        !readOnly && focusRing,
        pick || (readOnly && active) ? 'border-emphasis' : 'border-border',
        active ? 'bg-selected' : !readOnly && 'hover:bg-hover',
      )}
    >
      <span className="flex flex-wrap items-center gap-2">
        {n !== undefined && <Keycap>{n}</Keycap>}
        {option.icon && <ToolStack tools={[option.icon]} size={18} />}
        <span
          className={cn(compact ? size.type.caption : size.type.body, 'text-foreground')}
          style={{ fontVariationSettings: fontWeights.semibold }}
        >
          {option.label}
        </span>
        {pick && (
          <span className={cn(size.type.caption)} style={{ color: 'var(--emphasis)' }}>
            Agent's pick
          </span>
        )}
      </span>
      {(option.effects?.length || option.apps?.length) && (
        <span className="flex items-center gap-2.5">
          <span
            className={cn(
              size.type.caption,
              'grid',
              active ? 'text-foreground' : 'text-muted-foreground',
            )}
          >
            {option.effects?.map((e, i) => (
              // Effect lines are static slots supplied with this option.
              // biome-ignore lint/suspicious/noArrayIndexKey: source component static effect slots
              <span key={i}>{e}</span>
            ))}
          </span>
          {option.apps && <ToolStack tools={option.apps} size={20} />}
        </span>
      )}
    </Tag>
  );
}

/** Three dots breathing in turn while a follow-up waits on an answer. */
function Waiting() {
  return (
    <span aria-hidden className="inline-flex items-center gap-1 align-middle">
      {[0, 150, 300].map((d) => (
        <span
          key={d}
          className="pulse-soft size-1 rounded-full bg-muted-foreground"
          style={{ animationDelay: `${d}ms` }}
        />
      ))}
    </span>
  );
}

const DecisionTreeBody = forwardRef<HTMLDivElement, Omit<DecisionTreeProps, 'size'>>(
  (
    {
      risk,
      agent,
      context,
      decision,
      selectedId,
      readOnly = false,
      labels,
      onSelect,
      followUpId,
      onSelectFollowUp,
      keyboard = true,
      className,
      ...props
    },
    ref,
  ) => {
    const size = useSize();
    const [state, setState] = useState(decision.pickId ?? decision.options[0]?.id);
    const current = selectedId !== undefined ? selectedId : readOnly ? null : state;
    const [subState, setSubState] = useState<string | null>(null);
    const sub = followUpId !== undefined ? followUpId : subState;
    const choose = (id: string) => {
      if (readOnly) return;
      if (selectedId === undefined) setState(id);
      if (followUpId === undefined) setSubState(null);
      onSelect?.(id);
    };
    const chooseSub = (optionId: string, id: string) => {
      if (readOnly) return;
      if (optionId !== current) choose(optionId);
      if (followUpId === undefined) setSubState(id);
      onSelectFollowUp?.(optionId, id);
    };
    const chosen = decision.options.find((o) => o.id === current);

    useEffect(() => {
      if (!keyboard || readOnly) return;
      const onKey = (e: KeyboardEvent) => {
        if (
          e.metaKey ||
          e.ctrlKey ||
          e.altKey ||
          (e.target as HTMLElement)?.closest?.('input,textarea,[contenteditable]')
        )
          return;
        const i = Number(e.key) - 1;
        if (!Number.isInteger(i) || i < 0) return;
        const next = chosen?.followUp;
        if (chosen && next && !sub) {
          if (next.options[i]) chooseSub(chosen.id, next.options[i].id);
        } else if (decision.options[i]) choose(decision.options[i].id);
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    });

    return (
      <div
        ref={ref}
        className={cn(
          'grid min-w-0 items-center gap-7 @min-[620px]/decision:grid-cols-[minmax(0,204px)_minmax(0,1fr)]',
          className,
        )}
        {...props}
      >
        <div className="relative grid gap-2.5">
          {risk && (
            <span>
              <Badge color={riskColor[risk]}>{riskLabel[risk]}</Badge>
            </span>
          )}
          <AgentCard className="grid gap-2.5 px-4 py-3.5">
            <AgentIdentity name={agent.name} model={agent.model} logo={agent.logo} />
            <h3
              className={cn(size.type.body, 'text-foreground')}
              style={{ fontVariationSettings: fontWeights.semibold }}
            >
              {decision.question}
            </h3>
            {context && <p className={cn(size.type.caption, 'text-muted-foreground')}>{context}</p>}
          </AgentCard>
        </div>
        <fieldset
          aria-label={labels?.options ?? 'How should the agent go on?'}
          className="m-0 grid min-w-0 gap-3.5 border-0 p-0"
        >
          {decision.options.map((o, i) => {
            const active = o.id === current;
            return (
              <div
                key={o.id}
                className={cn(
                  'grid items-center gap-6 @min-[620px]/decision:grid-cols-[minmax(0,184px)_minmax(0,1fr)] transition-opacity duration-160',
                  !readOnly && !active && 'opacity-40',
                )}
              >
                <OptionButton
                  option={o}
                  n={keyboard && !readOnly ? i + 1 : undefined}
                  readOnly={readOnly}
                  pick={!readOnly && o.id === decision.pickId}
                  active={active}
                  onClick={() => choose(o.id)}
                />
                {o.followUp && (
                  <div className="grid justify-items-start gap-2">
                    <div
                      className={cn(size.type.caption, 'flex items-center gap-2 text-foreground')}
                      style={{ fontVariationSettings: fontWeights.semibold }}
                    >
                      {o.followUp.question}
                      {!readOnly && active && !sub && <Waiting />}
                    </div>
                    <fieldset
                      aria-label={o.followUp.question}
                      className="m-0 grid min-w-0 justify-items-start gap-1.5 border-0 p-0 pl-5"
                    >
                      {o.followUp.options.map((s, j) => (
                        <div
                          key={s.id}
                          className={cn(
                            'transition-opacity duration-160',
                            !readOnly && active && sub && sub !== s.id && 'opacity-40',
                          )}
                        >
                          <OptionButton
                            option={s}
                            n={keyboard && !readOnly && active && !sub ? j + 1 : undefined}
                            readOnly={readOnly}
                            compact
                            pick={!readOnly && s.id === o.followUp?.pickId}
                            active={active && sub === s.id}
                            onClick={() => chooseSub(o.id, s.id)}
                          />
                        </div>
                      ))}
                    </fieldset>
                  </div>
                )}
              </div>
            );
          })}
        </fieldset>
        <div className="sr-only" aria-live="polite" aria-atomic="true">
          {readOnly
            ? chosen
              ? `${labels?.selected ?? 'Selected'}: ${chosen.label}`
              : (labels?.unknown ?? 'No recorded choice')
            : chosen
              ? `${chosen.label} – picked.${chosen.followUp ? (sub ? ` ${chosen.followUp.options.find((x) => x.id === sub)?.label ?? ''} – picked.` : ` Next: ${chosen.followUp.question}`) : ''}`
              : ''}
        </div>
      </div>
    );
  },
);
DecisionTreeBody.displayName = 'DecisionTreeBody';

/** Branching decision with the agent's pick, follow-up, and number-key shortcuts. */
const DecisionTree = forwardRef<HTMLDivElement, DecisionTreeProps>(({ size, ...props }, ref) => (
  <SizeScope size={size}>
    <div className="@container/decision min-w-0">
      <DecisionTreeBody ref={ref} {...props} />
    </div>
  </SizeScope>
));
DecisionTree.displayName = 'DecisionTree';

export type { DecisionNode, DecisionOption, DecisionTreeProps };
export { DecisionTree };
