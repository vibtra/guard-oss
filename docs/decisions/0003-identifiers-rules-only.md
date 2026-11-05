# 0003 — Personal identifiers launch with rules alone, without a model

- **Status:** Accepted, 5 November 2026.
- **Decided by:** Sam Rahmani
- **Tickets:** [VIB-48](https://linear.app/vibtra/issue/VIB-48), launch parent [VIB-18](https://linear.app/vibtra/issue/VIB-18)

## Decision

Guard's first public release detects personal identifiers with rules only: about 275 identifier types, using each number's shape, its check digits and a nearby label. No model runs on the device.

We launch below the 95% and 2% target we set, and we say so. The rules can't reliably catch a plain number with no label and no check digit.

## Why

We scored the frozen rules, Privacy Filter and Von on the same 11,490-row synthetic set, written by an agent that could not read the detector.

| Detector | Labelled | Unlabelled | False positives |
|---|---|---|---|
| Rules | 93.90% | 36.25% | 3.15% |
| Privacy Filter, `account_number` at any score | 79.58% | 67.49% | 64.08% |
| Von, ID-only question, score at least 0.5 | 69.54% | 85.34% | 17.03% |
| Rules OR Von, score at least 0.999 | 95.26% | 66.48% | 7.72% |

Both models find more unlabelled numbers, but they can't separate an ID from an ordinary work number at a usable false-positive rate. At 2% false positives, either model alone catches about 15% of labelled rows. Von would also add a 1.58GB download and about 100ms per message.

Full figures and limits are in `scripts/guard-bench/v3/README.md`.

## Consequences

- Rules false positives concentrate in documents that name an ID type beside an ordinary number, at 20.86%. On ordinary numbers they are 0.36%.
- The guide states these limits and tells admins to try the rule in Monitor first.
- All figures come from synthetic data. Real traffic may differ.

## What would reopen this

A model or rule change that reaches at least 95% on labelled rows at no more than 2% false positives, measured on a new blind set.
