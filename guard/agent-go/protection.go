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

type clockSample struct{ mono, wall time.Time }

func sampleClock() clockSample { return clockSample{mono: time.Now(), wall: wallNow()} }

func (s clockSample) awake(mono time.Time) time.Time { return s.wall.Add(mono.Sub(s.mono)) }

type missedSpan struct{ from, to, until time.Time }

func (m missedSpan) holds(now, offWaitSince time.Time) bool {
	return now.Before(m.until) || !offWaitSince.IsZero() && now.Sub(offWaitSince) < offWaitLimit && offWaitSince.Before(m.until)
}

type policyClock struct {
	last   clockSample
	missed []missedSpan
}

func (c policyClock) at(now clockSample, validUntil, offWaitSince time.Time) time.Time {
	for _, m := range c.missed {
		if m.from.Before(validUntil) && !validUntil.After(m.to) && m.holds(now.mono, offWaitSince) {
			return m.from
		}
	}
	if c.last.mono.IsZero() {
		return now.wall
	}
	if awake := c.last.awake(now.mono); awake.Before(now.wall) {
		return awake
	}
	return now.wall
}

func (a *Agent) policyTimeLocked() time.Time {
	return a.clock.at(sampleClock(), a.held.validUntil, a.offWaitSince)
}

func (a *Agent) startClock() {
	now := sampleClock()
	a.mu.Lock()
	a.clock = policyClock{last: now, missed: []missedSpan{{to: now.wall, until: now.mono.Add(graceAfterWake())}}}
	a.mu.Unlock()
}

func (a *Agent) observeClock() (woke bool) {
	now := sampleClock()
	a.mu.Lock()
	defer a.mu.Unlock()
	var kept []missedSpan
	for _, m := range a.clock.missed {
		if m.holds(now.mono, a.offWaitSince) {
			kept = append(kept, m)
		}
	}
	awake := a.clock.last.awake(now.mono)
	if woke = now.wall.Sub(awake) > sleptOver; woke {
		kept = append(kept, missedSpan{from: awake, to: now.wall, until: now.mono.Add(graceAfterWake())})
	}
	a.clock = policyClock{last: now, missed: kept}
	return woke
}

func (a *Agent) checkedIn() {
	now := time.Now()
	a.mu.Lock()
	defer a.mu.Unlock()
	for i, m := range a.clock.missed {
		if now.Before(m.until) {
			a.clock.missed[i].until = now
		}
	}
}

func (a *Agent) inGrace() bool {
	now := time.Now()
	a.mu.RLock()
	defer a.mu.RUnlock()
	for _, m := range a.clock.missed {
		if now.Before(m.until) {
			return true
		}
	}
	return false
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
