#!/usr/bin/env python3
"""Order the hard coding tasks from task content only. No model call and no outcome is read."""
import argparse
from collections import defaultdict
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import urllib.request

SEED = 'corral-hard-tasks-v1'
HARD_DIFFICULTIES = {'1-4 hours', '>4 hours'}
# The 45 hard tasks span 8 repositories, so 12 tasks cannot all come from different ones.
REPOSITORY_CAP = 2
TASKS_PER_KIND = 12
MIN_BODY_CHARS = 40
VITEST_FILE = re.compile(r'\.test\.tsx?$')
SOURCE_FILE = re.compile(r'\.tsx?$')
NOT_SOURCE = re.compile(r'(^|/)(test|tests|e2e)/|\.(test|spec)\.tsx?$|\.d\.ts$')
DEPENDENCY_FILE = re.compile(r'(^|/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$|^patches/')


def rank(value):
    return hashlib.sha256(f'{SEED}:{value}'.encode()).hexdigest()


def swe_order(rows):
    """One task per repository, then a second per repository, each in seeded order."""
    by_repository = defaultdict(list)
    for row in rows:
        if row['difficulty'] in HARD_DIFFICULTIES:
            by_repository[row['repo']].append(row)
    groups = [sorted(by_repository[repo], key=lambda row: rank(row['instance_id']))
              for repo in sorted(by_repository, key=rank)]
    return [group[depth] for depth in range(REPOSITORY_CAP) for group in groups if depth < len(group)]


def select_swe(rows, count):
    order = swe_order(rows)
    if len(order) < count:
        raise ValueError('too few qualifying tasks')
    return order[:count]


def commit_tier(commit):
    """1 for multi-source fixes, 2 for the single-source ones used only as replacements."""
    files = commit['files']
    source = [path for path in files if SOURCE_FILE.search(path) and not NOT_SOURCE.search(path)]
    if (not commit['subject'].startswith('fix') or len(commit['body'].strip()) < MIN_BODY_CHARS
            or len(files) < 3 or not source or not any(VITEST_FILE.search(path) for path in files)
            or any(DEPENDENCY_FILE.search(path) for path in files)):
        return None
    return 1 if len(source) >= 2 else 2


def commit_qualifies(commit):
    return commit_tier(commit) is not None


def commit_order(commits):
    return sorted(filter(commit_qualifies, commits), key=lambda commit: (commit_tier(commit), rank(commit['sha'])))


def select_commits(commits, count):
    order = commit_order(commits)
    if len(order) < count:
        raise ValueError('too few qualifying tasks')
    return order[:count]


def stages(swe_ids, corral_ids):
    """Stages nest, so a run from a smaller stage stands for the same task in a larger one."""
    both = lambda count: swe_ids[:count] + corral_ids[:count]
    return {'A': both(3), 'B': both(TASKS_PER_KIND), 'C': both(6)}


def corral_commits(repository):
    def git(*args):
        return subprocess.run(['git', '-C', str(repository), *args], check=True,
                              capture_output=True, text=True).stdout
    log = git('log', '--no-merges', '--format=%x00%H%x01%P%x01%s%x01%b')
    commits = []
    for entry in log.split('\0')[1:]:
        sha, parents, subject, body = entry.split('\x01', 3)
        if not subject.startswith('fix') or len(parents.split()) != 1:
            continue
        numstat = git('show', '--numstat', '--no-renames', '--format=', sha).splitlines()
        commits.append({'sha': sha, 'parent': parents, 'subject': subject, 'body': body.strip(),
                        'files': [line.split('\t')[2] for line in numstat]})
    return commits


def image_record(image):
    name = image.split('/', 1)[1].split(':')[0]
    url = f'https://hub.docker.com/v2/repositories/swebench/{name}/tags/latest'
    with urllib.request.urlopen(url, timeout=20) as response:
        tag = json.load(response)
    return {'image': f'swebench/{name}@{tag["digest"]}', 'compressedBytes': tag['full_size']}


def private_save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n')
    path.chmod(0o600)


def task_hash(task):
    return hashlib.sha256(json.dumps(task, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def main():
    import pyarrow.parquet

    parser = argparse.ArgumentParser()
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--repository', type=Path, required=True)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    tasks = []
    for row in swe_order(pyarrow.parquet.read_table(args.dataset).to_pylist()):
        task = {'id': f'swe-{row["instance_id"]}', 'kind': 'swe-bench-verified', **image_record(row['image']),
                'request': row['problem_statement'], 'repository': row['repo'],
                'instanceId': row['instance_id'], 'baseCommit': row['base_commit'],
                'difficulty': row['difficulty'], 'goldPatch': row['patch'], 'testPatch': row['test_patch'],
                'evalScript': row['eval_script'], 'evalType': row['eval_type'], 'version': row['version'],
                'logParser': row['log_parser'],
                'failToPass': row['FAIL_TO_PASS'], 'passToPass': row['PASS_TO_PASS']}
        tasks.append(task)
    for commit in commit_order(corral_commits(args.repository)):
        tasks.append({'id': f'corral-{commit["sha"][:8]}', 'kind': 'corral-commit',
                      'request': f'{commit["subject"]}\n\n{commit["body"]}', 'commit': commit['sha'],
                      'parent': commit['parent'],
                      'tests': [path for path in commit['files'] if VITEST_FILE.search(path)]})
    public = ('id', 'kind', 'image', 'compressedBytes', 'repository', 'instanceId', 'baseCommit',
              'difficulty', 'commit', 'parent')
    records = []
    for task in tasks:
        private_save(args.root / 'outcomes/hard/tasks' / task['id'] / 'task.json', task)
        records.append({**{key: task[key] for key in public if key in task},
                        'taskSha256': task_hash(task)})
    private_save(args.out, {
        'version': 1, 'seed': SEED, 'tasksPerKind': TASKS_PER_KIND, 'repositoryCap': REPOSITORY_CAP,
        'selection': 'Ordered from task content before any run. The first tasks of each kind that pass '
                     'preflight form the set, in this order.',
        'datasetSha256': hashlib.sha256(args.dataset.read_bytes()).hexdigest(), 'order': records})
    args.out.chmod(0o644)
    kinds = {kind: sum(record['kind'] == kind for record in records)
             for kind in ('swe-bench-verified', 'corral-commit')}
    print(json.dumps(kinds))


if __name__ == '__main__':
    main()
