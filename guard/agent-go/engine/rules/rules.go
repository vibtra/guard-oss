// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package rules

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"time"

	"github.com/vibtra/guard/guard/agent-go/engine"
	"github.com/vibtra/guard/guard/agent-go/engine/rules/internal/detect"
	"github.com/vibtra/guard/guard/agent-go/policy"
)

type Readiness int

const (
	Unsupported Readiness = iota
	NotReady
	Ready
)

type Extra interface {
	Readiness(kind string) Readiness
	Detect(ctx context.Context, d policy.Detector, c engine.Content) (*engine.Match, error)
}

type Engine struct{ extra Extra }

type Option func(*Engine)

func WithExtra(x Extra) Option { return func(e *Engine) { e.extra = x } }

func New(opts ...Option) *Engine {
	e := &Engine{}
	for _, o := range opts {
		o(e)
	}
	return e
}

func Builtin(kind string) bool { return detect.Known(kind) }

func (Engine) Name() string { return "rules" }

func (e Engine) Decide(ctx context.Context, r engine.Request) (engine.Decision, error) {
	v := decide(ctx, e.extra, r.Bundle, r.Catalogue, r.Host, r.BundleID, r.CLI, r.Content, r.Now)
	v = applySurfaceBlock(v, r.Surface)
	if r.CoverageFailed {
		if r.Transport == engine.WebSocket {
			v = websocketCoverageVerdict(v)
		} else {
			v = httpCoverageVerdict(v)
		}
	}
	return v, nil
}

func Detect(c engine.Content, detectors []policy.Detector) []*engine.Match {
	p := detect.Prepare(c)
	out := make([]*engine.Match, len(detectors))
	for i, d := range detectors {
		out[i] = detect.Detect(d, c, p)
	}
	return out
}

func rank(action string) int {
	switch action {
	case "block":
		return 2
	case "ask":
		return 1
	}
	return 0
}
func applies(raw json.RawMessage, service string) bool {
	if string(raw) == `"*"` {
		return true
	}
	var ids []string
	if json.Unmarshal(raw, &ids) != nil {
		return false
	}
	return slices.Contains(ids, service)
}
func decide(ctx context.Context, x Extra, b *policy.Bundle, c *policy.Catalogue, host, bundleID, cli string, ex engine.Content, now time.Time) engine.Decision {
	v := engine.Decision{Verdict: "not-intercepted"}
	if b == nil {
		return v
	}
	v.Enforced = b.ClientMode == "enforce"
	s := c.Service(host, bundleID, cli)
	if s == nil {
		return v
	}
	v.Intercepted = true
	v.Service = s
	f := b.Flow(s.ServiceID, now)
	v.Flow = &f
	action := f.Action
	if action == "allow" {
		content := &engine.ContentResult{Action: "allow", Matches: []engine.ContentMatch{}, Decided: -1}
		p := detect.Prepare(ex)
		for _, r := range b.ContentRules {
			if !applies(r.Services, s.ServiceID) {
				continue
			}
			m, unavailable := match(ctx, x, r.Detector, ex, p)
			if m == nil || unavailable != "" && r.Action == "allow" {
				continue
			}
			hit := engine.ContentMatch{Rule: r, Match: *m, Unavailable: unavailable}
			ruleAction := r.Action
			if unavailable != "" {
				ruleAction = "block"
				hit.Rule.Note = unavailableNotes[unavailable]
			}
			if e := b.Exception(s.ServiceID, r.RuleID, now); e != nil {
				hit.Excepted = true
				hit.GrantID = e.GrantID
			}
			content.Matches = append(content.Matches, hit)
			if !hit.Excepted && rank(ruleAction) > rank(content.Action) {
				content.Action = ruleAction
				content.Decided = len(content.Matches) - 1
			}
		}
		v.Content = content
		action = content.Action
	}
	v.Verdict = "allowed"
	if action == "ask" {
		v.Verdict = "asked"
	}
	if action == "block" {
		v.Verdict = "blocked"
	}
	return v
}

var unavailableNotes = map[string]string{
	"engine-capability": "This version of Guard cannot run the detector this rule needs, so the rule blocks the request.",
	"model_not_ready":   "Guard's detection model is not ready yet, so this rule blocks the request.",
}

func match(ctx context.Context, x Extra, d policy.Detector, ex engine.Content, p detect.Prepared) (*engine.Match, string) {
	ready := Unsupported
	if x != nil {
		ready = readiness(x, d.Kind)
	}
	if detect.Known(d.Kind) {
		m := detect.Detect(d, ex, p)
		if ready == Ready {
			if more, err := extraDetect(ctx, x, d, ex); err == nil {
				m = union(m, more)
			}
		}
		return m, ""
	}
	empty := &engine.Match{Kind: d.Kind, Examples: []string{}}
	switch ready {
	case Ready:
		m, err := extraDetect(ctx, x, d, ex)
		if err != nil {
			return empty, "model_not_ready"
		}
		return union(nil, m), ""
	case NotReady:
		return empty, "model_not_ready"
	}
	return empty, "engine-capability"
}

func readiness(x Extra, kind string) (r Readiness) {
	defer func() {
		if recover() != nil {
			r = NotReady
		}
	}()
	return x.Readiness(kind)
}

func extraDetect(ctx context.Context, x Extra, d policy.Detector, ex engine.Content) (m *engine.Match, err error) {
	defer func() {
		if recover() != nil {
			m, err = nil, errExtraPanicked
		}
	}()
	return x.Detect(ctx, d, ex)
}

var errExtraPanicked = errors.New("rules: the extra detector panicked")

func union(m, more *engine.Match) *engine.Match {
	if more == nil {
		return m
	}
	if m == nil {
		m = &engine.Match{Kind: more.Kind, Examples: []string{}}
	}
	out := *m
	out.Count = max(m.Count, more.Count)
	out.Examples = slices.Clone(m.Examples)
	for _, e := range more.Examples {
		if len(out.Examples) < 3 && !slices.Contains(out.Examples, e) {
			out.Examples = append(out.Examples, e)
		}
	}
	out.Details = slices.Clone(m.Details)
	for _, d := range more.Details {
		if !slices.Contains(out.Details, d) {
			out.Details = append(out.Details, d)
		}
	}
	out.Diagnostics = append(slices.Clone(m.Diagnostics), more.Diagnostics...)
	return &out
}

func applySurfaceBlock(v engine.Decision, entry *engine.Surface) engine.Decision {
	if entry == nil || !v.Intercepted {
		return v
	}
	v.Flow = &policy.Flow{Action: "block", Source: "surface-block", SurfaceID: entry.Surface, CoverageEntry: entry.CoverageEntry, Note: "This documented action is blocked by your organisation's surface control."}
	v.Content = nil
	v.Verdict = "blocked"
	return v
}

func httpCoverageVerdict(v engine.Decision) engine.Decision {
	if v.Intercepted && v.Flow.Action == "allow" {
		v.Verdict = "blocked"
		v.Content = nil
		v.Flow = &policy.Flow{Action: "block", Source: "inspection-coverage", Note: "Guard could not inspect this HTTP request safely."}
	}
	return v
}

func websocketCoverageVerdict(v engine.Decision) engine.Decision {
	if v.Intercepted {
		v.Verdict = "blocked"
		v.Content = nil
		v.Flow = &policy.Flow{Action: "block", Source: "inspection-coverage", Note: "Guard could not inspect this WebSocket message safely."}
	}
	return v
}
