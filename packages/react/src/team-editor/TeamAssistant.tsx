import type { CompositionStep, TeamAssistantTarget, TeamComposition } from '@corral/contracts';
import type { CompileOptions, ResolvedCatalog } from '@corral/core';
import { motion, useReducedMotion } from 'motion/react';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
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
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Flag,
  PanelRight,
  Repeat2,
  ShieldCheck,
  Sparkles,
  Split,
} from '../ui/icons.ts';
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

export type { TeamAssistantHost } from './assistant.ts';

const edits = ['describe', 'add_shared_advice', 'require_review', 'set_brief'] as const;
const optionClass = 'h-auto min-h-7 max-w-full whitespace-normal text-start';
// The composition list's indent for what a step holds.
const rail = 'ps-3.5';

function sameTarget(a: TeamAssistantTarget | undefined, b: TeamAssistantTarget) {
  return a?.outputId === b.outputId && a.index === b.index;
}

/** One seat: its name, the agent it uses, its duty in one line and the skills added to it. */
function SeatRow({
  seatId,
  plan,
  resolved,
  judge,
  t,
}: {
  seatId: string;
  plan: TeamComposition;
  resolved: ResolvedCatalog;
  judge?: boolean;
  t: AssistantText;
}) {
  const seat = plan.seats.find((candidate) => candidate.id === seatId);
  if (!seat) return null;
  const agent = resolved.agentById.get(seat.agent)?.role.name;
  const skills = (seat.skills ?? []).flatMap((id) => {
    const name = resolved.skillById.get(id)?.name;
    return name ? [name] : [];
  });
  return (
    <li className="flex min-w-0 gap-2">
      <Bot aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span
            data-seat-name
            className="min-w-0 truncate"
            title={seat.name}
            style={{ fontVariationSettings: fontWeights.semibold }}
          >
            {seat.name}
          </span>
          {agent && agent !== seat.name && (
            <span className="min-w-0 truncate text-caption text-muted-foreground">{agent}</span>
          )}
          {judge && (
            <span className="inline-flex items-center gap-1 self-center text-caption text-muted-foreground">
              <ShieldCheck aria-hidden size={12} />
              {t('judge')}
            </span>
          )}
        </div>
        <p className="truncate text-muted-foreground" title={seat.duty}>
          {seat.duty}
        </p>
        {skills.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {skills.map((name) => (
              <KitBadge key={name} size="compact">
                {name}
              </KitBadge>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

/** A step that holds several seats: work side by side, or a loop's rounds. */
function StepGroup({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <li className="grid min-w-0 gap-1">
      <span id={id} className="flex items-center gap-1.5 text-caption text-muted-foreground">
        {icon}
        {label}
      </span>
      <ul aria-labelledby={id} className={cn('grid min-w-0 gap-1.5', rail)}>
        {children}
      </ul>
    </li>
  );
}

/** The composed team in the order it works, ending in the result and who submits it. */
function CompositionFlow({
  proposal,
  plan,
  resolved,
  t,
}: {
  proposal: Proposal;
  plan: TeamComposition;
  resolved: ResolvedCatalog;
  t: AssistantText;
}) {
  // A team that ends in work side by side receives each seat's result.
  const results = useMemo(
    () =>
      summarize(proposal.result).outputs.flatMap((output) =>
        output.results.map((result) => ({
          key: `${output.outputId}/${result.index}`,
          text: t('resultBy', { name: result.name, producer: result.producerName }),
        })),
      ),
    [proposal.result, t],
  );
  const seat = (seatId: string, judge?: boolean) => (
    <SeatRow key={seatId} seatId={seatId} plan={plan} resolved={resolved} judge={judge} t={t} />
  );
  const step = (item: CompositionStep, index: number) => {
    if ('seat' in item) return seat(item.seat);
    if ('parallel' in item)
      return (
        <StepGroup
          key={index}
          icon={<Split aria-hidden size={14} />}
          label={t('TeamEditor.composition.parallel')}
        >
          {item.parallel.map((seatId) => seat(seatId))}
        </StepGroup>
      );
    const { work, judge, rounds } = item.loop;
    return (
      <StepGroup
        key={index}
        icon={<Repeat2 aria-hidden size={14} />}
        label={t('rounds', { count: rounds ?? 2 })}
      >
        {work.map((seatId) => seat(seatId))}
        {seat(judge, true)}
      </StepGroup>
    );
  };
  return (
    <ol className="grid min-w-0 gap-1.5">
      {plan.flow.map(step)}
      {results.map((result) => (
        <li key={result.key} className="flex min-w-0 items-center gap-2 text-muted-foreground">
          <Flag aria-hidden className="size-4 shrink-0" />
          <span className="min-w-0">{result.text}</span>
        </li>
      ))}
    </ol>
  );
}

function PlanPreview({
  proposal,
  plan,
  resolved,
  actions,
  t,
  disabled,
  target,
}: {
  proposal: Proposal;
  plan: TeamComposition;
  resolved: ResolvedCatalog;
  actions: AssistantActions;
  t: AssistantText;
  disabled: boolean;
  target: TeamAssistantTarget | undefined;
}) {
  const root = useTranslations();
  const td = useTranslations('TeamDraft');
  const id = useId();
  const shared = proposal.result.definition.sharedOutrider;
  return (
    <div className="grid min-w-0 gap-2">
      <CompositionFlow proposal={proposal} plan={plan} resolved={resolved} t={t} />
      <p className="text-muted-foreground">{proposal.reason}</p>
      {shared && (
        <p className="text-caption text-muted-foreground">
          {td(shared.artifactReview ? 'artifactAdvice' : 'sharedAdvice')}
        </p>
      )}
      {/* The settings take the card's width, not the kit's 18rem column. */}
      <Accordion size="compact" className="w-full">
        <AccordionItem value="options" highlight="trigger" disabled={disabled}>
          <AccordionTrigger>{t('options')}</AccordionTrigger>
          <AccordionContent>
            <div className="grid gap-2">
              <ul className="grid list-disc gap-0.5 ps-5">
                {plan.criteria.map((criterion) => (
                  <li key={criterion}>{criterion}</li>
                ))}
              </ul>
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

/** A proposal a later one replaced: it reads as it was shown and cannot be applied. */
function EarlierProposal({
  proposal,
  plan,
  resolved,
  t,
}: {
  proposal: Proposal;
  plan: TeamComposition;
  resolved: ResolvedCatalog;
  t: AssistantText;
}) {
  return (
    <Accordion size="compact" className="w-full rounded-lg border border-border px-3">
      <AccordionItem value="earlier" highlight="trigger">
        <AccordionTrigger>{t('earlier')}</AccordionTrigger>
        <AccordionContent>
          <div className="grid min-w-0 gap-2 pb-2">
            <CompositionFlow proposal={proposal} plan={plan} resolved={resolved} t={t} />
            <p className="text-muted-foreground">{proposal.reason}</p>
          </div>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
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
  // Until the model list arrives nothing is said about models: the input waits, unable to send.
  const modelPending = !connected && Boolean(host.modelPending);
  // Only a choice's own question takes typed text without a model.
  const inputOff = !connected && !localReply && !modelPending;
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
          {turns.map((turn) =>
            turn.proposal?.plan && turn.proposal.resolved ? (
              <EarlierProposal
                key={turn.id}
                proposal={turn.proposal}
                plan={turn.proposal.plan}
                resolved={turn.proposal.resolved}
                t={t}
              />
            ) : (
              <p
                key={turn.id}
                className={
                  turn.role === 'user'
                    ? 'max-w-[90%] justify-self-end whitespace-pre-wrap rounded-md bg-muted px-3 py-1.5 text-foreground'
                    : 'whitespace-pre-wrap'
                }
              >
                <span className="sr-only">
                  {t(turn.role === 'user' ? 'yourRequest' : 'reply')}:{' '}
                </span>
                {turn.text}
              </p>
            ),
          )}
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
                {proposal.plan && proposal.resolved && (
                  <PlanPreview
                    proposal={proposal}
                    plan={proposal.plan}
                    resolved={proposal.resolved}
                    actions={actions}
                    t={t}
                    disabled={stale || busy}
                    target={state.decisions.reviewTarget}
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
              ? cn(surfaceHoverClasses(2, 2), 'cursor-pointer hover:text-foreground')
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
          sendDescription={cost ?? (modelPending && !localReply ? undefined : td('noModelCall'))}
          sendDisabled={busy || (modelPending && !localReply)}
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
