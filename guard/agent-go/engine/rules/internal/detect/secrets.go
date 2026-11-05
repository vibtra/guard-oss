// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package detect

import (
	_ "embed"
	"encoding/json"
	"math"
	"regexp"
	"slices"
	"strings"
	"unicode"

	"github.com/vibtra/guard/guard/agent-go/engine"
	"github.com/vibtra/guard/guard/agent-go/policy"
)

type secretPattern struct {
	id, expression, label string
	re                    *regexp.Regexp
	keywords              []string
	entropy               float64
	group                 int
	mixed                 bool
}

//go:embed secretpack/secrets.json
var secretPack []byte

type secretEntry struct {
	ID       string   `json:"id"`
	Label    string   `json:"label"`
	Patterns []string `json:"patterns"`
	Keywords []string `json:"keywords"`
	Entropy  float64  `json:"entropy"`
	Group    int      `json:"group"`
	Mixed    bool     `json:"mixed"`
}

func shannon(s string) float64 {
	counts := map[rune]float64{}
	n := 0.0
	for _, r := range s {
		counts[r]++
		n++
	}
	h := 0.0
	for _, c := range counts {
		p := c / n
		h -= p * math.Log2(p)
	}
	return h
}

func credentialShaped(s string) bool {
	lower, upper, number, other := false, false, false, false
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z':
			lower = true
		case r >= 'A' && r <= 'Z':
			upper = true
		case r >= '0' && r <= '9':
			number = true
		default:
			other = true
		}
	}
	return number && (lower || upper) || other && (lower || upper) && (upper && lower || number)
}

var secretPatterns = []secretPattern{
	{id: "aws-access-token", expression: `\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b`, label: "an AWS access key id"},
	{id: "github-pat", expression: `\bghp_[0-9A-Za-z]{36}\b`, label: "a GitHub personal access token"},
	{id: "github-fine-grained-pat", expression: `\bgithub_pat_[0-9A-Za-z_]{82}\b`, label: "a GitHub fine-grained token"},
	{id: "github-app-token", expression: `\b(?:ghu|ghs|gho|ghr)_[0-9A-Za-z]{36}\b`, label: "a GitHub app or OAuth token"},
	{id: "openai-api-key", expression: `\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}\b`, label: "an OpenAI API key"},
	{id: "anthropic-api-key", expression: `\bsk-ant-[a-z]+[0-9]{2}-[A-Za-z0-9_-]{80,}`, label: "an Anthropic API key"},
	{id: "slack-token", expression: `\bxox[baprs]-[0-9]{10,13}-[0-9A-Za-z-]{10,}`, label: "a Slack token"},
	{id: "stripe-access-token", expression: `\b(?:sk|rk)_(?:test|live|prod)_[0-9A-Za-z]{10,99}\b`, label: "a Stripe key"},
	{id: "gcp-api-key", expression: `\bAIza[0-9A-Za-z_-]{35}`, label: "a Google API key"},
	{id: "gcp-oauth-token", expression: `\bya29\.[0-9A-Za-z_-]{20,}`, label: "a Google OAuth access token"},
	{id: "gcp-client-secret", expression: `\bGOCSPX-[0-9A-Za-z_-]{28}`, label: "a Google OAuth client secret"},
	{id: "slack-webhook-url", expression: `hooks\.slack\.com/(?:services|workflows|triggers)/[A-Za-z0-9+/]{43,56}`, label: "a Slack webhook URL"},
	{id: "private-key", expression: `-----BEGIN[ \t\r\n]+(?:(?:RSA|EC|DSA|OPENSSH|PGP|ENCRYPTED)[ \t\r\n]+)?PRIVATE[ \t\r\n]+KEY(?:[ \t\r\n]+BLOCK)?-----`, label: "a private key"},
	{id: "jwt", expression: `\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b`, label: "a JSON web token"},
	{id: "sendgrid-api-token", expression: `\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b`, label: "a SendGrid key"},
}

func init() {
	entries := []secretEntry{}
	if err := json.Unmarshal(secretPack, &entries); err != nil {
		panic(err)
	}
	for _, e := range entries {
		for _, p := range e.Patterns {
			secretPatterns = append(secretPatterns, secretPattern{id: e.ID, expression: p, label: e.Label, keywords: e.Keywords, entropy: e.Entropy, group: e.Group, mixed: e.Mixed})
		}
	}
	for i := range secretPatterns {
		secretPatterns[i].re = regexp.MustCompile(secretPatterns[i].expression)
	}
}
func secrets(d policy.Detector, p Prepared) *engine.Match {
	views := append(append([]string{}, p.Strict...), p.Joined...)
	base := append([]string{}, views...)
	for _, v := range base {
		for parity := 0; parity < 2; parity++ {
			if u := unwrap(v, parity); u != v {
				views = append(views, u)
			}
		}
	}
	out := &engine.Match{Kind: "secret", Examples: []string{}, Details: []string{}}
	lowered := strings.ToLower(strings.Join(views, "\n"))
	for _, pat := range secretPatterns {
		if len(d.Rules) > 0 && !slices.Contains(d.Rules, pat.id) {
			continue
		}
		if len(pat.keywords) > 0 && !slices.ContainsFunc(pat.keywords, func(k string) bool { return strings.Contains(lowered, k) }) {
			continue
		}
		seen := map[string]bool{}
		first := ""
		n := 0
		for i, v := range views {
			for _, m := range pat.re.FindAllStringSubmatchIndex(v, -1) {
				if pat.id == "gcp-api-key" && m[1] < len(v) && token(v[m[1]]) {
					continue
				}
				if pat.entropy > 0 || pat.mixed {
					at := 2 * pat.group
					if at+1 >= len(m) || m[at] < 0 {
						at = 0
					}
					secret := v[m[at]:m[at+1]]
					if shannon(secret) < pat.entropy || pat.mixed && !credentialShaped(secret) {
						continue
					}
				}
				s := v[m[0]:m[1]]
				compact := strings.Map(func(r rune) rune {
					if unicode.IsSpace(r) {
						return -1
					}
					return r
				}, s)
				key := compact
				if len(key) > 16 {
					key = key[:16]
				}
				if i >= max(1, p.PrimaryCount) && seen[key] {
					continue
				}
				seen[key] = true
				n++
				if len(out.Diagnostics) < 3 {
					view, label := "line-unwrapped", ""
					if i < len(p.Strict) {
						view = "primary"
						label = viewLabel(p.StrictLabels, i)
						if i >= max(1, p.PrimaryCount) {
							view = "base64"
						}
					} else if i < len(p.Strict)+len(p.Joined) {
						view = "joined"
					}
					out.Diagnostics = append(out.Diagnostics, diagnosticMatch("secret", pat.id, view, label, v, m[0], m[1], false, false))
				}
				if first == "" {
					first = s[:min(6, len(s))]
				}
			}
		}
		if n > 0 {
			out.Count += n
			out.Details = append(out.Details, pat.id)
			if len(out.Examples) < 3 {
				out.Examples = append(out.Examples, pat.label+" ("+first+"…)")
			}
		}
	}
	if out.Count == 0 {
		return nil
	}
	return out
}
