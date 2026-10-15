import { execFileSync } from 'node:child_process';

export default function build() {
  execFileSync(
    'pnpm',
    ['exec', 'vite', 'build', '--mode', 'performance', '--outDir', 'dist-performance'],
    {
      cwd: new URL('../..', import.meta.url),
      stdio: 'inherit',
    },
  );
}
