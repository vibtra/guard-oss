"""Templates -> data/{dev,test}.jsonl.gz + MANIFEST.json + STATS.json. Deterministic for a seed.

usage: build.py --seed 20261103 --out DIR [--templates DIR] [--rows 50000] [--ratio 0.8] [--test-share 0.3]
"""
import argparse
import collections
import glob
import gzip
import hashlib
import json
import os
import random
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import render  # noqa: E402

VERSION = "1.0.0"
ROOT = os.path.dirname(HERE)
OVERSAMPLE = 1.5
DEDUPE_JACCARD = 0.8
DEV_INDUSTRY_TEST_SHARE = 0.2


def h64(s):
    return int.from_bytes(hashlib.blake2b(s.encode("utf-8"), digest_size=8).digest(), "big")


def load_templates(tdir, tax):
    ts, bad = [], []
    for path in sorted(glob.glob(os.path.join(tdir, "*.jsonl"))):
        with open(path, encoding="utf-8") as f:
            for n, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    t = json.loads(line)
                    for key in ("family_id", "industry", "role", "label", "categories", "policy_basis", "difficulty", "shape", "jurisdiction", "description", "text"):
                        if key not in t:
                            raise ValueError(f"missing {key}")
                    if t["industry"] not in tax["industries"]:
                        raise ValueError(f"unknown industry {t['industry']}")
                    if t["label"] not in ("violation", "clean"):
                        raise ValueError("bad label")
                    if t["difficulty"] not in ("easy", "medium", "hard") or t["shape"] not in ("oneliner", "short", "paragraph", "document"):
                        raise ValueError("bad difficulty or shape")
                    known = set(tax["pii"]) | set(tax["policy"]) | set(tax["negatives"])
                    for c in t["categories"]:
                        if c not in known:
                            raise ValueError(f"unknown category {c}")
                    if (t["label"] == "clean") != all(c.startswith("neg-") for c in t["categories"]):
                        raise ValueError("clean templates take neg-* categories only, violations never")
                    render.check_template(t)
                    ts.append(t)
                except (ValueError, json.JSONDecodeError, KeyError) as e:
                    bad.append(f"{os.path.basename(path)}:{n}: {e}")
    seen = collections.Counter(t["family_id"] for t in ts)
    for fid, c in seen.items():
        if c > 1:
            bad.append(f"duplicate family_id {fid} x{c}")
    return ts, bad


def assign_splits(ts, held_out, seed):
    """Family-level split. Held-out industries are all test; other industries send 20% of families per (industry,label) to test."""
    split = {}
    groups = collections.defaultdict(list)
    for t in ts:
        groups[(t["industry"], t["label"])].append(t["family_id"])
    for (ind, _label), fams in groups.items():
        if ind in held_out:
            for f in fams:
                split[f] = "test"
            continue
        fams = sorted(fams, key=lambda f: h64(f"{seed}|split|{f}"))
        n_test = max(1, round(len(fams) * DEV_INDUSTRY_TEST_SHARE)) if len(fams) >= 3 else 0
        for i, f in enumerate(fams):
            split[f] = "test" if i < n_test else "dev"
    return split


NORM_DIGITS = re.compile(r"\d+")
TOKEN = re.compile(r"\w+")
NPERM = 24
BANDS = 8
ROWS = 3
MASK = (1 << 64) - 1
MULT = 0x9E3779B97F4A7C15
SEEDS = [h64(f"perm{i}") for i in range(NPERM)]


def shingles(text):
    toks = TOKEN.findall(NORM_DIGITS.sub("0", text.lower()))
    if len(toks) < 4:
        return frozenset({h64(" ".join(toks))})
    return frozenset(h64(" ".join(toks[i:i + 4])) for i in range(len(toks) - 3))


def signature(sh):
    return [min(((x ^ s) * MULT) & MASK for x in sh) for s in SEEDS]


class NearDup:
    def __init__(self):
        self.buckets = collections.defaultdict(list)
        self.sets = []
        self.fam = []

    def find_or_add(self, text, family):
        sh = shingles(text)
        sig = signature(sh)
        keys = [(b, tuple(sig[b * ROWS:(b + 1) * ROWS])) for b in range(BANDS)]
        cand = set()
        for k in keys:
            cand.update(self.buckets.get(k, ()))
        for c in cand:
            if self.fam[c] == family:
                continue
            o = self.sets[c]
            if len(sh & o) / len(sh | o) >= DEDUPE_JACCARD:
                return True
        idx = len(self.sets)
        self.sets.append(sh)
        self.fam.append(family)
        for k in keys:
            self.buckets[k].append(idx)
        return False


def write_gz(path, rows):
    with open(path, "wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, compresslevel=9, mtime=0) as gz:
            for r in rows:
                gz.write((json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8"))


def sha256_gz_content(p):
    h = hashlib.sha256()
    with gzip.open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=20261103)
    ap.add_argument("--out", required=True)
    ap.add_argument("--templates", default=os.path.join(ROOT, "templates"))
    ap.add_argument("--rows", type=int, default=50000)
    ap.add_argument("--ratio", type=float, default=0.8)
    ap.add_argument("--test-share", type=float, default=0.3)
    a = ap.parse_args()

    with open(os.path.join(ROOT, "taxonomy.json"), encoding="utf-8") as f:
        tax = json.load(f)
    ts, bad = load_templates(a.templates, tax)
    if bad:
        print(f"{len(bad)} template problems (first 30):", file=sys.stderr)
        for b in bad[:30]:
            print("  " + b, file=sys.stderr)
        sys.exit(2)
    split = assign_splits(ts, set(tax["held_out"]), a.seed)

    quota = {}
    for sp, share in (("test", a.test_share), ("dev", 1 - a.test_share)):
        total = round(a.rows * share)
        v = round(total * a.ratio)
        quota[(sp, "violation")] = v
        quota[(sp, "clean")] = total - v
    nfam = collections.Counter((split[t["family_id"]], t["label"]) for t in ts)
    for k, q in quota.items():
        if q and not nfam[k]:
            print(f"no templates for {k}", file=sys.stderr)
            sys.exit(2)

    cands = []
    for t in ts:
        key = (split[t["family_id"]], t["label"])
        n = -(-int(quota[key] * OVERSAMPLE) // nfam[key])
        for k in range(n):
            rng = random.Random(f"{a.seed}|{t['family_id']}|{k}")
            r = render.render_row(t, rng)
            r["split"] = split[t["family_id"]]
            r["_key"] = h64(f"{a.seed}|row|{t['family_id']}|{k}")
            cands.append(r)

    cands.sort(key=lambda r: (0 if r["split"] == "test" else 1, r["_key"]))
    nd, seen_prompt, kept, dropped = NearDup(), set(), [], collections.Counter()
    for r in cands:
        if r["prompt"] in seen_prompt:
            dropped["exact-duplicate"] += 1
            continue
        if nd.find_or_add(r["prompt"], r["template_family_id"]):
            dropped[f"near-duplicate-{r['split']}"] += 1
            continue
        seen_prompt.add(r["prompt"])
        kept.append(r)

    final = []
    pools = {key: sorted([r for r in kept if (r["split"], r["row_label"]) == key], key=lambda r: r["_key"]) for key in quota}
    for sp in ("dev", "test"):
        scale = min([1.0] + [len(pools[(sp, lab)]) / quota[(sp, lab)] for lab in ("violation", "clean") if quota[(sp, lab)]])
        for lab in ("violation", "clean"):
            q = int(quota[(sp, lab)] * scale)
            if q < quota[(sp, lab)]:
                print(f"SHORTFALL {sp}/{lab}: {q} of {quota[(sp, lab)]} (scaled to keep the ratio)", file=sys.stderr)
            final.extend(pools[(sp, lab)][:q])
    final.sort(key=lambda r: r["_key"])
    for i, r in enumerate(final, 1):
        r["id"] = f"gb1-{i:06d}"
        r["generator_version"] = VERSION
        r["seed"] = a.seed
        del r["_key"]
    order = ("id", "split", "industry", "role", "description", "prompt", "row_label", "categories", "spans", "lookalikes", "policy_basis", "difficulty", "template_family_id", "shape", "jurisdiction", "generator_version", "seed")
    final = [{k: r[k] for k in order} for r in final]

    os.makedirs(a.out, exist_ok=True)
    for sp in ("dev", "test"):
        write_gz(os.path.join(a.out, f"{sp}.jsonl.gz"), [r for r in final if r["split"] == sp])

    stats = {"rows": len(final), "dropped": dict(dropped), "templates": len(ts), "families": dict((f"{k[0]}/{k[1]}", v) for k, v in nfam.items())}
    for field in ("split", "row_label", "jurisdiction", "industry", "difficulty", "shape"):
        stats[f"by_{field}"] = dict(collections.Counter(r[field] for r in final))
    stats["by_split_label"] = dict(collections.Counter(f"{r['split']}/{r['row_label']}" for r in final))
    stats["by_category"] = dict(collections.Counter(c for r in final for c in r["categories"]))
    stats["by_span_type"] = dict(collections.Counter(s["type"] for r in final for s in r["spans"]))
    with open(os.path.join(a.out, "STATS.json"), "w", encoding="utf-8") as f:
        json.dump(stats, f, indent=1, sort_keys=True)

    files = {}
    for p in sorted(glob.glob(os.path.join(a.out, "*.jsonl.gz"))) + sorted(glob.glob(os.path.join(a.templates, "*.jsonl"))) + [os.path.join(ROOT, "taxonomy.json")] + sorted(glob.glob(os.path.join(HERE, "*.py"))):
        inside = os.path.commonpath([os.path.abspath(p), ROOT]) == ROOT
        key = os.path.relpath(p, ROOT) if inside else "data/" + os.path.basename(p)
        files[key] = sha256_file(p)
        if p.endswith(".jsonl.gz"):
            files[key[:-3]] = sha256_gz_content(p)
    manifest = {"name": "GuardBench", "version": "v1", "generator_version": VERSION, "seed": a.seed, "rows": len(final), "python": "%d.%d.%d" % sys.version_info[:3], "files": files}
    with open(os.path.join(a.out, "MANIFEST.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=1, sort_keys=True)
    print(json.dumps({"rows": len(final), "by_split_label": stats["by_split_label"], "dropped": dict(dropped)}))


if __name__ == "__main__":
    main()
