package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

const routeCaptureMaxWindow = 24 * time.Hour

var routeCaptureID = regexp.MustCompile(`^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9a-fA-F]{16,}|[A-Za-z0-9_-]{24,}|[0-9]{5,})$`)

var routeCaptureMu sync.Mutex

func routeShape(path string) string {
	segments := strings.Split(path, "/")
	for i, s := range segments {
		if routeCaptureID.MatchString(s) {
			segments[i] = "{id}"
		}
	}
	return strings.Join(segments, "/")
}

func routeCaptureActive(dir string, now time.Time) bool {
	raw, err := os.ReadFile(filepath.Join(dir, "route-capture"))
	if err != nil {
		return false
	}
	until, err := time.Parse(time.RFC3339, strings.TrimSpace(string(raw)))
	return err == nil && now.Before(until) && until.Sub(now) <= routeCaptureMaxWindow
}

func (a *Agent) captureRoute(host string, r *http.Request, identity processAttribution, surface *surfaceEntry) {
	if a == nil || a.dir == "" || !routeCaptureActive(a.dir, time.Now()) {
		return
	}
	row := map[string]any{
		"at":          time.Now().UTC().Format(time.RFC3339Nano),
		"method":      r.Method,
		"host":        host,
		"path":        routeShape(r.URL.Path),
		"contentType": strings.TrimSpace(strings.SplitN(r.Header.Get("Content-Type"), ";", 2)[0]),
		"upgrade":     strings.ToLower(r.Header.Get("Upgrade")),
		"identity":    routeCaptureIdentity(identity),
	}
	if surface != nil {
		row["surfaceEntry"] = surface.ID
	}
	line, err := json.Marshal(row)
	if err != nil {
		return
	}
	routeCaptureMu.Lock()
	defer routeCaptureMu.Unlock()
	f, err := os.OpenFile(filepath.Join(a.dir, "route-capture.jsonl"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer func() { _ = f.Close() }()
	_, _ = f.Write(append(line, '\n'))
}

func routeCaptureIdentity(identity processAttribution) map[string]string {
	if !identity.verifiedApp() {
		status := identity.Status
		if status == "verified" {
			status = "unattributed"
		}
		return map[string]string{"status": status, "signingId": "", "teamId": ""}
	}
	return map[string]string{"status": identity.Status, "signingId": identity.SigningID, "teamId": identity.TeamID}
}
