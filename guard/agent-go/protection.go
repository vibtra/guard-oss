// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package main

import (
	"time"

	"github.com/vibtra/guard/guard/agent-go/policy"
)

const (
	modeOff     = "off"
	modeMonitor = "monitor"
	modeEnforce = "enforce"

	refreshBeforeExpiry  = 24 * time.Hour
	extensionProbesFresh = 10 * time.Second
	offWaitLimit         = 30 * time.Second
)

var modeRank = map[string]int{modeOff: 0, modeMonitor: 1, modeEnforce: 2}

func modeOrEnforce(mode string) string {
	if _, known := modeRank[mode]; known {
		return mode
	}
	return modeEnforce
}

func raiseMode(a, b string) string {
	if modeRank[b] > modeRank[a] {
		return b
	}
	return a
}

func inspects(b *policy.Bundle) bool { return b != nil && b.ClientMode != modeOff }

type heldPolicy struct {
	signed, fallback *policy.Bundle
	validUntil       time.Time
}

func holdPolicy(b *policy.Bundle, validUntil float64) heldPolicy {
	h := heldPolicy{signed: b}
	if validUntil > 0 {
		fallback := *b
		fallback.ClientMode = raiseMode(b.ClientMode, b.DefaultMode)
		h.fallback, h.validUntil = &fallback, time.Unix(int64(validUntil), 0)
	}
	return h
}

func (h heldPolicy) expired(now time.Time) bool {
	return h.fallback != nil && !now.Before(h.validUntil)
}

func (h heldPolicy) at(now time.Time) *policy.Bundle {
	if h.expired(now) {
		return h.fallback
	}
	return h.signed
}

func (h heldPolicy) wantsFreshSignature(now time.Time) bool {
	return h.fallback != nil && h.validUntil.Sub(now) < refreshBeforeExpiry
}

type extensionProbes struct {
	seen time.Time
	off  bool
}

func (p extensionProbes) active(now time.Time) bool {
	return !p.seen.IsZero() && now.Sub(p.seen) < extensionProbesFresh
}

func (p extensionProbes) steers(now time.Time) bool { return p.active(now) && !p.off }

func (a *Agent) extensionProbed(off bool) {
	a.mu.Lock()
	a.probes = extensionProbes{seen: time.Now(), off: off}
	a.mu.Unlock()
}

func (a *Agent) extensionActive() bool {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.probes.active(time.Now())
}

func (a *Agent) waitsForExtensionLocked(next heldPolicy, now time.Time) (wait, started bool) {
	if !inspects(a.held.at(now)) || inspects(next.at(now)) || !a.probes.steers(now) {
		a.offWaitSince = time.Time{}
		return false, false
	}
	if a.offWaitSince.IsZero() {
		a.offWaitSince = now
		started = true
	}
	return now.Sub(a.offWaitSince) < offWaitLimit, started
}
