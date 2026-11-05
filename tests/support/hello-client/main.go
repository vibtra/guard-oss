package main

import (
	"bufio"
	"bytes"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"time"

	utls "github.com/refraction-networking/utls"
)

func dummyPreSharedKey() []byte {
	identity := []byte{0, 7, 0, 1, 'x', 0, 0, 0, 0}
	binders := append([]byte{0, 33, 32}, bytes.Repeat([]byte{7}, 32)...)
	return append(identity, binders...)
}

func unsafeSpec(serverName string, versions []uint16, earlyData bool) *utls.ClientHelloSpec {
	extensions := []utls.TLSExtension{
		&utls.SNIExtension{ServerName: serverName},
		&utls.SupportedCurvesExtension{Curves: []utls.CurveID{utls.X25519, utls.CurveP256}},
		&utls.SupportedPointsExtension{SupportedPoints: []uint8{0}},
		&utls.SignatureAlgorithmsExtension{SupportedSignatureAlgorithms: []utls.SignatureScheme{utls.ECDSAWithP256AndSHA256, utls.PSSWithSHA256, utls.PKCS1WithSHA256}},
		&utls.ALPNExtension{AlpnProtocols: []string{"http/1.1"}},
		&utls.GenericExtension{Id: 22},
		&utls.SupportedVersionsExtension{Versions: versions},
		&utls.KeyShareExtension{KeyShares: []utls.KeyShare{{Group: utls.X25519}}},
		&utls.PSKKeyExchangeModesExtension{Modes: []uint8{utls.PskModeDHE}},
	}
	if earlyData {
		extensions = append(extensions, &utls.GenericExtension{Id: 42})
	}
	extensions = append(extensions, &utls.CookieExtension{Cookie: []byte("c")}, &utls.GenericExtension{Id: 41, Data: dummyPreSharedKey()})
	return &utls.ClientHelloSpec{
		TLSVersMin:         utls.VersionTLS12,
		TLSVersMax:         versions[0],
		CipherSuites:       []uint16{utls.TLS_AES_128_GCM_SHA256, utls.TLS_AES_256_GCM_SHA384, utls.TLS_CHACHA20_POLY1305_SHA256, utls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256, utls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256},
		CompressionMethods: []uint8{0},
		Extensions:         extensions,
	}
}

func tunnel(proxy, authority string) (net.Conn, error) {
	conn, err := net.DialTimeout("tcp", proxy, 10*time.Second)
	if err != nil {
		return nil, err
	}
	if _, err := fmt.Fprintf(conn, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", authority, authority); err != nil {
		conn.Close()
		return nil, err
	}
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, nil)
	if err != nil {
		conn.Close()
		return nil, err
	}
	if response.StatusCode != http.StatusOK {
		conn.Close()
		return nil, fmt.Errorf("CONNECT %s answered %d", authority, response.StatusCode)
	}
	if reader.Buffered() > 0 {
		conn.Close()
		return nil, errors.New("the proxy sent bytes before the TLS handshake")
	}
	return conn, nil
}

func run() error {
	proxy := flag.String("proxy", "", "")
	authority := flag.String("authority", "chatgpt.com:443", "")
	serverName := flag.String("servername", "chatgpt.com", "")
	caFile := flag.String("ca", "", "")
	maxVersion := flag.String("max", "tls13", "")
	earlyData := flag.Bool("early-data", false, "")
	flag.Parse()
	caPEM, err := os.ReadFile(*caFile)
	if err != nil {
		return err
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(caPEM) {
		return errors.New("the CA file holds no certificate")
	}
	raw, err := tunnel(*proxy, *authority)
	if err != nil {
		return err
	}
	defer raw.Close()
	if err := raw.SetDeadline(time.Now().Add(30 * time.Second)); err != nil {
		return err
	}
	versions := []uint16{utls.VersionTLS13, utls.VersionTLS12}
	if *maxVersion == "tls12" {
		versions = []uint16{utls.VersionTLS12}
	}
	conn := utls.UClient(raw, &utls.Config{ServerName: *serverName, RootCAs: roots, NextProtos: []string{"http/1.1"}}, utls.HelloCustom)
	if err := conn.ApplyPreset(unsafeSpec(*serverName, versions, *earlyData)); err != nil {
		return err
	}
	if err := conn.BuildHandshakeState(); err != nil {
		return err
	}
	sent := append([]byte(nil), conn.HandshakeState.Hello.Raw...)
	if err := conn.Handshake(); err != nil {
		return fmt.Errorf("handshake: %w", err)
	}
	if _, err := fmt.Fprintf(conn, "GET / HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n", *serverName); err != nil {
		return err
	}
	response, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		return err
	}
	response.Body.Close()
	return json.NewEncoder(os.Stdout).Encode(map[string]any{"hello": hex.EncodeToString(sent), "status": response.StatusCode, "version": conn.ConnectionState().Version})
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
