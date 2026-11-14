const MESSAGES = {
  installing: 'an install is in progress',
  judging: 'a judgment is running',
  computing: 'a computation is in progress',
} as const;

export type BundleBusyReason = keyof typeof MESSAGES;

/** Removal was refused because this bundle is installing or in the middle of work. */
export class BundleBusyError extends Error {
  readonly reason: BundleBusyReason;

  constructor(reason: BundleBusyReason) {
    super(MESSAGES[reason]);
    this.name = 'BundleBusyError';
    this.reason = reason;
  }
}
