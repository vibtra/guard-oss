// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

//go:build darwin

package main

import (
	"os"
	"syscall"
)

func exitIfStdioIsSocket() {
	for fd := 0; fd <= 2; fd++ {
		if couldBeSignerConnection(fd) {
			os.Exit(2)
		}
	}
}

func couldBeSignerConnection(fd int) bool {
	var st syscall.Stat_t
	if syscall.Fstat(fd, &st) != nil || st.Mode&syscall.S_IFMT != syscall.S_IFSOCK {
		return false
	}
	if self, _ := syscall.Getsockname(fd); !isUnix(self) {
		return true
	}
	peer, e := syscall.Getpeername(fd)
	named, ok := peer.(*syscall.SockaddrUnix)
	return e == nil && ok && named.Name != ""
}

func isUnix(sa syscall.Sockaddr) bool {
	_, ok := sa.(*syscall.SockaddrUnix)
	return ok
}
