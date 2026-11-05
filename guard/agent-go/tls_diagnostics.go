// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package main

import (
	"crypto/tls"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/vibtra/guard/guard/agent-go/policy"
)

const tlsDiagnosticLimit = 128
const tlsDiagnosticRetention = 30 * time.Minute
const tlsDiagnosticDedupe = 10 * time.Second

type tlsDiagnostic struct {
	ProcessAttribution processAttribution `json:"processAttribution"`
	FirstAt            time.Time          `json:"firstAt"`
	LastAt             time.Time          `json:"lastAt"`
	Count              uint64             `json:"count"`
	Host               string             `json:"host"`
	HostnameRedacted   bool               `json:"hostnameRedacted"`
	Outcome            string             `json:"outcome"`
	Class              string             `json:"class"`
	Alert              string             `json:"alert,omitempty"`
	TLSVersion         string             `json:"tlsVersion,omitempty"`
	ALPN               string             `json:"alpn,omitempty"`
	OfferedALPN        []string           `json:"offeredAlpn"`
	OfferedTLS         []string           `json:"offeredTls"`
	ECDSAP256Offered   bool               `json:"ecdsaP256Offered"`
}
type tlsDiagnosticRing struct {
	mu   sync.Mutex
	rows []tlsDiagnostic
}

func (r *tlsDiagnosticRing) prune(now time.Time) {
	n := 0
	for _, row := range r.rows {
		if now.Sub(row.LastAt) <= tlsDiagnosticRetention {
			r.rows[n] = row
			n++
		}
	}
	clear(r.rows[n:])
	r.rows = r.rows[:n]
}
func (r *tlsDiagnosticRing) add(row tlsDiagnostic, now time.Time) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.prune(now)
	row.OfferedALPN = append([]string{}, row.OfferedALPN...)
	row.OfferedTLS = append([]string{}, row.OfferedTLS...)
	row.FirstAt = now.UTC()
	row.LastAt = now.UTC()
	row.Count = 1
	for i, prev := range r.rows {
		if now.Sub(prev.LastAt) < tlsDiagnosticDedupe && prev.Host == row.Host && prev.HostnameRedacted == row.HostnameRedacted && prev.Outcome == row.Outcome && prev.Class == row.Class && prev.Alert == row.Alert && prev.TLSVersion == row.TLSVersion && prev.ALPN == row.ALPN && strings.Join(prev.OfferedALPN, ",") == strings.Join(row.OfferedALPN, ",") && strings.Join(prev.OfferedTLS, ",") == strings.Join(row.OfferedTLS, ",") && prev.ECDSAP256Offered == row.ECDSAP256Offered && prev.ProcessAttribution == row.ProcessAttribution {
			row.FirstAt = prev.FirstAt
			row.Count = prev.Count + 1
			copy(r.rows[i:], r.rows[i+1:])
			r.rows = r.rows[:len(r.rows)-1]
			break
		}
	}
	r.rows = append([]tlsDiagnostic{row}, r.rows...)
	if len(r.rows) > tlsDiagnosticLimit {
		r.rows = r.rows[:tlsDiagnosticLimit]
	}
}
func (r *tlsDiagnosticRing) snapshot(now time.Time) []tlsDiagnostic {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.prune(now)
	out := append([]tlsDiagnostic{}, r.rows...)
	for i := range out {
		out[i].OfferedALPN = append([]string{}, out[i].OfferedALPN...)
		out[i].OfferedTLS = append([]string{}, out[i].OfferedTLS...)
	}
	return out
}
func tlsVersionLabel(version uint16) string {
	switch version {
	case tls.VersionTLS12:
		return "TLS1.2"
	case tls.VersionTLS13:
		return "TLS1.3"
	case 0:
		return ""
	default:
		return "other"
	}
}
func tlsSafeALPN(protocols []string) []string {
	found := map[string]bool{}
	for _, p := range protocols {
		if p != "h2" && p != "http/1.1" {
			p = "other"
		}
		found[p] = true
	}
	out := []string{}
	for _, p := range []string{"h2", "http/1.1", "other"} {
		if found[p] {
			out = append(out, p)
		}
	}
	return out
}
func tlsSafeVersions(versions []uint16) []string {
	found := map[string]bool{}
	for _, v := range versions {
		s := tlsVersionLabel(v)
		if s == "" {
			s = "other"
		}
		found[s] = true
	}
	out := []string{}
	for _, v := range []string{"TLS1.3", "TLS1.2", "other"} {
		if found[v] {
			out = append(out, v)
		}
	}
	return out
}

func tlsFailureClass(err error) (string, string) {
	if err == nil {
		return "handshake-complete", ""
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return "timeout", ""
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return "peer-closed", ""
	}
	var op *net.OpError
	isOperation := errors.As(err, &op)
	remote := isOperation && op.Op == "remote error"
	local := isOperation && op.Op == "local error"
	leaf := err
	for i := 0; i < 8; i++ {
		next := errors.Unwrap(leaf)
		if next == nil {
			break
		}
		leaf = next
	}
	alerts := map[string]string{
		"tls: bad record MAC":  "bad_record_mac",
		"tls: bad certificate": "bad_certificate", "tls: unsupported certificate": "unsupported_certificate",
		"tls: revoked certificate": "certificate_revoked", "tls: expired certificate": "certificate_expired",
		"tls: unknown certificate": "certificate_unknown", "tls: unknown certificate authority": "unknown_ca",
		"tls: handshake failure": "handshake_failure", "tls: protocol version not supported": "protocol_version",
		"tls: no application protocol": "no_application_protocol", "tls: access denied": "access_denied",
		"tls: insufficient security level": "insufficient_security", "tls: internal error": "internal_error",
		"tls: bad certificate status response": "bad_certificate_status_response", "tls: bad certificate hash value": "bad_certificate_hash_value",
	}
	if label := alerts[leaf.Error()]; label != "" {
		if remote {
			return "remote-alert", label
		}
		if local {
			return "local-alert", label
		}
		return "tls-alert", label
	}
	if strings.HasPrefix(leaf.Error(), "tls: client requested unsupported application protocols") {
		return "alpn-incompatible", "no_application_protocol"
	}
	if leaf.Error() == "tls: peer doesn't support any of the certificate's signature algorithms" {
		return "signature-algorithms-incompatible", ""
	}
	if remote {
		return "remote-alert", "other"
	}
	if local {
		return "local-alert", "other"
	}
	var record tls.RecordHeaderError
	if errors.As(err, &record) {
		return "invalid-tls-record", ""
	}
	return "handshake-error", ""
}

func tlsDiagnosticHost(c *policy.Catalogue, authority string) (string, bool) {
	host, _, err := net.SplitHostPort(authority)
	if err != nil {
		host = authority
	}
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	if c == nil {
		return "other", true
	}
	best := ""
	for _, service := range c.Services {
		if service.Enabled != nil && !*service.Enabled {
			continue
		}
		for _, pattern := range service.Domains {
			if len(pattern) > 253 || strings.ContainsAny(pattern, "/\\\r\n\x00") {
				continue
			}
			if pattern == host && !strings.Contains(pattern, "*") {
				return pattern, false
			}
			if policy.HostMatch(pattern, host) && len(pattern) > len(best) {
				best = pattern
			}
		}
	}
	if best != "" {
		return best, true
	}
	return "other", true
}
func (a *Agent) recordTLSHandshake(authority string, state tls.ConnectionState, offeredALPN []string, offeredTLS []uint16, ecdsaP256 bool, err error, attribution ...processAttribution) {
	identity := unattributed("not-provided")
	if len(attribution) > 0 {
		identity = attribution[0]
	}
	_, c, _ := a.snapshot()
	host, redacted := tlsDiagnosticHost(c, authority)
	class, alert := tlsFailureClass(err)
	outcome := "success"
	if err != nil {
		outcome = "failure"
	}
	alpn := ""
	if state.NegotiatedProtocol != "" {
		alpn = tlsSafeALPN([]string{state.NegotiatedProtocol})[0]
	}
	a.tlsDiagnostics.add(tlsDiagnostic{ProcessAttribution: identity, Host: host, HostnameRedacted: redacted, Outcome: outcome, Class: class, Alert: alert, TLSVersion: tlsVersionLabel(state.Version), ALPN: alpn, OfferedALPN: tlsSafeALPN(offeredALPN), OfferedTLS: tlsSafeVersions(offeredTLS), ECDSAP256Offered: ecdsaP256}, time.Now())
}
func (a *Agent) localTLSDiagnostics(w http.ResponseWriter, r *http.Request) {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	ip := net.ParseIP(host)
	if err != nil || ip == nil || !ip.IsLoopback() || r.Header.Get("Origin") != "" || r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		http.Error(w, "local diagnostics only", http.StatusForbidden)
		return
	}
	jsonResponse(w, http.StatusOK, map[string]any{"stage": "downstream-tls-handshake", "localOnly": true, "processAttribution": "per-entry", "limit": tlsDiagnosticLimit, "retentionSeconds": int(tlsDiagnosticRetention.Seconds()), "dedupeSeconds": int(tlsDiagnosticDedupe.Seconds()), "entries": a.tlsDiagnostics.snapshot(time.Now())})
}
