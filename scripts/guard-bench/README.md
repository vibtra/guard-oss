# GuardBench

A synthetic benchmark of what employees type into AI chatbots. About 50,000 rows, 80% violations (PII or out-of-policy content) and 20% hard negatives, across 24 industries, with Australian and US identifiers. "Engine X scored Y on GuardBench v1."

Every value is synthetic. No real person, conversation or scraped data is used; phone numbers are drawn near the ranges ACMA and NANPA set aside for fiction (AU `(0N) 5550 xxxx` is exact, AU mobiles are near but not inside ACMA's reserved blocks, US `555-01xx` is exact). Categories come from public frameworks; see `taxonomy.json` and the project taxonomy notes. Template authors are LLMs; rows are filled by a seeded deterministic generator, so the dataset regenerates byte-identically from `--seed 20261103`.

## Layout

| Path | What |
|---|---|
| `taxonomy.json` | category ids, jurisdictions, industries, held-out industries |
| `templates/<industry>.jsonl` | LLM-written templates (one JSON object per line) |
| `generator/` | stdlib-only Python: value makers, noise, rendering, split, dedupe, checks, audit sampler |
| `data/` | generated `dev.jsonl.gz`, `test.jsonl.gz` (not in git) and `MANIFEST.json` (SHA256 of every file) |
| `kind-map.json` | maps an engine's detector kinds to GuardBench span types |
| `score.py` | `predictions.jsonl` + dataset -> metrics JSON and markdown |
| `leaderboard.py` | `results/*.json` -> `LEADERBOARD.md` |
| `results/` | scored runs (no row text) |
| `guard/agent-go/engine/eval/guardbench/` | Go runner: runs one `engine.Engine` over a split and writes `predictions.jsonl` |

## Row schema (JSONL, one object per line)

| Field | Type | Meaning |
|---|---|---|
| `id` | string | `gb1-NNNNNN` |
| `split` | `dev` or `test` | assigned by template family; held-out industries are test only |
| `industry`, `role` | string | |
| `description` | string | 1-2 sentences: who is typing and why |
| `prompt` | string | the text sent to the chatbot |
| `row_label` | `violation` or `clean` | |
| `categories` | string[] | taxonomy ids the row belongs to; every span type in the row is listed too; clean rows list `neg-*` ids |
| `spans` | object[] | `{start, end, type, jurisdiction, value_valid}`; offsets are Unicode code points, `[start, end)` into `prompt`; empty for clean rows |
| `lookalikes` | object[] | `{start, end, type}`: ID-shaped values in clean rows that are not violations |
| `policy_basis` | string | framework or category rationale |
| `difficulty` | `easy`, `medium`, `hard` | |
| `template_family_id` | string | the split unit |
| `shape` | string | `oneliner`, `short`, `paragraph`, `document` |
| `jurisdiction` | `AU`, `US`, `none`, `mixed` | row-level |
| `generator_version`, `seed` | string, int | |

Span `type` values are the PII category ids (`au-tfn`, `au-medicare`, `au-abn`, `au-acn`, `au-driver-licence`, `au-passport`, `au-bsb`, `au-account`, `au-crn`, `au-ihi`, `au-phone`, `au-address`, `au-dob`, `au-name`, `us-ssn`, `us-itin`, `us-ein`, `us-driver-licence`, `us-passport`, `us-routing`, `us-account`, `us-card`, `us-mbi`, `us-npi`, `us-phone`, `us-address`, `us-dob`, `us-name`, `email`) plus `secret` for credentials. Prose policy categories (privilege, M&A, HR, trade secrets) are row-level only.

## Predictions format (`predictions.jsonl`, one line per scored row)

```json
{"id": "gb1-000001", "blocked": true, "kinds": ["au-tfn"], "latency_us": 412}
```

`blocked` is the engine's enforce verdict. `kinds` are its raw detector kinds; row metrics never read them, and `score.py` prints which kinds fired on violation and clean rows (mapped through `kind-map.json` where a mapping exists). `spans` (`[{"start","end","type"}]`, code-point offsets) is optional and is what a span-level engine, such as a Python NER model, adds: no engine in this repository returns raw offsets, so the rules engine has none and span metrics print `n/a`. `latency_us` is wall time of `Decide` alone. `error` marks a row the engine failed on.

A predictions file must cover every row of the split. `score.py` exits non-zero when rows are missing, errored or the run was cut short with `--limit`; `--allow-incomplete` scores what is there and marks the result `incomplete`, and the leaderboard ranks incomplete results last.

## Metrics (`score.py`)

- Row level: recall = violation rows blocked / violation rows; false-block rate = clean rows blocked / clean rows. Both with Wilson 95% intervals, overall and per jurisdiction, category, industry, difficulty, and for the held-out industries. The leaderboard ranks results at or under 5% false-block by recall first, then the rest.
- Span level (engines with spans): precision and recall per span type, matched one-to-one, exact `[start,end)` and overlap in brackets. A span in a clean row is a false positive.
- Kinds fired: per engine kind, rows fired on violation rows and on clean rows (counts only).
- Latency: p50 and p95 of `latency_us`.
- Headline: `GuardBench v1: <engine> catches X% of violations at Y% false blocks`.
- Default split is `test`.

## Reproduce

```sh
python3 scripts/guard-bench/generator/build.py --seed 20261103 --out scripts/guard-bench/data
python3 scripts/guard-bench/generator/checks.py scripts/guard-bench/data
```

Run on a DO box (`do-ci.sh --cmd`), not a laptop. `build.py` is deterministic: two runs give identical files. `data/MANIFEST.json` records the SHA256 of the decompressed JSONL (`data/dev.jsonl`, `data/test.jsonl`, stable across zlib builds) and of the `.gz` bytes, with the Python version.

## GuardBench v1

| Item | Value |
|---|---|
| Rows | 50,000: dev 35,000, test 15,000 (frozen v1 test split) |
| Labels | 40,000 violation (80%), 10,000 clean (20%); same ratio in both splits |
| Templates | 2,449 across 24 industries (1,844 violation, 605 clean) written by sonnet workers, linted, then filtered by audit; 109 retired templates are kept in `templates/retired/` |
| Held-out industries | mining-resources, aged-care, maritime-shipping: test only (6,063 of the 15,000 test rows) |
| Seed | `--seed 20261103`, generator 1.0.0; two builds give byte-identical files |
| `dev.jsonl.gz` SHA256 | `a4ed882df2b08abbf7923f90e1d0d5b38027033d4f4e3c5e487989e8cfad2942` (decompressed JSONL: `70a3e503a4d948d2121de4bcfb5322b7b9157eff7dd7c85aa58331477e2c106c`) |
| `test.jsonl.gz` SHA256 | `323f0be30606d5c255a426b18f8a3934475494780d22c823ebb9ef4f4d7a5abc` (decompressed JSONL: `33af2416c1d9e359aea891dde4c98b2d99ca3dfef0ea3307def5145f1a0082ab`) |
| Checks | `generator/checks.py`: 0 failures on 39,652 spans with a structural or checksum validator, of which TFN, Medicare, ABN, ACN, IHI, routing, card and NPI carry a check digit (span offsets, checksum vs `value_valid`, look-alikes fail every strong checksum, no family in both splits, held-out industries test-only, no cross-split near-duplicates, 80/20 ratio) |
| Audit | LLM-judge on 1,000 stratified rows: 95.6% all-three agreement (label 99.7%); see `AUDIT.md` |

The `.jsonl.gz` files are not in git (they hold fake secret-shaped strings that trip secret scanners, and they regenerate from the seed). `data/MANIFEST.json` lists the SHA256 of every file that goes into them: templates, `taxonomy.json` and the generator.

Leaderboard: see [LEADERBOARD.md](LEADERBOARD.md). On the test split (15,000 rows):

- **GuardBench v1: rules catches 21.9% of violations at 0.9% false blocks.**

The eval policy is `engine/eval/policy.go` (TFN, Medicare, ABN, ACN, card number, secret, bulk email/phone). The rules engine returns no offsets, so span metrics are `n/a`.

## Run it

```sh
# 1. dataset (a box, not a laptop)
python3 scripts/guard-bench/generator/build.py --seed 20261103 --out scripts/guard-bench/data
python3 scripts/guard-bench/generator/checks.py scripts/guard-bench/data
# 2. predictions from the engine (--engine rules)
go -C guard/agent-go build -o build/guardbench ./engine/eval/guardbench
VIBTRA_GUARD_DIR="$(mktemp -d)" guard/agent-go/build/guardbench --dataset scripts/guard-bench/data --split test --out predictions.jsonl
# 3. metrics and leaderboard
python3 scripts/guard-bench/score.py --dataset scripts/guard-bench/data --predictions predictions.jsonl --engine rules --split test --out scripts/guard-bench/results/rules.json --md scripts/guard-bench/results/rules.md
python3 scripts/guard-bench/leaderboard.py scripts/guard-bench/results > scripts/guard-bench/LEADERBOARD.md
```

## Known limits

- Templates are LLM-written, so phrasing diversity is bounded by about 2,450 skeletons; about 20 rows come from each. Rows from one template differ in values, wrappers and noise, not in structure. The family split exists for this reason.
- ABN/ACN: a company's ABN or ACN alone, with its registered office and directors, is public registry data, so templates of that shape were retired. ABN/ACN rows remain where the number sits in a business record (bank details, vendor onboarding, remittance). `au-acn` (384 rows) and `bank-customer-au` (90 rows) are thin.
- Amounts, ages, genders and places inside a template are filled from context hints (words near the slot), not from a world model. The audit's remaining failures (3.7% not realistic) are mostly implausible money or age against the surrounding story.
- Policy-prose categories (privilege, M&A, HR, trade secrets) have no spans. Span precision/recall covers 30 identifier and secret types.
- The Mac/laptop is not a supported place to run the generator or scorer.
