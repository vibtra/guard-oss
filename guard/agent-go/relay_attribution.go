// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package main

import (
	"bufio"
	"bytes"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

const relayAttributionPrefix = "VIBTRA_APP_V1"
const relayAttributionLineLimit = 2048
const relayAttributionReplayLimit = 4096
const relayAttributionWindow = 60 * time.Second
const relayAttributionReplayTTL = 120 * time.Second

type processAttribution struct {
	Status         string `json:"status"`
	Source         string `json:"source,omitempty"`
	SigningID      string `json:"signingId,omitempty"`
	TeamID         string `json:"teamId,omitempty"`
	Reason         string `json:"reason,omitempty"`
	SteeringHost   string `json:"steeringHost,omitempty"`
	steeringSigned bool
}

func (p processAttribution) verifiedApp() bool {
	return p.Status == "verified" && p.SigningID != ""
}

func (p processAttribution) signedSteeringHost() string {
	if !p.steeringSigned {
		return ""
	}
	return p.SteeringHost
}

type relayAttributionKey struct{}
type relayPublicPin struct {
	Version   int    `json:"version"`
	KeyID     string `json:"keyId"`
	PublicKey string `json:"publicKey"`
}
type relayIdentityPayload struct {
	Version      int    `json:"version"`
	KeyID        string `json:"keyId"`
	IssuedAt     int64  `json:"issuedAt"`
	Nonce        string `json:"nonce"`
	SigningID    string `json:"signingId"`
	TeamID       string `json:"teamId"`
	SteeringHost string `json:"steeringHost,omitempty"`
}
type relayReplayCache struct {
	mu   sync.Mutex
	seen map[string]time.Time
}

func unattributed(reason string) processAttribution {
	return processAttribution{Status: "unattributed", Reason: reason}
}
func (c *relayReplayCache) accept(key string, now time.Time) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	for nonce, expires := range c.seen {
		if !expires.After(now) {
			delete(c.seen, nonce)
		}
	}
	if _, exists := c.seen[key]; exists {
		return "replayed"
	}
	if len(c.seen) >= relayAttributionReplayLimit {
		return "replay-capacity"
	}
	if c.seen == nil {
		c.seen = make(map[string]time.Time)
	}
	c.seen[key] = now.Add(relayAttributionReplayTTL)
	return ""
}
func relayIdentifier(s string, max int) bool {
	if s == "" || len(s) > max {
		return false
	}
	for _, r := range s {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '.' || r == '-' || r == '_' {
			continue
		}
		return false
	}
	return true
}

func relaySteeringHost(s string) bool {
	if s == "" {
		return true
	}
	if len(s) > 253 {
		return false
	}
	labels := strings.Split(s, ".")
	for _, label := range labels {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, r := range label {
			if (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '-' {
				return false
			}
		}
	}
	return strings.Trim(labels[len(labels)-1], "0123456789") != ""
}
func relayTeam(s string) bool {
	if len(s) != 10 {
		return false
	}
	for _, r := range s {
		if r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' {
			continue
		}
		return false
	}
	return true
}
func strictRelayJSON(raw []byte, out any) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(out); err != nil {
		return err
	}
	if err := dec.Decode(new(any)); !errors.Is(err, io.EOF) {
		return errors.New("invalid relay JSON")
	}
	return nil
}
func readRelayPublicPin(dir string) (relayPublicPin, *ecdsa.PublicKey, error) {
	var pin relayPublicPin
	f, err := os.OpenFile(filepath.Join(dir, "relay-attribution.json"), os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return pin, nil, err
	}
	defer func() { _ = f.Close() }()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > relayAttributionLineLimit {
		return pin, nil, errors.New("invalid relay public pin")
	}
	raw, err := io.ReadAll(io.LimitReader(f, relayAttributionLineLimit+1))
	if err != nil || len(raw) > relayAttributionLineLimit {
		return pin, nil, errors.New("invalid relay public pin")
	}
	if err = strictRelayJSON(raw, &pin); err != nil || pin.Version != 1 {
		return pin, nil, errors.New("invalid relay public pin")
	}
	pub, err := base64.RawURLEncoding.Strict().DecodeString(pin.PublicKey)
	if err != nil || len(pub) != 65 {
		return pin, nil, errors.New("invalid relay public pin")
	}
	digest := sha256.Sum256(pub)
	if pin.KeyID != hex.EncodeToString(digest[:]) {
		return pin, nil, errors.New("invalid relay public pin")
	}
	if _, err = ecdh.P256().NewPublicKey(pub); err != nil {
		return pin, nil, errors.New("invalid relay public pin")
	}
	key, err := ecdsa.ParseUncompressedPublicKey(elliptic.P256(), pub)
	if err != nil {
		return pin, nil, errors.New("invalid relay public pin")
	}
	return pin, key, nil
}
func (a *Agent) verifyRelayAttribution(proxyLine, line []byte, now time.Time) processAttribution {
	if len(line) > relayAttributionLineLimit || !bytes.HasSuffix(line, []byte("\r\n")) {
		return unattributed("malformed")
	}
	parts := strings.Split(strings.TrimSuffix(string(line), "\r\n"), " ")
	if len(parts) != 3 || parts[0] != relayAttributionPrefix {
		return unattributed("malformed")
	}
	payload, err := base64.RawURLEncoding.Strict().DecodeString(parts[1])
	if err != nil {
		return unattributed("malformed")
	}
	sig, err := base64.RawURLEncoding.Strict().DecodeString(parts[2])
	if err != nil || len(sig) != 64 {
		return unattributed("malformed")
	}
	var identity relayIdentityPayload
	if strictRelayJSON(payload, &identity) != nil || identity.Version != 1 {
		return unattributed("malformed")
	}
	if !relaySteeringHost(identity.SteeringHost) {
		identity.SteeringHost = ""
	}
	validApp := relayIdentifier(identity.SigningID, 255) && relayTeam(identity.TeamID)
	steeringOnly := identity.SigningID == "" && identity.TeamID == "" && identity.SteeringHost != ""
	if !validApp && !steeringOnly {
		return unattributed("malformed")
	}
	nonce, err := base64.RawURLEncoding.Strict().DecodeString(identity.Nonce)
	if err != nil || len(nonce) != 16 {
		return unattributed("malformed")
	}
	if identity.IssuedAt < now.Add(-relayAttributionWindow).Unix() || identity.IssuedAt > now.Add(relayAttributionWindow).Unix() {
		return unattributed("expired")
	}
	pin, pub, err := readRelayPublicPin(a.dir)
	if err != nil {
		return unattributed("pin-unavailable")
	}
	if identity.KeyID != pin.KeyID {
		return unattributed("key-mismatch")
	}
	h := sha256.New()
	h.Write([]byte(relayAttributionPrefix + "\n"))
	h.Write(proxyLine)
	h.Write(payload)
	if !ecdsa.Verify(pub, h.Sum(nil), new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])) {
		return unattributed("invalid-signature")
	}
	if reason := a.relayReplay.accept(pin.KeyID+":"+identity.Nonce, now); reason != "" {
		return unattributed(reason)
	}
	if !validApp {
		return processAttribution{Status: "unattributed", Source: "network-extension", Reason: "no-app-identity", SteeringHost: identity.SteeringHost, steeringSigned: true}
	}
	return processAttribution{Status: "verified", Source: "network-extension", SigningID: identity.SigningID, TeamID: identity.TeamID, SteeringHost: identity.SteeringHost, steeringSigned: identity.SteeringHost != ""}
}

func (a *Agent) readRelayAttribution(reader *bufio.Reader, proxyLine []byte) (processAttribution, error) {
	first, err := reader.Peek(1)
	if err != nil {
		return unattributed("not-provided"), err
	}
	if first[0] != 'V' {
		return unattributed("not-provided"), nil
	}
	line := make([]byte, 0, 512)
	for len(line) < relayAttributionLineLimit {
		b, err := reader.ReadByte()
		if err != nil {
			return unattributed("malformed"), err
		}
		line = append(line, b)
		if b == '\n' {
			return a.verifyRelayAttribution(proxyLine, line, time.Now()), nil
		}
	}
	return unattributed("malformed"), errors.New("relay metadata exceeds limit")
}
func attributedEventApp(app *EventApp, attribution processAttribution) *EventApp {
	out := EventApp{}
	if app != nil {
		out = *app
	}
	if attribution.verifiedApp() {
		out = EventApp{BundleID: attribution.SigningID}
	}
	out.attribution = &attribution
	return &out
}
