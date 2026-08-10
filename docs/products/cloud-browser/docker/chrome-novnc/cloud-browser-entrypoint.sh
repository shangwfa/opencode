#!/bin/sh
set -eu

/entrypoint &

# Expose Chrome CDP (bound to 127.0.0.1:9222) on 0.0.0.0:9223 so the
# OpenSandbox server proxy can reach it from outside the container.
socat TCP-LISTEN:9223,fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:9222 &

exec websockify 0.0.0.0:6080 127.0.0.1:5901
