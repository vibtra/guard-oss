// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
)

func canonical(v any) ([]byte, error) {
	var b bytes.Buffer
	var write func(any) error
	quote := func(s string) {
		b.WriteByte('"')
		for _, r := range s {
			switch r {
			case '"', '\\':
				b.WriteByte('\\')
				b.WriteRune(r)
			case '\b':
				b.WriteString(`\b`)
			case '\f':
				b.WriteString(`\f`)
			case '\n':
				b.WriteString(`\n`)
			case '\r':
				b.WriteString(`\r`)
			case '\t':
				b.WriteString(`\t`)
			default:
				if r < 32 {
					fmt.Fprintf(&b, `\u%04x`, r)
				} else {
					b.WriteRune(r)
				}
			}
		}
		b.WriteByte('"')
	}
	write = func(v any) error {
		switch x := v.(type) {
		case nil:
			b.WriteString("null")
		case bool:
			if x {
				b.WriteString("true")
			} else {
				b.WriteString("false")
			}
		case string:
			quote(x)
		case json.Number:
			n, e := strconv.ParseInt(string(x), 10, 64)
			if e != nil || n > 9007199254740991 || n < -9007199254740991 {
				return errors.New("document contains a non-safe integer")
			}
			b.WriteString(strconv.FormatInt(n, 10))
		case []any:
			b.WriteByte('[')
			for i, v := range x {
				if i > 0 {
					b.WriteByte(',')
				}
				if e := write(v); e != nil {
					return e
				}
			}
			b.WriteByte(']')
		case map[string]any:
			keys := []string{}
			for k := range x {
				keys = append(keys, k)
			}
			sort.Slice(keys, func(i, j int) bool {
				a, c := utf16.Encode([]rune(keys[i])), utf16.Encode([]rune(keys[j]))
				for k := 0; k < min(len(a), len(c)); k++ {
					if a[k] != c[k] {
						return a[k] < c[k]
					}
				}
				return len(a) < len(c)
			})
			b.WriteByte('{')
			for i, k := range keys {
				if i > 0 {
					b.WriteByte(',')
				}
				quote(k)
				b.WriteByte(':')
				if e := write(x[k]); e != nil {
					return e
				}
			}
			b.WriteByte('}')
		default:
			return errors.New("unsupported canonical value")
		}
		return nil
	}
	err := write(v)
	return b.Bytes(), err
}
func verifyDocument(raw []byte, kind string, d Device) ([]byte, string, float64, error) {
	fail := func() ([]byte, string, float64, error) {
		return nil, "", 0, errors.New("signed " + kind + " did not verify against the enrolled key")
	}
	v, e := decodeJSON(raw)
	if e != nil {
		return fail()
	}
	env, ok := v.(map[string]any)
	if !ok {
		return fail()
	}
	doc, ok := env[kind].(map[string]any)
	if !ok {
		return fail()
	}
	sig, ok := env["signature"].(map[string]any)
	if !ok || sig["alg"] != "ES256" || sig["keyId"] != d.Signing.KeyID || d.Signing.Alg != "ES256" {
		return fail()
	}
	jws, ok := sig["jws"].(string)
	if !ok {
		return fail()
	}
	parts := strings.Split(jws, ".")
	if len(parts) != 3 {
		return fail()
	}
	decode := func(s string) []byte { v, _ := base64.RawURLEncoding.DecodeString(s); return v }
	var header map[string]any
	var payload map[string]any
	if json.Unmarshal(decode(parts[0]), &header) != nil || json.Unmarshal(decode(parts[1]), &payload) != nil || header["alg"] != "ES256" || header["kid"] != d.Signing.KeyID || header["typ"] != "vibtra-guard+jwt" || payload["kind"] != kind || payload["keyId"] != d.Signing.KeyID || payload["orgId"] != d.OrgID {
		return fail()
	}
	if kind == "bundle" && (payload["deviceId"] != d.DeviceID || doc["deviceId"] != d.DeviceID || doc["orgId"] != d.OrgID) {
		return fail()
	}
	canonicalBytes, e := canonical(doc)
	if e != nil {
		return fail()
	}
	digest := sha256.Sum256(canonicalBytes)
	digestHex := hex.EncodeToString(digest[:])
	if payload["digest"] != digestHex {
		return fail()
	}
	version := doc["version"]
	if kind == "bundle" {
		version = doc["bundleVersion"]
	}
	v1, _ := json.Marshal(version)
	v2, _ := json.Marshal(payload["version"])
	if !bytes.Equal(v1, v2) {
		return fail()
	}
	block, _ := pem.Decode([]byte(d.Signing.PublicKeyPEM))
	if block == nil {
		return fail()
	}
	key, e := x509.ParsePKIXPublicKey(block.Bytes)
	if e != nil {
		return fail()
	}
	pub, ok := key.(*ecdsa.PublicKey)
	if !ok || pub.Curve != elliptic.P256() {
		return fail()
	}
	signature := decode(parts[2])
	hash := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if len(signature) != 64 || !ecdsa.Verify(pub, hash[:], new(big.Int).SetBytes(signature[:32]), new(big.Int).SetBytes(signature[32:])) {
		return fail()
	}
	issuedAt, _ := payload["iat"].(float64)
	return canonicalBytes, digestHex, issuedAt, nil
}
