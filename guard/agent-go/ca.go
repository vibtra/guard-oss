// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

type CA struct {
	dir    string
	mu     sync.Mutex
	key    caKey
	leaves map[string]*tls.Certificate

	trustMu sync.Mutex
	trustAt time.Time
	trusted *bool

	state         sync.Mutex
	cert          *x509.Certificate
	pem           []byte
	blocked       error
	reason        string
	signer        string
	lastSignError string
	notes         int
	awaiting      bool
	holdUntil     time.Time
	wake          chan struct{}
}

func serial() *big.Int { n, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128)); return n }
func loadCA(dir string) *CA {
	c := &CA{dir: dir, leaves: map[string]*tls.Certificate{}, reason: noSignerReason, signer: "unavailable", wake: make(chan struct{})}
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
	certPEM, e := os.ReadFile(filepath.Join(dir, "ca.pem"))
	if os.IsNotExist(e) {
		return nil, nil, nil
	}
	if e == nil {
		var cert *x509.Certificate
		if cert, e = parseCA(certPEM); e == nil {
			return cert, certPEM, nil
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
	if c.key == nil {
		defer c.mu.Unlock()
		_, _ = c.ready()
		return
	}
	cert, _ := c.certificate()
	c.state.Lock()
	seen := c.notes
	c.state.Unlock()
	c.mu.Unlock()
	e := probeAppSigner(keyIDOf(cert.RawSubjectPublicKeyInfo))
	c.state.Lock()
	defer c.state.Unlock()
	if c.notes == seen {
		c.noteLocked(signerReach(e))
	}
}
func signerReach(e error) error {
	switch offReason(e) {
	case reasonSignerUnavailable:
		return e
	case reasonUnsignedBuild:
		return &interceptionOff{reason: reasonSignerUnavailable, signer: "refused", err: e}
	}
	return nil
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
	cert, _ = c.certificate()
	_ = pruneAppSignerKeys(c.dir, keyIDOf(cert.RawSubjectPublicKeyInfo))
	c.key = key
	c.leaves = map[string]*tls.Certificate{}
	trusted := c.trust(0)
	c.state.Lock()
	c.awaiting = trusted != nil && !*trusted
	c.holdUntil = time.Time{}
	if c.awaiting {
		c.holdUntil = time.Now().Add(holdWindow())
	}
	c.state.Unlock()
	return key, nil
}
func (c *CA) open(cert *x509.Certificate) (caKey, error) {
	if cert != nil {
		id := keyIDOf(cert.RawSubjectPublicKeyInfo)
		pub, e := appSignerPub(id)
		if !errors.Is(e, errNoKey) {
			if e != nil {
				return nil, e
			}
			want := cert.PublicKey.(*ecdsa.PublicKey)
			if !pub.Equal(want) {
				return nil, &interceptionOff{reason: reasonKeyUnavailable, err: errors.New("the signer's key does not match ca.pem")}
			}
			return openAppSigner(id, want), nil
		}
		if e := c.retire(cert); e != nil {
			return nil, e
		}
	}
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
func (c *CA) retire(cert *x509.Certificate) error {
	hash := sha256.Sum256(cert.Raw)
	if e := os.Rename(filepath.Join(c.dir, "ca.pem"), filepath.Join(c.dir, "ca-stale-"+hex.EncodeToString(hash[:6])+".pem")); e != nil {
		return e
	}
	c.state.Lock()
	c.cert, c.pem = nil, nil
	c.state.Unlock()
	return nil
}
func staleCAFiles(dir string) []string {
	entries, _ := os.ReadDir(dir)
	var stale []string
	for _, entry := range entries {
		if name := entry.Name(); strings.HasPrefix(name, "ca-stale-") && strings.HasSuffix(name, ".pem") {
			stale = append(stale, filepath.Join(dir, name))
		}
	}
	return stale
}
func (c *CA) note(e error) {
	c.state.Lock()
	defer c.state.Unlock()
	c.noteLocked(e)
}
func (c *CA) noteLocked(e error) {
	c.notes++
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
	switch {
	case c.reason != "":
		return map[string]any{"on": false, "reason": c.reason}
	case c.awaiting:
		return map[string]any{"on": false, "reason": reasonAwaitingTrust}
	}
	return map[string]any{"on": true}
}
func (c *CA) status() map[string]any {
	out := c.facts()
	if out == nil {
		out = map[string]any{}
	}
	out["staleCAs"] = len(staleCAFiles(c.dir))
	c.state.Lock()
	defer c.state.Unlock()
	switch {
	case c.reason != "":
		out["state"] = "off"
	case c.awaiting:
		out["state"] = reasonAwaitingTrust
	default:
		out["state"] = "ready"
	}
	if c.awaiting && time.Now().Before(c.holdUntil) {
		out["holdUntil"] = c.holdUntil.UTC().Format(time.RFC3339)
	}
	if c.reason == "" {
		out["keyStore"] = "secure-enclave"
	}
	out["signer"] = c.signer
	if c.lastSignError != "" {
		out["lastSignError"] = c.lastSignError
	}
	return out
}
func passesThrough(e error) bool {
	switch offReason(e) {
	case reasonNoSecureEnclave, reasonKeyUnavailable, reasonUnsignedBuild, reasonUnsupportedPlatform, reasonAwaitingTrust:
		return true
	}
	return false
}
func refusalLine(e error) string {
	switch reason := offReason(e); reason {
	case "":
		return "This Mac cannot protect AI traffic: the certificate could not be signed"
	default:
		return "This Mac cannot protect AI traffic: " + reasonWords(reason)
	}
}

func (c *CA) trust(maxAge time.Duration) *bool {
	security := securityBinary()
	if security == "" {
		return nil
	}
	c.trustMu.Lock()
	defer c.trustMu.Unlock()
	if !c.trustAt.IsZero() && time.Since(c.trustAt) < maxAge {
		return c.trusted
	}
	ok := verifyCert(security, filepath.Join(c.dir, "ca.pem"))
	c.trusted, c.trustAt = &ok, time.Now()
	if ok {
		c.state.Lock()
		c.awaiting, c.holdUntil = false, time.Time{}
		c.state.Unlock()
	}
	return c.trusted
}
func verifyCert(security, file string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return exec.CommandContext(ctx, security, "verify-cert", "-L", "-q", "-p", "ssl", "-c", file).Run() == nil
}
func (c *CA) hold() {
	c.state.Lock()
	defer c.state.Unlock()
	if c.awaiting {
		c.holdUntil = time.Now().Add(holdWindow())
	}
}
func (c *CA) reload() {
	c.trust(0)
	c.mu.Lock()
	c.leaves = map[string]*tls.Certificate{}
	c.mu.Unlock()
	c.state.Lock()
	close(c.wake)
	c.wake = make(chan struct{})
	c.state.Unlock()
}
func (c *CA) untrusted() bool {
	c.state.Lock()
	awaiting := c.awaiting
	c.state.Unlock()
	if !awaiting {
		return false
	}
	trusted := c.trust(10 * time.Second)
	return trusted != nil && !*trusted
}
func (c *CA) waitForTrust(giveUp time.Time) bool {
	for {
		c.state.Lock()
		awaiting, left, wake := c.awaiting, min(time.Until(c.holdUntil), time.Until(giveUp)), c.wake
		c.state.Unlock()
		if !awaiting {
			return true
		}
		if left <= 0 {
			return false
		}
		timer := time.NewTimer(min(2*time.Second, left))
		select {
		case <-timer.C:
		case <-wake:
		}
		timer.Stop()
		c.trust(2 * time.Second)
	}
}

func (c *CA) leaf(host string) (*tls.Certificate, error) {
	giveUp := time.Now().Add(holdWindow())
	cert, e := c.signLeaf(host)
	if errors.Is(e, errNoKey) {
		cert, e = c.signLeaf(host)
	}
	for offReason(e) == reasonAwaitingTrust && c.waitForTrust(giveUp) {
		cert, e = c.signLeaf(host)
	}
	return cert, e
}
func (c *CA) signLeaf(host string) (*tls.Certificate, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if cert := c.leaves[host]; cert != nil && time.Now().Add(time.Minute).Before(cert.Leaf.NotAfter) {
		return cert, nil
	}
	signer, e := c.ready()
	if e != nil {
		return nil, e
	}
	if c.untrusted() {
		return nil, errAwaitingTrust
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
	if errors.Is(e, errNoKey) {
		_ = c.key.Close()
		c.key = nil
	}
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

func (a *Agent) caTrusted() *bool { return a.ca.trust(10 * time.Second) }

func trustCA(c *CA, local string) error {
	security := securityBinary()
	if security == "" {
		return errors.New("use your platform certificate store")
	}
	c.mu.Lock()
	_, e := c.ready()
	c.mu.Unlock()
	if e != nil {
		return errors.New("Guard could not make its new certificate: " + reasonWords(offReason(e)))
	}
	_, certPEM := c.certificate()
	caFile := filepath.Join(c.dir, "ca.pem")
	login := filepath.Join(os.Getenv("HOME"), "Library/Keychains/login.keychain-db")
	postAgent(local, "/ca/hold")
	if e := rewriteTrustFiles(c.dir, certPEM); e != nil {
		return e
	}
	if !verifyCert(security, caFile) {
		if e := runSecurity(security, "add-trusted-cert", "-r", "trustRoot", "-p", "ssl", "-k", login, caFile); e != nil {
			return fmt.Errorf("the certificate was not trusted: %w", e)
		}
		if !verifyCert(security, caFile) {
			return errors.New("macOS does not trust the certificate yet")
		}
	}
	postAgent(local, "/ca/reload")
	for _, stale := range staleCAFiles(c.dir) {
		if e := untrustStale(security, login, stale); e != nil {
			return e
		}
	}
	if e := os.Remove(filepath.Join(c.dir, "ca.key")); e != nil && !os.IsNotExist(e) {
		return e
	}
	return nil
}
func runSecurity(security string, args ...string) error {
	cmd := exec.Command(security, args...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}
func postAgent(local, path string) {
	client := &http.Client{Timeout: 2 * time.Second, Transport: &http.Transport{Proxy: nil}}
	if res, e := client.Post("http://"+local+path, "text/plain", nil); e == nil {
		_ = res.Body.Close()
	}
}
func untrustStale(security, login, file string) error {
	certPEM, e := os.ReadFile(file)
	if e != nil {
		return e
	}
	if block, _ := pem.Decode(certPEM); block != nil {
		if verifyCert(security, file) {
			if e := runSecurity(security, "remove-trusted-cert", file); e != nil {
				return fmt.Errorf("the earlier certificate %s is still trusted: %w", filepath.Base(file), e)
			}
		}
		hash := sha1.Sum(block.Bytes)
		sha := strings.ToUpper(hex.EncodeToString(hash[:]))
		found, _ := exec.Command(security, "find-certificate", "-a", "-Z", "-c", "Vibtra Guard", login).Output()
		if strings.Contains(string(found), "SHA-1 hash: "+sha+"\n") {
			if e := runSecurity(security, "delete-certificate", "-Z", sha, login); e != nil {
				return fmt.Errorf("the earlier certificate %s is still in the login keychain: %w", filepath.Base(file), e)
			}
		}
	}
	return os.Remove(file)
}
func rewriteTrustFiles(dir string, current []byte) error {
	caFile := filepath.Join(dir, "guard-ca.pem")
	if _, e := os.Stat(caFile); e == nil {
		if e := atomicWrite(caFile, current); e != nil {
			return e
		}
	}
	bundleFile := filepath.Join(dir, "guard-ca-bundle.pem")
	bundle, e := os.ReadFile(bundleFile)
	if os.IsNotExist(e) {
		return nil
	}
	if e != nil {
		return e
	}
	var kept []byte
	for block, rest := pem.Decode(bundle); block != nil; block, rest = pem.Decode(rest) {
		if block.Type == "CERTIFICATE" && !isGuardCA(block.Bytes) {
			kept = append(kept, pem.EncodeToMemory(block)...)
		}
	}
	return atomicWrite(bundleFile, append(kept, current...))
}
func isGuardCA(der []byte) bool {
	cert, e := x509.ParseCertificate(der)
	if e != nil {
		return false
	}
	name := cert.Subject.CommonName
	return (strings.HasPrefix(name, "Vibtra Guard local CA (") || strings.HasPrefix(name, "Vibtra Guard CA (")) && len(cert.Subject.Organization) == 1 && cert.Subject.Organization[0] == "Vibtra Guard"
}
