// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
)

var version = "0.1.0"

const (
	logLevelEnv     = "VIBTRA_LOG_LEVEL"
	logConfigName   = "logging.json"
	logDirName      = "logs"
	logFileName     = "vibtra-guard.log"
	logFileMaxBytes = 5 << 20
	logFilesKept    = 3
	logErrorMax     = 200
)

var logLevel = new(slog.LevelVar)

func parseLogLevel(s string) (slog.Level, bool) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug":
		return slog.LevelDebug, true
	case "info":
		return slog.LevelInfo, true
	case "warn", "warning":
		return slog.LevelWarn, true
	case "error":
		return slog.LevelError, true
	}
	return slog.LevelInfo, false
}

func levelName(l slog.Level) string {
	switch {
	case l <= slog.LevelDebug:
		return "debug"
	case l <= slog.LevelInfo:
		return "info"
	case l <= slog.LevelWarn:
		return "warn"
	}
	return "error"
}

func configuredLogLevel(dir string) string {
	var cfg struct {
		Level string `json:"level"`
	}
	if readJSON(filepath.Join(dir, logConfigName), &cfg) != nil {
		return ""
	}
	return cfg.Level
}

func resolveLogLevel(flagValue, dir string) (slog.Level, string, error) {
	if flagValue != "" {
		l, ok := parseLogLevel(flagValue)
		if !ok {
			return l, "", fmt.Errorf("--log-level takes debug, info, warn or error, not %q", flagValue)
		}
		return l, "flag", nil
	}
	for _, c := range []struct{ value, source string }{{os.Getenv(logLevelEnv), "env"}, {configuredLogLevel(dir), "config"}} {
		if l, ok := parseLogLevel(c.value); ok && c.value != "" {
			return l, c.source, nil
		}
	}
	return slog.LevelInfo, "default", nil
}

type fanout []io.Writer

func (f fanout) Write(p []byte) (int, error) {
	for _, w := range f {
		_, _ = w.Write(p)
	}
	return len(p), nil
}

type rotatingFile struct {
	mu   sync.Mutex
	path string
	max  int64
	keep int
	f    *os.File
	size int64
}

func openRotatingFile(path string, max int64, keep int) (*rotatingFile, error) {
	if e := os.MkdirAll(filepath.Dir(path), 0o700); e != nil {
		return nil, e
	}
	r := &rotatingFile{path: path, max: max, keep: keep}
	if e := r.open(); e != nil {
		return nil, e
	}
	return r, nil
}

func (r *rotatingFile) open() error {
	f, e := os.OpenFile(r.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if e != nil {
		return e
	}
	st, e := f.Stat()
	if e != nil {
		_ = f.Close()
		return e
	}
	r.f, r.size = f, st.Size()
	return nil
}

func (r *rotatingFile) rotate() {
	held, heldErr := r.f.Stat()
	onDisk, diskErr := os.Stat(r.path)
	_ = r.f.Close()
	r.f = nil
	if heldErr == nil && diskErr == nil && os.SameFile(held, onDisk) {
		for i := r.keep - 1; i >= 1; i-- {
			_ = os.Rename(fmt.Sprintf("%s.%d", r.path, i), fmt.Sprintf("%s.%d", r.path, i+1))
		}
		_ = os.Rename(r.path, r.path+".1")
	}
	_ = r.open()
}

func (r *rotatingFile) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.f == nil {
		if e := r.open(); e != nil {
			return 0, e
		}
	}
	if r.size > 0 && r.size+int64(len(p)) > r.max {
		r.rotate()
		if r.f == nil {
			return 0, errors.New("log file unavailable after rotation")
		}
	}
	n, e := r.f.Write(p)
	r.size += int64(n)
	return n, e
}

func (r *rotatingFile) Close() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.f == nil {
		return nil
	}
	e := r.f.Close()
	r.f = nil
	return e
}

func logFilePath(dir string) string { return filepath.Join(dir, logDirName, logFileName) }

func setupLogging(dir, flagValue string, toStderr bool) (func(), error) {
	level, source, e := resolveLogLevel(flagValue, dir)
	if e != nil {
		return func() {}, e
	}
	logLevel.Set(level)
	var sinks fanout
	if toStderr {
		signal.Ignore(syscall.SIGPIPE)
		sinks = append(sinks, os.Stderr)
	}
	file, fileErr := openRotatingFile(logFilePath(dir), logFileMaxBytes, logFilesKept)
	if fileErr == nil {
		sinks = append(sinks, file)
	}
	slog.SetDefault(slog.New(slog.NewJSONHandler(sinks, &slog.HandlerOptions{Level: logLevel})))
	if fileErr != nil {
		slog.Warn("log file unavailable; logging to stderr only", "error", errText(fileErr))
	}
	slog.Debug("logging configured", "level", levelName(level), "level_source", source, "version", version)
	return func() {
		if file != nil {
			_ = file.Close()
		}
	}, nil
}

func errText(e error) string {
	if e == nil {
		return ""
	}
	r := []rune(e.Error())
	return string(r[:min(len(r), logErrorMax)])
}

func localMutationRefused(w http.ResponseWriter, r *http.Request, what string) bool {
	site := r.Header.Get("Sec-Fetch-Site")
	switch {
	case r.Method != "POST":
		w.Header().Set("Allow", "POST")
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
	case r.Header.Get("Origin") != "" || site != "" && site != "none":
		http.Error(w, "web pages may not change "+what, http.StatusForbidden)
	default:
		return false
	}
	return true
}

func localLogLevel(w http.ResponseWriter, r *http.Request) {
	if r.Method == "GET" {
		jsonResponse(w, 200, map[string]string{"level": levelName(logLevel.Level())})
		return
	}
	if localMutationRefused(w, r, "the Guard log level") {
		return
	}
	var body struct {
		Level string `json:"level"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 1024)).Decode(&body) != nil {
		http.Error(w, `send {"level":"debug|info|warn|error"}`, http.StatusBadRequest)
		return
	}
	level, ok := parseLogLevel(body.Level)
	if !ok {
		http.Error(w, `send {"level":"debug|info|warn|error"}`, http.StatusBadRequest)
		return
	}
	previous := logLevel.Level()
	if level > previous {
		slog.Info("log level changed", "level", levelName(level), "previous", levelName(previous))
		logLevel.Set(level)
	} else {
		logLevel.Set(level)
		slog.Info("log level changed", "level", levelName(level), "previous", levelName(previous))
	}
	jsonResponse(w, 200, map[string]string{"level": levelName(level)})
}

func serverErrorLog() *log.Logger {
	return slog.NewLogLogger(slog.Default().Handler(), slog.LevelDebug)
}
