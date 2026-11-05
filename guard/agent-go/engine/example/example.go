// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package example

import (
	"context"
	"strings"

	"github.com/vibtra/guard/guard/agent-go/engine"
	"github.com/vibtra/guard/guard/agent-go/engine/rules"
	"github.com/vibtra/guard/guard/agent-go/policy"
)

const keyword = "CONFIDENTIAL"

var keywordRule = policy.ContentRule{RuleID: "example-keyword", Name: "Example keyword", Action: "block"}

type Engine struct{ rules *rules.Engine }

func New() Engine { return Engine{rules: rules.New()} }

func (Engine) Name() string { return "example" }

func (e Engine) Decide(ctx context.Context, r engine.Request) (engine.Decision, error) {
	d, err := e.rules.Decide(ctx, r)
	if err != nil || d.Content == nil || d.Verdict == "blocked" || !mentions(r.Content) {
		return d, err
	}
	hit := engine.ContentMatch{Rule: keywordRule, Match: engine.Match{Kind: "keyword", Count: 1, Examples: []string{}}}
	if x := r.Bundle.Exception(d.Service.ServiceID, keywordRule.RuleID, r.Now); x != nil {
		hit.Excepted, hit.GrantID = true, x.GrantID
	}
	d.Content.Matches = append(d.Content.Matches, hit)
	if !hit.Excepted {
		d.Content.Action, d.Content.Decided, d.Verdict = "block", len(d.Content.Matches)-1, "blocked"
	}
	return d, nil
}

func mentions(c engine.Content) bool {
	texts := append([]string{c.Text}, c.Joined...)
	for _, s := range c.Spans {
		texts = append(texts, s.Text)
	}
	for _, t := range texts {
		if strings.Contains(t, keyword) {
			return true
		}
	}
	return false
}
