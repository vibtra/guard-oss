// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package main

import (
	"bytes"
	"io"
	"net/http"
	"strconv"
	"time"
)

const (
	refusalDrainBytes = 64 << 20
	refusalDrainTime  = 5 * time.Second
)

type refusalBuffer struct {
	http.ResponseWriter
	status int
	body   bytes.Buffer
}

func (b *refusalBuffer) WriteHeader(status int) {
	if b.status == 0 {
		b.status = status
	}
}

func (b *refusalBuffer) Write(p []byte) (int, error) {
	if b.status == 0 {
		b.status = http.StatusOK
	}
	return b.body.Write(p)
}

func (a *Agent) blockResponse(w http.ResponseWriter, r *http.Request, b Block) {
	out := &refusalBuffer{ResponseWriter: w}
	a.writeBlockResponse(out, r, b)
	if out.status == 0 {
		out.status = http.StatusOK
	}
	w.Header().Set("Content-Length", strconv.Itoa(out.body.Len()))
	w.WriteHeader(out.status)
	_, _ = w.Write(out.body.Bytes())
	drainRefusedBody(w, r)
}

func drainRefusedBody(w http.ResponseWriter, r *http.Request) {
	if r.ProtoMajor != 1 || r.Body == nil || r.Body == http.NoBody {
		return
	}
	rc := http.NewResponseController(w)
	if rc.Flush() != nil {
		return
	}
	if rc.SetReadDeadline(time.Now().Add(refusalDrainTime)) != nil {
		return
	}
	_, _ = io.CopyN(io.Discard, r.Body, refusalDrainBytes)
	_ = rc.SetReadDeadline(time.Time{})
}
