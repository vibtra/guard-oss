"""Programmatic quality checks on a built dataset (G7). usage: checks.py DATA_DIR [--no-deep]
Exit 0 only if every hard check passes. Writes DATA_DIR/CHECKS.json."""
import collections
import gzip
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import build  # noqa: E402
import values  # noqa: E402

ROOT = os.path.dirname(HERE)
ENUM = {"split": {"dev", "test"}, "row_label": {"violation", "clean"}, "difficulty": {"easy", "medium", "hard"}, "shape": {"oneliner", "short", "paragraph", "document"}, "jurisdiction": {"AU", "US", "none", "mixed"}}
FIELDS = ("id", "split", "industry", "role", "description", "prompt", "row_label", "categories", "spans", "lookalikes", "policy_basis", "difficulty", "template_family_id", "shape", "jurisdiction", "generator_version", "seed")
VECTORS = (
    ("au-tfn", "123 456 782", True), ("au-tfn", "123 456 783", False),
    ("au-abn", "51 824 753 556", True), ("au-abn", "51 824 753 557", False),
    ("au-acn", "004 085 616", True), ("au-acn", "004 085 617", False),
    ("us-card", "4111 1111 1111 1111", True), ("us-card", "4111 1111 1111 1112", False),
    ("us-routing", "021000021", True), ("us-routing", "021000022", False),
    ("us-ssn", "078-05-1120", True), ("us-ssn", "000-12-3456", False), ("us-ssn", "666-12-3456", False), ("us-ssn", "923-12-3456", False),
    ("us-npi", "1234567893", True), ("us-npi", "1234567890", False),
    ("au-medicare", "2123 45670 1", True), ("au-medicare", "2123 45671 1", False),
    ("us-mbi", "1EG4-TE5-MK73", True), ("us-mbi", "0EG4-TE5-MK73", False),
    ("us-ein", "12-3456789", True), ("us-ein", "07-1234567", False),
    ("us-itin", "912-70-1234", True), ("us-itin", "912-30-1234", False),
)


DIGIT_RUN = re.compile(r"\b\d{9,19}\b|\b\d{3,5}(?:[ -]\d{2,5}){1,4}\b")


def alnum(s):
    return re.sub(r"[^A-Za-z0-9]", "", s)


def load(data_dir):
    rows = []
    for sp in ("dev", "test"):
        with gzip.open(os.path.join(data_dir, f"{sp}.jsonl.gz"), "rt", encoding="utf-8") as f:
            rows.extend(json.loads(line) for line in f)
    return rows


def main():
    data_dir = sys.argv[1]
    deep = "--no-deep" not in sys.argv
    opts = dict(a.split("=", 1) for a in sys.argv[2:] if a.startswith("--") and "=" in a)
    want_ratio = float(opts.get("--ratio", 0.8))
    want_test = float(opts.get("--test-share", 0.3))
    with open(os.path.join(ROOT, "taxonomy.json"), encoding="utf-8") as f:
        tax = json.load(f)
    held = set(tax["held_out"])
    pii = set(tax["pii"])
    fails, warns = collections.defaultdict(list), []

    def fail(name, msg):
        if len(fails[name]) < 20:
            fails[name].append(msg)
        else:
            fails[name].append(None)

    for typ, text, want in VECTORS:
        if values.VALIDATORS[typ](text) != want:
            fail("validator-vectors", f"{typ} {text} expected {want}")

    rows = load(data_dir)
    ids = set()
    fam_split = collections.defaultdict(set)
    fam_ind = collections.defaultdict(set)
    prompts = set()
    skipped_mask = 0
    checked_sum = 0
    for r in rows:
        rid = r.get("id")
        if tuple(r.keys()) != FIELDS:
            fail("schema", f"{rid}: fields {list(r.keys())}")
            continue
        if rid in ids:
            fail("schema", f"duplicate id {rid}")
        ids.add(rid)
        for k, allowed in ENUM.items():
            if r[k] not in allowed:
                fail("schema", f"{rid}: {k}={r[k]}")
        if r["prompt"] in prompts:
            fail("duplicate-prompt", rid)
        prompts.add(r["prompt"])
        fam_split[r["template_family_id"]].add(r["split"])
        fam_ind[r["template_family_id"]].add(r["industry"])
        if r["industry"] in held and r["split"] != "test":
            fail("held-out", f"{rid}: {r['industry']} in {r['split']}")
        p = r["prompt"]
        if not r["description"].strip() or len(r["description"]) > 400:
            fail("description", rid)
        if r["row_label"] == "clean":
            if r["spans"]:
                fail("clean-has-spans", rid)
            if not r["categories"] or not all(c.startswith("neg-") for c in r["categories"]):
                fail("categories", f"{rid}: {r['categories']}")
        else:
            if not r["categories"] or any(c.startswith("neg-") for c in r["categories"]):
                fail("categories", f"{rid}: {r['categories']}")
            if r["lookalikes"]:
                fail("violation-has-lookalikes", rid)
            for c in r["categories"]:
                if c in pii and c != "secret" and not any(s["type"] == c for s in r["spans"]):
                    fail("pii-category-without-span", f"{rid}: {c}")
        last_end = 0
        for s in sorted(r["spans"], key=lambda s: s["start"]):
            if not (0 <= s["start"] < s["end"] <= len(p)) or s["start"] < last_end:
                fail("span-offsets", f"{rid}: {s}")
                continue
            last_end = s["end"]
            if s["type"] not in pii:
                fail("span-type", f"{rid}: {s['type']}")
            if s["jurisdiction"] != tax["pii"].get(s["type"], {}).get("jurisdiction"):
                fail("span-jurisdiction", f"{rid}: {s}")
            f = values.VALIDATORS.get(s["type"])
            text = p[s["start"]:s["end"]]
            if f and s["value_valid"]:
                if "x" in text or "*" in text:
                    skipped_mask += 1
                elif not f(alnum(text)):
                    fail("checksum-vs-value_valid", f"{rid}: {s['type']} {text!r} marked valid")
                else:
                    checked_sum += 1
            elif f and not s["value_valid"] and f(alnum(text)):
                fail("checksum-vs-value_valid", f"{rid}: {s['type']} marked invalid but validates")
        for s in r["spans"]:
            if s["type"] not in r["categories"]:
                fail("span-type-not-in-categories", f"{rid}: {s['type']}")
        if r["row_label"] == "clean":
            for run in DIGIT_RUN.findall(p):
                digits_only = "".join(c for c in run if c.isdigit())
                if 9 <= len(digits_only) <= 19 and values.looks_like_other_id("", digits_only) and not any(la["start"] <= p.find(run) < la["end"] for la in r["lookalikes"]):
                    fail("clean-digit-run-validates", f"{rid}: {run!r}")
        for la in r["lookalikes"]:
            if not (0 <= la["start"] < la["end"] <= len(p)):
                fail("lookalike-offsets", f"{rid}: {la}")
                continue
            text = p[la["start"]:la["end"]]
            f = values.VALIDATORS.get(la["type"])
            if f and "*" not in text and f(alnum(text)):
                fail("lookalike-validates", f"{rid}: {la['type']} {text!r}")
            elif "*" not in text and values.looks_like_other_id(la["type"], text):
                fail("lookalike-validates-other", f"{rid}: {la['type']} {text!r}")
    for fam, sp in fam_split.items():
        if len(sp) > 1:
            fail("family-leak", f"{fam} in {sorted(sp)}")
        if len(fam_ind[fam]) > 1:
            fail("family-industry", fam)

    n = len(rows)
    viol = sum(1 for r in rows if r["row_label"] == "violation")
    if n and abs(viol / n - want_ratio) > 0.005:
        fail("ratio", f"violation share {viol / n:.4f}")
    for sp in ("dev", "test"):
        m = [r for r in rows if r["split"] == sp]
        if m and abs(sum(1 for r in m if r["row_label"] == "violation") / len(m) - want_ratio) > 0.005:
            fail("ratio", f"{sp} violation share")
    if n:
        test_share = sum(1 for r in rows if r["split"] == "test") / n
        if abs(test_share - want_test) > 0.03:
            fail("test-share", f"test share {test_share:.3f}")

    cat = collections.Counter(c for r in rows for c in r["categories"])
    for c in list(tax["pii"]) + list(tax["policy"]) + list(tax["negatives"]):
        if cat[c] < 100:
            warns.append(f"category {c}: {cat[c]} rows")
    ind = collections.Counter(r["industry"] for r in rows)
    for i in tax["industries"]:
        if ind[i] < 800:
            warns.append(f"industry {i}: {ind[i]} rows")

    if deep:
        nd = build.NearDup()
        for r in sorted(rows, key=lambda r: (r["split"] != "test", r["id"])):
            if nd.find_or_add(r["prompt"], r["template_family_id"]):
                fail("near-duplicate", r["id"])

    report = {"rows": n, "checked_checksums": checked_sum, "skipped_masked": skipped_mask, "failures": {k: {"count": len(v), "examples": [x for x in v if x]} for k, v in fails.items()}, "warnings": warns}
    with open(os.path.join(data_dir, "CHECKS.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, indent=1)
    print(json.dumps({"rows": n, "failed_checks": sorted(fails), "warnings": len(warns), "checked_checksums": checked_sum}))
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
