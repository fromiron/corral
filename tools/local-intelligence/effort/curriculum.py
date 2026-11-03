"""Build original, authored synthetic coding requests; no user logs or model calls.

Every translation and execution-step variant stays with its family. Labels are rubric
judgments, not measured effort requirements or independently human-reviewed ground truth.
"""
import csv
import hashlib
import json
import sys
from pathlib import Path


def build():
    with Path(__file__).with_name('curriculum.tsv').open() as source:
        for record in csv.DictReader(source, delimiter='\t'):
            for lang in ('en', 'ko', 'ja'):
                request = record[lang]
                base = dict(id=f"curriculum:{record['family']}:{lang}",
                            source='coding-curriculum', group=f"curriculum:{record['family']}",
                            lang=lang, label=record['label'], signal='authored rubric judgment',
                            use='train', split=record['split'], request=request)
                yield base
                # Same pending task expressed through a real ReasoningInput, not a new label
                # inferred from tool name, language or text length.
                followup = {'en': 'Continue with the next step.', 'ko': '다음 단계를 진행해줘.',
                            'ja': '次の段階を進めて。'}[lang]
                yield {**base, 'id': base['id'] + ':step', 'request': followup,
                       'input': dict(kind='step', request=followup, prevRequest=request,
                                     prev='', step=1, plan=request, calls=[], directiveIds=[])}


if __name__ == '__main__':
    rows = list(build())
    raw = ''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in rows)
    Path(sys.argv[1]).write_text(raw)
    print(json.dumps({'count': len(rows), 'sha256': hashlib.sha256(raw.encode()).hexdigest()}))
