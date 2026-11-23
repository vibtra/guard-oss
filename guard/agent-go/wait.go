// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package main

import (
	"context"
	"errors"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

const (
	waitHoldMax          = 55 * time.Second
	waitHoldMin          = 5 * time.Second
	waitHoldStep         = 5 * time.Second
	waitGrowAfter        = 10
	waitClientMargin     = 10 * time.Second
	waitCutMargin        = 5 * time.Second
	waitRetryMax         = 30 * time.Second
	waitUnsupportedPause = time.Hour
	waitIdle             = 5 * time.Second
	waitCheckInLimit     = 15 * time.Minute
	waitAsksPerStamp     = 2
	waitRetryDoublings   = 3
)

type holdTuner struct {
	hold      time.Duration
	completed int
	cutAt     time.Duration
}

func (t *holdTuner) finished() {
	t.cutAt = 0
	t.completed++
	if t.completed >= waitGrowAfter && t.hold < waitHoldMax {
		t.hold = min(waitHoldMax, t.hold+waitHoldStep)
		t.completed = 0
	}
}

func (t *holdTuner) cut(elapsed time.Duration) bool {
	t.completed = 0
	if t.cutAt == 0 {
		t.cutAt = elapsed
		return false
	}
	t.hold = max(waitHoldMin, min(t.cutAt, elapsed)-waitCutMargin)
	t.cutAt = 0
	return true
}

func (t *holdTuner) isCut(e error, elapsed time.Duration) bool {
	var network *registryNetworkError
	var refused *registryError
	gateway := errors.As(e, &refused) && (refused.status == http.StatusBadGateway || refused.status == http.StatusGatewayTimeout)
	return (errors.As(e, &network) || gateway) && elapsed >= waitHoldMin && elapsed < t.hold-waitCutMargin
}

func waitUnsupported(e error) bool {
	var refused *registryError
	return errors.As(e, &refused) && refused.status == http.StatusNotFound
}

func pause(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}

func (a *Agent) waitOnce(ctx context.Context, d Device, stamp string, hold time.Duration) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, hold+waitClientMargin)
	defer cancel()
	query := url.Values{"stamp": {stamp}, "hold": {strconv.Itoa(int(hold / time.Second))}}
	var res struct {
		Answer string `json:"answer"`
	}
	if e := a.call(ctx, d, "GET", "/sync/wait/"+d.DeviceID+"?"+query.Encode(), nil, &res); e != nil {
		return "", e
	}
	return res.Answer, nil
}

func (a *Agent) checkInFor(ctx context.Context, synced <-chan Message, ask bool) {
	for drained := false; !drained; {
		select {
		case <-synced:
		default:
			drained = true
		}
	}
	if ask {
		a.syncSoon()
	}
	limit := time.NewTimer(waitCheckInLimit)
	defer limit.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-limit.C:
			return
		case m := <-synced:
			if m.Name == "synced" {
				return
			}
		}
	}
}

func (a *Agent) waitLoop(ctx context.Context) {
	synced, unsubscribe := a.subscribe()
	defer unsubscribe()
	tuner := holdTuner{hold: waitHoldMax}
	askedStamp, asks := "", 0
	failures := 0
	for ctx.Err() == nil {
		b, _, d := a.snapshot()
		if d == nil || d.Revoked || b == nil {
			pause(ctx, waitIdle)
			continue
		}
		stamp := strconv.FormatUint(b.BundleVersion, 10) + "." + strconv.FormatUint(b.ProtectionRevision, 10)
		hold := tuner.hold
		started := time.Now()
		answer, e := a.waitOnce(ctx, *d, stamp, hold)
		elapsed := time.Since(started)
		if ctx.Err() != nil {
			return
		}
		if e == nil {
			failures = 0
			slog.Debug("long-poll wait answered", "answer", answer, "hold_s", int(hold/time.Second), "elapsed_ms", durationMS(elapsed))
		}
		switch {
		case e == nil && answer == "unchanged":
			tuner.finished()
		case e == nil && (answer == "changed" || answer == "recheck"):
			tuner.cutAt = 0
			if stamp != askedStamp {
				askedStamp, asks = stamp, 0
			}
			asks++
			a.checkInFor(ctx, synced, asks <= waitAsksPerStamp)
		case e == nil && answer == "unsupported" || waitUnsupported(e):
			slog.Info("the registry does not offer long polling; the agent checks in on its interval", "retry_in_s", int(waitUnsupportedPause/time.Second))
			pause(ctx, waitUnsupportedPause)
		case errors.Is(e, errRevoked):
			pause(ctx, waitIdle)
		default:
			if tuner.isCut(e, elapsed) {
				if tuner.cut(elapsed) {
					slog.Info("something between the agent and the registry cuts long waits; holding for less", "hold_s", int(tuner.hold/time.Second), "cut_after_ms", durationMS(elapsed))
				}
			} else {
				tuner.cutAt = 0
			}
			failures++
			retry := rand.N(waitRetrySpread()<<min(failures-1, waitRetryDoublings) + 1)
			slog.Debug("long-poll wait failed; trying again after a random delay", "error", errText(e), "elapsed_ms", durationMS(elapsed), "retry_in_ms", durationMS(retry))
			pause(ctx, retry)
		}
	}
}
