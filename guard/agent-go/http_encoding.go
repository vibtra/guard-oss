// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package main

import (
	"bytes"
	"compress/gzip"
	"compress/zlib"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/andybalholm/brotli"
	"github.com/klauspost/compress/zstd"
)

func httpEncoding(h http.Header) string {
	return strings.ToLower(strings.TrimSpace(strings.Join(h.Values("Content-Encoding"), ",")))
}

func encodedHTTP(h http.Header) bool {
	e := httpEncoding(h)
	return e != "" && e != "identity"
}

func decodeHTTPBody(h http.Header, wire []byte) ([]byte, string) {
	if len(wire) > inspectionLimit {
		return nil, "body-too-large"
	}
	encodings := strings.Split(httpEncoding(h), ",")
	if len(encodings) > 3 {
		return nil, "http-encoding-depth"
	}
	data := wire
	for i := len(encodings) - 1; i >= 0; i-- {
		var reader io.Reader
		closeReader := func() {}
		switch strings.TrimSpace(encodings[i]) {
		case "identity":
			continue
		case "gzip":
			r, err := gzip.NewReader(bytes.NewReader(data))
			if err != nil {
				return nil, "invalid-http-compression"
			}
			reader, closeReader = r, func() { _ = r.Close() }
		case "deflate":
			r, err := zlib.NewReader(bytes.NewReader(data))
			if err != nil {
				return nil, "invalid-http-compression"
			}
			reader, closeReader = r, func() { _ = r.Close() }
		case "br":
			reader = brotli.NewReader(bytes.NewReader(data))
		case "zstd":
			r, err := zstd.NewReader(bytes.NewReader(data), zstd.WithDecoderConcurrency(1), zstd.WithDecoderMaxMemory(8<<20), zstd.WithDecoderMaxWindow(inspectionLimit))
			if err != nil {
				return nil, "invalid-http-compression"
			}
			reader, closeReader = r, r.Close
		default:
			return nil, "unsupported-http-encoding"
		}
		decoded, err := io.ReadAll(io.LimitReader(reader, inspectionLimit+1))
		closeReader()
		if len(decoded) > inspectionLimit {
			return nil, "decoded-body-too-large"
		}
		if err != nil {
			if errors.Is(err, zstd.ErrWindowSizeExceeded) || errors.Is(err, zstd.ErrDecoderSizeExceeded) {
				return nil, "http-compression-memory-limit"
			}
			return nil, "invalid-http-compression"
		}
		data = decoded
	}
	return data, ""
}
