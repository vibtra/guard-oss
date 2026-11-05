// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package pineapple

import (
	"context"
	"strings"

	"github.com/vibtra/guard/guard/agent-go/engine"
	"github.com/vibtra/guard/guard/agent-go/policy"
)

type Engine struct{}

func New() Engine { return Engine{} }

func (Engine) Name() string { return "pineapple" }

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
	texts := []string{r.Content.Text}
	for _, span := range r.Content.Spans {
		texts = append(texts, span.Text)
	}
	for _, text := range texts {
		if strings.Contains(text, "PINEAPPLE") {
			v.Flow = &policy.Flow{Action: "block", Source: "rule", RuleID: "pineapple"}
			v.Verdict = "blocked"
		}
	}
	return v, nil
}
