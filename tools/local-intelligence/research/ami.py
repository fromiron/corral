#!/usr/bin/env python3
"""Sealed human-annotated addressee diagnostic; source AMI 1.6.2, CC BY 4.0."""
import argparse
from collections import defaultdict
import hashlib
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET
import zipfile

NS='{http://nite.sourceforge.net/}'
ELICIT={'ami_da_5','ami_da_8','ami_da_11','ami_da_13'}
ROLES={'PM':'project manager','UI':'user interface designer','ME':'marketing expert','ID':'industrial designer'}

def session_group(meeting):return 'ami-team-'+re.sub(r'[a-z]$','',meeting)

def visible_history(acts,current):
    return [a for a in acts if a['id']!=current['id'] and a['end']<=current['start']][-16:]

def parse(archive):
    z=zipfile.ZipFile(archive);meetings=defaultdict(list);words={};profiles={}
    for meeting in ET.fromstring(z.read('corpusResources/meetings.xml')):
        profiles[meeting.get('observation')]={s.get('nxt_agent'):ROLES.get(s.get('role'),'meeting participant') for s in meeting}
    for path in z.namelist():
        if not path.startswith('dialogueActs/') or not path.endswith('.xml'):continue
        meeting,speaker=Path(path).name.split('.')[:2]
        for d in ET.fromstring(z.read(path)):
            selected=[]
            for child in d.findall(NS+'child'):
                name,fragment=child.get('href').split('#',1);wordpath='words/'+name
                if wordpath not in words:
                    entries=list(ET.fromstring(z.read(wordpath)));words[wordpath]=(entries,{w.get(NS+'id'):i for i,w in enumerate(entries)})
                entries,index=words[wordpath];ids=re.findall(r'id\(([^)]+)\)',fragment)
                selected.extend(entries[index[ids[0]]:index[ids[-1]]+1])
            text=' '.join(w.text for w in selected if w.tag=='w' and w.text)
            timed=[w for w in selected if w.get('starttime') and w.get('endtime')]
            if not timed or not text.strip():continue
            pointer=d.find(NS+'pointer');kind=re.search(r'id\(([^)]+)\)',pointer.get('href','')).group(1) if pointer is not None else ''
            meetings[meeting].append({'id':d.get(NS+'id'),'speaker':speaker,'start':min(float(w.get('starttime')) for w in timed),
                'end':max(float(w.get('endtime')) for w in timed),'text':text,'kind':kind,'addressee':d.get('addressee','').split(',')})
    rows=[]
    for meeting,acts in meetings.items():
        acts.sort(key=lambda a:(a['start'],a['end'],a['id']))
        people=sorted(set(a['speaker'] for a in acts))
        for current in acts:
            # Multi-address labels mean addressed-to, not that everyone must answer.
            # The diagnostic deliberately uses only elicitation to one human addressee.
            target=current['addressee']
            if current['kind'] not in ELICIT or len(target)!=1 or target[0] not in people or target[0]==current['speaker'] or len(current['text'].split())<4:continue
            history=visible_history(acts,current)
            if len(history)<4:continue
            others=[p for p in people if p!=current['speaker']];mapping={p:f'p{i+1}' for i,p in enumerate(others)}
            x={'participants':[{'id':mapping[p],'name':'Participant '+p,'role':profiles.get(meeting,{}).get(p,'')} for p in others],
                'turns':[{'id':f't{i+1}','speakerId':mapping.get(a['speaker']),'text':a['text'],'replyTo':''} for i,a in enumerate(history)],'message':current['text']}
            rows.append({'id':'ami-'+hashlib.sha256(current['id'].encode()).hexdigest()[:20],'group':session_group(meeting),'task':'meeting','language':'en','input':x,
                'target':{'mode':'one','eligibleIds':[mapping[target[0]]],'excludedIds':[],'evidence':'AMI human addressee annotation on elicitation'},
                'source':{'corpus':'AMI manual 1.6.2','license':'CC-BY-4.0','meeting':meeting,'act':current['id'],'rater':'AMI human annotator'},'split':'final'})
    return rows

def main():
    p=argparse.ArgumentParser();p.add_argument('--zip',required=True);p.add_argument('--out',required=True);a=p.parse_args();out=Path(a.out)
    if out.exists():raise ValueError('sealed diagnostic exists')
    rows=parse(a.zip);out.mkdir(parents=True,mode=0o700)
    text=''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in rows);(out/'raw-final.jsonl').write_text(text)
    manifest={'source':'https://groups.inf.ed.ac.uk/ami/download/','license':'https://groups.inf.ed.ac.uk/ami/corpus/license.shtml',
        'archiveSha256':hashlib.file_digest(open(a.zip,'rb'),'sha256').hexdigest(),'count':len(rows),'groups':len(set(r['group'] for r in rows)),
        'sha256':hashlib.sha256(text.encode()).hexdigest(),'scope':'English human single-addressee elicitation diagnostic, not full Corral dispatch truth. Annotation can use nonverbal evidence absent from text. Public pretraining overlap unknown.',
        'modifications':'speaker IDs remapped; current speaker treated as user; only completed prior acts; last16 acts; no future responses; no demographic attributes'}
    (out/'manifest.json').write_text(json.dumps(manifest,indent=2))
    for f in out.iterdir():f.chmod(0o600)
    print(json.dumps({k:manifest[k] for k in ['count','groups','archiveSha256','scope']}))

if __name__=='__main__':main()
