// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package main

import (
	"embed"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/vibtra/guard/guard/agent-go/engine"
	"github.com/vibtra/guard/guard/agent-go/policy"
)

//go:embed surface-coverage.json
var surfaceFiles embed.FS

type surfaceEntry struct {
	ID          string `json:"id"`
	Surface     string `json:"surface"`
	Action      string `json:"action"`
	Host        string `json:"host"`
	Method      string `json:"method"`
	Transport   string `json:"transport"`
	PathMatcher struct {
		Kind  string `json:"kind"`
		Value string `json:"value"`
	} `json:"pathMatcher"`
	IdentityRequirement struct {
		Kind      string `json:"kind"`
		Allowlist []struct {
			SigningID string `json:"signingId"`
			TeamID    string `json:"teamId"`
		} `json:"allowlist"`
		SelectedSurfaceProofRequired bool `json:"selectedSurfaceProofRequired"`
	} `json:"identityRequirement"`
	Validation struct {
		Status string `json:"status"`
	} `json:"validation"`
}

var surfaceEntries = func() []surfaceEntry {
	data, err := surfaceFiles.ReadFile("surface-coverage.json")
	if err != nil {
		panic(err)
	}
	var manifest struct {
		SchemaVersion int            `json:"schemaVersion"`
		Entries       []surfaceEntry `json:"entries"`
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		panic(err)
	}
	if manifest.SchemaVersion != 1 {
		panic("unsupported surface manifest")
	}
	return manifest.Entries
}()

var surfaceIdentityKind = map[string]string{"claude-web": "verified-browser", "chatgpt-web": "verified-browser", "claude-macos": "verified-native", "chatgpt-macos": "verified-native"}

func surfaceRouteShape(method, transport string) bool {
	switch transport {
	case "http-json", "http-form":
		return method == "POST"
	case "websocket":
		return method == "GET"
	}
	return false
}

func executableSurface(e surfaceEntry) bool {
	kind, ok := surfaceIdentityKind[e.Surface]
	return ok && e.Action == "text-chat-send" && surfaceRouteShape(e.Method, e.Transport) &&
		(e.Validation.Status == "candidate" || e.Validation.Status == "verified") &&
		e.IdentityRequirement.Kind == kind && !e.IdentityRequirement.SelectedSurfaceProofRequired &&
		len(e.IdentityRequirement.Allowlist) > 0 &&
		(e.PathMatcher.Kind == "exact" || e.PathMatcher.Kind == "segments") && strings.HasPrefix(e.PathMatcher.Value, "/")
}
func supportedSurfaceBlocks() []string {
	out := []string{}
	for _, id := range []string{"claude-web", "claude-macos", "chatgpt-web", "chatgpt-macos"} {
		for _, e := range surfaceEntries {
			if e.Surface == id && executableSurface(e) {
				out = append(out, id)
				break
			}
		}
	}
	return out
}
func validateSurfaceBlocks(blocks map[string]bool) error {
	for id, on := range blocks {
		switch id {
		case "claude-web", "claude-macos", "chatgpt-web", "chatgpt-macos":
		default:
			return errors.New("unsupported surface control")
		}
		if on && !contains(supportedSurfaceBlocks(), id) {
			return errors.New("surface coverage unavailable; keeping last verified policy")
		}
	}
	return nil
}

func surfacePathMatches(kind, pattern, path string) bool {
	if strings.ContainsAny(path, "\\%?#") {
		return false
	}
	if kind == "exact" {
		return path == pattern
	}
	if kind != "segments" {
		return false
	}
	want, got := strings.Split(pattern, "/"), strings.Split(path, "/")
	if len(want) != len(got) {
		return false
	}
	for i, part := range want {
		if part == "{id}" {
			if got[i] == "" || got[i] == "." || got[i] == ".." {
				return false
			}
		} else if part != got[i] {
			return false
		}
	}
	return true
}

func matchSurface(b *policy.Bundle, host string, r *http.Request, identity processAttribution) *surfaceEntry {
	if b == nil || len(b.SurfaceBlocks) == 0 || !identity.verifiedApp() || identity.Source != "network-extension" {
		return nil
	}
	raw := strings.ToLower(r.URL.EscapedPath())
	if strings.Contains(raw, "%2f") || strings.Contains(raw, "%5c") {
		return nil
	}
	for i := range surfaceEntries {
		e := &surfaceEntries[i]
		if !b.SurfaceBlocks[e.Surface] || !executableSurface(*e) || e.Host != host || e.Method != r.Method || !surfacePathMatches(e.PathMatcher.Kind, e.PathMatcher.Value, r.URL.Path) {
			continue
		}
		if e.Transport == "websocket" && !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			continue
		}
		for _, allowed := range e.IdentityRequirement.Allowlist {
			if allowed.TeamID != "" && allowed.TeamID == identity.TeamID && allowed.SigningID == identity.SigningID {
				return e
			}
		}
	}
	return nil
}

func (e *surfaceEntry) engineSurface() *engine.Surface {
	if e == nil {
		return nil
	}
	return &engine.Surface{Surface: e.Surface, CoverageEntry: e.ID}
}
