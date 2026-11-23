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
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

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
	goos := factsOS()
	v := goos
	arch := runtime.GOARCH
	if arch == "amd64" {
		arch = "x86_64"
	}
	capabilities := map[string]int{"protectionOff": 1}
	out := map[string]any{"hostname": clip(host, 253), "osVersion": v, "agentVersion": version, "arch": arch, "capabilities": capabilities}
	if goos == "darwin" {
		capabilities["surfaceBlocks"] = 1
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

const (
	preflightValidationMessage = "Send the preflight body (protocol, device, ca, clientMode, pendingEvents)"
	protectionOffRefused       = "device.capabilities: Unrecognized key(s) in object: 'protectionOff'"
)

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
	if capabilities, ok := device["capabilities"].(map[string]int); ok && capabilities["protectionOff"] == 1 && detail == protectionOffRefused {
		older := map[string]int{}
		for key, value := range capabilities {
			if key != "protectionOff" {
				older[key] = value
			}
		}
		return withDevice(request, device, func(d map[string]any) { d["capabilities"] = older }), true
	}
	_, caps := device["capabilities"]
	_, surfaces := device["supportedSurfaceBlocks"]
	prefix := "device: Unrecognized key(s) in object: "
	match := caps && surfaces && (detail == prefix+"'capabilities', 'supportedSurfaceBlocks'" || detail == prefix+"'supportedSurfaceBlocks', 'capabilities'") ||
		caps && !surfaces && detail == prefix+"'capabilities'" || !caps && surfaces && detail == prefix+"'supportedSurfaceBlocks'"
	if !match {
		return nil, false
	}
	return withDevice(request, device, func(d map[string]any) {
		delete(d, "capabilities")
		delete(d, "supportedSurfaceBlocks")
	}), true
}

func withDevice(request, device map[string]any, edit func(map[string]any)) map[string]any {
	copyDevice := make(map[string]any, len(device))
	for key, value := range device {
		copyDevice[key] = value
	}
	edit(copyDevice)
	copyRequest := make(map[string]any, len(request))
	for key, value := range request {
		copyRequest[key] = value
	}
	copyRequest["device"] = copyDevice
	return copyRequest
}

type registryError struct {
	status                int
	code, message, detail string
}

func (e *registryError) Error() string { return fmt.Sprintf("registry answered HTTP %d", e.status) }

type registryNetworkError struct{ cause error }

func (e *registryNetworkError) Error() string { return "registry network request failed" }
func (e *registryNetworkError) Unwrap() error { return e.cause }

var errNotEnrolled = errors.New("not enrolled")

var optionalHealth = []string{"interception", "policyKey"}

func rejectedHealth(e error, sent map[string]any) []string {
	var re *registryError
	if !errors.As(e, &re) || re.status != http.StatusBadRequest || re.code != "VALIDATION" || re.message != preflightValidationMessage {
		return nil
	}
	var keys []string
	for _, issue := range strings.Split(re.detail, "; ") {
		if list, ok := strings.CutPrefix(issue, "health: Unrecognized key(s) in object: "); ok {
			for _, quoted := range strings.Split(list, ", ") {
				key := strings.TrimSuffix(strings.TrimPrefix(quoted, "'"), "'")
				if _, was := sent[key]; !was || !contains(optionalHealth, key) || "'"+key+"'" != quoted {
					return nil
				}
				keys = append(keys, key)
			}
		} else if !strings.HasPrefix(issue, "device: Unrecognized key(s) in object: ") && issue != protectionOffRefused {
			return nil
		}
	}
	return keys
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
	rule := registryRules()
	if e := rule.check(base); e != nil {
		return e
	}
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
	requestID := requestIDFrom(ctx)
	if requestID == "" {
		requestID = newUUIDv7()
	}
	req.Header.Set("X-Request-Id", requestID)
	res, e := rule.client.Do(req)
	if e != nil {
		var ue *url.Error
		if errors.As(e, &ue) {
			e = ue.Err
		}
		return &registryNetworkError{cause: e}
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
	rule := registryRules()
	server = rule.enrolServer(server)
	if e := rule.allows(server); e != nil {
		return e
	}
	if len(token) != 37 || !strings.HasPrefix(token, "genr_") {
		return errors.New("an enrol token is genr_ followed by 32 hex characters")
	}
	var res struct {
		Device
		Signing     SigningKey `json:"signing"`
		DeviceToken string     `json:"deviceToken"`
	}
	a.ca.ensure()
	e := api(ctx, "POST", server, "/enrol", "", withCA(map[string]any{"protocol": 1, "enrolToken": token, "device": a.deviceFacts}, a.ca.facts()), &res)
	if e != nil {
		return e
	}
	if res.DeviceID == "" || res.DeviceToken == "" || res.Signing.Alg != "ES256" {
		return errors.New("invalid enrolment response")
	}
	pin, e := pinFor(res.Device, res.Signing, pinSourceEnrolment)
	if e != nil {
		return errors.New("invalid enrolment response: " + e.Error())
	}
	setEnrolledRegistry(&res.Device, server)
	res.EnrolledAt = nowISO()
	res.Revoked = false
	unlock, e := a.lockPolicyStore()
	if e != nil {
		return e
	}
	defer a.reload()
	defer unlock()
	if e = a.pins.pin(pin); e != nil {
		return fmt.Errorf("could not pin the policy-signing key: %w", e)
	}
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

var errFetchInFlight = errors.New("another Guard process is fetching the policy-signing key; sync again shortly")

func (a *Agent) fetchPolicyKey(ctx context.Context, f pinFetch) error {
	e := a.commitFetch(ctx, f)
	if e != nil {
		a.pins.fetchFailed(f, e)
	}
	return e
}

func (a *Agent) commitFetch(ctx context.Context, f pinFetch) error {
	pin, e := a.fetchPin(ctx, f.device)
	if e != nil {
		return e
	}
	unlock, e := a.lockPolicyStore()
	if e != nil {
		return e
	}
	defer a.reload()
	defer unlock()
	var current Device
	if readJSON(filepath.Join(a.dir, "device.json"), &current) != nil || current.Revoked || !sameEnrolment(current, f.device) {
		return errFetchDiscarded
	}
	if e = a.pins.pinFetched(f, pin); e != nil && !errors.Is(e, errFetchDiscarded) {
		return fmt.Errorf("could not pin the policy-signing key: %w", e)
	}
	return e
}

func (a *Agent) fetchPin(ctx context.Context, d Device) (policyPin, error) {
	release, e := tryLockFile(filepath.Join(a.dir, "policy-key-fetch.lock"))
	if e != nil {
		return policyPin{}, e
	}
	defer release()
	var res struct {
		DeviceID string     `json:"deviceId"`
		OrgID    string     `json:"orgId"`
		Signing  SigningKey `json:"signing"`
	}
	if e := a.call(ctx, d, "GET", "/signing/"+d.DeviceID, nil, &res); e != nil {
		return policyPin{}, fmt.Errorf("could not fetch the policy-signing key: %w", e)
	}
	if res.DeviceID != d.DeviceID || res.OrgID != d.OrgID {
		return policyPin{}, errors.New("the registry sent a policy-signing key for another enrolment")
	}
	pin, e := pinFor(d, res.Signing, pinSourceRegistry)
	if e != nil {
		return policyPin{}, errors.New("the registry sent an invalid policy-signing key: " + e.Error())
	}
	return pin, nil
}

func (a *Agent) bearerFor(d Device) ([]byte, error) {
	unlock, e := a.lockPolicyStore()
	if e != nil {
		return nil, e
	}
	defer unlock()
	var current Device
	if e = readJSON(filepath.Join(a.dir, "device.json"), &current); errors.Is(e, os.ErrNotExist) {
		return nil, errors.New("not enrolled")
	}
	if e != nil || !sameEnrolment(current, d) {
		return nil, errors.New("enrolment changed; sync again")
	}
	if current.Revoked {
		return nil, errRevoked
	}
	token, e := os.ReadFile(filepath.Join(a.dir, "device.token"))
	if e != nil {
		return nil, errors.New("device bearer unavailable")
	}
	return token, nil
}
func (a *Agent) call(ctx context.Context, d Device, method, path string, body, out any) error {
	if d.Revoked {
		return errRevoked
	}
	token, e := a.bearerFor(d)
	if e != nil {
		return e
	}
	e = api(ctx, method, untrustedEnrolledRegistry(d), path, strings.TrimSpace(string(token)), body, out) //nolint:forbidigo // api() checks registryRules() before it dials
	if errors.Is(e, errRevoked) {
		revoked := d
		revoked.Revoked = true
		revoked.RevokedAt = nowISO()
		unlock, lockErr := a.lockPolicyStore()
		if lockErr != nil {
			return lockErr
		}
		defer unlock()
		var current Device
		if readJSON(filepath.Join(a.dir, "device.json"), &current) != nil || !sameEnrolment(current, d) {
			return e
		}
		if we := writeJSON(filepath.Join(a.dir, "device.json"), revoked); we != nil {
			logFrom(ctx).Error("device revocation not saved", "error", errText(we))
		}
		logFrom(ctx).Info("registry revoked this device; enforcement stops")
		a.mu.Lock()
		a.device = &revoked
		a.held = heldPolicy{}
		a.mu.Unlock()
		a.emit("synced", map[string]any{"ok": false, "revoked": true, "at": nowISO()})
	}
	return e
}
func (a *Agent) syncOnce(ctx context.Context) (next int, err error) {
	a.syncMu.Lock()
	defer a.syncMu.Unlock()
	ctx, _ = newTrace(ctx, "sync_id")
	cycle := &syncCycle{start: time.Now()}
	defer func() { a.logSyncCycle(ctx, cycle, err) }()
	a.reload()
	b, c, d := a.snapshot()
	if d == nil {
		return 60, errNotEnrolled
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
	if fetch, ok := a.pins.beginFetch(*d); ok {
		if err = cycle.run(ctx, "signing", func() error { return a.fetchPolicyKey(ctx, fetch) }); err != nil {
			return
		}
		if b, c, d = a.snapshot(); d == nil {
			return 60, errNotEnrolled
		}
	}
	inboxErr := a.ingestExtensionInbox(b, c)
	a.ca.ensure()
	healthScope := untrustedEnrolledRegistry(*d) //nolint:forbidigo // only a cache key for refused health fields; nothing dials it
	health := map[string]any{"proxyListening": a.isListening(), "extensionActive": a.extensionActive(), "uptimeSeconds": uint64(time.Since(a.started).Seconds())}
	for key, value := range map[string]any{"interception": a.ca.interception(), "policyKey": a.pins.health()} {
		if a.noHealth[key] != healthScope {
			health[key] = value
		}
	}
	keyID := a.pins.keyID()
	pre := withCA(map[string]any{"protocol": 1, "device": a.deviceFacts, "clientMode": d.ClientMode, "requestCleanSync": b == nil, "pendingEvents": len(a.queued()), "health": health}, a.ca.facts())
	if keyID != "" {
		pre["signingKeyId"] = keyID
	}
	if trusted := a.caTrusted(); trusted != nil {
		health["caTrusted"] = *trusted
	}
	if b != nil {
		pre["bundleVersion"] = b.BundleVersion
		pre["clientMode"] = b.ClientMode
	}
	a.mu.RLock()
	signedCat := a.catSource == "signed"
	refresh := a.held.wantsFreshSignature(time.Now())
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
	preflight := func() error { return a.call(ctx, *d, "POST", "/preflight/"+d.DeviceID, pre, &pf) }
	err = cycle.run(ctx, "preflight", preflight)
	if refused := rejectedHealth(err, health); len(refused) > 0 {
		for _, key := range refused {
			delete(health, key)
			a.noHealth[key] = healthScope
		}
		err = cycle.run(ctx, "preflight", preflight)
	}
	if err != nil {
		return
	}
	mismatch := keyID != "" && pf.SigningKeyID != keyID
	a.mu.Lock()
	a.state.SigningKeyMismatch = mismatch
	a.mu.Unlock()
	failure := ""
	if !mismatch && (pf.CleanSync || pf.RulesChanged || pf.CatalogueChanged || b == nil || !signedCat || refresh) {
		download := map[string]any{"protocol": 1}
		if !pf.CleanSync && b != nil && !refresh {
			download["bundleVersion"] = b.BundleVersion
		}
		if !pf.CleanSync && signedCat {
			download["catalogueVersion"] = c.Version
		}
		var rd map[string]json.RawMessage
		if err = cycle.run(ctx, "ruledownload", func() error { return a.call(ctx, *d, "POST", "/ruledownload/"+d.DeviceID, download, &rd) }); err != nil {
			return
		}
		if e := cycle.run(ctx, "policy_commit", func() error { return a.commitPolicyDownload(*d, rd) }); e != nil {
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
		if err = cycle.run(ctx, "eventupload", func() error {
			return a.call(ctx, *d, "POST", "/eventupload/"+d.DeviceID, map[string]any{"protocol": 1, "events": q}, &up)
		}); err != nil {
			return
		}
		cycle.accepted += up.Accepted
		cycle.rejected += len(up.Rejected)
		if up.Accepted+len(up.Rejected) != len(q) {
			err = errors.New("incomplete event acknowledgement; retaining upload batch")
			return
		}
		if legacy := legacyWouldActionEvents(q, up.Rejected); len(legacy) > 0 {
			var again struct {
				Accepted int             `json:"accepted"`
				Rejected []rejectedEvent `json:"rejected"`
			}
			if err = cycle.run(ctx, "eventupload", func() error {
				return a.call(ctx, *d, "POST", "/eventupload/"+d.DeviceID, map[string]any{"protocol": 1, "events": legacy}, &again)
			}); err != nil {
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
	if err = cycle.run(ctx, "postflight", func() error { return a.call(ctx, *d, "POST", "/postflight/"+d.DeviceID, post, &done) }); err == nil {
		next = max(10, done.Next)
		err = inboxErr
	}
	return
}

const syncFailuresBeforeError = 7

type syncStep struct {
	name     string
	calls    int
	duration time.Duration
	outcome  string
}

type syncCycle struct {
	start              time.Time
	steps              []*syncStep
	accepted, rejected int
}

func (c *syncCycle) run(ctx context.Context, name string, fn func() error) error {
	start := time.Now()
	err := timed(ctx, name, fn)
	var step *syncStep
	for _, s := range c.steps {
		if s.name == name {
			step = s
		}
	}
	if step == nil {
		step = &syncStep{name: name}
		c.steps = append(c.steps, step)
	}
	step.calls++
	step.duration += time.Since(start)
	step.outcome = "ok"
	if err != nil {
		step.outcome = "error"
	}
	return err
}

func (a *Agent) logSyncCycle(ctx context.Context, c *syncCycle, err error) {
	level, outcome := slog.LevelInfo, "ok"
	switch {
	case err == nil:
		a.syncFailures = 0
	case errors.Is(err, errNotEnrolled):
		level, outcome = slog.LevelDebug, "not-enrolled"
	case errors.Is(err, errRevoked):
		outcome = "revoked"
	default:
		a.syncFailures++
		level, outcome = slog.LevelWarn, "retrying"
		if a.syncFailures >= syncFailuresBeforeError {
			level, outcome = slog.LevelError, "retries-exhausted"
		}
	}
	l := logFrom(ctx)
	if !l.Enabled(ctx, level) {
		return
	}
	steps := make([]any, 0, len(c.steps))
	for _, s := range c.steps {
		steps = append(steps, slog.Group(s.name, slog.Int("calls", s.calls), slog.Float64("duration_ms", durationMS(s.duration)), slog.String("outcome", s.outcome)))
	}
	attrs := []slog.Attr{slog.String("outcome", outcome), slog.Float64("duration_ms", durationMS(time.Since(c.start))), slog.Group("steps", steps...), slog.Int("events_accepted", c.accepted), slog.Int("events_rejected", c.rejected)}
	if err != nil {
		attrs = append(attrs, slog.String("error", errText(err)), slog.Int("consecutive_failures", a.syncFailures))
	}
	l.LogAttrs(ctx, level, "sync cycle", attrs...)
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
