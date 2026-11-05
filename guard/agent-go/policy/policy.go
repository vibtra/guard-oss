// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package policy

import (
	"encoding/json"
	"net"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
)

type Detector struct {
	Kind           string   `json:"kind"`
	RequireContext bool     `json:"requireContext,omitempty"`
	Threshold      int      `json:"threshold,omitempty"`
	Rules          []string `json:"rules,omitempty"`
	Keywords       []string `json:"keywords,omitempty"`
	WholeWord      bool     `json:"wholeWord,omitempty"`
	Extensions     []string `json:"extensions,omitempty"`
}
type Person struct {
	UserID string `json:"userId"`
	Email  string `json:"email"`
	Name   string `json:"name,omitempty"`
}
type Service struct {
	ServiceID string   `json:"serviceId"`
	Name      string   `json:"name"`
	Vendor    string   `json:"vendor"`
	Category  string   `json:"category"`
	Domains   []string `json:"domains"`
	BundleIDs []string `json:"bundleIds"`
	CLINames  []string `json:"cliNames"`
	Enabled   *bool    `json:"enabled,omitempty"`
	Custom    bool     `json:"custom"`
}
type Catalogue struct {
	Version     string    `json:"version"`
	GeneratedAt string    `json:"generatedAt"`
	Services    []Service `json:"services"`
}
type ServiceDecision struct {
	Action string `json:"action"`
	RuleID string `json:"ruleId,omitempty"`
	Note   string `json:"note,omitempty"`
}
type ContentRule struct {
	RuleID   string          `json:"ruleId"`
	Name     string          `json:"name"`
	Detector Detector        `json:"detector"`
	Services json.RawMessage `json:"services"`
	Action   string          `json:"action"`
	Note     string          `json:"note,omitempty"`
}
type Exception struct {
	GrantID   string `json:"grantId"`
	ServiceID string `json:"serviceId"`
	RuleID    string `json:"ruleId,omitempty"`
	Scope     string `json:"scope"`
	ExpiresAt string `json:"expiresAt,omitempty"`
}
type Settings struct {
	UnreproducibleTLS string `json:"unreproducibleTls,omitempty"`
	RequestsEnabled   bool   `json:"requestsEnabled"`
	WorkspaceRedirect struct {
		Enabled bool   `json:"enabled"`
		URL     string `json:"url,omitempty"`
	} `json:"workspaceRedirect"`
	SnippetPolicy string `json:"snippetPolicy"`
	SnippetMax    int    `json:"snippetMax"`
}
type Bundle struct {
	Protocol         int                        `json:"protocol"`
	OrgID            string                     `json:"orgId"`
	DeviceID         string                     `json:"deviceId"`
	BundleVersion    uint64                     `json:"bundleVersion"`
	CatalogueVersion string                     `json:"catalogueVersion"`
	GeneratedAt      string                     `json:"generatedAt"`
	Person           Person                     `json:"person"`
	ClientMode       string                     `json:"clientMode"`
	DefaultAction    string                     `json:"defaultAction"`
	Services         map[string]ServiceDecision `json:"services"`
	SurfaceBlocks    map[string]bool            `json:"surfaceBlocks,omitempty"`
	ContentRules     []ContentRule              `json:"contentRules"`
	Exceptions       []Exception                `json:"exceptions"`
	Settings         Settings                   `json:"settings"`
}
type Flow struct {
	SurfaceID     string `json:"surfaceId,omitempty"`
	CoverageEntry string `json:"coverageEntry,omitempty"`
	Action        string `json:"action"`
	Source        string `json:"source"`
	RuleID        string `json:"ruleId,omitempty"`
	GrantID       string `json:"grantId,omitempty"`
	Note          string `json:"note,omitempty"`
}

var hostRegexes sync.Map

func HostMatch(pattern, host string) bool {
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	} else if strings.Count(host, ":") == 1 {
		host = strings.SplitN(host, ":", 2)[0]
	}
	host = strings.TrimSuffix(strings.ToLower(host), ".")
	pattern = strings.TrimSuffix(strings.ToLower(pattern), ".")
	if !strings.Contains(pattern, "*") {
		return host == pattern || strings.HasSuffix(host, "."+pattern)
	}
	re := "^" + strings.ReplaceAll(regexp.QuoteMeta(pattern), `\*`, `[a-z0-9-]+`) + "$"
	compiled, _ := hostRegexes.LoadOrStore(re, regexp.MustCompile(re))
	return compiled.(*regexp.Regexp).MatchString(host)
}
func (c *Catalogue) Service(host, bundleID, cli string) *Service {
	if c == nil {
		return nil
	}
	for i := range c.Services {
		s := &c.Services[i]
		if (bundleID != "" && slices.Contains(s.BundleIDs, bundleID)) || (cli != "" && slices.Contains(s.CLINames, cli)) {
			for _, pattern := range s.Domains {
				if HostMatch(pattern, host) {
					if s.Enabled != nil && !*s.Enabled {
						return nil
					}
					return s
				}
			}
		}
	}
	var best *Service
	length := -1
	for i := range c.Services {
		s := &c.Services[i]
		if s.Enabled != nil && !*s.Enabled {
			continue
		}
		matched := false
		for _, p := range s.Domains {
			if HostMatch(p, host) {
				matched = true
				if len(p) > length {
					length = len(p)
					best = s
				}
			}
		}
		if matched && (bundleID != "" && slices.Contains(s.BundleIDs, bundleID) || cli != "" && slices.Contains(s.CLINames, cli)) {
			return s
		}
	}
	return best
}

func (b *Bundle) Exception(service, rule string, now time.Time) *Exception {
	for i := range b.Exceptions {
		e := &b.Exceptions[i]
		if e.ServiceID != service || e.RuleID != rule {
			continue
		}
		if e.ExpiresAt != "" {
			at, err := time.Parse(time.RFC3339Nano, e.ExpiresAt)
			if err != nil || !at.After(now) {
				continue
			}
		}
		return e
	}
	return nil
}
func (b *Bundle) Flow(service string, now time.Time) Flow {
	if e := b.Exception(service, "", now); e != nil {
		return Flow{Action: "allow", Source: "exception", GrantID: e.GrantID}
	}
	if d, ok := b.Services[service]; ok {
		src := "default"
		if d.RuleID != "" {
			src = "rule"
		}
		return Flow{Action: d.Action, Source: src, RuleID: d.RuleID, Note: d.Note}
	}
	return Flow{Action: b.DefaultAction, Source: "default"}
}
