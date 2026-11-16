// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

//go:build darwin && !guard_test

package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"unsafe"
)

const (
	csOpsIdentity = 11
	csOpsTeamID   = 14
)

var (
	teamIdentifier = regexp.MustCompile(`^[A-Z0-9]{10}$`)
	agentSigningID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.-]{0,199}\.agent$`)
)

func newPolicyKeyStore(dir string) policyKeyStore {
	return newKeychainPinStore(dir, guardAppRequirement)
}

func ownCodeSignature(op uintptr, out unsafe.Pointer, size uintptr) error {
	if _, _, errno := syscall.Syscall6(syscall.SYS_CSOPS, uintptr(os.Getpid()), op, uintptr(out), size, 0, 0); errno != 0 {
		return errno
	}
	return nil
}

func ownCodeString(op uintptr) (string, error) {
	var buf [520]byte
	if e := ownCodeSignature(op, unsafe.Pointer(&buf[0]), uintptr(len(buf))); e != nil {
		return "", e
	}
	end := binary.BigEndian.Uint32(buf[4:8])
	if end <= 8 || end > uint32(len(buf)) {
		return "", errors.New("malformed code signing string")
	}
	return string(bytes.TrimRight(buf[8:end], "\x00")), nil
}

func ownTeamIdentity() (team, app string, signed bool, err error) {
	var flags uint32
	if e := ownCodeSignature(csOpsStatus, unsafe.Pointer(&flags), unsafe.Sizeof(flags)); e != nil {
		return "", "", false, fmt.Errorf("could not read this agent's own code signature: %w", e)
	}
	if flags&csValid == 0 {
		return "", "", false, nil
	}
	identifier, e := ownCodeString(csOpsIdentity)
	if e == nil {
		team, e = ownCodeString(csOpsTeamID)
	}
	switch {
	case errors.Is(e, syscall.ENOENT), errors.Is(e, syscall.ERANGE):
		return "", "", false, nil
	case e != nil:
		return "", "", false, fmt.Errorf("could not read this agent's own code signature: %w", e)
	case !teamIdentifier.MatchString(team) || !agentSigningID.MatchString(identifier):
		return "", "", false, nil
	}
	return team, strings.TrimSuffix(identifier, ".agent"), true, nil
}

type teamIdentity struct {
	team, app string
	signed    bool
}

var (
	selfMu     sync.Mutex
	selfCached *teamIdentity
)

func selfIdentity() (teamIdentity, error) {
	selfMu.Lock()
	defer selfMu.Unlock()
	if selfCached != nil {
		return *selfCached, nil
	}
	team, app, signed, e := ownTeamIdentity()
	if e != nil {
		return teamIdentity{}, e
	}
	selfCached = &teamIdentity{team: team, app: app, signed: signed}
	return *selfCached, nil
}

func guardAppRequirement() (string, bool, error) {
	id, e := selfIdentity()
	if e != nil || !id.signed {
		return "", e == nil, e
	}
	return `anchor apple generic and certificate leaf[subject.OU] = "` + id.team + `" and identifier "` + id.app + `"`, false, nil
}

func builtRegistry() (builtIn, error) {
	id, e := selfIdentity()
	return builtIn{signed: id.signed, origin: builtInRegistry, roots: builtInRegistryRoots}, e
}
