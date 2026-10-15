#!/usr/bin/env python3
"""Validate the specification pack; this does NOT run Corral product tests.
Requires Python 3.10+ and jsonschema 4.x. No network access is needed.
"""
from __future__ import annotations
import argparse
import copy
import json
import re
from pathlib import Path
from urllib.parse import unquote
from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parents[1]
# Generated or third-party trees that are not part of the specification pack.
SKIP_DIRS = {'node_modules', 'dist', 'coverage', 'storybook-static', 'playwright-report', 'test-results', '.git'}
REPORT_PATH = ROOT / 'tests/pack-validation-report.json'
checks: list[str] = []

def load(path: str):
    return json.loads((ROOT / path).read_text(encoding='utf-8'))

def ok(condition: bool, label: str):
    if not condition:
        raise AssertionError(label)
    checks.append(label)

def structure(doc: dict):
    """A deliberately limited fixture checker, not the product compiler."""
    roles = {r['id']: r for r in doc['roles']}
    nodes = {n['id']: n for n in doc['nodes']}
    assert len(roles) == len(doc['roles']), 'duplicate role ID'
    assert len(nodes) == len(doc['nodes']), 'duplicate node ID'
    assert doc['entryNodeId'] in nodes
    assert nodes[doc['entryNodeId']]['type'] == 'agent'
    assert len([n for n in nodes.values() if n['type'] == 'loop']) <= 1
    assert any(n['type'] == 'output' for n in nodes.values())
    used = set()
    adj = {i: set() for i in nodes}
    ports_out = {'agent': {'out'}, 'decision': {'pass','revise','approve','reject','yes','no'}, 'loop': {'body','next'}, 'output': set()}
    ports_in = {'agent': {'in'}, 'decision': {'in'}, 'loop': {'enter','repeat','exit'}, 'output': {'in'}}
    for n in nodes.values():
        if n['type'] == 'agent':
            assert n['roleId'] in roles
        if 'loopId' in n:
            assert nodes[n['loopId']]['type'] == 'loop'
        for b in n.get('inputBindings', []):
            if 'sourceNodeId' in b:
                assert b['sourceNodeId'] in nodes
            if b['kind'] in ('task_output','previous_iteration_output'):
                assert 'sourceNodeId' in b
            if b['kind'] == 'explicit_version':
                assert 'artifactVersionId' in b
    for e in doc['controlEdges']:
        s,t = nodes[e['source']],nodes[e['target']]
        assert e['sourcePort'] in ports_out[s['type']]
        assert e['targetPort'] in ports_in[t['type']]
        port = (e['source'],e['sourcePort'])
        assert port not in used, 'duplicate control port edge'
        used.add(port)
        assert s.get('invocation') != 'callable' and t.get('invocation') != 'callable'
        adj[e['source']].add(e['target'])
    for link in doc['capabilityLinks']:
        s,t = nodes[link['sourceNodeId']],nodes[link['targetNodeId']]
        assert s['type'] == t['type'] == 'agent'
        assert t['invocation'] == 'callable'
        tool = 'ask' if link['kind'] == 'question' else 'spawn_subagents'
        assert tool in roles[s['roleId']]['allowedCollaborationTools']
        adj[s['id']].add(t['id'])
    visited, stack = set(), [doc['entryNodeId']]
    while stack:
        n = stack.pop()
        if n in visited: continue
        visited.add(n)
        stack.extend(adj[n] - visited)
    assert visited == set(nodes), f'unreachable nodes: {set(nodes)-visited}'
    # Validate the explicit review-loop boundary in this example.
    for n in nodes.values():
        if n['type'] != 'loop': continue
        loopid = n['id']
        for e in doc['controlEdges']:
            s,t = nodes[e['source']],nodes[e['target']]
            if s.get('loopId') == loopid and t.get('loopId') != loopid:
                assert t['id'] == loopid and e['targetPort'] in ('repeat','exit')
            if t.get('loopId') == loopid and s.get('loopId') != loopid:
                assert s['id'] == loopid and e['sourcePort'] == 'body'


def main():
    req=load('contracts/requirements.json'); tasks=load('contracts/backlog.json')
    tests=load('tests/test-catalog.json'); trace=load('tests/traceability.json')
    reqids={r['id'] for r in req}; taskids={t['id'] for t in tasks}; testids={t['id'] for t in tests}
    ok(len(reqids)==len(req),'requirement IDs unique')
    ok(len(taskids)==len(tasks),'task IDs unique')
    ok(len(testids)==len(tests),'test scenario IDs unique')
    for task in tasks:
        ok(set(task['requirements']) <= reqids, task['id']+' requirement references')
        ok(set(task['dependsOn']) <= taskids, task['id']+' dependency references')
    completed=set()
    while len(completed)<len(tasks):
        nxt={t['id'] for t in tasks if set(t['dependsOn'])<=completed}-completed
        if not nxt: raise AssertionError('backlog dependency cycle')
        completed |= nxt
    ok(True,'backlog dependency graph acyclic')
    for test in tests:
        ok(set(test['requirements']) <= reqids, test['id']+' requirement references')
        ok(test['status']=='planned', test['id']+' not falsely marked passed')
    rows={r['requirementId']:r for r in trace}
    ok(set(rows)==reqids,'traceability covers every requirement')
    for rid,row in rows.items():
        ok(bool(row['tests']) and set(row['tests'])<=testids,rid+' test coverage mapping')
        ok(bool(row['tasks']) and set(row['tasks'])<=taskids,rid+' task coverage mapping')
    schemas={p.stem:json.loads(p.read_text()) for p in (ROOT/'contracts').glob('*.schema.json')}
    for name,schema in schemas.items():
        Draft202012Validator.check_schema(schema)
        ok(True,name+' JSON Schema syntax')
    def validate(key,obj):
        Draft202012Validator(schemas[key],format_checker=FormatChecker()).validate(obj)
    doc=load('examples/research-team.corral.json')
    validate('corral-definition.schema',doc); ok(True,'research team schema valid')
    structure(doc); ok(True,'research team static fixture checks')
    for cmd in load('examples/commands.json'):
        validate('command.schema',cmd); ok(True,cmd['commandId']+' command fixture schema')
    for name in ['review-revise','review-pass']:
        validate('review.schema',load('examples/'+name+'.json')); ok(True,name+' fixture schema')
    # Negative schema checks: none of these run a product runtime.
    mutated=copy.deepcopy(doc);mutated['nodes'][0]['type']='shell'
    ok(not Draft202012Validator(schemas['corral-definition.schema']).is_valid(mutated),'unknown node type rejected')
    mutated=copy.deepcopy(doc);mutated['limits']['maxDelegationDepth']=3
    ok(not Draft202012Validator(schemas['corral-definition.schema']).is_valid(mutated),'depth 3 rejected by definition schema')
    invalid=copy.deepcopy(load('examples/commands.json')[2]);invalid['payload']['allowedTools']=['shell']
    ok(not Draft202012Validator(schemas['command.schema']).is_valid(invalid),'permission expansion not a valid patch')
    invalid=load('examples/review-revise.json');invalid['issues']=[]
    ok(not Draft202012Validator(schemas['review.schema']).is_valid(invalid),'revise without issues rejected')
    mutated=copy.deepcopy(doc);mutated['nodes'][0]['roleId']='missing'
    try: structure(mutated)
    except (AssertionError,KeyError): ok(True,'missing role rejected by fixture checker')
    else: raise AssertionError('missing role not rejected')
    layout=load('examples/research-team.layout.json')
    ok(set(layout['nodes'])=={n['id'] for n in doc['nodes']},'layout and definition node IDs match')
    # Local Markdown links and fenced-block pairing.
    for p in ROOT.rglob('*.md'):
        if p.name in ['Corral-Complete.md']: continue
        if SKIP_DIRS.intersection(p.relative_to(ROOT).parts): continue
        text=p.read_text(encoding='utf-8')
        lines=text.splitlines()
        for ix,line in enumerate(lines):
            if line.startswith('|') and (ix==0 or not lines[ix-1].startswith('|')) and ix+1<len(lines):
                if lines[ix+1].startswith('|'):
                    ok(bool(re.fullmatch(r'[| :\-]+',lines[ix+1])),str(p.relative_to(ROOT))+' table separator at '+str(ix+1))
        ok(sum(1 for line in text.splitlines() if line.startswith('```'))%2==0,str(p.relative_to(ROOT))+' code fences paired')
        for link in re.findall(r'\[[^\]]*\]\(([^)]+)\)',text):
            if re.match(r'^(?:https?:|mailto:|#)',link): continue
            clean=unquote(link.split('#')[0])
            if clean: ok((p.parent/clean).exists(),str(p.relative_to(ROOT))+' link '+clean)
    report={
        'type':'documentation-pack-validation', 'requirements':len(req),'tasks':len(tasks),'plannedTestScenarios':len(tests),
        'checksPassed':len(checks),'result':'PASS','checks':checks,
        'notExecuted':['Corral application','Pi/LangGraph integration','product unit/contract/e2e tests','provider API calls','performance targets'],
        'meaning':'Only schemas, sample data, references and document consistency were checked.'}
    REPORT_PATH.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({k:v for k,v in report.items() if k!='checks'},ensure_ascii=False,indent=2))

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report',type=Path,default=ROOT/'tests/pack-validation-report.json',
                        help='where to write the JSON report (default: tests/pack-validation-report.json)')
    REPORT_PATH=parser.parse_args().report
    main()
