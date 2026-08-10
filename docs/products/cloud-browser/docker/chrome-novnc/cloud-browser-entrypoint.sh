#!/bin/sh
set -eu

/entrypoint &

exec websockify 0.0.0.0:6080 127.0.0.1:5901
