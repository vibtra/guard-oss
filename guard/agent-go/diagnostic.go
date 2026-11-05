// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package main

import (
	"net/url"
	"regexp"
	"strings"
)

func diagnosticMediaType(header string) string {
	media := strings.ToLower(strings.TrimSpace(strings.Split(header, ";")[0]))
	switch media {
	case "", "text/plain", "text/event-stream", "application/json", "application/x-www-form-urlencoded", "multipart/form-data", "application/octet-stream", "application/x-protobuf", "application/protobuf", "application/proto", "application/cbor", "application/msgpack", "application/connect+json", "application/connect+proto", "application/grpc-web+proto", "application/grpc-web-text", "application/grpc+proto", "application/x-sentry-envelope":
		return media
	default:
		return "other"
	}
}

func diagnosticRoute(path string) string {
	allowed := map[string]bool{}
	for _, s := range []string{"api", "rest", "v1", "v2", "events", "metrics", "telemetry", "logs", "rum", "chat", "conversation", "traces", "batch", "cdn-cgi", "challenge-platform", "verify", "token", "auth", "sessions", "ingest", "collect", "analytics", "report", "reports", "ccr-sessions", "ws", "session_ingress", "session", "chat_conversations", "organizations", "completion", "messages", "stream", "socket", "submit", "turns", "envelope"} {
		allowed[s] = true
	}
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) > 8 {
		parts = parts[:8]
	}
	for i, p := range parts {
		if !allowed[p] {
			parts[i] = "_"
		}
	}
	return "/" + strings.Join(parts, "/")
}

var sentryPublicKey = regexp.MustCompile(`^[0-9a-fA-F]{32}$`)
var sentryProjectPath = regexp.MustCompile(`^/[0-9]+$`)
var sentryPublicURL = regexp.MustCompile(`(?i)^https://[0-9a-f]{32}@[a-z0-9.-]+\.sentry\.io/[0-9]+$`)

func publicSentryDSN(s string) bool {
	if !sentryPublicURL.MatchString(s) {
		return false
	}
	u, err := url.Parse(s)
	if err != nil || u.Scheme != "https" || u.User == nil || u.RawQuery != "" || u.Fragment != "" || u.Port() != "" {
		return false
	}
	_, password := u.User.Password()
	return !password && sentryPublicKey.MatchString(u.User.Username()) && strings.HasSuffix(strings.ToLower(u.Hostname()), ".sentry.io") && sentryProjectPath.MatchString(u.EscapedPath())
}
