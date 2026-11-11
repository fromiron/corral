# Built-in themes

Corral's built-in themes ([features/themes.md](../docs/specs/features/themes.md)) are color values, not code. They live in `apps/studio/src/workbench/themes/builtin.ts`; `builtin.test.ts` compares them with the source files and checks every built-in id has an entry here.

- **Where the values were read**: the theme files of `@shikijs/themes` 4.5.0 as installed in this repository (a dependency of `shiki` 4.5.0, which `@pierre/diffs` 1.5.2 depends on; no package was added for themes). The package is MIT licensed, copyright (c) 2021 Pine Wu and (c) 2023 Anthony Fu. Its theme files are generated from the upstream projects named below; the upstream URL of each is the one in the `source` field of `sources-themes.ts` in [shikijs/textmate-grammars-themes](https://github.com/shikijs/textmate-grammars-themes), read on 2026-11-11.
- **Syntax colors, unchanged**: each of the eight syntax colors is the foreground the source theme paints one TextMate scope with: comment `comment.line.double-slash`, keyword `keyword.control`, string `string.quoted.double`, number `constant.numeric`, function `entity.name.function`, type `entity.name.type.class`, variable `variable.other.readwrite`, constant `constant.language`. The rule is the one whose plain selector (no descendant part) is the longest dotted prefix of the scope, the later rule on a tie; where no rule matches, the theme's `editor.foreground`. Values are only lower-cased.
- **Terminal colors, unchanged**: the sixteen are the source file's `terminal.ansiBlack` … `terminal.ansiBrightWhite`, lower-cased. Every theme below has all sixteen, so Corral chose no terminal color.
- **UI colors**: background and text are the theme's `editor.background` and `editor.foreground`; the other seven start from a color of the same theme, named per theme below. Where Corral's contrast rules (text, secondary text, the accent and the four status colors at 4.5:1 or more on surface steps 1–3, text at 4.5:1 on the selected row) were not met, Corral moved only the HSL lightness of that value, keeping its hue and saturation, to a little above 4.5:1. Those values are marked **adjusted** with the original beside them.
- **Licenses**: each upstream license file was read on its public repository on 2026-11-11. All are the MIT license; the copyright lines are quoted per theme. The MIT text below is the unmodified `LICENSE` of the installed `@shikijs/themes` 4.5.0; each upstream file carries the same terms under its own copyright line.

## Monokai — `builtin:monokai`

- Source file: `monokai.mjs` in `@shikijs/themes` 4.5.0.
- Upstream: Visual Studio Code's Monokai theme, [microsoft/vscode `extensions/theme-monokai/themes/monokai-color-theme.json`](https://github.com/microsoft/vscode/blob/main/extensions/theme-monokai/themes/monokai-color-theme.json). MIT License, "Copyright (c) 2015 - present Microsoft Corporation". The extension's `cgmanifest.json` names its origin as [Colorsublime/Colorsublime-Themes](https://github.com/Colorsublime/Colorsublime-Themes) (commit `c10fdd8b144486b7a4f3cb4e2251c66df222a825`), whose `LICENSE` is the MIT license, "Copyright (c) 2015 Colorsublime.com".
- Unchanged: all eight syntax colors and all sixteen terminal colors; background `#272822`, text `#f8f8f2`, accent `#66d9ef` (`terminal.ansiBrightCyan`), selected row `#75715e` (`list.activeSelectionBackground`), success `#a6e22e` (`terminal.ansiBrightGreen`), warning `#e6db74` (the string color), info `#819aff` (`terminal.ansiBrightBlue`).
- Adjusted: secondary text `#9e9e98` (from `editorLineNumber.foreground` `#90908a`); error `#fb6ea1` (from the keyword pink `#f92672`).

## Dracula — `builtin:dracula`

- Source file: `dracula.mjs` in `@shikijs/themes` 4.5.0.
- Upstream: [dracula/visual-studio-code `src/dracula.yml`](https://github.com/dracula/visual-studio-code/blob/main/src/dracula.yml). The MIT License (MIT), "Copyright (c) 2016 Dracula Theme".
- Unchanged: all eight syntax colors and all sixteen terminal colors; background `#282a36`, text `#f8f8f2`, accent `#bd93f9` (purple), selected row `#44475a` (`editor.selectionBackground`), success `#50fa7b`, warning `#ffb86c` (orange), info `#8be9fd` (cyan).
- Adjusted: secondary text `#96a0c2` (from the comment color `#6272a4`); error `#ff7676` (from `editorError.foreground` `#ff5555`).

## Nord — `builtin:nord`

- Source file: `nord.mjs` in `@shikijs/themes` 4.5.0.
- Upstream: [arcticicestudio/nord-visual-studio-code `themes/nord-color-theme.json`](https://github.com/arcticicestudio/nord-visual-studio-code/blob/develop/themes/nord-color-theme.json). MIT License (MIT), "Copyright (c) 2016-present Sven Greb <development@svengreb.de> (https://www.svengreb.de)".
- Unchanged: all eight syntax colors and all sixteen terminal colors; background `#2e3440`, text `#d8dee9`, accent `#88c0d0` (`badge.background`), selected row `#434c5e` (`list.inactiveSelectionBackground`), success `#a3be8c`, warning `#ebcb8b` (`editorWarning.foreground`).
- Adjusted: secondary text `#a2abbd` (from the comment color `#616e88`); error `#d79ba1` (from `editorError.foreground` `#bf616a`); info `#92aec9` (from `#81a1c1`).

## One Dark Pro — `builtin:one-dark-pro`

- Source file: `one-dark-pro.mjs` in `@shikijs/themes` 4.5.0.
- Upstream: [Binaryify/OneDark-Pro `themes/OneDark-Pro.json`](https://github.com/Binaryify/OneDark-Pro/blob/master/themes/OneDark-Pro.json). The MIT License (MIT), "Copyright (c) 2013-2022 Binaryify".
- Unchanged: all eight syntax colors and all sixteen terminal colors; background `#282c34`, text `#abb2bf`, accent `#61afef` (`textLink.foreground`), success `#98c379`, warning `#e5c07b`, info `#56b6c2`.
- Adjusted: secondary text `#9a9ea6` (from the comment color `#7f848e`); selected row `#3d4351` (from `focusBorder` `#3e4452`, darkened so text reaches 4.5:1); error `#e48189` (from `#e06c75`).

## Tokyo Night — `builtin:tokyo-night`

- Source file: `tokyo-night.mjs` in `@shikijs/themes` 4.5.0.
- Upstream: [enkia/tokyo-night-vscode-theme `themes/tokyo-night-color-theme.json`](https://github.com/enkia/tokyo-night-vscode-theme/blob/master/themes/tokyo-night-color-theme.json). The MIT License (MIT), "Copyright (c) 2018-present Enkia".
- Unchanged: all eight syntax colors and all sixteen terminal colors; background `#1a1b26`, text `#a9b1d6`, accent `#7aa2f7`, error `#f7768e`, success `#9ece6a`, warning `#e0af68`, info `#7dcfff`.
- Selected row `#2b2f41`: `editor.selectionBackground` `#515c7e4d` composited over the background, since a row color must be opaque.
- Adjusted: secondary text `#878ca8` (from `descriptionForeground` `#515670`).

## Gruvbox Dark — `builtin:gruvbox-dark`

- Source file: `gruvbox-dark-medium.mjs` in `@shikijs/themes` 4.5.0.
- Upstream: [jdinhify/vscode-theme-gruvbox `src/main.ts`](https://github.com/jdinhify/vscode-theme-gruvbox/blob/main/src/main.ts). MIT license text, "Copyright © 2017 JD".
- Unchanged: all eight syntax colors and all sixteen terminal colors; background `#282828`, text `#ebdbb2`, accent `#83a598`, selected row `#504945`, success `#b8bb26`, warning `#fabd2f`, info `#8ec07c`.
- Adjusted: secondary text `#a99a85` (from `tab.inactiveForeground` `#a89984`); error `#fc7161` (from `errorForeground` `#fb4934`).

## Solarized Light — `builtin:solarized-light`

- Source file: `solarized-light.mjs` in `@shikijs/themes` 4.5.0.
- Upstream: Visual Studio Code's Solarized Light theme, [microsoft/vscode `extensions/theme-solarized-light/themes/solarized-light-color-theme.json`](https://github.com/microsoft/vscode/blob/main/extensions/theme-solarized-light/themes/solarized-light-color-theme.json). MIT License, "Copyright (c) 2015 - present Microsoft Corporation". The extension's `cgmanifest.json` names its origin as [Colorsublime/Colorsublime-Themes](https://github.com/Colorsublime/Colorsublime-Themes) (commit `c10fdd8b144486b7a4f3cb4e2251c66df222a825`), whose `LICENSE` is the MIT license, "Copyright (c) 2015 Colorsublime.com".
- Unchanged: all eight syntax colors and all sixteen terminal colors; background `#fdf6e3`, selected row `#eee8d5` (`editor.selectionBackground`).
- Adjusted (the source's own text color is 4.1:1 on its background, and its accents are lighter): text `#445258` (from `editor.foreground` `#657b83`, darkened further than 4.5:1 so secondary text stays distinct from it); secondary text `#637272` (from the comment color `#93a1a1`); accent `#2074af` (from `#268bd2`); error `#d72724` (from `#dc322f`); success `#667500` (from `#859900`); warning `#8c6a00` (from `#b58900`); info `#207b74` (from `#2aa198`).

## Catppuccin Latte — `builtin:catppuccin-latte`

- Source file: `catppuccin-latte.mjs` in `@shikijs/themes` 4.5.0.
- Upstream: [catppuccin/vscode `packages/catppuccin-vsc`](https://github.com/catppuccin/vscode/blob/main/packages/catppuccin-vsc/package.json). MIT License, "Copyright (c) 2021 Catppuccin".
- Unchanged: all eight syntax colors and all sixteen terminal colors; background `#eff1f5`, text `#4c4f69`, accent `#8839ef` (`focusBorder`), selected row `#ccd0da` (`list.activeSelectionBackground`), error `#d20f39`.
- Adjusted: secondary text `#696b81` (from `disabledForeground` `#6c6f85`); success `#317a21` (from `#40a02b`); warning `#976014` (from `#df8e1d`); info `#145ff5` (from `#1e66f5`).

## Not included

No candidate was dropped: the eight themes above were all verified. Syntax and terminal colors keep the source values, so some (comments in particular) are below 4.5:1 on their background, as in the source themes; the terminal keeps xterm's minimum contrast correction.

## MIT license

```
MIT License

Copyright (c) 2021 Pine Wu
Copyright (c) 2023 Anthony Fu <https://github.com/antfu>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
