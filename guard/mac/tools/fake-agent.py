#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Vibtra
import argparse
import json
import queue
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ARGS = None
SUBSCRIBERS: list = []
ASKS: dict = {}
COUNTS = {"allowed": 41, "blocked": 2, "asked": 1}
LOCK = threading.Lock()
SEQ = [0xA0]


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def status() -> dict:
    return {
        "enrolled": True,
        "agentVersion": "0.0.0-stand-in",
        "deviceId": "gdev_0123456789abcdef",
        "hostname": "stand-in-mac",
        "person": {"userId": "usr_ada", "email": "ada@fernwood.example", "name": "Ada Lovelace"},
        "org": {"orgId": "org_fernwood", "name": "Fernwood", "handle": "fernwood"},
        "clientMode": ARGS.mode,
        "lastSyncAt": now(),
        "bundleVersion": 7,
        "today": dict(COUNTS),
        "settings": {"requestsEnabled": True, "workspaceRedirect": {"enabled": True, "url": "https://vibtra.app/fernwood"}},
        "lastBlocked": {"eventId": f"gev_{SEQ[0]:016x}"},
    }


def broadcast(event: str, data: dict) -> None:
    payload = f"event: {event}\ndata: {json.dumps(data)}\n\n".encode()
    with LOCK:
        for q in list(SUBSCRIBERS):
            q.put(payload)


def decision() -> dict:
    with LOCK:
        SEQ[0] += 1
        COUNTS["blocked"] += 1
        event_id = f"gev_{SEQ[0]:016x}"
    return {
        "eventId": event_id,
        "occurredAt": now(),
        "kind": "content",
        "action": "blocked",
        "enforced": ARGS.mode == "enforce",
        "serviceId": "openai-chatgpt",
        "serviceName": "ChatGPT",
        "host": "chatgpt.com",
        "app": {"name": "Google Chrome", "bundleId": "com.google.Chrome"},
        "ruleId": "gcr_0a1b2c3d",
        "ruleName": "Tax file numbers",
        "matchType": "au-tfn",
        "matchCount": 1,
        "snippet": "123***782",
        "requestsEnabled": True,
        "workspace": {"enabled": True, "url": "https://vibtra.app/fernwood"},
        "blockPage": f"http://127.0.0.1:{ARGS.port}/blocked/{event_id}",
    }


def decide_later(event_id: str) -> None:
    time.sleep(20)
    ASKS[event_id] = "approved"
    broadcast("ask-decided", {"eventId": event_id, "request": {"status": "approved"}})


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def send_json(self, code: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/healthz":
            return self.send_json(200, {"ok": True})
        if path == "/status":
            return self.send_json(200, status())
        if path.startswith("/blocked/") and path.endswith("/status"):
            event_id = path.split("/")[2]
            return self.send_json(200, {"eventId": event_id, "status": ASKS.get(event_id, "none"), "applied": ASKS.get(event_id) == "approved"})
        if path.startswith("/blocked/"):
            page = f"<!doctype html><title>Blocked</title><h1>Blocked</h1><p>Event {path.split('/')[2]} (stand-in agent).</p>".encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(page)))
            self.end_headers()
            return self.wfile.write(page)
        if path == "/events":
            return self.stream()
        return self.send_json(404, {"code": "NOT_FOUND", "message": path})

    def do_POST(self):
        path = self.path.split("?")[0]
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self.rfile.read(length)
        if path.startswith("/blocked/") and path.endswith("/request"):
            event_id = path.split("/")[2]
            ASKS[event_id] = "pending"
            threading.Thread(target=decide_later, args=(event_id,), daemon=True).start()
            return self.send_json(200, {"request": {"requestId": "pr_standin", "kind": "guard", "status": "pending"}, "created": True})
        return self.send_json(404, {"code": "NOT_FOUND", "message": path})

    def stream(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        q: queue.Queue = queue.Queue()
        with LOCK:
            SUBSCRIBERS.append(q)
        try:
            self.wfile.write(f"event: synced\ndata: {json.dumps({'at': now(), 'bundleVersion': 7})}\n\n".encode())
            self.wfile.flush()
            first = time.time()
            sent_first = False
            last_tick = time.time()
            while True:
                try:
                    self.wfile.write(q.get(timeout=1))
                    self.wfile.flush()
                except queue.Empty:
                    pass
                t = time.time()
                if not sent_first and t - first >= 3:
                    sent_first = True
                    broadcast("decision", decision())
                    last_tick = t
                elif ARGS.every > 0 and t - last_tick >= ARGS.every:
                    broadcast("decision", decision())
                    last_tick = t
                if int(t) % 15 == 0:
                    self.wfile.write(b": keep-alive\n\n")
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            with LOCK:
                SUBSCRIBERS.remove(q)


def main() -> None:
    global ARGS
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=9471)
    parser.add_argument("--mode", choices=["enforce", "monitor"], default="enforce")
    parser.add_argument("--every", type=float, default=0, help="seconds between decisions after the first (0 = one only)")
    ARGS = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", ARGS.port), Handler)
    print(f"stand-in agent on http://127.0.0.1:{ARGS.port} ({ARGS.mode})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
