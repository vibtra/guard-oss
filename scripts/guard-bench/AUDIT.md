# GuardBench v1 audit (G7)

## Method

- Programmatic (`generator/checks.py`, every build): span offsets in range and non-overlapping, span type and jurisdiction match the taxonomy, validators agree with `value_valid` on 39,652 spans (8 types carry a check digit: TFN, Medicare, ABN, ACN, IHI, routing, card, NPI; SSN, ITIN, EIN and MBI are structural rules; the rest are format only), look-alike values fail their own checksum and every other strong checksum, family never in both splits, held-out industries test-only, no cross-split near-duplicate (MinHash, Jaccard 0.8), 80/20 ratio, schema. Result for the release: 0 failures.
- LLM judge: 1,000 rows drawn by `generator/audit.py sample` (stratified by split, label, jurisdiction and primary category, seeded), judged in 10 batches of 100 by independent sonnet subagents that see only the row (prompt, description, labels, span text), not the template. Three booleans per row: label correct, description fits, realistic. The brief the judges used is `JUDGE-BRIEF.md` in the ledger (`projects/guard-bench/audit/`). Judgments are not in git because they quote prompts with fake secrets; counts are below.
- A 200-row stratified `audit-sample.jsonl` for a human spot-check is in the ledger folder, not in git for the same reason.

## Rounds

Each round rebuilt the dataset after fixes and drew a new sample (rows that did not change keep their id, so the same bad rows reappeared across rounds 4-5).

| Round | All three ok | Label | Description | Realistic | What changed before it |
|---|---|---|---|---|---|
| 1 | 87.1% | 98.0% | 99.9% | 89.2% | first build |
| 2 | 90.3% | 98.9% | 99.6% | 91.7% | removed orphan "Also her mobile..." extras; log-uniform amounts; light-mask removed; typos off code; one filler; ordered dates |
| 3 | 92.1% | 98.9% | 99.7% | 93.5% | age-aware DOB (child, elder), context-scaled amounts, neutral company names, emails matched to names, phone kind, city hints |
| 4 | 92.9% | 99.8% | 99.9% | 93.1% | neutral wrappers and fillers, two-sided amount context, ABN/ACN-only templates retired (48) |
| 5 | 93.3% | 99.6% | 99.9% | 93.7% | gender-matched names, conservative amount ranges |
| 6 | 96.5% | 99.6% | 100.0% | 96.9% | 61 template families that had a failing row in rounds 4-5 retired |
| 7 | **95.6%** | 99.7% | 99.5% | 96.3% | opus review fixes: invalid SSN/ITIN/EIN look-alikes no longer valid IDs, ITIN group 65 and EIN prefixes 01-06 admitted, `num:N` realistic, clean rows use compact/dotted formats too, fictional phone ranges, categories list every span type, two templates fixed |

Round 7 is the release: 956 of 1,000 rows pass all three checks (label 997, description 995, realistic 963), and the dataset audited is byte-identical to the one in `data/MANIFEST.json`. Round 6 audited the build before the review fixes; round 7 repeats the audit on the build that ships.

## What the judges still reject (round 7, 44 rows)

- Implausible money against the story, dates or ages that disagree (the largest group, about 20 rows).
- Pty Ltd companies carrying US identifiers or called NYSE-listed (about 5).
- Descriptions that say "webhook" where the prompt holds a bot token (3).
- Label disputes (3): an unlabelled 8-digit roster number tagged as a driver licence (twice) and a merged name span.

## Honest caveats

- Round 7 follows retiring the families flagged in rounds 4-5. The sample is fresh, but the loop of judge, fix and retire is tuned to this judge. A different judge model or policy text will find different rows.
- The judge policy treats ABN/ACN inside a business record as sensitive (Tyler's brief lists them as AU identifiers to catch). A reader who treats company registry numbers as public would reject more rows.
- The judges see `row_label` and the categories, so label agreement is confirmation of a stated label, not independent labelling. A blind labelling pass is a follow-up.
- Label agreement says the labels follow the stated policy. It does not say the policy is right for every employer.
