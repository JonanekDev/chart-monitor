#!/bin/sh
set -e

# EXTRA_CA_CERTS: PEM file with CAs for self-hosted git / Helm repos / registries (internal CA).
# git (libcurl) and Go tools (helm, trivy) each read ONE bundle that replaces the system one, so the
# extra CAs are appended to the system bundle; Node adds NODE_EXTRA_CA_CERTS on top of its own store.
if [ -n "$EXTRA_CA_CERTS" ]; then
  { cat /etc/ssl/certs/ca-certificates.crt; echo; cat "$EXTRA_CA_CERTS"; } > /tmp/ca-bundle.crt
  export SSL_CERT_FILE=/tmp/ca-bundle.crt
  export GIT_SSL_CAINFO=/tmp/ca-bundle.crt
  export NODE_EXTRA_CA_CERTS="$EXTRA_CA_CERTS"
fi

exec "$@"
