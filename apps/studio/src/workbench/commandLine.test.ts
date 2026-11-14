import { expect, it } from 'vitest';
import { commandLine } from './commandLine.ts';

it('leaves plain arguments as they are', () => {
  expect(commandLine(['pnpm', 'test', '--filter=@corral/studio', './src/a.ts'])).toBe(
    'pnpm test --filter=@corral/studio ./src/a.ts',
  );
});

it('quotes an argument a shell would split or expand', () => {
  expect(commandLine(['node', '-e', "console.log('README has a title')"])).toBe(
    `node -e "console.log('README has a title')"`,
  );
  expect(commandLine(['grep', 'two words', '*.md', ''])).toBe("grep 'two words' '*.md' ''");
  expect(commandLine(['sh', '-c', `echo "$HOME" 'it'`])).toBe(`sh -c 'echo "$HOME" '\\''it'\\'''`);
});
