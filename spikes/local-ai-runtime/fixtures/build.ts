// Builds fixtures/texts.json: effort-judge-like inputs in Korean, Japanese, English and
// code-mixed form at three lengths. Deterministic; run with `node fixtures/build.ts`.
import { writeFileSync } from 'node:fs';

const requests = {
  ko: [
    '안녕, 오늘 고마웠어.',
    '이 함수 이름을 camelCase로 바꿔 줘.',
    '로그인 후 세션이 가끔 풀리는 원인을 찾아서 고쳐 줘. 재현은 새로고침을 빠르게 두 번 하면 돼.',
    '결제 모듈을 이벤트 소싱 구조로 옮기는 설계안을 만들고, 기존 데이터 마이그레이션과 롤백 절차까지 정리해 줘.',
  ],
  ja: [
    'ありがとう、助かりました。',
    'このテストの名前を分かりやすく変えてください。',
    'ビルドが CI だけで失敗します。ローカルでは通るので、環境差分を調べて修正してください。',
    '検索インデックスを差分更新に切り替える設計を考えて、整合性の検証方法と段階的な移行計画もまとめてください。',
  ],
  en: [
    'thanks, that works.',
    'Rename the variable `cnt` to `count` in utils.ts.',
    'The websocket reconnect loop sometimes spins at 100% CPU after the laptop wakes from sleep. Find out why and fix it.',
    'Design a multi-tenant permission model for the admin API, including migration of existing roles, audit logging, and a rollout plan with a kill switch.',
  ],
  code: [
    '`npm test` 돌려 줘',
    'fix this: `TypeError: Cannot read properties of undefined (reading \'map\')` in `src/list.tsx:42`',
    'この SQL が遅いので速くして: `SELECT * FROM orders o JOIN users u ON u.id = o.user_id WHERE o.created_at > now() - interval \'7 days\' ORDER BY o.total DESC;`',
    'Refactor the retry helper so cancellation propagates through `withRetry(fn, { signal })`, add tests for late resolution after abort, and keep the public API.',
  ],
} as const;

const codeBlock = `\`\`\`ts
export async function withRetry<T>(fn: () => Promise<T>, opts: { retries: number; signal?: AbortSignal }) {
  let last: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    if (opts.signal?.aborted) throw new Error('aborted');
    try {
      return await fn();
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 100));
    }
  }
  throw last;
}
\`\`\``;

const toolResult = `call: read_file {"path":"src/net/socket.ts"}
result: 1 import { backoff } from './backoff';
2 export class Socket {
3   private timer?: NodeJS.Timeout;
4   connect() { this.ws = new WebSocket(this.url); this.ws.onclose = () => this.retry(); }
5   retry() { this.timer = setTimeout(() => this.connect(), backoff(this.attempt++)); }
6 }
call: run {"cmd":"pnpm vitest run test/socket.test.ts"}
result: FAIL test/socket.test.ts > reconnects after sleep
AssertionError: expected 1 reconnect, received 214
 at test/socket.test.ts:58:21`;

const previous = {
  ko: '이전 요청: 테스트가 왜 실패하는지 봐 줘.\n이전 응답: socket.test.ts의 재연결 횟수가 기대값과 다릅니다.',
  ja: '前の依頼: テストが失敗する理由を見てください。\n前の応答: 再接続回数が期待値と一致しません。',
  en: 'previous request: check why the tests fail.\nprevious reply: the reconnect count in socket.test.ts differs from the expectation.',
  code: 'previous request: run the tests.\nprevious reply: 1 failed, 41 passed.',
} as const;

type Entry = { id: string; lang: keyof typeof requests; size: 'short' | 'medium' | 'long'; text: string };
const entries: Entry[] = [];
for (const lang of Object.keys(requests) as (keyof typeof requests)[]) {
  requests[lang].forEach((request, index) => {
    entries.push({ id: `${lang}-short-${index}`, lang, size: 'short', text: `request: ${request}` });
  });
  const main = requests[lang][3];
  entries.push({
    id: `${lang}-medium`,
    lang,
    size: 'medium',
    text: `request: ${main}\n${previous[lang]}\nplan: inspect the code, reproduce, fix, add a regression test.\n${codeBlock}`,
  });
  entries.push({
    id: `${lang}-long`,
    lang,
    size: 'long',
    text: `request: ${main}\n${previous[lang]}\nplan: inspect the code, reproduce, fix, add a regression test.\n${codeBlock}\n${toolResult}\n${codeBlock.replaceAll('withRetry', 'withBackoff')}`,
  });
}

writeFileSync(new URL('./texts.json', import.meta.url), `${JSON.stringify(entries, null, 2)}\n`);
console.log(`${entries.length} fixtures`);
