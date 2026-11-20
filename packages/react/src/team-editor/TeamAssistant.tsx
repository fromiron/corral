import { TEAM_PATTERNS, type TeamAssistantTarget, type TeamPlan } from '@corral/contracts';
import {
  type CompileOptions,
  isReadOnlyTeam,
  isTemplatePattern,
  PATTERN_TEMPLATES,
} from '@corral/core';
import { motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
  InputMessage,
  KitBadge,
  RadioGroup,
  RadioItem,
  Switch,
  Tooltip,
  useShape,
  useSize,
} from '../design-kit/index.ts';
import { focusRing } from '../design-kit/lib/focus.ts';
import { fontWeights } from '../design-kit/lib/font-weight.ts';
import { spring } from '../design-kit/lib/springs.ts';
import { surfaceClasses, surfaceHoverClasses } from '../design-kit/lib/surface-classes.ts';
import { cn } from '../design-kit/lib/utils.ts';
import type { EditorDraft } from '../editor/model.ts';
import type { EditorStore } from '../editor/store.ts';
import { Bot, ChevronDown, ChevronRight, PanelRight, Sparkles } from '../ui/icons.ts';
import {
  type AssistantActions,
  assistantConversation,
  type Conversation,
  createAssistantActions,
  type TeamAssistantHost,
} from './assistant.ts';
import {
  type AssistantText,
  modeOf,
  type Proposal,
  summarize,
  targetLabel,
} from './assistant-proposal.ts';
import { outlineOrder } from './layout.ts';
import { type RosterRow, rosterOf } from './roster.ts';

export type { TeamAssistantHost } from './assistant.ts';

const edits = ['describe', 'add_shared_advice', 'require_review', 'set_brief'] as const;
const optionClass = 'h-auto min-h-7 max-w-full whitespace-normal text-start';

function sameTarget(a: TeamAssistantTarget | undefined, b: TeamAssistantTarget) {
  return a?.outputId === b.outputId && a.index === b.index;
}

/** Read the same flow tree as the composition list. Parallel workers are not a sequence. */
function flowOf({ result }: Proposal, t: AssistantText) {
  const { definition } = result;
  const names = new Map(definition.nodes.map((node) => [node.id, node.label]));
  const steps = (rows: RosterRow[]): string =>
    rows
      .map((row): string => {
        if (row.kind === 'parallel') {
          return t('parallelFlow', { steps: row.branches.map((b) => steps(b.rows)).join(' + ') });
        }
        if (row.kind === 'loop') {
          const inner = steps(row.children);
          return row.maxIterations === undefined
            ? `${names.get(row.nodeId)}: ${inner}`
            : t('loopFlow', { steps: inner, count: row.maxIterations });
        }
        if (row.kind === 'team') return steps(row.children);
        return names.get(row.nodeId) ?? row.nodeId;
      })
      .join(' → ');
  return steps(rosterOf(definition, outlineOrder(definition)).steps);
}

function PlanPreview({
  proposal,
  plan,
  actions,
  t,
  disabled,
  target,
  templates,
}: {
  proposal: Proposal;
  plan: TeamPlan;
  actions: AssistantActions;
  t: AssistantText;
  disabled: boolean;
  target: TeamAssistantTarget | undefined;
  templates: boolean;
}) {
  const root = useTranslations();
  const td = useTranslations('TeamDraft');
  const id = useId();
  const { definition } = proposal.result;
  const shared = definition.sharedOutrider;
  const flow = useMemo(() => flowOf(proposal, t), [proposal, t]);
  const results = useMemo(
    () =>
      summarize(proposal.result)
        .outputs.flatMap((output) =>
          output.results.map((result) =>
            t('resultBy', { name: result.name, producer: result.producerName }),
          ),
        )
        .join(' · '),
    [proposal.result, t],
  );
  const patternOptions = useMemo(
    () =>
      TEAM_PATTERNS.flatMap((pattern) => {
        if (isTemplatePattern(pattern) && !templates && pattern !== plan.pattern) return [];
        const card =
          pattern === 'single'
            ? 'starter'
            : isTemplatePattern(pattern)
              ? PATTERN_TEMPLATES[pattern]
              : null;
        return [
          {
            value: pattern,
            label: card ? root(`Workspace.template.${card}.name`) : td(`patterns.${pattern}`),
            hint: card ? root(`Workspace.template.${card}.body`) : t(`difference.${pattern}`),
          },
        ];
      }),
    [plan.pattern, root, t, td, templates],
  );
  return (
    <div className="grid min-w-0 gap-1">
      <ul aria-label={td('rolesLabel')} className="grid min-w-0 gap-y-1">
        {definition.roles.map((role) => {
          const duty =
            plan.roles.find((r) => r.slot === role.id)?.duty ?? role.prompt.split('\n', 1)[0];
          return (
            <li key={role.id} className="flex min-w-0 items-baseline gap-2">
              <Bot aria-hidden className="size-4 shrink-0 self-center text-muted-foreground" />
              <span
                className="max-w-[40%] shrink-0 truncate"
                title={role.name}
                style={{ fontVariationSettings: fontWeights.semibold }}
              >
                {role.name}
              </span>
              <span className="min-w-0 truncate" title={duty}>
                {duty}
              </span>
            </li>
          );
        })}
      </ul>
      <p>{t('flowResult', { flow, results })}</p>
      <p className="text-muted-foreground">{proposal.reason}</p>
      {shared && (
        <p className="text-caption text-muted-foreground">
          {td(shared.artifactReview ? 'artifactAdvice' : 'sharedAdvice')}
        </p>
      )}
      {definition.nodes.some((n) => n.type === 'output' && n.requireApproval) && (
        <p>{t('approval')}</p>
      )}
      {/* The options take the card's width, not the kit's 18rem column. */}
      <Accordion size="compact" className="w-full">
        <AccordionItem value="options" highlight="trigger" disabled={disabled}>
          <AccordionTrigger>{t('options')}</AccordionTrigger>
          <AccordionContent>
            <div className="grid gap-2">
              <p>
                {t('criteria')}: {plan.criteria.join(' · ')}
              </p>
              <div className="min-w-0">
                <h4 id={`${id}-pattern`} className="text-caption">
                  {td('patternLabel')}
                </h4>
                <RadioGroup
                  className="w-full"
                  aria-labelledby={`${id}-pattern`}
                  value={plan.pattern}
                  aria-disabled={disabled}
                  inert={disabled}
                  onValueChange={(value) => {
                    const option = patternOptions.find((p) => p.value === value);
                    if (!disabled && option) actions.pattern(option.value);
                  }}
                >
                  {patternOptions.map((option, i) => (
                    <RadioItem
                      key={option.value}
                      index={i}
                      value={option.value}
                      className="h-auto min-h-8 py-1 text-start"
                      label={`${option.label} — ${option.hint}`}
                      aria-label={option.label}
                      aria-description={option.hint}
                    />
                  ))}
                </RadioGroup>
              </div>
              <div className="grid gap-1 text-caption text-muted-foreground">
                <p>{td(isReadOnlyTeam(definition) ? 'readOnlyWork' : 'changesWork')}</p>
                <p>
                  {td(
                    definition.nodes.some((n) => n.type === 'loop')
                      ? 'hasReviewRound'
                      : 'noReviewRound',
                  )}
                </p>
              </div>
              <div className="grid gap-1">
                <Switch
                  label={root('TeamEditor.sharedOutrider.observe')}
                  checked={Boolean(shared?.observation)}
                  disabled={disabled}
                  onToggle={() => actions.observe(!shared?.observation)}
                />
                {shared?.observation && (
                  <p className="text-caption">
                    {td('observationSummary', {
                      model: shared.modelProfile,
                      interval: shared.observation.review.interval,
                      cap: shared.observation.review.maxRequestsPerReview,
                    })}
                  </p>
                )}
              </div>
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
      {plan.outrider === 'clarify_review' && (
        <div className="grid gap-1">
          <p>{td('reviewQuestion')}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="tertiary"
              disabled={disabled}
              onClick={() => actions.reviewPolicy('opinion_only')}
            >
              {td('reviewFeedback')}
            </Button>
            <Button
              variant="tertiary"
              disabled={disabled}
              onClick={() => actions.reviewPolicy('required')}
            >
              {td('reviewRequired')}
            </Button>
          </div>
        </div>
      )}
      {plan.outrider === 'required_review' &&
        proposal.targets.map((candidate) => {
          const hint = `${id}-${candidate.outputId}-${candidate.index}`;
          const checked = sameTarget(target, candidate) && proposal.canApply;
          const name = targetLabel(proposal.result, candidate, t);
          return (
            <div className="grid gap-1" key={hint}>
              <Switch
                label={root('Inspector.requireReview')}
                checked={checked}
                disabled={disabled}
                aria-describedby={hint}
                onToggle={() => actions.confirmTarget(checked ? undefined : candidate)}
              />
              <p id={hint} className="text-caption text-muted-foreground">
                {name}
              </p>
            </div>
          );
        })}
    </div>
  );
}

function QuestionChoices({
  question,
  draft,
  actions,
  decisions,
  focus,
  disabled,
  costId,
  t,
}: {
  question: NonNullable<Conversation['question']>;
  draft: EditorDraft;
  actions: AssistantActions;
  decisions: Conversation['decisions'];
  focus(): void;
  disabled: boolean;
  /** The caption beside the input that names the model and the request a press would send. */
  costId: string | undefined;
  t: AssistantText;
}) {
  const outputs = useMemo(
    () => (question.id === 'review_target' ? summarize(draft).outputs : []),
    [question.id, draft],
  );
  if (question.id === 'brief') return null;
  return (
    <fieldset className="flex flex-wrap gap-2">
      <legend className="sr-only">{t(`question.${question.id}`)}</legend>
      {question.choices.map((value) => {
        let label: string;
        let chosen: boolean;
        if (typeof value === 'string') {
          label = t(`choice.${value}`);
          chosen = value === decisions.material || value === decisions.reviewPolicy;
        } else {
          const result = outputs
            .find((o) => o.outputId === value.outputId)
            ?.results.find((r) => r.index === value.index);
          if (!result) return null;
          label = targetLabel(
            draft,
            { ...value, name: result.name, producerName: result.producerName },
            t,
          );
          chosen = sameTarget(decisions.reviewTarget, value);
        }
        return (
          <Button
            key={typeof value === 'string' ? value : `${value.outputId}/${value.index}`}
            variant="secondary"
            className={optionClass}
            disabled={disabled}
            aria-describedby={costId}
            aria-pressed={chosen}
            onClick={() => {
              void actions.answer(value, label);
              focus();
            }}
          >
            {label}
          </Button>
        );
      })}
      {(['recommend', 'direct'] as const).map((action) => (
        <Button
          key={action}
          variant="ghost"
          disabled={disabled}
          aria-describedby={action === 'recommend' ? costId : undefined}
          className={optionClass}
          onClick={() => {
            if (action === 'recommend') void actions.answer(action, t('choice.recommend'));
            focus();
          }}
        >
          {t(`choice.${action}`)}
        </Button>
      ))}
    </fieldset>
  );
}

/** One in-memory conversation per editor store. The host alone knows how to send a request. */
export function TeamAssistant({
  editor,
  host,
  start,
  onApplied,
  compileOptions,
  className,
  sideClassName,
}: {
  editor: EditorStore;
  host: TeamAssistantHost;
  start?: { open: boolean } | undefined;
  onApplied(row: string): void;
  compileOptions?: Pick<CompileOptions, 'resolveTeam' | 'knownModelProfiles'> | undefined;
  /** Where the editor's frame places the conversation under its work area. */
  className?: string | undefined;
  /**
   * Where the frame places it as a column on its right. Given this, an editor of 88rem or
   * more keeps the conversation there instead of under the work area.
   */
  sideClassName?: string | undefined;
}) {
  const root = useTranslations();
  const t = useCallback<AssistantText>(
    (key, values) =>
      root(/^(TeamEditor|Inspector|Validation)\./.test(key) ? key : `TeamAssistant.${key}`, values),
    [root],
  );
  const td = useTranslations('TeamDraft');
  const store = assistantConversation(editor, start);
  const state = useStore(store);
  const draft = useStore(editor, (s) => s.draft);
  const actions = useMemo(
    () => createAssistantActions(editor, host, t, compileOptions),
    [editor, host, t, compileOptions],
  );
  const { cancel } = actions;
  useEffect(() => cancel, [cancel]);
  const connected = Boolean(host.ask);
  useEffect(() => {
    if (!connected) cancel();
  }, [connected, cancel]);
  const creating = modeOf(draft) === 'create';
  const title = t(creating ? 'createTitle' : 'editTitle');
  const prompt = t(creating ? 'createPrompt' : 'editPrompt');
  const { input, turns, proposal, question, failure } = state;
  const busy = Boolean(state.pending);
  const stale = Boolean(proposal && proposal.base !== draft);
  const lastTurn = turns.at(-1);
  const surface = useRef<HTMLElement>(null);
  const [room, setRoom] = useState<'sheet' | 'dock' | 'side'>('dock');
  useLayoutEffect(() => {
    // The editor frame stays mounted when the conversation moves between its places.
    const frame = surface.current?.parentElement;
    if (!frame) return;
    const measure = () => {
      const width = frame.clientWidth;
      if (width === 0) return; // A hidden editor does not have a layout to switch to.
      const rem =
        Number.parseFloat(getComputedStyle(frame.ownerDocument.documentElement).fontSize) || 16;
      setRoom(width < 30 * rem ? 'sheet' : width < 88 * rem ? 'dock' : 'side');
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);
  const narrow = room === 'sheet';
  const side = room === 'side' && sideClassName !== undefined;
  // Nobody chose: the column stands open, the line and the sheet closed.
  const chosen = state.open;
  const open = chosen ?? side;
  const field = useRef<HTMLTextAreaElement>(null);
  const connect = useRef<HTMLButtonElement>(null);
  const entry = useRef<HTMLButtonElement>(null);
  const composing = useRef(false);
  const returnToEntry = useRef(false);
  const focusRow = useRef<string | null>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const id = useId();
  const reduceMotion = useReducedMotion();
  const wasMounted = useRef(false);
  useEffect(() => {
    wasMounted.current = true;
  }, []);
  // Asked for by a press in the conversation; the place may turn before it renders (below).
  const focusWanted = useRef(false);
  // Without a model the switched-off request stands where the input is, and takes its focus.
  const focusInput = () => {
    focusWanted.current = true;
    (field.current ?? connect.current)?.focus();
  };
  useLayoutEffect(() => {
    // Only a chosen opening takes the focus; a column that stands open by itself leaves it,
    // and so does one whose first use (a choice pressed in it) made the opening chosen.
    if (narrow) return;
    const section = surface.current;
    if (chosen) {
      if (!section?.contains(section.ownerDocument.activeElement))
        (field.current ?? connect.current)?.focus();
    } else if (returnToEntry.current) entry.current?.focus();
    returnToEntry.current = false;
  }, [chosen, narrow]);
  useLayoutEffect(() => {
    // Keep the latest reply and the composer reachable without scrolling the editor behind them.
    const panel = scroll.current;
    if (!panel || !open) return;
    if (proposal || question || lastTurn || failure) panel.scrollTop = panel.scrollHeight;
  }, [open, lastTurn, proposal, question, failure]);
  useLayoutEffect(() => {
    // Mobile browsers can shrink only the visual viewport when the keyboard appears.
    const viewport = window.visualViewport;
    if (!narrow || !open || !viewport) return;
    function fitSheet() {
      if (!sheet.current || !viewport) return;
      sheet.current.style.bottom = `${Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)}px`;
      sheet.current.style.maxHeight = `min(85dvh, ${viewport.height}px)`;
    }
    fitSheet();
    viewport.addEventListener('resize', fitSheet);
    viewport.addEventListener('scroll', fitSheet);
    return () => {
      viewport.removeEventListener('resize', fitSheet);
      viewport.removeEventListener('scroll', fitSheet);
    };
  }, [open, narrow]);
  function collapse() {
    returnToEntry.current = true;
    composing.current = false;
    actions.setOpen(false);
  }
  function apply() {
    const row = actions.apply();
    if (row === null) return;
    if (narrow) focusRow.current = row;
    else onApplied(row);
    // Beside the work area the conversation covers nothing, so it stays for the next change.
    if (!side) actions.setOpen(false);
  }
  const localReply = question?.source === 'choice';
  const paidSend = connected && !localReply;
  // Only a choice's own question takes typed text without a model.
  const inputOff = !connected && !localReply;
  const modelName = host.modelLabel || td('ask');
  const cost = paidSend ? `${modelName} · ${td('askCost')}` : null;
  const origin =
    proposal?.origin === 'model'
      ? t('modelProposal', { model: state.model || modelName })
      : t('changes');
  const shape = useShape();
  const compact = useSize().variant === 'compact';
  const wasOff = useRef(inputOff);
  useLayoutEffect(() => {
    // The press that asked for the request's focus turned its place (a choice opened its
    // question, or answered it): the focus follows to what stands there now. A model that comes
    // or goes by itself moves no focus.
    if (wasOff.current === inputOff) return;
    wasOff.current = inputOff;
    if (focusWanted.current) (field.current ?? connect.current)?.focus();
  }, [inputOff]);
  useLayoutEffect(() => {
    focusWanted.current = false;
  });
  const waiting = proposal ? t('proposalWaiting') : question ? t('questionWaiting') : null;
  const chooseEntry = side ? (
    // In its rail the entry is the icon alone; the tooltip and the name say what it opens.
    <Tooltip content={waiting ? `${title} · ${waiting}` : title} side="left">
      <Button
        ref={entry}
        variant="ghost"
        size="icon-compact"
        aria-label={title}
        aria-expanded={open}
        aria-describedby={waiting ? `${id}-waiting` : undefined}
        className="relative mt-1.5"
        onClick={() => actions.setOpen(true)}
      >
        <Sparkles aria-hidden />
        {waiting && (
          <>
            <span aria-hidden className="absolute end-1 top-1 size-1.5 rounded-full bg-emphasis" />
            <span id={`${id}-waiting`} className="sr-only">
              {waiting}
            </span>
          </>
        )}
      </Button>
    </Tooltip>
  ) : (
    <Button
      ref={entry}
      variant="ghost"
      aria-label={title}
      aria-expanded={open}
      aria-controls={open ? id : undefined}
      aria-describedby={waiting ? `${id}-waiting` : undefined}
      className="h-10 w-full justify-start px-4"
      onClick={() => actions.setOpen(true)}
    >
      <span className="flex items-center gap-2">
        <Sparkles aria-hidden className="size-4" />
        {title}
        {waiting && (
          <span id={`${id}-waiting`} className="text-caption text-muted-foreground">
            {waiting}
          </span>
        )}
      </span>
      <ChevronRight aria-hidden className="absolute end-4 size-4 -rotate-90" />
    </Button>
  );
  // The conversation keeps the detail's measure and its axis: 40rem in the middle of the work area.
  const body = (
    <div className="mx-auto grid min-h-0 w-full max-w-[42rem] flex-1 grid-rows-[minmax(0,1fr)_auto] gap-2 overflow-hidden px-4 pb-3 text-body [overflow-wrap:anywhere]">
      <div
        ref={scroll}
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-label={title}
        className={cn(
          'min-h-0 overflow-y-auto overscroll-contain',
          // In the column the conversation rests on the input and grows upward.
          side && 'flex flex-col [&>:first-child]:mt-auto',
        )}
      >
        <div className="grid min-w-0 gap-2">
          {turns.map((turn) => (
            <p
              key={turn.id}
              className={
                turn.role === 'user'
                  ? 'max-w-[90%] justify-self-end whitespace-pre-wrap rounded-md bg-muted px-3 py-1.5 text-foreground'
                  : 'whitespace-pre-wrap'
              }
            >
              <span className="sr-only">{t(turn.role === 'user' ? 'yourRequest' : 'reply')}: </span>
              {turn.text}
            </p>
          ))}
          {proposal && (
            <section
              data-assistant-preview
              aria-label={origin}
              className="grid gap-2 rounded-lg border border-border px-3 py-2"
            >
              {stale && <p style={{ fontVariationSettings: fontWeights.semibold }}>{t('stale')}</p>}
              <div className="grid gap-2 text-foreground">
                <div className="flex min-w-0 flex-wrap items-baseline gap-2">
                  <h3
                    className="text-subtitle"
                    style={{ fontVariationSettings: fontWeights.semibold }}
                  >
                    {proposal.plan ? proposal.result.definition.name : t('changes')}
                  </h3>
                  {proposal.origin !== 'choice' && <KitBadge size="compact">{origin}</KitBadge>}
                </div>
                {!proposal.plan && <p className="text-muted-foreground">{proposal.reason}</p>}
                {proposal.plan && (
                  <PlanPreview
                    proposal={proposal}
                    plan={proposal.plan}
                    actions={actions}
                    t={t}
                    disabled={stale || busy}
                    target={state.decisions.reviewTarget}
                    templates={Boolean(host.wording.templates)}
                  />
                )}
                {proposal.briefChange && (
                  <dl className="grid min-w-0 gap-2">
                    <div>
                      <dt className="text-caption text-muted-foreground">{t('diff.before')}</dt>
                      <dd
                        className="line-clamp-4 whitespace-pre-wrap text-muted-foreground"
                        title={proposal.briefChange.before}
                      >
                        {proposal.briefChange.before}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-caption text-muted-foreground">{t('diff.after')}</dt>
                      <dd
                        className="line-clamp-4 whitespace-pre-wrap text-foreground"
                        title={proposal.briefChange.after}
                      >
                        {proposal.briefChange.after}
                      </dd>
                    </div>
                  </dl>
                )}
                {proposal.changes.length > 0 && (
                  <ul className="grid gap-1">
                    {proposal.changes.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="compact"
                  variant="primary"
                  disabled={busy || stale || !proposal.canApply}
                  onClick={apply}
                >
                  {t('apply')}
                </Button>
                <Button
                  size="compact"
                  variant="tertiary"
                  disabled={busy}
                  onClick={() => void actions.retry()}
                >
                  {t('again')}
                </Button>
              </div>
            </section>
          )}
          {busy && <p className="text-caption text-muted-foreground">{td('asking')}</p>}
          {failure && (
            <div className="grid justify-items-start gap-1">
              <p role="alert" className="text-destructive">
                {failure}
              </p>
              <Button variant="tertiary" disabled={busy} onClick={() => void actions.retry()}>
                {td('retry')}
              </Button>
            </div>
          )}
        </div>
        {question && (
          <QuestionChoices
            question={question}
            draft={draft}
            actions={actions}
            decisions={state.decisions}
            // A new team's question waits for the model; an edit's continues without one.
            disabled={busy || (!connected && question.source === 'model' && creating)}
            costId={cost ? `${id}-cost` : undefined}
            focus={focusInput}
            t={t}
          />
        )}
        {!question && !proposal && !busy && (
          <div className="grid gap-2">
            {/* The other way to start stands at the end of the opening line, not as a row. */}
            <div className="flex flex-wrap items-center justify-between gap-x-2">
              <p className="text-foreground">{prompt}</p>
              {creating && host.onBrowseTemplates && (
                <Button size="compact" variant="ghost" onClick={host.onBrowseTemplates}>
                  {t('templates')}
                </Button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {creating
                ? !inputOff &&
                  (['newsletter', 'guide', 'compare'] as const).map((example) => (
                    <Button
                      key={example}
                      size="compact"
                      variant="secondary"
                      className={optionClass}
                      onClick={() => {
                        actions.setInput(t(`examples.${example}`));
                        focusInput();
                      }}
                    >
                      {t(`examples.${example}`)}
                    </Button>
                  ))
                : edits.map((choice) => (
                    <Button
                      key={choice}
                      size="compact"
                      variant="secondary"
                      className={optionClass}
                      onClick={() => {
                        actions.chooseEdit(choice);
                        if (choice === 'set_brief') focusInput();
                      }}
                    >
                      {t(`choice.${choice}`)}
                    </Button>
                  ))}
            </div>
          </div>
        )}
      </div>
      {inputOff ? (
        // The request is switched off: one control in the input's place and size, which opens
        // the model settings, or in the browser demo says where the request works.
        <button
          ref={connect}
          type="button"
          // Unavailable but still focusable, so opening the conversation lands on it.
          aria-disabled={!host.onConnectModel || undefined}
          onClick={host.onConnectModel}
          className={cn(
            'flex w-full shrink-0 flex-col gap-1 p-2 text-start text-muted-foreground transition-[box-shadow,color,background-color] duration-(--duration-fast)',
            surfaceClasses(2, 2),
            shape.container,
            focusRing,
            host.onConnectModel
              ? cn(surfaceHoverClasses(2, 2), 'hover:text-foreground')
              : 'cursor-default',
          )}
        >
          <span
            className={
              compact
                ? 'px-1.5 py-1.5 text-[length:var(--fs-subtitle-compact,13px)] leading-[var(--lh-subtitle-compact,18px)]'
                : 'px-2 py-2 text-[length:var(--fs-subtitle,14px)] leading-[var(--lh-subtitle,20px)]'
            }
          >
            {t(host.onConnectModel ? 'connect' : 'localServer')}
          </span>
          {/* The height of the input's action row, which is empty here. */}
          <span aria-hidden className={compact ? 'h-6' : 'h-7'} />
        </button>
      ) : (
        <InputMessage
          className="shrink-0"
          maxRows={3}
          inputRef={field}
          value={input}
          onValueChange={actions.setInput}
          onSend={() => void actions.send()}
          sendLabel={t('send')}
          sendDescription={cost ?? td('noModelCall')}
          sendDisabled={busy}
          placeholder={t(creating ? 'createPlaceholder' : 'editPlaceholder')}
          textareaProps={{
            'aria-label': t(creating ? 'createRequest' : 'editRequest'),
            maxLength: 2000,
            onCompositionStart: () => {
              composing.current = true;
            },
            onCompositionEnd: () => {
              composing.current = false;
            },
            onKeyDownCapture: (e) => {
              if (
                (e.key === 'Enter' || e.key === 'Escape') &&
                (composing.current || e.nativeEvent.isComposing || e.keyCode === 229)
              )
                e.stopPropagation();
            },
          }}
          leftSlot={
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-caption text-muted-foreground">
              {/* Read as one line, "model · one request": the choices take it as their description.
                The model keeps its own element, as wherever else its name is shown. */}
              {paidSend && (
                <span id={`${id}-cost`}>
                  <span>{modelName}</span> · <span>{td('askCost')}</span>
                </span>
              )}
            </div>
          }
          renderAction={
            busy
              ? () => (
                  <Button variant="tertiary" onClick={cancel}>
                    {t('cancel')}
                  </Button>
                )
              : undefined
          }
        />
      )}
    </div>
  );
  if (narrow)
    return (
      <section
        ref={surface}
        aria-label={open ? undefined : title}
        className={cn('shrink-0 border-t border-border', className)}
      >
        <Dialog
          open={open}
          onOpenChange={(next, details) => {
            if (
              !next &&
              details.reason === 'escape-key' &&
              (input.length > 0 || composing.current)
            ) {
              details.cancel();
              return;
            }
            if (next) actions.setOpen(true);
            else collapse();
          }}
        >
          <DialogTrigger render={chooseEntry} />
          <DialogContent
            ref={sheet}
            id={id}
            position="top"
            initialFocus={inputOff ? connect : field}
            finalFocus={() => {
              const row = focusRow.current;
              focusRow.current = null;
              if (row !== null) {
                onApplied(row);
                return false;
              }
              return entry.current;
            }}
            closeLabel={t('collapse')}
            className="bottom-0 top-auto flex max-h-[85dvh] w-full max-w-[45rem] flex-col overflow-hidden rounded-b-none p-0 pb-[env(safe-area-inset-bottom)]"
          >
            <DialogTitle className="shrink-0 px-4 py-3 pe-14">{title}</DialogTitle>
            <section className="flex min-h-0 flex-1 flex-col" aria-label={title}>
              {body}
            </section>
          </DialogContent>
        </Dialog>
      </section>
    );
  return (
    // Under the work area it is as tall as what it holds, up to half of the editor (60% with a
    // question or a proposal): the editor's frame is the size container these are measured
    // against. In a wide editor it is the frame's right column instead, a rail while collapsed.
    <section
      ref={surface}
      aria-label={title}
      style={side ? undefined : { maxHeight: proposal || question ? '60cqh' : '50cqh' }}
      className={cn(
        'flex min-h-0 shrink-0 flex-col overflow-hidden border-border',
        side
          ? cn('border-l', open ? 'w-[clamp(22rem,26cqw,28rem)]' : 'w-10 items-center')
          : 'border-t',
        side ? sideClassName : className,
      )}
      onKeyDown={(event) => {
        if (
          event.key !== 'Escape' ||
          !open ||
          event.defaultPrevented ||
          composing.current ||
          event.nativeEvent.isComposing
        )
          return;
        event.stopPropagation();
        if (input.length === 0) {
          event.preventDefault();
          collapse();
        }
      }}
    >
      {open ? (
        <motion.div
          // Opening grows from the entry row; an editor that starts open does not animate, and
          // neither does the column, which takes the frame's height.
          initial={!side && wasMounted.current && !reduceMotion ? { height: 40 } : false}
          animate={{ height: 'auto' }}
          transition={reduceMotion ? { duration: 0 } : spring.moderate}
          className={cn('flex min-h-0 flex-col overflow-hidden', side && 'flex-1')}
        >
          <div className="flex h-10 w-full shrink-0 items-center justify-between gap-2 ps-4 pe-2">
            <h2
              id={id}
              className="flex items-center gap-2 text-body"
              style={{ fontVariationSettings: fontWeights.semibold }}
            >
              <Sparkles aria-hidden className="size-4" />
              {title}
            </h2>
            <Button
              variant="ghost"
              size="icon-compact"
              aria-label={t('collapse')}
              onClick={collapse}
            >
              {side ? <PanelRight aria-hidden /> : <ChevronDown aria-hidden />}
            </Button>
          </div>
          {body}
        </motion.div>
      ) : (
        chooseEntry
      )}
    </section>
  );
}
