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
	"time"
)

type CA struct {
	Cert   *x509.Certificate
	Key    *ecdsa.PrivateKey
	PEM    []byte
	mu     sync.Mutex
	leaves map[string]*tls.Certificate
}

func serial() *big.Int { n, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128)); return n }
func loadCA(dir string) (*CA, error) {
	certPath, keyPath := filepath.Join(dir, "ca.pem"), filepath.Join(dir, "ca.key")
	certPEM, ce := os.ReadFile(certPath)
	keyPEM, ke := os.ReadFile(keyPath)
	if os.IsNotExist(ce) && os.IsNotExist(ke) {
		key, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if e != nil {
			return nil, e
		}
		host, _ := os.Hostname()
		now := time.Now()
		tmpl := &x509.Certificate{SerialNumber: serial(), Subject: pkix.Name{CommonName: "Vibtra Guard local CA (" + host + ")", Organization: []string{"Vibtra Guard"}}, NotBefore: now.Add(-time.Hour), NotAfter: now.AddDate(10, 0, 0), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature, MaxPathLenZero: true}
		der, e := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
		if e != nil {
			return nil, e
		}
		pk, e := x509.MarshalPKCS8PrivateKey(key)
		if e != nil {
			return nil, e
		}
		keyPEM = pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: pk})
		certPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
		if e := atomicWrite(keyPath, keyPEM); e != nil {
			return nil, e
		}
		if e := atomicWrite(certPath, certPEM); e != nil {
			return nil, e
		}
	} else if ce != nil || ke != nil {
		return nil, errors.New("interception CA is incomplete or unreadable; refusing to replace it")
	}
	certBlock, _ := pem.Decode(certPEM)
	keyBlock, _ := pem.Decode(keyPEM)
	if certBlock == nil || keyBlock == nil {
		return nil, errors.New("invalid interception CA PEM")
	}
	cert, e := x509.ParseCertificate(certBlock.Bytes)
	if e != nil {
		return nil, e
	}
	pk, e := x509.ParsePKCS8PrivateKey(keyBlock.Bytes)
	if e != nil {
		return nil, e
	}
	key, ok := pk.(*ecdsa.PrivateKey)
	if !ok || !cert.IsCA || time.Now().Before(cert.NotBefore) || !time.Now().Before(cert.NotAfter) {
		return nil, errors.New("interception CA key or validity is invalid")
	}
	pub, ok := cert.PublicKey.(*ecdsa.PublicKey)
	if !ok || !pub.Equal(&key.PublicKey) {
		return nil, errors.New("interception CA key does not match certificate")
	}
	_ = os.Chmod(keyPath, 0600)
	return &CA{Cert: cert, Key: key, PEM: certPEM, leaves: map[string]*tls.Certificate{}}, nil
}
func (c *CA) facts() map[string]any {
	hash := sha256.Sum256(c.Cert.Raw)
	return map[string]any{"fingerprintSha256": hex.EncodeToString(hash[:]), "subject": c.Cert.Subject.String(), "notAfter": c.Cert.NotAfter.UTC().Format(time.RFC3339)}
}
func (c *CA) spki() string {
	hash := sha256.Sum256(c.Cert.RawSubjectPublicKeyInfo)
	return base64.StdEncoding.EncodeToString(hash[:])
}
func (c *CA) leaf(host string) (*tls.Certificate, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if cert := c.leaves[host]; cert != nil && time.Now().Add(time.Minute).Before(cert.Leaf.NotAfter) {
		return cert, nil
	}
	key, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if e != nil {
		return nil, e
	}
	now := time.Now()
	tmpl := &x509.Certificate{SerialNumber: serial(), Subject: pkix.Name{CommonName: host}, NotBefore: now.Add(-time.Hour), NotAfter: minTime(now.Add(24*time.Hour), c.Cert.NotAfter), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	if ip := net.ParseIP(host); ip != nil {
		tmpl.IPAddresses = []net.IP{ip}
	} else {
		tmpl.DNSNames = []string{host}
	}
	der, e := x509.CreateCertificate(rand.Reader, tmpl, c.Cert, &key.PublicKey, c.Key)
	if e != nil {
		return nil, e
	}
	leaf, e := x509.ParseCertificate(der)
	if e != nil {
		return nil, e
	}
	cert := &tls.Certificate{Certificate: [][]byte{der, c.Cert.Raw}, PrivateKey: key, Leaf: leaf}
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
