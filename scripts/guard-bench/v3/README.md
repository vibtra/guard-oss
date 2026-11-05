# GuardBench v3: personal identifiers

This bench scores the `identifiers` detector. It covers identifiers with a known shape: national IDs, tax numbers, passports, licences, bank accounts and health numbers. Emails and phone numbers are outside the headline, and secrets are scored on their own.

No test data is in this folder. Fake secrets and generated rows stay out of git.

## Files

| File | What it is |
|---|---|
| `PREREG.md` | The gates, written before each scoring run, with the detector hash |
| `SEALED-RUNS.jsonl` | Every freeze and result, including misses |
| `core_gen.py` | Generates `packs/core.json`. Run `python3 -I scripts/guard-bench/v3/core_gen.py guard/agent-go/engine/rules/internal/detect/packs/core.json`. Never edit that file by hand |
| `secrets_gen.py` | Generates `secretpack/secrets.json` |
| `vocab_merge.py` | Merges `synonyms.json` into a world pack |
| `synonyms.json`, `ambiguous.txt` | Label vocabulary written by an agent that saw no test data, and the short words that also have an everyday meaning |
| `mark_strong.py` | Sets the person-record tier on entries with a strong check |
| `seg2.py`, `hom.py` | Split a blind set's score into labelled, unlabelled, clean, ordinary and homograph |

## Method

1. Tune only on dev sets and spent sets.
2. Freeze the detector and write the gates and hash into `PREREG.md`.
3. Score an unseen set once. Reading its misses makes it spent.
4. Any later change needs a new set.

Blind sets are written by agents that cannot read the detector. Each one reuses value generators and the type list from one table.

## Results on unseen sets

Only the last freeze below is the shipped detector. Target: labelled at least 95%, false positives at most 2%.

| Freeze | Set | Labelled | Near | Far | False positives | Lookalike false positives |
|---|---|---|---|---|---|---|
| `f0567e2f0071974f` | blind4 | 93.17% | | | 6.30% | 4.31% |
| `eb6f136d01ebe572` | blind5 | 94.03% | | | 0.82% | 4.17% |
| `5922f9902b627ea2` | blind6 | 75.46% | | | 1.05% | 8.61% |
| `9c17df705223994d` | blind7 | 89.57% | 94.63% | 74.41% | 0.73% | 9.44% |
| `5d8bc2abc9129d9a` | blind8 | 93.10% | 96.24% | 83.70% | 1.95% | 3.47% |
| `7f20397eb3100916` | blind9 | 93.90% | 95.72% | 88.43% | 3.15% | 5.14% |

The target is not met on the last freeze.

blind4 and blind5 took their labels from the same table the pack started from, so they overstate recall. From blind6 on, half the labels are the author's own wording. From blind8 on, negatives include documents that name an identifier beside ordinary numbers. blind9 also varied the wording of those numbers, and false positives on that kind of row reached 20.86%.

Lookalike rows come from the v2 generator: correctly shaped, explicitly labelled values marked as fictional or asked about in general. A rules engine can't tell they are fake.

Unlabelled plain numbers score about 35 to 38% on every set. Most can't be decided without a label.

## Models compared

Decision: Guard launches with rules alone. See `docs/decisions/0003-identifiers-rules-only.md`.

All on blind9, 11,490 rows. Each model ran as published, with no training. The model score cut-offs were read on this set, so the model rows are slightly optimistic.

| Detector | Labelled | Unlabelled | False positives | Ordinary numbers | Names an ID type | p50 per row |
|---|---|---|---|---|---|---|
| Rules, freeze `7f20397eb3100916` | 93.90% | 36.25% | 3.15% | 0.36% | 20.86% | 0.33ms |
| Privacy Filter, `account_number` at any score | 79.58% | 67.49% | 64.08% | 71.07% | 54.57% | 5.6ms |
| Von, general personal-data question, score at least 0.5 | 75.20% | 76.96% | 35.83% | 35.96% | 54.00% | 108ms |
| Von, ID-only question, score at least 0.5 | 69.54% | 85.34% | 17.03% | 16.36% | 33.71% | 106ms |
| Rules OR Von (ID-only), score at least 0.999 | 95.26% | 66.48% | 7.72% | 4.96% | 27.71% | 106ms when Von runs |
| Rules AND Von (ID-only), score at least 0.5 | 66.21% | 31.06% | 1.47% | 0.11% | 11.86% | 106ms when Von runs |

With false positives held to 2%, Privacy Filter alone catches 16.01% of labelled rows and Von alone 15.66%. Von is `verdict-models/von` at `8c8f52c2`, a 1.58GB ONNX model run on CPU in three processes at once. Privacy Filter is the bf16 MLX build. The runners are not in this repository.

84% of the ordinary negatives contain a person's name, which is why the general question over-fires. The ID-only question was written once and not tuned.

## Limits

- All sets are synthetic, and the agents that wrote them and the vocabulary are the same model, so their wording overlaps.
- Native-language text has had no native-speaker review.
- The negative mix is a choice. Label-mention rows are 11.7% of blind9's negatives, and that share sets the headline false-positive rate.
- The insurance corpus has no clean rows and its annotations are incomplete, so it measures recall only.
