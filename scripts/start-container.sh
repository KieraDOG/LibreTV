#!/bin/sh
set -eu
node server.js &
web_pid=$!
worker_pid=''
if [ "${NAS_DOWNLOAD_ENABLED:-0}" = '1' ]; then
  flock -n -F "${DOWNLOAD_DATA_DIR:-/data}/worker.lock" node worker.cjs &
  worker_pid=$!
fi
shutdown() {
  kill -TERM "$web_pid" 2>/dev/null || true
  if [ -n "$worker_pid" ]; then kill -TERM "$worker_pid" 2>/dev/null || true; fi
  wait || true
}
trap 'shutdown; exit 0' TERM INT
while kill -0 "$web_pid" 2>/dev/null; do
  if [ -n "$worker_pid" ] && ! kill -0 "$worker_pid" 2>/dev/null; then break; fi
  sleep 1
done
shutdown
exit 1
