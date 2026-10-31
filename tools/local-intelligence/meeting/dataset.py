"""Authored synthetic conversations, grouped by topic; no real user conversations.

The same held-out cases compare the existing all-participants behavior, cosine similarity,
and the learned selector. Participant IDs rotate and are never model features.
"""
import csv
import json
import sys
from pathlib import Path

FOLLOWUP = {'en': 'Why do you suggest that?', 'ko': '왜 그렇게 제안한 거야?', 'ja': 'なぜそう提案したの？'}
ALL = {'en': 'Everyone, give your own view.', 'ko': '모두 각자의 의견을 말해줘.', 'ja': '全員それぞれの意見を聞かせて。'}
MORE = {'en': 'Can you give a concrete example?', 'ko': '구체적인 예를 들어줄래?', 'ja': '具体的な例を挙げてくれる？'}


def build():
    with Path(__file__).with_name('topics.tsv').open() as source:
        topics = list(csv.DictReader(source, delimiter='\t'))
    for topic in topics:
        peers = [r for r in topics if r['split'] == topic['split']]
        index = peers.index(topic)
        selected = [topic, peers[(index+1) % len(peers)], peers[(index+2) % len(peers)]]
        for lang in ('en', 'ko', 'ja'):
            for kind in ('topic', 'followup', 'example', 'all', 'new-topic'):
                order = [(index+j) % 3 for j in range(3)]
                candidates = [{'participantId': f'p{n}', 'prompt': selected[n][lang+'Role']} for n in order]
                history = [{'participantId': f'p{n}', 'text': selected[n][lang+'Answer']} for n in order]
                query = topic[lang+'Question']
                wanted = ['p0']
                if kind == 'followup' or kind == 'example':
                    query = (FOLLOWUP if kind == 'followup' else MORE)[lang]
                    wanted = [history[-1]['participantId']]
                    # No explicit developer role is needed to follow an ordinary conversation.
                    candidates = [{**p, 'prompt': ''} for p in candidates]
                if kind == 'all':
                    query, wanted = ALL[lang], [p['participantId'] for p in candidates]
                if kind == 'new-topic':
                    history = []
                yield dict(id=f"{topic['topic']}:{lang}:{kind}", group=topic['topic'], split=topic['split'],
                           lang=lang, kind=kind, intent='followup' if kind == 'example' else 'topic' if kind == 'new-topic' else kind,
                           wanted=wanted, input=dict(message=query, participants=candidates, history=history))
    with Path(__file__).with_name('discussions.tsv').open() as source:
        for n, discussion in enumerate(csv.DictReader(source, delimiter='\t')):
            order = [(n+j) % 3 for j in range(3)]
            claims = [discussion[k] for k in ('first', 'second', 'third')]
            for kind, query, wanted in [('analysis', discussion['question'], ['p1']),
                                         ('compare', discussion['compare'], ['p0','p1'])]:
                yield dict(id=f"discussion:{discussion['family']}:{discussion['lang']}:{kind}",
                           group=discussion['family'], split=discussion['split'], lang=discussion['lang'],
                           kind=kind, intent='compare' if kind == 'compare' else 'topic', wanted=wanted,
                           input=dict(message=query,
                                      participants=[dict(participantId=f'p{i}', prompt='') for i in order],
                                      history=[dict(participantId=f'p{i}', text=claims[i]) for i in order]))


def phrasing_eval():
    # Additional evaluation only, after the model is frozen. These query formulations never
    # occur in training or selection. Keep the same intended recipients and conversation.
    queries = {
        'followup': {'en': 'What led you to that conclusion?', 'ko': '그 판단에 이르게 된 근거를 설명해줄래?', 'ja': 'その判断に至った根拠を説明してもらえる？'},
        'example': {'en': 'Show how your suggestion would work in a real situation.', 'ko': '방금 제안이 실제 상황에서는 어떤 모습일지 보여줘.', 'ja': '今の提案が実際の場面でどうなるか示して。'},
        'all': {'en': 'I would like to hear each participant separately on this.', 'ko': '참가자 각자가 이 문제를 어떻게 보는지 듣고 싶어.', 'ja': '参加者それぞれがこの問題をどう見るか聞きたい。'},
    }
    for row in build():
        if row['split'] == 'test' and row['kind'] in queries:
            yield {**row, 'id': 'phrasing:' + row['id'],
                   'input': {**row['input'], 'message': queries[row['kind']][row['lang']]}}


if __name__ == '__main__':
    rows = phrasing_eval() if '--phrasing-eval' in sys.argv else build()
    Path(sys.argv[1]).write_text(''.join(json.dumps(r, ensure_ascii=False)+'\n' for r in rows))
