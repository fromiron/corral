#!/usr/bin/env python3
"""Bounded container build; no publication, model copy/load, or GPU device access.

The image digest is fixed. Apt versions are captured after installation, so this
records the build inputs without claiming bit-reproducible future releases.
Only a git archive of pinned upstream source and this helper enter the container.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
import uuid

PIN = 'a91eab67d8389d979d29fdf6633b2edd0718eb4b'
IMAGE = 'ubuntu@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852'


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--llama-dir', required=True)
    parser.add_argument('--work', required=True, help='New private directory; existing paths are refused')
    parser.add_argument('--report', required=True)
    parser.add_argument('--image', default=IMAGE)
    parser.add_argument('--jobs', type=int, default=3)
    parser.add_argument('--timeout-seconds', type=int, default=900)
    args = parser.parse_args()
    if not re.fullmatch(r'[^\s]+@sha256:[0-9a-f]{64}', args.image):
        raise SystemExit('A digest-pinned image is required')
    if not 1 <= args.jobs <= 4 or not 60 <= args.timeout_seconds <= 1800:
        raise SystemExit('Build resources exceed the supported bounds')
    source = Path(args.llama_dir).resolve()
    if subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip() != PIN:
        raise SystemExit('llama.cpp revision differs from the pin')
    work = Path(args.work).resolve()
    work.mkdir(mode=0o700, parents=True, exist_ok=False)
    inputs = work / 'inputs'
    inputs.mkdir(mode=0o700)
    output = work / 'output'
    output.mkdir(mode=0o700)
    helper_dir = Path(__file__).resolve().parent
    subprocess.run(['git', '-C', str(source), 'archive', '--format=tar', '--output=' + str(inputs / 'llama.tar'), PIN], check=True)
    shutil.copyfile(helper_dir / 'main.cpp', inputs / 'main.cpp')
    shutil.copyfile(helper_dir / 'build-linux.sh', inputs / 'build-linux.sh')
    shutil.copyfile(helper_dir.parents[2] / 'LICENSE', inputs / 'project-license.txt')
    subprocess.run(['docker', 'pull', args.image], check=True)
    inspected = json.loads(subprocess.check_output(['docker', 'image', 'inspect', args.image], text=True))[0]
    if inspected['Os'] != 'linux' or inspected['Architecture'] != 'amd64':
        raise SystemExit('Only a Linux amd64 builder image is supported')
    name = 'corral-decision-build-' + uuid.uuid4().hex[:12]
    command = ['docker', 'run', '--rm', '--name', name, '--platform', 'linux/amd64',
               '--cpus', str(args.jobs), '--memory', '6g', '--memory-swap', '6g', '--pids-limit', '512',
               '--mount', f'type=bind,src={inputs},dst=/input,readonly',
               '--mount', f'type=bind,src={output},dst=/work',
               '--env', f'LLAMA_COMMIT={PIN}', '--env', f'BUILD_JOBS={args.jobs}',
               '--env', f'BUILD_UID={os.getuid()}', '--env', f'BUILD_GID={os.getgid()}',
               args.image, 'sh', '/input/build-linux.sh']
    started = time.monotonic()
    report = {'purpose': 'Linux artifact feasibility; not publication or universal portability proof',
              'sourceCommit': PIN, 'sourceArchiveSha256': digest(inputs / 'llama.tar'),
              'helperSourceSha256': digest(inputs / 'main.cpp'),
              'builderImage': args.image, 'builderImageId': inspected['Id'],
              'builderRepoDigests': inspected['RepoDigests'],
              'resourceLimits': {'cpus': args.jobs, 'memoryBytes': 6 * 1024**3, 'seconds': args.timeout_seconds},
              'gpuDevicesPassed': False, 'modelLoaded': False}
    try:
        with (work / 'build.log').open('w') as log:
            result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, timeout=args.timeout_seconds)
        report['exitCode'] = result.returncode
        report['status'] = 'built' if result.returncode == 0 else 'build_failed'
    except subprocess.TimeoutExpired:
        report['status'] = 'build_timeout'
    finally:
        # Only this invocation's uniquely named container can be removed.
        subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    report['elapsedSeconds'] = time.monotonic() - started
    if report['status'] == 'built':
        package = output / 'package'
        files = {}
        for path in sorted(package.rglob('*')):
            if not path.is_file():
                continue
            entry = {'bytes': path.stat().st_size, 'sha256': digest(path)}
            if path.read_bytes()[:4] == b'\x7fELF':
                dynamic = subprocess.check_output(['readelf', '-dW', str(path)], text=True)
                versions = subprocess.check_output(['readelf', '--version-info', '-W', str(path)], text=True)
                notes = subprocess.check_output(['readelf', '-nW', str(path)], text=True)
                entry['needed'] = re.findall(r'\(NEEDED\).*\[([^\]]+)\]', dynamic)
                entry['rpath'] = re.findall(r'\((?:RUNPATH|RPATH)\).*\[([^\]]*)\]', dynamic)
                entry['requiredSymbolVersions'] = sorted(set(re.findall(r'Name: ((?:GLIBC|GLIBCXX|CXXABI|GOMP)_[0-9.]+)', versions)))
                entry['elfNotes'] = notes.strip()
                if entry['rpath'] != ['$ORIGIN']:
                    raise SystemExit('An artifact has a missing or non-relative loader path')
            files[str(path.relative_to(package))] = entry
        report['files'] = files
        report['packageBytes'] = sum(file['bytes'] for file in files.values())
        report['toolchain'] = json.loads((output / 'evidence/toolchain.json').read_text())
        report['cpuPolicy'] = 'Upstream runtime dispatch: x64 baseline plus feature-checked optimized variants; GGML_NATIVE=OFF'
        report['runtimeSystemLibrariesBundled'] = False
        report['missingTests'] = ['CPU model inference', 'lower-ISA machine execution', 'older-kernel execution',
                                  'Vulkan GPU inference', 'packaged desktop integration', 'independent release quality replay']
    target = Path(args.report).resolve()
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    target.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({key: report.get(key) for key in ['status', 'elapsedSeconds', 'packageBytes', 'exitCode']}))
    if report['status'] != 'built':
        raise SystemExit(1)


if __name__ == '__main__':
    main()
