// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package main

import (
	"io"
	"net/http"
	"strings"

	"golang.org/x/net/http/httpguts"
)

func safeForwardTrailer(name string) bool {
	if !httpguts.ValidHeaderFieldName(name) || !httpguts.ValidTrailerHeader(name) {
		return false
	}
	switch strings.ToLower(name) {
	case "content-type", "content-encoding", "content-length", "host", "transfer-encoding", "trailer":
		return false
	}
	return true
}
func copyForwardTrailers(dst, src http.Header) {
	clear(dst)
	for name, values := range src {
		if safeForwardTrailer(name) {
			dst[name] = append([]string(nil), values...)
		}
	}
}
func prepareForwardTrailers(out, incoming *http.Request) {
	out.Trailer = make(http.Header)
	copyForwardTrailers(out.Trailer, incoming.Trailer)
	if out.Body != nil && out.Body != http.NoBody && incoming.GetBody == nil {
		out.Body = &forwardTrailerBody{ReadCloser: out.Body, complete: func() { copyForwardTrailers(out.Trailer, incoming.Trailer) }}
	}
}

type forwardTrailerBody struct {
	io.ReadCloser
	complete func()
}

func (b *forwardTrailerBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	if err == io.EOF {
		b.complete()
	}
	return n, err
}
