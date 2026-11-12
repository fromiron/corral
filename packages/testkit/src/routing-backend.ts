import type {
  DecisionCancellation,
  EffortQuestion,
  RouterRequest,
  RouterResponse,
  RoutingBackend,
  RoutingFallbackReason,
  RoutingFlight,
  RoutingLease,
  SettledBasis,
} from '@corral/contracts';

/** One engine call the test answers by hand. */
export interface FakeFlight {
  request: RouterRequest;
  respond(response?: Partial<RouterResponse>): void;
  fail(reason: RoutingFallbackReason): void;
  settle(basis?: SettledBasis): void;
}

export interface FakeRoutingOptions {
  kind?: 'local' | 'api';
  identity?: string;
  /** Refuses every admission with this reason. */
  refuse?: RoutingFallbackReason;
  /** Answers each call at once; `hold` leaves it to the test. */
  answer?: 'hold' | ((request: RouterRequest) => Partial<RouterResponse>);
  /** State units of a text: UTF-8 bytes for an API frame, a rough token count for d1. */
  units?: (text: string) => number;
  /** Delays every count until the test calls `releaseCounts()`. */
  holdCounts?: boolean;
  now?: () => number;
  /** What a Local lease reports as the device that actually ran. */
  device?: string;
}

/** UTF-8 length without platform encoders (core tests have no DOM or Node types). */
export function utf8Length(text: string): number {
  let total = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    total += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return total;
}
const utf8 = utf8Length;

/**
 * A routing engine for tests: one lease at a time, no queue, counts in bytes (or a given unit),
 * and answers either at once or when the test says so.
 */
export class FakeRoutingBackend implements RoutingBackend {
  readonly kind: 'local' | 'api';
  admits = 0;
  refusals = 0;
  countCalls = 0;
  releases = 0;
  readonly requests: RouterRequest[] = [];
  readonly flights: FakeFlight[] = [];
  private leased = false;
  private heldCounts: (() => void)[] = [];
  private currentIdentity: string;
  private readonly options: FakeRoutingOptions;

  constructor(options: FakeRoutingOptions = {}) {
    this.options = options;
    this.kind = options.kind ?? 'local';
    this.currentIdentity = options.identity ?? `fake-${this.kind}-1`;
  }

  identity(): string | null {
    return this.currentIdentity;
  }

  /** A different engine instance from now on (a restart, a new model). */
  replaceIdentity(identity: string) {
    this.currentIdentity = identity;
  }

  get busy() {
    return this.leased;
  }

  releaseCounts() {
    const held = this.heldCounts;
    this.heldCounts = [];
    for (const go of held) go();
  }

  admit(): { ok: true; lease: RoutingLease } | { ok: false; reason: RoutingFallbackReason } {
    if (this.options.refuse) {
      this.refusals++;
      return { ok: false, reason: this.options.refuse };
    }
    if (this.leased) {
      this.refusals++;
      return { ok: false, reason: 'busy' };
    }
    this.admits++;
    this.leased = true;
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      this.leased = false;
      this.releases++;
    };
    // A d1 frame counts tokens; about four bytes each stands in for the tokenizer.
    const units =
      this.options.units ??
      (this.kind === 'local' ? (text: string) => Math.ceil(utf8(text) / 4) : utf8);
    const count = (value: number, signal: DecisionCancellation) => {
      this.countCalls++;
      if (!this.options.holdCounts) return Promise.resolve(value);
      return new Promise<number>((resolve, reject) => {
        const off = signal.onCancel(() => reject(new Error('count cancelled')));
        this.heldCounts.push(() => {
          off();
          resolve(value);
        });
      });
    };
    const identity = this.currentIdentity;
    const lease: RoutingLease = {
      identity,
      frame: this.kind === 'local' ? 'd1-exact' : 'api-bounded',
      device:
        this.kind === 'local'
          ? { actual: this.options.device ?? 'cpu', host: 'test-host', threads: 4 }
          : null,
      countState: (text, signal) => count(units(text), signal),
      countInput: (state: string, question: EffortQuestion, signal) =>
        count(
          this.kind === 'local'
            ? units(state) + units(JSON.stringify(question))
            : utf8(JSON.stringify({ state, questions: { effort: question } })),
          signal,
        ),
      start: (request) => this.start(request, end),
      release: end,
    };
    return { ok: true, lease };
  }

  private start(request: RouterRequest, end: () => void): RoutingFlight {
    this.requests.push(request);
    let respond!: (response: RouterResponse) => void;
    let reject!: (error: unknown) => void;
    let settle!: (value: { basis: SettledBasis; finishedAtMs: number }) => void;
    const result = new Promise<RouterResponse>((res, rej) => {
      respond = res;
      reject = rej;
    });
    const settled = new Promise<{ basis: SettledBasis; finishedAtMs: number }>((res) => {
      settle = res;
    });
    const basis: SettledBasis =
      this.kind === 'local' ? 'native-response-complete' : 'remote-transport-closed';
    const full = (partial: Partial<RouterResponse> = {}): RouterResponse => {
      const choice = partial.choice ?? request.candidates[1] ?? request.candidates[0]!;
      const others = request.candidates.filter((level) => level !== choice);
      return {
        choice,
        probabilities: Object.fromEntries([
          [choice, 0.7],
          ...others.map((level) => [level, 0.3 / others.length]),
        ]),
        inputTokens: this.kind === 'local' ? request.inputUnits : null,
        billableUnits: null,
        ...partial,
      };
    };
    const flight: FakeFlight = {
      request,
      respond: (partial) => respond(full(partial)),
      fail: (reason) => reject(Object.assign(new Error(reason), { reason })),
      settle: (kind = basis) => {
        end();
        settle({ basis: kind, finishedAtMs: this.options.now?.() ?? 0 });
      },
    };
    this.flights.push(flight);
    if (this.options.answer !== 'hold') {
      flight.respond(this.options.answer?.(request));
      flight.settle();
    }
    return { result, settled };
  }
}
