// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package conformance

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/vibtra/guard/guard/agent-go/engine"
	"github.com/vibtra/guard/guard/agent-go/policy"
)

type flowFacts struct {
	Action  string `json:"action"`
	Source  string `json:"source"`
	RuleID  string `json:"ruleId,omitempty"`
	GrantID string `json:"grantId,omitempty"`
}

type matchFacts struct {
	RuleID   string `json:"ruleId"`
	Kind     string `json:"kind"`
	Count    int    `json:"count"`
	Excepted bool   `json:"excepted"`
}

type facts struct {
	Verdict       string       `json:"verdict"`
	Intercepted   bool         `json:"intercepted"`
	Enforced      bool         `json:"enforced"`
	ServiceID     string       `json:"serviceId,omitempty"`
	Flow          *flowFacts   `json:"flow,omitempty"`
	ContentAction string       `json:"contentAction,omitempty"`
	Matches       []matchFacts `json:"matches,omitempty"`
	Decided       *int         `json:"decided,omitempty"`
}

func factsOf(d engine.Decision) facts {
	f := facts{Verdict: d.Verdict, Intercepted: d.Intercepted, Enforced: d.Enforced}
	if d.Service != nil {
		f.ServiceID = d.Service.ServiceID
	}
	if d.Flow != nil {
		f.Flow = &flowFacts{d.Flow.Action, d.Flow.Source, d.Flow.RuleID, d.Flow.GrantID}
	}
	if d.Content != nil {
		f.ContentAction = d.Content.Action
		decided := d.Content.Decided
		f.Decided = &decided
		for _, m := range d.Content.Matches {
			f.Matches = append(f.Matches, matchFacts{m.Rule.RuleID, m.Match.Kind, m.Match.Count, m.Excepted})
		}
	}
	return f
}

func wantFacts(want facts) func(engine.Decision) string {
	w, _ := json.Marshal(want)
	return func(d engine.Decision) string {
		got, _ := json.Marshal(factsOf(d))
		if string(got) != string(w) {
			return fmt.Sprintf("got %s, want %s", got, w)
		}
		return ""
	}
}

func compiled() vectorSet {
	enforce := func() *policy.Bundle { return bundle("enforce") }
	withService := func(id string, d policy.ServiceDecision) func() *policy.Bundle {
		return func() *policy.Bundle {
			b := bundle("enforce")
			b.Services[id] = d
			return b
		}
	}
	withException := func(b func() *policy.Bundle, ex policy.Exception) func() *policy.Bundle {
		return func() *policy.Bundle {
			out := b()
			out.Exceptions = []policy.Exception{ex}
			return out
		}
	}
	live := now.Add(7 * 24 * time.Hour).Format(time.RFC3339Nano)
	expired := now.Add(-7 * 24 * time.Hour).Format(time.RFC3339Nano)
	chatgptBlocked := withService("openai-chatgpt", policy.ServiceDecision{Action: "block", RuleID: "gsr_00000004"})
	tfn := matchFacts{"gcr_00000001", "au-tfn", 1, false}
	card := matchFacts{"gcr_00000002", "card-number", 1, false}
	allowDefault := &flowFacts{Action: "allow", Source: "default"}
	coverage := &flowFacts{Action: "block", Source: "inspection-coverage"}
	decided := func(i int) *int { return &i }
	services := map[string]string{"chatgpt.com": "openai-chatgpt", "claude.ai": "anthropic-claude", "chat.deepseek.com": "deepseek", "poe.com": "poe"}
	cases := []struct {
		name   string
		bundle func() *policy.Bundle
		host   string
		req    engine.Request
		want   facts
	}{
		{"service-rule-blocks", chatgptBlocked, "chatgpt.com", engine.Request{Content: content("hello there")},
			facts{Verdict: "blocked", Intercepted: true, Enforced: true, Flow: &flowFacts{Action: "block", Source: "rule", RuleID: "gsr_00000004"}}},
		{"service-rule-asks", withService("openai-chatgpt", policy.ServiceDecision{Action: "ask", RuleID: "gsr_00000003"}), "chatgpt.com", engine.Request{Content: content("hello there")},
			facts{Verdict: "asked", Intercepted: true, Enforced: true, Flow: &flowFacts{Action: "ask", Source: "rule", RuleID: "gsr_00000003"}}},
		{"named-service-blocked", enforce, "chat.deepseek.com", engine.Request{Content: content("hello there")},
			facts{Verdict: "blocked", Intercepted: true, Enforced: true, Flow: &flowFacts{Action: "block", Source: "rule", RuleID: "gsr_00000002"}}},
		{"catalogue-default-block", withService("poe", policy.ServiceDecision{Action: "block"}), "poe.com", engine.Request{Content: content("hello there")},
			facts{Verdict: "blocked", Intercepted: true, Enforced: true, Flow: &flowFacts{Action: "block", Source: "default"}}},
		{"allow-rule-reports-keyword", enforce, "claude.ai", engine.Request{Content: content("project falcon")},
			facts{Verdict: "allowed", Intercepted: true, Enforced: true, Flow: allowDefault, ContentAction: "allow", Decided: decided(-1), Matches: []matchFacts{{"gcr_00000003", "keyword", 1, false}}}},
		{"content-blocks-tfn", enforce, "claude.ai", engine.Request{Content: content("tfn 123 456 782")},
			facts{Verdict: "blocked", Intercepted: true, Enforced: true, Flow: allowDefault, ContentAction: "block", Decided: decided(0), Matches: []matchFacts{tfn}}},
		{"card-asks-on-chatgpt", enforce, "chatgpt.com", engine.Request{Content: content("card 4242424242424242")},
			facts{Verdict: "asked", Intercepted: true, Enforced: true, Flow: allowDefault, ContentAction: "ask", Decided: decided(0), Matches: []matchFacts{card}}},
		{"card-rule-scoped-to-chatgpt", enforce, "claude.ai", engine.Request{Content: content("card 4242424242424242")},
			facts{Verdict: "allowed", Intercepted: true, Enforced: true, Flow: allowDefault, ContentAction: "allow", Decided: decided(-1)}},
		{"most-severe-rule-wins", enforce, "chatgpt.com", engine.Request{Content: content("tfn 123 456 782, card 4242424242424242")},
			facts{Verdict: "blocked", Intercepted: true, Enforced: true, Flow: allowDefault, ContentAction: "block", Decided: decided(0), Matches: []matchFacts{tfn, card}}},
		{"service-exception", withException(chatgptBlocked, policy.Exception{GrantID: "grant_service", ServiceID: "openai-chatgpt", Scope: "user", ExpiresAt: live}), "chatgpt.com", engine.Request{Content: content("hello there")},
			facts{Verdict: "allowed", Intercepted: true, Enforced: true, Flow: &flowFacts{Action: "allow", Source: "exception", GrantID: "grant_service"}, ContentAction: "allow", Decided: decided(-1)}},
		{"expired-service-exception", withException(chatgptBlocked, policy.Exception{GrantID: "grant_service", ServiceID: "openai-chatgpt", Scope: "user", ExpiresAt: expired}), "chatgpt.com", engine.Request{Content: content("hello there")},
			facts{Verdict: "blocked", Intercepted: true, Enforced: true, Flow: &flowFacts{Action: "block", Source: "rule", RuleID: "gsr_00000004"}}},
		{"rule-exception", withException(enforce, policy.Exception{GrantID: "grant_rule", ServiceID: "openai-chatgpt", RuleID: "gcr_00000001", Scope: "user", ExpiresAt: live}), "chatgpt.com", engine.Request{Content: content("tfn 123 456 782")},
			facts{Verdict: "allowed", Intercepted: true, Enforced: true, Flow: allowDefault, ContentAction: "allow", Decided: decided(-1), Matches: []matchFacts{{"gcr_00000001", "au-tfn", 1, true}}}},
		{"expired-rule-exception", withException(enforce, policy.Exception{GrantID: "grant_rule", ServiceID: "openai-chatgpt", RuleID: "gcr_00000001", Scope: "user", ExpiresAt: expired}), "chatgpt.com", engine.Request{Content: content("tfn 123 456 782")},
			facts{Verdict: "blocked", Intercepted: true, Enforced: true, Flow: allowDefault, ContentAction: "block", Decided: decided(0), Matches: []matchFacts{tfn}}},
		{"monitor-still-decides", func() *policy.Bundle { return bundle("monitor") }, "claude.ai", engine.Request{Content: content("tfn 123 456 782")},
			facts{Verdict: "blocked", Intercepted: true, Enforced: false, Flow: allowDefault, ContentAction: "block", Decided: decided(0), Matches: []matchFacts{tfn}}},
		{"unlisted-host", enforce, "example.org", engine.Request{Content: content("tfn 123 456 782")},
			facts{Verdict: "not-intercepted", Enforced: true}},
		{"no-policy", func() *policy.Bundle { return nil }, "chatgpt.com", engine.Request{Content: content("tfn 123 456 782")},
			facts{Verdict: "not-intercepted"}},
		{"surface-block", enforce, "chatgpt.com", engine.Request{Content: content("hello there"), Surface: &engine.Surface{Surface: "chatgpt-upload", CoverageEntry: "chatgpt.com/upload"}},
			facts{Verdict: "blocked", Intercepted: true, Enforced: true, Flow: &flowFacts{Action: "block", Source: "surface-block"}}},
		{"http-coverage-failure", enforce, "claude.ai", engine.Request{CoverageFailed: true},
			facts{Verdict: "blocked", Intercepted: true, Enforced: true, Flow: coverage}},
		{"http-coverage-failure-keeps-service-block", enforce, "chat.deepseek.com", engine.Request{CoverageFailed: true},
			facts{Verdict: "blocked", Intercepted: true, Enforced: true, Flow: &flowFacts{Action: "block", Source: "rule", RuleID: "gsr_00000002"}}},
		{"websocket-coverage-failure", enforce, "claude.ai", engine.Request{Transport: engine.WebSocket, CoverageFailed: true},
			facts{Verdict: "blocked", Intercepted: true, Enforced: true, Flow: coverage}},
	}
	s := vectorSet{name: "compiled"}
	for _, c := range cases {
		if c.want.Intercepted {
			c.want.ServiceID = services[c.host]
		}
		s.cases = append(s.cases, vectorCase{c.name, request(c.bundle(), c.host, c.req), wantFacts(c.want)})
	}
	return s
}
