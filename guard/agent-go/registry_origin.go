// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
)

var builtInRegistry string

const (
	reasonRegistryOriginMissing = "registry-origin-missing"
	reasonRegistryOriginOther   = "registry-origin-mismatch"
)

type registryRule struct {
	fixed  bool
	origin string
	err    error
}

var registryRules = sync.OnceValue(func() registryRule {
	signed, origin, e := builtRegistry()
	return ruleFor(signed, origin, e)
})

func ruleFor(signed bool, built string, identityErr error) registryRule {
	if identityErr != nil {
		return registryRule{fixed: true, err: fmt.Errorf("could not tell whether this agent is team-signed, so it calls no registry: %w", identityErr)}
	}
	if !signed {
		return registryRule{}
	}
	origin, e := registryOrigin(built)
	if e != nil {
		return registryRule{fixed: true, err: fmt.Errorf("this team-signed Guard has no valid built-in registry address (%q), so it calls no registry; rebuild it with GUARD_REGISTRY_URL set: %w", built, e)}
	}
	return registryRule{fixed: true, origin: origin}
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
	if port := u.Port(); port != "" && !(u.Scheme == "https" && port == "443") && !(u.Scheme == "http" && port == "80") {
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
