// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"runtime"
	"runtime/debug"
	"strings"
	"sync"
	"time"
)

type tracedWriter struct {
	http.ResponseWriter
	status   int
	bytes    int64
	hijacked bool
}

func (w *tracedWriter) WriteHeader(code int) {
	if w.status == 0 && code >= 200 {
		w.status = code
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *tracedWriter) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	n, e := w.ResponseWriter.Write(b)
	w.bytes += int64(n)
	return n, e
}

func (w *tracedWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		if w.status == 0 {
			w.status = http.StatusOK
		}
		f.Flush()
	}
}

func (w *tracedWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h, ok := w.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, http.ErrNotSupported
	}
	c, rw, e := h.Hijack()
	if e == nil {
		w.hijacked = true
	}
	return c, rw, e
}

func (w *tracedWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

const (
	traceProxy = "proxy"
	traceLocal = "local"
)

func requestHost(r *http.Request) string {
	host := r.URL.Hostname()
	if host == "" {
		host = r.Host
		if h, _, e := net.SplitHostPort(r.Host); e == nil {
			host = h
		}
	}
	return strings.ToLower(strings.TrimSuffix(host, "."))
}

func localRoute(path string) string {
	first, _, _ := strings.Cut(strings.Trim(path, "/"), "/")
	switch first {
	case "", "diagnostics", "healthz", "status", "policy", "activity", "ca.pem", "events", "ca", "blocked", "debug":
		return "/" + first
	}
	return "/_"
}

func panicText(rec any) string {
	if e, ok := rec.(runtime.Error); ok {
		return e.Error()
	}
	return fmt.Sprintf("%T", rec)
}

func traced(kind string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		ctx, t := newTrace(r.Context(), "request_id")
		r = r.WithContext(ctx)
		t.host = requestHost(r)
		tw := &tracedWriter{ResponseWriter: w}
		defer func() {
			rec := recover()
			if e, ok := rec.(error); ok && errors.Is(e, http.ErrAbortHandler) {
				finishTrace(kind, r, t, tw, start)
				panic(rec)
			}
			if rec != nil {
				t.log.LogAttrs(ctx, slog.LevelError, "panic serving request", slog.String("panic", panicText(rec)), slog.String("stack", string(debug.Stack())))
				if !tw.hijacked && tw.status == 0 {
					http.Error(tw, "Guard failed on this request", http.StatusInternalServerError)
				}
			}
			finishTrace(kind, r, t, tw, start)
		}()
		next(tw, r)
	}
}

func finishTrace(kind string, r *http.Request, t *requestTrace, tw *tracedWriter, start time.Time) {
	status := tw.status
	if tw.hijacked && status == 0 {
		status = http.StatusSwitchingProtocols
		if r.Method == http.MethodConnect {
			status = http.StatusOK
		}
	}
	t.mu.Lock()
	host, verdict, ruleID, intercepted := t.host, t.verdict, t.ruleID, t.intercepted
	t.mu.Unlock()
	if verdict == "" {
		verdict = "none"
	}
	level, msg, route := slog.LevelDebug, "request", diagnosticRoute(r.URL.Path)
	switch {
	case kind == traceLocal:
		msg, route = "local request", localRoute(r.URL.Path)
	case r.Method == http.MethodConnect:
		msg, route = "connect closed", ""
	case intercepted:
		level = slog.LevelInfo
	}
	ctx := r.Context()
	if !t.log.Enabled(ctx, level) {
		return
	}
	attrs := []slog.Attr{slog.String("host", host), slog.String("method", r.Method)}
	if route != "" {
		attrs = append(attrs, slog.String("route", route))
	}
	if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		attrs = append(attrs, slog.Bool("websocket", true))
	}
	attrs = append(attrs,
		slog.String("proto", r.Proto),
		slog.Bool("intercepted", intercepted),
		slog.String("verdict", verdict),
		slog.String("rule_id", ruleID),
		slog.Int("status", status),
		slog.Int64("bytes", tw.bytes),
		slog.Float64("duration_ms", durationMS(time.Since(start))),
	)
	t.log.LogAttrs(ctx, level, msg, attrs...)
}

func newUUIDv7() string {
	var b [16]byte
	ms := uint64(time.Now().UnixMilli())
	for i := 0; i < 6; i++ {
		b[i] = byte(ms >> (40 - 8*i))
	}
	_, _ = rand.Read(b[6:])
	b[6] = b[6]&0x0f | 0x70
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

type traceKey struct{}

type requestTrace struct {
	id          string
	log         *slog.Logger
	mu          sync.Mutex
	host        string
	verdict     string
	ruleID      string
	intercepted bool
}

var verdictRank = map[string]int{"": 0, "allowed": 1, "observed": 2, "asked": 3, "blocked": 4}

func newTrace(ctx context.Context, idKey string) (context.Context, *requestTrace) {
	t := &requestTrace{id: newUUIDv7()}
	t.log = slog.Default().With(idKey, t.id)
	return context.WithValue(ctx, traceKey{}, t), t
}

func traceFrom(ctx context.Context) *requestTrace {
	if ctx == nil {
		return nil
	}
	t, _ := ctx.Value(traceKey{}).(*requestTrace)
	return t
}

func logFrom(ctx context.Context) *slog.Logger {
	if t := traceFrom(ctx); t != nil {
		return t.log
	}
	return slog.Default()
}

func requestIDFrom(ctx context.Context) string {
	if t := traceFrom(ctx); t != nil {
		return t.id
	}
	return ""
}

func (t *requestTrace) target(host string, intercepted bool) {
	if t == nil {
		return
	}
	t.mu.Lock()
	t.host, t.intercepted = host, intercepted
	t.mu.Unlock()
}

func (t *requestTrace) decided(verdict, ruleID string) {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if verdictRank[verdict] >= verdictRank[t.verdict] {
		t.verdict, t.ruleID = verdict, ruleID
	}
}

func durationMS(d time.Duration) float64 { return float64(d.Microseconds()) / 1000 }

func stepDone(ctx context.Context, step string, d time.Duration, err error, failLevel slog.Level) {
	l := logFrom(ctx)
	if err == nil {
		if l.Enabled(ctx, slog.LevelDebug) {
			l.LogAttrs(ctx, slog.LevelDebug, "step", slog.String("step", step), slog.Float64("duration_ms", durationMS(d)))
		}
		return
	}
	attrs := []slog.Attr{slog.String("step", step), slog.Float64("duration_ms", durationMS(d)), slog.String("error", errText(err))}
	if cause := errors.Unwrap(err); cause != nil {
		attrs = append(attrs, slog.String("cause", errText(cause)))
	}
	var re *registryError
	if errors.As(err, &re) && re.code != "" {
		attrs = append(attrs, slog.String("code", re.code))
	}
	l.LogAttrs(ctx, failLevel, "step failed", attrs...)
}

func timedValue[T any](ctx context.Context, step string, fn func() (T, error)) (T, error) {
	start := time.Now()
	v, err := fn()
	stepDone(ctx, step, time.Since(start), err, slog.LevelWarn)
	return v, err
}

func timed(ctx context.Context, step string, fn func() error) error {
	_, err := timedValue(ctx, step, func() (struct{}, error) { return struct{}{}, fn() })
	return err
}
