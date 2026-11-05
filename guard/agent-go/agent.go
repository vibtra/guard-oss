// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package main

import (
	"bufio"
	"bytes"
	"crypto/rand"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/vibtra/guard/guard/agent-go/engine"
	"github.com/vibtra/guard/guard/agent-go/policy"
)

//go:embed catalogue.json
var seedCatalogue []byte

func nowISO() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }
func eventID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return "gev_" + hex.EncodeToString(b[:])
}
func atomicWrite(path string, b []byte) error {
	f, e := os.CreateTemp(filepath.Dir(path), ".guard-*")
	if e != nil {
		return e
	}
	defer func() { _ = os.Remove(f.Name()) }()
	if e = f.Chmod(0600); e == nil {
		_, e = f.Write(b)
	}
	if e == nil {
		e = f.Sync()
	}
	closeErr := f.Close()
	if e != nil {
		return e
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(f.Name(), path)
}
func writeJSON(path string, v any) error {
	b, e := json.MarshalIndent(v, "", "  ")
	if e != nil {
		return e
	}
	return atomicWrite(path, append(b, '\n'))
}
func readJSON(path string, v any) error {
	b, e := os.ReadFile(path)
	if e != nil {
		return e
	}
	return json.Unmarshal(b, v)
}

type Event struct {
	EventID       string    `json:"eventId"`
	OccurredAt    string    `json:"occurredAt"`
	Kind          string    `json:"kind"`
	Action        string    `json:"action"`
	ServiceID     string    `json:"serviceId,omitempty"`
	Host          string    `json:"host,omitempty"`
	Port          int       `json:"port,omitempty"`
	Method        string    `json:"method,omitempty"`
	PathHint      string    `json:"pathHint,omitempty"`
	App           *EventApp `json:"app,omitempty"`
	RuleID        string    `json:"ruleId,omitempty"`
	RuleKind      string    `json:"ruleKind,omitempty"`
	MatchType     string    `json:"matchType,omitempty"`
	MatchCount    int       `json:"matchCount,omitempty"`
	Snippet       string    `json:"snippet,omitempty"`
	Bytes         int64     `json:"bytes,omitempty"`
	RequestID     string    `json:"requestId,omitempty"`
	BundleVersion uint64    `json:"bundleVersion,omitempty"`
	Reason        string    `json:"reason,omitempty"`
	WouldAction   string    `json:"wouldAction,omitempty"`
}
type EventApp struct {
	attribution *processAttribution
	BundleID    string `json:"bundleId,omitempty"`
	Name        string `json:"name,omitempty"`
	CLI         string `json:"cli,omitempty"`
	PID         int    `json:"pid,omitempty"`
}
type SyncState struct {
	LastSyncAt         string `json:"lastSyncAt,omitempty"`
	LastSyncOK         bool   `json:"lastSyncOk"`
	LastError          string `json:"lastError,omitempty"`
	SigningKeyMismatch bool   `json:"signingKeyMismatch"`
}
type Message struct {
	Name string
	Data any
}
type Block struct {
	Event                       Event
	ServiceName, RuleName, Note string
	RequestsEnabled, Enforced   bool
	Workspace                   string
}
type Agent struct {
	tlsDiagnostics       tlsDiagnosticRing
	transportStatsMu     sync.RWMutex
	upstreamHelloHash    string
	uninspectedCount     uint64
	tunnelledCount       uint64
	relayReplay          relayReplayCache
	trustMu              sync.Mutex
	trustAt              time.Time
	trusted              *bool
	deviceFacts          map[string]any
	dir                  string
	ca                   *CA
	started              time.Time
	mu                   sync.RWMutex
	device               *Device
	bundle               *policy.Bundle
	catalogue            *policy.Catalogue
	digest, catSource    string
	state                SyncState
	proxyAddr, localAddr string
	listening            bool
	activity             []map[string]any
	blocks               map[string]Block
	blockOrder           []string
	asks                 map[string]map[string]any
	today                map[string]int
	countDay             string
	subscribers          map[chan Message]bool
	notified             map[string]time.Time
	policyMu             sync.Mutex
	syncMu               sync.Mutex
	wake                 chan struct{}
	engineName           string
}

func openAgent(dir string) (*Agent, error) {
	if e := os.MkdirAll(dir, 0700); e != nil {
		return nil, e
	}
	if e := os.Chmod(dir, 0700); e != nil {
		return nil, e
	}
	ca, e := loadCA(dir)
	if e != nil {
		return nil, e
	}
	a := &Agent{deviceFacts: facts(), dir: dir, ca: ca, started: time.Now(), blocks: map[string]Block{}, asks: map[string]map[string]any{}, today: map[string]int{}, subscribers: map[chan Message]bool{}, wake: make(chan struct{}, 1)}
	_ = json.Unmarshal(seedCatalogue, &a.catalogue)
	a.catSource = "seed"
	_ = readJSON(filepath.Join(dir, "state.json"), &a.state)
	a.reload()
	return a, nil
}
func (a *Agent) reload() {
	unlock, e := a.lockPolicyStore()
	if e != nil {
		return
	}
	defer unlock()
	var d Device
	if readJSON(filepath.Join(a.dir, "device.json"), &d) != nil {
		return
	}
	a.mu.Lock()
	if a.device != nil && !samePolicyIdentity(*a.device, d) {
		a.bundle = nil
		a.digest = ""
		_ = json.Unmarshal(seedCatalogue, &a.catalogue)
		a.catSource = "seed"
	}
	a.device = &d
	if d.Revoked {
		a.bundle = nil
		a.mu.Unlock()
		return
	}
	a.mu.Unlock()
	pair, e := a.readPolicyPair(d)
	if e != nil {
		return
	}
	b, c, digest, source, e := pair.verify(d)
	if e != nil {
		return
	}
	_ = a.mirrorPolicyPair(pair)
	a.mu.Lock()
	a.bundle, a.catalogue, a.digest, a.catSource = b, c, digest, source
	a.mu.Unlock()
}
func validateBundle(b policy.Bundle) error {
	if b.Settings.UnreproducibleTLS != "" && b.Settings.UnreproducibleTLS != "block" && b.Settings.UnreproducibleTLS != "tunnel" {
		return errors.New("unsupported unreproducible TLS policy")
	}
	if err := validateSurfaceBlocks(b.SurfaceBlocks); err != nil {
		return err
	}
	if b.Protocol != 1 || b.ClientMode != "monitor" && b.ClientMode != "enforce" || !validAction(b.DefaultAction) {
		return errors.New("unsupported policy")
	}
	for _, s := range b.Services {
		if !validAction(s.Action) {
			return errors.New("unsupported service action")
		}
	}
	for _, r := range b.ContentRules {
		if !validAction(r.Action) {
			return errors.New("unsupported content action")
		}
		if r.Detector.Kind == "" {
			return errors.New("content rule has no detector kind")
		}
	}
	return nil
}
func validAction(s string) bool { return s == "allow" || s == "block" || s == "ask" }
func (a *Agent) snapshot() (*policy.Bundle, *policy.Catalogue, *Device) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.bundle, a.catalogue, a.device
}
func (a *Agent) shouldIntercept(host string) bool {
	b, c, d := a.snapshot()
	return b != nil && d != nil && !d.Revoked && c.Service(host, "", "") != nil
}
func (a *Agent) emit(name string, data any) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for ch := range a.subscribers {
		select {
		case ch <- Message{name, data}:
		default:
		}
	}
}
func (a *Agent) subscribe() (chan Message, func()) {
	ch := make(chan Message, 64)
	a.mu.Lock()
	a.subscribers[ch] = true
	a.mu.Unlock()
	return ch, func() { a.mu.Lock(); delete(a.subscribers, ch); a.mu.Unlock() }
}
func (a *Agent) queue(fn func([]Event) ([]Event, error)) error {
	f, e := os.OpenFile(filepath.Join(a.dir, "events.jsonl.lock"), os.O_CREATE|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	defer func() { _ = f.Close() }()
	if e = syscall.Flock(int(f.Fd()), syscall.LOCK_EX); e != nil {
		return e
	}
	defer func() { _ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN) }()
	events := []Event{}
	b, e := os.ReadFile(filepath.Join(a.dir, "events.jsonl"))
	if e != nil && !os.IsNotExist(e) {
		return e
	}
	scanner := bufio.NewScanner(bytes.NewReader(b))
	scanner.Buffer(make([]byte, 4096), 128*1024)
	for scanner.Scan() {
		var ev Event
		if json.Unmarshal(scanner.Bytes(), &ev) == nil {
			events = append(events, ev)
		}
	}
	if e = scanner.Err(); e != nil {
		return e
	}
	next, e := fn(events)
	if e != nil {
		return e
	}
	if next == nil {
		return nil
	}
	var out []byte
	for _, ev := range next {
		line, e := json.Marshal(ev)
		if e != nil {
			return e
		}
		out = append(out, line...)
		out = append(out, '\n')
	}
	return atomicWrite(filepath.Join(a.dir, "events.jsonl"), out)
}
func (a *Agent) appendEvent(ev Event) error {
	return a.queue(func(q []Event) ([]Event, error) { return append(q, ev), nil })
}
func (a *Agent) queued() []Event {
	var out []Event
	_ = a.queue(func(q []Event) ([]Event, error) { out = q; return nil, nil })
	return out
}
func (a *Agent) record(v engine.Decision, host, method string, port int, n int64, inspection map[string]any, app *EventApp, bundles ...*policy.Bundle) (string, *Block) {
	if !v.Intercepted {
		return "", nil
	}
	b, _, _ := a.snapshot()
	if len(bundles) > 0 {
		b = bundles[0]
	}
	if b == nil {
		return "", nil
	}
	if app != nil && app.attribution != nil {
		if inspection == nil {
			inspection = map[string]any{}
		}
		inspection["processAttribution"] = *app.attribution
		if app.attribution.verifiedApp() {
			inspection["attribution"] = "network-extension"
		}
		if app.BundleID == "" && app.Name == "" && app.CLI == "" && app.PID == 0 {
			app = nil
		}
	}
	ev := Event{EventID: eventID(), OccurredAt: nowISO(), Kind: "flow", App: app, Action: v.Verdict, ServiceID: v.Service.ServiceID, Host: host, Port: port, Method: method, RuleKind: v.Flow.Source, RuleID: v.Flow.RuleID, BundleVersion: b.BundleVersion, Bytes: n}
	ruleName := ""
	if v.Flow.Source == "rule" {
		ev.RuleKind = "service"
	}
	if v.Flow.Source == "surface-block" {
		ev.RuleKind = "service"
		ev.Reason = "surface-block:" + v.Flow.SurfaceID
		ruleName = "Surface block: " + v.Flow.SurfaceID
	}
	if v.Flow.Source == "inspection-coverage" {
		ev.RuleKind = ""
		ev.Reason = "websocket-coverage"
		if method != "WEBSOCKET" {
			ev.Reason = "http-coverage"
		}
		ruleName = "Inspection unavailable"
	}
	note := v.Flow.Note
	if v.Content != nil && len(v.Content.Matches) > 0 {
		index := v.Content.Decided
		if index < 0 {
			index = 0
		}
		m := v.Content.Matches[index]
		ev.Kind = "content"
		ev.RuleKind = "content"
		ev.RuleID = m.Rule.RuleID
		ev.MatchType = m.Match.Kind
		ev.MatchCount = m.Match.Count
		if m.Unavailable != "" {
			ev.Reason = m.Unavailable
		}
		if len(m.Match.Diagnostics) > 0 {
			if inspection == nil {
				inspection = map[string]any{}
			}
			inspection["matchDiagnostics"] = m.Match.Diagnostics
		}
		ruleName = m.Rule.Name
		note = m.Rule.Note
		if b.Settings.SnippetPolicy == "redacted" && len(m.Match.Examples) > 0 {
			snippet := m.Match.Kind + " " + m.Match.Examples[0]
			r := []rune(snippet)
			ev.Snippet = string(r[:min(len(r), max(0, min(80, b.Settings.SnippetMax)))])
		}
	}
	if !v.Enforced {
		if v.Verdict == "blocked" || v.Verdict == "asked" {
			ev.WouldAction = v.Verdict
		}
		ev.Action = "observed"
	}
	delivery, _ := inspection["blockDelivery"].(string)
	delete(inspection, "blockDelivery")
	if delivery != blockDeliveryPage {
		delivery = blockDeliveryNotice
	}
	_ = a.appendEvent(ev)
	raw, _ := json.Marshal(ev)
	payload := map[string]any{}
	_ = json.Unmarshal(raw, &payload)
	if v.Enforced && (v.Verdict == "blocked" || v.Verdict == "asked") {
		payload["delivery"] = delivery
	}
	payload["serviceName"] = v.Service.Name
	payload["ruleName"] = ruleName
	payload["enforced"] = v.Enforced
	payload["inspection"] = inspection
	payload["requestsEnabled"] = b.Settings.RequestsEnabled
	block := &Block{Event: ev, ServiceName: v.Service.Name, RuleName: ruleName, Note: note, RequestsEnabled: b.Settings.RequestsEnabled, Enforced: v.Enforced}
	if v.Flow.Source == "surface-block" || v.Flow.Source == "inspection-coverage" {
		block.RequestsEnabled = false
		payload["requestsEnabled"] = false
	}
	if b.Settings.WorkspaceRedirect.Enabled {
		block.Workspace = b.Settings.WorkspaceRedirect.URL
		payload["workspace"] = block.Workspace
	}
	a.mu.Lock()
	day := time.Now().Format("2006-01-02")
	if a.countDay != day {
		a.countDay = day
		a.today = map[string]int{}
	}
	a.today[ev.Action]++
	a.activity = append([]map[string]any{payload}, a.activity...)
	if len(a.activity) > 300 {
		a.activity = a.activity[:300]
	}
	if v.Verdict == "blocked" || v.Verdict == "asked" {
		a.blocks[ev.EventID] = *block
		a.blockOrder = append(a.blockOrder, ev.EventID)
		if len(a.blockOrder) > 300 {
			delete(a.blocks, a.blockOrder[0])
			delete(a.asks, a.blockOrder[0])
			a.blockOrder = a.blockOrder[1:]
		}
	}
	repeat := a.repeatBlockLocked(ev, v, time.Now())
	if repeat {
		payload["coalesced"] = true
		a.activity[0] = payload
	}
	a.mu.Unlock()
	if !repeat {
		a.emit("decision", payload)
	}
	value := "allowed"
	if !v.Enforced {
		value = "observed"
	}
	if v.Verdict == "blocked" || v.Verdict == "asked" {
		value = "blocked; event=" + ev.EventID
		if !v.Enforced {
			value = "would-block; event=" + ev.EventID
		}
	}
	return value, block
}

const blockNoticeGap = 10 * time.Second

func (a *Agent) repeatBlockLocked(ev Event, v engine.Decision, now time.Time) bool {
	if !v.Enforced || (v.Verdict != "blocked" && v.Verdict != "asked") {
		return false
	}
	app := ""
	if ev.App != nil {
		app = ev.App.BundleID + "|" + ev.App.Name
	}
	key := ev.Action + "|" + ev.ServiceID + "|" + ev.RuleID + "|" + ev.Reason + "|" + app
	if a.notified == nil {
		a.notified = map[string]time.Time{}
	}
	last, ok := a.notified[key]
	for k, at := range a.notified {
		if now.Sub(at) >= blockNoticeGap {
			delete(a.notified, k)
		}
	}
	a.notified[key] = now
	return ok && now.Sub(last) < blockNoticeGap
}
