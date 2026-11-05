// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package main

import (
	"bufio"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/vibtra/guard/guard/agent-go/engine"
)

type wsMessageReader struct {
	reader  io.Reader
	conn    net.Conn
	active  bool
	timeout time.Duration
}

func (r *wsMessageReader) Read(b []byte) (int, error) {
	if len(b) == 0 {
		return 0, nil
	}
	if !r.active {
		n, err := r.reader.Read(b[:1])
		if n > 0 {
			r.active = true
			_ = r.conn.SetReadDeadline(time.Now().Add(r.timeout))
		}
		return n, err
	}
	return r.reader.Read(b)
}
func (r *wsMessageReader) websocketIdle() { r.active = false; _ = r.conn.SetReadDeadline(time.Time{}) }

type wsClientWriter struct {
	conn    net.Conn
	mu      sync.Mutex
	closing atomic.Bool
	partial bool
}

func (w *wsClientWriter) Write(b []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.conn.Write(b)
}

func (w *wsClientWriter) closeFrame(code uint16, up io.Writer) {
	w.closing.Store(true)
	_ = w.conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
	if closer, ok := up.(io.Closer); ok {
		_ = closer.Close()
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.partial {
		_, _ = w.conn.Write(wsCloseFrame(code))
	}
}

func (w *wsClientWriter) copyServerFrames(up io.Reader) error {
	for {
		head := make([]byte, 2)
		if _, err := io.ReadFull(up, head); err != nil {
			return err
		}
		if head[1]&0x80 != 0 {
			return errors.New("masked server frame")
		}
		size := uint64(head[1] & 127)
		switch size {
		case 126:
			more := make([]byte, 2)
			if _, err := io.ReadFull(up, more); err != nil {
				return err
			}
			head = append(head, more...)
			size = uint64(binary.BigEndian.Uint16(more))
		case 127:
			more := make([]byte, 8)
			if _, err := io.ReadFull(up, more); err != nil {
				return err
			}
			head = append(head, more...)
			size = binary.BigEndian.Uint64(more)
			if size>>63 != 0 {
				return errors.New("invalid server frame size")
			}
		}
		w.mu.Lock()
		if w.closing.Load() {
			w.mu.Unlock()
			return io.EOF
		}
		_, err := w.conn.Write(head)
		if err == nil {
			_, err = io.CopyN(w.conn, up, int64(size))
		}
		if err != nil {
			w.partial = true
		}
		w.mu.Unlock()
		if err != nil {
			return err
		}
	}
}

type wsUpstreamWriter struct {
	io.ReadWriteCloser
	timeout time.Duration
}

func (w wsUpstreamWriter) Write(b []byte) (int, error) {
	timer := time.AfterFunc(w.timeout, func() { _ = w.Close() })
	defer timer.Stop()
	return w.ReadWriteCloser.Write(b)
}
func wsCloseFrame(code uint16) []byte {
	reason := "Vibtra Guard closed this connection"
	if code == 1008 {
		reason = "Vibtra Guard blocked this message"
	}
	b := make([]byte, 4+len(reason))
	b[0] = 0x88
	b[1] = byte(2 + len(reason))
	binary.BigEndian.PutUint16(b[2:4], code)
	copy(b[4:], reason)
	return b
}

func (p *Proxy) websocketCoverage(ctx context.Context, host, cli string, app *EventApp, facts map[string]any, n int) (engine.Decision, error) {
	b, c, _ := p.agent.snapshot()
	v, err := decide(ctx, p.engine, engine.Request{Host: host, CLI: cli, Transport: engine.WebSocket, CoverageFailed: true, Bundle: b, Catalogue: c, Now: time.Now()})
	if err != nil || !v.Intercepted {
		return v, err
	}
	facts["coverageFailure"] = true
	p.agent.record(v, host, "WEBSOCKET", 443, int64(n), facts, app)
	return v, nil
}

func websocketFacts(r *http.Request, extra map[string]any) map[string]any {
	facts := map[string]any{"transport": "websocket-message", "attribution": "user-agent", "requestCategory": "websocket-message", "routeShape": diagnosticRoute(r.URL.Path), "textParts": 0}
	for k, v := range extra {
		facts[k] = v
	}
	return facts
}

func (p *Proxy) upgrade(w http.ResponseWriter, r *http.Request, res *http.Response, header, host, cli string, app *EventApp, intercept bool) {
	up, ok := res.Body.(io.ReadWriteCloser)
	if !ok {
		http.Error(w, "upgrade unavailable", http.StatusBadGateway)
		return
	}
	var inspector *webSocketInspector
	if intercept {
		var err error
		inspector, err = newWebSocketInspector(strings.Join(res.Header.Values("Sec-WebSocket-Extensions"), ","))
		if err != nil {
			facts := websocketFacts(r, map[string]any{"state": "flow-only", "reason": "unsupported-websocket-extension"})
			_, _ = p.websocketCoverage(r.Context(), host, cli, app, facts, 0)
			http.Error(w, "Guard cannot inspect the negotiated WebSocket extension", http.StatusBadGateway)
			return
		}
	}
	client, br, err := w.(http.Hijacker).Hijack()
	if err != nil {
		return
	}
	defer func() { _ = client.Close() }()
	defer func() { _ = up.Close() }()
	_, _ = fmt.Fprint(br, "HTTP/1.1 101 Switching Protocols\r\n")
	if header != "" {
		res.Header.Set("x-vibtra-guard", header)
	}
	_ = res.Header.Write(br)
	_, _ = br.WriteString("\r\n")
	if br.Flush() != nil {
		return
	}
	if !intercept {
		websocketBlind(client, br, up)
		return
	}
	writer := &wsClientWriter{conn: client}
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer func() { _ = up.Close() }()
		defer func() { _ = client.Close() }()
		p.gateWebSocket(client, br, wsUpstreamWriter{up, 15 * time.Second}, writer, inspector, r, host, cli, app)
	}()
	_ = writer.copyServerFrames(up)
	if !writer.closing.Load() {
		_ = client.Close()
		_ = up.Close()
	}
	<-done
}
func websocketBlind(client net.Conn, br *bufio.ReadWriter, up io.ReadWriteCloser) {
	done := make(chan struct{})
	go func() { _, _ = io.Copy(up, br); _ = up.Close(); close(done) }()
	_, _ = io.Copy(client, up)
	_ = client.Close()
	<-done
}

func (p *Proxy) gateWebSocket(client net.Conn, br *bufio.ReadWriter, up io.Writer, writer *wsClientWriter, inspector *webSocketInspector, r *http.Request, host, cli string, app *EventApp) {
	timeout := p.bodyReadTimeout
	if timeout == 0 {
		timeout = 15 * time.Second
	}
	reader := &wsMessageReader{reader: br.Reader, conn: client, timeout: timeout}
	defer reader.websocketIdle()
	for {
		msg, err := inspector.readMessage(reader, func(wire []byte) error { _, e := up.Write(wire); return e })
		reader.websocketIdle()
		if err != nil {
			if errors.Is(err, io.EOF) {
				return
			}
			code := uint16(1002)
			reason := "invalid-websocket-message"
			meta := map[string]any{}
			var we *webSocketError
			if errors.As(err, &we) {
				code = we.Code
				reason = we.Reason
				meta = we.Metadata
			}
			var ne net.Error
			if errors.As(err, &ne) && ne.Timeout() {
				reason = "websocket-message-timeout"
			}
			facts := websocketFacts(r, meta)
			facts["state"] = "flow-only"
			facts["reason"] = reason
			facts["transportClosed"] = true
			_, _ = p.websocketCoverage(r.Context(), host, cli, app, facts, 0)
			writer.closeFrame(code, up)
			return
		}
		ex, metadata, extractErr := msg.extract()
		facts := websocketFacts(r, metadata)
		if extractErr != nil {
			v, err := p.websocketCoverage(r.Context(), host, cli, app, facts, len(msg.Payload))
			if err != nil {
				writer.closeFrame(1011, up)
				return
			}
			if v.Enforced && (v.Verdict == "blocked" || v.Verdict == "asked") {
				writer.closeFrame(1003, up)
				return
			}
		} else {
			b, c, _ := p.agent.snapshot()
			v, err := decide(r.Context(), p.engine, engine.Request{Host: host, CLI: cli, Transport: engine.WebSocket, Content: ex, Bundle: b, Catalogue: c, Now: time.Now()})
			if err != nil {
				writer.closeFrame(1011, up)
				return
			}
			p.agent.record(v, host, "WEBSOCKET", 443, int64(len(msg.Payload)), facts, app)
			if v.Enforced && (v.Verdict == "blocked" || v.Verdict == "asked") {
				writer.closeFrame(1008, up)
				return
			}
		}
		if _, err = up.Write(msg.Wire); err != nil {
			return
		}
	}
}
