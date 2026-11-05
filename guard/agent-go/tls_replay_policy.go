// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package main

import (
	"bytes"
	"errors"
	"io"
	"net"
	"strconv"
	"time"

	utls "github.com/refraction-networking/utls"
)

type upstreamReplayError struct{ err error }

func (e *upstreamReplayError) Error() string { return "upstream replay failed: " + e.err.Error() }
func (e *upstreamReplayError) Unwrap() error { return e.err }

func replayParameterRejection(err error) bool {
	var remote *net.OpError
	if !errors.As(err, &remote) || remote.Op != "remote error" || remote.Err == nil {
		return false
	}
	switch remote.Err.Error() {
	case utls.AlertError(40).Error(), utls.AlertError(47).Error(), utls.AlertError(70).Error():
		return true
	}
	return false
}

func incompleteHello(wire []byte, err error) bool {
	if len(wire) == 0 {
		return true
	}
	var ne net.Error
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.As(err, &ne) && ne.Timeout() {
		_, _, framingErr := readClientHello(bytes.NewReader(wire))
		return framingErr != nil
	}
	return false
}

func validateReplayHello(wire []byte, authority string) error {
	spec, _, _, err := captureClientHello(&capturedHelloReader{Reader: bytes.NewReader(wire)})
	if err != nil {
		return err
	}
	_, hello, err := readClientHello(bytes.NewReader(wire))
	if err != nil {
		return err
	}
	modern := len(hello) >= 6 && uint16(hello[4])<<8|uint16(hello[5]) >= utls.VersionTLS12
	for _, ext := range spec.Extensions {
		if v, ok := ext.(*utls.SupportedVersionsExtension); ok {
			modern = false
			for _, version := range v.Versions {
				if version == utls.VersionTLS12 || version == utls.VersionTLS13 {
					modern = true
				}
			}
		}
	}
	if !modern {
		return errors.New("client requires unsupported TLS version")
	}
	host, _, _ := net.SplitHostPort(authority)
	conn := utls.UClient(nil, &utls.Config{ServerName: host, MinVersion: utls.VersionTLS12}, utls.HelloCustom)
	if err = conn.ApplyPreset(&spec); err != nil {
		return err
	}
	return conn.BuildHandshakeState()
}

func (a *Agent) recordTLSCoverage(authority, reason, action string, identity processAttribution, app ...*EventApp) {
	b, c, _ := a.snapshot()
	if b == nil {
		return
	}
	host, portText, _ := net.SplitHostPort(authority)
	port, _ := strconv.Atoi(portText)
	var requestApp *EventApp
	if len(app) > 0 {
		requestApp = app[0]
	}
	ev := Event{EventID: eventID(), OccurredAt: nowISO(), Kind: "flow", Action: action, Host: host, Port: port, BundleVersion: b.BundleVersion, Reason: reason, App: attributedEventApp(requestApp, identity)}
	if ev.App.BundleID == "" && ev.App.Name == "" && ev.App.CLI == "" && ev.App.PID == 0 {
		ev.App = nil
	}
	if c != nil {
		signingID := ""
		if identity.verifiedApp() {
			signingID = identity.SigningID
		}
		service := c.Service(host, signingID, "")
		if steered := identity.signedSteeringHost(); service == nil && reason == "tls-address-without-sni" && steered != "" {
			service = c.Service(steered, signingID, "")
		}
		if service != nil {
			ev.ServiceID = service.ServiceID
		}
	}
	_ = a.appendEvent(ev)
	diagHost, redacted := tlsDiagnosticHost(c, authority)
	a.tlsDiagnostics.add(tlsDiagnostic{ProcessAttribution: identity, Host: diagHost, HostnameRedacted: redacted, Outcome: "failure", Class: reason}, time.Now())
}
