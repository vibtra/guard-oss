// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/vibtra/guard/guard/agent-go/policy"
)

const policyCheckpointName = "active-policy.json"

var errPolicyUnverified = errors.New("the policy on disk did not verify")

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

func sameEnrolment(a, b Device) bool {
	return a.DeviceID == b.DeviceID && a.OrgID == b.OrgID
}

type verifiedPolicy struct {
	bundle    *policy.Bundle
	catalogue *policy.Catalogue
	digest    string
	catSource string
	signed    signedClaims
}

func (p policyPair) verify(d policyPin) (verifiedPolicy, error) {
	raw, digest, signed, e := verifyDocument(p.Bundle, "bundle", d)
	if e != nil {
		return verifiedPolicy{}, e
	}
	b, e := decodeBundle(raw)
	if e != nil {
		return verifiedPolicy{}, e
	}
	var c policy.Catalogue
	source := "seed"
	if len(p.Catalogue) > 0 {
		raw, _, _, e = verifyDocument(p.Catalogue, "catalogue", d)
		source = "signed"
	} else {
		raw = seedCatalogue
	}
	if e == nil {
		e = json.Unmarshal(raw, &c)
	}
	if e != nil {
		return verifiedPolicy{}, e
	}
	if c.Version == "" || b.CatalogueVersion != c.Version {
		return verifiedPolicy{}, errors.New("policy catalogue version mismatch")
	}
	return verifiedPolicy{bundle: &b, catalogue: &c, digest: digest, catSource: source, signed: signed}, nil
}

func (a *Agent) readPolicyPair(d policyPin) (policyPair, error) {
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
	if _, e = p.verify(d); e != nil {
		return p, fmt.Errorf("%w: %w", errPolicyUnverified, e)
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

type bundleAge struct {
	version, revision uint64
	issuedAt          float64
}

func (v verifiedPolicy) age() bundleAge {
	return bundleAge{v.bundle.BundleVersion, v.bundle.ProtectionRevision, v.signed.issuedAt}
}

func (a bundleAge) olderThan(b bundleAge) bool {
	if a.version != b.version {
		return a.version < b.version
	}
	if a.revision != b.revision {
		return a.revision < b.revision
	}
	return a.issuedAt < b.issuedAt
}

func (a *Agent) commitPolicyDownload(enrolled Device, download map[string]json.RawMessage) error {
	unlock, e := a.lockPolicyStore()
	if e != nil {
		return e
	}
	defer unlock()
	var current Device
	if readJSON(filepath.Join(a.dir, "device.json"), &current) != nil || current.Revoked || !sameEnrolment(current, enrolled) {
		return errors.New("enrolment changed during policy download")
	}
	pin := a.pins.anchor(current)
	if pin == nil {
		return errors.New("the pinned policy-signing key is unavailable; keeping the last verified policy")
	}
	d := *pin
	p, e := a.readPolicyPair(d)
	if e != nil {
		p = policyPair{}
	}
	var held bundleAge
	if v, e := p.verify(d); e != nil {
		p = policyPair{}
	} else {
		held = v.age()
	}
	if raw := download["bundle"]; len(raw) > 0 && !bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		p.Bundle = raw
	}
	if raw := download["catalogue"]; len(raw) > 0 && !bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		p.Catalogue = raw
	}
	v, e := p.verify(d)
	if e != nil {
		return e
	}
	if next := v.age(); next.olderThan(held) {
		return fmt.Errorf("refused older policy bundle v%d at protection revision %d signed at %.0f; the verified bundle on disk is v%d at protection revision %d signed at %.0f", next.version, next.revision, next.issuedAt, held.version, held.revision, held.issuedAt)
	}
	if e = writePolicyCheckpoint(filepath.Join(a.dir, policyCheckpointName), p); e != nil {
		return errors.New("unable to persist verified policy pair")
	}
	if e = a.mirrorPolicyPair(p); e != nil {
		return errors.New("unable to publish verified policy mirrors")
	}
	return nil
}
