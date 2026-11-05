// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package eval

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"runtime"
	"runtime/debug"
	"slices"
	"sort"
	"time"

	"github.com/vibtra/guard/guard/agent-go/engine"
)

type Rate struct {
	Hits int     `json:"hits"`
	N    int     `json:"n"`
	Pct  float64 `json:"pct"`
	Lo   float64 `json:"ciLow"`
	Hi   float64 `json:"ciHigh"`
}

func Wilson(hits, n int) Rate {
	if n == 0 {
		return Rate{}
	}
	const z = 1.959963984540054
	p := float64(hits) / float64(n)
	nf := float64(n)
	d := 1 + z*z/nf
	c := (p + z*z/(2*nf)) / d
	m := z * math.Sqrt(p*(1-p)/nf+z*z/(4*nf*nf)) / d
	return Rate{Hits: hits, N: n, Pct: round(100 * p), Lo: round(100 * math.Max(0, c-m)), Hi: round(100 * math.Min(1, c+m))}
}

func round(v float64) float64 { return math.Round(v*100) / 100 }

type LabelScore struct {
	Rate
	Detector bool `json:"detector"`
}

type Latency struct {
	Decisions int     `json:"decisions"`
	P50us     float64 `json:"p50us"`
	P95us     float64 `json:"p95us"`
}

type Score struct {
	Rows                   int                   `json:"rows"`
	Recall                 Rate                  `json:"recall"`
	RecallPIIRows          Rate                  `json:"recallRowsWithPII"`
	BlockedByKind          map[string]int        `json:"blockedRowsByKind"`
	FalseBlock             Rate                  `json:"falseBlock"`
	UnlocatedRows          int                   `json:"unlocatedRows"`
	ShippedFalseBlock      Rate                  `json:"shippedRedactedFalseBlock"`
	ShippedLeakRows        int                   `json:"shippedRedactedLeakRows"`
	ShippedCleanFalseBlock Rate                  `json:"shippedRedactedCleanRowsFalseBlock"`
	Labels                 map[string]LabelScore `json:"labels"`
	Latency                Latency               `json:"latency"`
}

type Escape struct {
	ID      int64    `json:"id"`
	Split   string   `json:"split"`
	Labels  []string `json:"labels"`
	Flagged []string `json:"flagged"`
	Missed  []string `json:"missedLabels"`
}

type FalseBlock struct {
	ID    int64    `json:"id"`
	Split string   `json:"split"`
	Kinds []string `json:"kinds"`
}

type Results struct {
	Schema      int               `json:"schema"`
	Engine      string            `json:"engine"`
	GitSHA      string            `json:"gitSha"`
	GitDirty    bool              `json:"gitDirty"`
	BuildTags   string            `json:"buildTags,omitempty"`
	GoVersion   string            `json:"goVersion"`
	GeneratedAt string            `json:"generatedAt"`
	Dataset     DatasetInfo       `json:"dataset"`
	Policy      PolicyInfo        `json:"policy"`
	KindLabels  map[string]string `json:"kindLabels"`
	NoDetector  []string          `json:"labelsWithNoDetector"`
	Scores      map[string]Score  `json:"scores"`
	Escapes     []Escape          `json:"escapes"`
	FalseBlocks []FalseBlock      `json:"falseBlocks"`
}

type DatasetInfo struct {
	SHA256   string          `json:"sha256"`
	Rows     int             `json:"rows"`
	Splits   []string        `json:"splits"`
	Manifest json.RawMessage `json:"manifest,omitempty"`
}

type PolicyInfo struct {
	BundleDigest    string   `json:"bundleDigest"`
	CatalogueDigest string   `json:"catalogueDigest"`
	Kinds           []string `json:"kinds"`
	Mode            string   `json:"mode"`
}

type outcome struct {
	row            *Row
	blocked        bool
	flagged        []string
	kinds          []string
	located        bool
	derivedBlocked bool
	derivedKinds   []string
	shippedBlocked bool
	shippedLeaks   bool
	latency        []time.Duration
}

type play struct {
	blocked bool
	kinds   []string
	took    time.Duration
}

func Run(ctx context.Context, e engine.Engine, ds Dataset, splits []string, content func(string) engine.Content) (Results, error) {
	b, c := Bundle(), Catalogue()
	decide := func(text string) (play, error) {
		req := engine.Request{Host: Host, Transport: engine.HTTP, Content: content(text), Bundle: b, Catalogue: c, Now: Now}
		start := time.Now()
		d, err := e.Decide(ctx, req)
		took := time.Since(start)
		if err != nil {
			return play{}, err
		}
		if err := engine.Validate(d); err != nil {
			return play{}, err
		}
		p := play{blocked: d.Verdict == "blocked" && d.Enforced, took: took}
		if d.Content != nil {
			for _, m := range d.Content.Matches {
				if !m.Excepted && !slices.Contains(p.kinds, m.Match.Kind) {
					p.kinds = append(p.kinds, m.Match.Kind)
				}
			}
		}
		sort.Strings(p.kinds)
		return p, nil
	}
	if len(ds.Rows) > 0 {
		if _, err := decide(ds.Rows[0].OriginalText); err != nil {
			return Results{}, err
		}
	}
	outs := make([]outcome, len(ds.Rows))
	for i := range ds.Rows {
		r := &ds.Rows[i]
		o := outcome{row: r, shippedLeaks: r.ShippedRedactionLeaks()}
		orig, err := decide(r.OriginalText)
		if err != nil {
			return Results{}, fmt.Errorf("row %d original_text: %w", r.ID, err)
		}
		derivedText, located := r.DerivedRedaction()
		derived, err := decide(derivedText)
		if err != nil {
			return Results{}, fmt.Errorf("row %d derived redaction: %w", r.ID, err)
		}
		shipped, err := decide(r.RedactedText)
		if err != nil {
			return Results{}, fmt.Errorf("row %d redacted_text: %w", r.ID, err)
		}
		o.blocked, o.kinds = orig.blocked, orig.kinds
		for _, k := range orig.kinds {
			if l, ok := kindLabel(k); ok && !slices.Contains(o.flagged, l) {
				o.flagged = append(o.flagged, l)
			}
		}
		sort.Strings(o.flagged)
		o.located, o.derivedBlocked, o.derivedKinds = located, derived.blocked, derived.kinds
		o.shippedBlocked = shipped.blocked
		o.latency = []time.Duration{orig.took, derived.took, shipped.took}
		outs[i] = o
	}

	covered := map[string]bool{}
	kinds := []string{}
	for _, rule := range b.ContentRules {
		kinds = append(kinds, rule.Detector.Kind)
		if l, ok := kindLabel(rule.Detector.Kind); ok {
			covered[l] = true
		}
	}
	res := Results{
		Schema:      1,
		Engine:      e.Name(),
		GoVersion:   runtime.Version(),
		GeneratedAt: time.Now().UTC().Format(time.RFC3339),
		Dataset:     DatasetInfo{SHA256: ds.SHA256, Rows: len(ds.Rows), Splits: splits, Manifest: ds.Manifest},
		Policy:      PolicyInfo{BundleDigest: Digest(b), CatalogueDigest: Digest(c), Kinds: kinds, Mode: b.ClientMode},
		KindLabels:  KindLabels,
		Scores:      map[string]Score{},
		Escapes:     []Escape{},
		FalseBlocks: []FalseBlock{},
	}
	res.GitSHA, res.GitDirty, res.BuildTags = vcs()
	for _, l := range LabelOrder() {
		if !covered[l] {
			res.NoDetector = append(res.NoDetector, l)
		}
	}
	res.Scores["all"] = score(outs, "", covered)
	for _, s := range splits {
		res.Scores[s] = score(outs, s, covered)
	}
	for _, o := range outs {
		labels := o.row.PIILabels()
		missed := []string{}
		for _, l := range labels {
			if !slices.Contains(o.flagged, l) {
				missed = append(missed, l)
			}
		}
		if !o.blocked {
			res.Escapes = append(res.Escapes, Escape{ID: o.row.ID, Split: o.row.Split, Labels: labels, Flagged: nonNil(o.flagged), Missed: missed})
		}
		if o.located && o.derivedBlocked {
			res.FalseBlocks = append(res.FalseBlocks, FalseBlock{ID: o.row.ID, Split: o.row.Split, Kinds: o.derivedKinds})
		}
	}
	return res, nil
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func score(outs []outcome, split string, covered map[string]bool) Score {
	var s Score
	recall, piiHits, piiN, fb, fbN, shipped, clean, cleanN := 0, 0, 0, 0, 0, 0, 0, 0
	s.BlockedByKind = map[string]int{}
	labelRows, labelHits := map[string]int{}, map[string]int{}
	lat := []time.Duration{}
	for _, o := range outs {
		if split != "" && o.row.Split != split {
			continue
		}
		s.Rows++
		if o.blocked {
			recall++
			for _, k := range o.kinds {
				s.BlockedByKind[k]++
			}
		}
		if len(o.row.PIILabels()) > 0 {
			piiN++
			if o.blocked {
				piiHits++
			}
		}
		if o.located {
			fbN++
			if o.derivedBlocked {
				fb++
			}
		} else {
			s.UnlocatedRows++
		}
		if o.shippedBlocked {
			shipped++
		}
		if o.shippedLeaks {
			s.ShippedLeakRows++
		} else {
			cleanN++
			if o.shippedBlocked {
				clean++
			}
		}
		for _, l := range o.row.PIILabels() {
			labelRows[l]++
			if slices.Contains(o.flagged, l) {
				labelHits[l]++
			}
		}
		lat = append(lat, o.latency...)
	}
	s.Recall = Wilson(recall, s.Rows)
	s.RecallPIIRows = Wilson(piiHits, piiN)
	s.FalseBlock = Wilson(fb, fbN)
	s.ShippedFalseBlock = Wilson(shipped, s.Rows)
	s.ShippedCleanFalseBlock = Wilson(clean, cleanN)
	s.Labels = map[string]LabelScore{}
	for l, n := range labelRows {
		s.Labels[l] = LabelScore{Rate: Wilson(labelHits[l], n), Detector: covered[l]}
	}
	slices.Sort(lat)
	s.Latency = Latency{Decisions: len(lat), P50us: quantile(lat, 0.50), P95us: quantile(lat, 0.95)}
	return s
}

func quantile(sorted []time.Duration, q float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	i := int(math.Ceil(q*float64(len(sorted)))) - 1
	i = max(0, min(i, len(sorted)-1))
	return round(float64(sorted[i].Nanoseconds()) / 1000)
}

func vcs() (string, bool, string) {
	sha, dirty, tags := "unknown", false, ""
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, s := range info.Settings {
			switch s.Key {
			case "vcs.revision":
				sha = s.Value
			case "vcs.modified":
				dirty = s.Value == "true"
			case "-tags":
				tags = s.Value
			}
		}
	}
	return sha, dirty, tags
}
