#!/usr/bin/env python3
"""GuardBench leaderboard: results/*.json (written by score.py) -> markdown on stdout.

Usage: leaderboard.py RESULTS_DIR > LEADERBOARD.md

Files that are not score.py outputs are skipped. Ranking: complete results on the test split come
first. Among them, engines at or under 5% false-block rank first by recall (highest first), then
the rest by recall. Incomplete results and results on other splits rank below all of those, in
the same order among themselves.
"""
import glob
import json
import os
import sys

FB_LIMIT = 5.0


def is_result(r):
    if not isinstance(r, dict) or r.get("benchmark") != "GuardBench v1":
        return False
    if not isinstance(r.get("engine"), str) or not isinstance(r.get("headline"), str):
        return False
    o = r.get("overall")
    return isinstance(o, dict) and "recall" in o and "false_block" in o and isinstance(r.get("dataset"), dict)


def load(results_dir):
    out = []
    for p in sorted(glob.glob(os.path.join(results_dir, "*.json"))):
        try:
            with open(p, "r", encoding="utf-8") as f:
                r = json.load(f)
        except (OSError, ValueError):
            continue
        if is_result(r):
            out.append(r)
    return out


def pct(rate):
    if not rate or not rate.get("n") or rate.get("pct") is None:
        return None
    return rate["pct"]


def cell(rate):
    if not rate or not rate.get("n") or rate.get("pct") is None:
        return "n/a"
    return "%.1f%% [%.1f-%.1f]" % (rate["pct"], rate["ci_low"], rate["ci_high"])


def split_of(r):
    return r["dataset"].get("split", "?")


def is_incomplete(r):
    if "incomplete" in r:
        return bool(r["incomplete"])
    return bool(r.get("missing") or r.get("errors"))


def is_ranked(r):
    return not is_incomplete(r) and split_of(r) == "test"


def sort_key(r):
    rec = pct(r["overall"]["recall"])
    fb = pct(r["overall"]["false_block"])
    rec = -1.0 if rec is None else rec
    fb_v = 101.0 if fb is None else fb
    within = fb is not None and fb <= FB_LIMIT
    return (0 if is_ranked(r) else 1, 0 if within else 1, -rec, fb_v, r["engine"])


def count(r, key):
    v = r.get(key)
    return "?" if v is None else str(v)


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: leaderboard.py RESULTS_DIR > LEADERBOARD.md")
    results = load(sys.argv[1])
    results.sort(key=sort_key)
    print("# GuardBench v1 leaderboard")
    print()
    if not results:
        print("No results yet.")
        return
    heads = [r for r in results if is_ranked(r) and r.get("shipping", True)]
    if heads:
        for r in heads:
            print("**%s**" % r["headline"])
            print()
    else:
        print("**No complete result on the test split yet.**")
        print()
    print("| Rank | Engine | Split | Recall [95% CI] | False-block [95% CI] | Held-out industry recall | p50 / p95 ms | Span F1 (exact / overlap) | Rows scored | Missing | Errors | Incomplete | Dataset SHA256 |")
    print("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for i, r in enumerate(results, 1):
        lat = r.get("latency") or {}
        if lat.get("n"):
            lat_s = "%.3f / %.3f" % (lat["p50_ms"], lat["p95_ms"])
        else:
            lat_s = "n/a"
        sp = r.get("span") or {}
        if sp.get("available"):
            m = sp["micro"]
            f1e, f1o = m.get("f1_exact"), m.get("f1_overlap")
            sp_s = "%s / %s" % ("n/a" if f1e is None else "%.1f%%" % f1e, "n/a" if f1o is None else "%.1f%%" % f1o)
        else:
            sp_s = "n/a"
        ds = r["dataset"]
        print("| %d | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | `%s` |" % (
            i,
            r["engine"] + ("" if r.get("shipping", True) else " (non-shipping)"),
            split_of(r),
            cell(r["overall"]["recall"]),
            cell(r["overall"]["false_block"]),
            cell((r.get("held_out") or {}).get("recall")),
            lat_s,
            sp_s,
            count(r, "rows_scored"),
            count(r, "missing"),
            count(r, "errors"),
            "yes" if is_incomplete(r) else "no",
            (ds.get("sha256") or "?")[:12],
        ))
    print()
    shas = {}
    for r in results:
        shas.setdefault(split_of(r), set()).add(r["dataset"].get("sha256"))
    if any(len(s) > 1 for s in shas.values()):
        print("Warning: results on the same split come from different dataset files; ranks are not comparable.")
        print()
    notes = [r for r in results if r.get("note")]
    if notes:
        print("Notes")
        print()
        for r in notes:
            print("- **%s**: %s" % (r["engine"], r["note"]))
        print()
    print("Ranking: complete results on the test split rank first. Among them, engines at or under %.0f%% false-block rank first by recall (highest first), then the rest by recall. Incomplete results and results on other splits rank last, in the same order." % FB_LIMIT)
    print("An incomplete result has missing predictions, prediction errors, or came from a partial run (`--limit`); its numbers cover only the rows scored.")
    print("Intervals are Wilson 95%. Recall is violation rows blocked; false-block is clean rows blocked.")


if __name__ == "__main__":
    main()
