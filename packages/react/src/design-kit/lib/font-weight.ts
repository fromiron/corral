// Inter (variable) weight tokens for `fontVariationSettings`: `normal` for
// text, `semibold` for headings and selected items, `bold` for display only.
//
// Each weight is paired with an `opsz` so switching weights keeps text width
// nearly constant (heavier `wght` widens, higher `opsz` narrows). Setting
// `opsz` explicitly intentionally overrides `font-optical-sizing: auto`.
export const fontWeights = {
  normal: "'wght' 400, 'opsz' 14",
  semibold: "'wght' 550, 'opsz' 18",
  bold: "'wght' 700, 'opsz' 25",
} as const;
