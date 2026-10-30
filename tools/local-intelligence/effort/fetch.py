# /// script
# requires-python = ">=3.11"
# dependencies = ["pyarrow==26.0.0"]
# ///
"""Builds the effort sample from public datasets that already carry a difficulty signal.

    uv run --no-project tools/local-intelligence/effort/fetch.py <cache-dir> <samples.jsonl>

Every source is pinned to a dataset revision (datasets.md); the signal-to-level mapping is
label-rubric.md. Sampling is deterministic: in each bucket the groups with the smallest sha256
keys are kept. Downloads stay in <cache-dir>, one folder per source.
"""

import csv
import difflib
import hashlib
import heapq
import io
import json
import os
import re
import sys
import urllib.request

import pyarrow.parquet as pq

HEADERS = {'User-Agent': 'corral-local-intelligence-dataset/1'}
REVISIONS = {
    'math': ('EleutherAI/hendrycks_math', '21a5633873b6a120296cce3e2df9d5550074f4a3'),
    'gsm8k': ('openai/gsm8k', '740312add88f781978c0658806c59bc2815b9866'),
    'mmlu': ('cais/mmlu', 'c30699e8356da336a370243923dbaf21066bb9fe'),
    'mmmlu': ('openai/MMMLU', '325a01dc3e173cac1578df94120499aaca2e2504'),
    'taco': ('BAAI/TACO', 'd593ed0a2becbbc952230bb89be09189bf1056dc'),
    'commitpackft': ('bigcode/commitpackft', 'fc56fe33c030c6daa414c2b112c932b8eed085e6'),
    'swe-bench-verified': ('SWE-bench/SWE-bench_Verified', '78f471bf655a3137b2e8a75af1501690ec009ec3'),
    'swe-rebench': ('nebius/SWE-rebench', '89cdfbab4ab1bd8f5a658bb212d1b63624f4f881'),
}
MATH_SUBJECTS = [
    'algebra', 'counting_and_probability', 'geometry', 'intermediate_algebra',
    'number_theory', 'prealgebra', 'precalculus',
]
COMMIT_LANGUAGES = ['python', 'javascript', 'typescript', 'java', 'go', 'rust']
# Groups kept per (source, level); commits are per (language, level).
CAPS = {
    'math': {'low': 800, 'medium': 800, 'high': 800, 'xhigh': 800},
    'gsm8k': {'low': 500},
    'mmlu': {'low': 400, 'medium': 400},
    'taco': {'medium': 900, 'high': 900, 'xhigh': 900},
    'commitpackft': {'low': 150, 'medium': 150},
    'swe-rebench': {'medium': 900, 'high': 900, 'xhigh': 900},
}
# effortText keeps the first 1200 code points of a request; whitespace collapses before that.
MAX_REQUEST = 6000


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def normal(text):
    return re.sub(r'\s+', ' ', text).strip().lower()


def url(source, path):
    repo, revision = REVISIONS[source]
    return f'https://huggingface.co/datasets/{repo}/resolve/{revision}/{path}'


def download(cache, source, path):
    target = os.path.join(cache, source, path)
    if os.path.exists(target):
        return target
    os.makedirs(os.path.dirname(target), exist_ok=True)
    request = urllib.request.Request(url(source, path), headers=HEADERS)
    with urllib.request.urlopen(request, timeout=120) as response, open(target + '.part', 'wb') as out:
        while chunk := response.read(1 << 20):
            out.write(chunk)
    os.replace(target + '.part', target)
    return target


class RemoteFile(io.RawIOBase):
    """Reads a remote file with HTTP range requests, so only the needed parquet columns move."""

    def __init__(self, address):
        request = urllib.request.Request(address, method='HEAD', headers=HEADERS)
        with urllib.request.urlopen(request, timeout=60) as response:
            self.address = response.url
            self.size = int(response.headers['Content-Length'])
        self.position = 0

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.position

    def seek(self, offset, whence=0):
        base = {0: 0, 1: self.position, 2: self.size}[whence]
        self.position = base + offset
        return self.position

    def readinto(self, buffer):
        if self.position >= self.size or len(buffer) == 0:
            return 0
        end = min(self.position + len(buffer), self.size) - 1
        request = urllib.request.Request(
            self.address, headers={**HEADERS, 'Range': f'bytes={self.position}-{end}'}
        )
        with urllib.request.urlopen(request, timeout=120) as response:
            data = response.read()
        if response.status != 206:
            raise RuntimeError(f'range request returned {response.status}')
        buffer[: len(data)] = data
        self.position += len(data)
        return len(data)


class Sampler:
    """Keeps, per bucket, the groups with the smallest keys; one group may hold several rows.

    A bucket is (source, level, ...). A group whose text also appears with another level is
    dropped: its signal does not decide the level.
    """

    def __init__(self):
        self.buckets = {}
        self.levels = {}
        self.conflicted = set()

    def offer(self, bucket, cap, key, rows):
        if self.levels.setdefault(key, bucket[1]) != bucket[1]:
            self.conflicted.add(key)
            return
        heap = self.buckets.setdefault(bucket, ([], set()))
        entries, keys = heap
        if key in keys:
            return
        if len(entries) < cap:
            heapq.heappush(entries, (_Reverse(key), rows))
            keys.add(key)
        elif key < entries[0][0].key:
            dropped = heapq.heapreplace(entries, (_Reverse(key), rows))
            keys.discard(dropped[0].key)
            keys.add(key)

    def full(self, bucket, cap):
        return len(self.buckets.get(bucket, ([], set()))[0]) >= cap

    def worst(self, bucket):
        return self.buckets[bucket][0][0][0].key

    def rows(self):
        for entries, _ in self.buckets.values():
            for reverse, rows in entries:
                if reverse.key not in self.conflicted:
                    yield from rows


class _Reverse:
    __slots__ = ('key',)

    def __init__(self, key):
        self.key = key

    def __lt__(self, other):
        return self.key > other.key

    def __eq__(self, other):
        return self.key == other.key


def row(source, group, lang, label, signal, request, use='train'):
    return {
        'id': f'{source}:{sha(group)[:16]}:{lang}',
        'source': source,
        'group': f'{source}:{group}',
        'lang': lang,
        'label': label,
        'signal': signal,
        'use': use,
        'request': request[:MAX_REQUEST],
    }


def math(cache, sampler):
    levels = {'Level 1': 'low', 'Level 2': 'medium', 'Level 3': 'medium', 'Level 4': 'high', 'Level 5': 'xhigh'}
    for subject in MATH_SUBJECTS:
        for split in ('train', 'test'):
            path = download(cache, 'math', f'{subject}/{split}-00000-of-00001.parquet')
            for item in pq.read_table(path, columns=['problem', 'level']).to_pylist():
                label = levels.get(item['level'])
                if not label:
                    continue
                key = sha(normal(item['problem']))
                sampler.offer(('math', label), CAPS['math'][label], key,
                              [row('math', key, 'en', label, item['level'], item['problem'])])


def gsm8k(cache, sampler):
    for split in ('train', 'test'):
        path = download(cache, 'gsm8k', f'main/{split}-00000-of-00001.parquet')
        for item in pq.read_table(path, columns=['question']).to_pylist():
            key = sha(normal(item['question']))
            sampler.offer(('gsm8k', 'low'), CAPS['gsm8k']['low'], key,
                          [row('gsm8k', key, 'en', 'low', 'grade school', item['question'])])


def mcq(question, choices):
    return '\n'.join([question.strip(), *(f'{letter}. {str(choice).strip()}' for letter, choice in zip('ABCD', choices))])


def mmlu(cache, sampler):
    """English MMLU test items with their Korean and Japanese MMMLU translations as one group."""
    english = pq.read_table(download(cache, 'mmlu', 'all/test-00000-of-00001.parquet'),
                            columns=['question', 'subject', 'choices']).to_pylist()
    # MMMLU numbers the rows within each subject, in MMLU test order.
    sizes = {}
    for item in english:
        item['index'] = sizes[item['subject']] = sizes.get(item['subject'], -1) + 1
    translated = {}
    for lang, path in (('ko', 'test/mmlu_KO-KR.csv'), ('ja', 'test/mmlu_JA-JP.csv')):
        with open(download(cache, 'mmmlu', path), encoding='utf-8', newline='') as file:
            for item in csv.DictReader(file):
                key = (item['Subject'], int(item['']))
                if key[1] > sizes.get(key[0], -1):
                    raise RuntimeError(f'MMMLU {lang} row {key} has no MMLU item')
                translated.setdefault(key, {})[lang] = mcq(item['Question'], [item[c] for c in 'ABCD'])
    for item in english:
        subject, index = item['subject'], item['index']
        if subject.startswith(('high_school_', 'elementary_')):
            label = 'low'
        elif subject.startswith('college_'):
            label = 'medium'
        else:
            continue
        group = f'{subject}:{index}'
        rows = [row('mmlu', group, 'en', label, subject, mcq(item['question'], item['choices']))]
        rows += [row('mmlu', group, lang, label, subject, text)
                 for lang, text in sorted(translated.get((subject, index), {}).items())]
        sampler.offer(('mmlu', label), CAPS['mmlu'][label], sha(group), rows)


def taco(cache, sampler):
    levels = {'EASY': 'medium', 'MEDIUM': 'high', 'MEDIUM_HARD': 'high', 'HARD': 'xhigh', 'VERY_HARD': 'xhigh'}
    shards = ['test-00000-of-00001'] + [f'train-{i:05d}-of-00009' for i in range(9)]
    for shard in shards:
        target = os.path.join(cache, 'taco', f'{shard}.jsonl')
        if not os.path.exists(target):
            os.makedirs(os.path.dirname(target), exist_ok=True)
            remote = RemoteFile(url('taco', f'ALL/{shard}.parquet'))
            table = pq.ParquetFile(remote).read(columns=['question', 'difficulty', 'source'])
            with open(target + '.part', 'w', encoding='utf-8') as out:
                for item in table.to_pylist():
                    out.write(json.dumps(item, ensure_ascii=False) + '\n')
            os.replace(target + '.part', target)
        with open(target, encoding='utf-8') as file:
            for line in file:
                item = json.loads(line)
                label = levels.get(item['difficulty'])
                # HackerRank problems are excluded: TACO states their license is unknown.
                if not label or 'hackerrank' in (item['source'] or '').lower():
                    continue
                if len(item['question'].strip()) < 80:
                    continue
                key = sha(normal(item['question']))
                sampler.offer(('taco', label), CAPS['taco'][label], key,
                              [row('taco', key, 'en', label, item['difficulty'], item['question'])])


def changed_lines(old, new):
    matcher = difflib.SequenceMatcher(None, old.splitlines(), new.splitlines())
    return sum((i2 - i1) + (j2 - j1) for tag, i1, i2, j1, j2 in matcher.get_opcodes() if tag != 'equal')


def commits(cache, sampler):
    seen = set()
    for language in COMMIT_LANGUAGES:
        path = download(cache, 'commitpackft', f'data/{language}/data.jsonl')
        buckets = {label: ('commitpackft', label, language) for label in ('low', 'medium')}
        caps = CAPS['commitpackft']
        with open(path, encoding='utf-8') as file:
            for line in file:
                item = json.loads(line)
                subject = item['subject'].strip()
                if len(subject) < 12 or len(subject.split()) < 3 or re.match(r'(merge|revert)\b', subject, re.I):
                    continue
                key = sha(normal(subject))
                if key in seen:
                    continue
                if all(sampler.full(b, caps[label]) and key > sampler.worst(b) for label, b in buckets.items()):
                    continue
                old, new = item['old_contents'], item['new_contents']
                if max(len(old), len(new)) > 50_000:
                    continue
                count = changed_lines(old, new)
                label = 'low' if 1 <= count <= 2 else 'medium' if 3 <= count <= 30 else None
                if not label:
                    continue
                repo = item['repos'].split(',')[0]
                sampler.offer(buckets[label], caps[label], key,
                              [row('commitpackft', key, 'en', label, f'{language}: {count} lines', subject)
                               | {'group': f'commitpackft:{repo}'}])
        seen.update(sha(normal(r['request'])) for r in sampler.rows() if r['source'] == 'commitpackft')


def patch_size(patch):
    files = len(re.findall(r'^diff --git ', patch, re.M))
    lines = sum(1 for line in patch.splitlines()
                if line.startswith(('+', '-')) and not line.startswith(('+++', '---')))
    return files, lines


def patch_level(patch):
    files, lines = patch_size(patch)
    return 'medium' if files == 1 and lines <= 6 else 'xhigh' if files > 3 or lines > 20 else 'high'


def issue_title(text):
    """The issue's first line when it reads like a title, not markup or a template heading."""
    first = text.strip().splitlines()[0].strip()
    if first.startswith(('#', '<', '*', '`', '|', '>', '-')) or len(first.split()) < 4 or len(first) > 200:
        return None
    return first


def swe_rebench(cache, sampler):
    """GitHub issues with the size of the patch that resolved them; SWE-bench repositories excluded."""
    held_out = {item['repo'] for item in pq.read_table(
        download(cache, 'swe-bench-verified', 'data/test-00000-of-00001.parquet'), columns=['repo']).to_pylist()}
    for shard in ('filtered-00000-of-00001', 'test-00000-of-00002', 'test-00001-of-00002'):
        target = os.path.join(cache, 'swe-rebench', f'{shard}.jsonl')
        if not os.path.exists(target):
            os.makedirs(os.path.dirname(target), exist_ok=True)
            remote = RemoteFile(url('swe-rebench', f'data/{shard}.parquet'))
            table = pq.ParquetFile(remote).read(columns=['instance_id', 'repo', 'problem_statement', 'patch'])
            with open(target + '.part', 'w', encoding='utf-8') as out:
                for item in table.to_pylist():
                    out.write(json.dumps(item, ensure_ascii=False) + '\n')
            os.replace(target + '.part', target)
        with open(target, encoding='utf-8') as file:
            for line in file:
                item = json.loads(line)
                if item['repo'] in held_out or len(item['problem_statement'].strip()) < 40:
                    continue
                label = patch_level(item['patch'])
                files, lines = patch_size(item['patch'])
                key = sha(normal(item['problem_statement']))
                group = {'group': f"swe-rebench:{item['repo']}"}
                signal = f'{files} files, {lines} lines'
                rows = [row('swe-rebench', key, 'en', label, signal, item['problem_statement']) | group]
                # The title alone is a short request with the same signal; real requests are often short.
                title = issue_title(item['problem_statement'])
                if title:
                    rows.append(row('swe-rebench-title', key, 'en', label, signal, title) | group)
                sampler.offer(('swe-rebench', label), CAPS['swe-rebench'][label], key, rows)


def swe_bench(cache):
    levels = {'<15 min fix': 'medium', '15 min - 1 hour': 'high', '1-4 hours': 'xhigh', '>4 hours': 'xhigh'}
    path = download(cache, 'swe-bench-verified', 'data/test-00000-of-00001.parquet')
    for item in pq.read_table(path, columns=['instance_id', 'repo', 'problem_statement', 'difficulty']).to_pylist():
        label = levels[item['difficulty']]
        yield row('swe-bench-verified', item['repo'] + ':' + item['instance_id'], 'en', label,
                  item['difficulty'], item['problem_statement'], use='eval')


def main(cache, out):
    sampler = Sampler()
    for step in (math, gsm8k, mmlu, taco, commits, swe_rebench):
        step(cache, sampler)
        print(f'{step.__name__}: done', file=sys.stderr)
    rows = list(sampler.rows()) + list(swe_bench(cache))
    rows.sort(key=lambda r: r['id'])
    if len({r['id'] for r in rows}) != len(rows):
        raise RuntimeError('sample ids are not unique')
    with open(out + '.part', 'w', encoding='utf-8') as file:
        for item in rows:
            file.write(json.dumps(item, ensure_ascii=False) + '\n')
    os.replace(out + '.part', out)
    counts = {}
    for item in rows:
        key = (item['use'], item['source'], item['lang'], item['label'])
        counts[key] = counts.get(key, 0) + 1
    for key in sorted(counts):
        print(*key, counts[key], sep='\t')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
