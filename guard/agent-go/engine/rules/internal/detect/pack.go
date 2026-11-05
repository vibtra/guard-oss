// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package detect

import (
	"embed"
	"encoding/json"
	"io/fs"
	"regexp"
	"slices"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"

	"github.com/vibtra/guard/guard/agent-go/engine"
	"github.com/vibtra/guard/guard/agent-go/policy"
)

//go:embed packs/*.json
var packFiles embed.FS

type packEntry struct {
	ID        string   `json:"id"`
	Label     string   `json:"label"`
	Country   string   `json:"country"`
	Group     string   `json:"group"`
	Source    string   `json:"source"`
	Patterns  []string `json:"patterns"`
	Check     string   `json:"check"`
	Context   []string `json:"context"`
	Before    int      `json:"before"`
	After     int      `json:"after"`
	Bounds    string   `json:"bounds"`
	NoDecimal bool     `json:"noDecimal"`
	Anchored  bool     `json:"anchored"`
	UpperGap  int      `json:"upperGap"`
	UpperOnly bool     `json:"upperOnly"`
	CellOnly  bool     `json:"cellOnly"`
	PersonRow bool     `json:"personRow"`
	ShapedRow bool     `json:"shapedRow"`
	Fire      []string `json:"fire"`
	Quiet     []string `json:"quiet"`
	res       []*regexp.Regexp
	valid     func(string) bool
	words     *wordSet
}

const (
	defaultBefore = 80
	defaultAfter  = 30
)

var loadPack = sync.OnceValue(func() []*packEntry {
	out := []*packEntry{}
	names, err := fs.Glob(packFiles, "packs/*.json")
	if err != nil {
		panic(err)
	}
	slices.Sort(names)
	seen := map[string]bool{}
	for _, name := range names {
		body, err := packFiles.ReadFile(name)
		if err != nil {
			panic(err)
		}
		entries := []*packEntry{}
		if err := json.Unmarshal(body, &entries); err != nil {
			panic(name + ": " + err.Error())
		}
		for _, e := range entries {
			if seen[e.ID] {
				panic(name + ": duplicate entry " + e.ID)
			}
			seen[e.ID] = true
			for _, p := range e.Patterns {
				e.res = append(e.res, regexp.MustCompile(p))
			}
			if e.Check != "" {
				e.valid = checks[e.Check]
				if e.valid == nil {
					panic(name + ": " + e.ID + ": unknown check " + e.Check)
				}
			}
			if len(e.Context) > 0 && e.Before == 0 && e.After == 0 {
				e.Before, e.After = defaultBefore, defaultAfter
			}
			if len(e.Context) > 0 {
				e.words = newWordSet(e.Context)
			}
			out = append(out, e)
		}
	}
	return out
})

func asciiLower(s string) string {
	b := []byte(s)
	for i := 0; i < len(b); {
		c := b[i]
		if c < utf8.RuneSelf {
			switch {
			case c >= 'A' && c <= 'Z':
				b[i] = c + 'a' - 'A'
			case c == '_' || c == '-':
				b[i] = ' '
			}
			i++
			continue
		}
		r, n := utf8.DecodeRune(b[i:])
		if l := unicode.ToLower(r); l != r && utf8.RuneLen(l) == n {
			utf8.EncodeRune(b[i:], l)
		}
		i += n
	}
	return string(b)
}

func sqlColumnHas(lower string, a int, words *wordSet, exact bool) bool {
	values := strings.LastIndex(lower[:a], "values")
	if values < 0 || a-values > 4000 {
		return false
	}
	open := strings.IndexByte(lower[values:a], '(')
	if open < 0 {
		return false
	}
	column := strings.Count(lower[values+open:a], ",")
	closing := strings.LastIndexByte(lower[:values], ')')
	if closing < 0 {
		return false
	}
	start := strings.LastIndexByte(lower[:closing], '(')
	if start < 0 {
		return false
	}
	names := strings.Split(lower[start+1:closing], ",")
	if column >= len(names) {
		return false
	}
	name := names[column]
	if exact {
		return wholeCell(name, words)
	}
	return hasWord(name, 0, len(name), words)
}

func columnHeaderHas(s, lower string, a int, words *wordSet, exact bool) bool {
	start := strings.LastIndexByte(s[:a], '\n') + 1
	end := strings.IndexByte(s[a:], '\n')
	if end < 0 {
		end = len(s)
	} else {
		end += a
	}
	line := s[start:end]
	delim := byte(0)
	for _, c := range []byte{'|', '\t', ';', ','} {
		if strings.IndexByte(line, c) >= 0 {
			delim = c
			break
		}
	}
	if delim == 0 || start == 0 {
		return false
	}
	column := strings.Count(s[start:a], string(delim))
	cells := strings.Count(line, string(delim))
	top := -1
	lineEnd := start - 1
	for steps := 0; lineEnd >= 0 && steps < 500; steps++ {
		lineStart := strings.LastIndexByte(s[:lineEnd], '\n') + 1
		if strings.Count(s[lineStart:lineEnd], string(delim)) != cells {
			break
		}
		top = lineStart
		if lineStart == 0 {
			break
		}
		lineEnd = lineStart - 1
	}
	if top < 0 {
		return false
	}
	headerEnd := top + strings.IndexByte(s[top:], '\n')
	at := top
	for i := 0; i < column; i++ {
		next := strings.IndexByte(s[at:headerEnd], delim)
		if next < 0 {
			return false
		}
		at += next + 1
	}
	cellEnd := strings.IndexByte(s[at:headerEnd], delim)
	if cellEnd < 0 {
		cellEnd = headerEnd
	} else {
		cellEnd += at
	}
	if exact {
		return wholeCell(lower[at:cellEnd], words)
	}
	return hasWord(lower, at, cellEnd, words)
}

func wordByte(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c >= 0x80
}

type wordSet struct {
	first   map[string][]string
	other   []string
	longest int
}

func wordPrefix(s string) int {
	i := 0
	for i < len(s) && wordByte(s[i]) {
		i++
	}
	return i
}

func newWordSet(words []string) *wordSet {
	set := &wordSet{first: map[string][]string{}}
	for _, raw := range words {
		w := asciiLower(raw)
		if w == "" {
			continue
		}
		set.longest = max(set.longest, len(w))
		r, _ := utf8.DecodeRuneInString(w)
		head := w[:wordPrefix(w)]
		if head == "" || r >= 0x0E00 {
			set.other = append(set.other, w)
			continue
		}
		set.first[head] = append(set.first[head], w)
	}
	return set
}

func (set *wordSet) find(lower string, from, to int, accept func(start, end int) bool) bool {
	from = max(from, 0)
	to = min(to, len(lower))
	for i := from; i < to; {
		if !wordByte(lower[i]) {
			i++
			continue
		}
		if i > 0 && wordByte(lower[i-1]) {
			i++
			continue
		}
		n := wordPrefix(lower[i:to])
		for _, w := range set.first[lower[i:i+n]] {
			end := i + len(w)
			if end <= to && lower[i:end] == w && (end >= len(lower) || !wordByte(lower[end])) && (accept == nil || accept(i, end)) {
				return true
			}
		}
		i += max(n, 1)
	}
	if len(set.other) == 0 || from >= to {
		return false
	}
	window := lower[from:to]
	for _, w := range set.other {
		at := 0
		for at <= len(window)-len(w) {
			k := strings.Index(window[at:], w)
			if k < 0 {
				break
			}
			if accept == nil || accept(from+at+k, from+at+k+len(w)) {
				return true
			}
			at += k + 1
		}
	}
	return false
}

func hasWord(lower string, from, to int, words *wordSet) bool {
	return words.find(lower, from, to, nil)
}

var markupRun = regexp.MustCompile(`</?[a-z][^<>]*`)
var clockTime = regexp.MustCompile(`[0-9]{1,2}:[0-9]{2}`)

func labelGap(gap string) string {
	if strings.IndexByte(gap, '<') >= 0 {
		gap = markupRun.ReplaceAllString(gap, "")
	}
	if strings.ContainsAny(gap, "0123456789") {
		gap = clockTime.ReplaceAllString(gap, "")
	}
	return gap
}

func cleanGap(gap string, limit int) bool {
	turn := strings.IndexByte(gap, '\n') >= 0 && (clockTime.MatchString(gap) || strings.IndexByte(gap, '?') >= 0)
	if turn {
		limit += 40
	}
	gap = labelGap(gap)
	if len(gap) > limit || strings.ContainsAny(gap, "0123456789") {
		return false
	}
	if turn {
		gap = gap[strings.LastIndexByte(gap, '\n')+1:]
	}
	return !hasWord(gap, 0, len(gap), workNumbers)
}

func reach(lower string, a, before int) int {
	near := lower[max(a-120, 0):a]
	if strings.IndexByte(near, '<') >= 0 || strings.IndexByte(near, '\n') >= 0 && (clockTime.MatchString(near) || strings.IndexByte(near, '?') >= 0) {
		return before + 80
	}
	return before + 12
}

func anchoredWord(lower string, a, before int, words *wordSet) bool {
	return words.find(lower, a-reach(lower, a, before)-words.longest, a, func(_, end int) bool {
		return cleanGap(lower[end:a], before) && !tableHeader(lower, end, a)
	})
}

func aloneOnLine(lower string, a, b int) bool {
	start := strings.LastIndexByte(lower[:a], '\n') + 1
	if start == 0 || a-start > 24 || strings.ContainsAny(lower[start:a], "0123456789,;|\t") {
		return false
	}
	end := strings.IndexByte(lower[b:], '\n')
	if end < 0 {
		end = len(lower) - b
	}
	return end <= 3 && !strings.ContainsAny(lower[b:b+end], ",;|\t")
}

func tableHeader(lower string, end, a int) bool {
	if strings.IndexByte(lower[end:a], '\n') < 0 {
		return false
	}
	start := strings.LastIndexByte(lower[:end], '\n') + 1
	stop := end + strings.IndexByte(lower[end:], '\n')
	return strings.ContainsAny(lower[start:stop], ",\t;|")
}

func upperAnchored(s, lower string, a, before int, words *wordSet) bool {
	return words.find(lower, a-reach(lower, a, before)-words.longest, a, func(start, end int) bool {
		return s[start:end] == strings.ToUpper(s[start:end]) && cleanGap(lower[end:a], before)
	})
}

func followedWord(lower string, b, after int, words *wordSet) bool {
	return words.find(lower, b, b+after+words.longest, func(start, _ int) bool {
		return start-b <= after && !strings.ContainsAny(lower[b:start], "0123456789") && !hasWord(lower, b, start, workNumbers)
	})
}

func followedUpper(s, lower string, b, after int, words *wordSet) bool {
	return words.find(lower, b, b+after+words.longest, func(start, end int) bool {
		return start-b <= after && s[start:end] == strings.ToUpper(s[start:end]) && !strings.ContainsAny(lower[b:start], "0123456789") && !hasWord(lower, b, start, workNumbers)
	})
}

func keyedWord(lower string, a, before int, words *wordSet) bool {
	return words.find(lower, a-before-words.longest, a, func(_, end int) bool {
		return a-end <= before && strings.ContainsAny(lower[end:a], ":=>") && !strings.ContainsAny(lower[end:a], "0123456789")
	})
}

func tokens(lower string) map[string]struct{} {
	out := map[string]struct{}{}
	for i := 0; i < len(lower); {
		if !wordByte(lower[i]) {
			i++
			continue
		}
		n := wordPrefix(lower[i:])
		out[lower[i:i+n]] = struct{}{}
		i += n
	}
	return out
}

func (set *wordSet) mayOccur(lower string, present map[string]struct{}) bool {
	if len(set.first) < len(present) {
		for head := range set.first {
			if _, ok := present[head]; ok {
				return true
			}
		}
	} else {
		for head := range present {
			if _, ok := set.first[head]; ok {
				return true
			}
		}
	}
	for _, w := range set.other {
		if strings.Contains(lower, w) {
			return true
		}
	}
	return false
}

var personName = regexp.MustCompile(`(\p{Lu}\p{Ll}+)[ ]+(?:\p{Ll}{1,3}[ ]+)?\p{Lu}\p{Ll}+`)

var notNames = map[string]bool{"the": true, "our": true, "new": true, "please": true, "hello": true, "dear": true, "thanks": true, "this": true, "that": true, "these": true, "from": true, "with": true, "for": true, "and": true, "code": true, "note": true, "ticket": true, "order": true, "invoice": true, "customer": true, "total": true, "status": true, "start": true, "end": true, "last": true, "first": true, "next": true, "user": true, "name": true}

var orgSuffix = regexp.MustCompile(`\b(?:Ltd|Limited|Pty|Inc|LLC|GmbH|Group|Solutions|Advisory|Ventures|Corp|Holdings|Bank|University)\b`)

func hasPersonName(s string) bool {
	for _, m := range personName.FindAllStringSubmatch(s, 8) {
		if notNames[strings.ToLower(m[1])] || orgSuffix.MatchString(s) {
			continue
		}
		return true
	}
	return false
}

func epochLike(value string) bool {
	return (len(value) == 10 || len(value) == 13) && value[0] == '1' && value[1] >= '4' && value[1] <= '9' && len(digits(value)) == len(value)
}

func groupedNeighbour(s string, a, b int) bool {
	if a >= 2 && (s[a-1] == ' ' || s[a-1] == '-') && (digit(s[a-2]) || s[a-2] >= 'A' && s[a-2] <= 'Z') {
		return true
	}
	return b+1 < len(s) && (s[b] == ' ' || s[b] == '-') && (digit(s[b+1]) || s[b+1] >= 'A' && s[b+1] <= 'Z')
}

var workNumbers = newWordSet([]string{"order", "orders", "invoice", "ticket", "tracking", "parcel", "shipment", "batch", "lot", "sku", "serial", "asset", "barcode", "pallet", "job", "build", "pipeline", "deal", "contract", "quote", "purchase", "case", "issue", "project", "request", "trace", "span", "commit", "version", "room", "budget", "stock", "total", "amount", "bestellung", "rechnung", "vorgang", "auftrag", "pedido", "factura", "caso", "commande", "facture", "dossier", "bestelling", "factuur", "zaak", "ordine", "fattura", "pratica", "tilaus", "lasku", "asia", "zamówienie", "faktura", "sprawa", "fatura", "sipariş", "beställning", "ärende", "created", "updated", "timestamp", "ts", "time", "catalog", "catalogue", "skus", "supplier", "product", "claim", "repair", "cheque", "form", "change", "revision", "module", "booking"})

func personRow(s, lower string, a, b int) bool {
	if a > 0 && wordByte(s[a-1]) || b < len(s) && wordByte(s[b]) {
		return false
	}
	if epochLike(s[a:b]) || groupedNeighbour(s, a, b) || hasWord(lower, a-32, a, workNumbers) || columnHeaderHas(s, lower, a, workNumbers, false) || sqlColumnHas(lower, a, workNumbers, false) {
		return false
	}
	start := strings.LastIndexByte(s[:a], '\n') + 1
	for range 3 {
		if start < 2 {
			start = 0
			break
		}
		start = strings.LastIndexByte(s[:start-1], '\n') + 1
	}
	end := strings.IndexByte(s[b:], '\n')
	if end < 0 {
		end = len(s)
	} else {
		end += b
	}
	return hasPersonName(s[start:a]) || hasPersonName(s[b:end])
}

func masked(s string, a, b int) bool {
	run := 0
	for run < a && s[a-1-run] == '*' {
		run++
	}
	if run == 0 {
		return false
	}
	return run != 2 || !strings.HasPrefix(s[b:], "**")
}

func packBounded(e *packEntry, s string, a, b int) bool {
	if strings.Contains(s[a:b], "*") || masked(s, a, b) {
		return false
	}
	left, right := "", ""
	switch e.Bounds {
	case "number":
		left, right = ".-/", "-/"
	case "token":
		left, right = ".-/ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", "-/ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
	default:
		left, right = "", ""
	}
	if e.Bounds != "" {
		if a > 0 && (digit(s[a-1]) || strings.IndexByte(left, s[a-1]) >= 0) {
			return false
		}
		if b < len(s) && (digit(s[b]) || strings.IndexByte(right, s[b]) >= 0) {
			return false
		}
	}
	return !e.NoDecimal || b+1 >= len(s) || s[b] != '.' || !digit(s[b+1])
}

func wholeCell(cell string, words *wordSet) bool {
	cell = strings.TrimSpace(cell)
	return words.find(cell, 0, len(cell), func(start, end int) bool { return start == 0 && end == len(cell) })
}

func packMatches(e *packEntry, s, lower, label string, present map[string]struct{}, collapsed bool) []string {
	contextual := e.words != nil
	exact := e.UpperGap > 0 || e.CellOnly
	labelled := contextual && label != "" && (!exact && hasWord(label, 0, len(label), e.words) || exact && wholeCell(label, e.words))
	if contextual && (collapsed || !e.PersonRow && !e.ShapedRow) && !labelled && !e.words.mayOccur(lower, present) {
		return nil
	}
	found := []string{}
	for _, re := range e.res {
		for _, m := range re.FindAllStringIndex(s, -1) {
			a, b := m[0], m[1]
			if !packBounded(e, s, a, b) {
				continue
			}
			value := s[a:b]
			if e.valid != nil && !e.valid(value) {
				continue
			}
			if contextual && !labelled && !columnHeaderHas(s, lower, a, e.words, exact) && !sqlColumnHas(lower, a, e.words, exact) {
				if strongCheck(e) && hasWord(lower, a-documentReach, b+documentReach, e.words) {
					found = append(found, value)
					continue
				}
				if e.CellOnly {
					continue
				}
				if e.UpperGap > 0 {
					if upperAnchored(s, lower, a, e.UpperGap, e.words) || e.After > 0 && followedUpper(s, lower, b, e.After, e.words) || !e.UpperOnly && keyedWord(lower, a, e.Before, e.words) {
						found = append(found, value)
					}
					continue
				}
				if e.Anchored && e.After > 0 && followedWord(lower, b, e.After, e.words) {
					found = append(found, value)
					continue
				}
				if e.Anchored && e.After > 0 && aloneOnLine(lower, a, b) && !hasWord(lower, a-300, a, workNumbers) && hasWord(lower, a-300, a, e.words) {
					found = append(found, value)
					continue
				}
				if e.Anchored && !anchoredWord(lower, a, e.Before, e.words) || !e.Anchored && (!hasWord(lower, a-e.Before, b+e.After, e.words) || !strongCheck(e) && hasWord(lower, a-32, a, workNumbers)) {
					rowEntry := e.PersonRow || e.ShapedRow && len(digits(value)) != len(value)
					if collapsed || !rowEntry || !personRow(s, lower, a, b) {
						continue
					}
				}
			}
			found = append(found, value)
		}
	}
	return found
}

var blankRun = regexp.MustCompile(`_{2,}`)

const documentReach = 2000

var genericKeys = map[string]bool{"value": true, "number": true, "val": true, "data": true, "id": true}

var columnKeys = map[string]bool{"columns": true, "cols": true, "headers": true, "header": true, "fields": true}

var rowKeys = map[string]bool{"rows": true, "records": true, "data": true, "values": true, "items": true}

func tableColumns(p Prepared) string {
	names := []string{}
	for i, s := range p.Strict {
		if columnKeys[asciiLower(viewLabel(p.StrictLabels, i))] {
			names = append(names, s)
		}
	}
	joined := asciiLower(strings.Join(names, " | "))
	if hasWord(joined, 0, len(joined), workNumbers) {
		return ""
	}
	return joined
}

func strongCheck(e *packEntry) bool {
	return e.valid != nil && e.words != nil && e.Check != "id-shape" && e.Check != "w-not-repeats" && e.Check != "w-has-letter" && !strings.HasPrefix(e.Check, "digits")
}

func identifiers(d policy.Detector, p Prepared) *engine.Match {
	details := []string{}
	examples := []string{}
	count := 0
	scan := func(s, label string, strongOnly bool) {
		if strings.Contains(s, "__") {
			s = blankRun.ReplaceAllStringFunc(s, func(run string) string { return strings.Repeat(" ", len(run)) })
		}
		lower := asciiLower(s)
		present := tokens(lower)
		for _, e := range loadPack() {
			if len(d.Rules) > 0 && !slices.Contains(d.Rules, e.ID) && !slices.Contains(d.Rules, e.Country) {
				continue
			}
			if strongOnly && !strongCheck(e) {
				continue
			}
			found := packMatches(e, s, lower, label, present, strongOnly)
			if len(found) == 0 {
				continue
			}
			count += len(found)
			if !slices.Contains(details, e.ID) {
				details = append(details, e.ID)
			}
			if len(examples) < 3 {
				examples = append(examples, e.Label+" ("+redact(found[0])+")")
			}
		}
	}
	columns := tableColumns(p)
	for i, s := range p.Strict {
		label := asciiLower(viewLabel(p.StrictLabels, i))
		if rowKeys[label] && columns != "" {
			label = columns
		} else if genericKeys[label] {
			near := []string{}
			for k := max(i-3, 0); k <= min(i+3, len(p.Strict)-1); k++ {
				if k != i && len(p.Strict[k]) <= 60 {
					near = append(near, p.Strict[k])
				}
			}
			label = asciiLower(strings.Join(near, " | "))
		}
		scan(s, label, false)
	}
	for i, s := range p.Context {
		if i < len(p.ContextKinds) && p.ContextKinds[i] == "collapsed" {
			scan(s, asciiLower(viewLabel(p.ContextLabels, i)), true)
		}
	}
	if count == 0 {
		return nil
	}
	return &engine.Match{Kind: "identifiers", Count: count, Examples: examples, Details: details}
}
