# LLM runtime ports

Corral includes adapted PI-Desktop code under LGPL-3.0-only and DeepSeek Harness code under MIT. Original copyright notices are retained with the source.

- PI-Desktop: vastsa/pi-desktop, commit `1a812ed7b84e0bd1b117080eb4e51c76eba35d48`; source in `packages/pi-runtime-port`. The Node runtime loads the package separately; Studio bundles its environment-neutral budget module.
- DeepSeek Harness: deepseek-ai/deepseek-harness, commit `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`; source in `packages/adapter-pi/src/ported/dsh`.
- A contributor's coding-agent harness (the contributor's own code, shared with permission): `packages/adapter-pi/src/ported/thinking-loop.ts`, the thinking-loop detector, copied with its thresholds and adapted to Corral's retry stream.
- A contributor's coding-agent workbench (the contributor's own code, shared with permission): `apps/server/src/pull-requests/prompt.ts`, the pull request content instructions and section limit, adapted without the change request template and conversation context. The same workbench's pull request watch gives `packages/core/src/pull-request-watch.ts` its failed-check and conflict rules and its wake wording; reviews, comments, approvals and passing checks are left out.
- Pi AI 1.6.0 (MIT) includes the local patch `patches/@earendil-works__pi-ai@1.6.0.patch` to honor `maxRetries: 0` in the Bedrock SDK transport.

The desktop runtime includes complete corresponding application and modified library sources in `corresponding-source/corral`, their checksum manifest, `sbom.spdx.json`, and `THIRD-PARTY-NOTICES/installed-packages.txt`. The latter contains the full GPLv3, LGPLv3 and MIT notices. Symbolic links in the source tree are listed in the checksum manifest with their targets instead of being copied. The PI package's NOTICE.md describes replacing the server module and rebuilding the browser/desktop application with a modified library. Modification and reverse engineering for debugging the LGPL library are permitted.

The original Corral source retains its MIT license. See [GNU LGPLv3 section 4](https://www.gnu.org/licenses/lgpl-3.0.html) and the bundled license texts for the terms governing the included library and combined distribution.
