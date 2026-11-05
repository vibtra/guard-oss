// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package main

import (
	"bytes"
	"encoding/json"
	"io"
	"mime"
	"mime/multipart"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/vibtra/guard/guard/agent-go/engine"
)

const inspectionLimit = 4 * 1024 * 1024

type TextSpan = engine.TextSpan

type Extracted = engine.Content

func inspectable(ct string) bool {
	ct = strings.TrimSpace(strings.ToLower(strings.Split(ct, ";")[0]))
	return ct == "" || ct == "application/json" || strings.HasSuffix(ct, "+json") || ct == "application/x-www-form-urlencoded" || ct == "multipart/form-data" || strings.HasPrefix(ct, "text/")
}
func decodeJSON(b []byte) (any, error) {
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	var v any
	err := d.Decode(&v)
	if err == nil {
		var extra any
		if d.Decode(&extra) != io.EOF {
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
func extract(ct string, body []byte) Extracted {
	out := Extracted{Spans: []TextSpan{}}
	essence, params, err := mime.ParseMediaType(ct)
	if err != nil {
		essence = strings.TrimSpace(strings.ToLower(strings.Split(ct, ";")[0]))
	}
	essence = strings.ToLower(essence)
	var text strings.Builder
	add := func(value, label string) {
		text.WriteString(value)
		text.WriteByte('\n')
		out.Spans = append(out.Spans, TextSpan{Text: value, Label: label})
	}
	var walk func(any, string, string, int)
	walk = func(v any, path, label string, depth int) {
		if depth > 64 {
			return
		}
		switch x := v.(type) {
		case string:
			if n := nested(x); n != nil {
				walk(n, path+"{}", label, depth+1)
				return
			}
			add(x, label)
		case json.Number:
			add(string(x), label)
		case []any:
			if messagePartsPath.MatchString(path) {
				fragments := []string{}
				flush := func() {
					if len(fragments) > 1 {
						out.Joined = append(out.Joined, strings.Join(fragments, ""))
					}
					fragments = nil
				}
				for _, item := range x {
					fragment, ok := messageFragment(item)
					if !ok {
						flush()
					} else {
						fragments = append(fragments, fragment)
					}
				}
				flush()
			}
			for i, item := range x {
				walk(item, path+"["+strconv.Itoa(i)+"]", label, depth+1)
			}
		case map[string]any:
			keys := make([]string, 0, len(x))
			for k := range x {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				walk(x[k], path+"."+strconv.Quote(k), k, depth+1)
			}
		}
	}
	switch {
	case essence == "application/json" || strings.HasSuffix(essence, "+json"):
		if v, e := decodeJSON(body); e == nil {
			walk(v, "", "", 0)
		} else {
			add(string(body), "")
		}
	case essence == "application/x-www-form-urlencoded":
		for _, pair := range strings.Split(string(body), "&") {
			kv := strings.SplitN(pair, "=", 2)
			if len(kv) != 2 {
				continue
			}
			s, e := url.QueryUnescape(kv[1])
			if e != nil {
				s = kv[1]
			}
			label, e := url.QueryUnescape(kv[0])
			if e != nil {
				label = kv[0]
			}
			walk(s, "form."+label, label, 0)
		}
	case essence == "multipart/form-data":
		if params["boundary"] != "" {
			r := multipart.NewReader(bytes.NewReader(body), params["boundary"])
			for {
				part, e := r.NextRawPart()
				if e != nil {
					break
				}
				b, e := io.ReadAll(io.LimitReader(part, inspectionLimit+1))
				_ = part.Close()
				if e != nil {
					continue
				}
				name := part.FileName()
				t := strings.ToLower(part.Header.Get("Content-Type"))
				if name != "" {
					out.Filenames = append(out.Filenames, name)
				}
				if name == "" && (t == "" || strings.HasPrefix(t, "text/") || strings.HasPrefix(t, "application/json")) || name != "" && (strings.HasPrefix(t, "text/") || strings.HasPrefix(t, "application/json")) {
					walk(string(b), "multipart."+part.FormName(), part.FormName(), 0)
				}
			}
		}
	default:
		if inspectable(ct) {
			if n := nested(string(body)); n != nil {
				walk(n, "", "", 0)
			} else if lines := jsonLines(string(body)); lines != nil {
				for _, line := range lines {
					walk(line, "", "", 0)
				}
			} else {
				add(string(body), "")
			}
		}
	}
	out.Text = text.String()
	return out
}

func jsonLines(s string) []any {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	if len(lines) < 2 {
		return nil
	}
	out := []any{}
	for _, line := range lines {
		if strings.TrimSpace(line) == "" {
			continue
		}
		v := nested(line)
		if v == nil {
			return nil
		}
		out = append(out, v)
	}
	return out
}

var messagePartsPath = regexp.MustCompile(`^\.(?:"messages"\[[0-9]+\]\."content"(?:\."parts")?|"contents"\[[0-9]+\]\."parts"|"input"\[[0-9]+\]\."content")$`)

func messageFragment(v any) (string, bool) {
	if s, ok := v.(string); ok {
		return s, nested(s) == nil
	}
	m, ok := v.(map[string]any)
	if !ok {
		return "", false
	}
	if typ, ok := m["type"]; ok && typ != "text" && typ != "input_text" && typ != "output_text" {
		return "", false
	}
	s, ok := m["text"].(string)
	return s, ok && nested(s) == nil
}
