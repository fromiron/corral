"""Deterministic local checks with no network or access to the user's home directory."""
import json
from pathlib import Path
import re
import subprocess
import time

def write_files(root,files,prefix):
    root=Path(root).resolve();root.mkdir(parents=True,exist_ok=True)
    for f in files:
        if not f['path'].startswith(prefix):raise ValueError('unexpected generated file prefix')
        path=(root/f['path']).resolve()
        if not path.is_relative_to(root) or '..' in Path(f['path']).parts:raise ValueError('generated path escapes trial')
        path.parent.mkdir(parents=True,exist_ok=True);path.write_text(f['content'])

PY_RUNNER='''import sys,unittest,json
sys.path.insert(0,"/work")
suite=unittest.defaultTestLoader.discover("/work/tests")
result=unittest.TextTestRunner(verbosity=1).run(suite)
print("CORRAL_EVAL_RESULT="+json.dumps({"run":result.testsRun,"failures":len(result.failures),"errors":len(result.errors),"skipped":len(result.skipped)}))
sys.exit(0 if result.wasSuccessful() and result.testsRun>0 and not result.skipped else 1)
'''

def grade(case,files,work):
    work=Path(work).resolve();work.mkdir(parents=True,exist_ok=True)
    allowed={f['path'] for f in case['files']}
    if any(f['path'] not in allowed for f in files):raise ValueError('worker edited a non-source path')
    merged={f['path']:f['content'] for f in case['files']}
    merged.update({f['path']:f['content'] for f in files})
    write_files(work,[{'path':k,'content':v} for k,v in merged.items()],'src/')
    write_files(work,case['tests'],'tests/')
    cmd=['bwrap','--unshare-net','--unshare-pid','--unshare-ipc','--unshare-uts','--die-with-parent','--ro-bind','/usr','/usr',
         '--symlink','usr/lib','/lib','--symlink','usr/lib','/lib64','--proc','/proc','--dev','/dev',
         '--tmpfs','/tmp','--bind',str(work),'/work','--ro-bind',str(work/'tests'),'/work/tests','--chdir','/work']
    if case['language']=='python':cmd+=['/usr/bin/python','-I','-c',PY_RUNNER]
    else:cmd+=['/usr/bin/node','--test','--test-reporter=tap']+[f['path'] for f in case['tests']]
    started=time.monotonic()
    try:
        result=subprocess.run(cmd,env={'PATH':'/usr/bin','LANG':'C.UTF-8','PYTHONDONTWRITEBYTECODE':'1'},capture_output=True,text=True,timeout=20)
        stdout=result.stdout;stderr=result.stderr
        if case['language']=='python':
            match=re.findall(r'^CORRAL_EVAL_RESULT=(.*)$',stdout,re.M)
            observed=json.loads(match[-1]) if match else None
            passed=bool(result.returncode==0 and observed and observed['run']>0 and not observed['skipped'])
        else:
            runs=re.findall(r'^# tests (\d+)$',stdout,re.M);fail=re.findall(r'^# fail (\d+)$',stdout,re.M);skipped=re.findall(r'^# skipped (\d+)$',stdout,re.M)
            observed={'run':int(runs[-1]),'failures':int(fail[-1]),'skipped':int(skipped[-1])} if runs and fail and skipped else None
            passed=bool(result.returncode==0 and observed and observed['run']>0 and observed['failures']==0 and observed['skipped']==0)
        outcome={'passed':passed,'exitCode':result.returncode,'observed':observed,'seconds':time.monotonic()-started}
        (work/'stdout.log').write_text(stdout);(work/'stderr.log').write_text(stderr)
    except subprocess.TimeoutExpired:
        outcome={'passed':False,'reason':'timeout','seconds':time.monotonic()-started}
    (work/'grade.json').write_text(json.dumps(outcome,indent=2));return outcome

def validate_corpus(root):
    root=Path(root)
    for source in sorted((root/'outcomes/author').glob('*/cases.json')):
        for case in json.loads(source.read_text())['cases']:
            out=root/'outcomes/validated'/case['id'];out.mkdir(parents=True,exist_ok=True)
            if (out/'receipt.json').exists():continue
            reference=grade(case,case['referenceFiles'],out/'reference')
            buggy=grade(case,case['files'],out/'buggy')
            receipt={'id':case['id'],'valid':reference['passed'] and not buggy['passed'],'reference':reference,'buggy':buggy}
            (out/'receipt.json').write_text(json.dumps(receipt,indent=2))
            if receipt['valid']:(out/'case.json').write_text(json.dumps(case,ensure_ascii=False,indent=2))
            print(json.dumps(receipt),flush=True)

if __name__=='__main__':
    import sys
    validate_corpus(sys.argv[1])
