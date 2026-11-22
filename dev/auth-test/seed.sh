#!/bin/sh
# Runs in the auth-test-seed container: pushes a "private" app image (two tags) to the test
# registry and a chart using it (two versions) to ChartMuseum and, as OCI, to the registry; then a
# private GitOps repo to Forgejo, and a read-only token for it into generated/git.env.
set -eu
apk add -q --no-cache ca-certificates curl git helm skopeo
cp /work/generated/ca.crt /usr/local/share/ca-certificates/auth-test.crt
update-ca-certificates 2>/dev/null

user=testuser
password=$(cat /work/generated/password)

for pair in 3.20.0:1.0.0 3.21.0:1.1.0; do
  skopeo copy -q --dest-creds "$user:$password" \
    "docker://docker.io/library/alpine:${pair%:*}" \
    "docker://auth-registry:5000/team/app:${pair#*:}"
done

mkdir -p /tmp/charts
for pair in 0.1.0:1.0.0 0.2.0:1.1.0; do
  helm package /work/chart --version "${pair%:*}" --app-version "${pair#*:}" -d /tmp/charts >/dev/null
done

echo "$password" | helm registry login auth-registry:5000 -u "$user" --password-stdin
for chart in /tmp/charts/*.tgz; do
  curl -fsS -u "$user:$password" --data-binary "@$chart" https://auth-chartmuseum:8080/api/charts
  echo
  helm push "$chart" oci://auth-registry:5000/charts
done
forgejo=https://auth-git:3000
until curl -fsS -o /dev/null -u "$user:$password" "$forgejo/api/v1/user"; do sleep 2; done
status=$(curl -sS -o /dev/null -w '%{http_code}' -u "$user:$password" -H 'Content-Type: application/json' \
  -d '{"name":"gitops","private":true}' "$forgejo/api/v1/user/repos")
case "$status" in 201 | 409) ;; *) echo "creating the repo failed: $status" >&2; exit 1 ;; esac

cp -r /work/gitops /tmp/gitops
cd /tmp/gitops
git init -q -b main
git add .
git -c user.name=auth-test -c user.email=auth-test@auth-test.invalid commit -qm 'auth-test applications'
git push -qf "https://$user:$password@auth-git:3000/$user/gitops.git" main
cd /

# Tokens can't be read back: a new one per run
token=$(curl -fsS -u "$user:$password" -H 'Content-Type: application/json' \
  -d "{\"name\":\"chart-monitor-$(date +%s)\",\"scopes\":[\"read:repository\"]}" \
  "$forgejo/api/v1/users/$user/tokens" | sed -n 's/.*"sha1":"\([^"]*\)".*/\1/p')
[ -n "$token" ] || { echo 'creating the token failed' >&2; exit 1; }
printf 'GIT_CREDENTIALS=https://%s:%s@auth-git:3000\n' "$user" "$token" > /work/generated/git.env

echo 'Seeded'
