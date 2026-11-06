// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"syscall"
	"time"
)

type CA struct {
	dir    string
	mu     sync.Mutex
	key    caKey
	leaves map[string]*tls.Certificate

	state         sync.Mutex
	cert          *x509.Certificate
	pem           []byte
	blocked       error
	reason        string
	signer        string
	lastSignError string
}

func serial() *big.Int { n, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128)); return n }
func loadCA(dir string) *CA {
	c := &CA{dir: dir, leaves: map[string]*tls.Certificate{}, reason: noSignerReason, signer: "unavailable"}
	c.readFiles()
	return c
}
func (c *CA) readFiles() {
	cert, certPEM, blocked := readCAFiles(c.dir)
	c.state.Lock()
	defer c.state.Unlock()
	c.cert, c.pem, c.blocked = cert, certPEM, blocked
	if blocked != nil {
		c.reason = offReason(blocked)
	}
}
func readCAFiles(dir string) (*x509.Certificate, []byte, error) {
	if e := platformBlocked(); e != nil {
		return nil, nil, e
	}
	var blocked error
	if _, e := os.Stat(filepath.Join(dir, "ca.key")); !os.IsNotExist(e) {
		blocked = &interceptionOff{reason: reasonKeyUnavailable, err: errors.New("ca.key from an earlier Guard is present; Guard never signs with a key file")}
	}
	certPEM, e := os.ReadFile(filepath.Join(dir, "ca.pem"))
	if os.IsNotExist(e) {
		return nil, nil, blocked
	}
	if e == nil {
		var cert *x509.Certificate
		if cert, e = parseCA(certPEM); e == nil {
			return cert, certPEM, blocked
		}
	}
	return nil, nil, &interceptionOff{reason: reasonKeyUnavailable, err: e}
}
func parseCA(certPEM []byte) (*x509.Certificate, error) {
	block, _ := pem.Decode(certPEM)
	if block == nil || block.Type != "CERTIFICATE" {
		return nil, errors.New("invalid interception CA PEM")
	}
	cert, e := x509.ParseCertificate(block.Bytes)
	if e != nil {
		return nil, e
	}
	if pub, ok := cert.PublicKey.(*ecdsa.PublicKey); !ok || pub.Curve != elliptic.P256() || !cert.IsCA || time.Now().Before(cert.NotBefore) || !time.Now().Before(cert.NotAfter) {
		return nil, errors.New("interception CA key or validity is invalid")
	}
	return cert, nil
}
func caTemplate() *x509.Certificate {
	host, _ := os.Hostname()
	now := time.Now()
	return &x509.Certificate{SerialNumber: serial(), Subject: pkix.Name{CommonName: "Vibtra Guard local CA (" + host + ")", Organization: []string{"Vibtra Guard"}}, NotBefore: now.Add(-time.Hour), NotAfter: now.AddDate(10, 0, 0), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature, MaxPathLenZero: true}
}

func (c *CA) ensure() {
	c.mu.Lock()
	defer c.mu.Unlock()
	_, _ = c.ready()
}
func (c *CA) ready() (caKey, error) {
	if c.key != nil {
		return c.key, nil
	}
	unlock, e := lockFile(filepath.Join(c.dir, "ca.lock"))
	if e != nil {
		return nil, e
	}
	defer unlock()
	c.readFiles()
	c.state.Lock()
	cert, blocked := c.cert, c.blocked
	c.state.Unlock()
	if blocked != nil {
		return nil, blocked
	}
	key, e := c.open(cert)
	if e != nil && offReason(e) == "" {
		e = &interceptionOff{reason: reasonKeyUnavailable, err: e}
	}
	c.note(e)
	if e != nil {
		return nil, e
	}
	c.key = key
	return key, nil
}
func (c *CA) open(cert *x509.Certificate) (caKey, error) {
	if cert == nil {
		id, cert, e := createAppSignerCA(caTemplate())
		if e != nil {
			return nil, e
		}
		certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert.Raw})
		if e := atomicWrite(filepath.Join(c.dir, "ca.pem"), certPEM); e != nil {
			return nil, e
		}
		c.state.Lock()
		c.cert, c.pem = cert, certPEM
		c.state.Unlock()
		return openAppSigner(id, cert.PublicKey.(*ecdsa.PublicKey)), nil
	}
	id := keyIDOf(cert.RawSubjectPublicKeyInfo)
	pub, e := appSignerPub(id)
	if e != nil {
		return nil, e
	}
	want := cert.PublicKey.(*ecdsa.PublicKey)
	if !pub.Equal(want) {
		return nil, &interceptionOff{reason: reasonKeyUnavailable, err: errors.New("the signer's key does not match ca.pem")}
	}
	return openAppSigner(id, want), nil
}
func (c *CA) note(e error) {
	c.state.Lock()
	defer c.state.Unlock()
	c.reason = offReason(e)
	c.signer = signerState(e)
	if e != nil {
		c.lastSignError = e.Error()
	}
}
func lockFile(path string) (func(), error) {
	f, e := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return nil, e
	}
	if e = syscall.Flock(int(f.Fd()), syscall.LOCK_EX); e != nil {
		_ = f.Close()
		return nil, e
	}
	return func() {
		_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		_ = f.Close()
	}, nil
}

func (c *CA) certificate() (*x509.Certificate, []byte) {
	c.state.Lock()
	defer c.state.Unlock()
	return c.cert, c.pem
}
func (c *CA) facts() map[string]any {
	cert, _ := c.certificate()
	if cert == nil {
		return nil
	}
	hash := sha256.Sum256(cert.Raw)
	return map[string]any{"fingerprintSha256": hex.EncodeToString(hash[:]), "subject": cert.Subject.String(), "notAfter": cert.NotAfter.UTC().Format(time.RFC3339)}
}
func (c *CA) spki() string {
	cert, _ := c.certificate()
	if cert == nil {
		return ""
	}
	hash := sha256.Sum256(cert.RawSubjectPublicKeyInfo)
	return base64.StdEncoding.EncodeToString(hash[:])
}
func (c *CA) interception() map[string]any {
	c.state.Lock()
	defer c.state.Unlock()
	if c.reason == "" {
		return map[string]any{"on": true}
	}
	return map[string]any{"on": false, "reason": c.reason}
}
func (c *CA) status() map[string]any {
	out := c.facts()
	if out == nil {
		out = map[string]any{}
	}
	c.state.Lock()
	defer c.state.Unlock()
	if c.reason == "" {
		out["keyStore"] = "secure-enclave"
	}
	out["signer"] = c.signer
	if c.lastSignError != "" {
		out["lastSignError"] = c.lastSignError
	}
	return out
}
func refusalLine(e error) string {
	if reason := offReason(e); reason != "" {
		return "This Mac cannot protect AI traffic: " + reasonWords(reason)
	}
	return "This Mac cannot protect AI traffic: the certificate could not be signed"
}

func (c *CA) leaf(host string) (*tls.Certificate, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if cert := c.leaves[host]; cert != nil && time.Now().Add(time.Minute).Before(cert.Leaf.NotAfter) {
		return cert, nil
	}
	signer, e := c.ready()
	if e != nil {
		return nil, e
	}
	ca, _ := c.certificate()
	key, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if e != nil {
		return nil, e
	}
	now := time.Now()
	tmpl := &x509.Certificate{SerialNumber: serial(), Subject: pkix.Name{CommonName: host}, NotBefore: now.Add(-time.Hour), NotAfter: minTime(now.Add(24*time.Hour), ca.NotAfter), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	if ip := net.ParseIP(host); ip != nil {
		tmpl.IPAddresses = []net.IP{ip}
	} else {
		tmpl.DNSNames = []string{host}
	}
	der, e := x509.CreateCertificate(rand.Reader, tmpl, ca, &key.PublicKey, signer)
	c.note(e)
	if e != nil {
		return nil, e
	}
	leaf, e := x509.ParseCertificate(der)
	if e != nil {
		return nil, e
	}
	cert := &tls.Certificate{Certificate: [][]byte{der, ca.Raw}, PrivateKey: key, Leaf: leaf}
	if len(c.leaves) >= 256 {
		c.leaves = map[string]*tls.Certificate{}
	}
	c.leaves[host] = cert
	return cert, nil
}
func minTime(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}

func (a *Agent) caTrusted() *bool {
	if runtime.GOOS != "darwin" {
		return nil
	}
	a.trustMu.Lock()
	defer a.trustMu.Unlock()
	if !a.trustAt.IsZero() && time.Since(a.trustAt) < 10*time.Second {
		return a.trusted
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	e := exec.CommandContext(ctx, "/usr/bin/security", "verify-cert", "-L", "-q", "-p", "ssl", "-c", filepath.Join(a.dir, "ca.pem")).Run()
	ok := e == nil
	a.trusted = &ok
	a.trustAt = time.Now()
	return a.trusted
}
