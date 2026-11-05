# GuardBench v3 pre-registration (written before any detector was scored on it)
Sources: nvidia/Nemotron-PII (CC-BY-4.0), gretelai/gretel-pii-masking-en-v1 and gretelai/synthetic_pii_finance_multilingual (Apache-2.0), databricks-dolly-15k (CC-BY-SA-3.0), OpenAssistant/oasst1 prompter English messages (Apache-2.0), a blind international set generated without seeing the detectors, and fresh GuardBench v1-generator rows with a new seed.
Split: sha256(salt:id) dev 40 / sealed-a,b,c 20 each. Row text of sealed folds is never read. A fold is scored once, and any detector change after it moves to the next fold.
Targets: identifier rows blocked >= 95%; clean rows blocked <= 2%, per sealed fold.
Identifier types: ssn, card (Luhn valid), iban (mod97 valid), routing (ABA valid), bank-account, passport, licence, national-id, tax-id, mrn, health-plan, dob. Values that fail their public check digit go to invalid-value and are not counted.
Not in the headline: email, phone, names, addresses, company ids, customer and employee ids, IP addresses, plates, biometrics, device ids. Secrets are a separate track.
Clean: Dolly, OASST prompts, finance rows with no spans, blind hard negatives, fresh lookalikes. Corpus rows that a human review confirms contain real PII are reported, not silently dropped.

## Amendment, 4 Nov 2026, written after dev tuning and before any sealed score. Detector hash e185d5b2205735aa.

Why: blind hard negatives (v3/blindneg, written by an agent that could not see the detector) showed that firing on an unlabelled number beside a name gives 63.6% false positives on dev. The set's README and that test agree that unlabelled plain numbers are often undecidable without a label. 

Gates, each one scored once on the frozen detector:
1. core sealed-a: identifier >= 95%, clean <= 2%.
2. intl sealed: labelled families >= 95%; clean <= 2%. Unlabelled families and the all-rows figure are reported beside it. The original target of >= 95% on all intl rows is NOT expected to be met, and that is reported as a miss against the original target, not redefined away.
3. blindneg sealed: clean <= 2%. This is the false-positive gate.
4. worknum sealed: clean <= 2%. Weaker evidence: its author also wrote the detector's work-word list.
5. fresh-seed GuardBench lookalikes: clean <= 2%. Same templates as v2, so not template independent.
Any change after a score moves to the next fold (sealed-b, then sealed-c). The intl, blindneg and worknum sealed sets have one fold each; a re-score after a change is reported as contaminated.

## Amendment 2, written before scoring round 2. Detector hash c30e6089beecdb3f.

Round 1 result on the previous freeze: core sealed-a pass; blindneg sealed 8.47% fail; fresh 3.89% fail; intl sealed labelled 96.49% pass. intl sealed and blindneg sealed are now spent and re-scoring them is contaminated.
Round 2 gates: core sealed-b identifier >= 95%, clean <= 2%. blind2 final (unseen families, split by family hash; dev half was used for tuning): labelled >= 95%, clean <= 2%, unlabelled reported. fresh seed 77123 clean <= 2%. Same-template lookalikes; rows that carry an explicit label and a correctly shaped value are reported.

## Amendment 3, written before scoring round 3. Detector hash 943e825fa5543770.

Round 2 on the previous freeze: core sealed-b pass; blind2 final labelled 93.52% fail, clean 4.29% fail; fresh seed 77123 clean 2.50% fail.
Round 3 gates: core sealed-c identifier >= 95%, clean <= 2%. blind3 final: labelled >= 95%, clean <= 2% counting every row including homographs; natural and homograph figures reported separately; unlabelled reported. fresh seed 55309 clean <= 2%. Core sealed-c is the last core fold.

## Amendment 4, written before scoring the final detector. Detector hash f0567e2f0071974f.

Round 3 on the previous freeze: core sealed-c pass; blind3 final labelled 94.62%, clean 8.38% (natural 0.80%, homograph 71.47%); fresh 55309 3.33%.
Final gates, one pass, no change after: blind4 whole set labelled >= 95%, clean <= 2% counting homographs. fresh seed 31877 clean <= 2%. Core folds are all used, so core sealed-a, b and c and intl sealed are re-scored on this detector and marked as re-scores, not fresh tests. Whatever the result, this is what is reported.

## Amendment 5, written before scoring. Detector hash eb6f136d01ebe572.

Final-1 on the previous freeze missed: blind4 labelled 93.17%, clean 6.30%; fresh 31877 4.31%. Amendment 4 said that result is what gets reported; it stays reported. The founder's instruction was to keep iterating to the target, so tuning continued, using blind4 as a spent set. blind4 is contaminated from here on: its 95.56% and 1.13% are not evidence. New pack entries (co-nit, th-tin, mx-nss, ad-nrt, es-nif-entity, nl-onderwijsnummer, nl-id-card) were added because of types blind4 exposed.
Gates, one pass: blind5 whole set, written by an agent that read no detector code, labelled >= 95%, clean <= 2% counting homographs. Unlabelled reported. fresh seed 62491 clean <= 2%, same templates as v2. Core folds and intl sealed re-scored and marked as re-scores. A miss on blind5 is reported as a miss. Any later change makes blind5 spent too.

## Amendment 6, written before scoring. Detector hash 5922f9902b627ea2.

Final-2 on the previous freeze: blind5 labelled 94.03% (miss), clean 0.82% (pass), unlabelled 35.06%; fresh seed 62491 clean 4.17% (miss); re-scores core a/b/c 96.07/0.09, 95.80/0.08, 95.69/0.21; intl sealed labelled 95.61%. blind5 misses were then inspected, so blind5 is spent. Tuning used blind4, blind5 and the insurance corpus.
Gates, one pass: blind6 whole set. Labelled >= 95%, clean <= 2% counting homographs. Reported beside that: labelsource table and labelsource own separately, unlabelled, homograph and ordinary clean. The own figure is the harder test because that wording did not come from the type table; the headline gate is all labelled rows. fresh seed 40961 clean <= 2%, same templates as v2. Core and intl sealed re-scored and marked as re-scores. A miss is reported as a miss. Any later change makes blind6 spent.

## Amendment 7, written before scoring. Detector hash 9c17df705223994d.

Final-3 on the previous freeze: blind6 labelled 75.46% MISS (table 88.25%, own 62.66%), unlabelled 38.62%, clean 1.05%; fresh seed 40961 clean 8.61% MISS. Finding: earlier blind sets drew labels from the same type table as the pack, so their ~95% overstated recall. blind6 is spent. Since then a vocabulary of 28,463 labels was merged, written by an agent that saw no test data; blind7 was written at the same time by a separate agent that saw neither that vocabulary nor the detector. Both are the same model, so their wording is not fully independent.
Gates, one pass: blind7 whole set, labelled >= 95%, clean <= 2% counting homographs. Reported beside it: near and far, own and table, near+own, unlabelled, ordinary and homograph clean. No label split is promoted to the headline after seeing results. fresh seed 73019 clean <= 2%. A miss is reported as a miss. Any later change makes blind7 spent.

## Amendment 8, written before scoring. Detector hash 5d8bc2abc9129d9a.

Final-4 on the previous freeze: blind7 labelled 89.57% MISS (near 94.63%, far 74.41%, own 88.34%, table 90.80%), unlabelled 38.34%, clean 0.73%; fresh seed 73019 clean 9.44% MISS. blind7 is spent. Since then: unchecked labelled TFN and Medicare reverted because real values pass their checksums, windows of 300 characters on entries without a strong check, stem and suffix label grammar, new dz-nin, mu-nid, sv-nit entries.
Gates, one pass: blind8 whole set, labelled >= 95%, clean <= 2% counting homographs and label mentions. Reported beside it: near, far, mixed, own, table, near+own, unlabelled, ordinary, homograph, labelmention. Nothing else becomes the headline after seeing results. fresh seed 88213 clean <= 2%. Core and intl sealed re-scored and marked as re-scores. Insurance corpus and latency reported. A miss is reported as a miss. Any later change makes blind8 spent.

## Amendment 9, written before scoring. Detector hash 7f20397eb3100916.

Final-5 on the previous freeze: blind8 labelled 93.10% MISS (near 96.24%, far 83.70%), unlabelled 36.07%, clean 1.95% (ordinary 0.84%, homograph 1.88%, labelmention 9.14%); fresh seed 88213 clean 3.47% MISS. blind8 is spent. Since then: JSON table columns, header-column check, work-word check on wide windows, value-alone-on-line rule.
Gates, one pass, last round before reporting: blind9 whole set, labelled >= 95%, clean <= 2% counting homographs and label mentions. Reported beside it: near, far, mixed, own, table, near+own, unlabelled, ordinary, homograph, labelmention. Nothing else becomes the headline after seeing results. fresh seed 19457 clean <= 2%. Core and intl sealed re-scored and marked as re-scores. A miss is reported as a miss.
