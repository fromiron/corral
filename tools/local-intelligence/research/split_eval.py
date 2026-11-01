"""Frozen training membership remains authoritative during expanded F-only replay."""
import hashlib


def validate_fit_rows(rows):
    if not rows or any(row.get('split') != 'fit' or not isinstance(row.get('group'), str) or not row['group'].strip() for row in rows):
        raise ValueError('fitting requires nonempty grouped F rows only')


def fit_dev_groups(rows, fold=0):
    validate_fit_rows(rows)
    if isinstance(fold, bool) or fold not in range(5):
        raise ValueError('unknown F validation fold')
    groups = {row['group'] for row in rows}
    selected = {group for group in groups if int(hashlib.sha256(group.encode()).hexdigest()[:8], 16) % 5 == fold}
    if not selected or selected == groups:
        raise ValueError('requested fold needs separate fit and validation groups')
    return selected


def fit_dev_rows(rows, metadata):
    args = metadata['args']
    if args.get('fit_all') or any(row['split'] != 'fit' for row in rows):
        raise ValueError('fit-dev replay requires an internal F holdout, not a full refit')
    selected = [row for row in rows if int(hashlib.sha256(row['group'].encode()).hexdigest()[:8], 16) % 5 == args.get('dev_fold', 0)]
    if {row['group'] for row in selected} & set(metadata['trainGroups']):
        raise ValueError('fit-dev replay overlaps fitted groups')
    return selected
