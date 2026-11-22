#!/bin/sh
# Generates what the auth-test profile needs into dev/auth-test/generated: a throwaway CA with a
# TLS certificate for the test registry, ChartMuseum and Forgejo, a random password, the
# registry's htpasswd and the app's Docker config.json. Run once before `--profile auth-test up`.
set -eu
dir="$(cd "$(dirname "$0")" && pwd)/generated"
mkdir -p "$dir/docker"
cd "$dir"

user=testuser
password=$(openssl rand -hex 16)
printf '%s' "$password" > password

openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj '/CN=chart-monitor auth-test CA' \
  -keyout ca.key -out ca.crt 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj '/CN=auth-test' -keyout server.key -out server.csr \
  2>/dev/null
printf 'subjectAltName=DNS:auth-registry,DNS:auth-chartmuseum,DNS:auth-git,DNS:localhost\n' > san.ext
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 30 \
  -extfile san.ext -out server.crt 2>/dev/null
# The services run as other users and only need to read it; it's a throwaway test key
chmod 644 server.key

# The registry only takes bcrypt
docker pull -q httpd:2.4-alpine >/dev/null
docker run --rm httpd:2.4-alpine htpasswd -nbB "$user" "$password" > htpasswd

auth=$(printf '%s:%s' "$user" "$password" | base64 | tr -d '\n')
printf '{"auths":{"auth-registry:5000":{"auth":"%s"}}}\n' "$auth" > docker/config.json
printf 'BASIC_AUTH_PASS=%s\n' "$password" > chartmuseum.env
printf 'HELM_REPO_CREDENTIALS=https://%s:%s@auth-chartmuseum:8080\n' "$user" "$password" > app.env

# The seed writes the Forgejo token here; created now so it stays yours, not root's
: > git.env
chmod 666 git.env

echo "Generated into $dir"
