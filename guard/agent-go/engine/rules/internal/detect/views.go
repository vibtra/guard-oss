// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package detect

import (
	"encoding/base64"
	"net/url"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/vibtra/guard/guard/agent-go/engine"
	"golang.org/x/text/unicode/norm"
)

type Prepared struct {
	Strict, Joined, Context     []string
	StrictLabels, ContextLabels []string
	ContextKinds                []string
	PrimaryCount                int
}

var percentRun = regexp.MustCompile(`(?:%[0-9A-Fa-f]{2})+`)
var zeroWidth = regexp.MustCompile("[\u200B-\u200D\u2060\uFEFF]")
var base64Run = regexp.MustCompile(`[A-Za-z0-9+/]{24,}={0,2}`)
var digitGap = regexp.MustCompile(`(?:[ ./\-]{1,3}|[ \t]*\r?\n[ \t]*)`)

func normalise(s string) string {
	s = percentRun.ReplaceAllStringFunc(s, func(r string) string {
		v, e := url.PathUnescape(r)
		if e == nil && utf8.ValidString(v) {
			return v
		}
		return r
	})
	return norm.NFKC.String(zeroWidth.ReplaceAllString(s, ""))
}
func collapse(s string) string {
	var b strings.Builder
	last := 0
	for _, p := range digitGap.FindAllStringIndex(s, -1) {
		if p[0] > 0 && p[1] < len(s) && digit(s[p[0]-1]) && digit(s[p[1]]) {
			b.WriteString(s[last:p[0]])
			last = p[1]
		}
	}
	b.WriteString(s[last:])
	return b.String()
}
func prepare(text string, joined []string) Prepared {
	p := Prepared{Strict: []string{normalise(text)}, PrimaryCount: 1}
	for _, s := range base64Run.FindAllString(p.Strict[0], -1) {
		s = strings.TrimRight(s, "=")
		if len(s)%4 == 1 {
			s = s[:len(s)-1]
		}
		b, e := base64.RawStdEncoding.DecodeString(s)
		if e != nil || !utf8.Valid(b) || len(b) == 0 {
			continue
		}
		ok := true
		for _, r := range string(b) {
			if unicode.IsControl(r) && r != '\r' && r != '\n' && r != '\t' {
				ok = false
				break
			}
		}
		if ok {
			p.Strict = append(p.Strict, normalise(string(b)))
		}
	}
	for _, j := range joined {
		p.Joined = append(p.Joined, normalise(j))
	}
	p.Context = append(p.Context, p.Joined...)
	for range p.Joined {
		p.ContextKinds = append(p.ContextKinds, "joined")
	}
	for _, v := range append(append([]string{}, p.Strict...), p.Joined...) {
		if c := collapse(v); c != v {
			p.Context = append(p.Context, c)
			p.ContextKinds = append(p.ContextKinds, "collapsed")
		}
	}
	return p
}
func digit(c byte) bool { return c >= '0' && c <= '9' }
func word(c byte) bool  { return digit(c) || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c == '_' }
func token(c byte) bool { return word(c) || c == '-' }
func unwrap(s string, parity int) string {
	lines := strings.Split(s, "\n")
	var b strings.Builder
	chain := -1
	for i, l := range lines {
		if i == 0 {
			b.WriteString(l)
			continue
		}
		prev := strings.TrimSuffix(lines[i-1], "\r")
		removable := len(prev) > 0 && len(l) > 0 && token(prev[len(prev)-1]) && token(l[0])
		all := len(prev) > 0
		for k := 0; k < len(prev); k++ {
			if !token(prev[k]) {
				all = false
			}
		}
		if !removable {
			chain = -1
		} else if chain >= 0 && all {
			chain++
		} else {
			chain = 0
		}
		if chain >= 0 && chain%2 == parity {
			v := b.String()
			b.Reset()
			b.WriteString(strings.TrimSuffix(v, "\r"))
		} else {
			b.WriteByte('\n')
		}
		b.WriteString(l)
	}
	return b.String()
}

func Prepare(ex engine.Content) Prepared {
	if ex.Spans == nil {
		return prepare(ex.Text, ex.Joined)
	}
	p := Prepared{PrimaryCount: len(ex.Spans)}
	decoded, decodedLabels := []string{}, []string{}
	for _, span := range ex.Spans {
		view := prepare(span.Text, nil)
		p.Strict = append(p.Strict, view.Strict[0])
		p.StrictLabels = append(p.StrictLabels, span.Label)
		for _, v := range view.Strict[1:] {
			decoded = append(decoded, v)
			decodedLabels = append(decodedLabels, span.Label)
		}
		for _, v := range view.Context {
			p.Context = append(p.Context, v)
			p.ContextKinds = append(p.ContextKinds, "collapsed")
			p.ContextLabels = append(p.ContextLabels, span.Label)
		}
	}
	p.Strict = append(p.Strict, decoded...)
	p.StrictLabels = append(p.StrictLabels, decodedLabels...)
	for _, joined := range ex.Joined {
		v := normalise(joined)
		p.Joined = append(p.Joined, v)
		p.Context = append(p.Context, v)
		p.ContextKinds = append(p.ContextKinds, "joined")
		p.ContextLabels = append(p.ContextLabels, "")
		if c := collapse(v); c != v {
			p.Context = append(p.Context, c)
			p.ContextKinds = append(p.ContextKinds, "collapsed")
			p.ContextLabels = append(p.ContextLabels, "")
		}
	}
	return p
}
func viewLabel(labels []string, i int) string {
	if i < len(labels) {
		return labels[i]
	}
	return ""
}
