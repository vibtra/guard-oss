// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package main

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"net/url"
	"os"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/encoding"
	"golang.org/x/text/encoding/charmap"
	xunicode "golang.org/x/text/encoding/unicode"
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
	carrierProto     carrierKind = "protobuf"
)

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
	{"avif", "????ftypavif"},
	{"avif", "????ftypavis"},
	{"bmp", "BM????\x00\x00\x00\x00"},
	{"tiff", "II*\x00"},
	{"tiff", "MM\x00*"},
	{"pdf", "%PDF-"},
	{"ole", "\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"},
	{kindZIP, "PK\x03\x04"},
	{"gzip", "\x1f\x8b"},
	{"bzip2", "BZh?1AY&SY"},
	{"xz", "\xfd7zXZ\x00"},
	{"zstd", "\x28\xb5\x2f\xfd"},
	{"7z", "7z\xbc\xaf\x27\x1c"},
	{"rar", "Rar!\x1a\x07"},
}

var officeMarkers = []struct {
	kind  fileKind
	entry string
}{
	{kindDOCX, "word/document.xml"},
	{kindXLSX, "xl/workbook.xml"},
	{kindPPTX, "ppt/presentation.xml"},
}

var mediaTypeKeys = []string{"mimeType", "mime_type", "media_type"}

var mediaDataKeys = []string{"data", "blob"}

var base64Alphabet = strings.NewReplacer("-", "+", "_", "/")

func sniff(b []byte) fileKind {
	if kind, ok := magicKind(b); ok {
		return kind
	}
	if _, ok := fileText(b); ok {
		return kindText
	}
	return kindUnknown
}

func magicKind(b []byte) (fileKind, bool) {
	for _, m := range fileMagic {
		if hasMagic(b, m.prefix) {
			if m.kind == kindZIP {
				return officeKind(b), true
			}
			return m.kind, true
		}
	}
	return "", false
}

func identified(kind fileKind) bool {
	return kind != kindText && kind != kindUnknown
}

func plainText(b []byte) bool {
	_, magic := magicKind(b)
	return !magic && bytes.IndexByte(b, 0) < 0 && utf8.Valid(b)
}

func fileText(b []byte) (string, bool) {
	if plainText(b) {
		return string(b), true
	}
	if decoder, ok := utf16Layout(b); ok {
		text, err := decoder.Bytes(b)
		return string(text), err == nil && readable(string(text))
	}
	if bytes.IndexByte(b, 0) >= 0 {
		return "", false
	}
	text, err := charmap.Windows1252.NewDecoder().Bytes(b)
	return string(text), err == nil && readable(string(text))
}

func utf16Layout(b []byte) (*encoding.Decoder, bool) {
	switch {
	case bytes.HasPrefix(b, []byte{0xff, 0xfe}):
		return xunicode.UTF16(xunicode.LittleEndian, xunicode.ExpectBOM).NewDecoder(), true
	case bytes.HasPrefix(b, []byte{0xfe, 0xff}):
		return xunicode.UTF16(xunicode.BigEndian, xunicode.ExpectBOM).NewDecoder(), true
	}
	pairs, even, odd := len(b)/2, 0, 0
	for i := 0; i+1 < len(b); i += 2 {
		if b[i] == 0 {
			even++
		}
		if b[i+1] == 0 {
			odd++
		}
	}
	switch {
	case pairs > 0 && odd*2 >= pairs && even*10 <= pairs:
		return xunicode.UTF16(xunicode.LittleEndian, xunicode.IgnoreBOM).NewDecoder(), true
	case pairs > 0 && even*2 >= pairs && odd*10 <= pairs:
		return xunicode.UTF16(xunicode.BigEndian, xunicode.IgnoreBOM).NewDecoder(), true
	}
	return nil, false
}

func readable(text string) bool {
	runes, unreadable := 0, 0
	for _, r := range text {
		runes++
		if r == utf8.RuneError || unicode.IsControl(r) && r != '\t' && r != '\n' && r != '\r' && r != '\f' {
			unreadable++
		}
	}
	return unreadable*20 <= runes
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

func multipartType(ct string) bool {
	return strings.HasPrefix(strings.TrimSpace(strings.ToLower(ct)), "multipart/")
}

func rawFile(ct string) bool {
	return fileInspection && !inspectable(ct) && !multipartType(ct)
}

func (scan *fileScan) extractRaw(body []byte) Extracted {
	spans, _ := scan.read(body, carrierRaw)
	var text strings.Builder
	for _, span := range spans {
		text.WriteString(span.Text)
		text.WriteByte('\n')
	}
	return Extracted{Spans: spans, Text: text.String()}
}

func dataURL(s string) (string, bool) {
	if !fileInspection || len(s) < 5 || !strings.EqualFold(s[:5], "data:") {
		return "", false
	}
	media, payload, ok := strings.Cut(s[5:], ",")
	if !ok || !strings.HasSuffix(strings.ToLower(strings.TrimSpace(media)), ";base64") {
		return "", false
	}
	if unescaped, err := url.PathUnescape(payload); err == nil {
		payload = unescaped
	}
	return payload, true
}

func base64Field(m map[string]any) (string, bool) {
	if !fileInspection {
		return "", false
	}
	if _, ok := m["data"].(string); ok && m["type"] == "base64" {
		return "data", true
	}
	if m["type"] == "text" || !slices.ContainsFunc(mediaTypeKeys, func(key string) bool { _, ok := m[key].(string); return ok }) {
		return "", false
	}
	for _, key := range mediaDataKeys {
		if _, ok := m[key].(string); ok {
			return key, false
		}
	}
	return "", false
}

func decodeBase64(s string) ([]byte, bool) {
	s = strings.Map(func(r rune) rune {
		if strings.ContainsRune(" \t\n\r\f\v", r) {
			return -1
		}
		return r
	}, s)
	b, err := base64.RawStdEncoding.DecodeString(base64Alphabet.Replace(strings.TrimRight(s, "=")))
	return b, err == nil
}
