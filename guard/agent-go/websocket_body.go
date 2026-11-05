// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package main

import (
	"bytes"
	"compress/flate"
	"encoding/binary"
	"errors"
	"io"
	"strconv"
	"strings"
	"unicode/utf8"
)

const webSocketMaxFrames = 256

type webSocketError struct {
	Code     uint16
	Reason   string
	Metadata map[string]any
}

func (e *webSocketError) Error() string { return e.Reason }
func wsError(code uint16, reason string) *webSocketError {
	return &webSocketError{Code: code, Reason: reason, Metadata: map[string]any{"state": "flow-only", "reason": reason, "transport": "websocket-message"}}
}

type webSocketMessage struct {
	Wire, Payload []byte
	Opcode        byte
	Frames        int
	Compressed    bool
}

func (m *webSocketMessage) metadata() map[string]any {
	opcode := "binary"
	if m.Opcode == 1 {
		opcode = "text"
	}
	compression := "identity"
	if m.Compressed {
		compression = "permessage-deflate"
	}
	return map[string]any{"transport": "websocket-message", "opcode": opcode, "wireFrames": m.Frames,
		"wireBytes": len(m.Wire), "bodyBytes": len(m.Payload), "compression": compression, "validUTF8": utf8.Valid(m.Payload)}
}

func (m *webSocketMessage) extract() (Extracted, map[string]any, error) {
	meta := m.metadata()
	ct := "text/plain"
	_, jsonErr := decodeJSON(m.Payload)
	meta["validJSON"] = jsonErr == nil
	if jsonErr == nil {
		ct = "application/json"
	}
	if m.Opcode == 2 && jsonErr != nil {
		err := wsError(1003, "unsupported-websocket-binary")
		for k, v := range meta {
			err.Metadata[k] = v
		}
		return Extracted{}, err.Metadata, err
	}
	if !utf8.Valid(m.Payload) {
		err := wsError(1007, "invalid-websocket-utf8")
		for k, v := range meta {
			err.Metadata[k] = v
		}
		return Extracted{}, err.Metadata, err
	}
	ex := extract(ct, m.Payload)
	meta["state"] = "inspected"
	meta["format"] = "text"
	if jsonErr == nil {
		meta["format"] = "json"
	}
	meta["textParts"] = len(ex.Spans)
	return ex, meta, nil
}

type webSocketInspector struct {
	deflate, noContextTakeover bool
	dictionary                 []byte
}

func newWebSocketInspector(extensions string) (*webSocketInspector, error) {
	s := &webSocketInspector{}
	if strings.TrimSpace(extensions) == "" {
		return s, nil
	}
	offers := strings.Split(extensions, ",")
	if len(offers) != 1 {
		return nil, wsError(1002, "unsupported-websocket-extension")
	}
	parts := strings.Split(offers[0], ";")
	if strings.TrimSpace(strings.ToLower(parts[0])) != "permessage-deflate" {
		return nil, wsError(1002, "unsupported-websocket-extension")
	}
	s.deflate = true
	seen := map[string]bool{}
	for _, part := range parts[1:] {
		pair := strings.SplitN(strings.TrimSpace(part), "=", 2)
		name := strings.ToLower(strings.TrimSpace(pair[0]))
		if seen[name] {
			return nil, wsError(1002, "invalid-websocket-extension")
		}
		seen[name] = true
		switch name {
		case "client_no_context_takeover", "server_no_context_takeover":
			if len(pair) != 1 {
				return nil, wsError(1002, "invalid-websocket-extension")
			}
			if name == "client_no_context_takeover" {
				s.noContextTakeover = true
			}
		case "client_max_window_bits", "server_max_window_bits":
			if len(pair) != 2 {
				return nil, wsError(1002, "invalid-websocket-extension")
			}
			value := strings.TrimSpace(pair[1])
			if len(value) >= 2 && value[0] == '"' && value[len(value)-1] == '"' {
				value = value[1 : len(value)-1]
			}
			n, err := strconv.Atoi(value)
			if err != nil || n < 8 || n > 15 || strconv.Itoa(n) != value {
				return nil, wsError(1002, "invalid-websocket-extension")
			}
		default:
			return nil, wsError(1002, "unsupported-websocket-extension")
		}
	}
	return s, nil
}

type webSocketFrame struct {
	wire, payload     []byte
	opcode            byte
	final, compressed bool
}

func readWebSocketFrame(r io.Reader) (webSocketFrame, error) {
	f := webSocketFrame{}
	header := make([]byte, 2)
	n, err := io.ReadFull(r, header)
	if err != nil {
		if err == io.EOF && n == 0 {
			return f, io.EOF
		}
		return f, wsError(1002, "truncated-websocket-frame")
	}
	f.final = header[0]&0x80 != 0
	f.compressed = header[0]&0x40 != 0
	f.opcode = header[0] & 0x0f
	if header[0]&0x30 != 0 || header[1]&0x80 == 0 {
		return f, wsError(1002, "invalid-websocket-frame")
	}
	switch f.opcode {
	case 0, 1, 2, 8, 9, 10:
	default:
		return f, wsError(1002, "invalid-websocket-opcode")
	}
	size := uint64(header[1] & 0x7f)
	if f.opcode >= 8 && (!f.final || f.compressed || size > 125) {
		return f, wsError(1002, "invalid-websocket-control")
	}
	switch size {
	case 126:
		more := make([]byte, 2)
		if _, err = io.ReadFull(r, more); err != nil {
			return f, wsError(1002, "truncated-websocket-frame")
		}
		header = append(header, more...)
		size = uint64(binary.BigEndian.Uint16(more))
		if size < 126 {
			return f, wsError(1002, "noncanonical-websocket-length")
		}
	case 127:
		more := make([]byte, 8)
		if _, err = io.ReadFull(r, more); err != nil {
			return f, wsError(1002, "truncated-websocket-frame")
		}
		header = append(header, more...)
		size = binary.BigEndian.Uint64(more)
		if size>>63 != 0 || size < 65536 {
			return f, wsError(1002, "noncanonical-websocket-length")
		}
	}
	if size > inspectionLimit {
		return f, wsError(1009, "websocket-message-too-large")
	}
	mask := make([]byte, 4)
	if _, err = io.ReadFull(r, mask); err != nil {
		return f, wsError(1002, "truncated-websocket-frame")
	}
	header = append(header, mask...)
	f.wire = make([]byte, len(header)+int(size))
	copy(f.wire, header)
	if _, err = io.ReadFull(r, f.wire[len(header):]); err != nil {
		return f, wsError(1002, "truncated-websocket-frame")
	}
	f.payload = make([]byte, int(size))
	for i, b := range f.wire[len(header):] {
		f.payload[i] = b ^ mask[i%4]
	}
	return f, nil
}

func (s *webSocketInspector) readMessage(r io.Reader, onControl func([]byte) error) (*webSocketMessage, error) {
	m := &webSocketMessage{}
	started := false
	controls := 0
	for {
		f, err := readWebSocketFrame(r)
		if err != nil {
			if errors.Is(err, io.EOF) && started {
				err = wsError(1002, "truncated-websocket-message")
			}
			return nil, err
		}
		if f.opcode >= 8 {
			if f.opcode == 8 {
				if len(f.payload) == 1 {
					return nil, wsError(1002, "invalid-websocket-close")
				}
				if len(f.payload) >= 2 {
					code := binary.BigEndian.Uint16(f.payload)
					if !validWebSocketCloseCode(code) {
						return nil, wsError(1002, "invalid-websocket-close")
					}
					if !utf8.Valid(f.payload[2:]) {
						return nil, wsError(1007, "invalid-websocket-close-utf8")
					}
				}
			}
			if onControl != nil {
				if err = onControl(f.wire); err != nil {
					return nil, err
				}
			}
			if !started {
				if idle, ok := r.(interface{ websocketIdle() }); ok {
					idle.websocketIdle()
				}
			}
			if f.opcode == 8 {
				return nil, io.EOF
			}
			if started {
				controls++
				if controls > webSocketMaxFrames {
					return nil, wsError(1009, "websocket-frame-limit")
				}
			}
			continue
		}
		if f.opcode == 0 {
			if !started || f.compressed {
				return nil, wsError(1002, "invalid-websocket-continuation")
			}
		} else {
			if started {
				return nil, wsError(1002, "interleaved-websocket-message")
			}
			if f.compressed && !s.deflate {
				return nil, wsError(1002, "unnegotiated-websocket-compression")
			}
			started = true
			m.Opcode = f.opcode
			m.Compressed = f.compressed
		}
		m.Frames++
		if m.Frames > webSocketMaxFrames {
			return nil, wsError(1009, "websocket-frame-limit")
		}
		if len(f.payload) > inspectionLimit-len(m.Payload) {
			return nil, wsError(1009, "websocket-message-too-large")
		}
		m.Wire = append(m.Wire, f.wire...)
		m.Payload = append(m.Payload, f.payload...)
		if !f.final {
			continue
		}
		if m.Compressed {
			decoded, err := s.inflate(m.Payload)
			if err != nil {
				return nil, err
			}
			m.Payload = decoded
		}
		if m.Opcode == 1 && !utf8.Valid(m.Payload) {
			err := wsError(1007, "invalid-websocket-utf8")
			for k, v := range m.metadata() {
				err.Metadata[k] = v
			}
			return nil, err
		}
		return m, nil
	}
}
func validWebSocketCloseCode(code uint16) bool {
	return code >= 3000 && code <= 4999 || code >= 1000 && code <= 1014 && code != 1004 && code != 1005 && code != 1006
}
func (s *webSocketInspector) inflate(payload []byte) ([]byte, error) {
	encoded := make([]byte, 0, len(payload)+9)
	encoded = append(encoded, payload...)
	encoded = append(encoded, 0, 0, 255, 255, 1, 0, 0, 255, 255)
	source := bytes.NewReader(encoded)
	reader := flate.NewReaderDict(source, s.dictionary)
	decoded, err := io.ReadAll(io.LimitReader(reader, inspectionLimit+1))
	_ = reader.Close()
	if len(decoded) > inspectionLimit {
		return nil, wsError(1009, "websocket-decoded-message-too-large")
	}
	if err != nil || source.Len() != 0 {
		return nil, wsError(1002, "invalid-websocket-compression")
	}
	if s.noContextTakeover {
		s.dictionary = nil
	} else {
		if len(decoded) >= 32768 {
			s.dictionary = append(s.dictionary[:0], decoded[len(decoded)-32768:]...)
		} else {
			keep := 32768 - len(decoded)
			if len(s.dictionary) > keep {
				s.dictionary = s.dictionary[len(s.dictionary)-keep:]
			}
			s.dictionary = append(s.dictionary, decoded...)
		}
	}
	return decoded, nil
}

var _ error = (*webSocketError)(nil)
