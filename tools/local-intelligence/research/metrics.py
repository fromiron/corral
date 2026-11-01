"""Task metrics distinguish valid alternative responders from exact singleton labels."""
import numpy as np

LEVELS=['low','medium','high','xhigh']
MODES=['one','set','all','none']

def valid_dispatch(ids,target):
    ids=set(ids)
    if ids & set(target['excludedIds']):return False
    if target['mode']=='none':return not ids
    if target['mode']=='one':return len(ids)==1 and ids<=set(target['eligibleIds'])
    return ids==set(target['eligibleIds'])

def decode_meeting(p,eligible=.5,excluded=.5,mode_confidence=.6):
    modes=np.asarray(p['mode']);mode=MODES[int(modes.argmax())]
    candidates=[i for i,x in enumerate(p['excluded']) if x<excluded]
    if mode=='none' and modes.max()>=mode_confidence:return []
    # A semantic exclusion model is not a source of explicit UI constraints. If it excludes
    # everybody without a confident none, retain the least-excluded candidate as fallback.
    if not candidates:candidates=[int(np.argmin(p['excluded']))]
    best=max(candidates,key=lambda i:(p['eligible'][i],-i))
    if modes.max()<mode_confidence or mode=='one':return [p['ids'][best]]
    if mode=='all':return [p['ids'][i] for i in candidates]
    selected=[p['ids'][i] for i in candidates if p['eligible'][i]>=eligible]
    return selected or [p['ids'][best]]

def effort_metrics(rows,predictions):
    lookup={p['id']:p for p in predictions}
    y=np.array([LEVELS.index(r['target']['level']) for r in rows]);p=np.array([lookup[r['id']]['probabilities'] for r in rows])
    z=p.argmax(1)
    return {'n':len(y),'accuracy':float((z==y).mean()),'levelError':float(abs(z-y).mean()),
            'severeUnder':int(((z==0)&(y>=2)).sum()),'severeOver':int(((y==0)&(z>=2)).sum()),
            'predictedCounts':np.bincount(z,minlength=4).tolist(),'targetCounts':np.bincount(y,minlength=4).tolist()}

def meeting_metrics(rows,predictions,**policy):
    lookup={p['id']:p for p in predictions};valid=forbidden=totalcalls=0;by_mode={}
    for r in rows:
        ids=decode_meeting(lookup[r['id']],**policy);ok=valid_dispatch(ids,r['target'])
        valid+=ok;forbidden+=bool(set(ids)&set(r['target']['excludedIds']));totalcalls+=len(ids)
        b=by_mode.setdefault(r['target']['mode'],{'n':0,'correct':0});b['n']+=1;b['correct']+=ok
    return {'n':len(rows),'validDispatch':valid/len(rows),'forbiddenDispatch':forbidden,'meanCalls':totalcalls/len(rows),'byMode':by_mode}
