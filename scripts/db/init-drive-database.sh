#!/bin/sh
# Creates the application database and runs the cluster bootstrap in it (docker-compose.yml and
# CI). The postgis image installs PostGIS, topology and the tiger geocoder into POSTGRES_DB, which
# is left as `postgres`; `drive` is created from template1 instead, so it holds only what
# bootstrap-dev.sql installs. Idempotent: an existing database is kept and bootstrapped again.
set -eu
here=$(dirname "$0")
bootstrap=${BOOTSTRAP_SQL:-$here/bootstrap-dev.sql}
if ! psql -v ON_ERROR_STOP=1 -U postgres -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname = 'drive'" | grep -q 1; then
  psql -v ON_ERROR_STOP=1 -U postgres -d postgres -c 'CREATE DATABASE drive TEMPLATE template1'
fi
psql -v ON_ERROR_STOP=1 -U postgres -d drive -f "$bootstrap"
