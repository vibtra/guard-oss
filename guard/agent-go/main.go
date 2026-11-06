// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"syscall"
	"time"

	"github.com/vibtra/guard/guard/agent-go/engine"
	"github.com/vibtra/guard/guard/agent-go/engine/conformance"
	engineeval "github.com/vibtra/guard/guard/agent-go/engine/eval"
	"github.com/vibtra/guard/guard/agent-go/engine/rules"
	"github.com/vibtra/guard/guard/agent-go/policy"
)

func dataDir() string {
	if v := os.Getenv("VIBTRA_GUARD_DIR"); v != "" {
		return v
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library", "Application Support", "Vibtra Guard")
}
func parseArgs(argv []string) ([]string, map[string][]string, error) {
	pos := []string{}
	flags := map[string][]string{}
	bools := map[string]bool{"json": true, "spki": true, "help": true, "version": true, "parity": true}
	for i := 0; i < len(argv); i++ {
		s := argv[i]
		if !strings.HasPrefix(s, "--") {
			pos = append(pos, s)
			continue
		}
		kv := strings.SplitN(strings.TrimPrefix(s, "--"), "=", 2)
		name := kv[0]
		value := "true"
		if len(kv) == 2 {
			value = kv[1]
		} else if !bools[name] {
			if name == "transparent" && (i+1 == len(argv) || strings.HasPrefix(argv[i+1], "--")) {
				value = "127.0.0.1:9472"
			} else {
				if i+1 == len(argv) {
					return nil, nil, errors.New("missing value for --" + name)
				}
				i++
				value = argv[i]
			}
		}
		flags[name] = append(flags[name], value)
	}
	return pos, flags, nil
}
func listenLoopback(addr string) (net.Listener, error) {
	host, _, e := net.SplitHostPort(addr)
	if e != nil {
		return nil, e
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return nil, errors.New("agent listeners must bind an explicit loopback IP")
	}
	return net.Listen("tcp", addr)
}
func runAgent(ctx context.Context, eng engine.Engine, a *Agent, proxyAddr, localAddr, transparentAddr string, maps map[string]*url.URL, upstreamCA string, every int) error {
	p, e := newProxy(eng, a, maps, upstreamCA)
	if e != nil {
		return e
	}
	pl, e := listenLoopback(proxyAddr)
	if e != nil {
		return e
	}
	defer func() { _ = pl.Close() }()
	ll, e := listenLoopback(localAddr)
	if e != nil {
		return e
	}
	defer func() { _ = ll.Close() }()
	var tl net.Listener
	if transparentAddr != "" {
		tl, e = listenLoopback(transparentAddr)
		if e != nil {
			return e
		}
		defer func() { _ = tl.Close() }()
	}
	a.mu.Lock()
	a.proxyAddr = pl.Addr().String()
	a.localAddr = ll.Addr().String()
	a.listening = true
	a.mu.Unlock()
	defer func() { a.mu.Lock(); a.listening = false; a.mu.Unlock() }()
	quiet := log.New(io.Discard, "", 0)
	proxyServer := &http.Server{Handler: p, ReadHeaderTimeout: 15 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 64 * 1024, ErrorLog: quiet}
	localServer := &http.Server{Handler: http.HandlerFunc(a.local), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16 * 1024, ErrorLog: quiet}
	defer func() { _ = proxyServer.Close() }()
	defer func() { _ = localServer.Close() }()
	a.ca.ensure()
	if line := interceptionLine(a.ca.interception()); line != "" {
		fmt.Fprintln(os.Stderr, "vibtra-guard:", line)
	}
	go func() { _ = proxyServer.Serve(pl) }()
	go func() { _ = localServer.Serve(ll) }()
	if tl != nil {
		go func() {
			slots := make(chan struct{}, 256)
			for {
				conn, e := tl.Accept()
				if e != nil {
					return
				}
				select {
				case slots <- struct{}{}:
					go func() { defer func() { <-slots }(); p.transparent(conn) }()
				default:
					_ = conn.Close()
				}
			}
		}()
	}
	go a.syncLoop(ctx, every)
	fmt.Fprintf(os.Stderr, "vibtra-guard (Go/client-hello replay): proxy http://%s · local pages http://%s\n", a.proxyAddr, a.localAddr)
	<-ctx.Done()
	return nil
}
func detectScan(path string) error {
	var list []struct {
		Name     string          `json:"name"`
		Detector policy.Detector `json:"detector"`
	}
	if e := readJSON(path, &list); e != nil {
		return e
	}
	detectors := make([]policy.Detector, len(list))
	for i, d := range list {
		detectors[i] = d.Detector
	}
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), 16*1024*1024)
	w := bufio.NewWriter(os.Stdout)
	defer func() { _ = w.Flush() }()
	for scanner.Scan() {
		if strings.TrimSpace(scanner.Text()) == "" {
			continue
		}
		var item struct {
			ID          string   `json:"id"`
			ContentType *string  `json:"contentType"`
			Body        string   `json:"body"`
			Filenames   []string `json:"filenames"`
		}
		if e := json.Unmarshal(scanner.Bytes(), &item); e != nil {
			return e
		}
		ct := ""
		if item.ContentType != nil {
			ct = *item.ContentType
		}
		ok := inspectable(ct)
		ex := Extracted{}
		if ok {
			ex = extract(ct, []byte(item.Body))
		}
		ex.Filenames = append(ex.Filenames, item.Filenames...)
		hits := []any{}
		for i, m := range rules.Detect(ex, detectors) {
			if m != nil {
				hits = append(hits, map[string]any{"name": list[i].Name, "kind": m.Kind, "count": m.Count, "details": m.Details})
			}
		}
		if e := json.NewEncoder(w).Encode(map[string]any{"id": item.ID, "inspectable": ok, "hits": hits}); e != nil {
			return e
		}
	}
	return scanner.Err()
}
func engineCommand(eng engine.Engine, args []string, vectorsDir, parityFlag string) error {
	if len(args) != 1 || args[0] != "check" && args[0] != "bench" {
		return errors.New("use engine check [--parity [--vectors DIR]], engine bench [--vectors DIR] or engine eval --dataset DIR [--engine NAME] [--split all|train|validation|test] [--out FILE]")
	}
	parity := false
	switch parityFlag {
	case "", "false":
	case "true":
		parity = true
	default:
		return errors.New("--parity takes no value, or true or false")
	}
	if args[0] == "check" && vectorsDir != "" && !parity {
		return errors.New("--vectors DIR is only used with --parity")
	}
	var opts []conformance.Option
	if parity || args[0] == "bench" {
		v, e := conformance.LoadVectors(vectorsDir, func(ct string, body []byte) engine.Content {
			if !inspectable(ct) {
				return engine.Content{}
			}
			return extract(ct, body)
		})
		if e != nil {
			return e
		}
		opts = append(opts, conformance.WithVectors(v))
	}
	fmt.Printf("engine: %s\n", eng.Name())
	if args[0] == "bench" {
		fmt.Println("one op is one pass over every case in the set")
		failed := false
		for _, r := range conformance.Bench(eng, opts...) {
			if len(r.Errors) > 0 {
				failed = true
				fmt.Printf("FAIL %s: %d of %d cases returned an error, first %s: %s\n", r.Set, len(r.Errors), r.Cases, r.Errors[0].Case, r.Errors[0].Problem)
				continue
			}
			fmt.Printf("%-12s %4d cases %12d ns/op %10d ns/case %8d allocs/op\n", r.Set, r.Cases, r.NsPerOp, r.NsPerCase, r.AllocsPerOp)
		}
		if failed {
			return errors.New("engine bench failed")
		}
		return nil
	}
	report := conformance.Check(eng, opts...)
	for _, r := range report.Results {
		status := "ok  "
		if len(r.Failures) > 0 {
			status = "FAIL"
		}
		fmt.Printf("%s %s (%d cases)\n", status, r.Check, r.Cases)
		for i, f := range r.Failures {
			if i == 10 {
				fmt.Printf("     … and %d more\n", len(r.Failures)-i)
				break
			}
			fmt.Printf("     %s: %s\n", f.Case, f.Problem)
		}
	}
	if !report.OK() {
		return errors.New("engine check failed")
	}
	return nil
}
func engineEval(eng engine.Engine, dataset, name, split, out string) error {
	if dataset == "" {
		return errors.New("engine eval needs --dataset DIR")
	}
	if name != eng.Name() {
		return fmt.Errorf("this binary runs engine %q, not %q: swap the engine in main.go and rebuild", eng.Name(), name)
	}
	splits := engineeval.Splits
	if split != "all" {
		if !slices.Contains(engineeval.Splits, split) {
			return errors.New("--split takes all, train, validation or test")
		}
		splits = []string{split}
	}
	ds, e := engineeval.Load(dataset, splits)
	if e != nil {
		return e
	}
	res, e := engineeval.Run(context.Background(), eng, ds, splits, func(text string) engine.Content {
		body, _ := json.Marshal(map[string]any{"model": "eval", "messages": []map[string]string{{"role": "user", "content": text}}})
		return extract("application/json", body)
	})
	if e != nil {
		return e
	}
	fmt.Print(engineeval.Markdown(res))
	if out == "" {
		return nil
	}
	b, e := json.MarshalIndent(res, "", "  ")
	if e != nil {
		return e
	}
	return os.WriteFile(out, append(b, '\n'), 0o644)
}
func interceptionLine(interception map[string]any) string {
	if on, _ := interception["on"].(bool); on {
		return ""
	}
	reason, _ := interception["reason"].(string)
	return "interception off: " + reasonWords(reason)
}
func mainErr() error {
	var eng engine.Engine = rules.New()
	pos, flags, e := parseArgs(os.Args[1:])
	if e != nil {
		return e
	}
	get := func(k, def string) string {
		if v := flags[k]; len(v) > 0 {
			return v[len(v)-1]
		}
		return def
	}
	if choice := get("engine", ""); choice != "" && choice != eng.Name() {
		return fmt.Errorf("--engine takes %s, not %q", eng.Name(), choice)
	}
	if get("version", "") != "" {
		fmt.Printf("vibtra-guard (Go/client-hello replay)\nengine: %s\n", eng.Name())
		return nil
	}
	if len(pos) == 0 || get("help", "") != "" {
		fmt.Println("vibtra-guard — Go agent with client-hello replay\nCommands: enrol, run, sync, status, ca export|trust, test, detect-scan, policy-scan, engine check|bench|eval\nUse --data-dir PATH or VIBTRA_GUARD_DIR for an isolated profile.")
		return nil
	}
	if pos[0] == "detect-scan" {
		return detectScan(get("detectors", ""))
	}
	if pos[0] == "engine" && len(pos) == 2 && pos[1] == "eval" {
		return engineEval(eng, get("dataset", ""), get("engine", eng.Name()), get("split", "all"), get("out", ""))
	}
	if pos[0] == "engine" {
		return engineCommand(eng, pos[1:], get("vectors", ""), get("parity", ""))
	}
	dir := get("data-dir", dataDir())
	if pos[0] == "policy-scan" {
		return policyScan(eng, dir, os.Stdin, os.Stdout)
	}
	a, e := openAgent(dir)
	if e != nil {
		return e
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	switch pos[0] {
	case "enrol":
		server, token := get("server", ""), get("token", "")
		if link := get("link", ""); link != "" {
			u, e := url.Parse(link)
			if e != nil {
				return errors.New("invalid enrolment link")
			}
			server = u.Query().Get("server")
			token = u.Query().Get("token")
		}
		if e := a.enrol(ctx, server, token); e != nil {
			return e
		}
		_, e = a.syncOnce(ctx)
		if e != nil {
			return fmt.Errorf("enrolled; first sync failed (run retries): %w", e)
		}
		fmt.Println("Enrolled and synced. Trust the local CA, then run the agent.")
	case "sync":
		next, e := a.syncOnce(ctx)
		if e != nil {
			return e
		}
		fmt.Printf("Synced; next check in %ds.\n", next)
	case "ca":
		if len(pos) < 2 {
			return errors.New("use ca export or ca trust")
		}
		a.ca.ensure()
		_, certPEM := a.ca.certificate()
		if certPEM == nil {
			return errors.New("no interception CA: " + interceptionLine(a.ca.interception()))
		}
		switch pos[1] {
		case "export":
			if get("spki", "") != "" {
				fmt.Println(a.ca.spki())
			} else {
				_, _ = os.Stdout.Write(certPEM)
			}
		case "trust":
			if runtime.GOOS != "darwin" {
				return errors.New("use your platform certificate store")
			}
			cmd := exec.Command("/usr/bin/security", "add-trusted-cert", "-r", "trustRoot", "-p", "ssl", "-k", filepath.Join(os.Getenv("HOME"), "Library/Keychains/login.keychain-db"), filepath.Join(dir, "ca.pem"))
			cmd.Stdin = os.Stdin
			cmd.Stdout = os.Stdout
			cmd.Stderr = os.Stderr
			return cmd.Run()
		default:
			return errors.New("unknown CA command")
		}
	case "status":
		client := &http.Client{Timeout: 2 * time.Second, Transport: &http.Transport{Proxy: nil}}
		var status map[string]any
		res, e := client.Get("http://" + get("local", "127.0.0.1:9471") + "/status")
		if e == nil {
			defer func() { _ = res.Body.Close() }()
			if res.StatusCode == 200 {
				_ = json.NewDecoder(io.LimitReader(res.Body, 1024*1024)).Decode(&status)
			}
		}
		if status == nil {
			status = a.status()
		}
		if _, ok := status["engine"]; !ok {
			status["engine"] = eng.Name()
		}
		b, e := json.MarshalIndent(status, "", "  ")
		if e != nil {
			return e
		}
		fmt.Println(string(b))
		if interception, _ := status["interception"].(map[string]any); interception != nil {
			if line := interceptionLine(interception); line != "" {
				fmt.Fprintln(os.Stderr, line)
			}
		}
	case "run":
		maps := map[string]*url.URL{}
		if raw := get("upstream-map", ""); raw != "" {
			for _, entry := range strings.Split(raw, ",") {
				kv := strings.SplitN(entry, "=", 2)
				if len(kv) != 2 {
					return errors.New("invalid upstream map")
				}
				u, e := url.Parse(kv[1])
				if e != nil || u.Hostname() == "" || u.Scheme != "http" && u.Scheme != "https" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" && u.Path != "/" {
					return errors.New("invalid upstream URL")
				}
				maps[strings.ToLower(kv[0])] = u
			}
		}
		every := 0
		_, _ = fmt.Sscanf(get("sync-every", "0"), "%d", &every)
		a.mu.Lock()
		a.engineName = eng.Name()
		a.mu.Unlock()
		return runAgent(ctx, eng, a, get("proxy", "127.0.0.1:9470"), get("local", "127.0.0.1:9471"), get("transparent", ""), maps, get("upstream-ca", ""), every)
	case "test":
		b, c, _ := a.snapshot()
		if name := get("bundle", ""); name != "" {
			raw, e := os.ReadFile(name)
			if e != nil {
				return e
			}
			var env map[string]json.RawMessage
			_ = json.Unmarshal(raw, &env)
			if env["bundle"] != nil {
				raw = env["bundle"]
			}
			var v policy.Bundle
			if e = json.Unmarshal(raw, &v); e != nil {
				return e
			}
			b = &v
		}
		if name := get("catalogue", ""); name != "" {
			raw, e := os.ReadFile(name)
			if e != nil {
				return e
			}
			var env map[string]json.RawMessage
			_ = json.Unmarshal(raw, &env)
			if env["catalogue"] != nil {
				raw = env["catalogue"]
			}
			var v policy.Catalogue
			if e = json.Unmarshal(raw, &v); e != nil {
				return e
			}
			c = &v
		}
		if b == nil {
			return errors.New("no verified policy; sync first or use --bundle for a local test")
		}
		ex := Extracted{Text: get("text", "")}
		for _, name := range flags["file"] {
			ex.Filenames = append(ex.Filenames, filepath.Base(name))
			body, e := os.ReadFile(name)
			if e == nil {
				ex.Text += "\n" + string(body)
			}
		}
		v, e := decide(ctx, eng, engine.Request{Host: get("host", ""), BundleID: get("bundle-id", ""), CLI: get("cli", ""), Transport: engine.HTTP, Content: ex, Bundle: b, Catalogue: c, Now: time.Now()})
		if e != nil {
			return e
		}
		bytes, _ := json.MarshalIndent(v, "", "  ")
		fmt.Println(string(bytes))
	default:
		return errors.New("unknown command: " + pos[0])
	}
	return nil
}
func main() {
	exitIfStdioIsSocket()
	if e := mainErr(); e != nil {
		fmt.Fprintln(os.Stderr, "vibtra-guard:", e)
		os.Exit(1)
	}
}
