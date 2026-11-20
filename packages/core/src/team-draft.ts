import {
  type CorralDefinition,
  DEFAULT_ADVISOR_REVIEW,
  DEFAULT_LIMITS,
  hasReviewLoop,
  type PatternSlot,
  TEAM_LIMITS,
  TEAM_SLOTS,
  type TeamPattern,
  type TeamPlan,
} from '@corral/contracts';
import { ROLE_RULES } from './role-prompt.ts';
import {
  type RoleWording,
  type TeamTemplateId,
  type TeamTemplateWording,
  teamTemplate,
} from './team-templates.ts';

// goal → team plan → Corral. The local suggestion reads the goal's words; the plan
// becomes a definition whose tools, bindings, Loop ports and limits are fixed by the pattern.

/** The three patterns drafted here; auto mode uses their shapes. */
export type BasePattern = 'single' | 'write_review' | 'research_write_review';
type BaseSlot = PatternSlot<BasePattern>;
/** The eight patterns that are the library templates of the same name. */
export type TemplatePattern = Exclude<TeamPattern, BasePattern>;

export const PATTERN_TEMPLATES: Readonly<Record<TemplatePattern, TeamTemplateId>> = {
  implement_review: 'implement-review',
  feature: 'feature',
  bug_fix: 'bug-fix',
  refactor: 'refactor',
  performance: 'performance',
  adversarial_review: 'adversarial-review',
  tech_decision: 'tech-decision',
  code_investigation: 'code-investigation',
};

export const isTemplatePattern = (pattern: TeamPattern): pattern is TemplatePattern =>
  pattern in PATTERN_TEMPLATES;

/** A template pattern's words: its roles by slot and its default criteria. */
export interface PatternWording<P extends TemplatePattern = TemplatePattern> {
  roles: Record<PatternSlot<P>, RoleWording>;
  criteria: readonly string[];
}

/** Words the local suggestion uses, from the Studio's messages (`TeamDraft.wording`). */
export interface TeamWording {
  roles: Record<BaseSlot, { name: string; duty: string }>;
  /** Default criteria: answer the brief; name sources (used by the review patterns). */
  criteria: { direct: string; sources: string };
  /** Labels of the steps the pattern adds. */
  labels: TeamLabels;
  /** Recognized local task: inspect evidence, write findings, independently verify. */
  securityReview?: {
    name: string;
    roles: Pick<TeamWording['roles'], 'researcher' | 'writer' | 'reviewer'>;
    criteria: { evidence: string; verification: string; approval: string };
  };
  /**
   * The template patterns' words, from the library templates (`TeamTemplates`). Without them
   * the local suggestion picks among the three base patterns only.
   */
  templates?: { [P in TemplatePattern]: PatternWording<P> };
}

export interface TeamLabels {
  loop: string;
  decision: string;
  output: string;
  outriderPrinciples?: string;
  /** The Join where the parallel patterns' branches meet. */
  join?: string;
  /** The Loop and decision of the patterns whose work a verification judges. */
  verifyLoop?: string;
  verifyDecision?: string;
}

const DEFAULT_OUTRIDER_PRINCIPLES =
  'Check the evidence against the requested result and suggest concrete corrections.';

const ENGLISH_LABELS: TeamLabels = {
  loop: 'Review loop',
  decision: 'Review decision',
  output: 'Output',
  join: 'Join',
  verifyLoop: 'Verification loop',
  verifyDecision: 'Verification decision',
};

export interface TeamDraft {
  definition: CorralDefinition;
}

const RESEARCH =
  /\b(research\w*|compar\w*|investigat\w*|analy[sz]\w*|survey\w*|evaluat\w*|assess\w*|sources?|market|benchmark\w*)\b|조사|비교|분석|리서치|자료|출처|평가|시장/i;
const WRITING =
  /\b(write|writing|draft\w*|report\w*|article\w*|essay\w*|post|announcement\w*|proposal\w*|document\w*|blog\w*|summar\w*|e-?mail\w*|letter\w*|review\w*|plan)\b|작성|글|보고서|문서|안내문|제안서|기획|요약|검토|이메일|편지/i;

const SECURITY = /\b(security|vulnerabilit\w*)\b|보안|취약점/i;
const PULL_REQUEST = /\b(pull[ -]?request|pr)\b|풀\s*리퀘스트|풀\s*리퀘/i;
const REVIEW = /\b(review\w*|check\w*|audit\w*)\b|검토|검사|확인|점검/i;
const SUGGESTED_NAME_LENGTH = 48;

// The template patterns, reached only from words that leave little doubt.
const REVIEW_CODE = /\b(review\w*|audit\w*|inspect\w*)\b|검토|리뷰|점검/i;
/** A part of a codebase, by the names its pieces go by. */
const CODE_EN = String.raw`code|codebase|prs?|pull[ -]?requests?|diffs?|branch\w*|commits?|modules?|middleware|functions?|endpoints?|implementation|repos?|repositor(?:y|ies)|librar\w*|components?|handlers?|loaders?|parsers?|schedulers?|plugins?|schemas?|limiters?|resolvers?|serializers?|validators?|routers?|interceptors?|reducers?|controllers?|renderers?|webhooks?|cron|(?:build|deploy\w*|migration|shell|bash|python|node|install\w*|setup|seed|ci) scripts?`;
const CODE_KO =
  '코드|브랜치|커밋|모듈|함수|미들웨어|구현|엔드포인트|라이브러리|컴포넌트|로직|로더|파서|스케줄러|플러그인|메[서소]드|핸들러|쿼리|스키마|리미터|라우터|컨트롤러|리졸버|웹훅';
const CODE = new RegExp(String.raw`\b(?:${CODE_EN})\b|${CODE_KO}`, 'i');
/** A part of this codebase in particular: "the auth module", "our parser"; Korean has no article. */
const NAMED_CODE = new RegExp(
  String.raw`\b(?:the|this|that|these|those|our|its|their|my|your)\s+(?:[\w'’.-]+\s+){0,2}?(?:${CODE_EN})\b|${CODE_KO}`,
  'i',
);
const NO_CHANGE =
  /\b(without (chang|modif|edit|touch|fix)\w*|(don['’]?t|do not|never) (change|modify|edit|touch|fix)\w*|read[- ]only|findings only|only report\w*|report (the )?findings|no (changes|edits|fixes))\b|(고치|수정하|바꾸|변경하|건드리|손대)지\s*(는\s*|도\s*)?(말|마)|읽기\s*전용/i;
const CORRECTNESS = /\b(correctness|logic errors?)\b|정확성|논리\s*오류/i;
const BUG =
  /\b(bugs?|crash\w*|errors?|exceptions?|fail\w*|broken|regressions?|flaky|intermittent\w*|timeouts?|hangs?|freez\w*|leaks?)\b|버그|오류|에러|장애|크래시|죽는|죽어|깨지|깨져|실패|안\s?되|멈추|멈춰|타임아웃|먹통|누수/i;
const FIX = /\b(fix\w*|repair\w*|resolv\w*|patch\w*)\b|고쳐|고치|수정해|해결/i;
const DECISION =
  /\b(decid\w*|decisions?|choos\w*|chose|pick|select|which (one|option|is better)|should (we|i)|recommend\w*|trade-?offs?)\b|결정|선택|고를|고르|골라|할지|추천|권해|권하/i;
const OPTIONS =
  /\b(between|or|vs\.?|versus|both|options?|alternatives?|either)\b|중\s*(에|에서)?\s*(무엇|어느|뭘|뭐|하나|어떤)|아니면|두\s*(안|가지|방안|옵션|후보)|둘\s*중|대신/i;
/** Korean names two alternatives by their endings alone: "유지할지 바꿀지". */
function twoAlternatives(brief: string) {
  let count = 0;
  for (const match of brief.matchAll(/([가-힣])지(?![가-힣])/g)) {
    // A syllable that ends in ㄹ: its final-consonant index is 8.
    if (((match[1]?.charCodeAt(0) ?? 0) - 0xac00) % 28 === 8) count += 1;
  }
  return count >= 2;
}
const IMPLEMENT =
  /\b(implement\w*|add|adds|adding|build|builds|building|develop|developing|introduce|integrat\w*|refactor\w*)\b|구현|추가|개발|도입|연동|리팩터|리팩토링/i;
const PLAN_FIRST =
  /\b(plan\w*|design\w*|migrat\w*|stages?|staged|step[- ]by[- ]step|phases?|phased|incremental\w*|roadmap|architect\w*)\b|설계|계획|마이그레이션|이관|옮기|옮겨|단계|아키텍처/i;
const DOCUMENT =
  /\b(documents?|docs?|manuscripts?|reports?|articles?|essays?|posts?|announcements?|proposals?|blogs?|e-?mails?|letters?|memos?|newsletters?|readme|faq|slides?|decks?|guides?|manuals?)\b|안내문|보고서|문서|원고|제안서|기획서|이메일|편지|공지|슬라이드|가이드|매뉴얼/i;
/** Writing a document: never a code pattern, whatever the document is about. */
const WRITE = /\b(write|writing|draft\w*|summar\w*)\b|작성|써\s*줘|써줘|요약/i;
const SOFTWARE =
  /\b(pages?|screens?|forms?|buttons?|toggles?|apps?|features?|cach\w*|database|db|tests?|settings|ui|cli|validation|login|sign[- ]?up|export|import|search)\b|화면|양식|폼|버튼|토글|앱|기능|캐시|데이터베이스|테스트|설정|로그인|가입|내보내기|검색/i;
/** Trying to break finished work, or keeping only the problems a run shows; not breaking it up. */
const ADVERSARIAL =
  /\b(adversarial\w*|(try|tries|trying|attempt\w*) to break|(?<!(n['’]t|not|never) )break (it|this|them|the (change|code|diff|fix|patch|feature)\w*)(?! (up|down|apart|into)\b| [\w'’-]+( [\w'’-]+)? (up )?(into|apart)\b)|stress[- ]test\w*|red[- ]team\w*|poke holes|blind spots?|attack (it|this|them|the (change|code|diff|fix|patch|feature)\w*)|only (report |show |list |tell me )?(what|the (problems?|issues?|bugs?|failures?)) (you|that) (can )?(show|reproduce|demonstrate)|(only|just) (the )?reproducible|reproducible (problems?|issues?|bugs?|failures?) only)\b|반증|깨뜨려|깨트려|깨\s*봐|깨\s*보|부숴|부수어|부서뜨려|공격해|허점|(?<!취)약점|사각지대|반례|재현(되는|된|할\s*수\s*있는|\s*가능한)\s*(문제|것|버그|결함|오류)만/i;
/** Looking for the ways a piece of work can fail: an attack when nothing is to be fixed. */
const FAILURE_HUNT =
  /\b((ways?|cases?|inputs?|scenarios?|conditions?|places?)\b.{0,40}\b(can|could|might|would|may|will)\b.{0,20}\b(fail|break|crash|lose|corrupt|leak|hang|go wrong|misbehave|double)\w*|what (can|could|might) (go wrong|break|fail)|failure modes?)\b|(생길|날|터질|깨질|실패할|틀릴|유실될|날아갈|꼬일|망가질|잘못될|죽을|멈출)\s*수\s*(도\s*)?있는\s*(경우|상황|입력|조건|지점|방법|곳|시나리오)/i;
/** Something that runs, besides code and the software's named parts. */
const RUNS = /\b(flows?|apis?|services?)\b|흐름|서비스/i;
/** A change made to something: finished work when it is not a document's. */
const CHANGE_MADE =
  /\b((the|this|my|your|our|that|these|those|new|recent|latest|last)\s+([\w'’-]+\s+){0,3}(changes?|diffs?|patch(es)?|fix(es)?)|changes|diffs|patches|fixes)\b|변경(?!하)|패치|수정\s*사항/i;
/** The behavior stays while the code's shape moves: a refactoring, not a change. */
const BEHAVIOR_KEPT =
  /\b(without chang\w* (its |the |any )?(behaviou?r|functionality|what it does|output)|(behaviou?r|functionality) (stays|unchanged|the same)|keep(ing)? (the |its )?(behaviou?r|functionality)|(must|should|may|can|will)(n['’]t| not|not) (change|alter|break|affect) (its |the |any )?(behaviou?r|functionality|output|results?|what it does)|(no|zero) (behaviou?r(al)?|functional) changes?|behaviou?r[- ]preserving|keep(ing)? (all |every |the )?(\w+ )?tests? (green|passing)|(all|every|the) tests? (must |should |have to |need to )?(still )?pass)\b|(동작|기능|결과|출력|행동)(은|는|이|가|을|를)?\s*(지금과\s*|기존과\s*|전과\s*)?(그대로|유지|바꾸지|같게|같아야|똑같|동일|(바뀌|달라지|변하)(면\s*안|지\s*않))|테스트(는|가|를)?\s*(전부|모두|다)?\s*(통과|깨지면\s*안|깨지지\s*않)/i;
const REFACTOR = /\b(refactor\w*)\b|리팩터|리팩토링/i;
const RESTRUCTURE =
  /\b(restructur\w*|untangl\w*|consolidat\w*|decoupl\w*|clean(ing)? up)\b|구조를?\s*(바꿔|바꾸|개선|정리)|구조\s*개선/i;
/** Splitting code into smaller pieces; splitting a PR or a commit reshapes the change instead. */
const SPLIT =
  /\b(break|split)\w*( [\w'’-]+){0,4}? (up )?into (smaller|separate|several|multiple|individual)\b|(작은|여러|잘게)[^.?!]{0,16}?(으로|로)\s*(나눠|나누|쪼개|분리)|쪼개/i;
const CHANGE_UNIT =
  /\b(prs?|pull[ -]?requests?|diffs?|commits?|patch(es)?|changesets?)\b|커밋|풀\s*리퀘|패치/i;
const RESHAPE =
  /\b(move|moving|merge|split|extract\w*|combin\w*|one place|single place|into (one|a single|a shared) [\w-]+|tidy\w*|de-?dup\w*|de-?duplicat\w*)\b|정리|모아|모으|합쳐|합치|나눠|나누|분리|옮겨|옮기|한\s*곳/i;
/** Saying that it is slow or runs out of room: a complaint, not the topic of speed. */
const SLOW =
  /\b(slow\w*|sluggish|lagg\w*|(run|runs|running|ran) out of memory|out[- ]of[- ]memory|ooms?|takes? (over |about |nearly |almost )?(\d[\d.,]*|a few|several|one|two|three|four|five|ten) ?(ms|milliseconds?|s|seconds?|minutes?)|(takes?|taking|took) (too |so |far too |way too )?(long|forever|ages)|from \d[\d.,]* ?(ms|milliseconds?|s|sec(ond)?s?|min(ute)?s?|hours?) to \d[\d.,]*)\b|느려|느린|느리|버벅|오래\s*걸|\d[\d.,]*\s*(초|분|밀리초|ms)(가|이|나|이나|씩|도)?\s*(넘게\s*|이상\s*)?걸/i;
/** Speed as a topic: the names of a measure of time. */
const SPEED_EN = String.raw`performance|latency|throughput|p\d{2,3}|percentiles?|load(?:ing)? times?|response times?|startup times?|speed`;
const SPEED_KO = String.raw`성능|속도|지연|로딩|응답\s*시간|처리\s*시간`;
/**
 * A resource the software uses, by its size or its use; 램 not inside a longer word, and a size
 * that is a limit's value is no resource.
 */
const RESOURCE_EN = String.raw`memory|ram|heap|footprint|bundles?|binary size|(?:file|image|payload|build|docker image|app|package|bundle) sizes?|cpu (?:use|usage|load|time|spikes?)|cpu at \d+|disk (?:use|usage|space)|storage (?:use|usage)|(?:docker|container) images?`;
const RESOURCE_KO = String.raw`메모리|(?<![가-힣])램|(?<![가-힣])힙(?!합)|용량(?!\s*(?:제한|한도|상한|초과))|번들|디스크|저장\s*공간|CPU\s*사용`;
const RESOURCE = new RegExp(String.raw`\b(?:${RESOURCE_EN})\b|${RESOURCE_KO}`, 'i');
const MEASURED = new RegExp(
  String.raw`\b(?:${SPEED_EN}|${RESOURCE_EN})\b|${SPEED_KO}|${RESOURCE_KO}`,
  'i',
);
/** A wish aimed at the measure itself: "improve the performance", "응답 속도를 개선". */
const MEASURE_WISHED = new RegExp(
  String.raw`\b(?:improv\w*|reduc\w*|cut(?:ting|s)?|lower(?:ing|s)?|boost\w*|optimi[sz]\w*|halv\w*|minimi[sz]\w*)\s+(?:[\w'’-]+\s+){0,2}?(?:${SPEED_EN}|${RESOURCE_EN})\b(?!\s+(?!(?:of|in|for|on|at|by|when|while|from|to|and|so|under|during|use|usage|footprint|size|sizes|times?|consumption|spikes?|budget|regressions?)\b)[a-z])` +
    String.raw`|(?:${SPEED_KO}|${RESOURCE_KO})(?:\s*(?:사용량|사용|크기|용량|시간))?\s*(?:을|를|이|가|은|는|도)?\s*(?:(?:좀|더|많이|크게|확|절반\s*(?:으로|이하로)?)\s*)*(?:개선|줄여|줄이|낮춰|낮추|최적화|빠르게|가볍게|작게)`,
  'i',
);
/** Wanting it better or back to how it was: with a slowdown, a wish for speed. */
const RELIEF =
  /\b(faster|quicker|speed\w* up|optimi[sz]\w*|improv\w*|reduc\w*|cut|lower|boost\w*|(bring|get|put) (it|them|this|that) (back|down)|back (down )?to (normal|how it was|what it was|before))\b|빠르게|빨라|빨리|최적화|개선|줄여|줄이|낮춰|낮추|원래대로|원래\s*속도|되돌려|예전처럼|전처럼/i;
/** Wanting it faster, which is about speed whatever else the goal names. */
const FASTER =
  /\b(faster|quicker|speed\w* up|fast again)\b|빨라지|더\s*빠르|빠르게\s*(해|만들|되)|빨리\s*(되|돌)/i;
/** Asking that a thing be made fast, which says by itself that it is slow. */
const SPEED_WISH =
  /\b(speed (it|them|this|that|things|the [\w'’-]+(?: [\w'’-]+){0,3}) up|speed up (the|our|this|its) [\w'’-]+|fast again|make (it|them|this|that|things|the [\w'’-]+(?: [\w'’-]+){0,3}) (fast|faster|quick|quicker|snappy))\b|(빨라지게|빠르게)\s*(해|만들어)\s*(줘|주세요|줄래)/i;
/** Wanting it lighter: smaller, or using less. */
const LIGHTER =
  /\b(shrink\w*|smaller|slim\w*|trim\w*|lighter|(use|uses|using) less|less (memory|cpu|disk|space|ram))\b|작게|가볍게|덜\s*(쓰|먹|차)|아껴/i;
/** It got slower or heavier than it was, or is too heavy: a growth, not just when it was seen. */
const SLOWED =
  /\b(doubled|tripled|(keeps? |kept )?(grow|grows|growing|grew|climb|climbs|climbing|balloon\w*|spik(e|es|ed|ing)|peg(s|ged|ging)?)|too (big|large|heavy|much)|(\d+(\.\d+)?x|\d+ times|twice as) (slower|longer)|regress\w*|(got|gotten|getting|became|become|grown|grew) (\w+ )?slower|slower (since|after|than (before|it was|it used to|last))|went (up )?from .{1,24} to)\b|두\s*배|세\s*배|늘었|늘어났|늘어나|느려졌|커졌|불어났|너무\s*(많|커|크|무거)/i;
/** Asking only what caused something. */
const CAUSE = /\b(why|cause[sd]?|reasons?)\b|왜(?!곡)|원인|이유/i;
/** How a definite part of the code works: enough by itself to trace it. */
const HOW_IT_WORKS = new RegExp(
  String.raw`\bhow (?:does|do|did|is|are|was|were) (?:the|this|that|these|those|our|its|their|my|your)\b|\bhow (?:the|this|that|these|those|our|its|their|my|your) [\w-]+(?: [\w-]+){0,4} \w+s\b|\bwalk (?:me |us )?through\b` +
    String.raw`|\bhow\b[^.?!]{1,60}?\b(?:works?|handled|implemented|wired|built|done|computed|calculated|stored|loaded|resolved|decided|scheduled|triggered|validated|generated|parsed|cached|retried)\b[^.?!]{0,40}?\b(?:in|by|inside|within|across|through) (?:the|this|that|our|its|their|my|your) (?:[\w'’-]+ ){0,2}?(?:${CODE_EN})\b` +
    String.raw`|어떻게\s*(?:동작|작동|처리|구현|돌아가|실행|계산|결정|저장|호출|연결|구성|전달|흘러)|어떤\s*(?:순서|방식|과정|원리|경로)로|(?:동작|작동)\s*(?:방식|원리|과정|순서)|흐름을?\s*(?:파악|추적|따라)`,
  'i',
);
/** Any how, which counts beside tracing or a write-up; "how to" and "how we" ask about people. */
const HOW =
  /\bhow\b(?! to\b| (we|i|you|they|people|teams?|users?|developers?|engineers?|others?)\b)|어떻게/i;
/** Why the code is so; "why it is needed" asks about a practice, "why we" about people. */
const WHY =
  /\bwhy (does|do|did|is|are|was|were) (it|they|this|that|the|our|its)\b|\bwhy (it|they|the|this|that) \w+|왜(?!곡)[^.?!]{0,40}?(는지|인지|은지|던지)/i;
const VALUE =
  /\b(need|needs|necessary|important|matters?|should|worth|useful|good|bad|better)\b|필요한지|필요할까|중요한지|중요할까|좋은지|좋을지|나쁜지|(해|써)야\s*(하는지|할까|하나)/i;
/** Following the code's path: tracing or investigating it. */
const TRACE =
  /\b(trac(e|es|ed|ing)|investigat\w*|dig (into|through)|look into)\b|조사|추적|파악|따라가/i;
const FLOW =
  /\b(flows?|paths?|in (what|which|that) order|sequence|call (chain|graph|stack)|lifecycle)\b|흐름|경로|순서|과정/i;
const EXPLAIN = /\b(explain\w*|describ\w*)\b|설명/i;
/** Writing up what was found, besides naming a document. */
const WRITE_UP =
  /\b(write (it |this |that |them |the (answer|findings) )?up|document (how|why|what|where|when))\b|문서로|설명서|정리해|남겨/i;
/** A short answer: one line, a sentence, briefly. */
const BRIEF_ANSWER =
  /\b(briefly|in (one|a single|a|two) (line|sentence|word|phrase)s?|one[- ]?liner|in short|short answer|tl;?dr|quick (answer|question|explanation)|in a nutshell)\b|한\s*(줄|문장|마디)|간단히|간단하게|짧게|요점만/i;
/** One small piece of code: a function, a line, an expression. */
const ONE_PIECE =
  /\b(this|that|the following) (function|method|line|regexp?|regular expression|expression|variable|snippet|statement|condition|one-liner|query|loop)\b|(이|그|저|다음)\s+(함수|메[서소]드|줄|한\s*줄|정규식|정규\s*표현식|변수|조건문|쿼리|반복문)/i;
/** Where code's past is kept. */
const HISTORY = /\b(commits?|history|blame|git log|changelog)\b|커밋|기록|이력|히스토리/i;
/** Reading that past as a source, not naming a commit as a concept. */
const HISTORY_READ =
  /\b(commit (history|log)s?|git (log|history|blame)|blame|changelog|history of)\b|커밋\s*(기록|로그|이력|내역)|(변경|수정)\s*(이력|기록|내역)|이력|히스토리|(커밋|기록)(을|를)?\s*(보고|살펴|찾아|뒤져|따라)/i;
/** A written deliverable besides a document: making one is not a change to the code. */
const DELIVERABLE =
  /\b(rationale|comparisons?|comparison (table|matrix)|pros and cons|recommendations?|summary)\b|비교|근거|요약|장단점|도표|(?<![가-힣])표(?:로|를|도|가)?(?![가-힣])/i;
/**
 * A change asked of the code: a verb said as a request ("add", "and fix", "추가해 줘"), not one
 * that describes a change ("this PR adds") or asks whether to make it ("should we add").
 */
const CHANGE_ASKED =
  /(?:^|[.;:!?,\n]\s*|\b(?:and|then|please|also|just|now|first|you|let['’]?s|go ahead and|(?:you|me|us) to|need to|want to)\s+)(?:add|implement|create|delete|remove|rename|rewrite|modify|change|update|edit|replace|fix|patch|write (?:(?:a|an|the|some|more|new|unit|integration|regression|e2e|end-to-end) )*(?:tests?|code|functions?|docstrings?|comments?|scripts?))\b|(?:추가|구현|삭제|제거|수정|변경)(?:해|하고|해서|하세요|하라|해라|하자)|(?:고쳐|바꿔|지워|없애|넣어|만들어)(?!졌|진|져)|달아(?!나)|(?:테스트|코드|함수|주석|스크립트)(?:를|을)?\s*(?:작성|써|짜)/gi;

/** A change asked of the code; making or editing a document or another write-up is not one. */
function asksForChange(brief: string): boolean {
  for (const match of brief.matchAll(CHANGE_ASKED)) {
    const end = match.index + match[0].length;
    // English names its object after the verb, Korean before it.
    const object = /[가-힣]/.test(match[0])
      ? brief.slice(Math.max(0, match.index - 16), match.index)
      : (brief
          .slice(end)
          .split(/[.;!?\n]/)[0]
          ?.slice(0, 40) ?? '');
    if (!DOCUMENT.test(object) && !DELIVERABLE.test(object)) return true;
  }
  return false;
}

const isSecurityReview = (brief: string) =>
  SECURITY.test(brief) && PULL_REQUEST.test(brief) && REVIEW.test(brief);

/** The choice among the three base patterns; auto mode's local rule. */
export function basePatternFromGoal(goal: string): BasePattern {
  const brief = goal.trim();
  return isSecurityReview(brief) || RESEARCH.test(brief)
    ? 'research_write_review'
    : WRITING.test(brief)
      ? 'write_review'
      : 'single';
}

function templatePatternFromGoal(brief: string): TemplatePattern | null {
  // "Without changing behavior" asks for a refactoring, not for leaving the code alone.
  const keepsCode = NO_CHANGE.test(brief.replace(new RegExp(BEHAVIOR_KEPT.source, 'gi'), ' '));
  const code = CODE.test(brief);
  const document = DOCUMENT.test(brief);
  const software = SOFTWARE.test(brief);
  // A security PR review is a recognized task of its own (docs/specs/features/canvas.md), whether
  // or not it forbids changes; one that asks for correctness too is a review of the code.
  if (isSecurityReview(brief) && !CORRECTNESS.test(brief)) return null;
  // A change asked of the code needs a seat that writes files: no read-only template gets it.
  const asksChange = !keepsCode && asksForChange(brief);
  if (code && REVIEW_CODE.test(brief) && (keepsCode || (CORRECTNESS.test(brief) && !asksChange)))
    return 'adversarial_review';
  // Breaking finished work that runs: code, a part of the software, a change or a flow.
  const attacks =
    !asksChange &&
    (ADVERSARIAL.test(brief) || (FAILURE_HUNT.test(brief) && (keepsCode || !FIX.test(brief))));
  // The thing attacked is not the attack's own word: "stress-test" names no test.
  const attacked = brief.replace(/stress[- ]test\w*/gi, ' ');
  if (
    attacks &&
    (code ||
      SOFTWARE.test(attacked) ||
      RUNS.test(attacked) ||
      (CHANGE_MADE.test(attacked) && !document))
  )
    return 'adversarial_review';
  if (isSecurityReview(brief)) return null;
  if (!asksChange && DECISION.test(brief) && (OPTIONS.test(brief) || twoAlternatives(brief)))
    return 'tech_decision';
  // Tracing how a part of the code works or how it came to be: a how-it-works question about a
  // definite part; tracing a named part by its how, why or path; its history read for a how or a
  // why; or a write-up of why it is so or how a named part works. A short answer about one piece,
  // a concept, or a why alone is one agent's answer.
  const why = WHY.test(brief) && !VALUE.test(brief);
  const how = HOW.test(brief);
  const named = NAMED_CODE.test(brief);
  const investigates =
    code &&
    !asksChange &&
    !BRIEF_ANSWER.test(brief) &&
    !(ONE_PIECE.test(brief) && !HISTORY.test(brief)) &&
    (HOW_IT_WORKS.test(brief) ||
      (TRACE.test(brief) && named && (how || why || FLOW.test(brief))) ||
      (HISTORY.test(brief) && why) ||
      (HISTORY_READ.test(brief) && (how || EXPLAIN.test(brief))) ||
      ((document || WRITE_UP.test(brief)) && (why || (how && named))));
  // A document written about the code still starts from reading the code.
  if (document && (WRITE.test(brief) || (!code && !software && FIX.test(brief))))
    return investigates ? 'code_investigation' : null;
  // A document alone is not code, whatever is asked of it.
  const aboutCode = !document || code || software;
  const measured = MEASURED.test(brief);
  // It is slow or heavy: said outright, a measure that grew, or a part asked to be made fast.
  const slow =
    SLOW.test(brief) ||
    (measured && SLOWED.test(brief)) ||
    ((code || software) && SPEED_WISH.test(brief));
  // A slowdown wants its speed back, however it is put: a wish for speed, a fix, or a regression
  // reported without asking only for its cause.
  const wantsRelief =
    SPEED_WISH.test(brief) ||
    RELIEF.test(brief) ||
    LIGHTER.test(brief) ||
    FIX.test(brief) ||
    (SLOWED.test(brief) && !CAUSE.test(brief));
  // A measure named without a complaint needs a wish for less of it: a fix or an edit is not one.
  const wantsLess =
    MEASURE_WISHED.test(brief) ||
    (measured && FASTER.test(brief)) ||
    (RESOURCE.test(brief) && LIGHTER.test(brief));
  // A regression in speed is a slowdown, not a failure.
  const failing = BUG.test(slow ? brief.replace(/\bregress\w*/gi, ' ') : brief);
  // Fixing changes code; finding a cause without fixing it is research.
  if (failing && FIX.test(brief) && !keepsCode) return 'bug_fix';
  // An explicit refactoring stays one, whatever it says about speed.
  if (REFACTOR.test(brief) && !keepsCode && aboutCode) return 'refactor';
  if (((slow && wantsRelief) || wantsLess) && !keepsCode && aboutCode) return 'performance';
  if (
    ((RESTRUCTURE.test(brief) && code) ||
      (SPLIT.test(brief) && code && !CHANGE_UNIT.test(brief)) ||
      (BEHAVIOR_KEPT.test(brief) && RESHAPE.test(brief))) &&
    !keepsCode &&
    aboutCode
  )
    return 'refactor';
  if (investigates) return 'code_investigation';
  if (IMPLEMENT.test(brief) && !(document && !software))
    return PLAN_FIRST.test(brief) ? 'feature' : 'implement_review';
  return null;
}

function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max - 1);
  const space = head.lastIndexOf(' ');
  return `${(space > max / 2 ? head.slice(0, space) : head).trimEnd()}…`;
}

/** A pattern's roles and settings in the given words; criteria are its defaults. */
function patternParts(
  pattern: TeamPattern,
  wording: TeamWording,
): Pick<TeamPlan, 'criteria' | 'roles' | 'reviewRounds' | 'finalApproval'> {
  const rounds = hasReviewLoop(pattern) ? { reviewRounds: 2 } : {};
  if (!isTemplatePattern(pattern)) {
    const slots: readonly BaseSlot[] = TEAM_SLOTS[pattern];
    return {
      criteria:
        pattern === 'single'
          ? [wording.criteria.direct]
          : [wording.criteria.direct, wording.criteria.sources],
      roles: slots.map((slot) => ({ slot, ...wording.roles[slot] })),
      ...rounds,
      finalApproval: false,
    };
  }
  const words = wording.templates?.[pattern] as PatternWording | undefined;
  if (!words) throw new Error(`no wording for the ${pattern} pattern`);
  const roles = words.roles as Readonly<Record<string, RoleWording | undefined>>;
  return {
    criteria: [...words.criteria],
    roles: TEAM_SLOTS[pattern].map((slot) => {
      const named = roles[slot];
      if (!named) throw new Error(`the ${pattern} wording has no ${slot}`);
      return { slot, name: named.name, duty: named.duty };
    }),
    ...rounds,
    finalApproval: false,
  };
}

/**
 * The plan with another pattern: its roles, settings and criteria become the pattern's defaults,
 * its name and brief stay. `keepCriteria` keeps criteria the person wrote by hand.
 */
export function planWithPattern(
  plan: Pick<TeamPlan, 'name' | 'brief' | 'criteria' | 'outrider' | 'observeWork'>,
  pattern: TeamPattern,
  wording: TeamWording,
  { keepCriteria = false }: { keepCriteria?: boolean } = {},
): TeamPlan {
  const parts = patternParts(pattern, wording);
  return {
    name: plan.name,
    pattern,
    brief: plan.brief,
    ...(plan.outrider ? { outrider: plan.outrider } : {}),
    ...(plan.observeWork ? { observeWork: true } : {}),
    ...parts,
    criteria: keepCriteria ? [...plan.criteria] : parts.criteria,
  };
}

/** Read explicit advice/review intent before matching the work itself to a pattern. */
function outriderFromGoal(goal: string): TeamPlan['outrider'] {
  const review = /\b(review|feedback|critique|pass)\b|검토|리뷰|피드백|수정 의견|통과/i.test(goal);
  const request =
    /\b(on request|on demand|when needed|when asked|if needed|as needed|ask for|request a|request review|can ask)\b|필요할 때|요청할 수|요청할 때|원할 때|물어볼 수|물어보게|부탁할 수/i.test(
      goal,
    );
  const mustPass =
    /\b(must pass|must be approved by (?:a|the) review|only (?:after|if).{0,32}(?:review|pass)|require.{0,18}review.{0,18}pass)\b|반드시.{0,20}통과|통과해야.{0,15}제출|통과한 뒤에만/i.test(
      goal,
    );
  if (review && mustPass) return 'required_review';
  if (review && request) return 'artifact_review';
  if (
    /\b(review (?:it )?(?:before (?:every )?(?:submitting|submission|publishing|publication)|then submit)|submit after review)\b|(?:검토|리뷰)(?:한)? 후 제출|(?:발행|제출)\s*전에?\s*(?:검토|리뷰)/i.test(
      goal,
    )
  )
    return 'clarify_review';
  if (
    request &&
    /\b(experts?|advice|advisors?|consult\w*|outrider)\b|전문가|자문|아웃라이더|Outrider|조언/i.test(
      goal,
    )
  )
    return 'consultation';
  return undefined;
}

// Remove only the denied policy, not the entire sentence: the author may still want
// manuscript feedback or separately ask to observe the work.
const EN_POLICY =
  '(?:passing (?:a )?review|(?:an? )?(?:review(?: pass| gate| step| rounds?)?|automatic observation(?: of (?:the )?(?:workers?|work in progress))?))';
const EN_POLICIES = `${EN_POLICY}(?:\\s+(?:or|and|nor)\\s+${EN_POLICY})*`;
const DENIED_EN_POLICY = new RegExp(
  `\\b(?:(?:no(?: need for)?|without|do not need|don't need|skip)\\s+${EN_POLICIES}|${EN_POLICIES}\\s+(?:(?:is|are) not|isn't|aren't|not) (?:needed|required|necessary))\\b`,
  'gi',
);
const KO_POLICY = '(?:(?:검토|리뷰)(?:\\s*(?:통과|단계))?|(?:진행\\s*중\\s*)?자동\\s*관찰)';
const DENIED_KO_POLICY = new RegExp(
  `${KO_POLICY}(?:\\s*(?:이나|나|또는|와|과|및)\\s*${KO_POLICY})*(?:이|가|은|는|을|를|도)?\\s*(?:필요\\s*없|필요하지\\s*않|불필요|없이|하지\\s*(?:않|말|마))`,
  'g',
);

export interface AdviceIntent {
  outrider: TeamPlan['outrider'];
  observeWork: boolean;
  singleWithoutReview: boolean;
}

/** The same review and observation intent governs local, model and conversational proposals. */
export function adviceIntentFromGoal(goal: string): AdviceIntent {
  let declinedReview = false;
  const removeDenied = (policy: string) => {
    if (/review|검토|리뷰/i.test(policy)) declinedReview = true;
    return ' ';
  };
  const positive = goal
    .replace(DENIED_EN_POLICY, removeDenied)
    .replace(DENIED_KO_POLICY, removeDenied);
  return {
    outrider: outriderFromGoal(positive),
    observeWork: matchesWorkObservation(positive),
    singleWithoutReview: declinedReview && !hasExplicitTeamStructure(positive),
  };
}

export function requestsWorkObservation(goal: string): boolean {
  return adviceIntentFromGoal(goal).observeWork;
}

/** A request to watch the team's ongoing work, including explicit opt-outs in either locale. */
function matchesWorkObservation(goal: string): boolean {
  return goal.split(/[.!?;\n]/).some((clause) => {
    const english =
      /\b(?:(?:observe|watch|monitor) (?:the )?work in progress|(?:automatically|periodically) (?:observe|watch|monitor) (?:the |each |all )?(?:workers?|agents?)\b|automatic observation of (?:the )?(?:workers?|work in progress))\b/i;
    const korean =
      /(?:자동\s*관찰(?:을|를)?\s*(?:켜|활성화)|진행\s*중(?:인)?\s*(?:(?:작업|업무)(?:을|를)?\s*)?(?:자동(?:으로)?\s*)?관찰|(?:작업자|에이전트)(?:들의?|들|의)?\s*(?:작업|업무)?(?:을|를)?\s*(?:자동으로|주기적으로)\s*관찰)/;
    const match = english.exec(clause) ?? korean.exec(clause);
    if (!match) return false;
    const before = clause.slice(0, match.index);
    const after = clause.slice(match.index + match[0].length);
    return (
      !/\b(?:never|no|without|not|don't|disable)\s+(?:enable\s+|turn on\s+)?(?:(?:the |any )?(?:outrider|advisor) to )?$/i.test(
        before,
      ) && !/^(?:을|를|은|는)?\s*(?:(?:하)?지\s*(?:않|말|마)|없이|끄|꺼|비활성|금지)/.test(after)
    );
  });
}

/** Keep an independently requested observation setting when accepting a model's other choices. */
export function withWorkObservation(plan: TeamPlan, enabled: boolean): TeamPlan {
  if (Boolean(plan.observeWork) === enabled) return plan;
  if (enabled) return { ...plan, observeWork: true };
  const { observeWork: _unrequested, ...rest } = plan;
  return rest;
}

/** The local suggestion: no model call. Null for an empty goal. */
export function planFromGoal(goal: string, wording: TeamWording): TeamPlan | null {
  return localPlan(goal.trim(), wording, adviceIntentFromGoal(goal));
}

function localPlan(
  brief: string,
  wording: TeamWording,
  { outrider, observeWork, singleWithoutReview }: AdviceIntent,
): TeamPlan | null {
  if (!brief) return null;
  const template = wording.templates ? templatePatternFromGoal(brief) : null;
  // An optional review request alone does not add a sequential review to a writing task.
  const selfReview =
    /\b(?:worker|writer|author).{0,34}(?:revise|edit|correct).{0,28}(?:submit|deliver)\b|(?:작업자|작성자).{0,24}직접.{0,18}(?:고쳐|수정).{0,14}제출/i.test(
      brief,
    );
  const pattern: TeamPattern =
    singleWithoutReview || ((outrider || selfReview) && !template && !isSecurityReview(brief))
      ? 'single'
      : (template ?? basePatternFromGoal(brief));
  const task =
    pattern === 'research_write_review' && isSecurityReview(brief)
      ? wording.securityReview
      : undefined;
  const firstLine = brief.split('\n')[0]?.replace(/\s+/g, ' ') ?? brief;
  const firstSentence = firstLine.split(/[.!?](?:\s|$)/)[0] || firstLine;
  const parts = patternParts(pattern, wording);
  const worker =
    pattern === 'single' &&
    (((selfReview || outrider === 'artifact_review') && WRITING.test(brief)) ||
      (singleWithoutReview && /\b(?:writer|author)\b|작성자/i.test(brief)))
      ? wording.roles.writer
      : undefined;
  return {
    name: task?.name ?? cut(firstSentence, SUGGESTED_NAME_LENGTH),
    pattern,
    brief: cut(brief, TEAM_LIMITS.brief),
    criteria: (task ? Object.values(task.criteria) : undefined) ?? parts.criteria,
    roles: parts.roles.map((role) => ({
      ...role,
      ...(role.slot === 'worker' && worker ? worker : {}),
      ...(task && role.slot in task.roles ? task.roles[role.slot as keyof typeof task.roles] : {}),
    })),
    ...(parts.reviewRounds === undefined ? {} : { reviewRounds: parts.reviewRounds }),
    finalApproval: parts.finalApproval,
    ...(outrider ? { outrider } : {}),
    ...(observeWork ? { observeWork: true } : {}),
  };
}

/** Explicit task roles take priority over the inferred shape of an advice-only goal. */
function hasExplicitTeamStructure(goal: string): boolean {
  return (
    /\b(?:two|three|four|[2-9])\s+(?:(?:different|distinct|separate)\s+)?(?:agents|roles|workers)\b|(?:두|세|네)\s*(?:명의?|개의?)?\s*(?:역할|작업자|에이전트)/i.test(
      goal,
    ) ||
    /\bone (?:agent|role|worker)\b.*\b(?:another|the other)\b|(?:역할을|작업을)\s*(?:나누|분담)/i.test(
      goal,
    ) ||
    /\b(?:planner|researcher|writer|editor|implementer|tester|reviewer)\b.{0,30}\b(?:and|then)\b.{0,16}\b(?:planner|researcher|writer|editor|implementer|tester|reviewer)\b|(?:기획자|조사자|작성자|편집자|구현자|검토자).{0,18}(?:와|과|다음에|그 뒤).{0,12}(?:기획자|조사자|작성자|편집자|구현자|검토자)/i.test(
      goal,
    )
  );
}

/** The plan Studio can present after a model answer. A local recovery retains its origin. */
export function planAfterModel(
  goal: string,
  proposed: TeamPlan | null,
  wording: TeamWording,
): { plan: TeamPlan | null; recovery: 'incompatible' | 'unusable' | null } {
  const intent = adviceIntentFromGoal(goal);
  const local = localPlan(goal.trim(), wording, intent);
  if (!proposed && local?.observeWork) return { plan: local, recovery: 'unusable' };
  const modelPlan = proposed && withWorkObservation(proposed, Boolean(local?.observeWork));
  if (local?.outrider === 'required_review') {
    if (!modelPlan) return { plan: local, recovery: 'unusable' };
    return modelPlan.outrider === 'required_review'
      ? { plan: modelPlan, recovery: null }
      : { plan: { ...modelPlan, outrider: 'required_review' }, recovery: 'incompatible' };
  }
  if (
    local?.pattern !== 'single' ||
    (!intent.singleWithoutReview &&
      ((local.outrider !== 'consultation' && local.outrider !== 'artifact_review') ||
        hasExplicitTeamStructure(goal)))
  )
    return { plan: modelPlan, recovery: null };

  if (proposed?.pattern === 'single' && proposed.outrider === local.outrider)
    return { plan: modelPlan, recovery: null };
  return { plan: local, recovery: proposed ? 'incompatible' : 'unusable' };
}

const CONTRACT: Record<BaseSlot, CorralDefinition['roles'][number]['outputContract']> = {
  worker: 'draft',
  planner: 'notes',
  researcher: 'notes',
  writer: 'draft',
  reviewer: 'review',
};

/**
 * A template pattern as its library template: structure and tools from the template, the words
 * from the plan. Review rounds and the final approval follow the plan where the pattern lets it.
 */
function templateDraft(
  plan: TeamPlan,
  pattern: TemplatePattern,
  corralId: string,
  labels: TeamLabels,
): CorralDefinition {
  const definition = teamTemplate(PATTERN_TEMPLATES[pattern], corralId, {
    name: plan.name,
    brief: plan.brief,
    criteria: plan.criteria,
    roles: Object.fromEntries(
      plan.roles.map(({ slot, name, duty }) => [slot, { name, duty }]),
    ) as TeamTemplateWording['roles'],
    labels: {
      loop: labels.loop,
      decision: labels.decision,
      verifyLoop: labels.verifyLoop ?? 'Verification loop',
      verifyDecision: labels.verifyDecision ?? 'Verification decision',
      join: labels.join ?? 'Join',
      output: labels.output,
    },
  });
  return {
    ...definition,
    nodes: definition.nodes.map((node) => {
      if (node.type === 'loop' && plan.reviewRounds !== undefined)
        return { ...node, maxIterations: plan.reviewRounds };
      if (node.type === 'output') return { ...node, requireApproval: plan.finalApproval };
      return node;
    }),
  };
}

/** The plan as a Corral. Tools and wiring come from the pattern alone. */
export function draftFromPlan(
  plan: TeamPlan,
  corralId: string,
  labels: TeamLabels = ENGLISH_LABELS,
): TeamDraft {
  const sharedOutrider =
    plan.observeWork ||
    plan.outrider === 'consultation' ||
    plan.outrider === 'artifact_review' ||
    plan.outrider === 'required_review'
      ? {
          modelProfile: 'model-a',
          principles: labels.outriderPrinciples ?? DEFAULT_OUTRIDER_PRINCIPLES,
          targets: { kind: 'all' as const },
          ...(plan.outrider === 'artifact_review' ? { artifactReview: true as const } : {}),
          ...(plan.observeWork
            ? {
                observation: {
                  targets: { kind: 'all' as const },
                  review: { ...DEFAULT_ADVISOR_REVIEW },
                },
              }
            : {}),
        }
      : undefined;
  const consultation = sharedOutrider ? { sharedOutrider } : {};
  if (isTemplatePattern(plan.pattern))
    return {
      definition: { ...templateDraft(plan, plan.pattern, corralId, labels), ...consultation },
    };
  const plannedRole = (slot: BaseSlot) => {
    const planned = plan.roles.find((r) => r.slot === slot);
    if (!planned) throw new Error(`the plan has no ${slot}`);
    return planned;
  };
  const seatWording = (slot: BaseSlot) => {
    const { name, duty } = plannedRole(slot);
    return { label: name, stepInstruction: duty };
  };
  const role = (slot: BaseSlot): CorralDefinition['roles'][number] => {
    return {
      id: slot,
      name: plannedRole(slot).name,
      prompt: ROLE_RULES,
      modelProfile: slot === 'reviewer' ? 'model-b' : 'model-a',
      allowedWorkTools: ['write_artifact' as const],
      allowedCollaborationTools: ['read_artifact' as const, 'submit_result' as const],
      outputContract: CONTRACT[slot],
    };
  };
  const base = {
    ...consultation,
    schemaVersion: '0.1' as const,
    id: corralId,
    name: plan.name,
    input: { brief: plan.brief, criteria: plan.criteria },
    capabilityLinks: [],
    limits: DEFAULT_LIMITS,
  };
  const output = (source: string) => ({
    id: 'output',
    type: 'output' as const,
    label: labels.output,
    inputBindings: [{ kind: 'task_output' as const, name: 'draft', sourceNodeId: source }],
    requireApproval: plan.finalApproval,
  });

  if (plan.pattern === 'single') {
    const definition = {
      ...base,
      entryNodeId: 'work',
      roles: [role('worker')],
      nodes: [
        {
          id: 'work',
          type: 'agent' as const,
          ...seatWording('worker'),
          roleId: 'worker',
          invocation: 'scheduled' as const,
          inputBindings: [{ kind: 'run_input' as const, name: 'brief' }],
          outputName: 'draft',
        },
        output('work'),
      ],
      controlEdges: [
        { id: 'e1', source: 'work', sourcePort: 'out', target: 'output', targetPort: 'in' },
      ],
    } satisfies CorralDefinition;
    return { definition };
  }

  // The first step (research or an outline) feeds the review Loop.
  const first: BaseSlot = plan.pattern === 'research_write_review' ? 'researcher' : 'planner';
  const firstNode = first === 'researcher' ? 'research' : 'plan';
  const nodes: CorralDefinition['nodes'] = [
    {
      id: firstNode,
      type: 'agent',
      ...seatWording(first),
      roleId: first,
      invocation: 'scheduled',
      inputBindings: [{ kind: 'run_input', name: 'brief' }],
      outputName: 'notes',
    },
    {
      id: 'review_loop',
      type: 'loop',
      label: labels.loop,
      maxIterations: plan.reviewRounds ?? 2,
    },
    {
      id: 'write',
      type: 'agent',
      ...seatWording('writer'),
      parentId: 'review_loop',
      roleId: 'writer',
      invocation: 'scheduled',
      inputBindings: [
        { kind: 'run_input', name: 'brief' },
        { kind: 'task_output', name: 'notes', sourceNodeId: firstNode },
        { kind: 'previous_iteration_output', name: 'draft', sourceNodeId: 'write', optional: true },
        {
          kind: 'previous_iteration_output',
          name: 'review',
          sourceNodeId: 'review',
          optional: true,
        },
      ],
      outputName: 'draft',
    },
    {
      id: 'review',
      type: 'agent',
      ...seatWording('reviewer'),
      parentId: 'review_loop',
      roleId: 'reviewer',
      invocation: 'scheduled',
      // The criteria text, so the review is against what the person asked for (#20).
      inputBindings: [
        { kind: 'task_output', name: 'draft', sourceNodeId: 'write' },
        { kind: 'run_input', name: 'criteria' },
      ],
      outputName: 'review',
    },
    {
      id: 'review_decision',
      type: 'decision',
      label: labels.decision,
      parentId: 'review_loop',
      mode: 'review',
      rule: 'review_verdict',
      inputBindings: [{ kind: 'task_output', name: 'review', sourceNodeId: 'review' }],
    },
    output('write'),
  ];
  const edges: CorralDefinition['controlEdges'] = [
    { id: 'e0', source: firstNode, sourcePort: 'out', target: 'review_loop', targetPort: 'enter' },
    { id: 'e1', source: 'review_loop', sourcePort: 'body', target: 'write', targetPort: 'in' },
    { id: 'e2', source: 'write', sourcePort: 'out', target: 'review', targetPort: 'in' },
    { id: 'e3', source: 'review', sourcePort: 'out', target: 'review_decision', targetPort: 'in' },
    {
      id: 'e4',
      source: 'review_decision',
      sourcePort: 'revise',
      target: 'review_loop',
      targetPort: 'repeat',
    },
    {
      id: 'e5',
      source: 'review_decision',
      sourcePort: 'pass',
      target: 'review_loop',
      targetPort: 'exit',
    },
    { id: 'e6', source: 'review_loop', sourcePort: 'next', target: 'output', targetPort: 'in' },
    // At the round cap nobody is asked: the last draft goes on with its review.
    {
      id: 'e7',
      source: 'review_loop',
      sourcePort: 'exhausted',
      target: 'output',
      targetPort: 'in',
    },
  ];
  const definition: CorralDefinition = {
    ...base,
    entryNodeId: firstNode,
    roles: [role(first), role('writer'), role('reviewer')],
    nodes,
    controlEdges: edges,
  };
  return { definition };
}
