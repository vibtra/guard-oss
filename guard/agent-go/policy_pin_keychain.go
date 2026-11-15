// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

//go:build darwin && !guard_test

package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"unsafe"
)

const (
	codesignBinary = "/usr/bin/codesign"
	solLocal       = 0
	localPeerToken = 6
	csOpsStatus    = 0
	csValid        = 0x1
)

var (
	teamIdentifier = regexp.MustCompile(`^[A-Z0-9]{10}$`)
	agentSigningID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.-]{0,199}\.agent$`)
)

type keychainPinStore struct {
	fallback    filePinStore
	once        sync.Once
	requirement string
	unsigned    bool
	err         error
}

func newPolicyKeyStore(dir string) policyKeyStore {
	return &keychainPinStore{fallback: filePinStore{path: filepath.Join(dir, "policy-pin.json"), kind: pinStoreUnprotected}}
}

func (s *keychainPinStore) resolve() {
	s.once.Do(func() { s.requirement, s.unsigned, s.err = guardAppRequirement() })
}

func (s *keychainPinStore) Kind() string {
	s.resolve()
	if s.unsigned {
		return pinStoreUnprotected
	}
	return pinStoreKeychain
}

func (s *keychainPinStore) PinPolicyKey(pin policyPin) error {
	if e := pin.validate(); e != nil {
		return e
	}
	if s.Kind() == pinStoreUnprotected {
		return s.fallback.PinPolicyKey(pin)
	}
	encoded, e := encodePin(pin)
	if e != nil {
		return e
	}
	_, e = s.call("pin-set " + encoded)
	return e
}

func (s *keychainPinStore) PinnedPolicyKey() (policyPin, error) {
	if s.Kind() == pinStoreUnprotected {
		return s.fallback.PinnedPolicyKey()
	}
	reply, e := s.call("pin-get")
	var answer signerAnswer
	if errors.As(e, &answer) && string(answer) == "err no-pin" {
		return policyPin{}, errNoPin
	}
	if e != nil {
		return policyPin{}, e
	}
	raw, e := base64.StdEncoding.DecodeString(reply)
	if e != nil {
		return policyPin{}, e
	}
	return decodePin(raw)
}

func (s *keychainPinStore) ClearPin() error {
	if s.Kind() == pinStoreUnprotected {
		return s.fallback.ClearPin()
	}
	_, e := s.call("pin-clear")
	return e
}

func (s *keychainPinStore) call(request string) (string, error) {
	if s.err != nil {
		return "", s.err
	}
	conn, e := net.DialTimeout("unix", signerSocket(), signerTimeout)
	if e != nil {
		return "", unavailable(e)
	}
	unix, ok := conn.(*net.UnixConn)
	if !ok {
		_ = conn.Close()
		return "", errors.New("the Guard app socket is not a Unix socket")
	}
	if e = verifyGuardApp(unix, s.requirement); e != nil {
		_ = conn.Close()
		return "", e
	}
	c, e := greetSigner(conn)
	if e != nil {
		return "", e
	}
	defer c.close()
	return c.call(request)
}

func guardAppRequirement() (string, bool, error) {
	self, e := os.Executable()
	if e != nil {
		return "", false, e
	}
	ctx, cancel := context.WithTimeout(context.Background(), signerTimeout)
	defer cancel()
	var out bytes.Buffer
	cmd := exec.CommandContext(ctx, codesignBinary, "-d", "--verbose=1", self)
	cmd.Stdout, cmd.Stderr = &out, &out
	if e = cmd.Run(); e != nil {
		return "", false, fmt.Errorf("could not read this agent's own signature: %w", e)
	}
	identifier, team := "", ""
	for _, line := range strings.Split(out.String(), "\n") {
		if v, ok := strings.CutPrefix(line, "Identifier="); ok {
			identifier = v
		}
		if v, ok := strings.CutPrefix(line, "TeamIdentifier="); ok {
			team = v
		}
	}
	if !teamIdentifier.MatchString(team) || !agentSigningID.MatchString(identifier) {
		return "", true, nil
	}
	app := strings.TrimSuffix(identifier, ".agent")
	return `anchor apple generic and certificate leaf[subject.OU] = "` + team + `" and identifier "` + app + `"`, false, nil
}

type auditToken [8]uint32

func peerAuditToken(conn *net.UnixConn) (auditToken, error) {
	var token auditToken
	raw, e := conn.SyscallConn()
	if e != nil {
		return token, e
	}
	var failed error
	e = raw.Control(func(fd uintptr) {
		size := uint32(unsafe.Sizeof(token))
		if _, _, errno := syscall.Syscall6(syscall.SYS_GETSOCKOPT, fd, solLocal, localPeerToken, uintptr(unsafe.Pointer(&token)), uintptr(unsafe.Pointer(&size)), 0); errno != 0 {
			failed = errno
		} else if size != uint32(unsafe.Sizeof(token)) {
			failed = errors.New("short audit token")
		}
	})
	if e == nil {
		e = failed
	}
	return token, e
}

func liveCodeStatus(token auditToken) (uint32, error) {
	var flags uint32
	if _, _, errno := syscall.Syscall6(syscall.SYS_CSOPS_AUDITTOKEN, uintptr(token[5]), csOpsStatus, uintptr(unsafe.Pointer(&flags)), unsafe.Sizeof(flags), uintptr(unsafe.Pointer(&token)), 0); errno != 0 {
		return 0, errno
	}
	return flags, nil
}

func verifyGuardApp(conn *net.UnixConn, requirement string) error {
	refused := func(why string) error {
		return errors.New("the process on the Guard app socket is not the Guard app (" + why + ")")
	}
	token, e := peerAuditToken(conn)
	if e != nil {
		return refused("no audit token: " + e.Error())
	}
	pid := token[5]
	if pid == 0 {
		return refused("no peer process")
	}
	ctx, cancel := context.WithTimeout(context.Background(), signerTimeout)
	defer cancel()
	if out, e := exec.CommandContext(ctx, codesignBinary, "--verify", "-v", "-R", "="+requirement, strconv.FormatUint(uint64(pid), 10)).CombinedOutput(); e != nil {
		return refused("code requirement: " + strings.TrimSpace(string(out)))
	}
	flags, e := liveCodeStatus(token)
	if e != nil {
		return refused("the checked process is no longer the socket's owner: " + e.Error())
	}
	if flags&csValid == 0 {
		return refused("the code signature is no longer valid")
	}
	return nil
}
