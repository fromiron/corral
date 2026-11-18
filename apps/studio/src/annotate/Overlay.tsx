// The overlay's drawing over the page area (features/browser-annotate.md 사용자 관측 동작): the
// frame, the hover or keyboard outline with its name tag, the markers, the busy line, the note.
// One full-size surface alone takes the pointer, the wheel and the page area's keys; everything
// drawn over it lets the pointer through to it, except the note.
import { Elevated } from '@corral/react/design-kit';
import { Check, TriangleAlert } from '@corral/react/icons';
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslations } from 'use-intl';
import type {
  AnnotateBridge,
  AnnotatePick,
  AnnotatePoint,
  AnnotateRect,
  AnnotateSubmitResult,
  AnnotateTarget,
  AnnotateTokens,
  StyleChange,
  StyleProperty,
} from '../../../desktop/src/annotate-bridge.ts';
import { sendKeyRole } from '../workbench/sendKey.ts';
import type { Frames } from './AnnotateApp.tsx';
import {
  framePath,
  markerPlaces,
  notePlace,
  noteWidth,
  outlineRect,
  type Size,
  stylePlace,
  tagPlace,
} from './geometry.ts';
import { NoteCard, type NoteView } from './NoteCard.tsx';
import type {
  AnnotateContext,
  AnnotateMessage,
  AnnotateOutcome,
  AnnotateSubmitExtra,
} from './protocol.ts';
import { STYLE_GROUPS, type StyleRowView, StyleView } from './StyleView.tsx';

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** No newer value waits for this property. */
const NONE = Symbol('none');

/** One of the note's popups (the kit's, at the end of the page) while it is open. */
const OPEN_POPUP = '[data-slot="popover-popup"][data-open], [data-slot="select-popup"][data-open]';

const ARROWS = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
} as const;

/** A 1px ring of the app's background around a line, so it stays visible over any page. */
const RING = 'shadow-[0_0_0_1px_var(--background),inset_0_0_0_1px_var(--background)]';

/** One property's row in the style view. */
interface StyleRow {
  /** As written (or chosen). */
  value: string;
  /** What main last put on the page for it (null: Corral's rule is off). */
  applied: string | null;
  problem: 'invalid' | 'page-changed' | 'page-busy' | null;
}

interface NoteStyle {
  open: boolean;
  /** The element's computed values when the view first opened, and the page's tokens. */
  read:
    | 'reading'
    | { failed: string }
    | { before: Record<StyleProperty, string>; tokens: AnnotateTokens };
  rows: Partial<Record<StyleProperty, StyleRow>>;
}

const PROPERTIES = STYLE_GROUPS.flatMap((group) => group.properties);

/** What a send carries of the style view: each property Corral changed on the page. */
function changes(note: Note): StyleChange[] {
  const read = note.style?.read;
  if (!read || typeof read !== 'object' || !('before' in read)) return [];
  return PROPERTIES.flatMap((property) => {
    const applied = note.style?.rows[property]?.applied;
    return applied == null ? [] : [{ property, before: read.before[property], after: applied }];
  });
}

interface Note {
  noteId: string;
  pick: AnnotatePick;
  /** Where it was picked: the note grows from there. */
  origin: AnnotatePoint;
  text: string;
  /** The person's screenshot toggle (on when the note opens). */
  shot: boolean;
  console: boolean;
  phase: 'editing' | 'sending' | 'adding' | 'unconfirmed';
  failure: string | null;
  /** Names the current submit: an answer to an older one is dropped. */
  attempt: number;
  /** The style view: null until it first opens. */
  style: NoteStyle | null;
}

/** Text or a style changed on the page. */
const written = (note: Note) => note.text.trim() !== '' || changes(note).length > 0;

function useArea(): Size {
  const [area, setArea] = useState<Size>(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  useEffect(() => {
    const resize = () => setArea({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  return area;
}

const sameRect = (a: AnnotateRect | null | undefined, b: AnnotateRect | null | undefined) =>
  a === b ||
  (!!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);

function sameBoxes(
  a: Record<string, AnnotateRect | null>,
  b: Record<string, AnnotateRect | null>,
): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => sameRect(a[key], b[key]));
}

/** The app page's answer as it gave it, or null when it isn't one. */
function outcomeOf(value: unknown): AnnotateOutcome | null {
  if (!value || typeof value !== 'object') return null;
  const outcome = value as { kind?: unknown; reason?: unknown; n?: unknown };
  switch (outcome.kind) {
    case 'accepted':
    case 'unconfirmed':
      return { kind: outcome.kind };
    case 'refused':
      return typeof outcome.reason === 'string'
        ? { kind: 'refused', reason: outcome.reason }
        : null;
    case 'added':
      return typeof outcome.n === 'number' ? { kind: 'added', n: outcome.n } : null;
    case 'not-added':
      return {
        kind: 'not-added',
        reason: typeof outcome.reason === 'string' ? outcome.reason : null,
      };
    default:
      return null;
  }
}

/** A polite live region; the same words twice are said twice. */
function useAnnouncer() {
  const [said, setSaid] = useState({ text: '', n: 0 });
  const announce = useCallback((text: string) => setSaid((last) => ({ text, n: last.n + 1 })), []);
  return { said, announce };
}

export function Overlay({
  bridge,
  frames,
  newId,
  context,
  page,
  busy,
  ending,
  navigation,
  focusRequest,
  onExited,
}: {
  bridge: AnnotateBridge;
  frames: Frames;
  newId: () => string;
  context: AnnotateContext;
  page: { kind: 'page' | 'preview'; generation: number } | null;
  busy: boolean;
  ending: boolean;
  navigation: number;
  focusRequest: number;
  onExited: () => void;
}) {
  const t = useTranslations('Annotate');
  const lost = useTranslations('Refusal')('network');
  const area = useArea();
  const surface = useRef<HTMLElement>(null);
  const { said, announce } = useAnnouncer();
  const [outline, setOutline] = useState<{
    target: AnnotateTarget;
    from: 'pointer' | 'keys';
  } | null>(null);
  const [boxes, setBoxes] = useState<Record<string, AnnotateRect | null>>({});
  const [view, setView] = useState<Size | null>(null);
  const [note, setNoteState] = useState<Note | null>(null);
  const noteRef = useRef<Note | null>(null);
  const setNote = (next: Note | null) => {
    noteRef.current = next;
    setNoteState(next);
  };
  const [collect, setCollect] = useState(context.collect);
  useEffect(() => setCollect(context.collect), [context.collect]);
  const [cardHeight, setCardHeight] = useState(0);
  const [sent, setSent] = useState<AnnotatePoint | null>(null);
  const [leaving, setLeaving] = useState<{
    view: NoteView;
    left: number;
    top: number;
    width: number;
    origin: string;
  } | null>(null);
  const [nudge, setNudge] = useState(0);
  /** The console a send of the open note would carry, read when its label's popover opens. */
  const [carried, setCarried] = useState<{
    noteId: string;
    console: { level: string; message: string }[] | null;
  } | null>(null);
  const busyLine = useRef<HTMLDivElement>(null);
  const [busyRect, setBusyRect] = useState<AnnotateRect | null>(null);
  /** Notes closed while their send was out: the answer is still said when it comes. */
  const orphans = useRef(new Map<string, number>());
  const picking = useRef(false);
  const styleId = useId();
  /** Each property's preview: one in flight at a time, and the newest value waiting behind it. */
  const previewing = useRef(
    new Map<string, { busy: boolean; next: string | null | typeof NONE }>(),
  );
  const busyNow = useRef(busy);
  busyNow.current = busy;
  /** The press began while one of the note's popups was open: it only closes that popup. */
  const closesPopup = useRef(false);
  const lastBox = useRef<AnnotateRect | null>(null);

  const hoverOff = note !== null && (written(note) || note.phase !== 'editing');

  // What the frame loop reads without restarting: the pointer (null outside the page area, stale
  // after a keyboard move until it moves again), the read in flight, and an epoch that a leave, a
  // keyboard move or a navigation bumps so an older answer's hover is dropped.
  const live = useRef({
    pointer: null as AnnotatePoint | null,
    stale: false,
    pending: false,
    epoch: 0,
    stopped: false,
    hoverOff: false,
    track: [] as string[],
  });
  live.current.stopped = busy || ending;
  live.current.hoverOff = hoverOff;
  live.current.track = [
    ...(note ? [note.pick.pickId] : []),
    ...context.markers.map((marker) => marker.pickId).filter((id) => id !== note?.pick.pickId),
  ];

  useEffect(() => {
    const state = live.current;
    let mounted = true;
    const stop = frames(() => {
      if (state.pending || state.stopped || document.hidden) return;
      const pointer = state.pointer && !state.stale && !state.hoverOff ? state.pointer : null;
      const track = state.track;
      if (!pointer && track.length === 0) return;
      state.pending = true;
      const epoch = state.epoch;
      bridge.frame({ pointer, track }).then(
        (answer) => {
          state.pending = false;
          // Null: the read was skipped or the page didn't answer; what is drawn stays.
          if (!mounted || !answer) return;
          if (pointer && epoch === state.epoch && !state.stopped && !state.hoverOff)
            setOutline((last) => {
              const hover = answer.hover;
              if (!hover) return null;
              if (
                last?.from === 'pointer' &&
                last.target.label === hover.label &&
                sameRect(last.target.box, hover.box)
              )
                return last;
              return { target: hover, from: 'pointer' };
            });
          setBoxes((last) => (sameBoxes(last, answer.boxes) ? last : answer.boxes));
          if (answer.view)
            setView((last) =>
              last?.width === answer.view.width && last.height === answer.view.height
                ? last
                : answer.view,
            );
        },
        () => {
          state.pending = false;
        },
      );
    });
    return () => {
      mounted = false;
      stop();
    };
  }, [bridge, frames]);

  const tell = (message: AnnotateMessage) => void bridge.tell(message);
  const focusArea = () => surface.current?.focus();

  // Markers: a pick whose chip went (present, then absent) is let go; one not there yet stays.
  const shown = useRef(new Set<string>());
  useEffect(() => {
    const now = new Set(context.markers.map((marker) => marker.pickId));
    for (const pickId of shown.current)
      if (!now.has(pickId) && pickId !== noteRef.current?.pick.pickId) void bridge.release(pickId);
    shown.current = now;
  }, [bridge, context.markers]);

  // The app page learns whether the open note has something written, for the mode's end.
  const told = useRef<{ noteId: string; written: boolean } | null>(null);
  const isWritten = note ? written(note) : false;
  useEffect(() => {
    if (!note) {
      told.current = null;
      return;
    }
    const last = told.current;
    if (!last || last.noteId !== note.noteId) {
      told.current = { noteId: note.noteId, written: isWritten };
      if (isWritten) tell({ type: 'note-written', noteId: note.noteId, written: true });
    } else if (last.written !== isWritten) {
      told.current = { noteId: note.noteId, written: isWritten };
      tell({ type: 'note-written', noteId: note.noteId, written: isWritten });
    }
  });

  useEffect(() => {
    if (!busy) return;
    live.current.epoch++;
    setOutline(null);
    announce(t('busy'));
  }, [busy, t, announce]);

  useLayoutEffect(() => {
    const line = busyLine.current?.getBoundingClientRect();
    setBusyRect((last) => {
      const next =
        busy && line ? { x: line.x, y: line.y, width: line.width, height: line.height } : null;
      return sameRect(last, next) ? last : next;
    });
  });

  useEffect(() => {
    if (focusRequest === 0) return;
    const text = document.querySelector<HTMLTextAreaElement>('[data-annotate="note"] textarea');
    (text ?? surface.current)?.focus();
  }, [focusRequest]);

  // Whether a press begins while one of the note's popups is open, read before anything hears
  // it: a list closes as the press begins, a popover as it ends.
  useEffect(() => {
    const begin = () => {
      closesPopup.current = document.querySelector(OPEN_POPUP) !== null;
    };
    window.addEventListener('pointerdown', begin, true);
    return () => window.removeEventListener('pointerdown', begin, true);
  }, []);

  // The sent mark goes at the next press, pointer or key.
  useEffect(() => {
    if (!sent) return;
    const dismiss = () => setSent(null);
    window.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('keydown', dismiss, true);
    return () => {
      window.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('keydown', dismiss, true);
    };
  }, [sent]);

  const failureText = (kind: Exclude<AnnotateSubmitResult['kind'], 'answered' | 'cancelled'>) =>
    ({
      'page-changed': t('failed.pageChanged'),
      'not-visible': t('failed.notVisible'),
      'input-fields': t('reason.fields'),
      'image-limit': t('failed.imageLimit'),
      'page-busy': t('busy'),
    })[kind];

  const noteBox = (current: Note) => {
    const tracked = boxes[current.pick.pickId];
    if (tracked) lastBox.current = tracked;
    return tracked ?? lastBox.current ?? current.pick.box;
  };

  const styleOpen = note?.style?.open === true;
  // Narrow, the style view is a sheet along the bottom and the docked note sits on it.
  const sheet = styleOpen ? stylePlace({ x: 0, y: 0, width: 0, height: 0 }, area) : null;
  const place = note
    ? notePlace(
        noteBox(note),
        { width: noteWidth(area.width), height: cardHeight },
        area,
        sheet?.sheet ? sheet.height : 0,
      )
    : null;
  const stylePlaced =
    sheet && place
      ? sheet.sheet
        ? sheet
        : // Clear of the element it changes (its outline), when there is any room for that.
          stylePlace(
            { x: place.x, y: place.y, width: place.width, height: cardHeight },
            area,
            note ? outlineRect(noteBox(note)) : null,
          )
      : null;

  /** The note leaves: its exit plays from a copy unless reduced motion asks for none. */
  const leave = (current: Note, toward: 'origin' | 'sent') => {
    if (!place || reducedMotion()) return;
    setLeaving({
      view: { ...noteView(current), locked: true },
      left: place.x,
      top: place.y,
      width: place.width,
      // Into the sent mark at its top left, or back to where it was picked.
      origin:
        toward === 'sent'
          ? '0 0'
          : `${current.origin.x - place.x}px ${current.origin.y - place.y}px`,
    });
    if (toward === 'sent') setSent({ x: place.x, y: place.y });
  };

  /** Closes the open note; `release` lets main forget its element (not for a collected one). */
  const close = (current: Note, release: boolean) => {
    // Its style view and its popups (the kit's, at the end of the page) are the note's too.
    const hadFocus =
      document.activeElement?.closest(
        '[data-annotate="note"], [data-annotate="style"], [data-slot="popover-popup"], [data-slot="select-popup"]',
      ) !== null;
    if (release) void bridge.release(current.pick.pickId);
    setNote(null);
    lastBox.current = null;
    if (hadFocus || document.activeElement === document.body) focusArea();
  };

  const settle = (noteId: string, attempt: number, result: AnnotateSubmitResult) => {
    const outcome = result.kind === 'answered' ? outcomeOf(result.outcome) : null;
    if (orphans.current.get(noteId) === attempt) {
      orphans.current.delete(noteId);
      if (result.kind === 'cancelled') return;
      if (outcome?.kind === 'accepted') announce(t('announce.sent'));
      else if (outcome?.kind === 'unconfirmed') announce(t('announce.unconfirmed'));
      else {
        const reason =
          outcome?.kind === 'refused'
            ? outcome.reason
            : result.kind === 'answered'
              ? null
              : failureText(result.kind);
        announce(reason ? `${t('announce.notSent')}. ${reason}` : t('announce.notSent'));
      }
      tell({ type: 'note-closed', noteId });
      return;
    }
    const current = noteRef.current;
    if (
      !current ||
      current.noteId !== noteId ||
      current.attempt !== attempt ||
      (current.phase !== 'sending' && current.phase !== 'adding')
    )
      return;
    const editing = (failure: string | null) => setNote({ ...current, phase: 'editing', failure });
    if (result.kind === 'cancelled') return;
    if (result.kind !== 'answered') return editing(failureText(result.kind));
    switch (outcome?.kind) {
      case 'accepted':
        leave(current, 'sent');
        if (reducedMotion() && place) setSent({ x: place.x, y: place.y });
        tell({ type: 'note-closed', noteId });
        close(current, true);
        announce(t('announce.sent'));
        return;
      case 'added':
        leave(current, 'origin');
        tell({ type: 'note-closed', noteId });
        close(current, false);
        announce(t('announce.added', { n: outcome.n }));
        return;
      case 'refused':
        return editing(outcome.reason);
      case 'unconfirmed':
        return setNote({ ...current, phase: 'unconfirmed', failure: null });
      case 'not-added':
        return editing(outcome.reason ?? t('failed.notAdded'));
      default:
        return editing(t('announce.notSent'));
    }
  };

  const shotBlocked = (current: Note): string | null => {
    if (!current.pick.screenshotAllowed) return t('reason.fields');
    if (collect) return context.draft.images >= 3 ? t('reason.images') : null;
    return context.imagesNow ? null : t('reason.newOnly');
  };
  const addBlocked = collect && context.draft.textAttachments >= 5 ? t('reason.attachments') : null;
  const canSubmit = (current: Note) =>
    collect ? written(current) && !addBlocked : current.text.trim() !== '';

  const submit = (via: AnnotateSubmitExtra['via'], again = false) => {
    const current = noteRef.current;
    if (!current) return;
    if (again ? current.phase !== 'unconfirmed' : current.phase !== 'editing') return;
    const intent = again ? 'send' : collect ? 'add' : 'send';
    if (!again && !canSubmit(current)) return;
    const attempt = current.attempt + 1;
    setNote({
      ...current,
      phase: intent === 'add' ? 'adding' : 'sending',
      failure: null,
      attempt,
    });
    const extra: AnnotateSubmitExtra = { via, again };
    bridge
      .submit({
        noteId: current.noteId,
        pickId: current.pick.pickId,
        intent,
        text: current.text,
        styles: changes(current),
        screenshot: current.shot && shotBlocked(current) === null && via !== 'interrupt',
        console: page?.kind === 'preview' && current.console,
        extra,
      })
      .then(
        (result) => settle(current.noteId, attempt, result),
        () => settle(current.noteId, attempt, { kind: 'page-changed' }),
      );
  };

  /** Escape: one level at a time, from the innermost. */
  const closeOne = () => {
    const current = noteRef.current;
    if (!current) {
      void bridge.end();
      return;
    }
    if (current.style?.open) {
      closeStyle(current);
      return;
    }
    if (current.phase === 'sending') return;
    if (current.phase === 'adding') {
      void bridge.cancelSubmit(current.noteId);
      setNote({
        ...current,
        phase: 'editing',
        failure: t('failed.notAdded'),
        attempt: current.attempt + 1,
      });
      return;
    }
    leave(current, 'origin');
    tell({ type: 'note-closed', noteId: current.noteId });
    close(current, true);
  };

  // A navigation closes the note as the spec says; a send still out says its result later. Only a
  // navigation runs this: the note and the helpers are read as they are then.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new navigation is the only trigger.
  useEffect(() => {
    if (navigation === 0) return;
    live.current.epoch++;
    setOutline(null);
    setSent(null);
    const current = noteRef.current;
    if (!current) return;
    switch (current.phase) {
      case 'sending':
        orphans.current.set(current.noteId, current.attempt);
        break;
      case 'unconfirmed':
        announce(t('announce.unconfirmed'));
        tell({ type: 'note-closed', noteId: current.noteId });
        break;
      case 'adding':
        void bridge.cancelSubmit(current.noteId);
        announce(t('announce.discarded'));
        tell({ type: 'note-closed', noteId: current.noteId });
        break;
      default:
        if (written(current)) announce(t('announce.discarded'));
        tell({ type: 'note-closed', noteId: current.noteId });
    }
    close(current, false);
  }, [navigation]);

  const pickAt = (at: AnnotatePoint | 'outline', origin: AnnotatePoint) => {
    if (picking.current) return;
    picking.current = true;
    void bridge.pick(at).then(
      (result) => {
        picking.current = false;
        if (!result.ok) {
          if (result.reason === 'page-busy') setNudge((n) => n + 1);
          return;
        }
        if (noteRef.current || live.current.stopped) {
          void bridge.release(result.pick.pickId);
          return;
        }
        lastBox.current = null;
        setLeaving(null);
        setNote({
          noteId: newId(),
          pick: result.pick,
          origin,
          text: '',
          shot: true,
          console: false,
          phase: 'editing',
          failure: null,
          attempt: 0,
          style: null,
        });
      },
      () => {
        picking.current = false;
      },
    );
  };

  const press = (x: number, y: number) => {
    if (busy) {
      setNudge((n) => n + 1);
      return;
    }
    const current = noteRef.current;
    if (current && (written(current) || current.phase !== 'editing')) return;
    if (picking.current) return;
    if (current) {
      tell({ type: 'note-closed', noteId: current.noteId });
      close(current, true);
    }
    pickAt({ x, y }, { x, y });
  };

  const walk = (direction: 'up' | 'down' | 'left' | 'right') => {
    live.current.stale = true;
    live.current.epoch++;
    void bridge.walk(direction).then((target) => {
      if (!target || live.current.stopped) return;
      setOutline({ target, from: 'keys' });
      announce(target.name ? `${target.label}, ${target.name}` : target.label);
    });
  };

  const noteView = (current: Note): NoteView => {
    const blocked = shotBlocked(current);
    const preview = page?.kind === 'preview';
    return {
      label: current.pick.label,
      style: {
        open: current.style?.open === true,
        id: styleId,
        reading: current.style?.read === 'reading',
      },
      what: {
        page: { origin: current.pick.page.origin, path: current.pick.page.path },
        selector: current.pick.element.selector,
        text: current.pick.element.text,
        styles: changes(current),
        console:
          preview && current.console && carried?.noteId === current.noteId ? carried.console : null,
        // Taken at the send: here, whether it will be.
        screenshot: blocked === null && current.shot ? 'included' : 'none',
      },
      text: current.text,
      locked: current.phase !== 'editing',
      busy: current.phase === 'sending' || current.phase === 'adding',
      intent: collect ? 'add' : 'send',
      canSubmit: canSubmit(current),
      shot: { on: blocked === null && current.shot, blocked },
      console: page?.kind === 'preview' ? current.console : null,
      collect: { on: collect, disabled: current.phase !== 'editing' },
      addBlocked,
      failure:
        current.failure ??
        (current.style && typeof current.style.read === 'object' && 'failed' in current.style.read
          ? current.style.read.failed
          : null),
      unconfirmed: current.phase === 'unconfirmed' ? lost : null,
    };
  };

  /** Opens the style view (reading the element's values the first time) or closes it. */
  const toggleStyle = () => {
    const current = noteRef.current;
    if (!current) return;
    const style = current.style;
    if (style?.read === 'reading') return;
    if (style && typeof style.read === 'object' && 'before' in style.read) {
      setNote({ ...current, style: { ...style, open: !style.open } });
      return;
    }
    const { noteId } = current;
    setNote({ ...current, style: { open: false, read: 'reading', rows: {} } });
    const answered = (
      read: { styles: Record<StyleProperty, string>; tokens: AnnotateTokens } | null,
    ) => {
      const now = noteRef.current;
      if (!now || now.noteId !== noteId || now.style?.read !== 'reading') return;
      setNote({
        ...now,
        style: read
          ? { open: true, read: { before: read.styles, tokens: read.tokens }, rows: {} }
          : {
              open: false,
              // A page that stopped answering says so; otherwise the element went with it.
              read: { failed: busyNow.current ? t('busy') : t('failed.pageChanged') },
              rows: {},
            },
      });
    };
    void bridge.inspect(current.pick.pickId).then(answered, () => answered(null));
  };

  /** Escape in the view or its note: the view goes; what it put on the page stays. */
  const closeStyle = (current: Note) => {
    if (!current.style) return;
    const inView = document.activeElement?.closest('[data-annotate="style"]') !== null;
    setNote({ ...current, style: { ...current.style, open: false } });
    if (inView)
      document
        .querySelector<HTMLElement>('[data-annotate="note"] [data-annotate="style-toggle"]')
        ?.focus();
  };

  const setRow = (property: StyleProperty, change: (row: StyleRow) => StyleRow) => {
    const current = noteRef.current;
    const style = current?.style;
    if (!current || !style || typeof style.read !== 'object' || !('before' in style.read)) return;
    const row = style.rows[property] ?? {
      value: style.read.before[property],
      applied: null,
      problem: null,
    };
    setNote({ ...current, style: { ...style, rows: { ...style.rows, [property]: change(row) } } });
  };

  /** Sends the newest value waiting for a property once the one before it has answered. */
  const pump = (noteId: string, pickId: string, property: StyleProperty) => {
    const slot = previewing.current.get(`${noteId} ${property}`);
    if (!slot || slot.busy || slot.next === NONE) return;
    const value = slot.next;
    slot.next = NONE;
    slot.busy = true;
    const answered = (
      result: { ok: true } | { ok: false; reason: 'invalid' | 'page-changed' | 'page-busy' },
    ) => {
      slot.busy = false;
      // A closed note's previews went with it.
      if (noteRef.current?.noteId !== noteId) return;
      const newer = slot.next !== NONE;
      setRow(property, (row) =>
        result.ok
          ? { ...row, applied: value, problem: newer ? row.problem : null }
          : // Main keeps what it put on the page before; the row says why this one isn't there.
            { ...row, problem: newer ? row.problem : result.reason },
      );
      pump(noteId, pickId, property);
    };
    void bridge
      .preview(pickId, property, value)
      .then(answered, () => answered({ ok: false, reason: 'page-changed' }));
  };

  /** A row's new value: shown on the page at once; the first value again takes Corral's rule off. */
  const restyle = (property: StyleProperty, value: string) => {
    const current = noteRef.current;
    const read = current?.style?.read;
    if (current?.phase !== 'editing' || !read || typeof read !== 'object') return;
    if (!('before' in read)) return;
    setRow(property, (row) => ({ ...row, value, problem: null }));
    const key = `${current.noteId} ${property}`;
    const slot = previewing.current.get(key) ?? { busy: false, next: NONE };
    previewing.current.set(key, slot);
    slot.next = value === read.before[property] ? null : value;
    pump(current.noteId, current.pick.pickId, property);
  };

  const styleRows = (current: Note): Record<StyleProperty, StyleRowView> | null => {
    const read = current.style?.read;
    if (!read || typeof read !== 'object' || !('before' in read)) return null;
    const problems = {
      invalid: t('styleView.invalid'),
      'page-changed': t('failed.pageChanged'),
      'page-busy': t('busy'),
    };
    const rows = {} as Record<StyleProperty, StyleRowView>;
    for (const property of PROPERTIES) {
      const row = current.style?.rows[property];
      const value = row?.value ?? read.before[property];
      rows[property] = {
        value,
        touched: value !== read.before[property] || (row?.applied ?? null) !== null,
        problem: row?.problem ? problems[row.problem] : null,
      };
    }
    return rows;
  };

  /** What a send would carry of the console, read as the label's popover opens. */
  const readCarried = (open: boolean) => {
    const current = noteRef.current;
    if (!open || !current || page?.kind !== 'preview' || !current.console) return;
    const { noteId } = current;
    void bridge.consoleFor(current.pick.pickId).then(
      (console) => {
        if (noteRef.current?.noteId === noteId) setCarried({ noteId, console });
      },
      () => {},
    );
  };

  // The kit's popups keep their own Escape (it closes only the popup and goes no further).
  const onNoteKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    closeOne();
  };

  const onTextKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    const role = sendKeyRole(event, context.sendKey);
    if (!role) return;
    event.preventDefault();
    if (collect) {
      if (role === 'send') submit('send');
      return;
    }
    submit(role);
  };

  const markers = useMemo(() => {
    const bounds = view
      ? { width: Math.min(area.width, view.width), height: Math.min(area.height, view.height) }
      : area;
    return markerPlaces(
      context.markers.flatMap(({ pickId, n }) => {
        const box = boxes[pickId];
        return box ? [{ pickId, n, box }] : [];
      }),
      bounds,
      busyRect,
    );
  }, [context.markers, boxes, area, view, busyRect]);

  const picked = note ? outlineRect(noteBox(note)) : null;

  return (
    <div className="fixed inset-0 overflow-hidden">
      <section
        ref={surface}
        data-annotate="surface"
        aria-label={t('area')}
        tabIndex={-1}
        className="absolute inset-0 outline-none"
        onPointerMove={(event) => {
          live.current.pointer = { x: event.clientX, y: event.clientY };
          live.current.stale = false;
        }}
        onPointerLeave={() => {
          live.current.pointer = null;
          live.current.epoch++;
          setOutline((last) => (last?.from === 'pointer' ? null : last));
        }}
        onClick={(event) => {
          if (closesPopup.current) {
            closesPopup.current = false;
            return;
          }
          if (event.button !== 0 || ending) return;
          live.current.pointer = { x: event.clientX, y: event.clientY };
          live.current.stale = false;
          press(event.clientX, event.clientY);
        }}
        onWheel={(event) => {
          bridge.wheel({
            x: event.clientX,
            y: event.clientY,
            deltaX: event.deltaX,
            deltaY: event.deltaY,
            deltaMode: event.deltaMode as 0 | 1 | 2,
          });
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || ending) return;
          const direction = ARROWS[event.key as keyof typeof ARROWS];
          if (direction && !event.altKey && !event.ctrlKey && !event.metaKey) {
            event.preventDefault();
            if (!noteRef.current) walk(direction);
          } else if (event.key === 'Enter' && !noteRef.current && outline?.from === 'keys') {
            event.preventDefault();
            const box = outline.target.box;
            pickAt('outline', { x: box.x + box.width / 2, y: box.y + box.height / 2 });
          } else if (event.key === 'Escape' && !event.shiftKey) {
            event.preventDefault();
            closeOne();
          }
        }}
      />
      <PageFrame area={area} ending={ending} onExited={onExited} />
      {picked && !ending && (
        <div
          data-annotate="picked"
          style={{
            transform: `translate(${picked.x}px, ${picked.y}px)`,
            width: `${picked.width}px`,
            height: `${picked.height}px`,
          }}
          className={`pointer-events-none absolute left-0 top-0 border-2 border-emphasis ${RING} forced-colors:border-[Highlight]`}
        />
      )}
      {outline && !busy && !ending && !hoverOff && <Outline target={outline.target} area={area} />}
      {!ending && (
        <div aria-hidden="true" className="pointer-events-none absolute inset-0">
          {markers.map((marker) => (
            <span
              key={marker.pickId}
              data-annotate="marker"
              style={{ transform: `translate(${marker.x}px, ${marker.y}px)` }}
              className="absolute left-0 top-0"
            >
              <span className="annotate-pop flex size-[18px] items-center justify-center rounded-full bg-emphasis font-mono text-micro tabular-nums text-background ring-1 ring-background forced-colors:bg-[Highlight] forced-colors:text-[HighlightText]">
                {marker.n}
              </span>
            </span>
          ))}
        </div>
      )}
      {busy && !ending && (
        <div
          ref={busyLine}
          data-annotate="busy"
          className="pointer-events-none absolute left-1/2 top-2 max-w-[calc(100%-16px)] -translate-x-1/2"
        >
          <Elevated
            key={nudge}
            offset={2}
            className={`flex items-center gap-2 rounded-xl px-3 py-1.5 text-body text-foreground ${nudge ? 'annotate-nudge' : ''}`}
          >
            <TriangleAlert className="size-4 shrink-0 text-warning" aria-hidden="true" />
            <span className="truncate">{t('busy')}</span>
          </Elevated>
        </div>
      )}
      {leaving && (
        <NoteCard
          ghost
          view={leaving.view}
          actions={IDLE}
          style={{
            left: `${leaving.left}px`,
            top: `${leaving.top}px`,
            width: `${leaving.width}px`,
            transformOrigin: leaving.origin,
          }}
          onAnimationEnd={() => setLeaving(null)}
        />
      )}
      {note && place && !ending && (
        <NoteCard
          key={note.noteId}
          view={noteView(note)}
          style={{
            left: `${place.x}px`,
            top: `${place.y}px`,
            width: `${place.width}px`,
            transformOrigin: `${note.origin.x - place.x}px ${note.origin.y - place.y}px`,
          }}
          onKeyDown={onNoteKey}
          actions={{
            onWhat: readCarried,
            onText: (text) => {
              const current = noteRef.current;
              if (current && current.phase === 'editing')
                setNote({ ...current, text: text.slice(0, 4000) });
            },
            onTextKey,
            onShot: () => {
              const current = noteRef.current;
              if (current) setNote({ ...current, shot: !current.shot });
            },
            onConsole: () => {
              const current = noteRef.current;
              if (current) setNote({ ...current, console: !current.console });
            },
            onCollect: () => {
              setCollect(!collect);
              tell({ type: 'collect', on: !collect });
            },
            onSubmit: () => submit('button'),
            onSendAgain: () => submit('button', true),
            onHeight: setCardHeight,
            onStyle: toggleStyle,
          }}
        />
      )}
      {note &&
        stylePlaced &&
        !ending &&
        note.style &&
        typeof note.style.read === 'object' &&
        'before' in note.style.read && (
          <StyleView
            key={`style ${note.noteId}`}
            id={styleId}
            label={note.pick.label}
            place={stylePlaced}
            tokens={note.style.read.tokens}
            rows={styleRows(note) as Record<StyleProperty, StyleRowView>}
            locked={note.phase !== 'editing'}
            onChange={restyle}
            onReset={(property) => {
              const read = noteRef.current?.style?.read;
              if (read && typeof read === 'object' && 'before' in read)
                restyle(property, read.before[property]);
            }}
            onResetAll={() => {
              const current = noteRef.current;
              const rows = current ? styleRows(current) : null;
              const read = current?.style?.read;
              if (!rows || !read || typeof read !== 'object' || !('before' in read)) return;
              for (const property of PROPERTIES)
                if (rows[property].touched) restyle(property, read.before[property]);
            }}
            onClose={() => {
              const current = noteRef.current;
              if (current) closeStyle(current);
            }}
          />
        )}
      {sent && !ending && (
        <div
          data-annotate="sent"
          style={{ transform: `translate(${sent.x}px, ${sent.y}px)` }}
          className="pointer-events-none absolute left-0 top-0"
        >
          <Elevated
            offset={2}
            className="annotate-pop flex items-center gap-1.5 rounded-xl px-2.5 py-1 text-caption text-foreground"
          >
            <Check className="size-3.5 text-success" aria-hidden="true" />
            {t('sentMark')}
          </Elevated>
        </div>
      )}
      <div data-annotate="announcer" role="status" aria-live="polite" className="sr-only">
        <span key={said.n}>{said.text}</span>
      </div>
    </div>
  );
}

const IDLE = {
  onWhat() {},
  onStyle() {},
  onText() {},
  onTextKey() {},
  onShot() {},
  onConsole() {},
  onCollect() {},
  onSubmit() {},
  onSendAgain() {},
  onHeight() {},
};

/** The page area's frame: drawn once around from the top right corner, faded on the way out. */
function PageFrame({
  area,
  ending,
  onExited,
}: {
  area: Size;
  ending: boolean;
  onExited: () => void;
}) {
  const frame = useRef<SVGSVGElement>(null);
  const exited = useRef(onExited);
  exited.current = onExited;
  useEffect(() => {
    const element = frame.current;
    if (!element || !ending) return;
    const done = (event: Event) => {
      if (event.target === element) exited.current();
    };
    element.addEventListener('animationend', done);
    return () => element.removeEventListener('animationend', done);
  }, [ending]);
  if (ending && reducedMotion()) return null;
  const path = framePath(area);
  return (
    <svg
      ref={frame}
      data-annotate="frame"
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 size-full${ending ? ' annotate-leave' : ''}`}
    >
      {/* The ring inside the line keeps it visible over a page of the same colour. */}
      <path
        d={path}
        pathLength={1}
        fill="none"
        strokeWidth={4}
        className="annotate-draw stroke-background forced-colors:hidden"
      />
      <path
        d={path}
        pathLength={1}
        fill="none"
        strokeWidth={2}
        className="annotate-draw stroke-emphasis forced-colors:stroke-[Highlight]"
      />
    </svg>
  );
}

/** The outline 3px outside the element's border box, and its name tag. */
function Outline({ target, area }: { target: AnnotateTarget; area: Size }) {
  const rect = outlineRect(target.box);
  const tag = useRef<HTMLSpanElement>(null);
  const [tagSize, setTagSize] = useState<Size>({ width: 0, height: 18 });
  useLayoutEffect(() => {
    const box = tag.current?.getBoundingClientRect();
    if (box && (box.width !== tagSize.width || (box.height && box.height !== tagSize.height)))
      setTagSize({ width: box.width, height: box.height || tagSize.height });
  });
  const place = tagPlace(rect, tagSize, area);
  return (
    <>
      <div
        data-annotate="outline"
        style={{
          transform: `translate(${rect.x}px, ${rect.y}px)`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
        }}
        className={`pointer-events-none absolute left-0 top-0 border-2 border-emphasis ${RING} transition-[transform,width,height] duration-(--duration-moderate) ease-(--ease-out-soft) motion-reduce:transition-none forced-colors:border-[Highlight]`}
      />
      <span
        ref={tag}
        data-annotate="tag"
        style={{ transform: `translate(${place.x}px, ${place.y}px)` }}
        className="pointer-events-none absolute left-0 top-0 whitespace-nowrap rounded-sm bg-emphasis px-1.5 py-0.5 font-mono text-micro text-background ring-1 ring-background transition-transform duration-(--duration-moderate) ease-(--ease-out-soft) motion-reduce:transition-none forced-colors:border forced-colors:border-[CanvasText] forced-colors:bg-[Canvas] forced-colors:text-[CanvasText]"
      >
        {target.label}
      </span>
    </>
  );
}
