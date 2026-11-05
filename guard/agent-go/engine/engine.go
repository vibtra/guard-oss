// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package engine

import (
	"context"
	"time"

	"github.com/vibtra/guard/guard/agent-go/policy"
)

type Engine interface {
	Name() string
	Decide(ctx context.Context, req Request) (Decision, error)
}

type Transport string

const (
	HTTP      Transport = "http"
	WebSocket Transport = "websocket"
)

type TextSpan struct {
	Text  string `json:"text"`
	Label string `json:"label,omitempty"`
}

type Content struct {
	Spans     []TextSpan
	Text      string
	Filenames []string
	Joined    []string
}

type Surface struct {
	Surface       string
	CoverageEntry string
}

type Request struct {
	Host           string
	BundleID       string
	CLI            string
	Transport      Transport
	Content        Content
	CoverageFailed bool
	Surface        *Surface
	Bundle         *policy.Bundle
	Catalogue      *policy.Catalogue
	Now            time.Time
}

type MatchDiagnostic struct {
	Detector        string `json:"detector"`
	Pattern         string `json:"pattern,omitempty"`
	View            string `json:"view"`
	FieldClass      string `json:"fieldClass"`
	SpanShape       string `json:"spanShape"`
	SpanLength      int    `json:"spanLength"`
	CandidateLength int    `json:"candidateLength"`
	CandidateDigits int    `json:"candidateDigits"`
	WholeSpan       bool   `json:"wholeSpan"`
	TextContext     bool   `json:"textContext,omitempty"`
	FieldContext    bool   `json:"fieldContext,omitempty"`
	NumericFragment bool   `json:"numericFragment,omitempty"`
	BeforeClass     string `json:"beforeClass"`
	AfterClass      string `json:"afterClass"`
}

type Match struct {
	Diagnostics []MatchDiagnostic `json:"-"`
	Kind        string            `json:"kind"`
	Count       int               `json:"count"`
	Examples    []string          `json:"examples"`
	Details     []string          `json:"details,omitempty"`
}

type ContentMatch struct {
	Rule        policy.ContentRule `json:"rule"`
	Match       Match              `json:"match"`
	Excepted    bool               `json:"excepted"`
	GrantID     string             `json:"grantId,omitempty"`
	Unavailable string             `json:"unavailable,omitempty"`
}

type ContentResult struct {
	Action  string         `json:"action"`
	Matches []ContentMatch `json:"matches"`
	Decided int            `json:"-"`
}

type Decision struct {
	Intercepted bool            `json:"intercepted"`
	Service     *policy.Service `json:"service,omitempty"`
	Flow        *policy.Flow    `json:"flow,omitempty"`
	Content     *ContentResult  `json:"content,omitempty"`
	Verdict     string          `json:"verdict"`
	Enforced    bool            `json:"enforced"`
}
