// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	utls "github.com/refraction-networking/utls"
	"golang.org/x/net/http/httpguts"
	"golang.org/x/net/http2"

	"github.com/vibtra/guard/guard/agent-go/engine"
	"github.com/vibtra/guard/guard/agent-go/policy"
)

func (a *Agent) recordUpstreamClientHello(raw []byte) {
	sum := sha256.Sum256(raw)
	a.transportStatsMu.Lock()
	a.upstreamHelloHash = fmt.Sprintf("%x", sum[:])
	a.transportStatsMu.Unlock()
}

func (a *Agent) recordUninspected() {
	a.transportStatsMu.Lock()
	a.uninspectedCount++
	a.transportStatsMu.Unlock()
}

func (a *Agent) recordTunnel() {
	a.transportStatsMu.Lock()
	a.tunnelledCount++
	a.transportStatsMu.Unlock()
}

func (a *Agent) upstreamTransportStats() map[string]any {
	a.transportStatsMu.RLock()
	defer a.transportStatsMu.RUnlock()
	return map[string]any{
		"mode":                   "client-hello-replay",
		"lastClientHelloSHA256":  a.upstreamHelloHash,
		"uninspectedConnections": a.uninspectedCount,
		"tunnelledConnections":   a.tunnelledCount,
	}
}

func replayDial(ctx context.Context, addr, serverName string, roots *x509.CertPool, _ utls.ClientHelloSpec, observed ...func([]byte)) (net.Conn, error) {
	wire, ok := ctx.Value(clientHelloWireKey{}).([]byte)
	if !ok || len(wire) == 0 {
		return nil, &upstreamReplayError{err: errors.New("upstream TLS requires the client's captured ClientHello bytes")}
	}
	spec, _, _, err := captureClientHello(&capturedHelloReader{Reader: bytes.NewReader(wire)})
	if err != nil {
		return nil, &upstreamReplayError{err: err}
	}
	raw, e := (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext(ctx, "tcp", addr)
	if e != nil {
		return nil, e
	}
	fail := func(e error) (net.Conn, error) { _ = raw.Close(); return nil, e }
	conn := utls.UClient(raw, &utls.Config{ServerName: serverName, RootCAs: roots, MinVersion: utls.VersionTLS12}, utls.HelloCustom)
	if e = conn.ApplyPreset(&spec); e != nil {
		return fail(&upstreamReplayError{err: e})
	}
	if e = conn.BuildHandshakeState(); e != nil {
		return fail(&upstreamReplayError{err: e})
	}
	deadline, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if e = conn.HandshakeContext(deadline); e != nil {
		if replayParameterRejection(e) {
			return fail(&upstreamReplayError{err: e})
		}
		return fail(e)
	}
	if len(observed) > 0 && observed[0] != nil {
		observed[0](append([]byte(nil), conn.HandshakeState.Hello.Raw...))
	}
	return conn, nil
}

type tlsNameKey struct{}
type clientHelloSpecKey struct{}
type clientHelloWireKey struct{}

type capturedHelloReader struct {
	net.Conn
	*bytes.Reader
}

func (c *capturedHelloReader) Read(p []byte) (int, error) { return c.Reader.Read(p) }

type clientTransportsKey struct{}
type rawHeadersKey struct{}
type rawHeader struct {
	name, value string
}
type rawRequestHeaders struct {
	method, requestURI string
	fields             []rawHeader
}
type requestHeaderTracker struct {
	mu            sync.Mutex
	buffer        []byte
	remainingBody int64
	chunkedBody   bool
	requests      []rawRequestHeaders
	disabled      bool
	halted        bool
}

func (t *requestHeaderTracker) feed(in []byte) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.disabled || t.halted {
		return
	}
	if len(t.buffer)+len(in) > 1<<20 {
		t.disable()
		return
	}
	t.buffer = append(t.buffer, in...)
	for {
		if t.remainingBody > 0 {
			n := min(int64(len(t.buffer)), t.remainingBody)
			t.buffer = t.buffer[n:]
			t.remainingBody -= n
			if t.remainingBody > 0 {
				return
			}
		}
		if t.chunkedBody {
			used, done := skipChunkedRequestBody(t.buffer)
			if used == -2 {
				t.disable()
				return
			}
			if used < 0 {
				return
			}
			t.buffer = t.buffer[used:]
			if !done {
				return
			}
			t.chunkedBody = false
		}
		end := bytes.Index(t.buffer, []byte("\r\n\r\n"))
		if end < 0 {
			return
		}
		block := t.buffer[:end]
		t.buffer = t.buffer[end+4:]
		lines := bytes.Split(block, []byte("\r\n"))
		if len(lines) == 0 {
			continue
		}
		start := strings.Fields(string(lines[0]))
		if len(start) != 3 || bytes.ContainsAny(lines[0], "\r\n") {
			t.disable()
			return
		}
		req := rawRequestHeaders{method: start[0], requestURI: start[1]}
		var contentLength int64
		upgrade := false
		for _, line := range lines[1:] {
			colon := bytes.IndexByte(line, ':')
			if colon <= 0 {
				t.disable()
				return
			}
			name := string(line[:colon])
			value := strings.Trim(string(line[colon+1:]), " \t")
			if !safeRawHeader(name, value) {
				t.disable()
				return
			}
			if strings.EqualFold(name, "Upgrade") {
				upgrade = true
			}
			req.fields = append(req.fields, rawHeader{name: name, value: value})
			if strings.EqualFold(name, "Content-Length") {
				contentLength, _ = strconv.ParseInt(value, 10, 64)
			}
			if strings.EqualFold(name, "Transfer-Encoding") && strings.EqualFold(value, "chunked") {
				t.chunkedBody = true
			}
		}
		if len(t.requests) >= 128 {
			t.disable()
			return
		}
		t.requests = append(t.requests, req)
		if upgrade {
			t.halted = true
			t.buffer = nil
			return
		}
		if !t.chunkedBody && contentLength > 0 {
			t.remainingBody = contentLength
		}
	}
}

func (t *requestHeaderTracker) disable() {
	t.disabled = true
	t.buffer = nil
	t.requests = nil
}

func safeRawHeader(name, value string) bool {
	if name == "" {
		return false
	}
	for _, c := range []byte(name) {
		if (c < 'a' || c > 'z') && (c < 'A' || c > 'Z') && (c < '0' || c > '9') && !strings.ContainsRune("!#$%&'*+-.^_`|~", rune(c)) {
			return false
		}
	}
	for _, c := range []byte(value) {
		if c == 127 || c < 32 && c != '\t' {
			return false
		}
	}
	return true
}

func skipChunkedRequestBody(b []byte) (consumed int, done bool) {
	at := 0
	for {
		lf := bytes.IndexByte(b[at:], '\n')
		if lf < 0 {
			return -1, false
		}
		lf += at
		if lf == at || b[lf-1] != '\r' || bytes.ContainsAny(b[at:lf-1], "\r\n") {
			return -2, false
		}
		sizeText := strings.SplitN(string(b[at:lf-1]), ";", 2)[0]
		size, err := strconv.ParseUint(sizeText, 16, 63)
		if err != nil {
			return -2, false
		}
		at = lf + 1
		if size == 0 {
			if len(b) == at || len(b) == at+1 && b[at] == '\r' {
				return -1, false
			}
			if len(b) >= at+2 && bytes.Equal(b[at:at+2], []byte("\r\n")) {
				return at + 2, true
			}
			return -2, false
		}
		if len(b)-at < 2 || size > uint64(len(b)-at-2) {
			return -1, false
		}
		at += int(size)
		if !bytes.Equal(b[at:at+2], []byte("\r\n")) {
			return -2, false
		}
		at += 2
	}
}

func rawHeadersMatchRequest(fields []rawHeader, r *http.Request) bool {
	captured := make(http.Header)
	hostCount, transferCount := 0, 0
	for _, h := range fields {
		if !safeRawHeader(h.name, h.value) {
			return false
		}
		switch strings.ToLower(h.name) {
		case "host":
			hostCount++
			if hostCount > 1 || h.value != r.Host {
				return false
			}
		case "transfer-encoding":
			transferCount++
			if transferCount > 1 || len(r.TransferEncoding) != 1 || !strings.EqualFold(h.value, r.TransferEncoding[0]) {
				return false
			}
		case "trailer":
			return false
		default:
			captured.Add(h.name, h.value)
		}
	}
	if hostCount == 0 && r.Host != "" || transferCount == 0 && len(r.TransferEncoding) != 0 {
		return false
	}
	if len(captured) != len(r.Header) {
		return false
	}
	for name, values := range r.Header {
		got := captured.Values(name)
		if len(got) != len(values) {
			return false
		}
		for i, value := range values {
			if got[i] != value {
				return false
			}
		}
	}
	return true
}

func (t *requestHeaderTracker) take(method, requestURI string) ([]rawHeader, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.disabled || len(t.requests) == 0 {
		return nil, false
	}
	req := t.requests[0]
	if req.method != method || req.requestURI != requestURI {
		t.disable()
		return nil, false
	}
	t.requests[0] = rawRequestHeaders{}
	t.requests = t.requests[1:]
	return req.fields, true
}

type upstreamTransportSet struct {
	h1, mappedH1 *http.Transport
	h2, mappedH2 *negotiatingTransport
	wireH1       *rawHTTP1Transport
}

func (s *upstreamTransportSet) closeIdleConnections() {
	s.h1.CloseIdleConnections()
	if s.mappedH1 != s.h1 {
		s.mappedH1.CloseIdleConnections()
	}
	s.h2.CloseIdleConnections()
	if s.mappedH2 != s.h2 {
		s.mappedH2.CloseIdleConnections()
	}
	s.wireH1.closeIdleConnections()
}

type Proxy struct {
	agent                      *Agent
	engine                     engine.Engine
	maps                       map[string]*url.URL
	transport, mappedTransport *http.Transport
	h2Transport                *negotiatingTransport
	mappedH2Transport          *negotiatingTransport
	mappedRoots                *x509.CertPool
	newHTTP1                   func(*x509.CertPool, bool) *http.Transport
	newHTTP2                   func(*x509.CertPool) *negotiatingTransport
	bodyReadTimeout            time.Duration
}

func newProxy(eng engine.Engine, a *Agent, maps map[string]*url.URL, caFile string) (*Proxy, error) {
	makeTransport := func(roots *x509.CertPool, scoped bool) *http.Transport {
		return &http.Transport{Proxy: nil, DisableCompression: true, ForceAttemptHTTP2: false, MaxIdleConns: 100, MaxIdleConnsPerHost: 6, IdleConnTimeout: 90 * time.Second, ResponseHeaderTimeout: 60 * time.Second, DialContext: (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext, DialTLSContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			name, _, e := net.SplitHostPort(addr)
			if e != nil {
				return nil, e
			}
			if explicit, ok := ctx.Value(tlsNameKey{}).(string); ok {
				name = explicit
			}
			spec, ok := ctx.Value(clientHelloSpecKey{}).(utls.ClientHelloSpec)
			if !ok {
				return nil, errors.New("upstream TLS requires the client's captured ClientHello")
			}
			return replayDial(ctx, addr, name, roots, spec, a.recordUpstreamClientHello)
		}}
	}
	makeH2Transport := func(roots *x509.CertPool) *negotiatingTransport {
		return &negotiatingTransport{dial: func(ctx context.Context, network, addr string) (net.Conn, error) {
			name, _, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}
			if explicit, ok := ctx.Value(tlsNameKey{}).(string); ok {
				name = explicit
			}
			spec, ok := ctx.Value(clientHelloSpecKey{}).(utls.ClientHelloSpec)
			if !ok {
				return nil, errors.New("upstream TLS requires the client's captured ClientHello")
			}
			return replayDial(ctx, addr, name, roots, spec, a.recordUpstreamClientHello)
		}}
	}
	p := &Proxy{agent: a, engine: eng, maps: maps, newHTTP1: makeTransport, newHTTP2: makeH2Transport, transport: makeTransport(nil, false), h2Transport: makeH2Transport(nil)}
	p.mappedTransport = p.transport
	p.mappedH2Transport = p.h2Transport
	if caFile != "" {
		if len(maps) == 0 {
			return nil, errors.New("--upstream-ca requires an explicit --upstream-map")
		}
		roots, e := x509.SystemCertPool()
		if e != nil {
			return nil, e
		}
		b, e := os.ReadFile(caFile)
		if e != nil || !roots.AppendCertsFromPEM(b) {
			return nil, errors.New("invalid mapped upstream CA")
		}
		p.mappedRoots = roots
		p.mappedTransport = makeTransport(roots, false)
		p.mappedH2Transport = makeH2Transport(roots)
	}
	return p, nil
}

func (p *Proxy) newClientTransportSet() *upstreamTransportSet {
	set := &upstreamTransportSet{h1: p.newHTTP1(nil, true), h2: p.newHTTP2(nil), wireH1: newRawHTTP1Transport()}
	if p.mappedRoots == nil {
		set.mappedH1, set.mappedH2 = set.h1, set.h2
	} else {
		set.mappedH1, set.mappedH2 = p.newHTTP1(p.mappedRoots, true), p.newHTTP2(p.mappedRoots)
	}
	return set
}
func stripHop(h http.Header, upgrade bool, upstreamH2 ...bool) {
	keepTE := len(upstreamH2) > 0 && upstreamH2[0] && len(h.Values("Te")) == 1 && strings.EqualFold(strings.TrimSpace(h.Get("Te")), "trailers")
	for _, name := range strings.Split(h.Get("Connection"), ",") {
		name = strings.TrimSpace(name)
		if name != "" && (!upgrade || !strings.EqualFold(name, "upgrade")) {
			h.Del(name)
		}
	}
	for _, name := range []string{"Proxy-Authorization", "Proxy-Authenticate", "Proxy-Connection", "Keep-Alive", "TE", "Trailer", "Transfer-Encoding"} {
		h.Del(name)
	}
	if keepTE {
		h.Set("Te", "trailers")
	}
	if !upgrade {
		h.Del("Upgrade")
		h.Del("Connection")
	}
}
func copyHeaders(dst, src http.Header) {
	for k, values := range src {
		for _, v := range values {
			dst.Add(k, v)
		}
	}
}
func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == "CONNECT" {
		p.connect(w, r)
		return
	}
	if r.URL.Hostname() == "guard.vibtra.local" || r.Host == "guard.vibtra.local" {
		p.agent.local(w, r)
		return
	}
	p.forward(w, r, "")
}
func (p *Proxy) forward(w http.ResponseWriter, r *http.Request, authority string) {
	var wireHeaders []rawHeader
	hasWireHeaders := false
	if r.ProtoMajor == 1 {
		if tracker, ok := r.Context().Value(rawHeadersKey{}).(*requestHeaderTracker); ok {
			wireHeaders, hasWireHeaders = tracker.take(r.Method, r.RequestURI)
			hasWireHeaders = hasWireHeaders && rawHeadersMatchRequest(wireHeaders, r)
		}
	}
	origin := *r.URL
	if authority != "" {
		origin.Scheme = "https"
		origin.Host = authority
		if r.Host != "" && !sameAuthority(r.Host, authority) {
			http.Error(w, "authority differs from CONNECT target", 421)
			return
		}
	} else if origin.Scheme != "http" && origin.Scheme != "https" {
		http.Error(w, "absolute HTTP URL required", 400)
		return
	}
	if origin.User != nil || origin.Hostname() == "" {
		http.Error(w, "invalid origin", 400)
		return
	}
	host := strings.ToLower(strings.TrimSuffix(origin.Hostname(), "."))
	b, c, d := p.agent.snapshot()
	cli, app := appFromUserAgent(c, r.Header.Get("User-Agent"))
	attribution, ok := r.Context().Value(relayAttributionKey{}).(processAttribution)
	if !ok {
		attribution = unattributed("not-provided")
	}
	app = attributedEventApp(app, attribution)
	surface := matchSurface(b, host, r, attribution)
	intercept := b != nil && d != nil && !d.Revoked && c != nil && c.Service(host, "", "") != nil && (c.Service(host, "", cli) != nil || surface != nil)
	if intercept {
		p.agent.captureRoute(host, r, attribution, surface)
	}
	if intercept && surface != nil && b.ClientMode == "enforce" {
		v, e := decide(r.Context(), p.engine, engine.Request{Host: host, Transport: engine.HTTP, Surface: surface.engineSurface(), Bundle: b, Catalogue: c, Now: time.Now()})
		if e != nil {
			http.Error(w, "Guard could not decide this request", http.StatusServiceUnavailable)
			return
		}
		if v.Enforced && (v.Verdict == "blocked" || v.Verdict == "asked") {
			inspection := map[string]any{"state": "flow-only", "reason": "surface-block", "surface": surface.Surface, "coverageEntry": surface.ID}
			port := 443
			if origin.Scheme == "http" {
				port = 80
			}
			if origin.Port() != "" {
				_, _ = fmt.Sscanf(origin.Port(), "%d", &port)
			}
			inspection["blockDelivery"] = blockDelivery(r)
			header, block := p.agent.record(v, host, r.Method, port, max(0, r.ContentLength), inspection, app, b)
			w.Header().Set("x-vibtra-guard", header)
			if block == nil {
				http.Error(w, "policy unavailable; retry after Guard sync", http.StatusServiceUnavailable)
				return
			}
			p.agent.blockResponse(w, r, *block)
			return
		}
	}
	ex := Extracted{}
	inspection := map[string]any{"state": "flow-only", "reason": "no-request-body", "textParts": 0}
	n := r.ContentLength
	if intercept && r.Body != nil && r.Body != http.NoBody {
		switch {
		case !inspectable(r.Header.Get("Content-Type")) && !connectMediaType(r.Header.Get("Content-Type")):
			inspection["reason"] = "unsupported-content-type"
		case r.ContentLength > inspectionLimit:
			inspection["reason"] = "body-too-large"
			if encodedHTTP(r.Header) && inspectable(r.Header.Get("Content-Type")) || connectMediaType(r.Header.Get("Content-Type")) {
				inspection["coverageFailure"] = true
			}
		default:
			original := r.Body
			rc := http.NewResponseController(w)
			if connectMediaType(r.Header.Get("Content-Type")) || encodedHTTP(r.Header) {
				timeout := p.bodyReadTimeout
				if timeout == 0 {
					timeout = 15 * time.Second
				}
				_ = rc.SetReadDeadline(time.Now().Add(timeout))
			}
			body, e := io.ReadAll(io.LimitReader(original, inspectionLimit+1))
			if e == nil && (connectMediaType(r.Header.Get("Content-Type")) || encodedHTTP(r.Header)) {
				_ = rc.SetReadDeadline(time.Time{})
			}
			if e != nil {
				_ = original.Close()
				var ne net.Error
				if errors.As(e, &ne) && ne.Timeout() {
					http.Error(w, "request body read timed out", http.StatusRequestTimeout)
					return
				}
				http.Error(w, "request body could not be read", 400)
				return
			}
			r.Body = &replayBody{Reader: io.MultiReader(bytes.NewReader(body), original), closer: original}
			if len(body) > inspectionLimit {
				inspection["reason"] = "body-too-large"
				if encodedHTTP(r.Header) && inspectable(r.Header.Get("Content-Type")) || connectMediaType(r.Header.Get("Content-Type")) {
					inspection["coverageFailure"] = true
				}
			} else {
				_ = original.Close()
				buffered := append([]byte(nil), body...)
				r.GetBody = func() (io.ReadCloser, error) {
					if len(buffered) == 0 {
						return http.NoBody, nil
					}
					return io.NopCloser(bytes.NewReader(buffered)), nil
				}
				r.Body, _ = r.GetBody()
				if len(buffered) == 0 {
					r.ContentLength = 0
					if len(r.Trailer) == 0 {
						r.TransferEncoding = nil
					}
				}
				n = int64(len(body))
				ex, inspection = inspectRequestBody(r.Header.Get("Content-Type"), r.Header, body)
			}
		}
	}
	inspection["requestCategory"] = requestCategory(host, r.Method, origin.Path)
	inspection["routeShape"] = diagnosticRoute(origin.Path)
	inspection["mediaType"] = diagnosticMediaType(r.Header.Get("Content-Type"))
	if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		inspection["transport"] = "websocket-handshake"
	}
	inspection["attribution"] = "user-agent"
	header := ""
	var pendingVerdict *engine.Decision
	pendingPort := 0
	if intercept {
		selectedCLI := cli
		if surface != nil {
			selectedCLI = ""
		}
		v, e := decide(r.Context(), p.engine, engine.Request{Host: host, CLI: selectedCLI, Transport: engine.HTTP, Content: ex, CoverageFailed: inspection["coverageFailure"] == true, Surface: surface.engineSurface(), Bundle: b, Catalogue: c, Now: time.Now()})
		if e != nil {
			http.Error(w, "Guard could not decide this request", http.StatusServiceUnavailable)
			return
		}
		if surface != nil {
			inspection["surface"] = surface.Surface
			inspection["coverageEntry"] = surface.ID
		}
		port := 443
		if origin.Scheme == "http" {
			port = 80
		}
		if origin.Port() != "" {
			_, _ = fmt.Sscanf(origin.Port(), "%d", &port)
		}
		var block *Block
		inspection["blockDelivery"] = blockDelivery(r)
		if v.Enforced && (v.Verdict == "blocked" || v.Verdict == "asked") {
			header, block = p.agent.record(v, host, r.Method, port, max(0, n), inspection, app, b)
			w.Header().Set("x-vibtra-guard", header)
			if block == nil {
				http.Error(w, "policy unavailable; retry after Guard sync", http.StatusServiceUnavailable)
				return
			}
			p.agent.blockResponse(w, r, *block)
			return
		}
		pendingVerdict, pendingPort = &v, port
	}
	if r.ContentLength == 0 && len(r.TransferEncoding) == 0 && len(r.Trailer) == 0 {
		if r.Body != nil {
			_ = r.Body.Close()
		}
		r.Body = http.NoBody
	}
	out := r.Clone(r.Context())
	out.URL = &origin
	out.RequestURI = ""
	out.Close = false
	out.Host = origin.Host
	out.Header = r.Header.Clone()
	out.Body = r.Body
	prepareForwardTrailers(out, r)
	upgrade := strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
	stripHop(out.Header, upgrade, r.ProtoMajor == 2)
	transport := http.RoundTripper(p.transport)
	if session, ok := r.Context().Value(clientTransportsKey{}).(*upstreamTransportSet); ok {
		transport = session.h1
	}
	if mapped := p.maps[host]; mapped != nil && intercept {
		out.URL.Scheme = mapped.Scheme
		out.URL.Host = mapped.Host
		out = out.WithContext(context.WithValue(out.Context(), tlsNameKey{}, host))
		transport = p.mappedTransport
		if session, ok := r.Context().Value(clientTransportsKey{}).(*upstreamTransportSet); ok {
			transport = session.mappedH1
		}
	}
	if r.ProtoMajor == 2 {
		transport = p.h2Transport
		if session, ok := r.Context().Value(clientTransportsKey{}).(*upstreamTransportSet); ok {
			transport = session.h2
		}
		if mapped := p.maps[host]; mapped != nil && intercept {
			transport = p.mappedH2Transport
			if session, ok := r.Context().Value(clientTransportsKey{}).(*upstreamTransportSet); ok {
				transport = session.mappedH2
			}
		}
	}
	var res *http.Response
	var e error
	if r.ProtoMajor == 1 {
		if session, ok := r.Context().Value(clientTransportsKey{}).(*upstreamTransportSet); ok {
			if hasWireHeaders {
				spec, hasSpec := r.Context().Value(clientHelloSpecKey{}).(utls.ClientHelloSpec)
				if hasSpec {
					roots := (*x509.CertPool)(nil)
					if p.maps[host] != nil && intercept {
						roots = p.mappedRoots
					}
					res, e = session.wireH1.roundTrip(out, wireHeaders, roots, spec, p.agent.recordUpstreamClientHello)
				} else {
					res, e = transport.RoundTrip(out)
				}
			} else {
				res, e = transport.RoundTrip(out)
			}
		} else {
			res, e = transport.RoundTrip(out)
		}
	} else {
		res, e = transport.RoundTrip(out)
	}
	if e != nil {
		var replayErr *upstreamReplayError
		if intercept && errors.As(e, &replayErr) {
			p.agent.recordTLSCoverage(net.JoinHostPort(host, strconv.Itoa(pendingPort)), "upstream-replay-failed", "blocked", attribution, app)
		} else if pendingVerdict != nil {
			p.agent.record(*pendingVerdict, host, r.Method, pendingPort, max(0, n), inspection, app, b)
		}
		http.Error(w, "upstream connection failed", http.StatusBadGateway)
		return
	}
	defer func() { _ = res.Body.Close() }()
	if pendingVerdict != nil {
		header, _ = p.agent.record(*pendingVerdict, host, r.Method, pendingPort, max(0, n), inspection, app, b)
	}
	if res.StatusCode == 101 && upgrade {
		p.upgrade(w, r, res, header, host, cli, app, intercept)
		return
	}
	stripHop(res.Header, false)
	copyHeaders(w.Header(), res.Header)
	if header != "" {
		w.Header().Set("x-vibtra-guard", header)
	}
	for name := range res.Trailer {
		if httpguts.ValidHeaderFieldName(name) && httpguts.ValidTrailerHeader(name) {
			w.Header().Add("Trailer", name)
		}
	}
	w.WriteHeader(res.StatusCode)
	flusher, _ := w.(http.Flusher)
	buf := make([]byte, 32*1024)
	for {
		n, e := res.Body.Read(buf)
		if n > 0 {
			if _, we := w.Write(buf[:n]); we != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if e != nil {
			if e == io.EOF {
				for name, values := range res.Trailer {
					if httpguts.ValidHeaderFieldName(name) && httpguts.ValidTrailerHeader(name) {
						w.Header()[http.TrailerPrefix+name] = append([]string(nil), values...)
					}
				}
			}
			return
		}
	}
}

type replayBody struct {
	io.Reader
	closer io.Closer
}

func (b *replayBody) Close() error { return b.closer.Close() }
func sameAuthority(a, b string) bool {
	normal := func(s string) string {
		if _, _, e := net.SplitHostPort(s); e != nil {
			return strings.ToLower(net.JoinHostPort(s, "443"))
		}
		return strings.ToLower(s)
	}
	return normal(a) == normal(b)
}
func (p *Proxy) connect(w http.ResponseWriter, r *http.Request) {
	authority := r.Host
	if !strings.Contains(authority, ":") {
		authority = net.JoinHostPort(authority, "443")
	}
	host, port, e := net.SplitHostPort(authority)
	if e != nil || host == "" || port == "" {
		http.Error(w, "invalid CONNECT authority", 400)
		return
	}
	h, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "CONNECT unavailable", 500)
		return
	}
	if !p.agent.shouldIntercept(host) {
		up, e := net.DialTimeout("tcp", authority, 10*time.Second)
		if e != nil {
			http.Error(w, "upstream unavailable", http.StatusBadGateway)
			return
		}
		client, br, e := h.Hijack()
		if e != nil {
			_ = up.Close()
			return
		}
		defer func() { _ = client.Close() }()
		defer func() { _ = up.Close() }()
		_, _ = br.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n")
		if br.Flush() != nil {
			return
		}
		splice(&bufferedConn{Conn: client, reader: br.Reader}, up)
		return
	}
	cert, e := p.agent.ca.leaf(host)
	if e != nil {
		http.Error(w, refusalLine(e), http.StatusBadGateway)
		return
	}
	client, br, e := h.Hijack()
	if e != nil {
		return
	}
	defer func() { _ = client.Close() }()
	_, _ = br.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n")
	if br.Flush() != nil {
		return
	}
	raw := &bufferedConn{Conn: client, reader: br.Reader}
	p.serveTLS(raw, authority, cert)
}

func captureClientHello(raw net.Conn) (utls.ClientHelloSpec, []byte, []string, error) {
	var spec utls.ClientHelloSpec
	var wire, handshake []byte
	var recordVersion [2]byte
	want := -1
	for records := 0; len(wire) < maxClientHelloSize*6; records++ {
		var header [5]byte
		nread, err := io.ReadFull(raw, header[:])
		if err != nil {
			wire = append(wire, header[:nread]...)
			return spec, wire, nil, err
		}
		n := int(header[3])<<8 | int(header[4])
		if header[0] != 22 || n == 0 || n > maxTLSPlaintextRecordSize {
			wire = append(wire, header[:]...)
			return spec, wire, nil, errors.New("unparseable ClientHello record")
		}
		body := make([]byte, n)
		nread, err = io.ReadFull(raw, body)
		if err != nil {
			wire = append(wire, header[:]...)
			wire = append(wire, body[:nread]...)
			return spec, wire, nil, err
		}
		wire = append(wire, header[:]...)
		wire = append(wire, body...)
		if records == 0 {
			recordVersion = [2]byte{header[1], header[2]}
		}
		handshake = append(handshake, body...)
		if len(handshake) >= 4 && want < 0 {
			if handshake[0] != 1 {
				return spec, wire, nil, errors.New("first TLS handshake message is not ClientHello")
			}
			want = 4 + (int(handshake[1]) << 16) + (int(handshake[2]) << 8) + int(handshake[3])
			if want > 65535 {
				return spec, wire, nil, errors.New("ClientHello exceeds uTLS replay limit")
			}
		}
		if want >= 0 && len(handshake) >= want {
			fp := make([]byte, 5+want)
			fp[0], fp[1], fp[2] = 22, recordVersion[0], recordVersion[1]
			fp[3], fp[4] = byte(want>>8), byte(want)
			copy(fp[5:], handshake[:want])
			parsed, err := (&utls.Fingerprinter{AllowBluntMimicry: true}).FingerprintClientHello(fp)
			if err != nil || parsed == nil {
				if err == nil {
					err = errors.New("uTLS returned an empty ClientHello spec")
				}
				return spec, wire, nil, err
			}
			kept := parsed.Extensions[:0]
			for _, ext := range parsed.Extensions {
				switch x := ext.(type) {
				case utls.PreSharedKeyExtension, *utls.CookieExtension:
					continue
				case *utls.GenericExtension:
					if x.Id == 22 || x.Id == 41 || x.Id == 42 || x.Id == 44 {
						continue
					}
				}
				kept = append(kept, ext)
			}
			parsed.Extensions = kept
			var alpn []string
			for _, ext := range parsed.Extensions {
				if x, ok := ext.(*utls.ALPNExtension); ok {
					alpn = append([]string(nil), x.AlpnProtocols...)
					break
				}
			}
			return *parsed, wire, alpn, nil
		}
	}
	return spec, wire, nil, errors.New("ClientHello exceeds capture byte budget")
}

type replayConn struct {
	net.Conn
	reader *bufio.Reader
}

func (c *replayConn) Read(b []byte) (int, error) { return c.reader.Read(b) }

func (p *Proxy) tunnelUninspected(raw net.Conn, authority string, replay []byte, identity processAttribution, reason error, coverageReason ...string) {
	b, _, _ := p.agent.snapshot()
	host, _, authorityErr := net.SplitHostPort(authority)
	validDestination := authorityErr == nil && strings.TrimSpace(host) != ""
	allowTunnel := validDestination && b != nil && b.ClientMode == "monitor" && b.Settings.UnreproducibleTLS == "tunnel"
	p.agent.recordUninspected()
	action := "blocked"
	if allowTunnel {
		action = "allowed"
	}
	eventReason := "tls-client-hello-unreproducible"
	if len(coverageReason) > 0 {
		eventReason = coverageReason[0]
	}
	eventAuthority := authority
	if !validDestination {
		eventAuthority = "unknown:443"
	}
	p.agent.recordTLSCoverage(eventAuthority, eventReason, action, identity)
	if !allowTunnel {
		_ = raw.SetWriteDeadline(time.Now().Add(time.Second))
		_, _ = raw.Write([]byte{21, 3, 3, 0, 2, 2, 40})
		_ = raw.Close()
		return
	}
	p.agent.recordTunnel()
	upstreamAuthority := authority
	if host, _, err := net.SplitHostPort(authority); err == nil {
		if mapped := p.maps[strings.ToLower(strings.TrimSuffix(host, "."))]; mapped != nil {
			upstreamAuthority = mapped.Host
		}
	}
	upstream, err := (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).Dial("tcp", upstreamAuthority)
	if err != nil {
		_ = raw.Close()
		return
	}
	defer func() { _ = upstream.Close() }()
	defer func() { _ = raw.Close() }()
	_ = raw.SetDeadline(time.Time{})
	client := &replayConn{Conn: raw, reader: bufio.NewReader(io.MultiReader(bytes.NewReader(replay), raw))}
	splice(client, upstream)
}

func (p *Proxy) serveTLS(raw net.Conn, authority string, cert *tls.Certificate, attribution ...processAttribution) {
	identity := unattributed("not-provided")
	if len(attribution) > 0 {
		identity = attribution[0]
	}
	_ = raw.SetDeadline(time.Now().Add(15 * time.Second))
	spec, captured, alpn, captureErr := captureClientHello(raw)
	if captureErr != nil && incompleteHello(captured, captureErr) {
		_ = raw.Close()
		return
	}
	if captureErr == nil {
		captureErr = validateReplayHello(captured, authority)
	}
	if captureErr != nil {
		p.tunnelUninspected(raw, authority, captured, identity, captureErr)
		return
	}
	proto := []string{}
	for _, offered := range alpn {
		if offered == "h2" {
			proto = []string{"h2", "http/1.1"}
			break
		}
		if offered == "http/1.1" {
			proto = []string{"http/1.1"}
		}
	}
	client := &replayConn{Conn: raw, reader: bufio.NewReader(io.MultiReader(bytes.NewReader(captured), raw))}
	sessionTransports := p.newClientTransportSet()
	defer sessionTransports.closeIdleConnections()
	var offeredALPN []string
	var offeredTLS []uint16
	var ecdsaP256 bool
	conn := tls.Server(client, &tls.Config{Certificates: []tls.Certificate{*cert}, MinVersion: tls.VersionTLS12, NextProtos: proto, GetConfigForClient: func(hello *tls.ClientHelloInfo) (*tls.Config, error) {
		offeredALPN = tlsSafeALPN(hello.SupportedProtos)
		offeredTLS = append([]uint16(nil), hello.SupportedVersions...)
		for _, scheme := range hello.SignatureSchemes {
			if scheme == tls.ECDSAWithP256AndSHA256 {
				ecdsaP256 = true
			}
		}
		return nil, nil
	}})
	_ = conn.SetDeadline(time.Now().Add(15 * time.Second))
	err := conn.Handshake()
	p.agent.recordTLSHandshake(authority, conn.ConnectionState(), offeredALPN, offeredTLS, ecdsaP256, err, identity)
	if err != nil {
		_ = conn.Close()
		return
	}
	_ = conn.SetDeadline(time.Time{})
	tracker := &requestHeaderTracker{}
	ln := newSingleListener(conn, tracker)
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := context.WithValue(r.Context(), relayAttributionKey{}, identity)
		ctx = context.WithValue(ctx, clientHelloSpecKey{}, spec)
		ctx = context.WithValue(ctx, clientHelloWireKey{}, captured)
		ctx = context.WithValue(ctx, clientTransportsKey{}, sessionTransports)
		p.forward(w, r.WithContext(ctx), authority)
	}), ConnContext: func(ctx context.Context, _ net.Conn) context.Context {
		return context.WithValue(ctx, rawHeadersKey{}, tracker)
	}, ReadHeaderTimeout: 15 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 64 * 1024, ErrorLog: log.New(io.Discard, "", 0)}
	if conn.ConnectionState().NegotiatedProtocol == "h2" {
		(&http2.Server{}).ServeConn(conn, &http2.ServeConnOpts{Handler: server.Handler, BaseConfig: server})
		return
	}
	_ = server.Serve(ln)
}

type bufferedConn struct {
	net.Conn
	reader *bufio.Reader
}

func (c *bufferedConn) Read(b []byte) (int, error) { return c.reader.Read(b) }
func splice(a, b net.Conn) {
	done := make(chan struct{})
	go func() {
		_, _ = io.Copy(b, a)
		if h, ok := b.(interface{ CloseWrite() error }); ok {
			_ = h.CloseWrite()
		}
		close(done)
	}()
	_, _ = io.Copy(a, b)
	_ = a.Close()
	_ = b.Close()
	<-done
}

type singleListener struct {
	conn      net.Conn
	tracker   *requestHeaderTracker
	once      sync.Once
	done      chan struct{}
	closeOnce sync.Once
}
type notifyConn struct {
	net.Conn
	done    func()
	tracker *requestHeaderTracker
}

func (c *notifyConn) Close() error { e := c.Conn.Close(); c.done(); return e }
func (c *notifyConn) Read(b []byte) (int, error) {
	n, err := c.Conn.Read(b)
	if n > 0 && c.tracker != nil {
		c.tracker.feed(b[:n])
	}
	return n, err
}
func newSingleListener(c net.Conn, trackers ...*requestHeaderTracker) *singleListener {
	l := &singleListener{conn: c, done: make(chan struct{})}
	if len(trackers) > 0 {
		l.tracker = trackers[0]
	}
	return l
}
func (l *singleListener) Accept() (net.Conn, error) {
	var c net.Conn
	l.once.Do(func() {
		c = &notifyConn{Conn: l.conn, done: func() { l.closeOnce.Do(func() { close(l.done) }) }, tracker: l.tracker}
	})
	if c != nil {
		return c, nil
	}
	<-l.done
	return nil, net.ErrClosed
}
func (l *singleListener) Close() error {
	l.closeOnce.Do(func() { close(l.done) })
	return l.conn.Close()
}
func (l *singleListener) Addr() net.Addr { return l.conn.LocalAddr() }

func appFromUserAgent(c *policy.Catalogue, ua string) (string, *EventApp) {
	if ua == "" || c == nil {
		return "", nil
	}
	if strings.HasPrefix(ua, "Mozilla/") {
		for _, browser := range []struct{ pattern, name string }{{"Edg/", "Microsoft Edge"}, {"Firefox/", "Firefox"}, {"Chrome/", "Google Chrome"}, {"Safari/", "Safari"}} {
			if strings.Contains(ua, browser.pattern) {
				return "", &EventApp{Name: browser.name}
			}
		}
		return "", nil
	}
	tokens := strings.FieldsFunc(ua, func(r rune) bool { return r == ' ' || r == '/' })
	if len(tokens) == 0 {
		return "", nil
	}
	token := strings.ToLower(tokens[0])
	r := []rune(token)
	app := &EventApp{Name: string(r[:min(120, len(r))])}
	for _, candidate := range []string{token, strings.TrimSuffix(token, "-cli"), strings.TrimSuffix(token, "_cli_rs"), strings.TrimSuffix(token, "_cli"), strings.TrimSuffix(token, "-code")} {
		for _, s := range c.Services {
			if contains(s.CLINames, candidate) {
				app.CLI = candidate
				return candidate, app
			}
		}
	}
	return "", app
}
