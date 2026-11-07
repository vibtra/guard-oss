// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

//go:build darwin || guard_test

package main

import (
	"bufio"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const noSignerReason = reasonSignerUnavailable
const signerTimeout = 5 * time.Second

func signerSocket() string {
	if sock := signerSocketOverride(); sock != "" {
		return sock
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library", "Application Support", "Vibtra Guard", "ca-signer.sock")
}

type redial struct {
	mu   sync.Mutex
	next time.Time
	wait time.Duration
	last error
}

var signerRedial redial

func (r *redial) blocked() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if time.Now().Before(r.next) {
		return r.last
	}
	return nil
}
func (r *redial) failed(e error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.wait = min(max(2*r.wait, time.Second), 5*time.Second)
	r.next = time.Now().Add(r.wait)
	r.last = e
}
func (r *redial) connected() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.wait, r.next, r.last = 0, time.Time{}, nil
}

type signerConn struct {
	conn net.Conn
	r    *bufio.Reader
}

func unavailable(e error) error { return &interceptionOff{reason: reasonSignerUnavailable, err: e} }

func dialSigner() (*signerConn, error) {
	if e := signerRedial.blocked(); e != nil {
		return nil, e
	}
	c, e := openSignerConn()
	if e != nil {
		signerRedial.failed(e)
		return nil, e
	}
	signerRedial.connected()
	return c, nil
}
func openSignerConn() (*signerConn, error) {
	conn, e := net.DialTimeout("unix", signerSocket(), signerTimeout)
	if e != nil {
		return nil, unavailable(e)
	}
	c := &signerConn{conn: conn, r: bufio.NewReaderSize(conn, 4096)}
	_ = conn.SetDeadline(time.Now().Add(signerTimeout))
	line, e := c.readLine()
	if nonce, ok := strings.CutPrefix(line, "nonce "); e == nil && ok && isNonce(nonce) {
		if _, e = io.WriteString(conn, "hello "+nonce+"\n"); e == nil {
			if line, e = c.readLine(); e == nil && line == "ready" {
				return c, nil
			}
		}
	}
	_ = conn.Close()
	switch {
	case e != nil:
		return nil, unavailable(e)
	case line == "err unauthorised binding":
		return nil, &interceptionOff{reason: reasonSignerUnavailable, signer: "refused", err: errors.New("the Guard app could not bind this connection to this agent (" + line + ")")}
	case strings.HasPrefix(line, "err unauthorised"):
		return nil, &interceptionOff{reason: reasonUnsignedBuild, err: errors.New("the Guard app refused this agent (" + line + ")")}
	}
	return nil, unavailable(errors.New("the signer did not complete the handshake (" + line + ")"))
}
func isNonce(b64 string) bool {
	raw, e := base64.StdEncoding.DecodeString(b64)
	return e == nil && len(raw) == 32
}
func (c *signerConn) readLine() (string, error) {
	line, e := c.r.ReadSlice('\n')
	if e != nil {
		return "", e
	}
	return strings.TrimSuffix(string(line), "\n"), nil
}
func (c *signerConn) call(request string) (string, error) {
	_ = c.conn.SetDeadline(time.Now().Add(signerTimeout))
	return c.send(request)
}
func (c *signerConn) send(request string) (string, error) {
	if _, e := io.WriteString(c.conn, request+"\n"); e != nil {
		return "", unavailable(e)
	}
	line, e := c.readLine()
	if e != nil {
		return "", unavailable(e)
	}
	if rest, ok := strings.CutPrefix(line, "ok"); ok && (rest == "" || rest[0] == ' ') {
		return strings.TrimPrefix(rest, " "), nil
	}
	switch {
	case line == "err no-key":
		return "", &interceptionOff{reason: reasonKeyUnavailable, err: errNoKey}
	case line == "err no-se":
		return "", &interceptionOff{reason: reasonNoSecureEnclave, err: signerAnswer(line)}
	case strings.HasPrefix(line, "err unauthorised"):
		return "", &interceptionOff{reason: reasonUnsignedBuild, err: signerAnswer(line)}
	}
	return "", signerAnswer(line)
}

type signerAnswer string

func (a signerAnswer) Error() string { return "the signer answered " + string(a) }

func keychainOff(e error) error {
	var answer signerAnswer
	if errors.As(e, &answer) && strings.HasPrefix(string(answer), "err keychain") {
		return &interceptionOff{reason: reasonKeyUnavailable, err: e}
	}
	return e
}
func (c *signerConn) close() { _ = c.conn.Close() }

func signature(reply string, e error) ([]byte, error) {
	if e != nil {
		return nil, e
	}
	return base64.StdEncoding.DecodeString(reply)
}
func signerPublicKey(b64 string) (*ecdsa.PublicKey, error) {
	der, e := base64.StdEncoding.DecodeString(b64)
	if e != nil {
		return nil, e
	}
	k, e := x509.ParsePKIXPublicKey(der)
	if e != nil {
		return nil, e
	}
	pub, ok := k.(*ecdsa.PublicKey)
	if !ok || pub.Curve != elliptic.P256() {
		return nil, errors.New("the signer's key is not P-256")
	}
	return pub, nil
}
func sha256Only(opts crypto.SignerOpts) error {
	if opts.HashFunc() != crypto.SHA256 {
		return errors.New("the Guard CA signs with SHA-256 only")
	}
	return nil
}

type appSignerKey struct {
	id   keyID
	pub  *ecdsa.PublicKey
	mu   sync.Mutex
	conn *signerConn
}

func platformBlocked() error { return nil }

func openAppSigner(id keyID, want *ecdsa.PublicKey) caKey { return &appSignerKey{id: id, pub: want} }

func (k *appSignerKey) Public() crypto.PublicKey { return k.pub }
func (k *appSignerKey) Sign(io.Reader, []byte, crypto.SignerOpts) ([]byte, error) {
	return nil, errors.New("the Guard app signs whole certificates, not digests")
}
func (k *appSignerKey) SignMessage(_ io.Reader, msg []byte, opts crypto.SignerOpts) ([]byte, error) {
	if e := sha256Only(opts); e != nil {
		return nil, e
	}
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.conn == nil {
		conn, e := dialSigner()
		if e != nil {
			return nil, e
		}
		k.conn = conn
	}
	reply, e := k.conn.call("sign " + string(k.id) + " m " + base64.StdEncoding.EncodeToString(msg))
	if offReason(e) == reasonSignerUnavailable {
		k.conn.close()
		k.conn = nil
		signerRedial.failed(e)
	}
	return signature(reply, e)
}
func (k *appSignerKey) Close() error {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.conn != nil {
		k.conn.close()
		k.conn = nil
	}
	return nil
}

type caSelfSigner struct {
	conn *signerConn
	id   keyID
	pub  *ecdsa.PublicKey
}

func (s caSelfSigner) Public() crypto.PublicKey { return s.pub }
func (s caSelfSigner) Sign(io.Reader, []byte, crypto.SignerOpts) ([]byte, error) {
	return nil, errors.New("the Guard app signs whole certificates, not digests")
}
func (s caSelfSigner) SignMessage(_ io.Reader, msg []byte, opts crypto.SignerOpts) ([]byte, error) {
	if e := sha256Only(opts); e != nil {
		return nil, e
	}
	return signature(s.conn.call("ca " + string(s.id) + " " + base64.StdEncoding.EncodeToString(msg)))
}

func createAppSignerCA(tmpl *x509.Certificate) (keyID, *x509.Certificate, error) {
	conn, e := dialSigner()
	if e != nil {
		return "", nil, e
	}
	defer conn.close()
	reply, e := conn.call("create")
	if e != nil {
		return "", nil, keychainOff(e)
	}
	id, spki, _ := strings.Cut(reply, " ")
	pub, e := signerPublicKey(spki)
	if e != nil {
		return "", nil, e
	}
	if raw, _ := base64.StdEncoding.DecodeString(spki); keyIDOf(raw) != keyID(id) {
		return "", nil, errors.New("the signer's key ID does not match its key")
	}
	der, e := x509.CreateCertificate(rand.Reader, tmpl, tmpl, pub, caSelfSigner{conn: conn, id: keyID(id), pub: pub})
	if e != nil {
		return "", nil, e
	}
	cert, e := x509.ParseCertificate(der)
	return keyID(id), cert, e
}

func pruneAppSignerKeys(dir string, keep ...keyID) error {
	if signerSocketOverride() == "" && filepath.Clean(dir) != filepath.Clean(defaultDataDir()) {
		return nil
	}
	conn, e := dialSigner()
	if e != nil {
		return e
	}
	defer conn.close()
	ids := make([]string, len(keep))
	for i, id := range keep {
		ids[i] = string(id)
	}
	_, e = conn.call(strings.TrimSpace("prune " + strings.Join(ids, ",")))
	return e
}

func probeAppSigner(id keyID) error {
	conn, e := dialSigner()
	if e != nil {
		return e
	}
	defer conn.close()
	_, e = conn.send("pub " + string(id))
	return e
}

func appSignerPub(id keyID) (*ecdsa.PublicKey, error) {
	conn, e := dialSigner()
	if e != nil {
		return nil, e
	}
	defer conn.close()
	reply, e := conn.call("pub " + string(id))
	if e != nil {
		return nil, keychainOff(e)
	}
	return signerPublicKey(reply)
}
