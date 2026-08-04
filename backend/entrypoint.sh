#!/bin/sh
set -e

# Bind-mounted data dirs come from the host with arbitrary ownership.
# Ensure the runtime user can write before dropping privileges.
if [ -d /app/backend/data ]; then
  chown -R musicflow:musicflow /app/backend/data
fi

exec su-exec musicflow node dist/index.js
