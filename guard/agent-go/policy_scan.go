// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/vibtra/guard/guard/agent-go/engine"
	"github.com/vibtra/guard/guard/agent-go/policy"
)

func policyScan(eng engine.Engine, dir string, input io.Reader, output io.Writer) error {
	var d Device
	if err := readJSON(filepath.Join(dir, "device.json"), &d); err != nil {
		return err
	}
	if d.Revoked {
		return errors.New("device is revoked")
	}
	docs := map[string][]byte{}
	digests := map[string]string{}
	for _, kind := range []string{"bundle", "catalogue"} {
		raw, err := os.ReadFile(filepath.Join(dir, kind+".json"))
		if err != nil {
			return err
		}
		doc, digest, _, err := verifyDocument(raw, kind, d)
		if err != nil {
			return err
		}
		docs[kind] = doc
		digests[kind] = digest
	}
	var b policy.Bundle
	var c policy.Catalogue
	if err := json.Unmarshal(docs["bundle"], &b); err != nil {
		return err
	}
	if err := validateBundle(b); err != nil {
		return err
	}
	if err := json.Unmarshal(docs["catalogue"], &c); err != nil {
		return err
	}
	if b.CatalogueVersion != c.Version {
		return errors.New("policy/catalogue changed during read; retry after sync")
	}
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), 16*1024*1024)
	encoder := json.NewEncoder(output)
	now := time.Now()
	for scanner.Scan() {
		var item struct {
			Transport              string   `json:"transport"`
			WebSocketExtensions    string   `json:"websocketExtensions"`
			ID                     string   `json:"id"`
			Host                   string   `json:"host"`
			UserAgent              string   `json:"userAgent"`
			ContentType            string   `json:"contentType"`
			ContentEncoding        string   `json:"contentEncoding"`
			ConnectContentEncoding string   `json:"connectContentEncoding"`
			Body                   string   `json:"body"`
			BodyBase64             string   `json:"bodyBase64"`
			Filenames              []string `json:"filenames"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &item); err != nil {
			return err
		}
		body := []byte(item.Body)
		if item.BodyBase64 != "" {
			var err error
			body, err = base64.StdEncoding.DecodeString(item.BodyBase64)
			if err != nil {
				return errors.New("invalid bodyBase64")
			}
		}
		headers := http.Header{}
		headers.Set("Content-Encoding", item.ContentEncoding)
		headers.Set("Connect-Content-Encoding", item.ConnectContentEncoding)
		ex, inspection := inspectRequestBody(item.ContentType, headers, body)
		coverageFailure := false
		if item.Transport == "websocket" {
			coverageFailure = true
			ex = Extracted{}
			inspection = map[string]any{"state": "flow-only", "reason": "invalid-websocket-message", "transport": "websocket-message"}
			inspector, err := newWebSocketInspector(item.WebSocketExtensions)
			if err == nil {
				reader := bytes.NewReader(body)
				msg, readErr := inspector.readMessage(reader, nil)
				if readErr == nil && reader.Len() == 0 {
					ex, inspection, err = msg.extract()
					coverageFailure = err != nil
				} else {
					err = readErr
				}
			}
			var wsErr *webSocketError
			if errors.As(err, &wsErr) {
				inspection = wsErr.Metadata
			}
			if coverageFailure {
				inspection["coverageFailure"] = true
			}
		}
		checked := inspection["state"] == "inspected"
		if checked {
			ex.Filenames = append(ex.Filenames, item.Filenames...)
		}
		cli, _ := appFromUserAgent(&c, item.UserAgent)
		req := engine.Request{Host: item.Host, CLI: cli, Transport: engine.HTTP, Content: ex, CoverageFailed: inspection["coverageFailure"] == true, Bundle: &b, Catalogue: &c, Now: now}
		if item.Transport == "websocket" {
			req.Transport = engine.WebSocket
			req.CoverageFailed = coverageFailure
		}
		v, err := decide(context.Background(), eng, req)
		if err != nil {
			return err
		}
		row := map[string]any{"id": item.ID, "verdict": v.Verdict, "enforced": v.Enforced, "intercepted": v.Intercepted, "inspectable": checked, "bundleVersion": b.BundleVersion, "bundleDigest": digests["bundle"], "catalogueDigest": digests["catalogue"]}
		row["inspection"] = inspection
		gatingKinds := []string{}
		if v.Service != nil {
			row["serviceId"] = v.Service.ServiceID
			row["flowAction"] = v.Flow.Action
			for _, rule := range b.ContentRules {
				if applies(rule.Services, v.Service.ServiceID) && rank(rule.Action) > 0 && b.Exception(v.Service.ServiceID, rule.RuleID, now) == nil && !contains(gatingKinds, rule.Detector.Kind) {
					gatingKinds = append(gatingKinds, rule.Detector.Kind)
				}
			}
		}
		row["gatingKinds"] = gatingKinds
		hits := []any{}
		if v.Content != nil {
			for _, m := range v.Content.Matches {
				hit := map[string]any{"ruleId": m.Rule.RuleID, "kind": m.Match.Kind, "count": m.Match.Count, "action": m.Rule.Action, "excepted": m.Excepted}
				if m.Unavailable != "" {
					hit["unavailable"] = m.Unavailable
					hit["action"] = "block"
				}
				hits = append(hits, hit)
			}
		}
		row["matches"] = hits
		if err := encoder.Encode(row); err != nil {
			return err
		}
	}
	return scanner.Err()
}
