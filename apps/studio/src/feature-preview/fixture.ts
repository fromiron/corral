import type {
  AgentStatus,
  AgentTaskFileChange,
  AgentTaskStatus,
  AgentTaskStepState,
  DiffFile,
  FindingSeverity,
} from '@corral/react/design-kit';

// The one sample set every feature preview draws (docs/specs/features/feature-preview.md): one
// fictional project, its sessions, runs and files, seen at one fixed moment. Nothing here comes
// from or goes to a real project. Words a person or agent wrote follow the interface language;
// code, paths and the sample site's own text stay as written.

/** Text a person or an agent wrote, in each catalog language. */
export interface SampleText {
  readonly en: string;
  readonly ko: string;
}

/** The fixed moment the previews are drawn at; every sample time is relative to it. */
export const PREVIEW_NOW = Date.UTC(2026, 0, 15, 9, 30);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const ago = (minutes: number) => PREVIEW_NOW - minutes * MINUTE;

export const SAMPLE_PROJECT = { name: 'example-shop', repo: 'example/shop', base: 'main' } as const;
export const SAMPLE_MODEL = 'Sample model';

export const SAMPLE_SESSIONS = {
  total: { title: { en: 'Fix the checkout total', ko: '결제 합계 고치기' } },
  cart: { title: { en: 'Empty cart message', ko: '빈 장바구니 안내' } },
} as const satisfies Record<string, { title: SampleText }>;
export type SampleSessionKey = keyof typeof SAMPLE_SESSIONS;

/** A session and the run in it that did the work. */
export interface SampleRun {
  readonly session: SampleSessionKey;
  readonly run: number;
}

export const SAMPLE_FILES = {
  total: 'src/checkout/total.ts',
  totalTest: 'src/checkout/total.test.ts',
  summary: 'src/checkout/OrderSummary.tsx',
  coupon: 'src/checkout/CouponField.tsx',
  emptyCart: 'src/cart/EmptyCart.tsx',
  badge: 'src/cart/CartBadge.tsx',
  itemCount: 'src/cart/ItemCountBadge.tsx',
} as const;

// ─── Task board ──────────────────────────────────────────────────────────────

const TITLES = {
  total: { en: 'Round the checkout total to cents', ko: '결제 합계를 센트 단위로 반올림' },
  coupon: { en: 'Keep focus on the coupon field', ko: '쿠폰 입력란의 포커스 유지' },
  badge: { en: 'Rename the cart badge component', ko: '장바구니 배지 컴포넌트 이름 바꾸기' },
} as const satisfies Record<string, SampleText>;

export interface SampleTask {
  readonly id: string;
  readonly title: SampleText;
  readonly status: AgentTaskStatus;
  readonly branch: string;
  readonly linked?: SampleRun;
  /** Live tasks: when the run started. */
  readonly startedAt?: number;
  /** Finished tasks: how long the run took. */
  readonly durationMs?: number;
  readonly error?: SampleText;
  readonly checks?: 'passed' | 'failed';
  /** The sample pull request opened from this task. */
  readonly pullRequest?: number;
  readonly steps: readonly {
    readonly text: SampleText;
    readonly state: AgentTaskStepState;
    readonly durationMs?: number;
    readonly startedAt?: number;
    readonly note?: string;
  }[];
  readonly files: readonly {
    readonly path: string;
    readonly change: AgentTaskFileChange;
    readonly additions: number;
    readonly deletions: number;
  }[];
}

export const SAMPLE_TASKS: readonly SampleTask[] = [
  {
    id: 'task-total',
    title: TITLES.total,
    status: 'ready',
    branch: 'example/round-total',
    linked: { session: 'total', run: 3 },
    durationMs: 6 * MINUTE + 12 * SECOND,
    checks: 'failed',
    pullRequest: 12,
    steps: [
      {
        text: { en: `Read ${SAMPLE_FILES.total}`, ko: `${SAMPLE_FILES.total} 읽기` },
        state: 'done',
        durationMs: 4 * SECOND,
      },
      {
        text: { en: 'Added a test for a half-cent total', ko: '반 센트 합계 테스트 추가' },
        state: 'done',
        durationMs: 48 * SECOND,
      },
      {
        text: { en: 'Rounded once, after the discount', ko: '할인 뒤에 한 번만 반올림' },
        state: 'done',
        durationMs: 95 * SECOND,
      },
      {
        text: { en: 'Ran the tests: 23 of 24 passed', ko: '테스트 실행: 24개 중 23개 통과' },
        state: 'done',
        durationMs: 31 * SECOND,
        note: 'total.test.ts › rounds a 10% coupon on 19.95',
      },
    ],
    files: [
      { path: SAMPLE_FILES.total, change: 'modified', additions: 2, deletions: 2 },
      { path: SAMPLE_FILES.totalTest, change: 'added', additions: 8, deletions: 0 },
    ],
  },
  {
    id: 'task-cart',
    title: { en: 'Show a message for an empty cart', ko: '빈 장바구니에 안내 문구 보이기' },
    status: 'running',
    branch: 'example/empty-cart',
    linked: { session: 'cart', run: 1 },
    startedAt: ago(4),
    steps: [
      {
        text: { en: 'Found the cart page', ko: '장바구니 화면 찾기' },
        state: 'done',
        durationMs: 6 * SECOND,
      },
      {
        text: {
          en: 'Added EmptyCart with a link back to the shop',
          ko: '상점으로 돌아가는 링크가 있는 EmptyCart 추가',
        },
        state: 'done',
        durationMs: 72 * SECOND,
      },
      {
        text: { en: 'Running the cart tests', ko: '장바구니 테스트 실행 중' },
        state: 'active',
        startedAt: ago(1),
      },
    ],
    files: [{ path: SAMPLE_FILES.emptyCart, change: 'added', additions: 31, deletions: 0 }],
  },
  {
    id: 'task-summary',
    title: { en: 'Tidy the order summary layout', ko: '주문 요약 배치 정리' },
    status: 'queued',
    branch: 'example/order-summary',
    steps: [],
    files: [],
  },
  {
    id: 'task-coupon',
    title: TITLES.coupon,
    status: 'ready',
    branch: 'example/coupon-focus',
    linked: { session: 'total', run: 2 },
    durationMs: 3 * MINUTE + 40 * SECOND,
    checks: 'passed',
    pullRequest: 11,
    steps: [
      {
        text: { en: 'Kept focus after Apply', ko: '적용 뒤에도 포커스 유지' },
        state: 'done',
        durationMs: 64 * SECOND,
      },
      {
        text: { en: 'Ran the tests: 24 passed', ko: '테스트 실행: 24개 통과' },
        state: 'done',
        durationMs: 29 * SECOND,
      },
    ],
    files: [{ path: SAMPLE_FILES.coupon, change: 'modified', additions: 2, deletions: 0 }],
  },
  {
    id: 'task-shipping',
    title: { en: 'Show shipping in the order summary', ko: '주문 요약에 배송비 보이기' },
    status: 'failed',
    branch: 'example/summary-shipping',
    linked: { session: 'cart', run: 2 },
    durationMs: 2 * MINUTE + 18 * SECOND,
    error: { en: 'The type check failed', ko: '타입 검사 실패' },
    checks: 'failed',
    steps: [
      {
        text: { en: 'Added a shipping row', ko: '배송비 행 추가' },
        state: 'done',
        durationMs: 51 * SECOND,
      },
      {
        text: { en: 'Ran the type check', ko: '타입 검사 실행' },
        state: 'failed',
        durationMs: 12 * SECOND,
        note: "OrderSummary.tsx:41 · Property 'shipping' does not exist on type 'Totals'",
      },
    ],
    files: [{ path: SAMPLE_FILES.summary, change: 'modified', additions: 6, deletions: 0 }],
  },
  {
    id: 'task-badge',
    title: TITLES.badge,
    status: 'merged',
    branch: 'example/cart-badge',
    linked: { session: 'total', run: 1 },
    durationMs: 2 * MINUTE + 5 * SECOND,
    checks: 'passed',
    pullRequest: 10,
    steps: [
      {
        text: {
          en: 'Renamed CartBadge to ItemCountBadge',
          ko: 'CartBadge 이름을 ItemCountBadge로 변경',
        },
        state: 'done',
        durationMs: 38 * SECOND,
      },
    ],
    files: [{ path: SAMPLE_FILES.itemCount, change: 'renamed', additions: 1, deletions: 1 }],
  },
];

// ─── Pull requests ───────────────────────────────────────────────────────────

export interface SampleCheck {
  readonly id: string;
  readonly name: SampleText;
  readonly status: AgentStatus;
  readonly done: number;
  readonly total: number;
  readonly step?: SampleText;
}

export interface SampleFinding {
  readonly id: string;
  readonly severity: FindingSeverity;
  readonly title: SampleText;
  /** The check that reported it. */
  readonly check: string;
  readonly location?: string;
  readonly at: number;
}

export interface SampleComment {
  readonly id: string;
  readonly author: string;
  readonly body: SampleText;
  readonly location?: string;
  readonly at: number;
}

export interface SamplePull {
  readonly number: number;
  readonly title: SampleText;
  readonly description: SampleText;
  readonly branch: string;
  readonly state: 'open' | 'merged';
  readonly task: string;
  readonly linked: SampleRun;
  readonly files: DiffFile[];
  readonly checks: readonly SampleCheck[];
  readonly findings: readonly SampleFinding[];
  readonly comments: readonly SampleComment[];
}

const REVIEWER = 'review-agent';

export const SAMPLE_PULLS: readonly SamplePull[] = [
  {
    number: 12,
    title: TITLES.total,
    description: {
      en: 'Rounds the total once, after the coupon, so a 10% coupon on 19.95 comes to 17.96.',
      ko: '쿠폰을 뺀 뒤 합계를 한 번만 반올림해 19.95에 10% 쿠폰을 쓰면 17.96이 됩니다.',
    },
    branch: 'example/round-total',
    state: 'open',
    task: 'task-total',
    linked: { session: 'total', run: 3 },
    files: [
      {
        path: SAMPLE_FILES.total,
        hunks: [
          {
            header: '@@ -14,6 +14,6 @@ export function checkoutTotal',
            lines: [
              {
                type: 'ctx',
                n: 14,
                text: 'export function checkoutTotal(cart: Cart, coupon?: Coupon): Money {',
              },
              { type: 'ctx', n: 15, text: '  const subtotal = sum(cart.lines.map(lineTotal));' },
              { type: 'ctx', n: 16, text: '' },
              {
                type: 'del',
                n: 17,
                text: '  const discount = coupon ? roundCents(subtotal * coupon.rate) : 0;',
              },
              { type: 'del', n: 18, text: '  return roundCents(subtotal) - discount;' },
              {
                type: 'add',
                n: 17,
                text: '  const discount = coupon ? subtotal * coupon.rate : 0;',
              },
              { type: 'add', n: 18, text: '  return roundCents(subtotal - discount);' },
              { type: 'ctx', n: 19, text: '}' },
            ],
          },
        ],
      },
      {
        path: SAMPLE_FILES.totalTest,
        change: 'added',
        hunks: [
          {
            lines: [
              { type: 'add', n: 1, text: "import { checkoutTotal } from './total.ts';" },
              { type: 'add', n: 2, text: "import { cart, cents, coupon } from './samples.ts';" },
              { type: 'add', n: 3, text: '' },
              { type: 'add', n: 4, text: "it('rounds a 10% coupon on 19.95 once', () => {" },
              {
                type: 'add',
                n: 5,
                text: '  expect(checkoutTotal(cart(19.95), coupon(0.1))).toEqual(cents(1796));',
              },
              { type: 'add', n: 6, text: '});' },
              { type: 'add', n: 7, text: '' },
              {
                type: 'add',
                n: 8,
                text: "it('keeps an empty cart at zero', () => expect(checkoutTotal(cart())).toEqual(cents(0)));",
              },
            ],
          },
        ],
      },
    ],
    checks: [
      {
        id: 'types',
        name: { en: 'Type check', ko: '타입 검사' },
        status: 'done',
        done: 1,
        total: 1,
      },
      {
        id: 'tests',
        name: { en: 'Unit tests', ko: '단위 테스트' },
        status: 'failed',
        done: 1,
        total: 1,
        step: { en: '23 of 24 passed', ko: '24개 중 23개 통과' },
      },
      {
        id: 'lint',
        name: { en: 'Lint', ko: '린트' },
        status: 'done',
        done: 1,
        total: 1,
      },
    ],
    findings: [
      {
        id: 'f-empty',
        severity: 'critical',
        title: { en: 'An empty cart has no total', ko: '빈 장바구니에 합계가 없음' },
        check: 'tests',
        location: 'total.ts:15',
        at: ago(3),
      },
      {
        id: 'f-summary',
        severity: 'warning',
        title: {
          en: 'The order summary still rounds on its own',
          ko: '주문 요약이 아직 따로 반올림함',
        },
        check: 'lint',
        location: 'OrderSummary.tsx:41',
        at: ago(5),
      },
    ],
    comments: [
      {
        id: 'c-12-1',
        author: REVIEWER,
        body: {
          en: 'The rounding is right now. An empty cart still reads cart.lines before checking it.',
          ko: '반올림은 맞습니다. 빈 장바구니는 아직 확인 전에 cart.lines를 읽습니다.',
        },
        location: 'total.ts:15',
        at: ago(4),
      },
    ],
  },
  {
    number: 11,
    title: TITLES.coupon,
    description: {
      en: 'Applying a coupon keeps focus on the field, so a second code can be typed at once.',
      ko: '쿠폰을 적용한 뒤에도 입력란에 포커스가 남아 다른 코드를 바로 입력할 수 있습니다.',
    },
    branch: 'example/coupon-focus',
    state: 'open',
    task: 'task-coupon',
    linked: { session: 'total', run: 2 },
    files: [
      {
        path: SAMPLE_FILES.coupon,
        hunks: [
          {
            header: '@@ -22,4 +22,6 @@ function apply',
            lines: [
              { type: 'ctx', n: 22, text: '  const apply = () => {' },
              { type: 'ctx', n: 23, text: '    onApply(code.trim());' },
              { type: 'ctx', n: 24, text: "    setCode('');" },
              { type: 'add', n: 25, text: '    // Keep the field ready for the next code.' },
              { type: 'add', n: 26, text: '    field.current?.focus();' },
              { type: 'ctx', n: 27, text: '  };' },
            ],
          },
        ],
      },
    ],
    checks: [
      {
        id: 'types',
        name: { en: 'Type check', ko: '타입 검사' },
        status: 'done',
        done: 1,
        total: 1,
      },
      {
        id: 'tests',
        name: { en: 'Unit tests', ko: '단위 테스트' },
        status: 'done',
        done: 1,
        total: 1,
      },
    ],
    findings: [
      {
        id: 'f-comment',
        severity: 'note',
        title: { en: 'The comment repeats the code', ko: '주석이 코드를 되풀이함' },
        check: 'types',
        location: 'CouponField.tsx:25',
        at: ago(9),
      },
    ],
    comments: [],
  },
  {
    number: 10,
    title: TITLES.badge,
    description: {
      en: 'Renames CartBadge to ItemCountBadge; nothing else changes.',
      ko: 'CartBadge 이름을 ItemCountBadge로 바꿉니다. 다른 변경은 없습니다.',
    },
    branch: 'example/cart-badge',
    state: 'merged',
    task: 'task-badge',
    linked: { session: 'total', run: 1 },
    files: [
      {
        path: SAMPLE_FILES.itemCount,
        hunks: [
          {
            lines: [
              {
                type: 'del',
                n: 3,
                text: 'export function CartBadge({ count }: { count: number }) {',
              },
              {
                type: 'add',
                n: 3,
                text: 'export function ItemCountBadge({ count }: { count: number }) {',
              },
              { type: 'ctx', n: 4, text: '  return <span className="badge">{count}</span>;' },
              { type: 'ctx', n: 5, text: '}' },
            ],
          },
        ],
      },
    ],
    checks: [
      {
        id: 'tests',
        name: { en: 'Unit tests', ko: '단위 테스트' },
        status: 'done',
        done: 1,
        total: 1,
      },
    ],
    findings: [],
    comments: [
      {
        id: 'c-10-1',
        author: REVIEWER,
        body: { en: 'Looks good. Merged.', ko: '좋습니다. 병합했습니다.' },
        at: ago(70),
      },
    ],
  },
];

// ─── Browser QA ──────────────────────────────────────────────────────────────

export const BROWSER_STEPS = [
  'open',
  'snapshot',
  'act',
  'console',
  'screenshot',
  'attach',
] as const;
export type BrowserStep = (typeof BROWSER_STEPS)[number];

export const SAMPLE_BROWSER = {
  /** A reserved test domain: the preview opens nothing. */
  url: 'https://example-shop.test/checkout',
  title: 'Checkout · example-shop',
  /** The conversation the screenshot goes to. */
  linked: { session: 'total', run: 3 } satisfies SampleRun,
  snapshot: [
    { ref: 'e1', role: 'heading', name: 'Checkout' },
    { ref: 'e2', role: 'listitem', name: 'Canvas tote × 1, $19.95' },
    { ref: 'e3', role: 'textbox', name: 'Coupon code' },
    { ref: 'e4', role: 'button', name: 'Apply coupon' },
    { ref: 'e5', role: 'status', name: 'Total $19.95' },
    { ref: 'e6', role: 'button', name: 'Place order' },
  ],
  actions: [
    {
      id: 'fill',
      verb: 'fill',
      ref: 'e3',
      value: 'SAVE10',
      result: { en: 'Typed into Coupon code', ko: 'Coupon code에 입력함' },
    },
    {
      id: 'click',
      verb: 'click',
      ref: 'e4',
      result: { en: 'The total stayed at $19.95', ko: '합계가 $19.95 그대로임' },
    },
  ],
  console: [
    {
      level: 'warning',
      message: 'Coupon SAVE10 applied before the cart total was ready',
      source: 'src/checkout/CouponField.tsx:27',
    },
    {
      level: 'error',
      message: "TypeError: Cannot read properties of undefined (reading 'lines')",
      source: 'src/checkout/total.ts:15',
    },
  ],
  screenshot: { name: 'checkout-coupon.png', width: 1280, height: 800 },
} as const;
