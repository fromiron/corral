#!/usr/bin/env python3
"""Read-only near-duplicate hygiene; no labels or resulting features feed a model."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import unicodedata

from sklearn.feature_extraction.text import TfidfVectorizer


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--data', required=True); parser.add_argument('--out', required=True)
    args = parser.parse_args(); data = Path(args.data); output = Path(args.out)
    if output.exists(): raise ValueError('audit receipt already exists')
    manifest_raw = (data / 'manifest.json').read_bytes(); manifest = json.loads(manifest_raw)
    rows = []; sources = {}
    for split in ('fit', 'calibration', 'policy', 'final'):
        name = f'{split}.raw.jsonl'; raw = (data / name).read_bytes(); digest = hashlib.sha256(raw).hexdigest()
        if digest != manifest['files'][name]['sha256']: raise ValueError('frozen source bytes changed')
        sources[name] = digest
        part = [json.loads(line) for line in raw.splitlines() if line.strip()]
        if any(row['split'] != split for row in part): raise ValueError('mislabeled partition')
        rows.extend(part)
    texts = []
    for row in rows:
        x = row['input']
        # Recorded A-D aliases are not personal names. Replacing their letters
        # inside ordinary words would corrupt the text, so omit name normalization.
        text = '\n'.join([person['role'] for person in x['participants']] +
                         [str(turn['speakerId']) + ':' + turn['text'] for turn in x['turns']] + [x['message']])
        texts.append(re.sub(r'\s+', ' ', unicodedata.normalize('NFKC', text)).strip().lower())
    matrix = TfidfVectorizer(analyzer='char_wb', ngram_range=(3, 5), min_df=2,
                             sublinear_tf=True).fit_transform(texts)
    pairs = []
    for offset in range(0, len(rows), 256):
        similarities = (matrix[offset:offset + 256] @ matrix.T).tocoo()
        for left, right, score in zip(similarities.row, similarities.col, similarities.data):
            left += offset
            if left >= right or score < .94 or rows[left]['group'] == rows[right]['group']: continue
            a, b = rows[left], rows[right]
            pairs.append({'left': a['id'], 'right': b['id'], 'leftGroup': a['group'], 'rightGroup': b['group'],
                          'leftSplit': a['split'], 'rightSplit': b['split'], 'similarity': float(score)})
    result = {'sourceManifestSha256': hashlib.sha256(manifest_raw).hexdigest(), 'files': sources,
              'threshold': .94, 'rows': len(rows), 'groups': len({row['group'] for row in rows}),
              'method': 'char_wb TF-IDF3-5gram, min_df2, sublinear_tf, NFKC/lower/whitespace normalization',
              'scope': 'hygiene only; labels never read for similarity and these features are never reused for fitting/scoring',
              'crossGroupPairs': len(pairs), 'crossSplitPairs': sum(pair['leftSplit'] != pair['rightSplit'] for pair in pairs),
              'pairs': pairs, 'inputFilesChanged': False}
    with output.open('x') as handle: json.dump(result, handle, indent=2)
    output.chmod(0o600)
    print(json.dumps({key: result[key] for key in ('rows', 'groups', 'threshold', 'crossGroupPairs', 'crossSplitPairs')}))


if __name__ == '__main__': main()
