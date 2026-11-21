// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package main

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"os"
	"slices"
	"strings"
	"unicode/utf8"
)

var fileInspection = os.Getenv("VIBTRA_GUARD_FILE_INSPECTION") == "1"

type fileKind string

const (
	kindText    fileKind = "text"
	kindUnknown fileKind = "unknown"
	kindZIP     fileKind = "zip"
	kindDOCX    fileKind = "docx"
	kindXLSX    fileKind = "xlsx"
	kindPPTX    fileKind = "pptx"
)

type carrierKind string

const (
	carrierRaw       carrierKind = "raw"
	carrierMultipart carrierKind = "multipart"
	carrierBase64    carrierKind = "json-base64"
)

type foundFile struct {
	Kind    fileKind
	Carrier carrierKind
	Data    []byte
	Index   int
}

var fileMagic = []struct {
	kind   fileKind
	prefix string
}{
	{"png", "\x89PNG\r\n\x1a\n"},
	{"jpeg", "\xff\xd8\xff"},
	{"gif", "GIF87a"},
	{"gif", "GIF89a"},
	{"webp", "RIFF????WEBP"},
	{"heic", "????ftypheic"},
	{"heic", "????ftypheix"},
	{"heic", "????ftypmif1"},
	{"tiff", "II*\x00"},
	{"tiff", "MM\x00*"},
	{"pdf", "%PDF-"},
	{"ole", "\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"},
	{kindZIP, "PK\x03\x04"},
}

var officeMarkers = []struct {
	kind  fileKind
	entry string
}{
	{kindDOCX, "word/document.xml"},
	{kindXLSX, "xl/workbook.xml"},
	{kindPPTX, "ppt/presentation.xml"},
}

var base64Encodings = []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding}

func sniff(b []byte) fileKind {
	for _, m := range fileMagic {
		if hasMagic(b, m.prefix) {
			if m.kind == kindZIP {
				return officeKind(b)
			}
			return m.kind
		}
	}
	if utf8.Valid(b) {
		return kindText
	}
	return kindUnknown
}

func hasMagic(b []byte, prefix string) bool {
	if len(b) < len(prefix) {
		return false
	}
	for i := range len(prefix) {
		if prefix[i] != '?' && b[i] != prefix[i] {
			return false
		}
	}
	return true
}

func officeKind(b []byte) fileKind {
	z, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		return kindZIP
	}
	for _, m := range officeMarkers {
		if slices.ContainsFunc(z.File, func(f *zip.File) bool { return f.Name == m.entry }) {
			return m.kind
		}
	}
	return kindZIP
}

func rawFile(ct string, body []byte) bool {
	if !fileInspection {
		return false
	}
	switch sniff(body) {
	case kindUnknown:
		return false
	case kindText:
		form := strings.HasPrefix(strings.ToLower(strings.TrimSpace(ct)), "application/x-www-form-urlencoded")
		return !inspectable(ct) || form && !formShaped(body)
	}
	return true
}

func extractRaw(body []byte) (Extracted, []fileFact) {
	spans, fact := foundFile{Kind: sniff(body), Carrier: carrierRaw, Data: body}.read()
	var text strings.Builder
	for _, span := range spans {
		text.WriteString(span.Text)
		text.WriteByte('\n')
	}
	return Extracted{Spans: spans, Text: text.String()}, []fileFact{fact}
}

func formShaped(body []byte) bool {
	if bytes.ContainsAny(body, "\r\n\t") {
		return false
	}
	for _, pair := range bytes.Split(body, []byte("&")) {
		if len(pair) > 0 && !bytes.Contains(pair, []byte("=")) {
			return false
		}
	}
	return true
}

func dataURL(s string) ([]byte, bool) {
	rest, ok := strings.CutPrefix(s, "data:")
	if !fileInspection || !ok {
		return nil, false
	}
	media, payload, ok := strings.Cut(rest, ",")
	if !ok || !strings.HasSuffix(strings.ToLower(media), ";base64") {
		return nil, false
	}
	return decodeBase64(payload)
}

func base64Block(m map[string]any) ([]byte, bool) {
	data, ok := m["data"].(string)
	if !fileInspection || !ok || m["type"] != "base64" {
		return nil, false
	}
	return decodeBase64(data)
}

func decodeBase64(s string) ([]byte, bool) {
	for _, enc := range base64Encodings {
		if b, err := enc.DecodeString(s); err == nil {
			return b, true
		}
	}
	return nil, false
}
