# LLM runtime ports

Corral includes adapted PI-Desktop code under LGPL-3.0-only and DeepSeek Harness code under MIT. Original copyright notices are retained with the source.

- PI-Desktop: vastsa/pi-desktop, commit `1a812ed7b84e0bd1b117080eb4e51c76eba35d48`; source in `packages/pi-runtime-port`. The Node runtime loads the package separately; Studio bundles its environment-neutral budget module.
- DeepSeek Harness: deepseek-ai/deepseek-harness, commit `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`; source in `packages/adapter-pi/src/ported/dsh`.
- Pi AI 1.3.0 (MIT) includes the local patch `patches/@earendil-works__pi-ai@1.3.0.patch` to honor `maxRetries: 0` in the Bedrock SDK transport.

The desktop runtime includes complete corresponding application and modified library sources in `corresponding-source/corral`, their checksum manifest, `sbom.spdx.json`, and `THIRD-PARTY-NOTICES/installed-packages.txt`. The latter contains the full GPLv3, LGPLv3 and MIT notices. The PI package's NOTICE.md describes replacing the server module and rebuilding the browser/desktop application with a modified library. Modification and reverse engineering for debugging the LGPL library are permitted.

The original Corral source retains its MIT license. See [GNU LGPLv3 section 4](https://www.gnu.org/licenses/lgpl-3.0.html) and the bundled license texts for the terms governing the included library and combined distribution.
