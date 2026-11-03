#!/usr/bin/env python3
"""Hard coding tasks through the real Corral path. Hidden tests grade, and each stage is a live spend."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import random
import shlex
import shutil
import signal
import subprocess
import sys
import threading
import time

from run import digest, save
import sandbox

HERE = Path(__file__).resolve().parent
RESEARCH = HERE.parent
CHECKOUT = HERE.parents[3]
MANIFEST = HERE / 'hard-tasks.json'
FROZEN = HERE / 'hard-set.json'
FROZEN_FILES = ('tools/local-intelligence/research/protocol.md',
                'tools/local-intelligence/research/coding_gate.py',
                'tools/local-intelligence/research/evaluation.py',
                'tools/local-intelligence/research/harness-validation/hard-tasks.json',
                'tools/local-intelligence/research/harness-validation/hard_run.py',
                'tools/local-intelligence/research/harness-validation/sandbox.py',
                'tools/local-intelligence/research/harness-validation/swe_report.py',
                'tools/local-intelligence/research/harness-validation/driver.ts',
                'tools/local-intelligence/research/harness-validation/worker-patch.ts')
TASKS_PER_KIND = 12
# 103GB were free before the images; layers shared between them make their listed sizes overcount.
FREE_BYTES_FLOOR = 43_000_000_000
EFFORTS = ('low', 'medium', 'high', 'xhigh')
# DeepSeek folds medium and xhigh into high, so stage D is context for the screen and never its evidence.
DEEPSEEK_EFFORTS = ('low', 'high', 'max')
DEEPSEEK = 'deepseek-v4.1-flash'
STAGE_MODELS = {'A': 'gpt-6.1-sol', 'B': 'gpt-6.1-sol', 'C': 'gpt-6-luna', 'D': DEEPSEEK}
PROVIDER = 'openai-codex'
SMOKE = {'provider': 'hive', 'model': 'deepseek-ai/deepseek-v4.1-flash-1017',
         'modelProviders': [{'id': 'hive', 'name': 'Hive', 'baseUrl': 'https://api-cdn.thehive.ai/api/v3',
                             'access': 'api_key',
                             # Reasoning counts as output, and on a hard task one response passed
                             # 16384 at low. The provider documents no maximum.
                             'models': [{'id': 'deepseek-ai/deepseek-v4.1-flash-1017',
                                         'maxOutput': 65536}]}]}
SMOKE_LIMITS = {'maxModelCalls': 30, 'maxOutputTokens': 32000, 'modelTimeoutMs': 180000,
                'runDeadlineMs': 900000}
# A stage run ends when the task does: high levels often pass any fixed count, and stopping there
# would read as a failed task. Only one call can time out, or one response reach the model's cap.
LIMITS = {'modelTimeoutMs': 300000}
# These end a runaway run, which then counts as unsettled and stops the stage for review.
REQUEST_GUARD = 1000
WALL_GUARD_MS = 6 * 3600 * 1000
SPENDING_LIMITS = {'model_calls', 'output_tokens', 'deadline'}
# What `timeout` returns when it ends a grader.
TIMED_OUT = {124, 137}
TEST_SECONDS = 600
EVAL_SECONDS = 1500
GUIDANCE = {
    'swe-bench-verified': 'The project environment is active and the working directory is the repository root.',
    'corral-commit': 'This is a pnpm TypeScript workspace with dependencies installed. Run tests with '
                     '`node node_modules/vitest/vitest.mjs run <paths>`.',
}


def file_hash(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def node_home():
    node = Path(os.environ.get('CORRAL_RESEARCH_NODE') or shutil.which('node')).resolve()
    return node.parent.parent


def command_env():
    return {**os.environ, 'PATH': f'{node_home()}/bin:{os.environ["PATH"]}'}


def commit_tree(directory):
    def git(*args):
        subprocess.run(['git', '-c', 'user.name=Hard Task', '-c', 'user.email=task@example.invalid',
                        '-C', str(directory), *args], check=True, capture_output=True)
    git('init', '-q')
    git('config', 'core.autocrlf', 'false')
    git('add', '-f', '.')
    git('commit', '-qm', 'hard task base')


def extract(commit, target):
    target.mkdir(parents=True, mode=0o700)
    archive = subprocess.Popen(['git', '-C', str(CHECKOUT), 'archive', commit], stdout=subprocess.PIPE)
    subprocess.run(['tar', '-x', '-C', str(target)], stdin=archive.stdout, check=True)
    if archive.wait() != 0:
        raise ValueError('commit archive failed')


def env_dir(root, task):
    return root / 'outcomes/hard/env' / task['id']


def hide_tests(task, env):
    """The commit's tests and the files beside them that they read, held back for grading."""
    tests = [path for path in task['tests'] if (env / 'fixed' / path).exists()]
    if not tests:
        raise ValueError('the commit keeps no test file')
    for path in [*tests, *task['support']]:
        if (env / 'fixed' / path).exists():
            target = env / 'hidden' / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(env / 'fixed' / path, target)
    return tests


def prepare_corral(root, task):
    env = env_dir(root, task)
    if not (env / 'ready.json').exists():
        shutil.rmtree(env, ignore_errors=True)
        install = env / 'deps'
        extract(task['parent'], install)
        subprocess.run(['pnpm', 'install', '--frozen-lockfile', '--prefer-offline'], cwd=install, check=True,
                       env=command_env(), capture_output=True)
        # CLI tests serve the built Studio and would otherwise try to build it with no pnpm in the sandbox.
        subprocess.run(['pnpm', '--filter', '@corral/studio', 'build'], cwd=install, check=True,
                       env=command_env(), capture_output=True)
        # What stays is only what the install made, so a file the worker deletes stays deleted.
        tracked = subprocess.run(['git', '-C', str(CHECKOUT), 'ls-tree', '-r', '--name-only', '-z', task['parent']],
                                 check=True, capture_output=True, text=True).stdout
        for path in filter(None, tracked.split('\0')):
            (install / path).unlink(missing_ok=True)
        extract(task['parent'], env / 'repo')
        commit_tree(env / 'repo')
        extract(task['commit'], env / 'fixed')
    save(env / 'ready.json', {'tests': hide_tests(task, env)})
    return env


def prepare_swe(root, task):
    env = env_dir(root, task)
    if (env / 'ready.json').exists():
        return env
    shutil.rmtree(env, ignore_errors=True)
    subprocess.run(['docker', 'pull', '-q', task['image']], check=True, capture_output=True)
    head = subprocess.run(['docker', 'run', '--rm', task['image'], 'bash', '-c',
                           'git config --global --add safe.directory /testbed; git -C /testbed rev-parse HEAD'],
                          check=True, capture_output=True, text=True).stdout.strip().splitlines()[-1]
    (env / 'repo').mkdir(parents=True, mode=0o700)
    archive = subprocess.Popen(['docker', 'run', '--rm', task['image'], 'bash', '-c',
                                'git config --global --add safe.directory /testbed; git -C /testbed archive HEAD'],
                               stdout=subprocess.PIPE)
    subprocess.run(['tar', '-x', '-C', str(env / 'repo')], stdin=archive.stdout, check=True)
    if archive.wait() != 0:
        raise ValueError('image archive failed')
    commit_tree(env / 'repo')
    save(env / 'ready.json', {'imageHead': head})
    return env


def grade_corral(root, task, tree, out):
    """Every test in the commit's test files, on its versions of them, in a no-network overlay."""
    env = env_dir(root, task)
    tests = json.loads((env / 'ready.json').read_text())['tests']
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True, mode=0o700)
    argv = [*sandbox.bwrap_prefix(str(node_home()), [env / 'deps', tree, env / 'hidden']),
            '--bind', str(out), '/out', 'timeout', '-k', '5', str(TEST_SECONDS), 'node',
            'node_modules/vitest/vitest.mjs', 'run', '--reporter=json', '--outputFile=/out/vitest.json', *tests]
    with (out / 'stdout.log').open('wb') as log:
        code = subprocess.run(argv, stdout=log, stderr=subprocess.STDOUT, check=False).returncode
    result = json.loads((out / 'vitest.json').read_text()) if (out / 'vitest.json').exists() else {}
    total, failed = result.get('numTotalTests', 0), result.get('numFailedTests', 0)
    return {'passed': code == 0 and total > 0 and failed == 0, 'exitCode': code,
            'tests': total, 'failed': failed, 'failedSuites': result.get('numFailedTestSuites', 0)}


def grade_swe(root, task, patch, out):
    """Apply the patch in the task's image, run its evaluation and take the official verdict."""
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True, mode=0o700)
    (out / 'patch.diff').write_bytes(patch)
    (out / 'eval.sh').write_text(f'#!/bin/bash\nset -uxo pipefail\n{task["evalScript"]}\n')
    script = ('cd /testbed && { [ ! -s /grade/patch.diff ] || git apply --verbose /grade/patch.diff; } '
              f'&& timeout -k 10 {EVAL_SECONDS} /bin/bash /grade/eval.sh')
    with (out / 'eval.log').open('wb') as log:
        code = subprocess.run([*sandbox.docker_prefix(out, '/grade'), task['image'], 'bash', '-c', script],
                              stdout=log, stderr=subprocess.STDOUT, check=False).returncode
    uv = ['uv', 'run', '--no-project', '--python', '3.12', '--with-requirements',
          str(HERE / 'swebench-requirements.txt'), 'python', '-I', str(HERE / 'swe_report.py'),
          str(root / 'outcomes/hard/tasks' / task['id'] / 'task.json'), str(out / 'eval.log')]
    report = json.loads(subprocess.run(uv, check=True, capture_output=True, text=True).stdout.splitlines()[-1])
    return {'passed': bool(report['resolved']), 'exitCode': code, **report}


def reference_patch(task):
    """The commit without what grading holds back, the way a worker's patch arrives."""
    def diff(*args):
        return subprocess.run(['git', '--literal-pathspecs', '-C', str(CHECKOUT), 'diff', '--no-renames',
                               task['parent'], task['commit'], *args], check=True, capture_output=True).stdout

    held = {*task['tests'], *task['support']}
    paths = [path for path in diff('--name-only', '-z').decode().split('\0') if path and path not in held]
    return diff('--binary', '--', *paths) if paths else b''


def grade_patch(root, task, patch, tree, out):
    """A patch on the starting code with the held-back tests, the path every submission takes."""
    shutil.rmtree(tree, ignore_errors=True)
    subprocess.run(['git', 'clone', '-q', str(env_dir(root, task) / 'repo'), str(tree)], check=True,
                   capture_output=True)
    if patch:
        applied = subprocess.run(['git', '-C', str(tree), 'apply', '--binary', '-'], input=patch,
                                 capture_output=True, check=False)
        if applied.returncode:
            return {'passed': False, 'reason': 'patch did not apply'}
    shutil.rmtree(tree / '.git')
    return grade_corral(root, task, tree, out)


def has_verdict(grade):
    """A failing test or a suite the worker broke is a verdict; a grader that never got there is not."""
    return not (grade.get('infraFailure') or grade.get('exitCode') in TIMED_OUT
                or grade.get('reason') == 'patch did not apply'
                or (grade.get('tests') == 0 and not grade.get('failedSuites')))


def preflight(root, task):
    """The reference must pass and the starting code must fail before the task can spend anything."""
    out = root / 'outcomes/hard/preflight' / task['id']
    receipt_path = out / 'receipt.json'
    if receipt_path.exists():
        receipt = json.loads(receipt_path.read_text())
        if receipt.get('taskHash') == digest(task):
            return receipt
    if task['kind'] == 'swe-bench-verified':
        prepare_swe(root, task)
        reference = grade_swe(root, task, task['goldPatch'].encode(), out / 'reference')
        start = grade_swe(root, task, b'', out / 'start')
        repeat = reference
    else:
        prepare_corral(root, task)
        patch, tree = reference_patch(task), out / 'graded-tree'
        reference = grade_patch(root, task, patch, tree, out / 'reference')
        repeat = grade_patch(root, task, patch, tree, out / 'reference-repeat')
        start = grade_patch(root, task, b'', tree, out / 'start')
        shutil.rmtree(tree, ignore_errors=True)
    receipt = {'id': task['id'], 'taskHash': digest(task), 'reference': reference, 'repeat': repeat, 'start': start,
               'valid': reference['passed'] and repeat['passed'] and not start['passed'] and has_verdict(start)}
    save(receipt_path, receipt)
    return receipt


def check_argv(root, task):
    """One executable, because a registered check may name no file outside the worktree."""
    env = env_dir(root, task)
    target = (['swe', task['image']] if task['kind'] == 'swe-bench-verified'
              else ['corral', str(env / 'deps'), str(node_home())])
    launcher = env / 'sandbox-check'
    words = shlex.join([sys.executable, '-I', str(HERE / 'sandbox.py'), *target])
    launcher.write_text(f'#!/bin/sh\nexec {words}\n')
    launcher.chmod(0o700)
    return [str(launcher)]


def worker_input(task, repository, check, options):
    return {'id': task['id'], 'request': task['request'], 'repository': str(repository),
            'guidance': GUIDANCE[task['kind']],
            'check': {'argv': check, 'timeoutMs': (sandbox.SECONDS + 30) * 1000}, 'options': options}


def trial_dir(root, task, model, effort):
    return root / 'outcomes/hard/trials' / model / task['id'] / effort


def guards(limits):
    calls = limits.get('maxModelCalls')
    return {'physicalRequests': calls * 2 if calls else REQUEST_GUARD,
            'wallMs': limits.get('runDeadlineMs', WALL_GUARD_MS)}


def run_events(out):
    path = out / 'events.jsonl'
    return list(map(json.loads, path.read_text().splitlines())) if path.exists() else []


def spent_a_limit(out):
    return any((event.get('type') == 'limit.reached'
                and event['payload'].get('limitKind') in SPENDING_LIMITS)
               or (event.get('type') == 'cancel.requested'
                   and event['payload'].get('reason') == 'model_request_timeout') for event in run_events(out))


def made_no_progress(out):
    return any(event.get('type') == 'limit.reached' and event['payload'].get('limitKind') == 'no_progress'
               for event in run_events(out))


def ended_on_a_cut_response(out):
    path = out / 'stop-reasons.jsonl'
    stops = path.read_text().splitlines() if path.exists() else []
    return bool(stops) and json.loads(stops[-1]) == 'length'


def settled_state(out, result):
    """A provider failure, a host failure or a limit of any kind says nothing about the task."""
    if not result or (out / 'provider-error.json').exists():
        return 'invalid'
    stopped = result.get('status') == 'cancelled' and not made_no_progress(out)
    return 'limited' if stopped or spent_a_limit(out) or ended_on_a_cut_response(out) else 'complete'


def graded_state(state, grade):
    return 'invalid' if state == 'complete' and not has_verdict(grade) else state


def worker_patch(out):
    path = out / 'patch.diff'
    return path.read_bytes() if path.exists() else b''


def final_grade(root, task, out):
    patch = worker_patch(out)
    if task['kind'] == 'swe-bench-verified':
        return grade_swe(root, task, patch, out / 'grade')
    return grade_patch(root, task, patch, out / 'graded-tree', out / 'grade')


def same_run(receipt, task):
    """A receipt counts only for the task and driver it ran."""
    return (receipt.get('taskHash') == digest(task)
            and receipt.get('driverHash') == file_hash(HERE / 'driver.ts'))


def refuse_a_stale_receipt(root, task, model, effort):
    path = trial_dir(root, task, model, effort) / 'receipt.json'
    if path.exists() and not same_run(json.loads(path.read_text()), task):
        raise ValueError(f'{task["id"]} {effort}: the receipt is from another task or driver; set it aside')


def receipt_state(root, task, model, effort):
    path = trial_dir(root, task, model, effort) / 'receipt.json'
    if not path.exists():
        return 'unsettled'
    receipt = json.loads(path.read_text())
    return receipt['state'] if same_run(receipt, task) else 'stale'


def product_state(base=CHECKOUT):
    """The product a run loads, since the driver imports it from this checkout."""
    def git(*args):
        return subprocess.run(['git', '-C', str(base), *args], check=True, capture_output=True,
                              text=True).stdout.strip()

    return {'productRevision': git('rev-parse', 'HEAD'),
            'productDirty': bool(git('status', '--porcelain', '--untracked-files=no'))}


def require_committed(product):
    if product['productDirty']:
        raise ValueError('commit the tracked changes first: a run loads its code from this checkout')


def trial(root, task, model, effort, limits, check, provider=None):
    out = trial_dir(root, task, model, effort)
    out.mkdir(parents=True, exist_ok=True, mode=0o700)
    receipt_path = out / 'receipt.json'
    if receipt_path.exists():
        refuse_a_stale_receipt(root, task, model, effort)
        return json.loads(receipt_path.read_text())
    if (out / 'started.json').exists():
        return {'id': task['id'], 'model': model, 'effort': effort, 'state': 'unsettled', 'passed': False}
    options = {**(provider or {'provider': PROVIDER, 'model': model}), 'limits': limits, **guards(limits)}
    save(out / 'worker-input.json', worker_input(task, env_dir(root, task) / 'repo', check, options))
    request = {'id': task['id'], 'model': model, 'effort': effort, 'startedAt': time.time(),
               'taskHash': digest(task), 'driverHash': file_hash(HERE / 'driver.ts'), **product_state()}
    save(out / 'started.json', request)
    run_root = root / 'runs/hard' / model / task['id'] / effort
    command = [os.environ.get('CORRAL_RESEARCH_NODE', 'node'), str(HERE / 'driver.ts'),
               str(out / 'worker-input.json'), str(out), str(run_root), effort]
    started = time.monotonic()
    with (out / 'stdout.log').open('w') as stdout, (out / 'stderr.log').open('w') as stderr:
        process = subprocess.Popen(command, stdout=stdout, stderr=stderr, start_new_session=True)
        try:
            process.wait(timeout=guards(limits)['wallMs'] / 1000 + 120)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
    result_path = out / 'harness.json'
    result = json.loads(result_path.read_text()) if result_path.exists() else {}
    grade = final_grade(root, task, out) if result else {'passed': False, 'reason': 'no result'}
    state = graded_state(settled_state(out, result), grade)
    usage = [row['normalized'] for row in result.get('usage', [])]
    receipt = {**request, 'completedAt': time.time(), 'elapsedSeconds': time.monotonic() - started,
               'exitCode': process.returncode, 'state': state, 'status': result.get('status'),
               'passed': bool(state == 'complete' and result.get('status') == 'succeeded'
                              and result.get('wireVerified') and grade['passed']),
               'grade': grade, 'wallSeconds': result.get('wallMs', 0) / 1000,
               'physicalProviderRequests': result.get('physicalProviderRequests', 0),
               'totalTokens': sum((row['inputTokens'] or 0) + (row['outputTokens'] or 0) for row in usage),
               'usage': usage}
    save(receipt_path, receipt)
    return receipt


def freeze(root, manifest):
    """The first tasks of each kind that pass preflight, in the content-only order."""
    chosen = {'swe-bench-verified': [], 'corral-commit': []}
    rejected = []
    for record in manifest['order']:
        if len(chosen[record['kind']]) == TASKS_PER_KIND:
            continue
        task = json.loads((root / 'outcomes/hard/tasks' / record['id'] / 'task.json').read_text())
        receipt = preflight(root, task)
        print(json.dumps({'id': task['id'], 'valid': receipt['valid']}), flush=True)
        if receipt['valid']:
            chosen[record['kind']].append(task['id'])
        else:
            rejected.append(task['id'])
    if shutil.disk_usage(root).free < FREE_BYTES_FLOOR:
        raise ValueError('the images leave too little disk')
    swe, corral = chosen['swe-bench-verified'], chosen['corral-commit']
    return {'version': 1, 'limits': LIMITS, 'efforts': list(EFFORTS),
            'deepseekEfforts': list(DEEPSEEK_EFFORTS),
            'stages': {'A': swe[:3] + corral[:3], 'B': swe + corral, 'C': swe[:6] + corral[:6],
                       'D': swe[:3] + corral[:3]},
            'rejectedByPreflight': rejected,
            'hashes': {path: file_hash(CHECKOUT / path) for path in FROZEN_FILES}}


def verify_frozen(frozen, base=CHECKOUT):
    for path, expected in frozen['hashes'].items():
        if file_hash(Path(base) / path) != expected:
            raise ValueError(f'{path} changed since the freeze')


def stage_plan(frozen, stage, model):
    if STAGE_MODELS.get(stage) != model:
        raise ValueError('this stage does not run on this model')
    return frozen['stages'][stage]


def stage_levels(stage):
    return DEEPSEEK_EFFORTS if stage == 'D' else EFFORTS


def stage_provider(stage):
    return SMOKE if stage == 'D' else None


def left_to_run(root, task, model, effort):
    """A run started and not finished belongs to the process that started it."""
    out = trial_dir(root, task, model, effort)
    return (out / 'receipt.json').exists() or not (out / 'started.json').exists()


def run_plan(plan, run, jobs):
    """Runs start in plan order. An unsettled run starts no more, and those under way finish."""
    remaining = iter(plan)
    lock = threading.Lock()
    halted = threading.Event()
    results = []

    def work():
        while not halted.is_set():
            with lock:
                item = next(remaining, None)
            if item is None:
                return
            try:
                result = run(*item)
            except BaseException:
                halted.set()
                raise
            results.append(result)
            if result['state'] != 'complete':
                halted.set()

    with ThreadPoolExecutor(jobs) as pool:
        for future in [pool.submit(work) for _ in range(jobs)]:
            future.result()
    return results


def frozen_task(root, task_id, recorded):
    task = json.loads((root / 'outcomes/hard/tasks' / task_id / 'task.json').read_text())
    if digest(task) != recorded[task_id]:
        raise ValueError(f'{task_id} differs from the manifest')
    return task


def live(root, stage, model, jobs=1):
    frozen = json.loads(FROZEN.read_text())
    verify_frozen(frozen)
    require_committed(product_state())
    recorded = {record['id']: record['taskSha256'] for record in json.loads(MANIFEST.read_text())['order']}
    plan = []
    for task_id in stage_plan(frozen, stage, model):
        task = frozen_task(root, task_id, recorded)
        efforts = list(stage_levels(stage))
        random.Random(f'{task_id}:{model}:hard-v1').shuffle(efforts)
        for effort in efforts:
            refuse_a_stale_receipt(root, task, model, effort)
        plan += [(task, effort) for effort in efforts if jobs == 1 or left_to_run(root, task, model, effort)]

    def run(task, effort):
        result = trial(root, task, model, effort, frozen['limits'], check_argv(root, task),
                       stage_provider(stage))
        print(json.dumps({key: result.get(key) for key in ('id', 'effort', 'state', 'passed', 'wallSeconds')}),
              flush=True)
        return result

    results = run_plan(plan, run, jobs)
    if any(result['state'] != 'complete' for result in results):
        raise RuntimeError('a run did not settle; review it before spending more')
    return results


def level_report(rows, levels):
    passed = {(row['task'], row['effort']) for row in rows if row['state'] == 'complete' and row['passed']}
    tasks = sorted({row['task'] for row in rows})
    summary = {level: {'runs': sum(row['effort'] == level for row in rows),
                       'passed': sum(key[1] == level for key in passed),
                       'wallSeconds': sum(row['wallSeconds'] for row in rows if row['effort'] == level),
                       'totalTokens': sum(row['totalTokens'] for row in rows if row['effort'] == level)}
               for level in levels}
    only = {level: [task for task in tasks if (task, level) in passed
                    and not any((task, other) in passed for other in levels if other != level)]
            for level in levels}
    return {'gateEvidence': False, 'complete': all(row['state'] == 'complete' for row in rows),
            'levels': summary, 'onlyAt': only}


def report(root, model, stage):
    sys.path.insert(0, str(RESEARCH))
    from coding_gate import screening_report

    tasks = json.loads(FROZEN.read_text())['stages'][stage]
    rows = []
    for task_id in tasks:
        task = json.loads((root / 'outcomes/hard/tasks' / task_id / 'task.json').read_text())
        for effort in stage_levels(stage):
            path = trial_dir(root, task, model, effort) / 'receipt.json'
            receipt = json.loads(path.read_text()) if path.exists() else {}
            rows.append({'task': task_id, 'model': model, 'effort': effort,
                         'state': receipt_state(root, task, model, effort),
                         'passed': receipt.get('passed', False), 'wallSeconds': receipt.get('wallSeconds', 0),
                         'totalTokens': receipt.get('totalTokens', 0)})
    if stage == 'D':
        return level_report(rows, stage_levels(stage))
    return screening_report(rows, tasks=tasks, model=model)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--preflight-only', action='store_true')
    mode.add_argument('--dry-run', action='store_true')
    mode.add_argument('--live', action='store_true')
    mode.add_argument('--report', action='store_true')
    mode.add_argument('--smoke', metavar='TASK', help='one DeepSeek run to prove the path, never a result')
    parser.add_argument('--jobs', type=int, default=1, help='live runs at a time; wall times get noisier')
    parser.add_argument('--stage', choices=sorted(STAGE_MODELS))
    parser.add_argument('--effort', choices=DEEPSEEK_EFFORTS, default='high')
    parser.add_argument('--model')
    args = parser.parse_args()
    os.umask(0o077)
    root = args.root.resolve()
    if args.preflight_only:
        frozen = freeze(root, json.loads(MANIFEST.read_text()))
        FROZEN.write_text(json.dumps(frozen, indent=2) + '\n')
        print(json.dumps({'tasks': len(frozen['stages']['B']), 'rejected': frozen['rejectedByPreflight']}))
    elif args.dry_run:
        frozen = json.loads(FROZEN.read_text())
        for task_id in (frozen['stages']['A'][0], frozen['stages']['A'][3]):
            task = json.loads((root / 'outcomes/hard/tasks' / task_id / 'task.json').read_text())
            out = root / 'outcomes/hard/dry-run' / task_id
            shutil.rmtree(out, ignore_errors=True)
            shutil.rmtree(root / 'runs/hard/dry-run' / task_id, ignore_errors=True)
            out.mkdir(parents=True, mode=0o700)
            options = {'provider': PROVIDER, 'model': 'gpt-6.1-sol', 'limits': frozen['limits'],
                       **guards(frozen['limits'])}
            save(out / 'worker-input.json',
                 worker_input(task, env_dir(root, task) / 'repo', check_argv(root, task), options))
            subprocess.run([os.environ.get('CORRAL_RESEARCH_NODE', 'node'), str(HERE / 'driver.ts'),
                            str(out / 'worker-input.json'), str(out), str(root / 'runs/hard/dry-run' / task_id),
                            'xhigh', '--prepare-only'], check=True)
    elif args.smoke:
        task = json.loads((root / 'outcomes/hard/tasks' / args.smoke / 'task.json').read_text())
        if task['id'] in json.loads(FROZEN.read_text())['stages']['B']:
            raise ValueError('a smoke stays outside the frozen tasks')
        preflight(root, task)
        result = trial(root, task, 'deepseek-smoke', args.effort, SMOKE_LIMITS, check_argv(root, task), SMOKE)
        print(json.dumps({key: result.get(key) for key in (
            'id', 'state', 'status', 'passed', 'grade', 'wallSeconds', 'physicalProviderRequests', 'totalTokens')}))
    elif args.live:
        live(root, args.stage, args.model, args.jobs)
    else:
        print(json.dumps(report(root, args.model, args.stage), indent=2))


if __name__ == '__main__':
    main()
