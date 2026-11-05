"""Stratified audit sampling and judgment merge (G7).

  audit.py sample DATA_DIR OUT_DIR [--n 1000] [--batch 100] [--public 200] [--seed 20261103]
     OUT_DIR/batch-NN.jsonl   rows for the LLM judge (span text included, template ids hidden)
     OUT_DIR/audit-sample.jsonl   the first --public rows of a second, smaller stratified draw, for a human spot-check
  audit.py merge JUDGMENTS_DIR     judgments-NN.jsonl lines {id, label_ok, description_ok, realistic_ok, reason}
"""
import collections
import glob
import gzip
import hashlib
import json
import os
import sys


def h(s):
    return int.from_bytes(hashlib.blake2b(s.encode(), digest_size=8).digest(), "big")


def load(data_dir):
    rows = []
    for sp in ("dev", "test"):
        with gzip.open(os.path.join(data_dir, f"{sp}.jsonl.gz"), "rt", encoding="utf-8") as f:
            rows.extend(json.loads(line) for line in f)
    return rows


def stratum(r):
    primary = r["categories"][0]
    return (r["split"], r["row_label"], r["jurisdiction"], primary)


def draw(rows, n, seed, salt):
    groups = collections.defaultdict(list)
    for r in rows:
        groups[stratum(r)].append(r)
    for g in groups.values():
        g.sort(key=lambda r: h(f"{seed}|{salt}|{r['id']}"))
    out, keys = [], sorted(groups)
    i = 0
    while len(out) < n and any(groups.values()):
        k = keys[i % len(keys)]
        if groups[k]:
            out.append(groups[k].pop(0))
        i += 1
    return out


def view(r):
    p = r["prompt"]
    return {
        "id": r["id"], "industry": r["industry"], "role": r["role"], "description": r["description"], "prompt": p,
        "row_label": r["row_label"], "categories": r["categories"], "policy_basis": r["policy_basis"],
        "spans": [{**s, "text": p[s["start"]:s["end"]]} for s in r["spans"]],
        "lookalikes": [{**s, "text": p[s["start"]:s["end"]]} for s in r["lookalikes"]],
    }


def sample(argv):
    data_dir, out_dir = argv[0], argv[1]
    opt = dict(zip(argv[2::2], argv[3::2]))
    n, batch, public = int(opt.get("--n", 1000)), int(opt.get("--batch", 100)), int(opt.get("--public", 200))
    seed = int(opt.get("--seed", 20261103))
    rows = load(data_dir)
    os.makedirs(out_dir, exist_ok=True)
    picked = draw(rows, n, seed, "judge")
    for b in range(0, len(picked), batch):
        with open(os.path.join(out_dir, f"batch-{b // batch + 1:02d}.jsonl"), "w", encoding="utf-8") as f:
            for r in picked[b:b + batch]:
                f.write(json.dumps(view(r), ensure_ascii=False) + "\n")
    with open(os.path.join(out_dir, "audit-sample.jsonl"), "w", encoding="utf-8") as f:
        for r in draw(rows, public, seed, "public"):
            f.write(json.dumps(view(r), ensure_ascii=False) + "\n")
    print(json.dumps({"judge_rows": len(picked), "batches": -(-len(picked) // batch), "public": public}))


def merge(argv):
    rows = []
    for p in sorted(glob.glob(os.path.join(argv[0], "judgments-*.jsonl"))):
        with open(p, encoding="utf-8") as f:
            rows.extend(json.loads(line) for line in f if line.strip())
    n = len(rows)
    keys = ("label_ok", "description_ok", "realistic_ok")
    allok = sum(1 for r in rows if all(r.get(k) for k in keys))
    out = {"judged": n, "all_ok": allok, "agreement_pct": round(100 * allok / n, 2) if n else None}
    for k in keys:
        out[k + "_pct"] = round(100 * sum(1 for r in rows if r.get(k)) / n, 2) if n else None
    out["failures"] = [{"id": r["id"], "reason": r.get("reason", "")} for r in rows if not all(r.get(k) for k in keys)]
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    {"sample": sample, "merge": merge}[sys.argv[1]](sys.argv[2:])
