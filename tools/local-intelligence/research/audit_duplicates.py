#!/usr/bin/env python3
"""Near-duplicate hygiene only. Does not train or evaluate a candidate on sealed labels."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import unicodedata
from sklearn.feature_extraction.text import TfidfVectorizer

def content(row):
    x=row['input']
    if row['task']=='meeting':
        text='\n'.join([p['role'] for p in x['participants']]+[str(t['speakerId'])+':'+t['text'] for t in x['turns']]+[x['message']])
        for p in sorted(x['participants'],key=lambda p:-len(p['name'])):
            if p['name']:text=text.replace(p['name'],p['id'])
    else:
        text='\n'.join([x.get(k,'') for k in ['goal','request','previousRequest','previousReply','plan']]+[t['content'] for t in x.get('tools',[])])
    return re.sub(r'\s+',' ',unicodedata.normalize('NFKC',text)).strip().lower()

def main():
    p=argparse.ArgumentParser();p.add_argument('--data',required=True);p.add_argument('--out',required=True)
    p.add_argument('--threshold',type=float,default=.94);a=p.parse_args();source=Path(a.data);out=Path(a.out)
    if out.exists():raise ValueError('do not overwrite an audited snapshot')
    rows=[json.loads(line) for split in ['fit','calibration','policy','final'] for line in (source/f'{split}.jsonl').read_text().splitlines()]
    parents={r['group']:r['group'] for r in rows}
    def find(g):
        if parents[g]!=g:parents[g]=find(parents[g])
        return parents[g]
    pairs=[]
    for task in ['effort','meeting']:
        items=[r for r in rows if r['task']==task]
        if len(items)<2:continue
        x=TfidfVectorizer(analyzer='char_wb',ngram_range=(3,5),min_df=2,sublinear_tf=True).fit_transform([content(r) for r in items])
        similarities=(x@x.T).tocoo()
        for i,j,score in zip(similarities.row,similarities.col,similarities.data):
            if i>=j or score<a.threshold or items[i]['group']==items[j]['group']:continue
            l,r=items[i],items[j];ga,gb=find(l['group']),find(r['group'])
            if ga!=gb:parents[max(ga,gb)]=min(ga,gb)
            pairs.append({'left':l['id'],'right':r['id'],'similarity':float(score),'crossSplit':l['split']!=r['split']})
    splits={}
    for r in rows:splits.setdefault(find(r['group']),set()).add(r['split'])
    quarantined={g for g,s in splits.items() if len(s)>1}
    out.mkdir(parents=True,mode=0o700)
    manifest=json.loads((source/'manifest.json').read_text());manifest['sourceManifestSha256']=hashlib.sha256((source/'manifest.json').read_bytes()).hexdigest()
    manifest['nearDuplicateAudit']={'threshold':a.threshold,'pairs':len(pairs),'crossSplitComponents':len(quarantined),'method':'char_wb TF-IDF 3-5gram, normalized names; hygiene features never reused for model fitting'}
    kept=[{**r,'group':find(r['group'])} for r in rows if find(r['group']) not in quarantined]
    for split in ['fit','calibration','policy','final']:
        selected=[r for r in kept if r['split']==split];text=''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in selected)
        (out/f'{split}.jsonl').write_text(text);manifest['splits'][split]={'count':len(selected),'sha256':hashlib.sha256(text.encode()).hexdigest()}
    manifest['total']=len(kept);manifest['groups']=len(set(r['group'] for r in kept));manifest['quarantined']=len(rows)-len(kept)
    (out/'manifest.json').write_text(json.dumps(manifest,indent=2));(out/'duplicate-pairs.json').write_text(json.dumps(pairs,indent=2))
    for f in out.iterdir():f.chmod(0o600)
    print(json.dumps(manifest['nearDuplicateAudit']|{'kept':len(kept),'quarantinedRows':len(rows)-len(kept)}))

if __name__=='__main__':main()
