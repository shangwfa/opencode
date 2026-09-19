#!/usr/bin/env python3
"""Exec helper: python3 sandbox-exec.py <sessionID> <command> -> stdout"""
import json, sys, urllib.request, base64

sid = sys.argv[1]
cmd = sys.argv[2]
req = urllib.request.Request(
    f"http://localhost:14097/api/session/{sid}/exec",
    data=json.dumps({"command": cmd, "timeoutSeconds": 60}).encode(),
    headers={
        "Content-Type": "application/json",
        "Authorization": "Basic " + base64.b64encode(b"opencode:v2-test-pass").decode(),
        "x-opencode-directory": "/workspace",
    },
)
try:
    resp = urllib.request.urlopen(req, timeout=90)
    print(json.load(resp).get("stdout", "").rstrip())
except Exception:
    print("")
