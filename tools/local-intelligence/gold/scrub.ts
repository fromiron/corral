// Removes credentials and personal details before anything reaches the gold directory. The text
// stays local either way; this keeps a leaked item or a shared screen from carrying a live secret.
const SECRET = '<secret>';
const RULES: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, SECRET],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, SECRET],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, SECRET],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, SECRET],
  [/\bAIza[A-Za-z0-9_-]{30,}/g, SECRET],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, SECRET],
  [/\bAKIA[A-Z0-9]{16}\b/g, SECRET],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/g, SECRET],
  [/\bgAAAAA[A-Za-z0-9_=-]{40,}/g, SECRET],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${SECRET}`],
  [/([?&](?:token|key|api_key|apikey|secret|password|auth)=)[^\s&#"'<>]+/gi, `$1${SECRET}`],
  [
    /((?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd|token)["']?\s*[:=]\s*["']?)[^\s"',;]{4,}/gi,
    `$1${SECRET}`,
  ],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, '<email>'],
  [/\/(?:home|Users)\/[^/\s"']+/g, '~'],
  [/[A-Za-z]:\\Users\\[^\\\s"']+/g, '~'],
];

export function scrub(text: string): string {
  return RULES.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text);
}
