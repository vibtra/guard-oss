// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package main

import (
	"net/http"
	"strings"
)

func connectMediaType(contentType string) bool {
	media := strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))
	return media == "application/connect+proto" || media == "application/proto" || media == "application/connect+json"
}

func inspectRequestBody(contentType string, headers http.Header, body []byte) (Extracted, map[string]any) {
	ex := Extracted{}
	facts := map[string]any{"state": "flow-only", "reason": "no-request-body", "textParts": 0}
	compressedText := encodedHTTP(headers) && (inspectable(contentType) || connectMediaType(contentType))
	wireBytes := len(body)
	encodingLabel := ""
	if compressedText {
		facts["wireBytes"] = len(body)
		var reason string
		body, reason = decodeHTTPBody(headers, body)
		if reason != "" {
			facts["reason"] = reason
			facts["coverageFailure"] = true
			return ex, facts
		}
		facts["decodedBytes"] = len(body)
		parts := strings.Split(httpEncoding(headers), ",")
		for i := range parts {
			parts[i] = strings.TrimSpace(parts[i])
		}
		encodingLabel = strings.Join(parts, ",")
		facts["httpEncoding"] = encodingLabel
		headers = headers.Clone()
		headers.Del("Content-Encoding")
	}
	switch {
	case len(body) == 0:
		return ex, facts
	case len(body) > inspectionLimit:
		facts["reason"] = "body-too-large"
		if connectMediaType(contentType) {
			facts["coverageFailure"] = true
		}
		return ex, facts
	case connectMediaType(contentType):
		parsed, metadata, err := extractConnect(contentType, headers, body)
		for k, v := range metadata {
			facts[k] = v
		}
		if compressedText {
			facts["wireBytes"] = wireBytes
			facts["httpEncoding"] = encodingLabel
		}
		if err != nil {
			facts["coverageFailure"] = true
			if facts["reason"] == "no-request-body" {
				facts["reason"] = "invalid-connect-body"
			}
			return ex, facts
		}
		ex = parsed
		if facts["format"] == nil {
			facts["format"] = "connect-protobuf"
		}
	case !inspectable(contentType):
		facts["reason"] = "unsupported-content-type"
		return ex, facts
	default:
		ex = extract(contentType, body)
		if strings.Contains(contentType, "json") {
			facts["format"] = "json"
		} else if strings.Contains(contentType, "form") {
			facts["format"] = "form"
		}
	}
	if facts["state"] != "partial" {
		facts["state"] = "inspected"
		delete(facts, "reason")
	}
	facts["textParts"] = len(ex.Spans)
	for _, span := range ex.Spans {
		if span.Label == "dsn" && publicSentryDSN(span.Text) {
			count, _ := facts["protocolDSNFields"].(int)
			facts["protocolDSNFields"] = count + 1
		}
	}
	return ex, facts
}
