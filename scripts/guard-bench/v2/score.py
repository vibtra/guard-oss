#!/usr/bin/env python3
"""GuardBench v2 scorer: predictions -> headline, per-type table and a test-run ledger.

usage: score.py --dataset DIR --predictions FILE --engine NAME --policy NAME --split dev|test [--final] --out FILE

Scoring the test split needs --final and appends to TEST-RUNS.jsonl, with a hash of the detector source. Rule work
uses dev; a test score must not lead to a detector change without a new sealed test set.
"""
import argparse
import datetime
import glob
import gzip
import hashlib
import json
import math
import os
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
Z = 1.959963984540054
KIND_TYPES = {
    "au-tfn": ["au-tfn"],
    "au-medicare": ["au-medicare"],
    "au-abn": ["au-abn"],
    "au-acn": ["au-acn"],
    "card-number": ["us-card"],
    "us-ssn": ["us-ssn"],
    "us-itin": ["us-itin"],
    "us-ein": ["us-ein"],
    "us-routing": ["us-routing"],
    "us-npi": ["us-npi"],
    "us-mbi": ["us-mbi"],
    "au-bsb": ["au-bsb"],
    "au-ihi": ["au-ihi"],
    "au-crn": ["au-crn"],
    "bank-account": ["au-account", "us-account"],
    "passport": ["au-passport", "us-passport"],
    "driver-licence": ["au-driver-licence", "us-driver-licence"],
    "email-address": ["email"],
    "email-bulk": ["email"],
    "phone-number": ["au-phone", "us-phone"],
    "phone-bulk": ["au-phone", "us-phone"],
    "date-of-birth": ["au-dob", "us-dob"],
    "person-name": ["au-name", "us-name"],
    "location": ["au-address", "us-address"],
}


def wilson(hits, n):
    if not n:
        return {"hits": 0, "n": 0, "pct": None, "low": None, "high": None}
    p = hits / n
    d = 1 + Z * Z / n
    c = (p + Z * Z / (2 * n)) / d
    m = Z * math.sqrt(p * (1 - p) / n + Z * Z / (4 * n * n)) / d
    return {"hits": hits, "n": n, "pct": round(100 * p, 2), "low": round(100 * max(0, c - m), 2), "high": round(100 * min(1, c + m), 2)}


def show(w):
    return "n/a" if w["pct"] is None else "%.1f%% [%.1f-%.1f] (%d/%d)" % (w["pct"], w["low"], w["high"], w["hits"], w["n"])


def source_sha():
    h = hashlib.sha256()
    paths = sorted(glob.glob(os.path.join(ROOT, "guard/agent-go/engine/rules/internal/detect/*.go"))) + [os.path.join(ROOT, "guard/agent-go/engine/eval/policy.go")]
    for p in paths:
        with open(p, "rb") as f:
            h.update(f.read())
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", required=True)
    ap.add_argument("--predictions", required=True)
    ap.add_argument("--engine", required=True)
    ap.add_argument("--policy", required=True)
    ap.add_argument("--split", required=True, choices=["dev", "test"])
    ap.add_argument("--final", action="store_true")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    if a.split == "test" and not a.final:
        raise SystemExit("the test split needs --final, and that run goes in the ledger")
    rows = [json.loads(line) for line in gzip.open(os.path.join(a.dataset, f"{a.split}.jsonl.gz"), "rt", encoding="utf-8")]
    preds = {}
    for line in open(a.predictions, encoding="utf-8"):
        p = json.loads(line)
        preds[p["id"]] = p
    missing = [r["id"] for r in rows if r["id"] not in preds]
    errors = [r["id"] for r in rows if preds.get(r["id"], {}).get("error")]
    if missing or errors:
        raise SystemExit(f"{len(missing)} rows missing and {len(errors)} errors; the score would be incomplete")
    blocked = lambda r: bool(preds[r["id"]]["blocked"])
    track = lambda t: [r for r in rows if r["track"] == t]
    rate = lambda rs: wilson(sum(map(blocked, rs)), len(rs))
    res = {
        "benchmark": "GuardBench v2",
        "engine": a.engine,
        "policy": a.policy,
        "split": a.split,
        "known_shape_recall": rate(track("known-shape")),
        "false_block": rate(track("clean")),
        "contextual_recall": rate(track("contextual")),
        "fictional_blocked": rate(track("judgement")),
        "types": {},
        "kinds_on_clean": {},
    }
    types = sorted({s["type"] for r in rows for s in r["spans"]})
    for t in types:
        kinds = [k for k, ts in KIND_TYPES.items() if t in ts]
        rs = [r for r in rows if any(s["type"] == t for s in r["spans"])]
        hit = sum(any(k in preds[r["id"]]["kinds"] for k in kinds) for r in rs)
        res["types"][t] = wilson(hit, len(rs))
    for r in track("clean"):
        for k in preds[r["id"]]["kinds"]:
            res["kinds_on_clean"][k] = res["kinds_on_clean"].get(k, 0) + 1
    lat = sorted(preds[r["id"]].get("latency_us", 0) / 1000 for r in rows)
    res["latency_ms"] = {"p50": lat[len(lat) // 2], "p95": lat[int(len(lat) * 0.95)]}
    if a.split == "test":
        head = subprocess.run(["git", "-C", ROOT, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
        entry = {"at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "engine": a.engine, "policy": a.policy, "head": head, "detector_source_sha256": source_sha()}
        with open(os.path.join(HERE, "TEST-RUNS.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(res, f, indent=2)
        f.write("\n")
    print(f"GuardBench v2 {a.split}: {a.engine} / {a.policy}")
    print("  known-shape PII caught:", show(res["known_shape_recall"]))
    print("  clean rows blocked:    ", show(res["false_block"]))
    print("  names/addresses only:  ", show(res["contextual_recall"]))
    print("  fictional rows blocked:", show(res["fictional_blocked"]))
    print("  latency p50/p95 ms:    ", res["latency_ms"]["p50"], res["latency_ms"]["p95"])
    for t in types:
        print(f"  {t:20} {show(res['types'][t])}")
    print("  kinds on clean rows:", json.dumps(dict(sorted(res["kinds_on_clean"].items(), key=lambda x: -x[1]))))


if __name__ == "__main__":
    main()
