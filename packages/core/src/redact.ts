// One rule for text that came from tools and is shown or handed on: credential-looking values are
// masked, the workspace folders become `[workspace]` and any other absolute path becomes `[path]`.
// Pure, so the server's check output and the advisor's review input stay the same rule.

/**
 * Masks credentials and replaces workspace and other absolute paths, in that order. A path inside
 * a workspace keeps its relative part (`[workspace]/src/a.ts`).
 */
export function redactCredentialsAndPaths(raw: string, workspaceRoots: readonly string[]): string {
  let text = raw;
  for (const root of workspaceRoots) if (root) text = text.split(root).join('[workspace]');
  return text
    .replace(/(bearer\s+)[\w.+/=-]+/gi, '$1[redacted]')
    .replace(/\b(?:sk-|rt-|eyJ)[\w.-]{8,}/g, '[redacted]')
    .replace(
      /\b[\w-]*(?:token|secret|password|api[_-]?key)[\w-]*\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi,
      '[credential redacted]',
    )
    .replace(/(?:[A-Za-z]:\\|(?<![:/\w\]])\/)(?:[^\s:<>"'|]+[\\/])*[^\s:<>"'|]*/g, '[path]');
}
