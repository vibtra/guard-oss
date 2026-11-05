// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	utls "github.com/refraction-networking/utls"
)

type rawHTTP1Transport struct {
	mu                    sync.Mutex
	conns                 map[string]*rawHTTP1Conn
	close                 bool
	responseHeaderTimeout time.Duration
}

type rawHTTP1Conn struct {
	conn net.Conn
	read *bufio.Reader
	busy bool
}

func newRawHTTP1Transport() *rawHTTP1Transport {
	return &rawHTTP1Transport{conns: map[string]*rawHTTP1Conn{}, responseHeaderTimeout: 60 * time.Second}
}

func (t *rawHTTP1Transport) closeIdleConnections() {
	t.mu.Lock()
	t.close = true
	for key, c := range t.conns {
		if !c.busy {
			_ = c.conn.Close()
			delete(t.conns, key)
		}
	}
	t.mu.Unlock()
}

func (t *rawHTTP1Transport) roundTrip(req *http.Request, rawHeaders []rawHeader, roots *x509.CertPool, spec utls.ClientHelloSpec, onHello func([]byte)) (*http.Response, error) {
	key := req.URL.Scheme + "://" + strings.ToLower(req.URL.Host)
	t.mu.Lock()
	if t.close {
		t.mu.Unlock()
		return nil, errors.New("client upstream session is closed")
	}
	c := t.conns[key]
	if c != nil && c.busy {
		t.mu.Unlock()
		return nil, errors.New("HTTP/1 upstream request overlapped an active response")
	}
	if c == nil {
		var conn net.Conn
		var err error
		if req.URL.Scheme == "https" {
			name, _, splitErr := net.SplitHostPort(req.URL.Host)
			if splitErr != nil {
				name = req.URL.Hostname()
			}
			if explicit, ok := req.Context().Value(tlsNameKey{}).(string); ok {
				name = explicit
			}
			conn, err = replayDial(req.Context(), req.URL.Host, name, roots, spec, onHello)
		} else {
			conn, err = (&net.Dialer{}).DialContext(req.Context(), "tcp", req.URL.Host)
		}
		if err != nil {
			t.mu.Unlock()
			return nil, err
		}
		c = &rawHTTP1Conn{conn: conn, read: bufio.NewReader(conn)}
		t.conns[key] = c
	}
	c.busy = true
	t.mu.Unlock()

	cancelled := make(chan struct{})
	stopCancel := context.AfterFunc(req.Context(), func() {
		_ = c.conn.Close()
		close(cancelled)
	})
	var finishOnce sync.Once
	finish := func(reusable bool) {
		finishOnce.Do(func() {
			if !stopCancel() {
				<-cancelled
				reusable = false
			}
			t.finish(key, c, reusable && !req.Close)
		})
	}
	fail := func(err error) (*http.Response, error) {
		finish(false)
		return nil, err
	}
	if err := writeRawRequest(c.conn, req, rawHeaders); err != nil {
		return fail(err)
	}
	if t.responseHeaderTimeout > 0 {
		_ = c.conn.SetReadDeadline(time.Now().Add(t.responseHeaderTimeout))
	}
	var res *http.Response
	for interim := 0; ; interim++ {
		var err error
		res, err = http.ReadResponse(c.read, req)
		if err != nil {
			return fail(err)
		}
		if res.StatusCode >= 200 || res.StatusCode == http.StatusSwitchingProtocols {
			break
		}
		_ = res.Body.Close()
		if interim >= 9 {
			return fail(errors.New("too many informational responses"))
		}
	}
	_ = c.conn.SetReadDeadline(time.Time{})
	res.Request = req
	if state, ok := c.conn.(interface{ ConnectionState() tls.ConnectionState }); ok {
		state := state.ConnectionState()
		res.TLS = &state
	}
	if res.StatusCode == http.StatusSwitchingProtocols {
		res.Body = &rawUpgradedBody{reader: c.read, conn: c.conn, done: func() { finish(false) }}
		return res, nil
	}
	if res.Body == http.NoBody {
		finish(!res.Close)
		return res, nil
	}
	res.Body = &managedResponseBody{ReadCloser: res.Body, done: func(complete bool) { finish(complete && !res.Close) }}
	return res, nil
}

func (t *rawHTTP1Transport) finish(key string, c *rawHTTP1Conn, reusable bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	c.busy = false
	if t.close || !reusable {
		_ = c.conn.Close()
		if t.conns[key] == c {
			delete(t.conns, key)
		}
	}
}

type managedResponseBody struct {
	io.ReadCloser
	done func(bool)
	eof  bool
	once sync.Once
}

func (b *managedResponseBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	if err == io.EOF {
		b.eof = true
	}
	return n, err
}

func (b *managedResponseBody) Close() error {
	b.once.Do(func() { b.done(b.eof) })
	err := b.ReadCloser.Close()
	return err
}

type rawUpgradedBody struct {
	reader *bufio.Reader
	conn   net.Conn
	done   func()
	once   sync.Once
}

func (b *rawUpgradedBody) Read(p []byte) (int, error)  { return b.reader.Read(p) }
func (b *rawUpgradedBody) Write(p []byte) (int, error) { return b.conn.Write(p) }
func (b *rawUpgradedBody) Close() error {
	err := b.conn.Close()
	b.once.Do(b.done)
	return err
}

func writeRawRequest(conn net.Conn, req *http.Request, rawHeaders []rawHeader) error {
	uri := req.URL.RequestURI()
	if uri == "" {
		uri = "/"
	}
	upgrade := strings.EqualFold(req.Header.Get("Upgrade"), "websocket")
	connectionTokens := map[string]bool{}
	for _, h := range rawHeaders {
		if strings.EqualFold(h.name, "Connection") {
			for _, token := range strings.Split(h.value, ",") {
				connectionTokens[strings.ToLower(strings.TrimSpace(token))] = true
			}
		}
	}
	var b bytes.Buffer
	fmt.Fprintf(&b, "%s %s HTTP/1.1\r\n", req.Method, uri)
	hasHost, hasLength, hasTransfer := false, false, false
	chunked := hasChunked(req.TransferEncoding) || req.Body != nil && req.Body != http.NoBody && req.ContentLength < 0
	for _, h := range rawHeaders {
		if !safeRawHeader(h.name, h.value) {
			return errors.New("unsafe raw request header")
		}
		lower := strings.ToLower(h.name)
		if lower == "content-length" {
			if !chunked && !hasLength && req.ContentLength >= 0 {
				fmt.Fprintf(&b, "%s: %d\r\n", h.name, req.ContentLength)
				hasLength = true
			}
			continue
		}
		if lower == "transfer-encoding" {
			if chunked && !hasTransfer {
				fmt.Fprintf(&b, "%s: chunked\r\n", h.name)
				hasTransfer = true
			}
			continue
		}
		if lower == "host" {
			hasHost = true
		}
		if lower == "proxy-authorization" || lower == "proxy-authenticate" || lower == "proxy-connection" || lower == "keep-alive" || lower == "te" || lower == "trailer" {
			continue
		}
		if connectionTokens[lower] && (!upgrade || lower != "upgrade" && lower != "connection") {
			continue
		}
		if lower == "connection" && !upgrade {
			continue
		}
		if lower == "upgrade" && !upgrade {
			continue
		}
		fmt.Fprintf(&b, "%s: %s\r\n", h.name, h.value)
	}
	if !hasHost {
		fmt.Fprintf(&b, "Host: %s\r\n", req.Host)
	}
	noBody := req.Body == nil || req.Body == http.NoBody
	if !noBody {
		if hasChunked(req.TransferEncoding) {
			if !hasTransfer {
				b.WriteString("Transfer-Encoding: chunked\r\n")
				hasTransfer = true
			}
		} else if req.ContentLength >= 0 && !hasLength {
			fmt.Fprintf(&b, "Content-Length: %d\r\n", req.ContentLength)
		} else if req.ContentLength < 0 && !hasTransfer {
			b.WriteString("Transfer-Encoding: chunked\r\n")
			hasTransfer = true
		}
	} else if !hasLength && !hasTransfer && req.ContentLength == 0 && (req.Method == "POST" || req.Method == "PUT" || req.Method == "PATCH") {
		b.WriteString("Content-Length: 0\r\n")
	}
	b.WriteString("\r\n")
	if _, err := conn.Write(b.Bytes()); err != nil {
		return err
	}
	if noBody {
		if hasTransfer {
			_, err := io.WriteString(conn, "0\r\n\r\n")
			return err
		}
		return nil
	}
	if hasChunked(req.TransferEncoding) || req.ContentLength < 0 {
		return writeChunkedBody(conn, req.Body)
	}
	_, err := io.Copy(conn, req.Body)
	return err
}

func hasChunked(transferEncoding []string) bool {
	for _, value := range transferEncoding {
		if strings.EqualFold(value, "chunked") {
			return true
		}
	}
	return false
}

func writeChunkedBody(w io.Writer, body io.Reader) error {
	buf := make([]byte, 32*1024)
	for {
		n, err := body.Read(buf)
		if n > 0 {
			if _, e := fmt.Fprintf(w, "%x\r\n", n); e != nil {
				return e
			}
			if _, e := w.Write(buf[:n]); e != nil {
				return e
			}
			if _, e := io.WriteString(w, "\r\n"); e != nil {
				return e
			}
		}
		if err == io.EOF {
			_, e := io.WriteString(w, "0\r\n\r\n")
			return e
		}
		if err != nil {
			return err
		}
	}
}
