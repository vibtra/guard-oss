// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

//go:build darwin

package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"os/exec"
	"path/filepath"
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
	solSocket      = 0xffff
	soNRead        = 0x1020
	csOpsStatus    = 0
	csValid        = 0x1
)

type keychainPinStore struct {
	fallback    filePinStore
	identity    func() (requirement string, unsigned bool, err error)
	mu          sync.Mutex
	resolved    bool
	requirement string
	unsigned    bool
}

func newKeychainPinStore(dir string, identity func() (string, bool, error)) *keychainPinStore {
	return &keychainPinStore{fallback: filePinStore{path: filepath.Join(dir, "policy-pin.json"), kind: pinStoreUnprotected}, identity: identity}
}

func (s *keychainPinStore) app() (string, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.resolved {
		requirement, unsigned, e := s.identity()
		if e != nil {
			return "", false, e
		}
		s.requirement, s.unsigned, s.resolved = requirement, unsigned, true
	}
	return s.requirement, s.unsigned, nil
}

func (s *keychainPinStore) Kind() string {
	if _, unsigned, e := s.app(); e == nil && unsigned {
		return pinStoreUnprotected
	}
	return pinStoreKeychain
}

func (s *keychainPinStore) PinPolicyKey(pin policyPin) error {
	if e := pin.validate(); e != nil {
		return e
	}
	requirement, unsigned, e := s.app()
	switch {
	case e != nil:
		return e
	case unsigned:
		return s.fallback.PinPolicyKey(pin)
	}
	raw, e := json.Marshal(pin)
	if e != nil {
		return e
	}
	_, e = callGuardApp(requirement, "pin-set "+base64.StdEncoding.EncodeToString(raw))
	return e
}

func (s *keychainPinStore) PinnedPolicyKey() (policyPin, error) {
	requirement, unsigned, e := s.app()
	switch {
	case e != nil:
		return policyPin{}, e
	case unsigned:
		return s.fallback.PinnedPolicyKey()
	}
	reply, e := callGuardApp(requirement, "pin-get")
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

func callGuardApp(requirement, request string) (string, error) {
	conn, e := net.DialTimeout("unix", signerSocket(), signerTimeout)
	if e != nil {
		return "", unavailable(e)
	}
	unix, ok := conn.(*net.UnixConn)
	if !ok {
		_ = conn.Close()
		return "", errors.New("the Guard app socket is not a Unix socket")
	}
	token, e := verifyGuardApp(unix, requirement)
	if e != nil {
		_ = conn.Close()
		return "", e
	}
	c, e := greetSigner(conn)
	if e != nil {
		return "", e
	}
	defer c.close()
	if e = stillGuardApp(unix, c, token); e != nil {
		return "", e
	}
	reply, e := c.call(request)
	if moved := stillGuardApp(unix, c, token); moved != nil {
		return "", moved
	}
	return reply, e
}

func notGuardApp(why string) error {
	return errors.New("the process on the Guard app socket is not the Guard app (" + why + ")")
}

func socketOption(conn *net.UnixConn, level, name uintptr, value unsafe.Pointer, size uint32) error {
	raw, e := conn.SyscallConn()
	if e != nil {
		return e
	}
	var failed error
	e = raw.Control(func(fd uintptr) {
		got := size
		if _, _, errno := syscall.Syscall6(syscall.SYS_GETSOCKOPT, fd, level, name, uintptr(value), uintptr(unsafe.Pointer(&got)), 0); errno != 0 {
			failed = errno
		} else if got != size {
			failed = errors.New("short socket option")
		}
	})
	if e == nil {
		e = failed
	}
	return e
}

type auditToken [8]uint32

func peerAuditToken(conn *net.UnixConn) (auditToken, error) {
	var token auditToken
	return token, socketOption(conn, solLocal, localPeerToken, unsafe.Pointer(&token), uint32(unsafe.Sizeof(token)))
}

func stillGuardApp(conn *net.UnixConn, c *signerConn, verified auditToken) error {
	token, e := peerAuditToken(conn)
	var unread int32
	if e == nil {
		e = socketOption(conn, solSocket, soNRead, unsafe.Pointer(&unread), uint32(unsafe.Sizeof(unread)))
	}
	if e != nil || token != verified || unread > 0 || c.r.Buffered() > 0 {
		return notGuardApp("another process used the connection after it was checked")
	}
	return nil
}

func liveCodeStatus(token auditToken) (uint32, error) {
	var flags uint32
	if _, _, errno := syscall.Syscall6(syscall.SYS_CSOPS_AUDITTOKEN, uintptr(token[5]), csOpsStatus, uintptr(unsafe.Pointer(&flags)), unsafe.Sizeof(flags), uintptr(unsafe.Pointer(&token)), 0); errno != 0 {
		return 0, errno
	}
	return flags, nil
}

func verifyGuardApp(conn *net.UnixConn, requirement string) (auditToken, error) {
	token, e := peerAuditToken(conn)
	if e != nil {
		return token, notGuardApp("no audit token: " + e.Error())
	}
	pid := token[5]
	if pid == 0 {
		return token, notGuardApp("no peer process")
	}
	ctx, cancel := context.WithTimeout(context.Background(), signerTimeout)
	defer cancel()
	if out, e := exec.CommandContext(ctx, codesignBinary, "--verify", "-v", "-R", "="+requirement, strconv.FormatUint(uint64(pid), 10)).CombinedOutput(); e != nil {
		return token, notGuardApp("code requirement: " + strings.TrimSpace(string(out)))
	}
	flags, e := liveCodeStatus(token)
	if e != nil {
		return token, notGuardApp("the checked process is no longer the socket's owner: " + e.Error())
	}
	if flags&csValid == 0 {
		return token, notGuardApp("the code signature is no longer valid")
	}
	return token, nil
}
