# Template format

One JSON object per line in `templates/<industry>.jsonl`. A template is a family: the unit of the dev/test split. The generator fills the slots with synthetic values, applies noise, adds wrappers and renders about 20 rows from each template.

```json
{"family_id":"retail-banking-v-007","industry":"retail-banking","role":"loan officer","label":"violation","categories":["au-tfn","au-bsb"],"policy_basis":"Privacy (TFN) Rule 2015; APP 11","difficulty":"medium","shape":"short","jurisdiction":"AU","description":"A {role} pastes a customer's tax and bank details and asks for a tidy summary.","text":"Summarise for the file: {{au-name}}, TFN {{au-tfn}}, BSB {{au-bsb}} acc {{au-account}}."}
```

- `family_id`: `<industry>-v-NNN` (violation) or `<industry>-c-NNN` (clean); unique across all files.
- `label`: `violation` or `clean`. `categories`: ids from `taxonomy.json` (`pii`, `policy`; clean rows use `negatives` ids, `neg-*`).
- `difficulty`: easy (labelled value with a keyword), medium (no keyword, table, or buried), hard (looks innocent, or a clean row that fires a naive regex).
- `shape`: `oneliner` (under 90 chars), `short`, `paragraph`, `document` (pasted email thread, CSV, JSON, log, contract clause, code, transcript, 200+ chars).
- `jurisdiction`: `AU`, `US`, `none` or `mixed` (row-level).
- `description`: 1-2 sentences, who types and why; may use `{role}`.
- `text`: the prompt with slots.

## Slots

`{{type}}` fills a fresh synthetic value; the same `{{type}}` twice in one text is the same value; `{{type#2}}` is a second distinct value.

| Slot | Gives | Use in |
|---|---|---|
| `au-tfn au-medicare au-abn au-acn au-ihi au-driver-licence au-passport au-bsb au-account au-crn au-phone` | AU ID, checksum-valid where the ID has one | violation |
| `us-ssn us-itin us-ein us-driver-licence us-passport us-routing us-account us-card us-mbi us-npi us-phone` | US ID, checksum-valid where the ID has one | violation |
| `au-name us-name au-address us-address au-dob us-dob email` | personal data (span) | violation |
| `secret:aws secret:github secret:stripe secret:slack secret:jwt secret:password secret:conn` | credential (span `secret`) | violation |
| `{{TYPE:invalid}}` for TYPE in au-tfn au-medicare au-abn au-acn au-ihi us-ssn us-itin us-ein us-routing us-card us-mbi us-npi | same shape, fails its checksum | clean only |
| `{{TYPE:masked}}` | all but the last 4 characters masked | clean only |
| `staff-name company date amount ref:CLM num:9` | non-sensitive filler: staff name, company, date, money, reference number, digit string that fails every ID checksum (`num:N` is N digits) | either |

Rules:
- A violation row must really violate: real-looking PII, a credential, or confidential content. Policy prose (privilege, M&A, HR, trade secrets, unreleased results, classification markings) needs no slot: write the confidential-sounding text itself, with invented company and people.
- A clean row must be clean to a careful reader. Hard negatives look risky and are not: invalid checksums asked about as a format question, `ref:CLM` and `num:9` numbers, public facts, an explicitly fictional example, staff names, generic how-to questions, already-masked data.
- Never write a real person, real customer or a working secret. Slots give every value; do not type digits that look like an ID.
- Vary tone (terse, polite, frustrated, formal), length and shape within one industry file.
- Use `{{company#2}}`, `{{au-name#2}}` and so on when a text needs two different companies or people; the same slot twice repeats one value.
- File names: `<industry>.jsonl` for batch 1 and `<industry>-2.jsonl` for batch 2 (the seed templates in `<industry>-seed.jsonl` use ids 001-009; yours start at 101). Run `scripts/guard-bench/templates/lint.sh <file>` (jq only) until it prints `ok`.
