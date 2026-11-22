#!/bin/sh
# Runs in the auth-git (Forgejo) container: starts Forgejo (configured from the FORGEJO__ variables,
# INSTALL_LOCK skips the web installer), then creates the admin from the CLI
set -eu
/usr/bin/entrypoint /usr/bin/s6-svscan /etc/s6 &
until curl -fsS --cacert /auth-test/ca.crt https://localhost:3000/api/healthz >/dev/null 2>&1; do
  sleep 1
done
# Already there when the container restarts
su-exec git forgejo admin user create --config /data/gitea/conf/app.ini --admin \
  --username testuser --password "$(cat /auth-test/password)" \
  --email testuser@auth-test.invalid --must-change-password=false >/dev/null 2>&1 || true
wait
