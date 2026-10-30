"""Reference embeddings and timings from the official LiteRT-LM Python API.

Development-only spike tool, never shipped. Run with:
  uv run --no-project --python 3.13 --with litert-lm-api==0.19.0 \
    python reference/litert_reference.py <model.litertlm> <out.json> [cpu|gpu] [threads]
"""

import json
import pathlib
import statistics
import sys
import time

import litert_lm
from litert_lm import embedding_engine

PREFIX = "task: classification | query: "
REPS = 20


def main() -> None:
    model, out = sys.argv[1], pathlib.Path(sys.argv[2])
    backend_name = sys.argv[3] if len(sys.argv) > 3 else "cpu"
    threads = int(sys.argv[4]) if len(sys.argv) > 4 else None
    fixtures = json.loads((pathlib.Path(__file__).parent.parent / "fixtures/texts.json").read_text())

    backend = (
        litert_lm.Backend.GPU()
        if backend_name == "gpu"
        else litert_lm.Backend.CPU(thread_count=threads)
    )
    started = time.perf_counter()
    engine = embedding_engine.EmbeddingEngine(model, backend=backend)
    load_ms = (time.perf_counter() - started) * 1000
    options = embedding_engine.EmbeddingOptions(normalize=True, output_size=768)

    def embed(text: str) -> list[float]:
        return list(engine.compute_embedding(PREFIX + text.strip(), options).embedding)

    started = time.perf_counter()
    embed(fixtures[0]["text"])
    first_ms = (time.perf_counter() - started) * 1000

    results = []
    for entry in fixtures:
        vector = embed(entry["text"])
        timings = []
        for _ in range(REPS):
            started = time.perf_counter()
            embed(entry["text"])
            timings.append((time.perf_counter() - started) * 1000)
        timings.sort()
        results.append(
            {
                "id": entry["id"],
                "p50": statistics.median(timings),
                "p95": timings[int(len(timings) * 0.95) - 1],
                "embedding": vector,
            }
        )

    batch = [PREFIX + entry["text"].strip() for entry in fixtures if entry["size"] == "short"]
    started = time.perf_counter()
    engine.compute_embedding_batch([[text] for text in batch], options)
    batch_ms = (time.perf_counter() - started) * 1000

    out.write_text(
        json.dumps(
            {
                "runtime": "litert-lm-python-0.19.0",
                "backend": backend_name,
                "threads": threads,
                "loadMs": load_ms,
                "firstMs": first_ms,
                "batch16Ms": batch_ms,
                "results": results,
            }
        )
    )
    for row in results:
        print(f"{row['id']:<14} p50 {row['p50']:7.1f} ms  p95 {row['p95']:7.1f} ms")
    print(f"load {load_ms:.0f} ms, first {first_ms:.0f} ms, batch of {len(batch)} short {batch_ms:.0f} ms")


if __name__ == "__main__":
    main()
