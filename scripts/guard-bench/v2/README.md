# GuardBench v2: PII with known shapes

v2 filters a v1 build, so ids, values and the family split are unchanged. `build.py` drops subjective categories, rows with no spans and rows with secrets. It keeps two PII tracks: `known-shape` (25 types, the headline) and `contextual` (names and addresses only). Clean rows lose staff names, which depend on company policy, and invalid-checksum rows for types with no checksum. Clearly fictional rows are reported on their own line.

```bash
python3 scripts/guard-bench/v2/build.py --v1 DIR --out V2DIR
```

```bash
go run ./engine/eval/guardbench --dataset V2DIR --split dev --policy pii-default --out dev.jsonl
```

```bash
python3 scripts/guard-bench/v2/score.py --dataset V2DIR --predictions dev.jsonl --engine rules --policy pii-default --split dev --out dev.json
```

Run the `go run` line from `guard/agent-go`. Scoring test needs `--final` and adds a line to `TEST-RUNS.jsonl`. Rule work uses dev. After a test score, a detector change needs newly sealed rows.

## Results, test split, 8,543 known-shape rows and 2,263 clean rows

| Setup | Known-shape PII blocked | Clean rows blocked | Names and addresses only | Fictional rows blocked |
|---|---|---|---|---|
| Rules, old policy | 22.8% | 0.9% | 0.0% | 2.0% |
| Rules, `pii-default` | 86.7% [86.0-87.4] | 2.2% [1.7-2.9] | 0.0% | 14.8% |
| Rules, `pii-all` | 94.7% [94.2-95.2] | 16.2% [14.7-17.8] | 11.3% | 30.2% |
| `pii-default` + Privacy Filter, dev cut-off 0.9999 | 95.5% | 8.5% | 68.3% | not scored |

`pii-default` asks instead of blocking on EIN, bank account and email, so those three do not count in its blocked column unless another kind fired. Per-type figures in `results/` count a kind firing, whichever action the policy takes.

## Limits

- The rows are synthetic and come from one generator. Dev and test share its noise and formats, so these figures do not predict real traffic.
- Rule context is row-wide for most kinds. On the Australian insurance corpus, 1,554 long documents the rules never saw, `driver-licence` fired on 17.2% of documents with no labelled licence (229 of 1,329). That corpus has unlabelled PII, so this is an upper bound on false fires, but v2 rows are too short to show the problem.
- The test split was already exposed once: a Python prototype of these rules was scored on v1 test, and its aggregate and per-type numbers were seen before the Go rules were written. Test text and generator templates were never read.
- v2 has no IP address, IBAN, VIN or medical record number rows, so those types are unmeasured.
