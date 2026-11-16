// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"os"
	"sync"
	"time"
)

const (
	pinSourceEnrolment         = "enrolment"
	pinSourceRegistry          = "registry"
	pinStoreKeychain           = "keychain"
	pinStoreUnprotected        = "unprotected"
	reasonPolicyKeyFetching    = "policy-key-fetching"
	reasonPolicyKeyMismatch    = "policy-key-mismatch"
	reasonPolicyKeyUnavailable = "policy-key-unavailable"
	pinRetryAfter              = 15 * time.Second
	maxPinBytes                = 4096
)

var errNoPin = errors.New("no policy-signing key is pinned")

type policyPin struct {
	DeviceID string     `json:"deviceId"`
	OrgID    string     `json:"orgId"`
	Signing  SigningKey `json:"signing"`
	Source   string     `json:"source"`
	PinnedAt string     `json:"pinnedAt"`
}

type policyKeyStore interface {
	PinPolicyKey(pin policyPin) error
	PinnedPolicyKey() (policyPin, error)
	Kind() string
}

func pinFor(d Device, signing SigningKey, source string) (policyPin, error) {
	p := policyPin{DeviceID: d.DeviceID, OrgID: d.OrgID, Signing: signing, Source: source, PinnedAt: nowISO()}
	return p, p.validate()
}

func (p policyPin) validate() error {
	if p.DeviceID == "" || p.OrgID == "" || p.Signing.KeyID == "" || p.Signing.Alg != "ES256" || p.Source != pinSourceEnrolment && p.Source != pinSourceRegistry {
		return errors.New("the policy-signing key is incomplete")
	}
	block, _ := pem.Decode([]byte(p.Signing.PublicKeyPEM))
	if block == nil {
		return errors.New("the policy-signing key is not PEM")
	}
	key, e := x509.ParsePKIXPublicKey(block.Bytes)
	if e != nil {
		return e
	}
	if pub, ok := key.(*ecdsa.PublicKey); !ok || pub.Curve != elliptic.P256() {
		return errors.New("the policy-signing key is not P-256")
	}
	return nil
}

func (p policyPin) matches(d Device) bool {
	return sameEnrolment(Device{DeviceID: p.DeviceID, OrgID: p.OrgID}, d)
}

func (p policyPin) sameKey(q policyPin) bool {
	return p.DeviceID == q.DeviceID && p.OrgID == q.OrgID && p.Signing == q.Signing
}

func decodePin(raw []byte) (policyPin, error) {
	var p policyPin
	if len(raw) > maxPinBytes {
		return p, errors.New("the pinned policy-signing key is too large")
	}
	if e := json.Unmarshal(raw, &p); e != nil {
		return p, e
	}
	return p, p.validate()
}

type pinState struct {
	store  policyKeyStore
	mu     sync.Mutex
	held   *policyPin
	retry  time.Time
	reason string
}

func (s *pinState) anchor(d Device) *policyPin {
	s.mu.Lock()
	held, waiting := s.held, time.Now().Before(s.retry)
	s.mu.Unlock()
	if held != nil && held.matches(d) {
		return s.settle(held, "")
	}
	if waiting {
		return held
	}
	pin, e := s.store.PinnedPolicyKey()
	switch {
	case errors.Is(e, errNoPin):
		return s.settle(nil, reasonPolicyKeyFetching)
	case e != nil:
		return s.settle(held, reasonPolicyKeyUnavailable)
	case !pin.matches(d):
		return s.settle(&pin, reasonPolicyKeyMismatch)
	}
	return s.settle(&pin, "")
}

func (s *pinState) settle(held *policyPin, reason string) *policyPin {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.held, s.reason, s.retry = held, reason, time.Time{}
	if held == nil || reason != "" {
		s.retry = time.Now().Add(pinRetryAfter)
	}
	return held
}

func (s *pinState) pin(pin policyPin) error {
	if e := s.store.PinPolicyKey(pin); e != nil {
		return e
	}
	s.settle(&pin, "")
	return nil
}

func (s *pinState) pinFetched(pin policyPin) error {
	_, e := s.store.PinnedPolicyKey()
	switch {
	case e == nil:
		s.mu.Lock()
		s.retry = time.Time{}
		s.mu.Unlock()
		return nil
	case !errors.Is(e, errNoPin):
		return e
	}
	return s.pin(pin)
}

func (s *pinState) fetching() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.reason == reasonPolicyKeyFetching
}

func (s *pinState) keyID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.held != nil {
		return s.held.Signing.KeyID
	}
	return ""
}

func (s *pinState) health() map[string]any {
	out := map[string]any{"store": s.store.Kind()}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.held != nil {
		out["pinned"] = s.held.Source
	}
	if s.reason != "" {
		out["reason"] = s.reason
	}
	return out
}

type filePinStore struct {
	path string
	kind string
}

func (s filePinStore) PinPolicyKey(pin policyPin) error {
	if e := pin.validate(); e != nil {
		return e
	}
	return writeJSON(s.path, pin)
}

func (s filePinStore) PinnedPolicyKey() (policyPin, error) {
	raw, e := os.ReadFile(s.path)
	if errors.Is(e, os.ErrNotExist) {
		return policyPin{}, errNoPin
	}
	if e != nil {
		return policyPin{}, e
	}
	return decodePin(raw)
}

func (s filePinStore) Kind() string { return s.kind }
