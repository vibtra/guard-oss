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

func (a *Agent) inspecting() bool {
	b, _, _ := a.snapshot()
	return inspects(b)
}

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

func wallNow() time.Time { return time.Now().Round(0).Add(clockSkew()) }

type policyClock struct{ seen, missedFrom, missedTo time.Time }

func (c policyClock) at(wall, validUntil time.Time) time.Time {
	if c.missedFrom.Before(validUntil) && !validUntil.After(c.missedTo) {
		return c.missedFrom
	}
	if c.seen.IsZero() || wall.Before(c.seen) {
		return wall
	}
	return c.seen
}

func (a *Agent) policyTimeLocked() time.Time { return a.clock.at(wallNow(), a.held.validUntil) }

func (a *Agent) startClock() clockSample {
	now := sampleClock()
	a.mu.Lock()
	a.clock = policyClock{seen: now.wall, missedTo: now.wall}
	a.mu.Unlock()
	return now
}

func (a *Agent) sawClock(prev, now clockSample) (woke bool) {
	woke = now.sleptSince(prev)
	a.mu.Lock()
	defer a.mu.Unlock()
	if woke {
		if a.clock.missedTo.IsZero() {
			a.clock.missedFrom = prev.wall
		}
		a.clock.missedTo = now.wall
	}
	a.clock.seen = now.wall
	return woke
}

func (a *Agent) endMissedExpiry() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.offWaitSince.IsZero() && time.Since(a.offWaitSince) < offWaitLimit {
		return false
	}
	a.clock.missedFrom, a.clock.missedTo = time.Time{}, time.Time{}
	return true
}

func (a *Agent) waitsForExtensionLocked(next heldPolicy, now time.Time) (wait, started bool) {
	at := a.policyTimeLocked()
	if !inspects(a.held.at(at)) || inspects(next.at(at)) || !a.probes.steers(now) {
		a.offWaitSince = time.Time{}
		return false, false
	}
	if a.offWaitSince.IsZero() {
		a.offWaitSince = now
		started = true
	}
	return now.Sub(a.offWaitSince) < offWaitLimit, started
}
