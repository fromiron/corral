"""Frozen training membership remains authoritative during expanded F-only replay."""
import hashlib


def validate_fit_rows(rows):
    if not rows or any(row.get('split') != 'fit' or not isinstance(row.get('group'), str) or not row['group'].strip() for row in rows):
        raise ValueError('fitting requires nonempty grouped F rows only')


def fit_dev_groups(rows, fold=0, *, holdout_manifest=None, fit_sha256=None):
    validate_fit_rows(rows)
    groups = {row['group'] for row in rows}
    if holdout_manifest is not None:
        if (holdout_manifest.get('version') != 'fit-holdout-v1' or not fit_sha256
                or holdout_manifest.get('fitSha256') != fit_sha256):
            raise ValueError('explicit holdout requires the exact frozen F input hash')
        folds = holdout_manifest.get('folds')
        if (not isinstance(folds, list) or len(folds) < 2 or isinstance(fold, bool)
                or not isinstance(fold, int) or fold not in range(len(folds))):
            raise ValueError('unknown explicit F validation fold')
        seen = set()
        for part in folds:
            held = part.get('devGroups') if isinstance(part, dict) else None
            if (not isinstance(held, list) or not held
                    or any(not isinstance(group, str) or not group.strip() for group in held)
                    or len(set(held)) != len(held) or seen.intersection(held)):
                raise ValueError('explicit F folds must contain disjoint nonempty groups')
            seen.update(held)
        if seen != groups:
            raise ValueError('explicit F folds must partition the exact input groups')
        return set(folds[fold]['devGroups'])
    if isinstance(fold, bool) or fold not in range(5):
        raise ValueError('unknown F validation fold')
    selected = {group for group in groups if int(hashlib.sha256(group.encode()).hexdigest()[:8], 16) % 5 == fold}
    if not selected or selected == groups:
        raise ValueError('requested fold needs separate fit and validation groups')
    return selected


def fit_dev_rows(rows, metadata, *, source_sha256=None):
    args = metadata['args']
    if args.get('fit_all') or any(row['split'] != 'fit' for row in rows):
        raise ValueError('fit-dev replay requires an internal F holdout, not a full refit')
    if args.get('holdout_manifest'):
        validate_fit_rows(rows)
        if not source_sha256 or metadata.get('fitSourceSha256') != source_sha256:
            raise ValueError('explicit fit-dev replay requires the exact fitted F input hash')
        held = metadata.get('devGroups')
        trained = set(metadata['trainGroups'])
        if (not isinstance(held, list) or not held or len(set(held)) != len(held)
                or trained.intersection(held) or not {r['group'] for r in rows} <= trained.union(held)):
            raise ValueError('explicit fit-dev replay requires disjoint recorded train/dev groups')
        selected = [row for row in rows if row['group'] in held]
    else:
        selected = [row for row in rows if int(hashlib.sha256(row['group'].encode()).hexdigest()[:8], 16) % 5 == args.get('dev_fold', 0)]
    if {row['group'] for row in selected} & set(metadata['trainGroups']):
        raise ValueError('fit-dev replay overlaps fitted groups')
    return selected
