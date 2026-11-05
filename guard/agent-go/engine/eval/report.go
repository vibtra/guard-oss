// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package eval

import (
	"fmt"
	"sort"
	"strings"
)

func pct(r Rate) string {
	if r.N == 0 {
		return "n/a"
	}
	return fmt.Sprintf("%.1f%% [%.1f–%.1f] (%d/%d)", r.Pct, r.Lo, r.Hi, r.Hits, r.N)
}

func Markdown(r Results) string {
	var b strings.Builder
	w := func(format string, a ...any) { _, _ = fmt.Fprintf(&b, format, a...) }
	sha := r.GitSHA
	if r.GitDirty {
		sha += " (dirty)"
	}
	w("engine: %s · git %s · dataset sha256 %s · policy %s\n\n", r.Engine, sha, r.Dataset.SHA256, r.Policy.BundleDigest[:12])
	cols := append([]string{"all"}, r.Dataset.Splits...)
	w("| metric | %s |\n|---|%s\n", strings.Join(cols, " | "), strings.Repeat("---|", len(cols)))
	row := func(name string, f func(Score) string) {
		cells := []string{}
		for _, c := range cols {
			cells = append(cells, f(r.Scores[c]))
		}
		w("| %s | %s |\n", name, strings.Join(cells, " | "))
	}
	row("rows", func(s Score) string { return fmt.Sprint(s.Rows) })
	row("blocked % (recall), original_text", func(s Score) string { return pct(s.Recall) })
	row("blocked %, rows with should-redact PII", func(s Score) string { return pct(s.RecallPIIRows) })
	row("false-block %, derived redaction", func(s Score) string { return pct(s.FalseBlock) })
	row("false-block %, shipped redacted_text", func(s Score) string { return pct(s.ShippedFalseBlock) })
	row("shipped redacted_text rows still holding PII", func(s Score) string { return fmt.Sprint(s.ShippedLeakRows) })
	row("latency p50 / p95 µs per decision", func(s Score) string { return fmt.Sprintf("%.0f / %.0f", s.Latency.P50us, s.Latency.P95us) })
	w("\n| label | detector | %s |\n|---|---|%s\n", strings.Join(cols, " | "), strings.Repeat("---|", len(cols)))
	for _, l := range LabelOrder() {
		all, ok := r.Scores["all"].Labels[l]
		if !ok {
			continue
		}
		cells := []string{}
		for _, c := range cols {
			cells = append(cells, pct(r.Scores[c].Labels[l].Rate))
		}
		det := "no"
		if all.Detector {
			det = "yes"
		}
		w("| %s | %s | %s |\n", l, det, strings.Join(cells, " | "))
	}
	kinds := []string{}
	for k, n := range r.Scores["all"].BlockedByKind {
		kinds = append(kinds, fmt.Sprintf("%s %d", k, n))
	}
	sort.Strings(kinds)
	w("\nblocked rows by detector kind (all): %s\n", strings.Join(kinds, ", "))
	w("labels with no detector: %s\n", strings.Join(r.NoDetector, ", "))
	w("escapes (original_text not blocked): %d rows · false blocks (derived redaction): %d rows\n", len(r.Escapes), len(r.FalseBlocks))
	return b.String()
}
