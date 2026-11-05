// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package eval

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
)

var Splits = []string{"train", "validation", "test"}

type Span struct {
	Label        string
	Canonical    string
	Text         string
	ShouldRedact bool
}

type Row struct {
	ID           int64
	Split        string
	OriginalText string
	RedactedText string
	Spans        []Span
}

type Dataset struct {
	Rows     []Row
	SHA256   string
	Manifest json.RawMessage
}

type rawRow struct {
	ID           *int64  `json:"id"`
	Split        string  `json:"split"`
	OriginalText *string `json:"original_text"`
	RedactedText *string `json:"redacted_text"`
	Annotations  *string `json:"annotations"`
}

type rawAnnotations struct {
	Annotations []struct {
		Type         string  `json:"type"`
		Text         *string `json:"text"`
		ShouldRedact bool    `json:"should_redact"`
	} `json:"annotations"`
}

func Load(dir string, splits []string) (Dataset, error) {
	jsonl := filepath.Join(dir, "jsonl")
	var ds Dataset
	if m, err := os.ReadFile(filepath.Join(jsonl, "manifest.json")); err == nil {
		ds.Manifest = m
	}
	h := sha256.New()
	for _, split := range Splits {
		if !slices.Contains(splits, split) {
			continue
		}
		path := filepath.Join(jsonl, split+".jsonl")
		raw, err := os.ReadFile(path)
		if err != nil {
			return Dataset{}, fmt.Errorf("read %s (convert the parquet files first with scripts/eval-pii-parquet-to-jsonl.py): %w", path, err)
		}
		_, _ = fmt.Fprintf(h, "%s %d\n", split, len(raw))
		h.Write(raw)
		sc := bufio.NewScanner(strings.NewReader(string(raw)))
		sc.Buffer(make([]byte, 64*1024), 16*1024*1024)
		for line := 1; sc.Scan(); line++ {
			row, err := parseRow(sc.Bytes(), split)
			if err != nil {
				return Dataset{}, fmt.Errorf("%s line %d: %w", path, line, err)
			}
			ds.Rows = append(ds.Rows, row)
		}
		if err := sc.Err(); err != nil {
			return Dataset{}, fmt.Errorf("%s: %w", path, err)
		}
	}
	if len(ds.Rows) == 0 {
		return Dataset{}, errors.New("the dataset has no rows")
	}
	ds.SHA256 = hex.EncodeToString(h.Sum(nil))
	return ds, nil
}

func parseRow(b []byte, split string) (Row, error) {
	var r rawRow
	if err := json.Unmarshal(b, &r); err != nil {
		return Row{}, err
	}
	if r.ID == nil || r.OriginalText == nil || r.RedactedText == nil || r.Annotations == nil {
		return Row{}, errors.New("a row needs id, original_text, redacted_text and annotations")
	}
	if r.Split != "" && r.Split != split {
		return Row{}, fmt.Errorf("row %d says split %q in the %s file", *r.ID, r.Split, split)
	}
	spans, err := ParseAnnotations(*r.Annotations)
	if err != nil {
		return Row{}, fmt.Errorf("row %d annotations: %w", *r.ID, err)
	}
	return Row{ID: *r.ID, Split: split, OriginalText: *r.OriginalText, RedactedText: *r.RedactedText, Spans: spans}, nil
}

func ParseAnnotations(s string) ([]Span, error) {
	var a rawAnnotations
	if err := json.Unmarshal([]byte(s), &a); err != nil {
		return nil, err
	}
	out := make([]Span, 0, len(a.Annotations))
	for _, x := range a.Annotations {
		text := ""
		if x.Text != nil {
			text = *x.Text
		}
		out = append(out, Span{Label: x.Type, Canonical: Canonical(x.Type), Text: text, ShouldRedact: x.ShouldRedact})
	}
	return out, nil
}

func (r Row) PIILabels() []string {
	seen := map[string]bool{}
	for _, s := range r.Spans {
		if s.ShouldRedact {
			seen[s.Canonical] = true
		}
	}
	out := make([]string, 0, len(seen))
	for l := range seen {
		out = append(out, l)
	}
	sort.Strings(out)
	return out
}

func (r Row) DerivedRedaction() (string, bool) {
	spans := []Span{}
	for _, s := range r.Spans {
		if s.ShouldRedact && s.Text != "" {
			spans = append(spans, s)
		}
	}
	sort.SliceStable(spans, func(i, j int) bool { return len(spans[i].Text) > len(spans[j].Text) })
	text := r.OriginalText
	located := true
	for _, s := range spans {
		if !strings.Contains(r.OriginalText, s.Text) {
			located = false
		}
		text = strings.ReplaceAll(text, s.Text, "["+s.Canonical+"]")
	}
	return text, located
}

func (r Row) ShippedRedactionLeaks() bool {
	for _, s := range r.Spans {
		if s.ShouldRedact && s.Text != "" && strings.Contains(r.RedactedText, s.Text) {
			return true
		}
	}
	return false
}
