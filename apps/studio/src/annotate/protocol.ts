// What the annotation overlay (apps/studio/annotate.html, features/browser-annotate.md) and the
// app page say to each other. The desktop passes all of it through unread: the context by
// `annotateContext`, a submit's `extra`, the answer by `answerAnnotate`, a message by `tell`
// (apps/desktop/src/annotate-bridge.ts, browser-bridge.ts). Types only: both sides import them.

/**
 * The app page's context for the overlay, whole each time it changes (`annotateContext`). The
 * overlay has no app storage of its own, so it draws nothing until the first one arrives.
 */
export interface AnnotateContext {
  locale: 'en' | 'ko';
  /** The appearance on the app's root: its darkness and a named theme's tokens (none: default). */
  theme: { dark: boolean; tokens: Record<string, string> | null };
  density: 'default' | 'compact';
  /** The composer's send key setting (composer-flow.md 전송). */
  sendKey: 'enter' | 'mod-enter';
  /** "모아 두기", remembered on this device by the app page. */
  collect: boolean;
  /** What the composer's draft holds now, against its limits (5 text attachments, 3 images). */
  draft: { textAttachments: number; images: number };
  /**
   * Whether a note sent now takes an image: false while sending now would join or interrupt a
   * run ("새 요청에만 적용"). Collect on: whether the draft's next request would.
   */
  imagesNow: boolean;
  /** The collected notes in the composer's chips, by pick: their markers and kept previews. */
  markers: { pickId: string; n: number }[];
}

/** A submit's `extra`: how it was asked for. */
export interface AnnotateSubmitExtra {
  /** The key that sent it (composer-flow.md's three), or the button. */
  via: 'send' | 'interrupt' | 'queue' | 'button';
  /** "다시 보내기": the same command again, with the ID the app page kept for this note. */
  again: boolean;
}

/** The app page's answer to a submit (`answerAnnotate`'s outcome). */
export type AnnotateOutcome =
  /** Sent and accepted ("보냄"). */
  | { kind: 'accepted' }
  /** Refused: the composer's sentence for why, in the context's locale. The command is over. */
  | { kind: 'refused'; reason: string }
  /** The answer was lost: the app page keeps the command ID while the note stays open. */
  | { kind: 'unconfirmed' }
  /** Collected as chip `n`. */
  | { kind: 'added'; n: number }
  /** Not collected: the composer's sentence, or null for "주석을 담지 못했습니다". */
  | { kind: 'not-added'; reason: string | null };

/** The overlay's messages to the app page (`tell`). */
export type AnnotateMessage =
  /** The collect switch changed: the app page remembers it and sends a new context. */
  | { type: 'collect'; on: boolean }
  /**
   * A note closed (sent, discarded, its page gone): the app page forgets its command ID. After
   * the mode ends the app page says a send's result itself (바로 보내기).
   */
  | { type: 'note-closed'; noteId: string };
