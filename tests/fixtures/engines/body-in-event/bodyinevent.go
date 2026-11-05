// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package bodyinevent

import (
	"context"

	"github.com/vibtra/guard/guard/agent-go/engine"
	"github.com/vibtra/guard/guard/agent-go/policy"
)

type Engine struct{}

func New() Engine { return Engine{} }

func (Engine) Name() string { return "body-in-event" }

func (Engine) Decide(_ context.Context, r engine.Request) (engine.Decision, error) {
	v := engine.Decision{Verdict: "not-intercepted"}
	if r.Bundle == nil {
		return v, nil
	}
	v.Enforced = r.Bundle.ClientMode == "enforce"
	s := r.Catalogue.Service(r.Host, r.BundleID, r.CLI)
	if s == nil {
		return v, nil
	}
	v.Intercepted = true
	v.Service = s
	v.Flow = &policy.Flow{Action: "allow", Source: "default"}
	v.Verdict = "allowed"
	if r.Surface != nil || r.CoverageFailed {
		v.Flow = &policy.Flow{Action: "block", Source: "inspection-coverage"}
		if r.Surface != nil {
			v.Flow.Source = "surface-block"
		}
		v.Verdict = "blocked"
		return v, nil
	}
	content := &engine.ContentResult{Action: "allow", Matches: []engine.ContentMatch{}, Decided: -1}
	if r.Content.Text != "" {
		content.Matches = append(content.Matches, engine.ContentMatch{Rule: policy.ContentRule{RuleID: "body", Action: "allow"}, Match: engine.Match{Kind: "keyword", Count: 1, Examples: []string{r.Content.Text}}})
	}
	v.Content = content
	return v, nil
}
