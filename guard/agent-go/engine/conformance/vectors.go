// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package conformance

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/vibtra/guard/guard/agent-go/engine"
	"github.com/vibtra/guard/guard/agent-go/policy"
)

type Decoder func(contentType string, body []byte) engine.Content

type Vectors struct {
	sets []vectorSet
}

type vectorSet struct {
	name  string
	cases []vectorCase
}

type vectorCase struct {
	name string
	req  engine.Request
	want func(engine.Decision) string
}

const vectorPath = "packages/guard-contract/src"

const parityRule = "gcr_00000000000000c1"

func LoadVectors(dir string, decode Decoder) (Vectors, error) {
	if dir == "" {
		found, err := findVectorDir()
		if err != nil {
			return Vectors{}, err
		}
		dir = found
	}
	raw, err := os.ReadFile(filepath.Join(dir, "detectors.vectors.json"))
	if err != nil {
		return Vectors{}, err
	}
	var d detectorVectors
	if err := json.Unmarshal([]byte(strings.ReplaceAll(string(raw), "~~", "")), &d); err != nil {
		return Vectors{}, fmt.Errorf("detectors.vectors.json: %w", err)
	}
	raw, err = os.ReadFile(filepath.Join(dir, "body.vectors.json"))
	if err != nil {
		return Vectors{}, err
	}
	var body []bodyVector
	if err := json.Unmarshal(raw, &body); err != nil {
		return Vectors{}, fmt.Errorf("body.vectors.json: %w", err)
	}
	l := loader{decode}
	contextSet, err := l.context(d)
	if err != nil {
		return Vectors{}, err
	}
	return Vectors{sets: []vectorSet{l.identifiers(d), contextSet, l.views(d), l.secrets(d), l.bulk(d), l.body(body), compiled()}}, nil
}

func findVectorDir() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		candidate := filepath.Join(dir, vectorPath)
		if _, err := os.Stat(filepath.Join(candidate, "detectors.vectors.json")); err == nil {
			return candidate, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", errors.New("no " + vectorPath + "/detectors.vectors.json above the working directory; run from the repository or pass --vectors DIR")
		}
		dir = parent
	}
}

type groups struct {
	Valid   []string `json:"valid"`
	Invalid []string `json:"invalid"`
}

type viewVector struct {
	Detector policy.Detector `json:"detector"`
	Text     string          `json:"text"`
	Joined   []string        `json:"joined"`
	Count    int             `json:"count"`
}

type detectorVectors struct {
	TFN      groups                     `json:"tfn"`
	ABN      groups                     `json:"abn"`
	ACN      groups                     `json:"acn"`
	Medicare groups                     `json:"medicare"`
	Card     groups                     `json:"card"`
	Context  map[string]json.RawMessage `json:"context"`
	Views    struct {
		Fire  []viewVector `json:"fire"`
		Quiet []viewVector `json:"quiet"`
	} `json:"views"`
	Secrets struct {
		Fire []struct {
			Rule string `json:"rule"`
			Text string `json:"text"`
		} `json:"fire"`
		Quiet []string `json:"quiet"`
		Cap   struct {
			Text    string   `json:"text"`
			Count   int      `json:"count"`
			Details []string `json:"details"`
		} `json:"cap"`
	} `json:"secrets"`
	EmailBulk struct {
		Threshold int    `json:"threshold"`
		Fire      string `json:"fire"`
		Quiet     string `json:"quiet"`
	} `json:"emailBulk"`
	Keyword struct {
		Keywords  []string `json:"keywords"`
		Fire      string   `json:"fire"`
		FireCount int      `json:"fireCount"`
		Quiet     string   `json:"quiet"`
		WholeWord struct {
			Fire  string `json:"fire"`
			Quiet string `json:"quiet"`
		} `json:"wholeWord"`
	} `json:"keyword"`
	FileType struct {
		Extensions []string `json:"extensions"`
		Fire       []string `json:"fire"`
		FireCount  int      `json:"fireCount"`
		Quiet      []string `json:"quiet"`
	} `json:"fileType"`
}

type bodyVector struct {
	Name        string          `json:"name"`
	ContentType string          `json:"contentType"`
	Body        string          `json:"body"`
	Detector    policy.Detector `json:"detector"`
	Count       int             `json:"count"`
}

type loader struct {
	decode Decoder
}

var looksJSON = regexp.MustCompile(`^\s*[\[{]`)

func (l loader) text(text string) engine.Content {
	if looksJSON.MatchString(text) {
		body, _ := json.Marshal(map[string]string{"text": text})
		return l.decode("application/json", body)
	}
	return l.decode("text/plain", []byte(text))
}

func (l loader) files(names []string) engine.Content {
	c := l.decode("text/plain", nil)
	c.Filenames = append(c.Filenames, names...)
	return c
}

func parityRequest(d policy.Detector, c engine.Content) engine.Request {
	b := bundle("enforce")
	b.Services = map[string]policy.ServiceDecision{}
	b.ContentRules = []policy.ContentRule{contentRule(parityRule, d, `"*"`, "block")}
	return request(b, "chatgpt.com", engine.Request{Content: c})
}

func (l loader) identifiers(d detectorVectors) vectorSet {
	s := vectorSet{name: "identifiers"}
	for _, g := range []struct {
		name, kind string
		groups     groups
	}{{"tfn", "au-tfn", d.TFN}, {"abn", "au-abn", d.ABN}, {"acn", "au-acn", d.ACN}, {"medicare", "au-medicare", d.Medicare}, {"card", "card-number", d.Card}} {
		for valid, values := range map[bool][]string{true: g.groups.Valid, false: g.groups.Invalid} {
			for i, v := range values {
				s.cases = append(s.cases, vectorCase{fmt.Sprintf("%s/%s/%d", g.name, validity(valid), i), parityRequest(policy.Detector{Kind: g.kind}, l.text("here it is: "+v+".")), wantFires(valid)})
			}
		}
	}
	slices.SortFunc(s.cases, func(a, b vectorCase) int { return strings.Compare(a.name, b.name) })
	return s
}

func validity(valid bool) string {
	if valid {
		return "valid"
	}
	return "invalid"
}

func (l loader) context(d detectorVectors) (vectorSet, error) {
	s := vectorSet{name: "context"}
	for _, k := range []struct{ name, kind string }{{"acn", "au-acn"}, {"medicare", "au-medicare"}, {"tfn", "au-tfn"}} {
		raw, ok := d.Context[k.name]
		if !ok {
			continue
		}
		var byGroup map[string][]string
		if err := json.Unmarshal(raw, &byGroup); err != nil {
			return s, fmt.Errorf("detectors.vectors.json context.%s: %w", k.name, err)
		}
		names := make([]string, 0, len(byGroup))
		for g := range byGroup {
			names = append(names, g)
		}
		slices.Sort(names)
		for _, g := range names {
			for i, text := range byGroup[g] {
				s.cases = append(s.cases, vectorCase{fmt.Sprintf("%s/%s/%d", k.name, g, i), parityRequest(policy.Detector{Kind: k.kind, RequireContext: true}, l.text(text)), wantFires(g == "fire")})
			}
		}
	}
	return s, nil
}

func (l loader) views(d detectorVectors) vectorSet {
	s := vectorSet{name: "views"}
	for _, g := range []struct {
		name    string
		vectors []viewVector
	}{{"fire", d.Views.Fire}, {"quiet", d.Views.Quiet}} {
		for i, v := range g.vectors {
			c := l.text(v.Text)
			if len(v.Joined) > 0 {
				fragments := []string{}
				for _, line := range strings.Split(v.Text, "\n") {
					if line != "" && line != "text" {
						fragments = append(fragments, line)
					}
				}
				body, _ := json.Marshal(map[string]any{"messages": []any{map[string]any{"content": fragments}}})
				c = l.decode("application/json", body)
			}
			s.cases = append(s.cases, vectorCase{fmt.Sprintf("%s/%d", g.name, i), parityRequest(v.Detector, c), wantCount(v.Count)})
		}
	}
	return s
}

func (l loader) secrets(d detectorVectors) vectorSet {
	s := vectorSet{name: "secrets"}
	secret := policy.Detector{Kind: "secret"}
	for i, v := range d.Secrets.Fire {
		s.cases = append(s.cases, vectorCase{fmt.Sprintf("fire/%d", i), parityRequest(secret, l.text(v.Text)), wantDetails(v.Rule)})
	}
	for i, text := range d.Secrets.Quiet {
		s.cases = append(s.cases, vectorCase{fmt.Sprintf("quiet/%d", i), parityRequest(secret, l.text(text)), wantCount(0)})
	}
	capped := d.Secrets.Cap
	s.cases = append(s.cases, vectorCase{"cap", parityRequest(secret, l.text(capped.Text)), func(dec engine.Decision) string {
		if problem := wantCount(capped.Count)(dec); problem != "" {
			return problem
		}
		if m := matched(dec); !slices.Equal(m.Details, capped.Details) {
			return fmt.Sprintf("details %v, want %v", m.Details, capped.Details)
		}
		return ""
	}})
	return s
}

func (l loader) bulk(d detectorVectors) vectorSet {
	s := vectorSet{name: "bulk"}
	email := policy.Detector{Kind: "email-bulk", Threshold: d.EmailBulk.Threshold}
	substring := policy.Detector{Kind: "keyword", Keywords: d.Keyword.Keywords}
	whole := policy.Detector{Kind: "keyword", Keywords: d.Keyword.Keywords, WholeWord: true}
	files := policy.Detector{Kind: "file-type", Extensions: d.FileType.Extensions}
	quietFiles := slices.DeleteFunc(slices.Clone(d.FileType.Quiet), func(name string) bool { return name == ".xlsx" })
	s.cases = []vectorCase{
		{"email/fire", parityRequest(email, l.text(d.EmailBulk.Fire)), wantCount(3)},
		{"email/quiet", parityRequest(email, l.text(d.EmailBulk.Quiet)), wantCount(0)},
		{"keyword/fire", parityRequest(substring, l.text(d.Keyword.Fire)), wantCount(d.Keyword.FireCount)},
		{"keyword/quiet", parityRequest(substring, l.text(d.Keyword.Quiet)), wantCount(0)},
		{"keyword/whole-word/fire", parityRequest(whole, l.text(d.Keyword.WholeWord.Fire)), wantCount(1)},
		{"keyword/whole-word/quiet", parityRequest(whole, l.text(d.Keyword.WholeWord.Quiet)), wantCount(0)},
		{"file-type/fire", parityRequest(files, l.files(d.FileType.Fire)), wantCount(d.FileType.FireCount)},
		{"file-type/quiet", parityRequest(files, l.files(quietFiles)), wantCount(0)},
	}
	return s
}

func (l loader) body(vectors []bodyVector) vectorSet {
	s := vectorSet{name: "body"}
	for i, v := range vectors {
		s.cases = append(s.cases, vectorCase{fmt.Sprintf("%d %s", i, v.Name), parityRequest(v.Detector, l.decode(v.ContentType, []byte(v.Body))), wantCount(v.Count)})
	}
	return s
}

func matched(d engine.Decision) *engine.Match {
	if d.Content == nil {
		return nil
	}
	for _, m := range d.Content.Matches {
		if m.Rule.RuleID == parityRule {
			return &m.Match
		}
	}
	return nil
}

func wantCount(n int) func(engine.Decision) string {
	return func(d engine.Decision) string {
		got := 0
		if m := matched(d); m != nil {
			got = m.Count
		}
		verdict := "allowed"
		if n > 0 {
			verdict = "blocked"
		}
		if got != n || d.Verdict != verdict {
			return fmt.Sprintf("matched %d times with verdict %s, want %d and %s", got, d.Verdict, n, verdict)
		}
		return ""
	}
}

func wantFires(fire bool) func(engine.Decision) string {
	return func(d engine.Decision) string {
		got := matched(d) != nil && d.Verdict == "blocked"
		if got != fire {
			return fmt.Sprintf("fired %t with verdict %s, want %t", matched(d) != nil, d.Verdict, fire)
		}
		return ""
	}
}

func wantDetails(rule string) func(engine.Decision) string {
	return func(d engine.Decision) string {
		m := matched(d)
		if m == nil || !slices.Contains(m.Details, rule) || d.Verdict != "blocked" {
			return fmt.Sprintf("secret rule %s did not fire (verdict %s)", rule, d.Verdict)
		}
		return ""
	}
}

func parity(e engine.Engine, s vectorSet) Result {
	res := Result{Check: "parity/" + s.name, Cases: len(s.cases)}
	for _, c := range s.cases {
		d, err := decide(e, c.req)
		if err != nil {
			res.Failures = append(res.Failures, Failure{c.name, err.Error()})
			continue
		}
		if err := engine.Validate(d); err != nil {
			res.Failures = append(res.Failures, Failure{c.name, err.Error()})
			continue
		}
		if problem := c.want(d); problem != "" {
			res.Failures = append(res.Failures, Failure{c.name, problem})
		}
	}
	return res
}
