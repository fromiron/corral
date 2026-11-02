// Controlled conversations with rule-derived recipients; never natural-dialogue accuracy.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPrivateDirectory, writePrivate } from '../gold/store.ts';
import { INPUT_VERSION, type MeetingInput, renderMeeting } from './data.ts';

type Words = readonly [ko: string, en: string, ja: string];
export interface FactEvent {
  actor: number;
  kind: 'proposal' | 'observation' | 'repeat' | 'other';
  fact?: string;
  words: Words;
}
interface Rule {
  mode: 'one' | 'set' | 'all' | 'none';
  owners?: readonly string[];
  excludeOwners?: readonly string[];
}
interface Family {
  id: string;
  events: FactEvent[];
  request: Words;
  rule: Rule;
}

// A proposal/observation introduces a fact. Repeating it never changes its first owner.
// These annotations define the controlled scene, not a classifier's interpretation of it.
export function deriveTarget(events: FactEvent[], rule: Rule, actorIds: string[]) {
  if (new Set(actorIds).size !== actorIds.length) throw new Error('participant IDs repeat');
  const owners = new Map<string, { id: string; turn: string }>();
  for (const [index, event] of events.entries()) {
    if (!actorIds[event.actor]) throw new Error('event actor is not a participant');
    if (
      (event.kind === 'proposal' || event.kind === 'observation') &&
      event.fact &&
      !owners.has(event.fact)
    )
      owners.set(event.fact, { id: actorIds[event.actor]!, turn: `t${index + 1}` });
  }
  const owner = (fact: string) => {
    const found = owners.get(fact);
    if (!found) throw new Error('rule refers to a missing fact owner');
    return found;
  };
  const excludedIds = [...new Set((rule.excludeOwners ?? []).map((fact) => owner(fact).id))];
  const eligibleIds =
    rule.mode === 'none'
      ? []
      : [
          ...new Set(
            (rule.owners ? rule.owners.map((fact) => owner(fact).id) : actorIds).filter(
              (id) => !excludedIds.includes(id),
            ),
          ),
        ];
  if (rule.mode !== 'none' && !eligibleIds.length)
    throw new Error('non-silence rule has no eligible recipient');
  const evidenceTurnIds = [
    ...new Set(
      [...(rule.owners ?? []), ...(rule.excludeOwners ?? [])].map((fact) => owner(fact).turn),
    ),
  ];
  return {
    mode: rule.mode,
    eligibleIds,
    excludedIds,
    evidenceTurnIds,
    evidence:
      'Derived from the first recorded proposal/observation owner and the explicit current recipient rule.',
  };
}

// Each block is a distinct conversation template. Translations, names and roster variants
// share its group; they are not counted as independent conversations or mechanisms.
const FAMILIES: Family[] = [
  {
    id: 'idea-owner',
    events: [
      {
        actor: 0,
        kind: 'proposal',
        fact: 'walk',
        words: [
          '동네 축제에서 야간 산책을 하자는 안을 제가 제안할게요.',
          'My suggestion for the neighborhood festival is a night walk.',
          '町のお祭りで夜の散歩をする案を私から提案します。',
        ],
      },
      {
        actor: 1,
        kind: 'repeat',
        fact: 'walk',
        words: [
          '방금 나온 야간 산책 안에 찬성해요.',
          'I support the night walk that was just proposed.',
          '今出た夜の散歩案に賛成です。',
        ],
      },
      {
        actor: 2,
        kind: 'other',
        words: [
          '저는 포스터 색을 내일 정할게요.',
          'I will choose the poster color tomorrow.',
          '私は明日ポスターの色を決めます。',
        ],
      },
      {
        actor: 0,
        kind: 'other',
        words: [
          '잠깐 다른 얘긴데, 물은 제가 가져올게요.',
          'On a separate topic, I will bring water.',
          '別の話ですが、水は私が持っていきます。',
        ],
      },
      {
        actor: 3,
        kind: 'repeat',
        fact: 'walk',
        words: [
          '저도 앞에서 나온 야간 산책 제안이 좋아요.',
          'I also like the earlier night-walk proposal.',
          '私も先ほどの夜の散歩案がいいと思います。',
        ],
      },
    ],
    request: [
      '야간 산책을 처음 제안한 분 한 명만, 그 안을 생각한 이유를 설명해 주세요.',
      'Only the person who first proposed the night walk: explain why you suggested it.',
      '夜の散歩を最初に提案した方一人だけ、その案を考えた理由を説明してください。',
    ],
    rule: { mode: 'one', owners: ['walk'] },
  },
  {
    id: 'field-observer',
    events: [
      {
        actor: 2,
        kind: 'observation',
        fact: 'flicker',
        words: [
          '제가 직접 보니 창문을 닫을 때마다 전등이 깜빡였어요.',
          'I directly observed the light flicker each time the window closed.',
          '私が直接見たところ、窓を閉めるたびに照明がちらつきました。',
        ],
      },
      {
        actor: 0,
        kind: 'repeat',
        fact: 'flicker',
        words: [
          '방금 보고대로라면 창문을 닫을 때 전등이 깜빡였다는 거군요.',
          'So, according to that report, closing the window made the light flicker.',
          '今の報告では、窓を閉めると照明がちらついたということですね。',
        ],
      },
      {
        actor: 2,
        kind: 'other',
        words: [
          '수리 일정은 아직 모릅니다.',
          'I do not know the repair schedule yet.',
          '修理の日程はまだ分かりません。',
        ],
      },
      {
        actor: 1,
        kind: 'other',
        words: [
          '원인을 단정하기 전에 관찰을 확인하죠.',
          'Let us confirm the observation before claiming a cause.',
          '原因を決めつける前に観察を確認しましょう。',
        ],
      },
      {
        actor: 3,
        kind: 'repeat',
        fact: 'flicker',
        words: [
          '저는 직접 본 것은 아니고, 앞의 깜빡임 보고만 들었어요.',
          'I did not see it myself; I only heard the earlier flickering report.',
          '私は直接見ておらず、先ほどのちらつきの報告を聞いただけです。',
        ],
      },
    ],
    request: [
      '전등이 깜빡이는 걸 직접 관찰했다고 처음 보고한 분만, 당시 상황을 더 알려 주세요.',
      'Only the person who first reported directly seeing the flickering: describe the circumstances.',
      '照明のちらつきを直接見たと最初に報告した方だけ、当時の状況を教えてください。',
    ],
    rule: { mode: 'one', owners: ['flicker'] },
  },
  {
    id: 'schedule-author',
    events: [
      {
        actor: 1,
        kind: 'proposal',
        fact: 'morning',
        words: [
          '여행 첫날 시장 방문을 오전에 하자는 일정을 제가 제안합니다.',
          'I propose visiting the market in the morning on our first travel day.',
          '旅行初日の市場訪問を午前にする日程を私から提案します。',
        ],
      },
      {
        actor: 3,
        kind: 'repeat',
        fact: 'morning',
        words: [
          '그 오전 시장 방문 일정에 동의해요.',
          'I agree with that morning market visit.',
          'その午前の市場訪問に賛成です。',
        ],
      },
      {
        actor: 0,
        kind: 'other',
        words: [
          '숙소 예약은 끝났어요.',
          'The accommodation booking is done.',
          '宿の予約は済みました。',
        ],
      },
      {
        actor: 1,
        kind: 'other',
        words: [
          '짐은 가볍게 가져가려고요.',
          'I plan to pack lightly.',
          '荷物は少なくするつもりです。',
        ],
      },
      {
        actor: 2,
        kind: 'repeat',
        fact: 'morning',
        words: [
          '앞서 제안한 오전 시장 일정으로 저도 괜찮아요.',
          'The previously proposed morning market visit also works for me.',
          '先ほど提案された午前の市場訪問で私も大丈夫です。',
        ],
      },
    ],
    request: [
      '시장 방문을 오전으로 잡자고 처음 제안한 분만, 이동 시간을 어떻게 예상했는지 말해 주세요.',
      'Only the original proposer of the morning market visit: explain your travel-time estimate.',
      '市場訪問を午前にしようと最初に提案した方だけ、移動時間の見積もりを説明してください。',
    ],
    rule: { mode: 'one', owners: ['morning'] },
  },
  {
    id: 'condition-reporter',
    events: [
      {
        actor: 3,
        kind: 'observation',
        fact: 'closing',
        words: [
          '제가 담당자에게 직접 확인했는데, 전시장은 여섯 시에 문을 닫는대요.',
          'I checked directly with the manager: the exhibition hall closes at six.',
          '私が担当者に直接確認したところ、展示場は六時に閉まるそうです。',
        ],
      },
      {
        actor: 1,
        kind: 'repeat',
        fact: 'closing',
        words: [
          '방금 확인한 폐장 시간이 여섯 시라는 거죠.',
          'The closing time you just confirmed is six, then.',
          '今確認した閉館時間は六時ということですね。',
        ],
      },
      {
        actor: 0,
        kind: 'other',
        words: [
          '점심 장소는 제가 찾아볼게요.',
          'I will look for a lunch venue.',
          '昼食の場所は私が探します。',
        ],
      },
      {
        actor: 3,
        kind: 'other',
        words: [
          '날씨 예보는 내일 다시 봅시다.',
          'Let us check the weather forecast again tomorrow.',
          '天気予報は明日また確認しましょう。',
        ],
      },
      {
        actor: 2,
        kind: 'repeat',
        fact: 'closing',
        words: [
          '앞의 보고처럼 여섯 시 폐장이라면 서둘러야겠네요.',
          'If it closes at six as reported earlier, we should hurry.',
          '先ほどの報告どおり六時閉館なら、急ぐ必要がありますね。',
        ],
      },
    ],
    request: [
      '폐장 시간을 담당자에게 직접 확인했다고 한 분만, 확인한 내용을 더 설명해 주세요.',
      'Only the person who said they checked the closing time directly with the manager: elaborate.',
      '閉館時間を担当者に直接確認したと話した方だけ、確認内容を詳しく教えてください。',
    ],
    rule: { mode: 'one', owners: ['closing'] },
  },
  {
    id: 'paired-ideas',
    events: [
      {
        actor: 0,
        kind: 'proposal',
        fact: 'cafe',
        words: [
          '모임 장소로 조용한 카페를 제가 제안할게요.',
          'I propose a quiet cafe as our meeting venue.',
          '集まりの場所として静かなカフェを私から提案します。',
        ],
      },
      {
        actor: 2,
        kind: 'proposal',
        fact: 'park',
        words: [
          '저는 다른 안으로 공원 피크닉을 제안해요.',
          'I propose a park picnic as a different option.',
          '私は別案として公園でのピクニックを提案します。',
        ],
      },
      {
        actor: 1,
        kind: 'repeat',
        fact: 'cafe',
        words: [
          '앞에서 나온 카페 안이 좋아요.',
          'I like the cafe option mentioned earlier.',
          '先ほど出たカフェ案がいいと思います。',
        ],
      },
      {
        actor: 3,
        kind: 'repeat',
        fact: 'park',
        words: [
          '앞에서 나온 공원 안도 괜찮네요.',
          'The earlier park option also sounds good.',
          '先ほどの公園案もよさそうです。',
        ],
      },
      {
        actor: 0,
        kind: 'other',
        words: [
          '초대장 사진은 나중에 고르죠.',
          'Let us choose the invitation photo later.',
          '招待状の写真は後で選びましょう。',
        ],
      },
    ],
    request: [
      '카페와 공원을 각각 처음 제안한 두 분만, 두 장소의 장단점을 비교해 주세요.',
      'Only the two original proposers of the cafe and the park: compare the two venues.',
      'カフェと公園をそれぞれ最初に提案した二人だけ、二つの場所の長所と短所を比較してください。',
    ],
    rule: { mode: 'set', owners: ['cafe', 'park'] },
  },
  {
    id: 'paired-causes',
    events: [
      {
        actor: 1,
        kind: 'observation',
        fact: 'door',
        words: [
          '제가 직접 확인했는데 문을 열었을 때 웅웅거리는 소리가 멈췄어요.',
          'I directly observed that the humming stopped when the door opened.',
          '私が直接確認したところ、ドアを開けると低い音が止まりました。',
        ],
      },
      {
        actor: 3,
        kind: 'observation',
        fact: 'fan',
        words: [
          '저는 직접 확인했는데, 환풍기를 끄면 그 소리가 멈췄어요.',
          'I directly checked that turning off the fan stopped that noise.',
          '私が直接調べたところ、換気扇を止めるとその音が止まりました。',
        ],
      },
      {
        actor: 0,
        kind: 'repeat',
        fact: 'door',
        words: [
          '앞의 보고는 문을 열면 소리가 멈췄다는 거네요.',
          'The earlier report says opening the door stopped the noise.',
          '先ほどの報告は、ドアを開けると音が止まったということですね。',
        ],
      },
      {
        actor: 2,
        kind: 'repeat',
        fact: 'fan',
        words: [
          '환풍기를 끄면 멈췄다는 두 번째 보고도 들었어요.',
          'I also heard the second report about turning off the fan.',
          '換気扇を止めたら止まったという二つ目の報告も聞きました。',
        ],
      },
      {
        actor: 1,
        kind: 'other',
        words: [
          '회의 시간은 아직 남았어요.',
          'We still have meeting time left.',
          '会議の時間はまだ残っています。',
        ],
      },
    ],
    request: [
      '문과 환풍기에 관한 두 관찰을 각각 직접 보고한 두 분만, 관찰 조건을 비교해 주세요.',
      'Only the two people who directly reported the door and fan observations: compare their conditions.',
      'ドアと換気扇の観察をそれぞれ直接報告した二人だけ、観察条件を比較してください。',
    ],
    rule: { mode: 'set', owners: ['door', 'fan'] },
  },
  {
    id: 'alternate-owner',
    events: [
      {
        actor: 2,
        kind: 'proposal',
        fact: 'trail',
        words: [
          '주말 활동으로 산길 걷기를 제가 제안해요.',
          'I propose a trail walk for our weekend activity.',
          '週末の活動として山道の散歩を私から提案します。',
        ],
      },
      {
        actor: 0,
        kind: 'repeat',
        fact: 'trail',
        words: [
          '그 산길 걷기 안에 찬성해요.',
          'I agree with that trail-walk proposal.',
          'その山道の散歩案に賛成です。',
        ],
      },
      {
        actor: 1,
        kind: 'proposal',
        fact: 'museum',
        words: [
          '실내 대안으로 박물관 방문을 제가 제안할게요.',
          'I propose a museum visit as an indoor alternative.',
          '屋内の代案として博物館訪問を私から提案します。',
        ],
      },
      {
        actor: 3,
        kind: 'repeat',
        fact: 'museum',
        words: [
          '앞에서 나온 박물관 안도 좋아요.',
          'I also like the museum option proposed earlier.',
          '先ほど出た博物館案もいいと思います。',
        ],
      },
      {
        actor: 1,
        kind: 'other',
        words: [
          '간식은 나중에 정해요.',
          'Let us decide on snacks later.',
          'おやつは後で決めましょう。',
        ],
      },
    ],
    request: [
      '산길 걷기를 처음 제안한 분은 이번 답변에서 제외하고, 박물관 대안을 처음 제안한 분만 이유를 설명해 주세요.',
      'Exclude the original trail-walk proposer from this reply; only the original museum proposer should explain the alternative.',
      '山道の散歩を最初に提案した方は今回の回答から除き、博物館という代案を最初に提案した方だけ理由を説明してください。',
    ],
    rule: { mode: 'one', owners: ['museum'], excludeOwners: ['trail'] },
  },
  {
    id: 'alternate-observer',
    events: [
      {
        actor: 0,
        kind: 'observation',
        fact: 'spill',
        words: [
          '제가 직접 보니 입구 바닥에 물이 흘러 있었어요.',
          'I directly saw water spilled on the entrance floor.',
          '私が直接見たところ、入口の床に水がこぼれていました。',
        ],
      },
      {
        actor: 1,
        kind: 'repeat',
        fact: 'spill',
        words: [
          '입구에 물이 있었다는 앞의 보고를 들었어요.',
          'I heard the earlier report of water at the entrance.',
          '入口に水があったという先ほどの報告を聞きました。',
        ],
      },
      {
        actor: 3,
        kind: 'observation',
        fact: 'leak',
        words: [
          '저는 직접 확인했는데, 천장 이음새에서 물방울이 떨어졌어요.',
          'I directly observed drops falling from a ceiling seam.',
          '私は天井の継ぎ目から水滴が落ちるところを直接確認しました。',
        ],
      },
      {
        actor: 2,
        kind: 'repeat',
        fact: 'leak',
        words: [
          '천장에서 물방울이 떨어졌다는 보고도 중요하네요.',
          'The report about drops from the ceiling also matters.',
          '天井から水滴が落ちたという報告も重要ですね。',
        ],
      },
      {
        actor: 0,
        kind: 'other',
        words: [
          '우산은 입구에 두었어요.',
          'I left my umbrella at the entrance.',
          '傘は入口に置きました。',
        ],
      },
    ],
    request: [
      '바닥의 물을 처음 보고한 분은 이번 답변에서 제외합니다. 천장에서 떨어지는 물방울을 직접 보고한 분만 더 설명해 주세요.',
      'Exclude the first floor-water reporter from this reply. Only the direct observer of the ceiling drops should elaborate.',
      '床の水を最初に報告した方は今回の回答から除きます。天井からの水滴を直接報告した方だけ詳しく説明してください。',
    ],
    rule: { mode: 'one', owners: ['leak'], excludeOwners: ['spill'] },
  },
  {
    id: 'silence',
    events: [
      {
        actor: 3,
        kind: 'proposal',
        fact: 'garden',
        words: [
          '공동 정원에 허브를 심는 안을 제안해요.',
          'I propose planting herbs in the communal garden.',
          '共同の庭にハーブを植える案を提案します。',
        ],
      },
      {
        actor: 1,
        kind: 'repeat',
        fact: 'garden',
        words: [
          '그 허브 제안에 동의해요.',
          'I agree with that herb proposal.',
          'そのハーブの提案に賛成です。',
        ],
      },
      {
        actor: 2,
        kind: 'other',
        words: [
          '화분 크기를 확인해 볼게요.',
          'I will check the pot sizes.',
          '鉢の大きさを確認します。',
        ],
      },
      {
        actor: 0,
        kind: 'other',
        words: [
          '물 주는 일정도 나중에 정하죠.',
          'Let us decide the watering schedule later too.',
          '水やりの日程も後で決めましょう。',
        ],
      },
    ],
    request: [
      '지금은 기록만 남깁니다. 제가 다음 질문을 보낼 때까지 아무도 답하지 마세요.',
      'This is only a note for the record. Nobody should reply until I send the next question.',
      '今は記録だけ残します。次の質問を送るまで、誰も返答しないでください。',
    ],
    rule: { mode: 'none' },
  },
  {
    id: 'excluded-open-invitation',
    events: [
      {
        actor: 1,
        kind: 'proposal',
        fact: 'time',
        words: [
          '독서 모임 시간을 토요일 세 시로 하자고 제가 제안해요.',
          'I propose Saturday at three as the book-club meeting time.',
          '読書会の時間を土曜日の三時にする案を私から提案します。',
        ],
      },
      {
        actor: 0,
        kind: 'repeat',
        fact: 'time',
        words: [
          '앞의 토요일 세 시 제안에 찬성해요.',
          'I support the earlier Saturday-at-three proposal.',
          '先ほどの土曜日三時という提案に賛成です。',
        ],
      },
      {
        actor: 2,
        kind: 'other',
        words: [
          '읽을 책은 아직 고르지 않았어요.',
          'We have not picked the book yet.',
          '読む本はまだ選んでいません。',
        ],
      },
      {
        actor: 3,
        kind: 'other',
        words: [
          '책 분량은 함께 정하면 좋겠어요.',
          'We could decide the reading length together.',
          '読む分量は一緒に決めるとよさそうです。',
        ],
      },
    ],
    request: [
      '토요일 세 시를 처음 제안한 분은 이번에는 답하지 마세요. 그 외 참가자 중 누구든 한 명만 읽을 책 아이디어를 주세요.',
      'The person who first proposed Saturday at three should not reply this time. Any one other participant may suggest a book.',
      '土曜日三時を最初に提案した方は今回は返答しないでください。それ以外の参加者の誰か一人だけ、本の案を出してください。',
    ],
    rule: { mode: 'one', excludeOwners: ['time'] },
  },
  {
    id: 'open-invitation',
    events: [
      {
        actor: 0,
        kind: 'other',
        words: [
          '휴일에 편하게 할 일을 찾고 있어요.',
          'We are looking for something relaxing to do on the holiday.',
          '休日に気楽にできることを探しています。',
        ],
      },
      {
        actor: 2,
        kind: 'other',
        words: [
          '아직 구체적인 아이디어는 없어요.',
          'There is no specific idea yet.',
          'まだ具体的な案はありません。',
        ],
      },
      {
        actor: 1,
        kind: 'other',
        words: [
          '실내와 실외 모두 괜찮아요.',
          'Both indoor and outdoor activities are fine.',
          '屋内でも屋外でも大丈夫です。',
        ],
      },
      {
        actor: 3,
        kind: 'other',
        words: [
          '비용은 적게 들면 좋겠네요.',
          'Keeping the cost low would be nice.',
          '費用は少なくて済むといいですね。',
        ],
      },
    ],
    request: [
      '특정한 분을 지목하는 건 아니에요. 누구든 한 명만 편하게 아이디어 하나를 말해 주세요.',
      'I am not addressing anyone in particular. Any one participant may casually suggest an idea.',
      '特定の方への指名ではありません。誰か一人だけ、気軽に案を一つ出してください。',
    ],
    rule: { mode: 'one' },
  },
  {
    id: 'all-except-owner',
    events: [
      {
        actor: 2,
        kind: 'proposal',
        fact: 'cards',
        words: [
          '환영 행사에서 손으로 쓴 카드를 나눠 주자는 안을 제가 제안해요.',
          'I propose giving out handwritten cards at the welcome event.',
          '歓迎会で手書きのカードを配る案を私から提案します。',
        ],
      },
      {
        actor: 3,
        kind: 'repeat',
        fact: 'cards',
        words: [
          '그 손글씨 카드 안이 좋아요.',
          'I like that handwritten-card idea.',
          'その手書きカードの案がいいと思います。',
        ],
      },
      {
        actor: 0,
        kind: 'other',
        words: [
          '종이는 재활용지를 쓸 수 있어요.',
          'We could use recycled paper.',
          '再生紙を使えそうです。',
        ],
      },
      {
        actor: 2,
        kind: 'other',
        words: [
          '행사장 의자는 이미 준비했어요.',
          'The venue chairs are already prepared.',
          '会場の椅子はもう準備しました。',
        ],
      },
      {
        actor: 1,
        kind: 'repeat',
        fact: 'cards',
        words: [
          '앞서 나온 카드 아이디어에 저도 동의해요.',
          'I also support the card idea mentioned earlier.',
          '私も先ほど出たカードの案に賛成です。',
        ],
      },
    ],
    request: [
      '손글씨 카드를 처음 제안한 분은 이번 답변에서 제외하고, 나머지 참가자는 모두 그 안에 대한 의견을 하나씩 말해 주세요.',
      'Exclude the original handwritten-card proposer from this reply. Every other participant should give an opinion on that idea.',
      '手書きカードを最初に提案した方は今回の回答から除き、それ以外の参加者は全員、その案への意見を一つずつ述べてください。',
    ],
    rule: { mode: 'all', excludeOwners: ['cards'] },
  },
];

const LANGUAGES = ['ko', 'en', 'ja'] as const;
const NAMES = [
  ['민서', '하린', '지우', '서준', '수빈', '도윤'],
  ['Mina', 'Haru', 'Jules', 'Sam', 'Riley', 'Noah'],
  ['美咲', '遥', '悠真', '葵', '陽菜', '蓮'],
] as const;
export const SOURCE =
  'programmatic controlled conversation facts, not natural/human-rated dialogue';
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function shuffled<T>(values: readonly T[], key: string): T[] {
  return values
    .map((value, index) => ({ value, order: sha(`${key}:${index}`) }))
    .sort((a, b) => a.order.localeCompare(b.order))
    .map(({ value }) => value);
}

export function buildOracle(seed = 41) {
  if (!Number.isSafeInteger(seed)) throw new Error('seed must be an integer');
  return FAMILIES.flatMap((family) =>
    LANGUAGES.flatMap((language, languageIndex) =>
      Array.from({ length: 6 }, (_, variant) => {
        const count = variant % 2 ? 6 : 4;
        const key = `${seed}:${family.id}:${variant}`;
        const actorIds = shuffled(
          Array.from({ length: count }, (_, index) => `p${index + 1}`),
          `${key}:ids`,
        );
        const names = shuffled(NAMES[languageIndex]!, `${key}:names`).slice(0, count);
        const participants = shuffled(
          actorIds.map((id, index) => ({ id, name: names[index]!, role: '' })),
          `${key}:roster`,
        );
        const input: MeetingInput = {
          participants,
          turns: family.events.map((event, index) => ({
            id: `t${index + 1}`,
            speakerId: actorIds[event.actor]!,
            text: event.words[languageIndex]!,
          })),
          message: family.request[languageIndex]!,
        };
        return {
          id: `meeting-oracle-${family.id}-${language}-${variant}`,
          group: `meeting-oracle-family-${family.id}`,
          task: 'meeting' as const,
          language,
          split: 'final' as const,
          source: SOURCE,
          inputVersion: INPUT_VERSION,
          input,
          text: renderMeeting(input),
          target: deriveTarget(family.events, family.rule, actorIds),
          oracle: {
            family: family.id,
            variant,
            actorIds,
            rule: family.rule,
            events: family.events.map(({ actor, kind, fact }, index) => ({
              turnId: `t${index + 1}`,
              actor,
              kind,
              ...(fact ? { fact } : {}),
            })),
          },
        };
      }),
    ),
  );
}

export function freezeOracle(output: string, seed = 41) {
  if (existsSync(output)) throw new Error('frozen diagnostic directory already exists');
  const rows = buildOracle(seed);
  const data = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
  const source = readFileSync(fileURLToPath(import.meta.url));
  const renderer = readFileSync(
    new URL('../../../packages/local-intelligence/src/decision/text.ts', import.meta.url),
  );
  const destination = assertPrivateDirectory(output);
  const manifest = {
    version: 'meeting-oracle-v1',
    frozenAt: new Date().toISOString(),
    seed,
    source: SOURCE,
    inputAuthorship: 'Agent-authored static templates; exact source frozen.',
    labelSource:
      'Executable fact ownership and explicit recipient rules, without model-assigned labels.',
    sourceSha256: sha(source),
    rendererSha256: sha(renderer),
    dataSha256: sha(data),
    records: rows.length,
    groups: new Set(rows.map((row) => row.group)).size,
    partitions: { final: rows.length },
    languages: Object.fromEntries(
      LANGUAGES.map((language) => [
        language,
        rows.filter((row) => row.language === language).length,
      ]),
    ),
    ids: rows.map((row) => ({ id: row.id, group: row.group })),
    limitations: [
      'Rule/template families, not variants or translations, are the grouping unit.',
      'Source-defined controlled scenes with executable fact-derived labels; not natural dialogue or human-rated relevance.',
      'Ownership and explicit recipient-rule following only; no claim about all conversational situations.',
      'Do not fit, calibrate or select a policy on this final diagnostic.',
    ],
  };
  writePrivate(join(destination, 'final.jsonl'), data);
  writePrivate(join(destination, 'generator.ts'), source.toString());
  writePrivate(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [output, seed = '41'] = process.argv.slice(2);
  if (!output) throw new Error('new private output directory required');
  const manifest = freezeOracle(output, Number(seed));
  console.log(
    JSON.stringify({
      records: manifest.records,
      groups: manifest.groups,
      dataSha256: manifest.dataSha256,
    }),
  );
}
