// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package main

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/andybalholm/brotli"
)

const connectMaxFrames = 256
const protoMaxFields = 32768
const protoMaxDepth = 32

type protoField struct {
	wire uint64
	data []byte
}
type protoBudget struct{ fields, work, opaque int }

func extractConnect(ct string, headers http.Header, body []byte) (Extracted, map[string]any, error) {
	out := Extracted{Spans: []TextSpan{}}
	meta := map[string]any{"state": "flow-only", "format": "connect", "textParts": 0, "wireBytes": len(body)}
	fail := func(reason string) (Extracted, map[string]any, error) {
		meta["state"] = "flow-only"
		meta["reason"] = reason
		return Extracted{}, meta, errors.New(reason)
	}
	essence, _, err := mime.ParseMediaType(ct)
	if err != nil {
		return fail("invalid-connect-media-type")
	}
	essence = strings.ToLower(essence)
	framed := essence == "application/connect+proto" || essence == "application/connect+json"
	isJSON := essence == "application/connect+json"
	meta["format"] = "connect-protobuf"
	if isJSON {
		meta["format"] = "connect-json"
	}
	if !framed && essence != "application/proto" {
		return fail("unsupported-connect-media-type")
	}
	if len(body) > inspectionLimit {
		return fail("body-too-large")
	}
	httpEncoding := strings.ToLower(strings.TrimSpace(headers.Get("Content-Encoding")))
	if httpEncoding == "" {
		httpEncoding = "identity"
	}
	switch httpEncoding {
	case "identity", "gzip", "br":
		meta["httpEncoding"] = httpEncoding
	default:
		meta["httpEncoding"] = "other"
		return fail("unsupported-http-encoding")
	}
	if httpEncoding != "identity" {
		body, err = decodeConnectBytes(httpEncoding, body, inspectionLimit)
		if err != nil {
			return fail("invalid-http-compression")
		}
		if len(body) > inspectionLimit {
			return fail("decoded-body-too-large")
		}
	}
	encoding := strings.ToLower(strings.TrimSpace(headers.Get("Connect-Content-Encoding")))
	if encoding == "" {
		encoding = "identity"
	}
	switch encoding {
	case "identity", "gzip", "br":
		meta["encoding"] = encoding
	default:
		meta["encoding"] = "other"
		return fail("unsupported-connect-encoding")
	}
	frames := [][]byte{}
	decodedBytes := 0
	if !framed {
		frames = append(frames, body)
		decodedBytes = len(body)
	} else {
		for offset := 0; offset < len(body); {
			if len(frames) >= connectMaxFrames {
				return fail("connect-frame-limit")
			}
			if len(body)-offset < 5 {
				return fail("invalid-connect-frame")
			}
			flags := body[offset]
			if flags & ^byte(1) != 0 {
				return fail("unsupported-connect-flags")
			}
			length := uint64(binary.BigEndian.Uint32(body[offset+1 : offset+5]))
			offset += 5
			if length > uint64(len(body)-offset) {
				return fail("invalid-connect-frame")
			}
			data := body[offset : offset+int(length)]
			offset += int(length)
			if flags&1 != 0 {
				if encoding == "identity" {
					return fail("missing-connect-encoding")
				}
				var r io.Reader
				var gz *gzip.Reader
				if encoding == "gzip" {
					gz, err = gzip.NewReader(bytes.NewReader(data))
					if err != nil {
						return fail("invalid-connect-compression")
					}
					r = gz
				} else {
					r = brotli.NewReader(bytes.NewReader(data))
				}
				data, err = io.ReadAll(io.LimitReader(r, int64(inspectionLimit-decodedBytes)+1))
				if gz != nil {
					_ = gz.Close()
				}
				if err != nil {
					return fail("invalid-connect-compression")
				}
			}
			decodedBytes += len(data)
			if decodedBytes > inspectionLimit {
				return fail("decoded-body-too-large")
			}
			frames = append(frames, data)
		}
	}
	if len(frames) == 0 {
		return fail("empty-connect-body")
	}
	budget := protoBudget{}
	for _, frame := range frames {
		if isJSON {
			if !json.Valid(frame) {
				return fail("invalid-connect-json")
			}
			ex := extract("application/json", frame)
			out.Spans = append(out.Spans, ex.Spans...)
			out.Joined = append(out.Joined, ex.Joined...)
			out.Filenames = append(out.Filenames, ex.Filenames...)
		} else {
			fields, ok := protoFields(frame)
			if !ok {
				return fail("invalid-protobuf-message")
			}
			if reason := walkProto(fields, 0, &budget, &out); reason != "" {
				return fail(reason)
			}
		}
	}
	var text strings.Builder
	for _, span := range out.Spans {
		text.WriteString(span.Text)
		text.WriteByte('\n')
	}
	out.Text = text.String()
	meta["state"] = "inspected"
	meta["frames"] = len(frames)
	meta["decodedBytes"] = decodedBytes
	meta["textParts"] = len(out.Spans)
	if !isJSON {
		meta["protobufFields"] = budget.fields
		meta["opaqueFields"] = budget.opaque
	}
	if budget.opaque > 0 {
		meta["state"] = "partial"
		meta["reason"] = "opaque-protobuf-fields"
	}
	return out, meta, nil
}

func decodeConnectBytes(encoding string, data []byte, limit int) ([]byte, error) {
	var r io.Reader
	if encoding == "gzip" {
		gz, err := gzip.NewReader(bytes.NewReader(data))
		if err != nil {
			return nil, err
		}
		defer func() { _ = gz.Close() }()
		r = gz
	} else {
		r = brotli.NewReader(bytes.NewReader(data))
	}
	return io.ReadAll(io.LimitReader(r, int64(limit)+1))
}

func protoFields(b []byte) ([]protoField, bool) {
	fields := []protoField{}
	for len(b) > 0 {
		if len(fields) >= protoMaxFields {
			return nil, false
		}
		tag, n := binary.Uvarint(b)
		if n <= 0 || tag>>3 == 0 || tag>>3 > 536870911 {
			return nil, false
		}
		b = b[n:]
		wire := tag & 7
		field := protoField{wire: wire}
		switch wire {
		case 0:
			_, n = binary.Uvarint(b)
			if n <= 0 {
				return nil, false
			}
			b = b[n:]
		case 1:
			if len(b) < 8 {
				return nil, false
			}
			b = b[8:]
		case 2:
			length, n := binary.Uvarint(b)
			if n <= 0 {
				return nil, false
			}
			b = b[n:]
			if length > uint64(len(b)) {
				return nil, false
			}
			field.data = b[:int(length)]
			b = b[int(length):]
		case 5:
			if len(b) < 4 {
				return nil, false
			}
			b = b[4:]
		default:
			return nil, false
		}
		fields = append(fields, field)
	}
	return fields, true
}

func protoText(b []byte) bool {
	if !utf8.Valid(b) {
		return false
	}
	for _, r := range string(b) {
		if unicode.IsControl(r) && r != '\n' && r != '\r' && r != '\t' {
			return false
		}
	}
	return true
}
func walkProto(fields []protoField, depth int, budget *protoBudget, out *Extracted) string {
	if depth > protoMaxDepth {
		return "protobuf-depth-limit"
	}
	for _, field := range fields {
		budget.fields++
		if budget.fields > protoMaxFields {
			return "protobuf-field-limit"
		}
		if field.wire != 2 || len(field.data) == 0 {
			continue
		}
		budget.work += len(field.data)
		if budget.work > inspectionLimit*8 {
			return "protobuf-work-limit"
		}
		nested, valid := protoFields(field.data)
		text := protoText(field.data)
		hasDelimited := false
		for _, child := range nested {
			if child.wire == 2 {
				hasDelimited = true
				break
			}
		}
		if text && (!valid || !hasDelimited) {
			out.Spans = append(out.Spans, TextSpan{Text: string(field.data)})
			continue
		}
		if valid && len(nested) > 0 {
			if text {
				budget.opaque++
			}
			if reason := walkProto(nested, depth+1, budget, out); reason != "" {
				return reason
			}
		} else if text {
			out.Spans = append(out.Spans, TextSpan{Text: string(field.data)})
		} else {
			budget.opaque++
		}
	}
	return ""
}
