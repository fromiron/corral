#!/usr/bin/env python3
"""Compile only the research helper against an existing, verified local build."""
import argparse
from pathlib import Path
import subprocess

PIN = 'a91eab67d8389d979d29fdf6633b2edd0718eb4b'
parser = argparse.ArgumentParser()
parser.add_argument('--llama-dir', required=True)
parser.add_argument('--output', required=True)
args = parser.parse_args()
source = Path(args.llama_dir).resolve()
revision = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
if revision != PIN:
    raise SystemExit('llama.cpp revision does not match the research pin')
out = Path(args.output).resolve()
out.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
libraries = source / 'build/bin'
subprocess.run([
    'c++', '-std=c++17', '-O2', '-Wall', '-Wextra', '-Werror',
    '-I' + str(source / 'include'), '-I' + str(source / 'ggml/include'),
    '-I' + str(source / 'vendor'), str(Path(__file__).with_name('main.cpp')),
    '-L' + str(libraries), '-Wl,-rpath,' + str(libraries), '-lllama', '-lggml', '-lggml-base',
    '-o', str(out),
], check=True)
print('Research helper compiled against pinned llama.cpp; no production bundle changed.')
