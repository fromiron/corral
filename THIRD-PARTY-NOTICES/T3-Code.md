# T3 Code UI port

Source: https://github.com/pingdotgg/t3code/tree/70d60e03a7a35c6fa131825bbfa05ec893e69912

Adapted files: `packages/react/src/ui/`, `apps/studio/src/workbench/Sidebar.tsx`, `ChatView.tsx`, and `ComposerSurface.tsx`. Sidebar and ChatView retain the upstream pane, row, menu, timeline/composer and panel composition, with Corral repositories, events and commands replacing T3 provider/runtime dependencies. Unused provider, remote, terminal, source-control and media surfaces are omitted. Tokens and text are adapted for Corral and its locales.

MIT License

Copyright (c) 2026 T3 Tools Inc.

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
