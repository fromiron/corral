// A command's arguments as one line a shell would read back into the same arguments. Display
// only: commands always run from their argument array, never from this text.

const PLAIN = /^[A-Za-z0-9_@%+=:,./-]+$/;
/** Characters a double-quoted shell word would still expand or end on. */
const ACTIVE_IN_DOUBLE_QUOTES = /["$`\\!]/;

function quoteArgument(argument: string): string {
  if (PLAIN.test(argument)) return argument;
  if (!argument.includes("'")) return `'${argument}'`;
  if (!ACTIVE_IN_DOUBLE_QUOTES.test(argument)) return `"${argument}"`;
  return `'${argument.replaceAll("'", "'\\''")}'`;
}

export function commandLine(argv: readonly string[]): string {
  return argv.map(quoteArgument).join(' ');
}
