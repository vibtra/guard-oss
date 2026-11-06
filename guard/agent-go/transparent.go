// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"strconv"
	"strings"
	"time"
)

const maxClientHelloSize = 1 << 20
const maxTLSPlaintextRecordSize = 16 * 1024

func sniFromHandshake(handshake []byte) string {
	if len(handshake) < 4 || handshake[0] != 1 {
		return ""
	}
	messageSize := int(handshake[1])<<16 | int(handshake[2])<<8 | int(handshake[3])
	if messageSize > maxClientHelloSize || len(handshake) < 4+messageSize {
		return ""
	}
	end := 4 + messageSize
	p := 4 + 2 + 32
	take := func(n int) []byte {
		if n < 0 || p+n > end {
			return nil
		}
		out := handshake[p : p+n]
		p += n
		return out
	}
	one := take(1)
	if one == nil {
		return ""
	}
	if take(int(one[0])) == nil {
		return ""
	}
	two := take(2)
	if two == nil {
		return ""
	}
	if take(int(binary.BigEndian.Uint16(two))) == nil {
		return ""
	}
	one = take(1)
	if one == nil {
		return ""
	}
	if take(int(one[0])) == nil {
		return ""
	}
	two = take(2)
	if two == nil {
		return ""
	}
	extEnd := p + int(binary.BigEndian.Uint16(two))
	if extEnd > end {
		return ""
	}
	for p+4 <= extEnd {
		h := take(4)
		if h == nil {
			return ""
		}
		typ, n := binary.BigEndian.Uint16(h[:2]), int(binary.BigEndian.Uint16(h[2:]))
		data := take(n)
		if data == nil || p > extEnd {
			return ""
		}
		if typ == 0 {
			if len(data) < 2 {
				return ""
			}
			limit := 2 + int(binary.BigEndian.Uint16(data))
			if limit > len(data) {
				return ""
			}
			for q := 2; q+3 <= limit; {
				t := data[q]
				size := int(binary.BigEndian.Uint16(data[q+1 : q+3]))
				q += 3
				if q+size > limit {
					return ""
				}
				if t == 0 {
					return strings.ToLower(string(data[q : q+size]))
				}
				q += size
			}
		}
	}
	return ""
}

func sni(records []byte) string {
	handshake := make([]byte, 0, 512)
	for len(records) >= 5 {
		if records[0] != 22 {
			return ""
		}
		size := int(binary.BigEndian.Uint16(records[3:5]))
		if len(records) < 5+size {
			return ""
		}
		handshake = append(handshake, records[5:5+size]...)
		if len(handshake) >= 4 {
			messageSize := int(handshake[1])<<16 | int(handshake[2])<<8 | int(handshake[3])
			if handshake[0] != 1 || messageSize > maxClientHelloSize {
				return ""
			}
			if len(handshake) >= 4+messageSize {
				return sniFromHandshake(handshake)
			}
		}
		records = records[5+size:]
	}
	return ""
}

func readClientHello(reader io.Reader) (wire, handshake []byte, err error) {
	for len(wire) < maxClientHelloSize*6 {
		var header [5]byte
		n, readErr := io.ReadFull(reader, header[:])
		wire = append(wire, header[:n]...)
		if readErr != nil {
			err = readErr
			return wire, handshake, err
		}
		if header[0] != 22 {
			return wire, handshake, errors.New("not a TLS handshake record")
		}
		recordSize := int(binary.BigEndian.Uint16(header[3:5]))
		if recordSize > maxTLSPlaintextRecordSize {
			return wire, handshake, errors.New("oversized TLS record")
		}
		start := len(wire)
		wire = append(wire, make([]byte, recordSize)...)
		n, readErr = io.ReadFull(reader, wire[start:])
		wire = wire[:start+n]
		if readErr != nil {
			return wire, handshake, readErr
		}
		handshake = append(handshake, wire[start:]...)
		if len(handshake) >= 4 {
			if handshake[0] != 1 {
				return wire, handshake, errors.New("first TLS handshake message is not ClientHello")
			}
			messageSize := int(handshake[1])<<16 | int(handshake[2])<<8 | int(handshake[3])
			if messageSize > maxClientHelloSize {
				return wire, handshake, errors.New("ClientHello exceeds inspection limit")
			}
			if len(handshake) >= 4+messageSize {
				return wire, handshake[:4+messageSize], nil
			}
		}
	}
	return wire, handshake, errors.New("ClientHello exceeds capture byte budget")
}

func (p *Proxy) transparent(client net.Conn) {
	defer func() { _ = client.Close() }()
	_ = client.SetReadDeadline(time.Now().Add(5 * time.Second))
	reader := bufio.NewReaderSize(client, 4096)
	line := []byte{}
	for len(line) < 108 {
		v, e := reader.ReadByte()
		if e != nil {
			return
		}
		line = append(line, v)
		if v == '\n' {
			break
		}
	}
	if !bytes.HasSuffix(line, []byte("\r\n")) {
		return
	}
	header := strings.TrimSuffix(string(line), "\r\n")
	if header == "PROXY UNKNOWN vibtra-health" {
		_, _ = io.WriteString(client, "VIBTRA-GUARD OK\r\n")
		return
	}
	fields := strings.Fields(header)
	if len(fields) < 2 || fields[0] != "PROXY" {
		return
	}
	dest := ""
	port := "443"
	switch fields[1] {
	case "UNKNOWN":
	case "TCP4", "TCP6":
		if len(fields) != 6 || net.ParseIP(fields[2]) == nil || net.ParseIP(fields[3]) == nil {
			return
		}
		dport, e := strconv.Atoi(fields[5])
		if e != nil || dport < 1 || dport > 65535 {
			return
		}
		dest = fields[3]
		port = fields[5]
	default:
		return
	}
	attribution, err := p.agent.readRelayAttribution(reader, line)
	if err != nil {
		return
	}
	_ = client.SetReadDeadline(time.Now().Add(10 * time.Second))
	record, _, helloErr := readClientHello(reader)
	name := sni(record)
	if helloErr != nil && incompleteHello(record, helloErr) {
		return
	}
	if helloErr != nil || name == "" {
		if dest == "" {
			reason := "tls-address-without-sni"
			if helloErr != nil {
				reason = "tls-client-hello-unparseable"
			}
			p.agent.recordUninspected()
			p.agent.recordTLSCoverage(net.JoinHostPort("unknown", port), reason, "blocked", attribution)
			_ = client.SetWriteDeadline(time.Now().Add(time.Second))
			_, _ = client.Write([]byte{21, 3, 3, 0, 2, 2, 40})
			return
		}
		replay := &bufferedConn{Conn: client, reader: reader}
		p.tunnelUninspected(replay, net.JoinHostPort(dest, port), record, attribution, helloErr, "tls-address-without-sni")
		return
	}
	_ = client.SetReadDeadline(time.Time{})
	replay := &bufferedConn{Conn: client, reader: bufio.NewReader(io.MultiReader(bytes.NewReader(record), reader))}
	if name != "" && p.agent.shouldIntercept(name) {
		cert, e := p.agent.ca.leaf(name)
		if e == nil {
			p.serveTLS(replay, net.JoinHostPort(name, port), cert, attribution)
			return
		}
		if !passesThrough(e) {
			return
		}
	}
	if dest == "" {
		dest = name
	}
	if dest == "" {
		return
	}
	up, e := net.DialTimeout("tcp", net.JoinHostPort(dest, port), 10*time.Second)
	if e != nil {
		return
	}
	defer func() { _ = up.Close() }()
	p.agent.recordTunnel()
	splice(replay, up)
}
