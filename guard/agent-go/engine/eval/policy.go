// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package eval

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"time"

	"github.com/vibtra/guard/guard/agent-go/policy"
)

const Host = "api.eval.example"

var Now = time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)

func Catalogue() *policy.Catalogue {
	return &policy.Catalogue{Version: "eval", Services: []policy.Service{
		{ServiceID: "eval-ai", Name: "Eval AI", Vendor: "Example", Category: "chat", Domains: []string{Host}, BundleIDs: []string{}, CLINames: []string{}},
	}}
}

func rule(id string, d policy.Detector) policy.ContentRule {
	return policy.ContentRule{RuleID: id, Name: d.Kind, Detector: d, Services: json.RawMessage(`"*"`), Action: "block"}
}

func Bundle() *policy.Bundle {
	return &policy.Bundle{
		Protocol:         1,
		OrgID:            "org_eval",
		DeviceID:         "dev_eval",
		BundleVersion:    1,
		CatalogueVersion: "eval",
		ClientMode:       "enforce",
		DefaultAction:    "allow",
		Services:         map[string]policy.ServiceDecision{},
		ContentRules: []policy.ContentRule{
			rule("gcr_eval0001", policy.Detector{Kind: "au-tfn"}),
			rule("gcr_eval0002", policy.Detector{Kind: "au-medicare"}),
			rule("gcr_eval0003", policy.Detector{Kind: "au-abn"}),
			rule("gcr_eval0004", policy.Detector{Kind: "au-acn"}),
			rule("gcr_eval0005", policy.Detector{Kind: "card-number"}),
			rule("gcr_eval0006", policy.Detector{Kind: "secret"}),
			rule("gcr_eval0007", policy.Detector{Kind: "email-bulk", Threshold: 10}),
			rule("gcr_eval0008", policy.Detector{Kind: "phone-bulk", Threshold: 10}),
		},
		Exceptions: []policy.Exception{},
		Settings:   policy.Settings{SnippetPolicy: "redacted", SnippetMax: 80},
	}
}

func IdentifierBundle() *policy.Bundle {
	b := Bundle()
	b.ContentRules = []policy.ContentRule{
		rule("gcr_eval0001", policy.Detector{Kind: "au-tfn", RequireContext: true}),
		rule("gcr_eval0002", policy.Detector{Kind: "au-medicare", RequireContext: true}),
		rule("gcr_eval0003", policy.Detector{Kind: "card-number"}),
		rule("gcr_eval0004", policy.Detector{Kind: "secret"}),
		rule("gcr_eval0005", policy.Detector{Kind: "identifiers"}),
		rule("gcr_eval0006", policy.Detector{Kind: "email-bulk", Threshold: 10}),
		rule("gcr_eval0007", policy.Detector{Kind: "phone-bulk", Threshold: 10}),
	}
	return b
}

func Digest(v any) string {
	b, _ := json.Marshal(v)
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}
