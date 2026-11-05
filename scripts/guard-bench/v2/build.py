#!/usr/bin/env python3
"""GuardBench v2: the PII rows of a v1 build. Same families, ids, values and splits; nothing new is generated.

usage: build.py --v1 DIR --out DIR

Violation rows keep the "known-shape" track when any span has a known shape, otherwise "contextual" (only names or
addresses). Rows from subjective categories, rows with no span and rows with secrets are dropped. Clean rows lose
staff names, which depend on the company's policy, and invalid-checksum rows for types with no checksum to fail.
Clearly fictional rows move to a "judgement" track that the headline leaves out.
"""
import argparse
import collections
import gzip
import hashlib
import json
import os

SUBJECTIVE = {"trade-secret", "legal-privilege", "source-code", "ma-confidential", "infra-internal", "gov-classified", "mnpi-sox"}
CONTEXTUAL = {"au-name", "us-name", "au-address", "us-address"}
NO_CHECKSUM = {"us-ein", "au-passport", "us-passport", "au-driver-licence", "us-driver-licence", "au-account", "us-account", "au-bsb"}


def keep(r):
    """The row's track, or None when v2 drops it."""
    cats = set(r["categories"])
    if r["row_label"] == "violation":
        types = {s["type"] for s in r["spans"]}
        if cats & SUBJECTIVE or not types or "secret" in types:
            return None
        return "known-shape" if types - CONTEXTUAL else "contextual"
    if "neg-staff-allowed" in cats:
        return None
    if "neg-invalid-checksum" in cats and {x["type"] for x in r.get("lookalikes") or []} & NO_CHECKSUM:
        return None
    return "judgement" if "neg-fictional-marked" in cats else "clean"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--v1", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    manifest = {"name": "GuardBench", "version": "v2", "source": "v1 build, filtered", "splits": {}}
    for split in ("dev", "test"):
        counts = collections.Counter()
        path = os.path.join(a.v1, f"{split}.jsonl.gz")
        v1_sha = hashlib.sha256(gzip.open(path, "rb").read()).hexdigest()
        lines = []
        for line in gzip.open(path, "rt", encoding="utf-8"):
            r = json.loads(line)
            track = keep(r)
            counts[track or "dropped"] += 1
            if track:
                r["track"] = track
                lines.append(json.dumps(r, ensure_ascii=False) + "\n")
        body = "".join(lines).encode("utf-8")
        with gzip.GzipFile(os.path.join(a.out, f"{split}.jsonl.gz"), "wb", mtime=0) as f:
            f.write(body)
        manifest["splits"][split] = {"v1_sha256": v1_sha, "sha256": hashlib.sha256(body).hexdigest(), "rows": len(lines), "tracks": dict(sorted(counts.items()))}
    with open(os.path.join(a.out, "MANIFEST.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")
    print(json.dumps(manifest["splits"]))


if __name__ == "__main__":
    main()
