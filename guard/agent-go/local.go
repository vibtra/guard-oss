// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package main

import (
	"encoding/json"
	"fmt"
	"html"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

func jsonResponse(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func (a *Agent) status() map[string]any {
	trusted := a.caTrusted()
	q := len(a.queued())
	a.mu.RLock()
	defer a.mu.RUnlock()
	counts := map[string]int{}
	for k, v := range a.today {
		counts[k] = v
	}
	state := "not enrolled"
	mode := "monitor"
	upstreamTransport := a.upstreamTransportStats()
	upstreamTransport["kind"] = "utls"
	upstreamTransport["available"] = a.listening
	out := map[string]any{"enrolled": a.device != nil && !a.device.Revoked, "agentVersion": "0.1.0", "implementation": "go", "hostname": a.deviceFacts["hostname"], "catalogueVersion": a.catalogue.Version, "catalogueSource": a.catSource, "lastSync": map[string]any{"at": a.state.LastSyncAt, "ok": a.state.LastSyncOK, "error": a.state.LastError}, "signingKeyMismatch": a.state.SigningKeyMismatch, "queuedEvents": q, "today": counts, "ca": a.ca.status(), "interception": a.ca.interception(), "caTrusted": trusted, "proxyListening": a.listening, "proxy": a.proxyAddr, "local": "http://" + a.localAddr, "uptimeSeconds": int(time.Since(a.started).Seconds()), "upstreamTransport": upstreamTransport}
	out["pid"] = os.Getpid()
	out["capabilities"] = map[string]int{"nativeRelayAttribution": 1, "nativeRelaySteering": 1, "surfaceBlocks": 1}
	out["supportedSurfaceBlocks"] = supportedSurfaceBlocks()
	if d := a.device; d != nil {
		state = "waiting for rules"
		mode = d.ClientMode
		out["deviceId"] = d.DeviceID
		out["org"] = map[string]string{"orgId": d.OrgID, "handle": d.OrgHandle, "name": d.OrgName}
		out["person"] = d.Person
		out["server"] = d.Server.BaseURL
		out["revoked"] = d.Revoked
		if d.Revoked {
			state = "revoked"
		}
	}
	if b := a.bundle; b != nil {
		state = "enforcing"
		if b.ClientMode == "monitor" {
			state = "monitoring"
		}
		mode = b.ClientMode
		out["bundleVersion"] = b.BundleVersion
		out["bundleDigest"] = a.digest
		out["settings"] = b.Settings
	}
	out["state"] = state
	out["clientMode"] = mode
	if a.engineName != "" {
		out["engine"] = a.engineName
	}
	return out
}
func (a *Agent) policy() map[string]any {
	b, c, _ := a.snapshot()
	services, rules := []any{}, []any{}
	out := map[string]any{"available": b != nil, "services": services, "contentRules": rules}
	if b == nil {
		return out
	}
	for _, s := range c.Services {
		if s.Enabled != nil && !*s.Enabled {
			continue
		}
		f := b.Flow(s.ServiceID, time.Now())
		services = append(services, map[string]any{"id": s.ServiceID, "name": s.Name, "action": f.Action, "source": f.Source, "note": f.Note})
	}
	warnings := []string{}
	for _, r := range b.ContentRules {
		if (r.Detector.Kind == "au-medicare" || r.Detector.Kind == "au-tfn" || r.Detector.Kind == "au-acn") && !r.Detector.RequireContext && (r.Action == "block" || r.Action == "ask") {
			warnings = append(warnings, r.Name+": context checking is off; ordinary numeric IDs may trigger this rule. Review it in the console.")
		}
		names := []string{}
		for _, s := range c.Services {
			if (s.Enabled == nil || *s.Enabled) && applies(r.Services, s.ServiceID) {
				names = append(names, s.Name)
			}
		}
		rules = append(rules, map[string]any{"id": r.RuleID, "name": r.Name, "action": r.Action, "note": r.Note, "detector": r.Detector.Kind, "detectorConfiguration": r.Detector, "serviceNames": names})
	}
	out["warnings"] = warnings
	out["mode"] = b.ClientMode
	out["bundleVersion"] = b.BundleVersion
	out["services"] = services
	out["contentRules"] = rules
	out["surfaceBlocks"] = b.SurfaceBlocks
	return out
}
func (a *Agent) local(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	host, _, e := net.SplitHostPort(r.Host)
	if e != nil {
		host = r.Host
	}
	if host != "127.0.0.1" && host != "localhost" && host != "::1" && host != "guard.vibtra.local" {
		http.Error(w, "loopback host required", http.StatusForbidden)
		return
	}
	path := r.URL.Path
	if r.Method == "GET" {
		switch path {
		case "/diagnostics/tls":
			a.localTLSDiagnostics(w, r)
			return
		case "/healthz":
			_, _ = io.WriteString(w, "ok\n")
			return
		case "/status":
			jsonResponse(w, 200, a.status())
			return
		case "/policy":
			jsonResponse(w, 200, a.policy())
			return
		case "/activity":
			a.mu.RLock()
			events := append([]map[string]any{}, a.activity...)
			a.mu.RUnlock()
			jsonResponse(w, 200, map[string]any{"events": events, "limit": 300})
			return
		case "/ca.pem":
			_, certPEM := a.ca.certificate()
			if certPEM == nil {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Type", "application/x-pem-file")
			_, _ = w.Write(certPEM)
			return
		case "/events":
			a.sse(w, r)
			return
		case "/":
			_, _ = io.WriteString(w, "Vibtra Guard is running\n")
			return
		}
	}
	if r.Method == "POST" && (path == "/ca/hold" || path == "/ca/reload") {
		if path == "/ca/hold" {
			a.ca.hold()
		} else {
			a.ca.reload()
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) < 2 || parts[0] != "blocked" {
		http.NotFound(w, r)
		return
	}
	id := parts[1]
	a.mu.RLock()
	block, ok := a.blocks[id]
	a.mu.RUnlock()
	if !ok {
		jsonResponse(w, 404, map[string]string{"code": "GUARD_EVENT_UNKNOWN"})
		return
	}
	base := "http://" + a.localAddr + "/blocked/" + id
	if r.Method == "OPTIONS" {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST")
		w.Header().Set("Access-Control-Allow-Headers", "content-type")
		w.Header().Set("Access-Control-Allow-Private-Network", "true")
		w.WriteHeader(204)
		return
	}
	if len(parts) == 2 && r.Method == "GET" {
		a.blockHTML(w, block)
		return
	}
	if len(parts) == 3 {
		switch parts[2] {
		case "request":
			if r.Method != "POST" {
				break
			}
			if !block.RequestsEnabled {
				jsonResponse(w, 403, map[string]string{"code": "GUARD_REQUESTS_OFF"})
				return
			}
			r.Body = http.MaxBytesReader(w, r.Body, 64*1024)
			var note string
			if strings.Contains(r.Header.Get("Content-Type"), "application/json") {
				var body struct {
					Note string `json:"note"`
				}
				if json.NewDecoder(r.Body).Decode(&body) != nil {
					http.Error(w, "invalid request", 400)
					return
				}
				note = body.Note
			} else {
				_ = r.ParseForm()
				note = r.Form.Get("note")
			}
			body := map[string]any{"serviceId": block.Event.ServiceID, "eventId": id}
			if block.Event.RuleKind == "content" {
				body["ruleId"] = block.Event.RuleID
			}
			if block.Event.MatchType != "" {
				body["matchType"] = block.Event.MatchType
			}
			if note = strings.TrimSpace(note); note != "" {
				rr := []rune(note)
				body["note"] = string(rr[:min(280, len(rr))])
			}
			_, _, d := a.snapshot()
			if d == nil {
				http.Error(w, "not enrolled", http.StatusConflict)
				return
			}
			var res map[string]any
			if e := a.call(r.Context(), "POST", "/requests/"+d.DeviceID, body, &res); e != nil {
				jsonResponse(w, 502, map[string]string{"code": "GUARD_REQUEST_FAILED", "message": e.Error()})
				return
			}
			ask, _ := res["request"].(map[string]any)
			a.mu.Lock()
			a.asks[id] = ask
			a.mu.Unlock()
			ev := block.Event
			ev.EventID = eventID()
			ev.OccurredAt = nowISO()
			ev.Action = "requested"
			ev.RequestID, _ = ask["requestId"].(string)
			_ = a.appendEvent(ev)
			select {
			case a.wake <- struct{}{}:
			default:
			}
			if strings.Contains(r.Header.Get("Accept"), "text/html") || strings.Contains(r.Header.Get("Content-Type"), "form-urlencoded") {
				http.Redirect(w, r, base, http.StatusSeeOther)
			} else {
				w.Header().Set("Access-Control-Allow-Origin", "*")
				jsonResponse(w, 200, res)
			}
			return
		case "status":
			if r.Method != "GET" {
				break
			}
			a.refreshAsks(r)
			a.mu.RLock()
			ask := a.asks[id]
			a.mu.RUnlock()
			b, _, _ := a.snapshot()
			rule := block.Event.RuleID
			if block.Event.RuleKind != "content" {
				rule = ""
			}
			applied := b != nil && b.Exception(block.Event.ServiceID, rule, time.Now()) != nil
			out := map[string]any{"eventId": id, "status": "none", "applied": applied}
			for _, k := range []string{"status", "requestId", "grantExpiresAt", "decisionNote"} {
				if v := ask[k]; v != nil {
					out[k] = v
				}
			}
			if ask["status"] == "approved" && !applied {
				select {
				case a.wake <- struct{}{}:
				default:
				}
			}
			w.Header().Set("Access-Control-Allow-Origin", "*")
			jsonResponse(w, 200, out)
			return
		case "workspace":
			if r.Method == "GET" && block.Workspace != "" {
				u, e := url.Parse(block.Workspace)
				if e == nil && (u.Scheme == "http" || u.Scheme == "https") {
					ev := block.Event
					ev.EventID = eventID()
					ev.OccurredAt = nowISO()
					ev.Action = "redirected"
					_ = a.appendEvent(ev)
					http.Redirect(w, r, block.Workspace, http.StatusFound)
					return
				}
			}
		}
	}
	http.NotFound(w, r)
}
func (a *Agent) refreshAsks(r *http.Request) {
	_, _, d := a.snapshot()
	if d == nil {
		return
	}
	a.mu.RLock()
	pending := false
	for _, v := range a.asks {
		if v["status"] == "pending" {
			pending = true
		}
	}
	a.mu.RUnlock()
	if !pending {
		return
	}
	var res struct {
		Requests []map[string]any `json:"requests"`
	}
	if a.call(r.Context(), "GET", "/requests/"+d.DeviceID, nil, &res) != nil {
		return
	}
	updates := []map[string]any{}
	a.mu.Lock()
	for id, held := range a.asks {
		for _, v := range res.Requests {
			if v["requestId"] == held["requestId"] {
				a.asks[id] = v
				if v["status"] != held["status"] {
					msg := map[string]any{"eventId": id}
					for k, x := range v {
						msg[k] = x
					}
					updates = append(updates, msg)
				}
			}
		}
	}
	a.mu.Unlock()
	for _, v := range updates {
		a.emit("ask-decided", v)
		if v["status"] == "approved" {
			select {
			case a.wake <- struct{}{}:
			default:
			}
		}
	}
}
func (a *Agent) sse(w http.ResponseWriter, r *http.Request) {
	f, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "stream unavailable", 500)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	ch, unsubscribe := a.subscribe()
	defer unsubscribe()
	_, _ = io.WriteString(w, ": vibtra-guard events\n\n")
	f.Flush()
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			if _, e := io.WriteString(w, ": keep-alive\n\n"); e != nil {
				return
			}
			f.Flush()
		case msg := <-ch:
			b, _ := json.Marshal(msg.Data)
			if _, e := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", msg.Name, b); e != nil {
				return
			}
			f.Flush()
		}
	}
}
func (a *Agent) writeBlockResponse(w http.ResponseWriter, r *http.Request, b Block) {
	w.Header().Set("Cache-Control", "no-store")
	envelope := a.refusalEnvelope(b)
	w.Header().Set(guardDecisionHeader, envelope.ID)
	if strings.Contains(r.Header.Get("Accept"), "text/html") {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(403)
		a.blockHTML(w, b)
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Credentials", "true")
		w.Header().Set("Access-Control-Expose-Headers", "x-vibtra-guard, "+guardDecisionHeader)
	}
	action := "block"
	if b.Event.Action == "asked" {
		action = "ask"
	}
	out := map[string]any{"code": "GUARD_BLOCKED", "eventId": b.Event.EventID, "action": action, "blockPage": "http://" + a.localAddr + "/blocked/" + b.Event.EventID, "requestsEnabled": b.RequestsEnabled, "service": b.Event.ServiceID, "message": "Guard stopped this request under your organisation's AI policy."}
	out["error"] = envelope.line()
	out["reason"] = envelope.Message
	out["policy"] = envelope
	if b.Event.RuleID != "" {
		out["ruleId"] = b.Event.RuleID
	}
	if b.Event.Reason == "model_not_ready" || b.Event.Reason == "engine-capability" {
		out["unavailable"] = b.Event.Reason
	}
	if b.Workspace != "" {
		out["workspace"] = b.Workspace
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusForbidden)
	_ = json.NewEncoder(w).Encode(out)
}

const (
	blockDeliveryPage   = "page"
	blockDeliveryNotice = "notice"
)

func blockDelivery(r *http.Request) string {
	if !strings.Contains(r.Header.Get("Accept"), "text/html") || !strings.EqualFold(r.Header.Get("Sec-Fetch-Mode"), "navigate") {
		return blockDeliveryNotice
	}
	switch strings.ToLower(r.Header.Get("Sec-Fetch-Dest")) {
	case "", "document":
		return blockDeliveryPage
	}
	return blockDeliveryNotice
}

func blockNextStep(b Block) string {
	switch {
	case strings.HasPrefix(b.Event.Reason, "surface-block:"):
		return "Ask your administrator to review this block. A request for access cannot override it."
	case b.Event.Reason == "http-coverage" || b.Event.Reason == "websocket-coverage":
		return "Guard could not check this request safely. Ask your administrator to review Guard's coverage before you try again."
	case b.Event.Kind == "content":
		return "Remove or replace the matched data, then send it again. Do not resend the same request."
	case b.RequestsEnabled:
		return "Request access below. Try again only after your administrator approves it."
	}
	return "Ask your administrator to review this policy. Access requests are turned off on this device."
}

func (a *Agent) blockHTML(w http.ResponseWriter, b Block) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self' http://127.0.0.1:*; form-action 'self' http://127.0.0.1:*")
	esc := html.EscapeString
	base := "http://" + a.localAddr + "/blocked/" + b.Event.EventID
	title := "Request blocked"
	if b.Event.Action == "asked" {
		title = "Ask IT for access"
	}
	org := "Your organisation"
	if _, _, d := a.snapshot(); d != nil {
		if d.OrgName != "" {
			org = d.OrgName
		} else if d.OrgHandle != "" {
			org = d.OrgHandle
		}
	}
	rule := b.RuleName
	if rule == "" {
		rule = "Service policy"
	}
	_, _ = fmt.Fprintf(w, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>%s · Vibtra Guard</title><style>body{font:14px/1.5 system-ui;background:#fafafa;color:#262626;margin:0;padding:48px 24px}main{max-width:520px;margin:auto;padding:28px;border:1px solid #ddd;border-radius:12px;background:white}h1{font-size:24px}h2{font-size:16px;margin:20px 0 4px}dt{color:#666}dd{margin:0 0 12px}button,a{display:inline-block;margin:12px 8px 0 0;padding:10px 16px;border:0;border-radius:8px;background:#262626;color:white;text-decoration:none;font:inherit}textarea{display:block;width:95%%;padding:10px}small{color:#666}</style></head><body><main><small>Vibtra Guard</small><h1>%s</h1><p>Your organisation's AI policy stopped this request before it was sent.</p><dl><dt>Organisation</dt><dd>%s</dd><dt>Service</dt><dd>%s</dd><dt>Rule</dt><dd>%s</dd>`, esc(title), esc(title), esc(org), esc(b.ServiceName), esc(rule))
	if b.Event.MatchType != "" {
		_, _ = fmt.Fprintf(w, `<dt>Match</dt><dd>%s (%d)</dd>`, esc(b.Event.MatchType), b.Event.MatchCount)
	}
	_, _ = fmt.Fprintf(w, `</dl>`)
	if b.Note != "" {
		_, _ = fmt.Fprintf(w, `<p>%s</p>`, esc(b.Note))
	}
	_, _ = fmt.Fprintf(w, `<h2>What to do next</h2><p id="next">%s</p>`, esc(blockNextStep(b)))
	if b.RequestsEnabled {
		_, _ = fmt.Fprintf(w, `<form method="post" action="%s/request"><label>Why do you need access?<textarea name="note" maxlength="280"></textarea></label><button>Request access</button></form>`, esc(base))
	}
	if b.Workspace != "" {
		_, _ = fmt.Fprintf(w, `<a href="%s/workspace">Use the company Vibtra workspace</a>`, esc(base))
	}
	_, _ = fmt.Fprintf(w, `<p id="status" role="status"></p><small>Reference %s</small></main><script>setInterval(async()=>{try{let r=await fetch(%q+'/status');let s=await r.json();document.getElementById('status').textContent=s.applied?'Access approved. Retry your request.':s.status==='none'?'':'Request '+s.status}catch{}},3000)</script></body></html>`, esc(b.Event.EventID), base)
}
