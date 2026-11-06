// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"github.com/vibtra/guard/guard/agent-go/policy"
)

const policyCheckpointName = "active-policy.json"

type policyPair struct {
	Bundle    json.RawMessage `json:"bundle"`
	Catalogue json.RawMessage `json:"catalogue,omitempty"`
}

func (a *Agent) lockPolicyStore() (func(), error) {
	a.policyMu.Lock()
	unlock, e := lockFile(filepath.Join(a.dir, "policy.lock"))
	if e != nil {
		a.policyMu.Unlock()
		return nil, e
	}
	return func() {
		unlock()
		a.policyMu.Unlock()
	}, nil
}
func writePolicyCheckpoint(path string, p policyPair) error {
	raw, e := json.Marshal(p)
	if e != nil {
		return e
	}
	return atomicWrite(path, raw)
}

func samePolicyIdentity(a, b Device) bool {
	return a.DeviceID == b.DeviceID && a.OrgID == b.OrgID && a.Signing == b.Signing
}
func (p policyPair) verify(d Device) (*policy.Bundle, *policy.Catalogue, string, string, error) {
	raw, digest, e := verifyDocument(p.Bundle, "bundle", d)
	if e != nil {
		return nil, nil, "", "", e
	}
	var b policy.Bundle
	if e = json.Unmarshal(raw, &b); e == nil {
		e = validateBundle(b)
	}
	if e != nil {
		return nil, nil, "", "", e
	}
	var c policy.Catalogue
	source := "seed"
	if len(p.Catalogue) > 0 {
		raw, _, e = verifyDocument(p.Catalogue, "catalogue", d)
		source = "signed"
	} else {
		raw = seedCatalogue
	}
	if e == nil {
		e = json.Unmarshal(raw, &c)
	}
	if e != nil {
		return nil, nil, "", "", e
	}
	if c.Version == "" || b.CatalogueVersion != c.Version {
		return nil, nil, "", "", errors.New("policy catalogue version mismatch")
	}
	return &b, &c, digest, source, nil
}

func (a *Agent) readPolicyPair(d Device) (policyPair, error) {
	var p policyPair
	checkpoint := filepath.Join(a.dir, policyCheckpointName)
	raw, e := os.ReadFile(checkpoint)
	if e == nil {
		e = json.Unmarshal(raw, &p)
		return p, e
	}
	if !errors.Is(e, os.ErrNotExist) {
		return p, e
	}
	p.Bundle, e = os.ReadFile(filepath.Join(a.dir, "bundle.json"))
	if e != nil {
		return p, e
	}
	p.Catalogue, e = os.ReadFile(filepath.Join(a.dir, "catalogue.json"))
	if e != nil && !errors.Is(e, os.ErrNotExist) {
		return p, e
	}
	if _, _, _, _, e = p.verify(d); e != nil {
		return p, e
	}
	e = writePolicyCheckpoint(checkpoint, p)
	return p, e
}
func (a *Agent) mirrorPolicyPair(p policyPair) error {
	for _, item := range []struct {
		name string
		raw  []byte
	}{{"bundle.json", p.Bundle}, {"catalogue.json", p.Catalogue}} {
		if len(item.raw) == 0 {
			continue
		}
		path := filepath.Join(a.dir, item.name)
		if current, e := os.ReadFile(path); e == nil && bytes.Equal(current, item.raw) {
			continue
		}
		if e := atomicWrite(path, item.raw); e != nil {
			return e
		}
	}
	return nil
}

func (a *Agent) commitPolicyDownload(d Device, download map[string]json.RawMessage) error {
	unlock, e := a.lockPolicyStore()
	if e != nil {
		return e
	}
	defer unlock()
	var current Device
	if readJSON(filepath.Join(a.dir, "device.json"), &current) != nil || current.Revoked || !samePolicyIdentity(current, d) {
		return errors.New("enrolment changed during policy download")
	}
	p, e := a.readPolicyPair(d)
	if e != nil {
		p = policyPair{}
	}
	if _, _, _, _, e = p.verify(d); e != nil {
		p = policyPair{}
	}
	if raw := download["bundle"]; len(raw) > 0 && !bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		p.Bundle = raw
	}
	if raw := download["catalogue"]; len(raw) > 0 && !bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		p.Catalogue = raw
	}
	if _, _, _, _, e = p.verify(d); e != nil {
		return e
	}
	if e = writePolicyCheckpoint(filepath.Join(a.dir, policyCheckpointName), p); e != nil {
		return errors.New("unable to persist verified policy pair")
	}
	if e = a.mirrorPolicyPair(p); e != nil {
		return errors.New("unable to publish verified policy mirrors")
	}
	return nil
}
