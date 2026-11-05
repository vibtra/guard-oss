// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package detect

import (
	"fmt"
	"net/url"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/vibtra/guard/guard/agent-go/engine"
	"github.com/vibtra/guard/guard/agent-go/policy"
)

var digitsRE = regexp.MustCompile(`[^0-9]`)

func digits(s string) string { return digitsRE.ReplaceAllString(s, "") }
func sumWeights(s string, weights []int) int {
	n := 0
	for i, w := range weights {
		n += int(s[i]-'0') * w
	}
	return n
}
func validTFN(s string) bool {
	return len(s) == 9 && sumWeights(s, []int{1, 4, 3, 7, 5, 8, 6, 9, 10})%11 == 0
}
func validACN(s string) bool {
	return len(s) == 9 && (10-sumWeights(s, []int{8, 7, 6, 5, 4, 3, 2, 1})%10)%10 == int(s[8]-'0')
}
func validABN(s string) bool {
	return len(s) == 11 && (sumWeights(s, []int{10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19})-10)%89 == 0
}
func validMedicare(s string) bool {
	return (len(s) == 10 || len(s) == 11) && s[0] >= '2' && s[0] <= '6' && sumWeights(s, []int{1, 3, 7, 9, 1, 3, 7, 9})%10 == int(s[8]-'0')
}
func luhn(s string) bool {
	if len(s) < 13 || len(s) > 19 {
		return false
	}
	n := 0
	for i, c := range []byte(s) {
		v := int(c - '0')
		if (len(s)-i)%2 == 0 {
			v *= 2
			if v > 9 {
				v -= 9
			}
		}
		n += v
	}
	return n%10 == 0
}
func validCard(s string) bool {
	if !luhn(s) {
		return false
	}
	n := len(s)
	p2, _ := strconv.Atoi(s[:2])
	p3, _ := strconv.Atoi(s[:3])
	p4, _ := strconv.Atoi(s[:4])
	return s[0] == '4' && (n == 13 || n == 16 || n == 19) || (p2 >= 51 && p2 <= 55 || p4 >= 2221 && p4 <= 2720) && n == 16 || (slices.Contains([]string{"5018", "5020", "5038", "5893", "6304", "6759", "6761", "6762", "6763"}, s[:4])) && n >= 12 && n <= 19 || p4 >= 2200 && p4 <= 2204 && n >= 16 && n <= 19 || (p2 == 34 || p2 == 37) && n == 15 || p4 >= 3528 && p4 <= 3589 && n >= 16 && n <= 19 || (p3 >= 300 && p3 <= 305 || p2 == 36 || p2 == 38 || p2 == 39) && n >= 14 && n <= 19 || (p4 == 6011 || p3 >= 644 && p3 <= 649 || p2 == 65 || p2 == 62) && n >= 16 && n <= 19
}

var numberRE = map[string]*regexp.Regexp{
	"au-tfn":      regexp.MustCompile(`[0-9]{3}[ -]?[0-9]{3}[ -]?[0-9]{3}`),
	"au-acn":      regexp.MustCompile(`[0-9]{3}[ -]?[0-9]{3}[ -]?[0-9]{3}`),
	"au-abn":      regexp.MustCompile(`[0-9]{2}[ -]?[0-9]{3}[ -]?[0-9]{3}[ -]?[0-9]{3}`),
	"au-medicare": regexp.MustCompile(`[2-6][0-9]{3}[ -]?[0-9]{5}[ -]?[0-9](?:[ -]?[0-9])?`),
	"card-number": regexp.MustCompile(`(?:[0-9][ -]?){12,18}[0-9]`),
}
var contexts = map[string]*regexp.Regexp{
	"au-tfn":      regexp.MustCompile(`(?i)(?:\b|_)(?:tfn|tax[\s_-]*file)`),
	"au-acn":      regexp.MustCompile(`(?i)(?:\b|_)(?:acn|company[\s_-]*number)`),
	"au-abn":      regexp.MustCompile(`(?i)(?:\b|_)(?:abn|business[\s_-]*number)`),
	"au-medicare": regexp.MustCompile(`(?i)(?:\b|_)medicare`),
	"card-number": regexp.MustCompile(`(?i)(?:\b|_)(?:credit|card|visa|master\s*card|cc|amex|american\s+express|discover|jcb|diners|maestro|unionpay)(?:\b|_)`),
}
var grouped9 = regexp.MustCompile(`^[0-9]{3} [0-9]{3} [0-9]{3}$`)
var groupedMed = regexp.MustCompile(`^[0-9]{4}[ -][0-9]{5}[ -][0-9](?:[ -][0-9])?$`)
var otherLabel = regexp.MustCompile(`(?i)(?:^|[^0-9a-z])(?:con[\s-]?note|consignment|waybill|air[\s-]?waybill|awb|sscc|pallet|parcel|shipment|tracking|imei|serial|s/n)(?:[\s_-]*(?:no\.?|number|num|id|code|#))?\s*[:#=.\-]?\s*$`)
var phoneRE = regexp.MustCompile(`(?:(?:(?:\+|00)61[ .\-]?|61[ .\-]?|0)4[0-9]{2}[ .\-]?[0-9]{3}[ .\-]?[0-9]{3}|(?:\(0[2378]\)[ .\-]?|0[2378][ .\-]?|(?:\+|00)61[ .\-]?\(?[2378]\)?[ .\-]?)[0-9]{4}[ .\-]?[0-9]{4}|1[38]00[ .\-]?[0-9]{3}[ .\-]?[0-9]{3})`)

func phoneSpans(s string) [][2]int {
	out := [][2]int{}
	for _, p := range phoneRE.FindAllStringIndex(s, -1) {
		if p[0] > 0 && (word(s[p[0]-1]) && s[p[0]-1] != '_' || s[p[0]-1] == '+') || p[1] < len(s) && digit(s[p[1]]) {
			continue
		}
		out = append(out, [2]int{p[0], p[1]})
	}
	return out
}
func near(s string, a, b int, re *regexp.Regexp) bool {
	before := []rune(s[:a])
	after := []rune(s[b:])
	if len(before) > 60 {
		before = before[len(before)-60:]
	}
	if len(after) > 60 {
		after = after[:60]
	}
	return re.MatchString(string(before)) || re.MatchString(string(after))
}
func redact(s string) string {
	s = strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) || r == '-' {
			return -1
		}
		return r
	}, s)
	r := []rune(s)
	if len(r) < 7 {
		return strings.Repeat("*", len(r))
	}
	return string(r[:3]) + strings.Repeat("*", len(r)-6) + string(r[len(r)-3:])
}

func groupedFragment(s string, a, b int) bool {
	if a > 1 && (s[a-1] == ' ' || s[a-1] == '-') && digit(s[a-2]) {
		n := 0
		for a-2-n >= 0 && digit(s[a-2-n]) {
			n++
		}
		if n < 3 {
			return true
		}
	}
	if b+1 < len(s) && (s[b] == ' ' || s[b] == '-') && digit(s[b+1]) {
		n := 0
		for b+1+n < len(s) && digit(s[b+1+n]) {
			n++
		}
		if n < 3 {
			return true
		}
	}
	return false
}

func numbers(d policy.Detector, p Prepared) *engine.Match {
	valid := map[string]func(string) bool{"au-tfn": validTFN, "au-acn": validACN, "au-abn": validABN, "au-medicare": validMedicare, "card-number": validCard}[d.Kind]
	seen := map[string]bool{}
	found := []string{}
	diagnostics := []engine.MatchDiagnostic{}
	views := append(append([]string{}, p.Strict...), p.Context...)
	for i, s := range views {
		strict := i < len(p.Strict)
		phones := phoneSpans(s)
		for _, m := range numberSpans(d.Kind, s) {
			a, b := m[0], m[1]
			if numericFragment(s, a, b) || d.Kind != "card-number" && groupedFragment(s, a, b) {
				continue
			}
			value := s[a:b]
			key := digits(value)
			if !valid(key) {
				continue
			}
			label := ""
			if strict {
				label = viewLabel(p.StrictLabels, i)
			} else {
				label = viewLabel(p.ContextLabels, i-len(p.Strict))
			}
			ctx := near(s, a, b, contexts[d.Kind]) || contexts[d.Kind].MatchString(label)
			if d.Kind == "card-number" && label == "dsn" && publicSentryDSN(s) {
				continue
			}
			if !strict && !ctx {
				continue
			}
			grouped := grouped9.MatchString(value)
			if d.Kind == "au-medicare" {
				grouped = groupedMed.MatchString(value)
			}
			if strict && d.RequireContext && !ctx && !grouped {
				continue
			}
			if strict && !ctx {
				overlap := false
				if d.Kind == "au-tfn" || d.Kind == "au-acn" || d.Kind == "au-medicare" {
					for _, ph := range phones {
						if ph[0] < b && a < ph[1] {
							overlap = true
						}
					}
				}
				if overlap {
					continue
				}
				if d.Kind == "card-number" {
					before := []rune(s[:a])
					if len(before) > 40 {
						before = before[len(before)-40:]
					}
					if otherLabel.MatchString(string(before)) || otherLabel.MatchString(label) {
						continue
					}
				}
			}
			if i >= max(1, p.PrimaryCount) && seen[key] {
				continue
			}
			seen[key] = true
			found = append(found, value)
			if len(diagnostics) < 3 {
				view := "primary"
				if !strict {
					view = viewLabel(p.ContextKinds, i-len(p.Strict))
				} else if i >= max(1, p.PrimaryCount) {
					view = "base64"
				}
				diagnostics = append(diagnostics, diagnosticMatch(d.Kind, "", view, label, s, a, b, near(s, a, b, contexts[d.Kind]), contexts[d.Kind].MatchString(label)))
			}
		}
	}
	if len(found) == 0 {
		return nil
	}
	examples := []string{}
	for _, f := range found {
		e := redact(f)
		if !slices.Contains(examples, e) {
			examples = append(examples, e)
		}
		if len(examples) == 3 {
			break
		}
	}
	return &engine.Match{Kind: d.Kind, Count: len(found), Examples: examples, Diagnostics: diagnostics}
}

var sentryPublicKey = regexp.MustCompile(`^[0-9a-fA-F]{32}$`)
var sentryProjectPath = regexp.MustCompile(`^/[0-9]+$`)
var sentryPublicURL = regexp.MustCompile(`(?i)^https://[0-9a-f]{32}@[a-z0-9.-]+\.sentry\.io/[0-9]+$`)

func publicSentryDSN(s string) bool {
	if !sentryPublicURL.MatchString(s) {
		return false
	}
	u, err := url.Parse(s)
	if err != nil || u.Scheme != "https" || u.User == nil || u.RawQuery != "" || u.Fragment != "" || u.Port() != "" {
		return false
	}
	_, password := u.User.Password()
	return !password && sentryPublicKey.MatchString(u.User.Username()) && strings.HasSuffix(strings.ToLower(u.Hostname()), ".sentry.io") && sentryProjectPath.MatchString(u.EscapedPath())
}

var emailRE = regexp.MustCompile(`(?i)\b[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}\b`)

func Known(kind string) bool {
	switch kind {
	case "secret", "email-bulk", "phone-bulk", "keyword", "file-type", "identifiers":
		return true
	}
	return numberRE[kind] != nil
}

func Detect(d policy.Detector, ex engine.Content, p Prepared) *engine.Match {
	if !Known(d.Kind) {
		return nil
	}
	if d.Kind == "identifiers" {
		return identifiers(d, p)
	}
	if numberRE[d.Kind] != nil {
		return numbers(d, p)
	}
	if d.Kind == "secret" {
		return secrets(d, p)
	}
	values := []string{}
	details := []string{}
	count := 0
	switch d.Kind {
	case "email-bulk", "phone-bulk":
		unique := map[string]bool{}
		for _, s := range p.Strict {
			if d.Kind == "email-bulk" {
				for _, v := range emailRE.FindAllString(unspell(s), -1) {
					unique[strings.ToLower(v)] = true
				}
			} else {
				for _, m := range phoneSpans(s) {
					v := digits(s[m[0]:m[1]])
					if strings.HasPrefix(v, "0061") {
						v = "0" + v[4:]
					} else if len(v) == 11 && strings.HasPrefix(v, "61") {
						v = "0" + v[2:]
					}
					unique[v] = true
				}
			}
		}
		threshold := d.Threshold
		if threshold <= 0 {
			threshold = 10
		}
		count = len(unique)
		if count < threshold {
			return nil
		}
		label := "addresses"
		if d.Kind == "phone-bulk" {
			label = "numbers"
		}
		values = []string{fmt.Sprintf("%d distinct %s", count, label)}

	case "keyword":
		texts := []string{ex.Text}
		if ex.Spans != nil {
			texts = nil
			for _, span := range ex.Spans {
				texts = append(texts, span.Text)
			}
		}
		lowers := make([]string, len(texts))
		for i, s := range texts {
			lowers[i] = strings.ToLower(s)
		}
		isWord := func(r rune) bool { return unicode.IsLetter(r) || unicode.IsNumber(r) || r == '_' }
		for _, k := range d.Keywords {
			needle := strings.ToLower(k)
			if needle == "" {
				continue
			}
			n := 0
			for _, lower := range lowers {
				from := 0
				for from < len(lower) {
					at := strings.Index(lower[from:], needle)
					if at < 0 {
						break
					}
					start := from + at
					end := start + len(needle)
					before, _ := utf8.DecodeLastRuneInString(lower[:start])
					after, _ := utf8.DecodeRuneInString(lower[end:])
					if !d.WholeWord || !isWord(before) && !isWord(after) {
						n++
						from = end
					} else {
						_, size := utf8.DecodeRuneInString(lower[start:])
						from = start + size
					}
				}
			}
			if n > 0 {
				count += n
				details = append(details, k)
				if len(values) < 3 {
					values = append(values, k)
				}
			}
		}

	case "file-type":
		for _, f := range ex.Filenames {
			e := strings.TrimPrefix(strings.ToLower(filepath.Ext(f)), ".")
			for _, want := range d.Extensions {
				if e == strings.TrimPrefix(strings.ToLower(want), ".") {
					count++
					if !slices.Contains(details, e) {
						details = append(details, e)
					}
					if len(values) < 3 {
						values = append(values, "."+e)
					}
					break
				}
			}
		}
	}
	if count == 0 {
		return nil
	}
	return &engine.Match{Kind: d.Kind, Count: count, Examples: values, Details: details}
}

var boundedNumbers = func() map[string]*regexp.Regexp {
	out := map[string]*regexp.Regexp{}
	for k, re := range numberRE {
		left := `[^A-Za-z0-9_+\-]`
		if k == "card-number" {
			left = `[^A-Za-z0-9_\-]`
		}
		out[k] = regexp.MustCompile(`(^|` + left + `)(` + re.String() + `)($|[^A-Za-z0-9_\-])`)
	}
	return out
}()

func numberSpans(kind, s string) [][2]int {
	out := [][2]int{}
	offset := 0
	for offset < len(s) {
		m := boundedNumbers[kind].FindStringSubmatchIndex(s[offset:])
		if m == nil {
			break
		}
		a, b := offset+m[4], offset+m[5]
		out = append(out, [2]int{a, b})
		offset = b
	}
	return out
}

var spelledAt = regexp.MustCompile(`(?i)[ \t]*[\[({][ \t]*at[ \t]*[\])}][ \t]*`)
var spelledDot = regexp.MustCompile(`(?i)[ \t]*[\[({][ \t]*dot[ \t]*[\])}][ \t]*`)

func unspell(s string) string {
	return spelledDot.ReplaceAllString(spelledAt.ReplaceAllString(s, "@"), ".")
}
