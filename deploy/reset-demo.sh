#!/bin/sh
# Throws away everything in the demo and starts it again with fresh made-up customers.
# Runs every night (installed by setup-server.sh), so a visitor can never leave a mess behind.
set -e
cd /opt/gamerxp
docker compose rm -sf demo demo-db >/dev/null 2>&1 || true
docker volume rm gamerxp-demo-db >/dev/null 2>&1 || true
docker compose up -d --no-build demo-db demo >/dev/null 2>&1
