#!/usr/bin/env python3
"""Order the hard coding tasks from task content only. No model call and no outcome is read."""
import argparse
from collections import defaultdict
from functools import lru_cache
import hashlib
import json
import os
from pathlib import Path
import posixpath
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
TEST_DIRECTORY = re.compile(r'(^|/)tests?/')
CONTRACT_NOTES = Path(__file__).resolve().parent / 'contract-notes.json'
INTERFACE_START = 'The tests use the names'
INTERFACE_HEADING = (f'{INTERFACE_START}, text and numbers below, each with the file that holds it. '
                     'They add to the description above and do not replace it.')
STATIC_IMPORT = re.compile(r"""^\s*import\s+(?!type\s)(?:(\w+)\s*,?\s*)?(?:\{([^}]*)\}\s*)?from\s*['"]([^'"]+)['"]""", re.M)
DYNAMIC_IMPORT = re.compile(r"""\{([^{}]*)\}\s*=\s*await\s+import\(\s*['"]([^'"]+)['"]\s*\)""")
EXPORT_LIST = re.compile(r"""^export\s*(?:\{([^}]*)\}|(\*))\s*(?:from\s*['"]([^'"]+)['"])?""", re.M)
EXPORTED = r'^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|class|enum)\s+{}\b'
DECLARED = r'^(?:async\s+)?(?:function\*?|const|let|class|enum)\s+{}\b'
TYPE_DECLARATION = re.compile(r'^export\s+(?:interface|type)\s+(\w+)', re.M)
STRING = re.compile(r"""'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\\n]|\\.)*)`""")
NUMBER = re.compile(r'(?<![\w.])\d{2,}(?![\w.])')
MESSAGE_FILE = re.compile(r'(^|/)messages/en\.json$')
MESSAGE_KEY = re.compile(r"""(?:\bmessages\.|['"`])([A-Z]\w*)\.(\w+)""")
MIN_TEXT_CHARS = 4
MAX_DECLARATION_LINES = 40
# A brace after one of these opens a type, not a body.
TYPE_POSITION = (':', '|', '&', ',', '<')


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


def listed(names):
    """(name in its module, name here) for each value in an import or export list."""
    pairs = []
    for item in names.split(','):
        item = item.strip()
        if item and not item.startswith('type '):
            source, _, visible = item.partition(' as ')
            pairs.append((source.strip(), (visible or source).strip()))
    return pairs


def imported_names(source):
    """Values a test takes from other modules, as (name, module). Types vanish at run time."""
    found = set()
    for default, names, module in STATIC_IMPORT.findall(source):
        found |= {(name, module) for name, _ in listed(names)}
        if default:
            found.add(('default', module))
    for names, module in DYNAMIC_IMPORT.findall(source):
        found |= {(name, module) for name, _ in listed(names)}
    return found


def module_file(importer, module, read):
    """The file behind a project import, or None for a library."""
    if module.startswith('.'):
        bases = [posixpath.normpath(posixpath.join(posixpath.dirname(importer), module))]
    elif module.startswith('@corral/'):
        package = module.split('/')[1]
        bases = [f'{folder}/{package}/src/index' for folder in ('packages', 'apps')]
    else:
        return None
    for base in bases:
        for suffix in ('.ts', '.tsx', '/index.ts', ''):
            if read(base + suffix) is not None:
                return base + suffix
    return None


def declaration(source, start):
    """A declaration up to the start of its body, on one line."""
    text = '\n'.join(source[start:].splitlines()[:MAX_DECLARATION_LINES])
    depth = 0
    end = len(text)
    for index, mark in enumerate(text):
        if not depth:
            before = text[:index].rstrip()
            ends_a_line = mark == '\n' and not (before.endswith(TYPE_POSITION) or text[index:].lstrip().startswith('|'))
            if mark == ';' or ends_a_line or (mark == '{' and not before.endswith(TYPE_POSITION)):
                end = index
                break
        depth += (mark in '([{') - (mark in ')]}')
    return re.sub(r'(\s*(=>|=|\{))+$', '', ' '.join(text[:end].split()).rstrip(';'))


def exported(read, path, name, seen=frozenset()):
    """The file and declaration behind an exported value, following re-exports, or None."""
    source = read(path)
    if source is None or path in seen:
        return None
    seen |= {path}
    direct = re.search(EXPORTED.format(re.escape(name)), source, re.M)
    if direct:
        return path, declaration(source, direct.start())
    for names, star, module in EXPORT_LIST.findall(source):
        origin = dict((visible, name_there) for name_there, visible in listed(names)).get(name)
        if not module:
            if origin:
                local = re.search(DECLARED.format(re.escape(origin)), source, re.M)
                return path, declaration(source, local.start()) if local else origin
        elif star or origin:
            target = module_file(path, module, read)
            found = target and exported(read, target, origin or name, seen)
            if found:
                return found
    return None


def required_text(tests_added, source_added, source_before, request):
    """New text the tests check: the fix adds it, and the request does not give it."""
    found = set()
    for line in tests_added:
        if line.lstrip().startswith('import '):
            continue
        for groups in STRING.findall(line):
            text = next(filter(None, groups), '')
            if (len(text) >= MIN_TEXT_CHARS and re.search(r'[^\W\d_]', text) and text in source_added
                    and text not in source_before and text not in request):
                found.add(text)
    return sorted(found)


def required_numbers(tests_added, source_added, source_before, request):
    """New numbers the tests check: the fix adds them, and the request does not give them."""
    checked = set(NUMBER.findall('\n'.join(line for line in tests_added if not line.lstrip().startswith('import '))))
    given = set(NUMBER.findall(source_before)) | set(NUMBER.findall(request))
    return sorted((checked & set(NUMBER.findall(source_added))) - given, key=int)


def required_keys(tests_added, diff):
    """Translation keys the tests name and the fix adds, each with its file."""
    found = set()
    for path, lines in diff.items():
        if MESSAGE_FILE.search(path):
            added = '\n'.join(lines)
            found |= {(path, f'{group}.{key}') for line in tests_added for group, key in MESSAGE_KEY.findall(line)
                      if f'"{key}"' in added}
    return sorted(found)


def new_types(names, before, after):
    """The exported types a disclosed declaration names and the start lacks, each with its body."""
    found = set()
    for path, what in names:
        source = after(path) or ''
        old = {match[1] for match in TYPE_DECLARATION.finditer(before(path) or '')}
        for match in TYPE_DECLARATION.finditer(source):
            if match[1] not in old and re.search(rf'\b{match[1]}\b', what):
                found.add((path, ' '.join(source[match.start():].split('\n\n')[0].split())))
    return found


def interface_note(task, read, diff):
    """What the tests need that neither the commit message nor the starting code gives a worker."""
    before = lambda path: read(task['parent'], path)
    after = lambda path: read(task['commit'], path)
    names = set()
    for test in task['tests']:
        for name, module in imported_names(after(test) or ''):
            path = module_file(test, module, after)
            if not path or NOT_SOURCE.search(path):
                continue
            old = module_file(test, module, before)
            if name == 'default':
                if not old:
                    names.add((path, 'default export'))
            else:
                now = exported(after, path, name) or (path, name)
                then = old and exported(before, old, name)
                if not then or then[1] != now[1]:
                    names.add(now)
    names |= new_types(names, before, after)
    sources = [path for path in diff if not NOT_SOURCE.search(path)]
    added = [[line for test in task['tests'] for line in diff.get(test, [])],
             '\n'.join(line for path in sources for line in diff[path]),
             '\n'.join(before(path) or '' for path in sources), task['request']]
    text, numbers, keys = required_text(*added), required_numbers(*added), required_keys(added[0], diff)
    if not names and not text and not numbers and not keys:
        return ''
    holder = lambda value: next(path for path in sources if value in '\n'.join(diff[path]))
    sections = [INTERFACE_HEADING]
    if names:
        sections.append('Names:\n' + '\n'.join(f'- {path}: {what}' for path, what in sorted(names)))
    if text:
        sections.append('Text:\n' + '\n'.join(f'- {holder(line)}: {line}' for line in text))
    if numbers:
        sections.append('Numbers:\n' + '\n'.join(f'- {holder(line)}: {line}' for line in numbers))
    if keys:
        sections.append('Message keys:\n' + '\n'.join(f'- {path}: {key}' for path, key in keys))
    return '\n\n' + '\n\n'.join(sections)


def with_interface(task, read, diff, notes=None):
    base = task['request'].split(f'\n\n{INTERFACE_START}')[0]
    support = sorted(path for path in diff if TEST_DIRECTORY.search(path) and not VITEST_FILE.search(path))
    plain = {**task, 'request': base, 'support': support}
    note = interface_note(plain, read, diff)
    written = (notes or {}).get(task['id'])
    if written:
        note = (note or f'\n\n{INTERFACE_HEADING}') + f'\n\nAlso:\n- {written}'
    return {**plain, 'request': base + note}


def revision_reader(repository):
    @lru_cache(maxsize=None)
    def read(revision, path):
        shown = subprocess.run(['git', '-C', str(repository), 'show', f'{revision}:{path}'],
                               capture_output=True, text=True, errors='replace')
        return shown.stdout if shown.returncode == 0 else None
    return read


def commit_diff(repository, commit):
    """The lines a commit adds, by file."""
    shown = subprocess.run(['git', '-C', str(repository), 'show', '--format=', '--unified=0', '--no-renames', commit],
                           check=True, capture_output=True, text=True, errors='replace').stdout
    added = defaultdict(list)
    path = None
    for line in shown.splitlines():
        if line.startswith('+++ '):
            path = line[6:] if line.startswith('+++ b/') else None
        elif line.startswith('+') and path:
            added[path].append(line[1:])
    return dict(added)


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


def disclose(root, repository, out):
    """Rewrites the Corral requests in place. The SWE-bench tasks and the order stay as they are."""
    manifest = json.loads(out.read_text())
    notes = json.loads(CONTRACT_NOTES.read_text())
    read = revision_reader(repository)
    for record in manifest['order']:
        if record['kind'] == 'corral-commit':
            path = root / 'outcomes/hard/tasks' / record['id'] / 'task.json'
            task = with_interface(json.loads(path.read_text()), read, commit_diff(repository, record['commit']), notes)
            private_save(path, task)
            record['taskSha256'] = task_hash(task)
    private_save(out, manifest)
    out.chmod(0o644)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dataset', type=Path)
    parser.add_argument('--disclose', action='store_true', help='rewrite the Corral requests only')
    parser.add_argument('--repository', type=Path, required=True)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    if args.disclose:
        disclose(args.root, args.repository, args.out)
        return
    import pyarrow.parquet

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
    read = revision_reader(args.repository)
    for commit in commit_order(corral_commits(args.repository)):
        task = {'id': f'corral-{commit["sha"][:8]}', 'kind': 'corral-commit',
                'request': f'{commit["subject"]}\n\n{commit["body"]}', 'commit': commit['sha'],
                'parent': commit['parent'],
                'tests': [path for path in commit['files'] if VITEST_FILE.search(path)]}
        tasks.append(with_interface(task, read, commit_diff(args.repository, commit['sha'])))
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
