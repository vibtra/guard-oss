// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package blocksinmonitor

import (
	"context"

	"github.com/vibtra/guard/guard/agent-go/engine"
	"github.com/vibtra/guard/guard/agent-go/policy"
)

type Engine struct{}

func New() Engine { return Engine{} }

func (Engine) Name() string { return "blocks-in-monitor" }

func (Engine) Decide(_ context.Context, r engine.Request) (engine.Decision, error) {
	v := engine.Decision{Verdict: "not-intercepted", Enforced: true}
	if r.Bundle == nil {
		return v, nil
	}
	s := r.Catalogue.Service(r.Host, r.BundleID, r.CLI)
	if s == nil {
		return v, nil
	}
	v.Intercepted = true
	v.Service = s
	if r.Surface != nil || r.CoverageFailed {
		v.Flow = &policy.Flow{Action: "block", Source: "inspection-coverage"}
		if r.Surface != nil {
			v.Flow.Source = "surface-block"
		}
		v.Verdict = "blocked"
		return v, nil
	}
	f := r.Bundle.Flow(s.ServiceID, r.Now)
	v.Flow = &policy.Flow{Action: f.Action, Source: f.Source, RuleID: f.RuleID, GrantID: f.GrantID}
	v.Verdict = "allowed"
	if f.Action == "block" {
		v.Verdict = "blocked"
	}
	return v, nil
}
