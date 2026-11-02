#!/usr/bin/env python3
"""Run the worker's newest command file in a throwaway copy: no network, no home, bounded time."""
from pathlib import Path
import shlex
import subprocess
import sys

COMMANDS = '.harness/commands'
SECONDS = 270


def newest(root):
    names = sorted(path.name for path in (Path(root) / COMMANDS).glob('*.sh'))
    return names[-1] if names else None


def bwrap_prefix(node, layers):
    prefix = ['/usr/bin/bwrap', '--unshare-all', '--die-with-parent', '--ro-bind', '/usr', '/usr',
              '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib', '/lib64',
              '--symlink', 'usr/bin', '/bin', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
              '--ro-bind', node, '/opt/node', '--setenv', 'PATH', '/opt/node/bin:/usr/bin',
              '--setenv', 'HOME', '/tmp', '--setenv', 'CI', '1']
    for layer in layers:
        prefix += ['--overlay-src', str(layer)]
    return prefix + ['--tmp-overlay', '/work', '--chdir', '/work']


def corral_argv(deps, node, work, name):
    return [*bwrap_prefix(node, [deps, work]), 'timeout', '-k', '5', str(SECONDS),
            'bash', f'{COMMANDS}/{name}']


def docker_prefix(work, mount):
    return ['docker', 'run', '--rm', '--network', 'none', '--memory', '8g', '--cpus', '6',
            '--pids-limit', '4096', '-v', f'{work}:{mount}:ro']


def swe_argv(image, work, name):
    script = ('tar -C /work --exclude=./.git --exclude=./.harness -cf - . | tar -C /testbed -xf - && '
              'source /opt/miniconda3/bin/activate && conda activate testbed && cd /testbed && '
              f'timeout -k 5 {SECONDS} bash {shlex.quote(f"/work/{COMMANDS}/{name}")}')
    return [*docker_prefix(work, '/work'), image, 'bash', '-c', script]


def main():
    work = str(Path.cwd())
    name = newest(work)
    if name is None:
        print(f'No command file. Write one under {COMMANDS}/ first.')
        return 2
    kind, *rest = sys.argv[1:]
    argv = swe_argv(rest[0], work, name) if kind == 'swe' else corral_argv(rest[0], rest[1], work, name)
    print(f'[running {COMMANDS}/{name}]', flush=True)
    return subprocess.run(argv, check=False).returncode


if __name__ == '__main__':
    raise SystemExit(main())
