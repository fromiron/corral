#!/usr/bin/env python3
"""Freeze and run exactly two F-only 0.8B views, fold0/seed41, without model selection."""
import argparse
from collections import Counter
import hashlib
from importlib.metadata import version
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time


def digest(path):
    return hashlib.file_digest(Path(path).open('rb'), 'sha256').hexdigest()


def write(path, value):
    with path.open('x') as handle:
        json.dump(value, handle, indent=2)
        handle.write('\n')
    path.chmod(0o600)


def aggregate(report, domains):
    result = {}
    for domain in ('effort', 'synthetic', 'natural'):
        part = [row for row in report['predictions'] if domains[row['id']] == domain]
        result[domain] = {'count': len(part), 'correct': sum(row['valid'] for row in part),
                          'accuracy': sum(row['valid'] for row in part) / len(part)}
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--views', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--max-seconds-per-view', type=int, default=6000)
    args = parser.parse_args()
    root, views, out = Path(args.root), Path(args.views), Path(args.out)
    if out.exists():
        raise ValueError('pilot output must be new; do not resume or replace a frozen run')
    code = Path(__file__).resolve().parent.parent
    original_recipe = root / 'models/confirmation-v1/shared-qwen35-final-fit/run.json'
    recipe = json.loads(original_recipe.read_text())['args']
    expected = {'task': 'joint', 'tokens': 1024, 'family': 'qwen35', 'epochs': 3,
                'lr': 3e-5, 'rank': 16, 'seed': 41, 'augment': None}
    if any(recipe[key] != value for key, value in expected.items()):
        raise ValueError('v3 joint recipe differs from the declared pilot')
    kernel_recipe = root / 'runs/confirmation-v1/manifest.json'
    if (version('flash-linear-attention') != '0.6.0'
            or not json.loads(kernel_recipe.read_text())['kernel'].startswith('fla0.6.0')):
        raise ValueError('run this pilot with the phase1 FLA0.6 environment')
    datasets = {}
    sys.path.insert(0, str(code))
    from split_eval import fit_dev_groups
    for view in ('timeline', 'participant-index'):
        data = views / view
        source = data / 'fit.jsonl'
        rows = [json.loads(line) for line in source.read_text().splitlines()]
        held = fit_dev_groups(rows, 0, holdout_manifest=json.loads((data / 'holdout.json').read_text()), fit_sha256=digest(source))
        datasets[view] = {'data': str(data), 'fitSha256': digest(source), 'holdoutSha256': digest(data / 'holdout.json'),
                          'devGroups': sorted(held), 'devIds': [r['id'] for r in rows if r['group'] in held],
                          'domains': {r['id']: r['phase2Domain'] for r in rows},
                          'trainCount': sum(r['group'] not in held for r in rows), 'devCount': sum(r['group'] in held for r in rows)}
    if datasets['timeline']['devIds'] != datasets['participant-index']['devIds']:
        raise ValueError('paired views must hold out identical case IDs')
    out.mkdir(parents=True, mode=0o700)
    frozen_code = out / 'code'
    frozen_code.mkdir(mode=0o700)
    source_files = ['sft.py', 'split_eval.py', 'metrics.py', 'predict_sft.py', 'train.py', 'modeling.py']
    hashes = {}
    for name in source_files:
        shutil.copyfile(code / name, frozen_code / name)
        hashes[name] = digest(frozen_code / name)
    for name in ['sft-views.ts', 'representations.ts', 'sft_pilot.py', 'sft-pilot.md']:
        hashes[f'phase2/{name}'] = digest(code / 'phase2' / name)
    base_pointer = root / 'models/qwen35.path'
    base = Path(base_pointer.read_text().strip())
    freeze = {'version': 'phase2-sft-pilot-fast-v1', 'scope': 'F-only fold0seed41 two-view comparison; no C/P/H',
              'recipe': expected, 'initialization': 'original pretrained0.8B, never the v3 fitted adapter',
              'basePath': str(base), 'basePointerSha256': digest(base_pointer), 'baseConfigSha256': digest(base / 'config.json'),
              'baseWeights': {p.name: digest(p) for p in sorted(base.glob('*.safetensors'))},
              'environment': {name: version(name) for name in ('torch', 'transformers', 'peft', 'flash-linear-attention', 'fla-core')},
              'python': sys.executable, 'pythonVersion': sys.version, 'sourceKernelRecipeSha256': digest(kernel_recipe),
              'sourceRecipeSha256': digest(original_recipe), 'sourceHashes': hashes,
              'datasets': datasets, 'maxSecondsPerView': args.max_seconds_per_view,
              'frozenBeforeFitAt': time.time(), 'selection': 'fixed epoch3; no best-view promotion'}
    write(out / 'freeze.json', freeze)
    env = {**os.environ, 'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1', 'TOKENIZERS_PARALLELISM': 'false'}
    execution = []
    for view, data in datasets.items():
        if (digest(Path(data['data']) / 'fit.jsonl') != data['fitSha256']
                or digest(Path(data['data']) / 'holdout.json') != data['holdoutSha256']
                or digest(base_pointer) != freeze['basePointerSha256']):
            raise ValueError('frozen source changed before fitting')
        run = out / view
        command = [sys.executable, str(frozen_code / 'sft.py'), '--models', str(root / 'models'),
                   '--data', data['data'], '--out', str(run), '--holdout-manifest', str(Path(data['data']) / 'holdout.json'),
                   '--dev-fold', '0']
        for key in ('task', 'tokens', 'family', 'epochs', 'lr', 'rank', 'seed'):
            command += ['--' + key, str(expected[key])]
        started = time.monotonic()
        with (out / f'{view}.log').open('x') as log:
            child = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, env=env, cwd=frozen_code)
            try:
                while child.poll() is None:
                    free = int(subprocess.check_output(['nvidia-smi', '--query-gpu=memory.free', '--format=csv,noheader,nounits']).decode().splitlines()[0])
                    if free < 512 or time.monotonic() - started > args.max_seconds_per_view:
                        raise RuntimeError('owned pilot hit declared resource/time boundary')
                    time.sleep(5)
                if child.returncode:
                    raise RuntimeError('pilot child failed; inspect private log')
            finally:
                if child.poll() is None:
                    child.terminate()
                    try: child.wait(timeout=15)
                    except subprocess.TimeoutExpired: child.kill(); child.wait()
        metadata = json.loads((run / 'run.json').read_text())
        if metadata['devGroups'] != data['devGroups'] or metadata['fitSourceSha256'] != data['fitSha256']:
            raise ValueError('actual training split differs from frozen split')
        final = json.loads((run / 'dev.json').read_text())
        if [row['id'] for row in final['predictions']] != data['devIds']:
            raise ValueError('evaluation case IDs differ from frozen dev')
        entry = {'view': view, 'seconds': time.monotonic() - started,
                 'zeroShot': aggregate(json.loads((run / 'zero-shot-dev.json').read_text()), data['domains']),
                 'epoch3': aggregate(final, data['domains'])}
        execution.append(entry)
        write(out / f'{view}-summary.json', entry)
        print(json.dumps(entry), flush=True)
    first = {r['id']: r for r in json.loads((out / 'timeline/dev.json').read_text())['predictions']}
    second = {r['id']: r for r in json.loads((out / 'participant-index/dev.json').read_text())['predictions']}
    paired = {}
    for domain in ('effort', 'synthetic', 'natural'):
        ids = [i for i in first if datasets['timeline']['domains'][i] == domain]
        counts = Counter('bothCorrect' if first[i]['valid'] and second[i]['valid'] else 'timelineOnly' if first[i]['valid'] else 'indexOnly' if second[i]['valid'] else 'bothWrong' for i in ids)
        paired[domain] = {'count': len(ids), **dict(counts), 'samePrediction': sum(first[i]['prediction'] == second[i]['prediction'] for i in ids)}
    write(out / 'comparison.json', {'scope': freeze['scope'], 'runs': execution, 'pairedSameIds': paired,
                                    'allOwnedChildrenExited': True, 'qualityReleaseClaim': False})


if __name__ == '__main__':
    main()
