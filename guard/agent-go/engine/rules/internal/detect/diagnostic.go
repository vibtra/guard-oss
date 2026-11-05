// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package detect

import (
	"encoding/json"
	"strconv"
	"strings"

	"github.com/vibtra/guard/guard/agent-go/engine"
)

func diagnosticField(label string) string {
	switch strings.ToLower(label) {
	case "":
		return "unlabelled"
	case "token", "jwt", "access_token", "id_token", "refresh_token", "captcha_token", "turnstile_token", "cf_turnstile_response", "cf-turnstile-response", "authorization", "session_token":
		return "protocol-token"
	case "timestamp", "time", "ts", "created_at", "duration", "latency", "start_time", "end_time":
		return "time-or-duration"
	case "id", "event_id", "trace_id", "session_id", "request_id", "distinct_id":
		return "identifier"
	case "dsn":
		return "telemetry-dsn"
	case "url", "uri", "endpoint":
		return "url"
	case "prompt", "text", "content", "message", "parts", "input":
		return "message-text"
	case "medicare_number", "medicare_no", "tfn", "tax_file_number", "card_number", "credit_card":
		return "labelled-sensitive-number"
	default:
		return "other"
	}
}
func diagnosticShape(s string) string {
	s = strings.TrimSpace(s)
	if json.Valid([]byte(s)) {
		if strings.HasPrefix(s, "{") {
			return "json-object"
		}
		if strings.HasPrefix(s, "[") {
			return "json-array"
		}
	}
	if _, e := strconv.ParseFloat(s, 64); e == nil {
		if strings.ContainsAny(s, ".eE") {
			return "decimal-number"
		}
		return "integer"
	}
	lines := strings.Split(s, "\n")
	if len(lines) > 1 {
		allJSON := true
		for _, line := range lines {
			if strings.TrimSpace(line) != "" && !json.Valid([]byte(line)) {
				allJSON = false
			}
		}
		if allJSON {
			return "json-lines"
		}
	}
	return "text"
}
func diagnosticBoundary(s string, i int) string {
	if i < 0 || i >= len(s) {
		return "edge"
	}
	c := s[i]
	if digit(c) {
		return "digit"
	}
	if word(c) {
		return "letter-or-underscore"
	}
	switch c {
	case ' ', '\t', '\r', '\n':
		return "whitespace"
	case '.':
		return "dot"
	case '-':
		return "hyphen"
	case '/':
		return "slash"
	case '=':
		return "equals"
	case ':':
		return "colon"
	case '\'', '"':
		return "quote"
	case ',':
		return "comma"
	case ';':
		return "semicolon"
	case '&':
		return "ampersand"
	case '%':
		return "percent"
	case '+':
		return "plus"
	case '(', ')', '[', ']', '{', '}':
		return "bracket"
	default:
		return "other"
	}
}
func numericFragment(s string, a, b int) bool {
	return a > 1 && s[a-1] == '.' && digit(s[a-2]) || b+1 < len(s) && s[b] == '.' && digit(s[b+1])
}
func diagnosticMatch(kind, pattern, view, label, s string, a, b int, textContext, fieldContext bool) engine.MatchDiagnostic {
	return engine.MatchDiagnostic{Detector: kind, Pattern: pattern, View: view, FieldClass: diagnosticField(label), SpanShape: diagnosticShape(s), SpanLength: len(s), CandidateLength: b - a, CandidateDigits: len(digits(s[a:b])), WholeSpan: strings.TrimSpace(s) == s[a:b], TextContext: textContext, FieldContext: fieldContext, NumericFragment: numericFragment(s, a, b), BeforeClass: diagnosticBoundary(s, a-1), AfterClass: diagnosticBoundary(s, b)}
}
