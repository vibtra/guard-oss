// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package main

import (
	"context"
	"encoding/json"

	"github.com/vibtra/guard/guard/agent-go/engine"
	"github.com/vibtra/guard/guard/agent-go/policy"
)

type SigningKey struct {
	KeyID        string `json:"keyId"`
	Alg          string `json:"alg"`
	PublicKeyPEM string `json:"publicKeyPem"`
}
type ServerFacts struct {
	BaseURL             string `json:"baseUrl"`
	SyncIntervalSeconds int    `json:"syncIntervalSeconds"`
	BatchSize           int    `json:"batchSize"`
}
type Device struct {
	DeviceID   string        `json:"deviceId"`
	OrgID      string        `json:"orgId"`
	OrgHandle  string        `json:"orgHandle"`
	OrgName    string        `json:"orgName"`
	Person     policy.Person `json:"person"`
	Signing    SigningKey    `json:"signing"`
	Server     ServerFacts   `json:"server"`
	ClientMode string        `json:"clientMode"`
	EnrolledAt string        `json:"enrolledAt"`
	Revoked    bool          `json:"revoked"`
	RevokedAt  string        `json:"revokedAt,omitempty"`
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
	return contains(ids, service)
}
func contains(ss []string, s string) bool {
	for _, v := range ss {
		if v == s {
			return true
		}
	}
	return false
}

func decide(ctx context.Context, eng engine.Engine, req engine.Request) (engine.Decision, error) {
	v, err := eng.Decide(ctx, req)
	if err != nil {
		return v, err
	}
	return v, engine.Validate(v)
}
