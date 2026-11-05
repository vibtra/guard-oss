# engine eval

`vibtra-guard engine eval` scores the engine that `main.go` wires in against a labelled PII dataset. Every engine is scored the same way, through the `Engine` port. It changes no engine behaviour.

## Dataset

[soates/australian-insurance-pii-dataset](https://huggingface.co/datasets/soates/australian-insurance-pii-dataset), revision `3fa92a6c350b24acd8a03d1484fc704bb5c5bcac`. It holds 1,554 insurance customer letters with Australian PII: train 1,243, validation 155 and test 156.

The dataset card has no licence, so the data is not redistributable and is not in this repository. `evals/datasets/` is gitignored. Download it yourself:

```sh
mkdir -p evals/datasets/australian-insurance-pii-dataset/data
for s in train validation test; do
  curl -fL -o evals/datasets/australian-insurance-pii-dataset/data/$s-00000-of-00001.parquet \
    https://huggingface.co/datasets/soates/australian-insurance-pii-dataset/resolve/3fa92a6c350b24acd8a03d1484fc704bb5c5bcac/data/$s-00000-of-00001.parquet
done
```

Expected sha256: train `278c2630…890c31f`, validation `3d367c3a…d22`, test `6b787bbe…56a4`. The converter writes the full hashes to `jsonl/manifest.json`.

Columns: `original_text`, `redacted_text`, `annotations`, `id`. `annotations` is a JSON string `{"annotations": [{"type", "text", "start_char", "end_char", "should_redact"}]}`. `text` can be null.

Known defects, measured with the runner:

- Only 22 of 11,020 `start_char`/`end_char` offsets match the text. The runner finds spans by their text, not their offsets.
- In 1,314 of 1,554 rows, `redacted_text` still contains a `should_redact` span: the placeholders were spliced in at the wrong offsets. The runner therefore builds its own redaction for the false-block score. It replaces each `should_redact` span's text with `[LABEL]`. Rows with a span that is not in the text are left out of that score. The shipped `redacted_text` score is reported too, but it is not a valid control.
- About 115 different label strings occur. `labels.go` maps them to 11 labels. A label not in that table counts as `OTHER`.
- 210 rows have no `should_redact` span.

## Parquet

Go reads JSONL, not parquet. A pure-Go parquet reader would add a dependency to `go.mod`, which is a gate file. `scripts/eval-pii-parquet-to-jsonl.py` (pyarrow) writes `jsonl/{train,validation,test}.jsonl` and `jsonl/manifest.json` next to `data/`.

## Run

```sh
uv run --no-project --with pyarrow python3 scripts/eval-pii-parquet-to-jsonl.py evals/datasets/australian-insurance-pii-dataset
go -C guard/agent-go build -o build/vibtra-guard .
VIBTRA_GUARD_DIR="$(mktemp -d)" guard/agent-go/build/vibtra-guard engine eval \
  --dataset evals/datasets/australian-insurance-pii-dataset [--engine rules] [--split all|train|validation|test] [--out results.json]
```

`--engine` must name the engine this binary runs. To score another engine, swap it in `main.go` as `engine/README.md` describes, then rebuild.

## What it measures

Each row is sent as the body of a JSON chat request, `{"messages":[{"role":"user","content":TEXT}]}`, to the one service in an enforce-mode eval policy (`policy.go`). That policy blocks on `au-tfn`, `au-medicare`, `au-abn`, `au-acn`, `card-number`, `secret`, `email-bulk` (10 or more) and `phone-bulk` (10 or more).

| Score | Meaning |
|---|---|
| recall | `original_text` gets `Verdict: blocked` with `Enforced`. Reported over all rows and over rows with a `should_redact` span |
| false-block | the derived redaction is blocked. The shipped `redacted_text` is scored separately |
| labels | for each label, the share of rows with a `should_redact` span of that label in which a non-excepted match of a mapped kind fired (`KindLabels`). An engine can also return the label itself as `Match.Kind`. This score is per row, not per span |
| latency | wall time of `Decide` alone, p50 and p95, over all three decisions per row |

Rates come with Wilson 95% intervals. The results JSON records the engine, the git SHA (from the Go build info), the dataset hash (sha256 of the JSONL read), the parquet hashes, and the policy and catalogue digests. It also has `escapes`, the rows that were not blocked, with their labels and missed labels (the work queue), and `falseBlocks`. It contains no row text.

`results/rules-australian-insurance-pii.json` is the run for the `rules` engine at `feff38e`.

