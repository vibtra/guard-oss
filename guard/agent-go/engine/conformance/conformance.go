// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package conformance

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/vibtra/guard/guard/agent-go/engine"
	"github.com/vibtra/guard/guard/agent-go/policy"
)

type Failure struct {
	Case    string
	Problem string
}

type Result struct {
	Check    string
	Cases    int
	Failures []Failure
}

type Report struct {
	Engine  string
	Results []Result
}

func (r Report) OK() bool {
	for _, res := range r.Results {
		if len(res.Failures) > 0 {
			return false
		}
	}
	return len(r.Results) > 0
}

type Option func(*config)

type config struct {
	vectors *Vectors
}

func WithVectors(v Vectors) Option {
	return func(c *config) { c.vectors = &v }
}

func configure(opts []Option) config {
	var c config
	for _, o := range opts {
		o(&c)
	}
	return c
}

func Check(e engine.Engine, opts ...Option) Report {
	c := configure(opts)
	probes := invariantProbes()
	r := Report{Engine: e.Name(), Results: []Result{
		monitorNeverBlocks(e, probes),
		coverageFailureNeverAllowed(e, probes),
		missingCapabilityNeverAllowed(e, probes),
		surfaceBlocks(e, probes),
		validDecisions(e, probes),
		exceptionsHonoured(e),
		deterministic(e, probes),
		noContent(e, probes),
	}}
	if c.vectors != nil {
		for _, s := range c.vectors.sets {
			r.Results = append(r.Results, parity(e, s))
		}
	}
	return r
}

const repeats = 100

var now = time.Date(2026, 6, 1, 9, 0, 0, 0, time.UTC)

const canary = "conformance-canary-q7x2"

const sensitive = "Summarise this for " + canary + ": TFN 123 456 782, card 4242 4242 4242 4242, project falcon"

var leaks = []string{canary, "123456782", "123 456 782", "4242424242424242", "4242 4242 4242 4242"}

type probe struct {
	name string
	req  engine.Request
}

func content(text string, filenames ...string) engine.Content {
	return engine.Content{Spans: []engine.TextSpan{{Text: text}}, Text: text + "\n", Filenames: filenames}
}

func catalogue() *policy.Catalogue {
	service := func(id, name, domain string) policy.Service {
		return policy.Service{ServiceID: id, Name: name, Vendor: "Example", Category: "chat", Domains: []string{domain}, BundleIDs: []string{}, CLINames: []string{}}
	}
	return &policy.Catalogue{Version: "conformance", Services: []policy.Service{
		service("openai-chatgpt", "ChatGPT", "chatgpt.com"),
		service("anthropic-claude", "Claude", "claude.ai"),
		service("deepseek", "DeepSeek", "chat.deepseek.com"),
		service("poe", "Poe", "poe.com"),
	}}
}

func contentRule(id string, d policy.Detector, services, action string) policy.ContentRule {
	return policy.ContentRule{RuleID: id, Name: id, Detector: d, Services: json.RawMessage(services), Action: action}
}

func bundle(mode string) *policy.Bundle {
	return &policy.Bundle{
		Protocol:         1,
		OrgID:            "org_conformance",
		DeviceID:         "dev_conformance",
		BundleVersion:    1,
		CatalogueVersion: "conformance",
		ClientMode:       mode,
		DefaultAction:    "allow",
		Services:         map[string]policy.ServiceDecision{"deepseek": {Action: "block", RuleID: "gsr_00000002", Note: "Not approved for company data."}},
		ContentRules: []policy.ContentRule{
			contentRule("gcr_00000001", policy.Detector{Kind: "au-tfn"}, `"*"`, "block"),
			contentRule("gcr_00000002", policy.Detector{Kind: "card-number"}, `["openai-chatgpt"]`, "ask"),
			contentRule("gcr_00000003", policy.Detector{Kind: "keyword", Keywords: []string{"falcon"}}, `"*"`, "allow"),
			contentRule("gcr_00000004", policy.Detector{Kind: "file-type", Extensions: []string{"xlsx"}}, `"*"`, "block"),
		},
		Exceptions: []policy.Exception{},
		Settings:   policy.Settings{SnippetPolicy: "redacted", SnippetMax: 80},
	}
}

const missingKind = "conformance-missing-kind"

func missingCapability(mode string) *policy.Bundle {
	b := bundle(mode)
	b.ContentRules = append(b.ContentRules, contentRule("gcr_00000005", policy.Detector{Kind: missingKind}, `"*"`, "block"))
	return b
}

func request(b *policy.Bundle, host string, r engine.Request) engine.Request {
	r.Host = host
	r.Bundle = b
	r.Catalogue = catalogue()
	r.Now = now
	if r.Transport == "" {
		r.Transport = engine.HTTP
	}
	return r
}

func invariantProbes() []probe {
	var out []probe
	for _, mode := range []string{"enforce", "monitor"} {
		add := func(name, host string, r engine.Request) {
			out = append(out, probe{mode + "/" + name, request(bundle(mode), host, r)})
		}
		add("benign", "chatgpt.com", engine.Request{Content: content("hello there")})
		add("sensitive", "chatgpt.com", engine.Request{Content: content(sensitive, "payroll-"+canary+".xlsx")})
		add("pre-body", "chatgpt.com", engine.Request{})
		add("blocked-service", "chat.deepseek.com", engine.Request{Content: content(sensitive)})
		add("unlisted-host", "example.org", engine.Request{Content: content(sensitive)})
		add("coverage-failure", "chatgpt.com", engine.Request{CoverageFailed: true})
		add("surface-block", "chatgpt.com", engine.Request{Content: content(sensitive), Surface: &engine.Surface{Surface: "chatgpt-upload", CoverageEntry: "chatgpt.com/upload"}})
		add("surface-pre-body", "chatgpt.com", engine.Request{Surface: &engine.Surface{Surface: "chatgpt-upload", CoverageEntry: "chatgpt.com/upload"}})
		add("websocket-message", "chatgpt.com", engine.Request{Transport: engine.WebSocket, Content: content(sensitive)})
		add("websocket-coverage-failure", "chatgpt.com", engine.Request{Transport: engine.WebSocket, CoverageFailed: true})
		out = append(out, probe{mode + "/missing-capability", request(missingCapability(mode), "chatgpt.com", engine.Request{Content: content("hello there")})})
	}
	return append(out, probe{"no-policy", engine.Request{Host: "chatgpt.com", Transport: engine.HTTP, Content: content(sensitive), Now: now}})
}

func decide(e engine.Engine, r engine.Request) (d engine.Decision, err error) {
	defer func() {
		if p := recover(); p != nil {
			err = fmt.Errorf("the engine panicked: %v", p)
		}
	}()
	return e.Decide(context.Background(), r)
}

func fingerprint(d engine.Decision, err error) string {
	full := struct {
		Decision    engine.Decision
		Decided     int
		Diagnostics [][]engine.MatchDiagnostic
		Error       string
	}{Decision: d}
	if d.Content != nil {
		full.Decided = d.Content.Decided
		for _, m := range d.Content.Matches {
			full.Diagnostics = append(full.Diagnostics, m.Match.Diagnostics)
		}
	}
	if err != nil {
		full.Error = err.Error()
	}
	b, e := json.Marshal(full)
	if e != nil {
		return "unencodable decision: " + e.Error()
	}
	return string(b)
}

func probeCheck(e engine.Engine, probes []probe, check string, applies func(engine.Request) bool, problem func(engine.Decision) string) Result {
	res := Result{Check: check}
	for _, p := range probes {
		if !applies(p.req) {
			continue
		}
		res.Cases++
		d, err := decide(e, p.req)
		if err != nil {
			res.Failures = append(res.Failures, Failure{p.name, err.Error()})
			continue
		}
		if msg := problem(d); msg != "" {
			res.Failures = append(res.Failures, Failure{p.name, msg})
		}
	}
	return res
}

func monitorNeverBlocks(e engine.Engine, probes []probe) Result {
	return probeCheck(e, probes, "monitor-never-blocks", func(r engine.Request) bool {
		return r.Bundle != nil && r.Bundle.ClientMode == "monitor"
	}, func(d engine.Decision) string {
		if d.Enforced {
			return fmt.Sprintf("Enforced is true under a monitor bundle (verdict %s)", d.Verdict)
		}
		return ""
	})
}

func enforcing(r engine.Request) bool {
	return r.Bundle != nil && r.Bundle.ClientMode == "enforce"
}

func coverageFailureNeverAllowed(e engine.Engine, probes []probe) Result {
	return probeCheck(e, probes, "coverage-failure-never-allowed", func(r engine.Request) bool {
		return r.CoverageFailed && enforcing(r)
	}, func(d engine.Decision) string {
		if !d.Intercepted || !d.Enforced || d.Verdict != "blocked" && d.Verdict != "asked" {
			return fmt.Sprintf("a request Guard could not inspect would reach the service under an enforce bundle (intercepted %t, enforced %t, verdict %q); want intercepted, enforced and blocked or asked", d.Intercepted, d.Enforced, d.Verdict)
		}
		return ""
	})
}

func missingCapabilityNeverAllowed(e engine.Engine, probes []probe) Result {
	res := Result{Check: "missing-capability-never-allowed"}
	for _, p := range probes {
		if p.req.Bundle == nil || !slices.ContainsFunc(p.req.Bundle.ContentRules, func(r policy.ContentRule) bool { return r.Detector.Kind == missingKind }) {
			continue
		}
		res.Cases++
		d, err := decide(e, p.req)
		if err != nil {
			res.Failures = append(res.Failures, Failure{p.name, err.Error()})
			continue
		}
		if !d.Intercepted || d.Verdict != "blocked" || d.Enforced != enforcing(p.req) {
			res.Failures = append(res.Failures, Failure{p.name, fmt.Sprintf("a rule whose detector kind %q no engine runs gets intercepted %t, enforced %t, verdict %q; want intercepted, enforced %t and blocked", missingKind, d.Intercepted, d.Enforced, d.Verdict, enforcing(p.req))})
			continue
		}
		if d.Content == nil || !slices.ContainsFunc(d.Content.Matches, func(m engine.ContentMatch) bool {
			return m.Rule.Detector.Kind == missingKind && m.Unavailable == "engine-capability"
		}) {
			res.Failures = append(res.Failures, Failure{p.name, `the decision has no match for the rule with Unavailable "engine-capability"`})
		}
	}
	return res
}

func surfaceBlocks(e engine.Engine, probes []probe) Result {
	res := Result{Check: "surface-blocks"}
	for _, p := range probes {
		if p.req.Surface == nil || p.req.Bundle == nil {
			continue
		}
		res.Cases++
		d, err := decide(e, p.req)
		if err != nil {
			res.Failures = append(res.Failures, Failure{p.name, err.Error()})
			continue
		}
		if !d.Intercepted || d.Verdict != "blocked" || d.Enforced != enforcing(p.req) {
			res.Failures = append(res.Failures, Failure{p.name, fmt.Sprintf("a request on a blocked surface gets intercepted %t, enforced %t, verdict %q; want intercepted, enforced %t and blocked", d.Intercepted, d.Enforced, d.Verdict, enforcing(p.req))})
		}
	}
	return res
}

var verdicts = []string{"allowed", "asked", "blocked", "not-intercepted"}

func validDecisions(e engine.Engine, probes []probe) Result {
	all := slices.Clone(probes)
	for _, c := range exceptionCases() {
		all = append(append(all, c.live...), c.expired, c.without)
	}
	return probeCheck(e, all, "valid-decision", func(engine.Request) bool { return true }, func(d engine.Decision) string {
		if err := engine.Validate(d); err != nil {
			return err.Error()
		}
		if !slices.Contains(verdicts, d.Verdict) {
			return fmt.Sprintf("verdict %q is not one of %v", d.Verdict, verdicts)
		}
		if d.Intercepted == (d.Verdict == "not-intercepted") {
			return fmt.Sprintf("verdict %q does not match intercepted %t", d.Verdict, d.Intercepted)
		}
		return ""
	})
}

type exceptionCase struct {
	name    string
	ruleID  string
	live    []probe
	expired probe
	without probe
}

func exceptionCases() []exceptionCase {
	serviceBlocked := func() *policy.Bundle {
		b := bundle("enforce")
		b.Services["openai-chatgpt"] = policy.ServiceDecision{Action: "block", RuleID: "gsr_00000004"}
		return b
	}
	scenarios := []struct {
		name      string
		bundle    func() *policy.Bundle
		content   engine.Content
		exception policy.Exception
	}{
		{"service", serviceBlocked, content("hello there"), policy.Exception{GrantID: "grant_service", ServiceID: "openai-chatgpt", Scope: "user"}},
		{"content-rule", func() *policy.Bundle { return bundle("enforce") }, content("my TFN is 123 456 782"), policy.Exception{GrantID: "grant_rule", ServiceID: "openai-chatgpt", RuleID: "gcr_00000001", Scope: "user"}},
		{"missing-capability", func() *policy.Bundle { return missingCapability("enforce") }, content("hello there"), policy.Exception{GrantID: "grant_capability", ServiceID: "openai-chatgpt", RuleID: "gcr_00000005", Scope: "user"}},
	}
	out := make([]exceptionCase, 0, len(scenarios))
	for _, s := range scenarios {
		with := func(name, expiresAt string) probe {
			b := s.bundle()
			ex := s.exception
			ex.ExpiresAt = expiresAt
			b.Exceptions = []policy.Exception{ex}
			return probe{s.name + "/" + name, request(b, "chatgpt.com", engine.Request{Content: s.content})}
		}
		out = append(out, exceptionCase{
			name:    s.name,
			ruleID:  s.exception.RuleID,
			live:    []probe{with("live", now.Add(time.Hour).Format(time.RFC3339Nano)), with("no-expiry", "")},
			expired: with("expired", now.Add(-time.Hour).Format(time.RFC3339Nano)),
			without: probe{s.name + "/without", request(s.bundle(), "chatgpt.com", engine.Request{Content: s.content})},
		})
	}
	return out
}

func exceptionsHonoured(e engine.Engine) Result {
	res := Result{Check: "exceptions"}
	for _, c := range exceptionCases() {
		for _, p := range c.live {
			res.Cases++
			d, err := decide(e, p.req)
			if err != nil {
				res.Failures = append(res.Failures, Failure{p.name, err.Error()})
				continue
			}
			if d.Verdict == "blocked" || d.Verdict == "asked" {
				res.Failures = append(res.Failures, Failure{p.name, fmt.Sprintf("a live exception for %s is ignored: verdict %s", c.name, d.Verdict)})
			}
			if d.Content != nil {
				for _, m := range d.Content.Matches {
					if c.ruleID != "" && m.Rule.RuleID == c.ruleID && !m.Excepted {
						res.Failures = append(res.Failures, Failure{p.name, "the match for the excepted rule is not marked excepted"})
					}
				}
			}
		}
		res.Cases++
		expired, err := decide(e, c.expired.req)
		if err != nil {
			res.Failures = append(res.Failures, Failure{c.expired.name, err.Error()})
			continue
		}
		without, err := decide(e, c.without.req)
		if err != nil {
			res.Failures = append(res.Failures, Failure{c.without.name, err.Error()})
			continue
		}
		if fingerprint(expired, nil) != fingerprint(without, nil) {
			res.Failures = append(res.Failures, Failure{c.expired.name, fmt.Sprintf("an expired exception changed the decision: verdict %s, without it %s", expired.Verdict, without.Verdict)})
		}
	}
	return res
}

func deterministic(e engine.Engine, probes []probe) Result {
	res := Result{Check: "deterministic"}
	for _, p := range probes {
		res.Cases++
		first := fingerprint(decide(e, p.req))
		for i := 1; i < repeats; i++ {
			if again := fingerprint(decide(e, p.req)); again != first {
				res.Failures = append(res.Failures, Failure{p.name, fmt.Sprintf("decision %d of %d differs from the first", i+1, repeats)})
				break
			}
		}
	}
	return res
}

func noContent(e engine.Engine, probes []probe) Result {
	res := Result{Check: "no-content"}
	for _, p := range probes {
		res.Cases++
		d, err := decide(e, p.req)
		if err != nil {
			res.Failures = append(res.Failures, Failure{p.name, err.Error()})
			continue
		}
		fp := fingerprint(d, nil)
		for _, leak := range leaks {
			if strings.Contains(fp, leak) {
				res.Failures = append(res.Failures, Failure{p.name, fmt.Sprintf("the decision carries request content %q; only redacted examples may leave the engine", leak)})
			}
		}
	}
	return res
}
