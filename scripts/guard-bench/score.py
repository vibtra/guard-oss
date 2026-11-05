#!/usr/bin/env python3
"""GuardBench scorer: dataset split + predictions.jsonl -> metrics JSON (+ markdown).

Usage:
  score.py --dataset DIR --predictions FILE --engine NAME [--split test]
           [--kind-map kind-map.json] [--allow-incomplete] --out results/NAME.json [--md results/NAME.md]

Row-level metrics (recall, false-block, every breakdown) use the `blocked` field only. The scorer
never reads `kinds` for them. `kinds` feeds one table: how often each engine kind fired on
violation rows and on clean rows (counts only, no text), mapped through kind-map.json to GuardBench
types where a mapping exists. kind-map.json also maps the types of predicted spans, for engines
that emit spans.

Span matching is one-to-one. Predicted and gold spans are sorted, exact [start,end) pairs are made
first, then overlapping pairs of the same type; a gold span pairs with at most one predicted span
and the reverse, so one large predicted span cannot score recall for several gold spans.

Rows with no prediction are left out of the metrics and counted as `missing`. A result with missing
predictions, prediction errors, or a partial run (`--limit` in the runner, read from
PREDICTIONS.meta.json) is incomplete: the scorer exits non-zero unless --allow-incomplete is
passed, and then records incomplete, missing, errors and rows_scored in the results JSON.

dataset.sha256 is the SHA256 of the decompressed JSONL bytes of the split, so it does not depend
on the zlib build. Stdlib only. The results JSON never contains prompt text.
"""
import argparse
import gzip
import hashlib
import json
import math
import os
import sys

DEFAULT_HELD_OUT = ["mining-resources", "aged-care", "maritime-shipping"]
HERE = os.path.dirname(os.path.abspath(__file__))
Z = 1.959963984540054


def wilson(hits, n):
    if n == 0:
        return {"hits": 0, "n": 0, "pct": None, "ci_low": None, "ci_high": None}
    p = hits / n
    d = 1 + Z * Z / n
    c = (p + Z * Z / (2 * n)) / d
    m = Z * math.sqrt(p * (1 - p) / n + Z * Z / (4 * n * n)) / d
    return {
        "hits": hits,
        "n": n,
        "pct": round(100 * p, 2),
        "ci_low": round(100 * max(0.0, c - m), 2),
        "ci_high": round(100 * min(1.0, c + m), 2),
    }


def parse_jsonl(text, label):
    out = []
    for ln, line in enumerate(text.splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError as e:
            raise SystemExit("%s line %d: %s" % (label, ln, e))
    return out


def read_bytes(path):
    if path.endswith(".gz"):
        with gzip.open(path, "rb") as f:
            return f.read()
    with open(path, "rb") as f:
        return f.read()


def read_jsonl(path):
    return parse_jsonl(read_bytes(path).decode("utf-8"), path)


def read_split(path):
    data = read_bytes(path)
    return parse_jsonl(data.decode("utf-8"), path), hashlib.sha256(data).hexdigest()


def read_predictions(path):
    preds = {}
    for p in read_jsonl(path):
        if not isinstance(p, dict) or "id" not in p:
            raise SystemExit("%s: every line needs an id" % path)
        preds[p["id"]] = p
    return preds


def read_pred_meta(predictions_path):
    try:
        with open(predictions_path + ".meta.json", "r", encoding="utf-8") as f:
            m = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(m, dict):
        return None
    return {k: m.get(k) for k in ("dataset", "split", "limit", "rowsInSplit", "rowsScored")}


def find_split_file(dataset, split):
    for name in (split + ".jsonl.gz", split + ".jsonl"):
        p = os.path.join(dataset, name)
        if os.path.exists(p):
            return p
    raise SystemExit("no %s.jsonl.gz or %s.jsonl in %s" % (split, split, dataset))


def load_held_out(dataset):
    cands = [
        os.path.join(HERE, "taxonomy.json"),
        os.path.join(dataset, "taxonomy.json"),
        os.path.join(dataset, "..", "taxonomy.json"),
    ]
    for p in cands:
        if not os.path.exists(p):
            continue
        try:
            with open(p, "r", encoding="utf-8") as f:
                tax = json.load(f)
        except (OSError, ValueError):
            continue
        found = held_out_from(tax)
        if found:
            return found
    return list(DEFAULT_HELD_OUT)


def held_out_from(tax):
    if not isinstance(tax, dict):
        return None
    for key in ("held_out_industries", "heldOutIndustries", "held_out"):
        v = tax.get(key)
        if isinstance(v, list) and v and all(isinstance(x, str) for x in v):
            return v
    inds = tax.get("industries")
    out = []
    if isinstance(inds, list):
        for it in inds:
            if isinstance(it, dict) and (it.get("held_out") or it.get("heldOut")):
                name = it.get("id") or it.get("slug") or it.get("name")
                if name:
                    out.append(name)
    elif isinstance(inds, dict):
        for name, it in inds.items():
            if isinstance(it, dict) and (it.get("held_out") or it.get("heldOut")):
                out.append(name)
    return out or None


def load_kind_map(path, engine):
    """Return {raw_kind: [span types]} for the engine, or None when the engine has no entry."""
    if not os.path.exists(path):
        raise SystemExit("kind map not found: %s" % path)
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    m = data.get(engine)
    if not isinstance(m, dict):
        return None
    out = {}
    for k, v in m.items():
        if isinstance(v, str):
            out[k] = [v]
        elif isinstance(v, list) and v and all(isinstance(x, str) for x in v):
            out[k] = list(v)
    return out


def quantile(sorted_vals, q):
    if not sorted_vals:
        return None
    i = int(math.ceil(q * len(sorted_vals))) - 1
    i = max(0, min(i, len(sorted_vals) - 1))
    return sorted_vals[i]


def slice_stats(rows):
    """rows: list of (row, blocked). Row-level recall and false-block."""
    v = [b for r, b in rows if r.get("row_label") == "violation"]
    c = [b for r, b in rows if r.get("row_label") == "clean"]
    return {
        "rows": len(rows),
        "violation": len(v),
        "clean": len(c),
        "recall": wilson(sum(1 for b in v if b), len(v)),
        "false_block": wilson(sum(1 for b in c if b), len(c)),
    }


def group_stats(items, keyfn):
    groups = {}
    for item in items:
        keys = keyfn(item[0])
        if isinstance(keys, str) or keys is None:
            keys = [keys]
        for k in set(keys):
            if k is None or k == "":
                continue
            groups.setdefault(k, []).append(item)
    return {k: slice_stats(groups[k]) for k in sorted(groups)}


def kind_table(items, preds, kind_map):
    """Per engine kind: rows it fired on, split by violation and clean, plus mapped GuardBench types."""
    per = {}
    for row, _ in items:
        label = row.get("row_label")
        for k in set(x for x in (preds[row["id"]].get("kinds") or []) if isinstance(x, str)):
            e = per.setdefault(k, {"violation_rows": 0, "clean_rows": 0})
            if label == "violation":
                e["violation_rows"] += 1
            elif label == "clean":
                e["clean_rows"] += 1
    out = {}
    for k in sorted(per):
        types = (kind_map or {}).get(k) or []
        out[k] = {"types": list(types), "violation_rows": per[k]["violation_rows"], "clean_rows": per[k]["clean_rows"]}
    return out


def overlaps(a_start, a_end, b_start, b_end):
    return a_start < b_end and b_start < a_end


def pair_spans(pspans, gold):
    """One-to-one pairing of predicted and gold spans.

    pspans: [(start, end, allowed_types)], gold: [(start, end, type)]. Both are visited in sorted
    order; an exact pass runs first, then an overlap pass over what is left. Returns, per predicted
    span, None or (gold index, is_exact).
    """
    porder = sorted(range(len(pspans)), key=lambda i: (pspans[i][0], pspans[i][1]))
    gorder = sorted(range(len(gold)), key=lambda i: (gold[i][0], gold[i][1]))
    paired = [None] * len(pspans)
    taken = [False] * len(gold)
    for exact in (True, False):
        for pi in porder:
            if paired[pi] is not None:
                continue
            ps, pe, allowed = pspans[pi]
            for gi in gorder:
                if taken[gi]:
                    continue
                gs, ge, gt = gold[gi]
                if gt not in allowed:
                    continue
                if (ps == gs and pe == ge) if exact else overlaps(ps, pe, gs, ge):
                    taken[gi] = True
                    paired[pi] = (gi, exact)
                    break
    return paired


def span_stats(items, preds, kind_map):
    """Span-level precision/recall per type. items: [(row, blocked)]."""
    per = {}
    unmapped = 0

    def acc(t):
        return per.setdefault(t, {"gold": 0, "pred": 0, "tp_exact": 0, "tp_overlap": 0, "hit_exact": 0, "hit_overlap": 0})

    for row, _ in items:
        pred = preds[row["id"]]
        pspans = []
        for s in pred.get("spans") or []:
            try:
                start, end, raw = int(s["start"]), int(s["end"]), s["type"]
            except (KeyError, TypeError, ValueError):
                continue
            if kind_map is None:
                allowed = [raw]
            else:
                allowed = kind_map.get(raw)
                if not allowed:
                    unmapped += 1
                    continue
            pspans.append((start, end, allowed))
        gold = [(int(g["start"]), int(g["end"]), g["type"]) for g in (row.get("spans") or [])]
        paired = pair_spans(pspans, gold)
        hit_overlap = set(m[0] for m in paired if m)
        hit_exact = set(m[0] for m in paired if m and m[1])
        for gi, (_, _, gt) in enumerate(gold):
            a = acc(gt)
            a["gold"] += 1
            if gi in hit_exact:
                a["hit_exact"] += 1
            if gi in hit_overlap:
                a["hit_overlap"] += 1
        for pi, (_, _, al) in enumerate(pspans):
            m = paired[pi]
            a = acc(gold[m[0]][2] if m else al[0])
            a["pred"] += 1
            if m:
                a["tp_overlap"] += 1
                if m[1]:
                    a["tp_exact"] += 1

    def f1(p, r):
        if p is None or r is None or p + r == 0:
            return None
        return round(2 * p * r / (p + r), 2)

    out_types = {}
    tot = {k: 0 for k in ("gold", "pred", "tp_exact", "tp_overlap", "hit_exact", "hit_overlap")}
    for t in sorted(per):
        a = per[t]
        for k in tot:
            tot[k] += a[k]
        pe, re_ = wilson(a["tp_exact"], a["pred"]), wilson(a["hit_exact"], a["gold"])
        po, ro = wilson(a["tp_overlap"], a["pred"]), wilson(a["hit_overlap"], a["gold"])
        out_types[t] = {
            "gold": a["gold"],
            "pred": a["pred"],
            "precision_exact": pe,
            "recall_exact": re_,
            "precision_overlap": po,
            "recall_overlap": ro,
            "f1_exact": f1(pe["pct"], re_["pct"]),
            "f1_overlap": f1(po["pct"], ro["pct"]),
        }
    pe, re_ = wilson(tot["tp_exact"], tot["pred"]), wilson(tot["hit_exact"], tot["gold"])
    po, ro = wilson(tot["tp_overlap"], tot["pred"]), wilson(tot["hit_overlap"], tot["gold"])
    return {
        "available": True,
        "unmapped_pred_spans": unmapped,
        "micro": {
            "gold": tot["gold"],
            "pred": tot["pred"],
            "precision_exact": pe,
            "recall_exact": re_,
            "precision_overlap": po,
            "recall_overlap": ro,
            "f1_exact": f1(pe["pct"], re_["pct"]),
            "f1_overlap": f1(po["pct"], ro["pct"]),
        },
        "per_type": out_types,
    }


def fmt_rate(r):
    if not r or r.get("n", 0) == 0 or r.get("pct") is None:
        return "n/a"
    return "%.1f%% [%.1f-%.1f] (%d/%d)" % (r["pct"], r["ci_low"], r["ci_high"], r["hits"], r["n"])


def fmt_pct(v):
    return "n/a" if v is None else "%.1f%%" % v


def markdown(res):
    L = []
    w = L.append
    w("# %s" % res["headline"])
    w("")
    d = res["dataset"]
    w("engine: `%s` | split: %s | rows in split: %d (%d violation, %d clean) | dataset sha256: `%s` | python: %s" % (
        res["engine"], d["split"], d["rows"], d["violation"], d["clean"], d["sha256"], res["python"]))
    w("")
    w("rows scored: %d | missing predictions: %d | extra predictions: %d | errors: %d | incomplete: %s" % (
        res["rows_scored"], res["missing"], res["extra"], res["errors"], "yes" if res["incomplete"] else "no"))
    w("")
    if res["incomplete"]:
        for reason in res["incomplete_reasons"]:
            w("- incomplete: %s" % reason)
        w("")
    o = res["overall"]
    w("## Overall")
    w("")
    w("| metric | value |")
    w("|---|---|")
    w("| recall (violation rows blocked) | %s |" % fmt_rate(o["recall"]))
    w("| false-block (clean rows blocked) | %s |" % fmt_rate(o["false_block"]))
    ho = res["held_out"]
    w("| recall, held-out industries (%s) | %s |" % (", ".join(ho["industries"]), fmt_rate(ho["recall"])))
    w("| false-block, held-out industries | %s |" % fmt_rate(ho["false_block"]))
    lat = res["latency"]
    if lat["n"]:
        w("| latency p50 / p95 | %.3f ms / %.3f ms |" % (lat["p50_ms"], lat["p95_ms"]))
    else:
        w("| latency p50 / p95 | n/a |")
    w("")

    def table(title, groups):
        if not groups:
            return
        w("## %s" % title)
        w("")
        w("| group | rows | violation | clean | recall | false-block |")
        w("|---|---|---|---|---|---|")
        for k, s in groups.items():
            w("| %s | %d | %d | %d | %s | %s |" % (k, s["rows"], s["violation"], s["clean"], fmt_rate(s["recall"]), fmt_rate(s["false_block"])))
        w("")

    table("By jurisdiction", res["by_jurisdiction"])
    table("By category", res["by_category"])
    table("By industry", res["by_industry"])
    table("By difficulty", res["by_difficulty"])
    table("By shape", res["by_shape"])

    w("## Engine kinds fired")
    w("")
    kinds = res["kinds_fired"]
    if not kinds:
        w("no kinds reported")
        w("")
    else:
        w("Rows on which each engine kind fired, whether or not the row was blocked. Mapped types come from kind-map.json; `-` means no mapping.")
        w("")
        w("| engine kind | GuardBench types | violation rows | clean rows |")
        w("|---|---|---|---|")
        for k, s in kinds.items():
            w("| %s | %s | %d | %d |" % (k, ", ".join(s["types"]) or "-", s["violation_rows"], s["clean_rows"]))
        w("")

    w("## Span level")
    w("")
    sp = res["span"]
    if not sp.get("available"):
        w("n/a (row-level only)")
        w("")
    else:
        m = sp["micro"]
        w("micro: precision %s exact / %s overlap; recall %s exact / %s overlap; F1 %s exact / %s overlap; unmapped prediction spans: %d" % (
            fmt_pct(m["precision_exact"]["pct"]), fmt_pct(m["precision_overlap"]["pct"]),
            fmt_pct(m["recall_exact"]["pct"]), fmt_pct(m["recall_overlap"]["pct"]),
            fmt_pct(m["f1_exact"]), fmt_pct(m["f1_overlap"]), sp["unmapped_pred_spans"]))
        w("")
        w("| span type | gold | pred | precision exact (overlap) | recall exact (overlap) |")
        w("|---|---|---|---|---|")
        for t, s in sp["per_type"].items():
            w("| %s | %d | %d | %s (%s) | %s (%s) |" % (
                t, s["gold"], s["pred"],
                fmt_pct(s["precision_exact"]["pct"]), fmt_pct(s["precision_overlap"]["pct"]),
                fmt_pct(s["recall_exact"]["pct"]), fmt_pct(s["recall_overlap"]["pct"])))
        w("")
    return "\n".join(L) + "\n"


def incomplete_reasons(n_rows, missing, errors, pred_meta):
    reasons = []
    if missing:
        reasons.append("%d of %d rows have no prediction" % (missing, n_rows))
    if errors:
        reasons.append("%d predictions carry an error" % errors)
    if pred_meta:
        limit, scored, in_split = pred_meta.get("limit"), pred_meta.get("rowsScored"), pred_meta.get("rowsInSplit")
        if isinstance(limit, int) and limit > 0:
            reasons.append("the runner used --limit %d (%s of %s rows scored)" % (limit, scored, in_split))
        elif isinstance(scored, int) and isinstance(in_split, int) and scored < in_split:
            reasons.append("the runner scored %d of %d rows" % (scored, in_split))
    return reasons


def main():
    ap = argparse.ArgumentParser(description="Score GuardBench predictions.")
    ap.add_argument("--dataset", required=True)
    ap.add_argument("--predictions", required=True)
    ap.add_argument("--engine", required=True)
    ap.add_argument("--split", default="test")
    ap.add_argument("--kind-map", default=os.path.join(HERE, "kind-map.json"))
    ap.add_argument("--allow-incomplete", action="store_true", help="write results even when predictions are missing, errored or partial")
    ap.add_argument("--out", required=True)
    ap.add_argument("--md")
    args = ap.parse_args()

    split_path = find_split_file(args.dataset, args.split)
    rows, split_sha = read_split(split_path)
    preds = read_predictions(args.predictions)
    pred_meta = read_pred_meta(args.predictions)
    row_ids = {r["id"] for r in rows}
    extra = sum(1 for i in preds if i not in row_ids)

    items = []
    for r in rows:
        p = preds.get(r["id"])
        if p is None:
            continue
        items.append((r, bool(p.get("blocked") and not p.get("error"))))
    rows_scored = len(items)
    missing = len(rows) - rows_scored
    errors = sum(1 for r, _ in items if preds[r["id"]].get("error"))

    reasons = incomplete_reasons(len(rows), missing, errors, pred_meta)
    incomplete = bool(reasons)
    if incomplete and not args.allow_incomplete:
        sys.stderr.write("score.py: refusing to score an incomplete run (%s). Pass --allow-incomplete to record it flagged as incomplete.\n" % "; ".join(reasons))
        sys.exit(1)

    held = load_held_out(args.dataset)
    held_items = [it for it in items if it[0].get("industry") in held]
    ho = slice_stats(held_items)
    ho["industries"] = held

    lat = sorted(preds[r["id"]]["latency_us"] / 1000.0 for r, _ in items if isinstance(preds[r["id"]].get("latency_us"), (int, float)))
    latency = {
        "n": len(lat),
        "p50_ms": round(quantile(lat, 0.50), 4) if lat else None,
        "p95_ms": round(quantile(lat, 0.95), 4) if lat else None,
    }

    kind_map = load_kind_map(args.kind_map, args.engine)
    if any("spans" in preds[r["id"]] for r, _ in items):
        span = span_stats(items, preds, kind_map)
    else:
        span = {"available": False, "note": "n/a (row-level only)"}

    overall = slice_stats(items)
    n_viol = sum(1 for r in rows if r.get("row_label") == "violation")
    n_clean = sum(1 for r in rows if r.get("row_label") == "clean")
    rec, fb = overall["recall"]["pct"], overall["false_block"]["pct"]
    headline = "GuardBench v1: %s catches %s of violations at %s false blocks" % (
        args.engine,
        "n/a" if rec is None else "%.1f%%" % rec,
        "n/a" if fb is None else "%.1f%%" % fb,
    )
    if incomplete:
        headline += " (INCOMPLETE: %d of %d rows scored)" % (rows_scored, len(rows))

    res = {
        "schema": 2,
        "benchmark": "GuardBench v1",
        "engine": args.engine,
        "headline": headline,
        "python": "%d.%d.%d" % tuple(sys.version_info[:3]),
        "dataset": {
            "split": args.split,
            "rows": len(rows),
            "violation": n_viol,
            "clean": n_clean,
            "sha256": split_sha,
        },
        "incomplete": incomplete,
        "incomplete_reasons": reasons,
        "rows_scored": rows_scored,
        "missing": missing,
        "extra": extra,
        "errors": errors,
        "predictions_meta": pred_meta,
        "overall": overall,
        "by_jurisdiction": group_stats(items, lambda r: r.get("jurisdiction")),
        "by_category": group_stats(items, lambda r: r.get("categories") or []),
        "by_industry": group_stats(items, lambda r: r.get("industry")),
        "by_difficulty": group_stats(items, lambda r: r.get("difficulty")),
        "by_shape": group_stats(items, lambda r: r.get("shape")),
        "held_out": ho,
        "kinds_fired": kind_table(items, preds, kind_map),
        "span": span,
        "latency": latency,
    }

    outdir = os.path.dirname(os.path.abspath(args.out))
    os.makedirs(outdir, exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(res, f, indent=2, sort_keys=False)
        f.write("\n")
    if args.md:
        os.makedirs(os.path.dirname(os.path.abspath(args.md)), exist_ok=True)
        with open(args.md, "w", encoding="utf-8") as f:
            f.write(markdown(res))
    print(headline, file=sys.stderr)


if __name__ == "__main__":
    main()
