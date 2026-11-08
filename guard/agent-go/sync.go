// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

var registryHTTP = &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{Proxy: nil}, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}

func facts() map[string]any {
	run := func(name string, args ...string) string {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		b, e := exec.CommandContext(ctx, name, args...).Output()
		if e != nil {
			return ""
		}
		return strings.TrimSpace(string(b))
	}
	clip := func(s string, n int) string { r := []rune(s); return string(r[:min(n, len(r))]) }
	host, _ := os.Hostname()
	v := runtime.GOOS
	arch := runtime.GOARCH
	if arch == "amd64" {
		arch = "x86_64"
	}
	out := map[string]any{"hostname": clip(host, 253), "osVersion": v, "agentVersion": "0.1.0", "arch": arch}
	if runtime.GOOS == "darwin" {
		out["capabilities"] = map[string]int{"surfaceBlocks": 1}
		out["supportedSurfaceBlocks"] = supportedSurfaceBlocks()
		if value := run("/usr/bin/sw_vers", "-productVersion"); value != "" {
			out["osVersion"] = clip(value, 40)
		}
		if value := run("/usr/bin/sw_vers", "-buildVersion"); value != "" {
			out["osBuild"] = clip(value, 40)
		}
		if value := run("/usr/sbin/sysctl", "-n", "hw.model"); value != "" {
			out["modelIdentifier"] = clip(value, 64)
		}
	}
	return out
}

func validServer(raw string) error {
	u, e := url.Parse(raw)
	if e != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("invalid registry address")
	}
	if u.Scheme != "https" && (u.Scheme != "http" || u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost" && u.Hostname() != "::1") {
		return errors.New("registry requires HTTPS (HTTP is allowed on loopback for local tests)")
	}
	return nil
}
func api(ctx context.Context, method, base, path, token string, body, out any) error {
	return apiAttempt(ctx, method, base, path, token, body, out, true)
}

const preflightValidationMessage = "Send the preflight body (protocol, device, ca, clientMode, pendingEvents)"

func legacyFactsRequest(method, path, code, message, detail string, body any) (any, bool) {
	if method != "POST" || code != "VALIDATION" {
		return nil, false
	}
	expected := ""
	if path == "/enrol" {
		expected = "Send { protocol, enrolToken, device, ca }"
	} else if strings.HasPrefix(path, "/preflight/") && len(strings.TrimPrefix(path, "/preflight/")) > 0 && !strings.ContainsAny(strings.TrimPrefix(path, "/preflight/"), "/?#") {
		expected = preflightValidationMessage
	}
	if expected == "" || message != expected {
		return nil, false
	}
	request, ok := body.(map[string]any)
	if !ok {
		return nil, false
	}
	device, ok := request["device"].(map[string]any)
	if !ok {
		return nil, false
	}
	_, caps := device["capabilities"]
	_, surfaces := device["supportedSurfaceBlocks"]
	prefix := "device: Unrecognized key(s) in object: "
	match := caps && surfaces && (detail == prefix+"'capabilities', 'supportedSurfaceBlocks'" || detail == prefix+"'supportedSurfaceBlocks', 'capabilities'") ||
		caps && !surfaces && detail == prefix+"'capabilities'" || !caps && surfaces && detail == prefix+"'supportedSurfaceBlocks'"
	if !match {
		return nil, false
	}
	copyDevice := make(map[string]any, len(device))
	for key, value := range device {
		if key != "capabilities" && key != "supportedSurfaceBlocks" {
			copyDevice[key] = value
		}
	}
	copyRequest := make(map[string]any, len(request))
	for key, value := range request {
		copyRequest[key] = value
	}
	copyRequest["device"] = copyDevice
	return copyRequest, true
}

type registryError struct {
	status                int
	code, message, detail string
}

func (e *registryError) Error() string { return fmt.Sprintf("registry answered HTTP %d", e.status) }

func rejectsInterceptionHealth(e error) bool {
	var re *registryError
	if !errors.As(e, &re) || re.status != http.StatusBadRequest || re.code != "VALIDATION" || re.message != preflightValidationMessage {
		return false
	}
	found := false
	for _, issue := range strings.Split(re.detail, "; ") {
		switch {
		case issue == "health: Unrecognized key(s) in object: 'interception'":
			found = true
		case !strings.HasPrefix(issue, "device: Unrecognized key(s) in object: "):
			return false
		}
	}
	return found
}

type rejectedEvent struct {
	EventID string `json:"eventId"`
	Reason  string `json:"reason"`
}

func legacyWouldActionEvents(q []Event, rejected []rejectedEvent) []Event {
	refused := map[string]bool{}
	for _, r := range rejected {
		if r.Reason == "(root): Unrecognized key(s) in object: 'wouldAction'" {
			refused[r.EventID] = true
		}
	}
	out := []Event{}
	for _, ev := range q {
		if refused[ev.EventID] && ev.WouldAction != "" {
			ev.WouldAction = ""
			out = append(out, ev)
		}
	}
	return out
}

func apiAttempt(ctx context.Context, method, base, path, token string, body, out any, allowLegacy bool) error {
	if e := validServer(base); e != nil {
		return e
	}
	var r io.Reader
	if body != nil {
		b, e := json.Marshal(body)
		if e != nil {
			return e
		}
		r = bytes.NewReader(b)
	}
	req, e := http.NewRequestWithContext(ctx, method, strings.TrimRight(base, "/")+"/api/guard/v1"+path, r)
	if e != nil {
		return errors.New("invalid registry request")
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, e := registryHTTP.Do(req)
	if e != nil {
		return errors.New("registry network request failed")
	}
	defer func() { _ = res.Body.Close() }()
	data, e := io.ReadAll(io.LimitReader(res.Body, 8*1024*1024+1))
	if e != nil || len(data) > 8*1024*1024 {
		return errors.New("registry response exceeds limit or is unreadable")
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		var er struct {
			Code    string `json:"code"`
			Message string `json:"message"`
			Detail  string `json:"detail"`
		}
		_ = json.Unmarshal(data, &er)
		if er.Code == "GUARD_DEVICE_REVOKED" || er.Code == "GUARD_DEVICE_UNKNOWN" {
			return errRevoked
		}
		if allowLegacy && res.StatusCode == http.StatusBadRequest {
			if legacy, ok := legacyFactsRequest(method, path, er.Code, er.Message, er.Detail, body); ok {
				_ = res.Body.Close()
				return apiAttempt(ctx, method, base, path, token, legacy, out, false)
			}
		}
		return &registryError{res.StatusCode, er.Code, er.Message, er.Detail}
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(data, out)
}

var errRevoked = errors.New("device revoked; re-enrol to resume")

func withCA(body, ca map[string]any) map[string]any {
	if ca != nil {
		body["ca"] = ca
	}
	return body
}
func (a *Agent) enrol(ctx context.Context, server, token string) error {
	if len(token) != 37 || !strings.HasPrefix(token, "genr_") {
		return errors.New("an enrol token is genr_ followed by 32 hex characters")
	}
	var res struct {
		Device
		DeviceToken string `json:"deviceToken"`
	}
	a.ca.ensure()
	e := api(ctx, "POST", server, "/enrol", "", withCA(map[string]any{"protocol": 1, "enrolToken": token, "device": a.deviceFacts}, a.ca.facts()), &res)
	if e != nil {
		return e
	}
	if res.DeviceID == "" || res.DeviceToken == "" || res.Signing.Alg != "ES256" {
		return errors.New("invalid enrolment response")
	}
	res.Server.BaseURL = strings.TrimRight(server, "/")
	res.EnrolledAt = nowISO()
	res.Revoked = false
	unlock, e := a.lockPolicyStore()
	if e != nil {
		return e
	}
	defer a.reload()
	defer unlock()
	for _, name := range []string{"bundle.json", "catalogue.json", policyCheckpointName} {
		_ = os.Remove(filepath.Join(a.dir, name))
	}
	if e = os.Remove(filepath.Join(a.dir, "device.json")); e != nil && !errors.Is(e, os.ErrNotExist) {
		return e
	}
	crashPoint("enrol-before-token")
	if e = atomicWrite(filepath.Join(a.dir, "device.token"), []byte(res.DeviceToken)); e != nil {
		return e
	}
	crashPoint("enrol-after-token")
	if e = writeJSON(filepath.Join(a.dir, "device.json"), res.Device); e != nil {
		return e
	}
	return nil
}
func (a *Agent) call(ctx context.Context, method, path string, body, out any) error {
	_, _, d := a.snapshot()
	if d == nil {
		return errors.New("not enrolled")
	}
	if d.Revoked {
		return errRevoked
	}
	token, e := os.ReadFile(filepath.Join(a.dir, "device.token"))
	if e != nil {
		return errors.New("device bearer unavailable")
	}
	e = api(ctx, method, d.Server.BaseURL, path, strings.TrimSpace(string(token)), body, out)
	if errors.Is(e, errRevoked) {
		revoked := *d
		revoked.Revoked = true
		revoked.RevokedAt = nowISO()
		unlock, lockErr := a.lockPolicyStore()
		if lockErr != nil {
			return lockErr
		}
		defer unlock()
		var current Device
		if readJSON(filepath.Join(a.dir, "device.json"), &current) != nil || !samePolicyIdentity(current, *d) {
			return e
		}
		_ = writeJSON(filepath.Join(a.dir, "device.json"), revoked)
		a.mu.Lock()
		a.device = &revoked
		a.bundle = nil
		a.mu.Unlock()
		a.emit("synced", map[string]any{"ok": false, "revoked": true, "at": nowISO()})
	}
	return e
}
func (a *Agent) syncOnce(ctx context.Context) (next int, err error) {
	a.syncMu.Lock()
	defer a.syncMu.Unlock()
	a.reload()
	b, c, d := a.snapshot()
	if d == nil {
		return 60, errors.New("not enrolled")
	}
	if d.Revoked {
		return 60, errRevoked
	}
	next = max(10, d.Server.SyncIntervalSeconds)
	defer func() {
		a.mu.Lock()
		a.state.LastSyncAt = nowISO()
		a.state.LastSyncOK = err == nil
		a.state.LastError = ""
		if err != nil {
			a.state.LastError = err.Error()
		}
		state := a.state
		a.mu.Unlock()
		_ = writeJSON(filepath.Join(a.dir, "state.json"), state)
		a.emit("synced", map[string]any{"ok": err == nil, "at": state.LastSyncAt})
	}()
	inboxErr := a.ingestExtensionInbox(b, c)
	a.ca.ensure()
	health := map[string]any{"proxyListening": a.isListening(), "uptimeSeconds": uint64(time.Since(a.started).Seconds())}
	if a.noInterceptionHealth != d.Server.BaseURL {
		health["interception"] = a.ca.interception()
	}
	pre := withCA(map[string]any{"protocol": 1, "device": a.deviceFacts, "clientMode": d.ClientMode, "signingKeyId": d.Signing.KeyID, "requestCleanSync": b == nil, "pendingEvents": len(a.queued()), "health": health}, a.ca.facts())
	if trusted := a.caTrusted(); trusted != nil {
		health["caTrusted"] = *trusted
	}
	if b != nil {
		pre["bundleVersion"] = b.BundleVersion
		pre["clientMode"] = b.ClientMode
	}
	a.mu.RLock()
	signedCat := a.catSource == "signed"
	a.mu.RUnlock()
	if signedCat {
		pre["catalogueVersion"] = c.Version
	}
	var pf struct {
		ClientMode          string `json:"clientMode"`
		SyncIntervalSeconds int    `json:"syncIntervalSeconds"`
		BatchSize           int    `json:"batchSize"`
		CleanSync           bool   `json:"cleanSync"`
		RulesChanged        bool   `json:"rulesChanged"`
		CatalogueChanged    bool   `json:"catalogueChanged"`
		SigningKeyID        string `json:"signingKeyId"`
	}
	err = a.call(ctx, "POST", "/preflight/"+d.DeviceID, pre, &pf)
	if _, sent := health["interception"]; sent && rejectsInterceptionHealth(err) {
		delete(health, "interception")
		a.noInterceptionHealth = d.Server.BaseURL
		err = a.call(ctx, "POST", "/preflight/"+d.DeviceID, pre, &pf)
	}
	if err != nil {
		return
	}
	mismatch := pf.SigningKeyID != d.Signing.KeyID
	a.mu.Lock()
	a.state.SigningKeyMismatch = mismatch
	a.mu.Unlock()
	failure := ""
	if !mismatch && (pf.CleanSync || pf.RulesChanged || pf.CatalogueChanged || b == nil || !signedCat) {
		download := map[string]any{"protocol": 1}
		if !pf.CleanSync && b != nil {
			download["bundleVersion"] = b.BundleVersion
		}
		if !pf.CleanSync && signedCat {
			download["catalogueVersion"] = c.Version
		}
		var rd map[string]json.RawMessage
		if err = a.call(ctx, "POST", "/ruledownload/"+d.DeviceID, download, &rd); err != nil {
			return
		}
		if e := a.commitPolicyDownload(*d, rd); e != nil {
			failure = e.Error()
		}
		a.reload()
	}
	batchSize := min(500, max(1, pf.BatchSize))
	for i := 0; inboxErr == nil && i < 50; i++ {
		q := a.queued()
		if len(q) == 0 {
			break
		}
		q = q[:min(batchSize, len(q))]
		var up struct {
			Accepted int             `json:"accepted"`
			Rejected []rejectedEvent `json:"rejected"`
		}
		if err = a.call(ctx, "POST", "/eventupload/"+d.DeviceID, map[string]any{"protocol": 1, "events": q}, &up); err != nil {
			return
		}
		if up.Accepted+len(up.Rejected) != len(q) {
			err = errors.New("incomplete event acknowledgement; retaining upload batch")
			return
		}
		if legacy := legacyWouldActionEvents(q, up.Rejected); len(legacy) > 0 {
			var again struct {
				Accepted int             `json:"accepted"`
				Rejected []rejectedEvent `json:"rejected"`
			}
			if err = a.call(ctx, "POST", "/eventupload/"+d.DeviceID, map[string]any{"protocol": 1, "events": legacy}, &again); err != nil {
				return
			}
			if again.Accepted+len(again.Rejected) != len(legacy) {
				err = errors.New("incomplete event acknowledgement; retaining upload batch")
				return
			}
		}
		ids := map[string]bool{}
		for _, ev := range q {
			ids[ev.EventID] = true
		}
		if err = a.queue(func(all []Event) ([]Event, error) {
			keep := []Event{}
			for _, ev := range all {
				if !ids[ev.EventID] {
					keep = append(keep, ev)
				}
			}
			return keep, nil
		}); err != nil {
			return
		}
	}
	if mismatch {
		err = errors.New("registry signing key changed; keeping last verified policy until re-enrolment")
		return
	}
	if failure != "" {
		err = errors.New(failure)
		return
	}
	b, c, _ = a.snapshot()
	post := map[string]any{"protocol": 1, "bundleVersion": 0, "catalogueVersion": c.Version, "rulesReceived": 0, "rulesProcessed": 0, "clientMode": pf.ClientMode}
	if b != nil {
		n := len(b.Services) + len(b.ContentRules) + len(b.Exceptions)
		post["bundleVersion"] = b.BundleVersion
		post["rulesReceived"] = n
		post["rulesProcessed"] = n
		post["clientMode"] = b.ClientMode
		a.mu.RLock()
		post["bundleDigest"] = a.digest
		a.mu.RUnlock()
	}
	var done struct {
		Next int `json:"nextSyncInSeconds"`
	}
	if err = a.call(ctx, "POST", "/postflight/"+d.DeviceID, post, &done); err == nil {
		next = max(10, done.Next)
		err = inboxErr
	}
	return
}
func (a *Agent) isListening() bool { a.mu.RLock(); defer a.mu.RUnlock(); return a.listening }
func (a *Agent) syncLoop(ctx context.Context, every int) {
	backoff := 10
	timer := time.NewTimer(0)
	defer timer.Stop()
	reload := time.NewTicker(2 * time.Second)
	defer reload.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-reload.C:
			a.reload()
		case <-a.wake:
			timer.Reset(0)
		case <-timer.C:
			next, e := a.syncOnce(ctx)
			if e != nil {
				next = backoff
				backoff = min(600, backoff*2)
			} else {
				backoff = 10
			}
			if every > 0 {
				next = every
			}
			timer.Reset(time.Duration(max(1, next)) * time.Second)
		}
	}
}
