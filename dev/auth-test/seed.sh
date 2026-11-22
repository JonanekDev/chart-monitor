#!/bin/sh
# Runs in the auth-test-seed container: pushes a "private" app image (two tags) to the test
# registry and a chart using it (two versions) to ChartMuseum and, as OCI, to the registry.
set -eu
apk add -q --no-cache ca-certificates curl helm skopeo
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
echo 'Seeded'
