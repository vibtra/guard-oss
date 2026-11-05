// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package main

func requestCategory(host, method, path string) string {
	if method == "GET" || method == "HEAD" {
		return "navigation-or-fetch"
	}
	if host == "ab.chatgpt.com" {
		return "background"
	}
	if host == "chatgpt.com" || host == "chat.openai.com" {
		switch path {
		case "/backend-api/conversation", "/backend-anon/conversation":
			return "conversation"
		case "/backend-api/sentinel/chat-requirements", "/backend-anon/sentinel/chat-requirements", "/backend-api/sentinel/chat-requirements/prepare", "/backend-api/sentinel/chat-requirements/finalize":
			return "session-check"
		case "/ces/v1/t", "/backend-api/lat/r", "/backend-api/telemetry":
			return "background"
		}
	}
	return "unclassified"
}
