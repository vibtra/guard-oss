// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package main

import (
	"context"
	"errors"
	"net"
	"net/http"
	"sync"
	"time"

	utls "github.com/refraction-networking/utls"
	"golang.org/x/net/http2"
)

type negotiatingTransport struct {
	mu      sync.Mutex
	dial    func(context.Context, string, string) (net.Conn, error)
	peers   map[string]*negotiatedPeer
	sockets map[*ownedUpstreamConn]struct{}
	closed  bool
}
type negotiatedPeer struct {
	h1 *http.Transport
	h2 *http2.ClientConn
}
type ownedUpstreamConn struct {
	net.Conn
	owner *negotiatingTransport
}

func (c *ownedUpstreamConn) Close() error {
	err := c.Conn.Close()
	c.owner.mu.Lock()
	delete(c.owner.sockets, c)
	c.owner.mu.Unlock()
	return err
}
func (t *negotiatingTransport) ownLocked(conn net.Conn) *ownedUpstreamConn {
	if t.sockets == nil {
		t.sockets = make(map[*ownedUpstreamConn]struct{})
	}
	c := &ownedUpstreamConn{Conn: conn, owner: t}
	t.sockets[c] = struct{}{}
	return c
}
func upstreamProtocol(conn net.Conn) string {
	if c, ok := conn.(*utls.UConn); ok {
		return c.ConnectionState().NegotiatedProtocol
	}
	return ""
}
func (t *negotiatingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	res, err := t.roundTrip(req)
	if err == nil || req.Context().Err() != nil || !h2RequestUnprocessed(err) {
		return res, err
	}
	if req.Body != nil && req.Body != http.NoBody && req.GetBody == nil {
		return nil, err
	}
	retry := req.Clone(req.Context())
	retry.Trailer = req.Trailer
	if req.Body != nil && req.Body != http.NoBody {
		body, bodyErr := req.GetBody()
		if bodyErr != nil {
			return nil, bodyErr
		}
		retry.Body = body
	}
	t.mu.Lock()
	delete(t.peers, req.URL.Scheme+"://"+req.URL.Host)
	t.mu.Unlock()
	return t.roundTrip(retry)
}

func h2RequestUnprocessed(err error) bool {
	if errors.Is(err, http2.ErrNoCachedConn) {
		return true
	}
	var stream http2.StreamError
	if errors.As(err, &stream) {
		return stream.Code == http2.ErrCodeRefusedStream
	}
	return err != nil && (err.Error() == "http2: client conn not usable" || err.Error() == "http2: Transport received Server's graceful shutdown GOAWAY")
}

func (t *negotiatingTransport) roundTrip(req *http.Request) (*http.Response, error) {
	key := req.URL.Scheme + "://" + req.URL.Host
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return nil, errors.New("client upstream session is closed")
	}
	if t.peers == nil {
		t.peers = make(map[string]*negotiatedPeer)
	}
	peer := t.peers[key]
	if peer != nil && peer.h2 != nil && !peer.h2.CanTakeNewRequest() {
		peer = nil
	}
	if peer == nil {
		addr := req.URL.Host
		dial := t.dial
		port := "443"
		if req.URL.Scheme == "http" {
			port = "80"
			dial = (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext
		} else if req.URL.Scheme != "https" {
			t.mu.Unlock()
			return nil, errors.New("unsupported upstream URL scheme")
		}
		if req.URL.Port() == "" {
			addr = net.JoinHostPort(req.URL.Hostname(), port)
		}
		conn, err := dial(req.Context(), "tcp", addr)
		if err != nil {
			t.mu.Unlock()
			return nil, err
		}
		protocol := upstreamProtocol(conn)
		owned := t.ownLocked(conn)
		peer = &negotiatedPeer{}
		switch protocol {
		case "h2":
			t.mu.Unlock()
			cc, err := (&http2.Transport{IdleConnTimeout: 90 * time.Second}).NewClientConn(owned)
			t.mu.Lock()
			if err != nil {
				t.mu.Unlock()
				_ = owned.Close()
				return nil, err
			}
			if t.closed {
				t.mu.Unlock()
				_ = cc.Close()
				return nil, errors.New("client upstream session is closed")
			}
			peer.h2 = cc
		case "", "http/1.1":
			var firstMu sync.Mutex
			first := net.Conn(owned)
			dialH1 := func(ctx context.Context, network, addr string) (net.Conn, error) {
				firstMu.Lock()
				c := first
				first = nil
				firstMu.Unlock()
				if c != nil {
					return c, nil
				}
				c, err := dial(ctx, network, addr)
				if err != nil {
					return nil, err
				}
				if proto := upstreamProtocol(c); proto != "" && proto != "http/1.1" {
					_ = c.Close()
					return nil, errors.New("upstream changed HTTP protocol")
				}
				t.mu.Lock()
				defer t.mu.Unlock()
				if t.closed {
					_ = c.Close()
					return nil, errors.New("client upstream session is closed")
				}
				return t.ownLocked(c), nil
			}
			peer.h1 = &http.Transport{DisableCompression: true, ResponseHeaderTimeout: 60 * time.Second, IdleConnTimeout: 90 * time.Second, DialContext: dialH1, DialTLSContext: dialH1}
		default:
			t.mu.Unlock()
			_ = owned.Close()
			return nil, errors.New("unsupported upstream ALPN")
		}
		t.peers[key] = peer
	}
	t.mu.Unlock()
	if peer.h2 != nil {
		return peer.h2.RoundTrip(req)
	}
	h1req := req.Clone(req.Context())
	h1req.Trailer = req.Trailer
	h1req.Header.Del("Te")
	if len(h1req.Trailer) > 0 {
		h1req.ContentLength = -1
		h1req.TransferEncoding = []string{"chunked"}
	}
	return peer.h1.RoundTrip(h1req)
}

func (t *negotiatingTransport) CloseIdleConnections() {
	t.mu.Lock()
	t.closed = true
	var sockets []*ownedUpstreamConn
	for c := range t.sockets {
		sockets = append(sockets, c)
	}
	var h1 []*http.Transport
	for _, peer := range t.peers {
		if peer.h1 != nil {
			h1 = append(h1, peer.h1)
		}
	}
	t.mu.Unlock()
	for _, c := range sockets {
		_ = c.Close()
	}
	for _, tr := range h1 {
		tr.CloseIdleConnections()
	}
}
