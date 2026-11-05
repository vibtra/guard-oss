// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"sort"
	"strings"
	"time"

	"github.com/vibtra/guard/guard/agent-go/engine"
	"github.com/vibtra/guard/guard/agent-go/engine/eval"
	"github.com/vibtra/guard/guard/agent-go/engine/rules"
)

type row struct {
	ID     string `json:"id"`
	Prompt string `json:"prompt"`
}

type prediction struct {
	ID        string   `json:"id"`
	Blocked   bool     `json:"blocked"`
	Kinds     []string `json:"kinds"`
	LatencyUS int64    `json:"latency_us"`
	Error     string   `json:"error,omitempty"`
}

type meta struct {
	Engine      string `json:"engine"`
	Dataset     string `json:"dataset"`
	Split       string `json:"split"`
	Limit       int    `json:"limit"`
	RowsInSplit int    `json:"rowsInSplit"`
	RowsScored  int    `json:"rowsScored"`
	Rows        int    `json:"rows"`
	Blocked     int    `json:"blocked"`
	Errors      int    `json:"errors"`
	GitSHA      string `json:"gitSHA"`
	BuildTags   string `json:"buildTags"`
	GoVersion   string `json:"goVersion"`
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "guardbench:", err)
		os.Exit(1)
	}
}

func run() (err error) {
	engineName := flag.String("engine", "rules", "engine to score: rules")
	dataset := flag.String("dataset", "", "directory holding dev.jsonl.gz and test.jsonl.gz (plain .jsonl also accepted)")
	split := flag.String("split", "test", "test, dev or all")
	out := flag.String("out", "predictions.jsonl", "predictions file to write")
	limit := flag.Int("limit", 0, "score only the first N rows (0 = all); the meta file records the limit")
	policyName := flag.String("policy", "default", "default or identifiers")
	flag.Parse()
	eng, err := newEngine(*engineName)
	if err != nil {
		return err
	}
	if *dataset == "" {
		return errors.New("--dataset DIR is required")
	}
	var splits []string
	switch *split {
	case "test", "dev":
		splits = []string{*split}
	case "all":
		splits = []string{"dev", "test"}
	default:
		return errors.New("--split takes test, dev or all")
	}

	f, err := os.Create(*out)
	if err != nil {
		return err
	}
	defer func() {
		if cerr := f.Close(); cerr != nil && err == nil {
			err = cerr
		}
	}()
	w := bufio.NewWriterSize(f, 1<<20)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)

	ctx := context.Background()
	bundle, catalogue := eval.Bundle(), eval.Catalogue()
	switch *policyName {
	case "default":
	case "identifiers":
		bundle = eval.IdentifierBundle()
	default:
		return errors.New("--policy takes default or identifiers")
	}
	decide := func(text string) (engine.Decision, time.Duration, error) {
		req := engine.Request{Host: eval.Host, Transport: engine.HTTP, Content: content(text), Bundle: bundle, Catalogue: catalogue, Now: eval.Now}
		start := time.Now()
		d, derr := eng.Decide(ctx, req)
		took := time.Since(start)
		if derr != nil {
			return d, took, derr
		}
		return d, took, engine.Validate(d)
	}

	inSplit, scored, blocked, errs := 0, 0, 0, 0
	warmed := false
	for _, s := range splits {
		path, ferr := findSplit(*dataset, s)
		if ferr != nil {
			return ferr
		}
		err = readRows(path, func(r row) error {
			inSplit++
			if *limit > 0 && scored >= *limit {
				return nil
			}
			if !warmed {
				warmed = true
				_, _, _ = decide(r.Prompt)
			}
			d, took, derr := decide(r.Prompt)
			p := prediction{ID: r.ID, Kinds: []string{}, LatencyUS: took.Microseconds()}
			if derr != nil {
				p.Error = derr.Error()
				errs++
			} else {
				p.Blocked = d.Verdict == "blocked" && d.Enforced
				p.Kinds = collect(d)
			}
			if p.Blocked {
				blocked++
			}
			scored++
			return enc.Encode(p)
		})
		if err != nil {
			return err
		}
	}
	if err = w.Flush(); err != nil {
		return err
	}

	sha := gitSHA()
	m := meta{
		Engine:      eng.Name(),
		Dataset:     *dataset,
		Split:       *split,
		Limit:       *limit,
		RowsInSplit: inSplit,
		RowsScored:  scored,
		Rows:        scored,
		Blocked:     blocked,
		Errors:      errs,
		GitSHA:      sha,
		BuildTags:   buildTags(),
		GoVersion:   runtime.Version(),
	}
	mb, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	if err = os.WriteFile(*out+".meta.json", append(mb, '\n'), 0o644); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "guardbench: engine=%s split=%s rows=%d/%d blocked=%d errors=%d git=%s\n", eng.Name(), *split, scored, inSplit, blocked, errs, sha)
	return nil
}

func findSplit(dir, split string) (string, error) {
	for _, name := range []string{split + ".jsonl.gz", split + ".jsonl"} {
		p := filepath.Join(dir, name)
		if _, err := os.Stat(p); err == nil {
			return p, nil
		}
	}
	return "", fmt.Errorf("no %s.jsonl.gz or %s.jsonl in %s", split, split, dir)
}

func readRows(path string, fn func(row) error) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	var r io.Reader = f
	if strings.HasSuffix(path, ".gz") {
		gz, gerr := gzip.NewReader(f)
		if gerr != nil {
			return gerr
		}
		defer func() { _ = gz.Close() }()
		r = gz
	}
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 1<<20), 16<<20)
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		var rw row
		if uerr := json.Unmarshal(line, &rw); uerr != nil {
			return fmt.Errorf("%s: %w", path, uerr)
		}
		if ferr := fn(rw); ferr != nil {
			return ferr
		}
	}
	return sc.Err()
}

func collect(d engine.Decision) []string {
	kinds := []string{}
	if d.Content == nil {
		return kinds
	}
	seen := map[string]bool{}
	for _, m := range d.Content.Matches {
		if m.Excepted || seen[m.Match.Kind] {
			continue
		}
		seen[m.Match.Kind] = true
		kinds = append(kinds, m.Match.Kind)
		for _, detail := range m.Match.Details {
			kinds = append(kinds, m.Match.Kind+"/"+detail)
		}
	}
	sort.Strings(kinds)
	return kinds
}

func newEngine(name string) (engine.Engine, error) {
	if name != "rules" {
		return nil, fmt.Errorf("--engine takes rules, not %q", name)
	}
	return rules.New(), nil
}

func buildTags() string {
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, s := range info.Settings {
			if s.Key == "-tags" {
				return s.Value
			}
		}
	}
	return ""
}

func gitSHA() string {
	sha, dirty := "unknown", false
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, s := range info.Settings {
			switch s.Key {
			case "vcs.revision":
				sha = s.Value
			case "vcs.modified":
				dirty = s.Value == "true"
			}
		}
	}
	if dirty {
		sha += "-dirty"
	}
	return sha
}

func content(text string) engine.Content {
	body, _ := json.Marshal(map[string]any{"model": "eval", "messages": []map[string]string{{"role": "user", "content": text}}})
	out := engine.Content{Spans: []engine.TextSpan{}}
	var sb strings.Builder
	add := func(value, label string) {
		sb.WriteString(value)
		sb.WriteByte('\n')
		out.Spans = append(out.Spans, engine.TextSpan{Text: value, Label: label})
	}
	var walk func(any, string, int)
	walk = func(v any, label string, depth int) {
		if depth > 64 {
			return
		}
		switch x := v.(type) {
		case string:
			if n := nested(x); n != nil {
				walk(n, label, depth+1)
				return
			}
			add(x, label)
		case json.Number:
			add(string(x), label)
		case []any:
			for _, item := range x {
				walk(item, label, depth+1)
			}
		case map[string]any:
			keys := make([]string, 0, len(x))
			for k := range x {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				walk(x[k], k, depth+1)
			}
		}
	}
	if v, err := decodeJSON(body); err == nil {
		walk(v, "", 0)
	} else {
		add(string(body), "")
	}
	out.Text = sb.String()
	return out
}

func decodeJSON(b []byte) (any, error) {
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	var v any
	err := d.Decode(&v)
	if err == nil {
		var extra any
		if !errors.Is(d.Decode(&extra), io.EOF) {
			return nil, io.ErrUnexpectedEOF
		}
	}
	return v, err
}

func nested(s string) any {
	s = strings.TrimSpace(s)
	if !strings.HasPrefix(s, "{") && !strings.HasPrefix(s, "[") {
		return nil
	}
	v, err := decodeJSON([]byte(s))
	if err != nil {
		return nil
	}
	switch v.(type) {
	case []any, map[string]any:
		return v
	}
	return nil
}
