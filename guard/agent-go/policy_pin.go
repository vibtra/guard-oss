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
	"log/slog"
	"os"
	"path/filepath"
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
	reasonPolicyKeyUntrusted   = "policy-key-untrusted-source"
	pinSourceFirstUse          = "first-use"
	pinRetryAfter              = 15 * time.Second
	maxPinBytes                = 4096
)

var (
	errNoPin              = errors.New("no policy-signing key is pinned")
	errPinExists          = errors.New("a policy-signing key is already pinned")
	errUntrustedPinSource = errors.New("the pinned policy-signing key was taken from device.json by an earlier Guard (first-use), which this Guard does not trust; enrol again")
)

type policyPin struct {
	DeviceID string     `json:"deviceId"`
	OrgID    string     `json:"orgId"`
	Signing  SigningKey `json:"signing"`
	Source   string     `json:"source"`
	PinnedAt string     `json:"pinnedAt"`
}

type policyKeyStore interface {
	PinPolicyKey(pin policyPin) error
	PinPolicyKeyIfAbsent(pin policyPin) error
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
	if p.Source == pinSourceFirstUse {
		return policyPin{}, errUntrustedPinSource
	}
	return p, p.validate()
}

type pinPhase string

const (
	phaseLoading     pinPhase = "loading"
	phaseNoPin       pinPhase = "no-pin"
	phaseFetching    pinPhase = "fetching"
	phasePinned      pinPhase = "pinned"
	phaseUnavailable pinPhase = "unavailable"
	phaseMismatch    pinPhase = "mismatch"
)

type pinState struct {
	store    policyKeyStore
	mu       sync.Mutex
	phase    pinPhase
	held     *policyPin
	reason   string
	retry    time.Time
	gen      uint64
	fetchFor Device
}

type pinFetch struct {
	gen    uint64
	device Device
}

var errFetchDiscarded = errors.New("enrolment changed while fetching the policy-signing key")

func (s *pinState) reset() {
	s.phase, s.held, s.retry = phaseLoading, nil, time.Time{}
	s.gen++
}

func (s *pinState) set(phase pinPhase, held *policyPin, reason string, cause error) {
	switch reason {
	case s.reason:
	case "":
		slog.Info("policy-signing key usable again", "previous_reason", s.reason)
	case reasonPolicyKeyFetching:
		slog.Info("fetching the policy-signing key from the registry", "store", s.store.Kind())
	default:
		slog.Error("policy-signing key unusable; keeping the last verified policy", "reason", reason, "store", s.store.Kind(), "error", errText(cause))
	}
	s.phase, s.held, s.reason, s.retry = phase, held, reason, time.Time{}
	s.gen++
	if phase == phaseNoPin || phase == phaseUnavailable || phase == phaseMismatch {
		s.retry = time.Now().Add(pinRetryAfter)
	}
}

func (s *pinState) settled(d Device) (*policyPin, bool) {
	switch s.phase {
	case phaseFetching:
		return nil, true
	case phasePinned:
		return s.held, s.held.matches(d)
	case phaseMismatch, phaseNoPin, phaseUnavailable:
		if s.phase == phaseMismatch && s.held.matches(d) {
			s.set(phasePinned, s.held, "", nil)
			return s.held, true
		}
		return s.held, time.Now().Before(s.retry)
	}
	return s.held, false
}

func (s *pinState) anchor(d Device) *policyPin {
	s.mu.Lock()
	if s.phase == phaseFetching && !sameEnrolment(s.fetchFor, d) {
		s.reset()
	}
	if held, ok := s.settled(d); ok {
		s.mu.Unlock()
		return held
	}
	gen := s.gen
	s.mu.Unlock()
	pin, e := s.store.PinnedPolicyKey()
	s.mu.Lock()
	defer s.mu.Unlock()
	if gen != s.gen {
		held, _ := s.settled(d)
		return held
	}
	switch {
	case errors.Is(e, errNoPin):
		s.set(phaseNoPin, nil, reasonPolicyKeyFetching, e)
	case errors.Is(e, errUntrustedPinSource):
		s.set(phaseUnavailable, s.held, reasonPolicyKeyUntrusted, e)
	case e != nil:
		s.set(phaseUnavailable, s.held, reasonPolicyKeyUnavailable, e)
	case !pin.matches(d):
		s.set(phaseMismatch, &pin, reasonPolicyKeyMismatch, errors.New("device.json names another device or organisation than the pinned key"))
	default:
		s.set(phasePinned, &pin, "", nil)
	}
	return s.held
}

func (s *pinState) pin(pin policyPin) error {
	if e := s.store.PinPolicyKey(pin); e != nil {
		return e
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.set(phasePinned, &pin, "", nil)
	return nil
}

func (s *pinState) beginFetch(d Device) (pinFetch, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.phase != phaseNoPin {
		return pinFetch{}, false
	}
	s.set(phaseFetching, nil, reasonPolicyKeyFetching, nil)
	s.fetchFor = d
	return pinFetch{gen: s.gen, device: d}, true
}

func (s *pinState) current(f pinFetch) bool { return s.phase == phaseFetching && s.gen == f.gen }

func (s *pinState) fetchFailed(f pinFetch, cause error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	case !s.current(f):
	case errors.Is(cause, errFetchDiscarded):
		s.reset()
	default:
		s.set(phaseNoPin, nil, reasonPolicyKeyFetching, cause)
	}
}

func (s *pinState) pinFetched(f pinFetch, pin policyPin) error {
	s.mu.Lock()
	owned := s.current(f)
	s.mu.Unlock()
	if !owned {
		return errFetchDiscarded
	}
	e := s.store.PinPolicyKeyIfAbsent(pin)
	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	case !s.current(f):
		return errFetchDiscarded
	case errors.Is(e, errPinExists):
		s.reset()
		return nil
	case e != nil:
		s.set(phaseNoPin, nil, reasonPolicyKeyFetching, e)
		return e
	}
	s.set(phasePinned, &pin, "", nil)
	return nil
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

func (s filePinStore) PinPolicyKeyIfAbsent(pin policyPin) error {
	if e := pin.validate(); e != nil {
		return e
	}
	raw, e := json.MarshalIndent(pin, "", "  ")
	if e != nil {
		return e
	}
	f, e := os.CreateTemp(filepath.Dir(s.path), ".guard-pin-*")
	if e != nil {
		return e
	}
	defer func() { _ = os.Remove(f.Name()) }()
	if e = f.Chmod(0600); e == nil {
		_, e = f.Write(append(raw, '\n'))
	}
	if e == nil {
		e = f.Sync()
	}
	if closeErr := f.Close(); e == nil {
		e = closeErr
	}
	if e != nil {
		return e
	}
	if e = os.Link(f.Name(), s.path); errors.Is(e, os.ErrExist) {
		return errPinExists
	}
	return e
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
