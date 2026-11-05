// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const guardPolicyVersion = "vibtra.policy/v1"
const guardDecisionHeader = "x-vibtra-policy-decision"

type guardRefusalReason struct {
	Code   string `json:"code"`
	Text   string `json:"text"`
	Policy string `json:"policy"`
}
type guardRefusalPolicy struct {
	ID       string `json:"id"`
	Revision string `json:"revision"`
}
type guardRefusalNext struct {
	Kind string `json:"kind"`
	Text string `json:"text"`
}
type guardRefusalSubject struct {
	Family string `json:"family"`
	Action string `json:"action"`
}
type guardRefusalEnvelope struct {
	Version  string               `json:"version"`
	ID       string               `json:"id"`
	Time     string               `json:"time"`
	OrgID    string               `json:"orgId"`
	Subject  guardRefusalSubject  `json:"subject"`
	Decision string               `json:"decision"`
	Reasons  []guardRefusalReason `json:"reasons"`
	Policies []guardRefusalPolicy `json:"policies"`
	Message  string               `json:"message"`
	Next     []guardRefusalNext   `json:"next"`
}

var guardRefusalOrgID = regexp.MustCompile(`^(org_[A-Za-z0-9_]{1,96}|[A-Za-z0-9]{16,64})$`)
var guardRefusalRuleID = regexp.MustCompile(`^(gcr|gsr)_[a-f0-9]{8,64}$`)

func (a *Agent) refusalEnvelope(b Block) guardRefusalEnvelope {
	org := "org_unknown"
	_, _, d := a.snapshot()
	if d != nil && guardRefusalOrgID.MatchString(d.OrgID) {
		org = d.OrgID
	}
	id := b.Event.EventID
	if id == "" {
		id = eventID()
	}
	digest := sha256.Sum256([]byte("guard-refusal:" + id))
	instant, err := time.Parse(time.RFC3339Nano, b.Event.OccurredAt)
	if err != nil {
		instant = time.Now()
	}
	env := guardRefusalEnvelope{
		Version: guardPolicyVersion, ID: "pd_" + hex.EncodeToString(digest[:16]),
		Time: instant.UTC().Format("2006-01-02T15:04:05.000Z"), OrgID: org,
		Subject:  guardRefusalSubject{Family: "connection", Action: "Send a request to an AI service"},
		Decision: "deny",
	}
	code, reason, policy := "GUARD_SERVICE_BLOCKED", "Your organisation's Guard policy blocks this AI service.", "guard.services"
	switch {
	case strings.HasPrefix(b.Event.Reason, "surface-block:"):
		code, reason, policy = "GUARD_SURFACE_BLOCKED", "Your organisation's Guard surface policy blocks this action.", "guard.surfaces"
		env.Next = []guardRefusalNext{{Kind: "ask-person", Text: "Ask your administrator to review this surface block; per-request approval cannot override it."}}
	case b.Event.Reason == "http-coverage" || b.Event.Reason == "websocket-coverage":
		code, reason, policy = "GUARD_INSPECTION_UNAVAILABLE", "Guard could not inspect this request safely, so it was not sent.", "guard.inspection"
		env.Next = []guardRefusalNext{{Kind: "ask-person", Text: "Ask your administrator to review Guard's inspection coverage before retrying."}}
	case b.Event.Action == "asked":
		code, reason, policy = "GUARD_APPROVAL_REQUIRED", "This request requires approval and was not sent.", "guard.approval"
	case b.Event.Kind == "content":
		code, reason, policy = "GUARD_CONTENT_BLOCKED", "A Guard content rule matched data in this request, so it was not sent.", "guard.content"
		env.Next = []guardRefusalNext{{Kind: "retry", Text: "Remove or replace the matched data before retrying; do not resend the unchanged request."}}
	}
	if len(env.Next) == 0 {
		if b.RequestsEnabled {
			env.Next = []guardRefusalNext{{Kind: "ask-person", Text: "Ask the person to open Guard's local block page and request access; retry only after approval is applied."}}
		} else {
			env.Next = []guardRefusalNext{{Kind: "ask-person", Text: "Ask your organisation's administrator to review this policy; access requests are disabled on this device."}}
		}
	}
	if b.Workspace != "" && code != "GUARD_INSPECTION_UNAVAILABLE" {
		env.Next = append(env.Next, guardRefusalNext{Kind: "use", Text: "Use the company workspace offered on Guard's local block page if it is suitable for this task."})
	}
	if guardRefusalRuleID.MatchString(b.Event.RuleID) && code != "GUARD_INSPECTION_UNAVAILABLE" {
		policy = b.Event.RuleID
	}
	env.Reasons = []guardRefusalReason{{Code: code, Text: reason, Policy: policy}}
	env.Policies = []guardRefusalPolicy{{ID: policy, Revision: "bundle:" + strconv.FormatUint(b.Event.BundleVersion, 10)}}
	env.Message = reason + " " + env.Next[0].Text
	return env
}
func (e guardRefusalEnvelope) line() string {
	return fmt.Sprintf("vibtra: blocked — %s (decision %s)", e.Message, e.ID)
}
