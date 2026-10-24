# DeepSeek Harness ports (MIT)

Upstream: https://github.com/deepseek-ai/deepseek-harness/tree/22ddee3792402c3e70ec5f86a63c3e3e895a2f60

- context.ts: core/session/src/surface.ts replacement ranges; compaction/compaction-basic/src/region.ts backwards retention and balanced boundaries, stability and shrink checks; compaction-basic/src/summarizer.ts prefix-preserving summary request; compaction-tool-result-pruner/src/index.ts Unicode head/middle/tail pruning; llm/token-meter/src/index.ts envelope-matched usage anchors and estimate.ts density/framing estimates. Pi image blocks use its 2000-token heuristic, not base64 byte length; multilingual text uses a conservative UTF-8 adjustment. Tools are counted once from the resolved declarations.
- retry.ts: llm/llm/src/retry-policy.ts bounded exponential jitter and llm/llm-retry/src/index.ts cancellable delay.

Changes: Pi message types and Corral identities replace DSH events/Cordis injection, original context remains immutable, source references use existing Corral storage, Unicode estimates remain explicitly estimates, retry is bounded to two and ambiguous outcomes are not retried. No DSH npm package or Cordis runtime was installed. See adjacent LICENSE for original terms.

Corral additionally appends an internal-compaction system instruction while retaining the original prefix. The host uses toolChoice=none for summary attempts so task submission instructions cannot execute during compaction. An exact usage anchor can calibrate estimates both downward and upward; new suffixes remain estimates.
