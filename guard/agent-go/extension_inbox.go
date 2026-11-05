// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"syscall"
	"time"

	"github.com/vibtra/guard/guard/agent-go/policy"
)

const extensionBatchBytes = 64 * 1024
const extensionLineBytes = 4096

type extensionCursor struct {
	Device uint64   `json:"device"`
	Inode  uint64   `json:"inode"`
	Offset int64    `json:"offset"`
	Since  string   `json:"since"`
	Latest string   `json:"latest,omitempty"`
	IDs    []string `json:"ids,omitempty"`
}

type extensionRow struct {
	EventID    string `json:"eventId"`
	OccurredAt string `json:"occurredAt"`
	Kind       string `json:"kind"`
	Action     string `json:"action"`
	ServiceID  string `json:"serviceId"`
	Host       string `json:"host"`
	Port       int    `json:"port,omitempty"`
	App        *struct {
		BundleID string `json:"bundleId"`
	} `json:"app,omitempty"`
	RuleID        string `json:"ruleId,omitempty"`
	RuleKind      string `json:"ruleKind"`
	BundleVersion uint64 `json:"bundleVersion"`
}

var extensionID = regexp.MustCompile(`^gev_[0-9a-f]{16}$`)
var extensionHost = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$`)
var extensionSigningID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$`)

func privateInboxFile(path string) (*os.File, *syscall.Stat_t, error) {
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, nil, err
	}
	info, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, nil, err
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || st.Uid != uint32(os.Getuid()) {
		_ = f.Close()
		return nil, nil, errors.New("extension inbox must be a private owned regular file")
	}
	return f, st, nil
}

func parseExtensionRow(line []byte, b *policy.Bundle, c *policy.Catalogue, now time.Time) (Event, bool) {
	var r extensionRow
	dec := json.NewDecoder(bytes.NewReader(line))
	dec.DisallowUnknownFields()
	if dec.Decode(&r) != nil || dec.Decode(new(any)) != io.EOF {
		return Event{}, false
	}
	at, err := time.Parse(time.RFC3339Nano, r.OccurredAt)
	if err != nil || at.After(now.Add(5*time.Minute)) || !extensionID.MatchString(r.EventID) || r.Kind != "flow" || !extensionHost.MatchString(r.Host) || r.Port < 0 || r.Port > 65535 || b == nil || c == nil || b.ClientMode != "enforce" || r.BundleVersion != b.BundleVersion {
		return Event{}, false
	}
	signing := ""
	if r.App != nil {
		signing = r.App.BundleID
		if !extensionSigningID.MatchString(signing) {
			return Event{}, false
		}
	}
	service := c.Service(r.Host, signing, "")
	if service == nil || service.ServiceID != r.ServiceID {
		return Event{}, false
	}
	flow := b.Flow(r.ServiceID, at)
	kind := flow.Source
	if kind == "rule" {
		kind = "service"
	}
	action := map[string]string{"block": "blocked", "ask": "asked"}[flow.Action]
	if action == "" || r.Action != action || r.RuleKind != kind || r.RuleID != flow.RuleID {
		return Event{}, false
	}
	return Event{EventID: r.EventID, OccurredAt: r.OccurredAt, Kind: "flow", Action: r.Action, ServiceID: r.ServiceID, Host: r.Host, Port: r.Port, RuleID: r.RuleID, RuleKind: r.RuleKind, BundleVersion: r.BundleVersion, Reason: "extension-flow"}, true
}

func (a *Agent) ingestExtensionInbox(b *policy.Bundle, c *policy.Catalogue) error {
	if b == nil || c == nil {
		return nil
	}
	path := filepath.Join(a.dir, "events-from-extension.jsonl")
	cursorPath := filepath.Join(a.dir, "extension-inbox-cursor.json")
	var cursor extensionCursor
	cf, _, err := privateInboxFile(cursorPath)
	fresh := os.IsNotExist(err)
	if err != nil && !fresh {
		return err
	}
	if !fresh {
		raw, e := io.ReadAll(io.LimitReader(cf, 128*1024+1))
		_ = cf.Close()
		if e != nil {
			return e
		}
		if len(raw) > 128*1024 || json.Unmarshal(raw, &cursor) != nil || cursor.Offset < 0 || cursor.Since == "" || len(cursor.IDs) > 512 {
			return errors.New("invalid extension inbox checkpoint")
		}
	}
	f, st, err := privateInboxFile(path)
	missing := os.IsNotExist(err)
	if err != nil && !missing {
		return err
	}
	if !missing {
		defer func() { _ = f.Close() }()
	}
	if fresh {
		cursor.Since = nowISO()
		if !missing {
			cursor.Device = uint64(st.Dev)
			cursor.Inode = uint64(st.Ino)
			cursor.Offset = st.Size
		}
		return writeJSON(cursorPath, cursor)
	}
	if missing {
		if cursor.Inode != 0 {
			return errors.New("extension inbox disappeared")
		}
		return nil
	}
	if cursor.Inode == 0 {
		cursor.Device = uint64(st.Dev)
		cursor.Inode = uint64(st.Ino)
	}
	if cursor.Device != uint64(st.Dev) || cursor.Inode != uint64(st.Ino) || st.Size < cursor.Offset {
		return errors.New("extension inbox replaced or truncated")
	}
	if _, err = f.Seek(cursor.Offset, io.SeekStart); err != nil {
		return err
	}
	data, err := io.ReadAll(io.LimitReader(f, extensionBatchBytes))
	if err != nil {
		return err
	}
	end := bytes.LastIndexByte(data, '\n')
	if end < 0 {
		if len(data) >= extensionLineBytes {
			return errors.New("extension inbox oversized incomplete row")
		}
		return nil
	}
	events := []Event{}
	since, e := time.Parse(time.RFC3339Nano, cursor.Since)
	if e != nil {
		return errors.New("invalid extension inbox baseline")
	}
	latest := since
	if cursor.Latest != "" {
		latest, e = time.Parse(time.RFC3339Nano, cursor.Latest)
		if e != nil {
			return errors.New("invalid extension inbox watermark")
		}
	}
	for _, line := range bytes.Split(data[:end], []byte{'\n'}) {
		if len(line) > extensionLineBytes {
			continue
		}
		ev, ok := parseExtensionRow(line, b, c, time.Now())
		if !ok {
			continue
		}
		at, _ := time.Parse(time.RFC3339Nano, ev.OccurredAt)
		if at.Before(latest) || contains(cursor.IDs, ev.EventID) {
			continue
		}
		if at.After(latest) {
			latest = at
			cursor.IDs = nil
		}
		if len(cursor.IDs) >= 512 {
			continue
		}
		cursor.IDs = append(cursor.IDs, ev.EventID)
		cursor.Latest = ev.OccurredAt
		events = append(events, ev)
	}
	cursor.Offset += int64(end + 1)
	if len(events) > 0 {
		if err = a.queue(func(q []Event) ([]Event, error) {
			seen := map[string]bool{}
			for _, ev := range q {
				seen[ev.EventID] = true
			}
			for _, ev := range events {
				if !seen[ev.EventID] {
					q = append(q, ev)
					seen[ev.EventID] = true
				}
			}
			return q, nil
		}); err != nil {
			return err
		}
	}
	if err = writeJSON(cursorPath, cursor); err != nil {
		return err
	}
	for _, ev := range events {
		a.publishExtensionFlow(ev, b, c)
	}
	return nil
}

func (a *Agent) publishExtensionFlow(ev Event, b *policy.Bundle, c *policy.Catalogue) {
	raw, _ := json.Marshal(ev)
	payload := map[string]any{}
	_ = json.Unmarshal(raw, &payload)
	payload["enforced"] = true
	payload["requestsEnabled"] = b.Settings.RequestsEnabled
	block := Block{Event: ev, Enforced: true, RequestsEnabled: b.Settings.RequestsEnabled, Note: b.Flow(ev.ServiceID, time.Now()).Note}
	if b.Settings.WorkspaceRedirect.Enabled {
		block.Workspace = b.Settings.WorkspaceRedirect.URL
		payload["workspace"] = block.Workspace
	}
	payload["inspection"] = map[string]any{"state": "flow-only", "reason": "extension-policy-drop", "attribution": "extension-inbox-report"}
	for _, s := range c.Services {
		if s.ServiceID == ev.ServiceID {
			payload["serviceName"] = s.Name
			block.ServiceName = s.Name
			break
		}
	}
	a.mu.Lock()
	for _, row := range a.activity {
		if row["eventId"] == ev.EventID {
			a.mu.Unlock()
			return
		}
	}
	day := time.Now().Format("2006-01-02")
	if a.countDay != day {
		a.countDay = day
		a.today = map[string]int{}
	}
	a.blocks[ev.EventID] = block
	a.blockOrder = append(a.blockOrder, ev.EventID)
	if len(a.blockOrder) > 300 {
		delete(a.blocks, a.blockOrder[0])
		delete(a.asks, a.blockOrder[0])
		a.blockOrder = a.blockOrder[1:]
	}
	a.today[ev.Action]++
	a.activity = append([]map[string]any{payload}, a.activity...)
	if len(a.activity) > 300 {
		a.activity = a.activity[:300]
	}
	a.mu.Unlock()
}
