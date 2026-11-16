// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package main

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/x509roots/fallback/bundle"
)

var (
	builtInRegistry      string
	builtInRegistryRoots string
)

const (
	reasonRegistryOriginMissing = "registry-origin-missing"
	reasonRegistryOriginOther   = "registry-origin-mismatch"
)

type builtIn struct {
	signed bool
	origin string
	roots  string
}

type registryRule struct {
	fixed  bool
	origin string
	err    error
	client *http.Client
}

var registryHTTP = registryClient(nil)

var (
	registryRuleMu     sync.Mutex
	registryRuleCached *registryRule
	refusedOriginOnce  sync.Once
)

func registryRules() registryRule {
	registryRuleMu.Lock()
	defer registryRuleMu.Unlock()
	if registryRuleCached != nil {
		return *registryRuleCached
	}
	built, e := builtRegistry()
	rule := ruleFor(built, e)
	if e == nil {
		registryRuleCached = &rule
	}
	return rule
}

func registryClient(roots *x509.CertPool) *http.Client {
	transport := &http.Transport{Proxy: nil}
	if roots != nil {
		transport.TLSClientConfig = &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}
	}
	return &http.Client{Timeout: 30 * time.Second, Transport: transport, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
}

func ruleFor(built builtIn, identityErr error) registryRule {
	if identityErr != nil {
		return registryRule{fixed: true, err: fmt.Errorf("could not tell whether this agent is team-signed, so it calls no registry: %w", identityErr)}
	}
	if !built.signed {
		return registryRule{client: registryHTTP}
	}
	origin, e := registryOrigin(built.origin)
	if e != nil {
		return registryRule{fixed: true, err: fmt.Errorf("this team-signed Guard has no valid built-in registry address (%q), so it calls no registry; rebuild it with GUARD_REGISTRY_URL set: %w", built.origin, e)}
	}
	roots, e := registryRoots(built.roots)
	if e != nil {
		return registryRule{fixed: true, origin: origin, err: fmt.Errorf("this team-signed Guard has an invalid built-in registry root, so it calls no registry; rebuild it with GUARD_REGISTRY_ROOTS_FILE unset or set to a PEM file: %w", e)}
	}
	return registryRule{fixed: true, origin: origin, client: registryClient(roots)}
}

func registryRoots(extra string) (*x509.CertPool, error) {
	pool := x509.NewCertPool()
	for root := range bundle.Roots() {
		c, e := x509.ParseCertificate(root.Certificate)
		if e != nil {
			return nil, e
		}
		pool.AddCertWithConstraint(c, root.Constraint)
	}
	if extra == "" {
		return pool, nil
	}
	raw, e := base64.StdEncoding.DecodeString(extra)
	if e != nil {
		return nil, errors.New("the extra registry roots are not base64")
	}
	if !pool.AppendCertsFromPEM(raw) {
		return nil, errors.New("the extra registry roots hold no PEM certificate")
	}
	return pool, nil
}

func registryOrigin(raw string) (string, error) {
	if e := validServer(raw); e != nil {
		return "", e
	}
	u, _ := url.Parse(raw)
	if strings.Trim(u.Path, "/") != "" || u.RawPath != "" {
		return "", errors.New("a registry address is an origin, with no path")
	}
	host := strings.ToLower(u.Hostname())
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if port := u.Port(); port != "" && (u.Scheme != "https" || port != "443") && (u.Scheme != "http" || port != "80") {
		host += ":" + port
	}
	return u.Scheme + "://" + host, nil
}

func (r registryRule) allows(base string) error {
	switch {
	case !r.fixed:
		return nil
	case r.err != nil:
		return r.err
	}
	if got, e := registryOrigin(base); e != nil || got != r.origin {
		return fmt.Errorf("this Guard talks only to its built-in registry %s, not %q; enrol with %s", r.origin, base, r.origin)
	}
	return nil
}

func (r registryRule) check(base string) error {
	e := r.allows(base)
	if e != nil {
		refusedOriginOnce.Do(func() {
			reason := reasonRegistryOriginOther
			if r.err != nil {
				reason = reasonRegistryOriginMissing
			}
			slog.Error("registry call refused; this Guard syncs with no server until it is enrolled with its built-in registry", "reason", reason, "built_in", r.origin, "host", hostOf(base))
		})
	}
	return e
}

func hostOf(base string) string {
	if u, e := url.Parse(base); e == nil {
		return u.Hostname()
	}
	return ""
}

func (r registryRule) enrolServer(asked string) string {
	if asked == "" && r.fixed {
		return r.origin
	}
	return asked
}

func (r registryRule) status(d *Device) map[string]any {
	out := map[string]any{"fixed": r.fixed}
	if r.origin != "" {
		out["origin"] = r.origin
	}
	switch {
	case r.err != nil:
		out["reason"], out["error"] = reasonRegistryOriginMissing, r.err.Error()
	case d != nil && r.allows(d.Server.BaseURL) != nil:
		out["reason"] = reasonRegistryOriginOther
	}
	return out
}

func printRegistry(dir string, out io.Writer) error {
	var d *Device
	var enrolled Device
	if readJSON(filepath.Join(dir, "device.json"), &enrolled) == nil {
		d = &enrolled
	}
	raw, e := json.Marshal(registryRules().status(d))
	if e == nil {
		_, e = fmt.Fprintln(out, string(raw))
	}
	return e
}
