# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy==2.3.5", "scikit-learn==1.7.2", "scipy==1.16.3", "joblib==1.5.2", "threadpoolctl==3.6.0"]
# ///
"""Train context selection on authored conversations; test cases never select weights.

uv run --no-project train.py <cases.jsonl> <vectors.json> <out-dir>
"""
import hashlib
import json
import sys
from pathlib import Path
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import f1_score
from threadpoolctl import threadpool_limits


def probabilities(x):
    ex = np.exp(x - x.max(axis=-1, keepdims=True))
    return ex / ex.sum(axis=-1, keepdims=True)


def features(case, vectors, intent):
    people = case['input']['participants']
    history = case['input']['history']
    last = next((h['participantId'] for h in reversed(history) if h['participantId'] is not None), None)
    similarities = []
    for n,p in enumerate(people):
        has = any(h['participantId'] == p['participantId'] and h['text'].strip() for h in history)
        role = np.dot(vectors[0], vectors[n+1]) if p['prompt'].strip() else 0.
        reply = np.dot(vectors[0], vectors[n+1+len(people)]) if has else 0.
        similarities.append([reply, role, float(last == p['participantId'])])
    a = np.array(similarities)
    replies, roles = a[:,0]-a[:,0].mean(), a[:,1]-a[:,1].mean()
    maximum = np.maximum(a[:,0],a[:,1]); maximum -= maximum.mean()
    topical = intent[0] + intent[3]
    return np.column_stack([replies*topical,roles*topical,replies*intent[1],a[:,2]*intent[1],maximum*topical,np.full(len(a),intent[3])])


def select(case, p, rank, threshold, margin, all_threshold):
    ids = [p['participantId'] for p in case['input']['participants']]
    if p[2] >= all_threshold:
        return ids
    order = np.argsort(-rank)
    selected = [i for i in order if rank[i] >= threshold]
    remainder = [i for i in order if rank[i] < threshold]
    if not selected or rank[selected[-1]] - (rank[remainder[0]] if remainder else 0.) < margin:
        return ids  # runtime abstention uses the existing all-participants behavior
    return [ids[i] for i in selected]


def main(args):
    raw = Path(args[0]).read_bytes()
    cases = [json.loads(line) for line in raw.splitlines()]
    data = json.loads(Path(args[1]).read_text())
    if data['samplesSha256'] != hashlib.sha256(raw).hexdigest() or data['device'] != 'cpu':
        raise ValueError('embedding provenance differs')
    vs = [np.array(v) for v in data['vectors']]
    if len(vs) != len(cases) or any(not np.isfinite(v).all() for v in vs):
        raise ValueError('missing or invalid vectors')
    groups = [{c['group'] for c in cases if c['split'] == s} for s in ('train','calibration','test')]
    if any(groups[i] & groups[j] for i in range(3) for j in range(i)):
        raise ValueError('conversation family crosses splits')
    train = np.array([c['split']=='train' for c in cases])
    cal = np.array([c['split']=='calibration' for c in cases])
    x = np.array([v[0] for v in vs])
    y = np.array([['topic','followup','all','compare'].index(c['intent']) for c in cases])
    best = None
    evidence = []
    for strength in (1., 10., 100.):
        intent = LogisticRegression(C=strength, max_iter=300, class_weight='balanced', random_state=41).fit(x[train], y[train])
        ps = probabilities(x @ intent.coef_.T + intent.intercept_)
        fs = [features(c,v,p) for c,v,p in zip(cases,vs,ps)]
        tx, ty = [], []
        for n,c in enumerate(cases):
            if not train[n] or c['intent'] == 'all':
                continue
            tx.extend(fs[n])
            ty.extend([int(p['participantId'] in c['wanted']) for p in c['input']['participants']])
        for rank_c in (1., 10., 100.):
            rank = LogisticRegression(C=rank_c, max_iter=300, class_weight='balanced', random_state=41).fit(tx,ty)
            predictions = [1/(1+np.exp(-(f @ rank.coef_[0]+rank.intercept_[0]))) for f in fs]
            for threshold in (.4, .5, .6):
                for margin in (0., .05, .1):
                    for all_threshold in (.5, .7, .9):
                        per_kind = {}
                        for n,c in enumerate(cases):
                            if cal[n]:
                                hit = set(select(c,ps[n],predictions[n],threshold,margin,all_threshold)) == set(c['wanted'])
                                per_kind.setdefault(c['kind'], []).append(hit)
                        score = float(np.mean([np.mean(v) for v in per_kind.values()]))
                        if best is None or score > best[0]:
                            weights = dict(schemaVersion=1, version='meeting-v1', dims=data['dims'],
                                           baseModelSha256=data['baseModelSha256'], preprocessVersion=data['preprocessVersion'],
                                           intent=dict(weights=intent.coef_.tolist(), bias=intent.intercept_.tolist()),
                                           rank=dict(weights=rank.coef_[0].tolist(), bias=float(rank.intercept_[0])),
                                           allThreshold=all_threshold, minimumScore=threshold, minimumMargin=margin)
                            best = (score, weights)
            evidence.append(dict(intentC=strength, rankC=rank_c, intentF1=float(f1_score(y[cal], ps[cal].argmax(axis=1), average='macro'))))
    out = Path(args[2]); out.mkdir(parents=True,exist_ok=True)
    (out/'meeting-v1.json').write_text(json.dumps(best[1])+'\n')
    (out/'validation.json').write_text(json.dumps(dict(samplesSha256=data['samplesSha256'],
            score=best[0], candidates=evidence, train=int(train.sum()), calibration=int(cal.sum()),
            selection='macro average exact recipient-set match by context kind; calibration families only'),indent=2)+'\n')
    print('selected validation exact-set score', best[0])


if __name__ == '__main__':
    with threadpool_limits(limits=4):
        main(sys.argv[1:])
