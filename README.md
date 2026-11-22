# Chart Monitor

Add a GitOps repo as a monitor and it is scanned on a schedule (or on demand): the app finds the
ArgoCD `Application`s and `ApplicationSet`s, then checks every Helm chart they deploy:

- is there a newer chart version?
- are there newer tags for the images the chart renders (with the app's own values)? Is the tag
  yours to bump, or the chart's default that comes with a chart upgrade? What would the newer tag fix?
- what vulnerabilities do those images have (Trivy)?
- what would upgrading an outdated chart change: vulnerabilities it fixes and brings in, values the
  new version no longer has (from values, `helm.parameters` and subchart defaults), a failing
  render, immutable fields that make the sync fail, RBAC changes, a field diff of the rendered
  manifests (version bumps left out), and the changelog of every version in between
  (`artifacthub.io/changes`, plus a link to the GitHub releases)?

Works with any git host (GitHub, GitLab, Gitea/Forgejo, self-hosted).

## Quick start

```bash
cp .env.example .env
htpasswd -nBC 12 '' | cut -d: -f2   # asks for a password; put the output into ADMIN_PASSWORD_HASH
docker compose up --build
```

Open http://localhost:3000 and log in with your password.

## Configuration

All settings go in `.env` in the repo root.

| Variable                | Purpose                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------- |
| `ADMIN_PASSWORD_HASH`   | **Required.** bcrypt hash of the login password, in single quotes (see below).          |
| `AUTH_DISABLED`         | `true` turns the login off, for setups with SSO in front of the app (default `false`).  |
| `GITHUB_TOKEN`          | Private GitHub repos. Fine-grained token, _Contents: Read-only_.                        |
| `GIT_CREDENTIALS`       | Private repos on other hosts, comma-separated `https://user:token@host` (see below).    |
| `HELM_REPO_CREDENTIALS` | Private Helm repos (classic), comma-separated `https://user:password@host/path`.        |
| `DOCKER_CONFIG`         | Private registries: directory with a Docker `config.json` (see below).                  |
| `TZ`                    | Time zone for scan schedules, e.g. `Europe/Prague` (default `UTC`).                     |
| `SCAN_RETENTION`        | Scans kept per monitor; older ones are deleted (default `10`).                          |
| `PUBLIC_URL`            | Where the app is reachable, for links in notifications (e.g. `https://cm.example.com`). |
| `PORT`                  | Port the app is published on (default `3000`).                                          |
| `INCLUDE_PRERELEASES`   | Also treat pre-release versions (`1.2.0-rc.1`) as updates (default `false`).            |

Generate the password hash with `htpasswd` (package `apache2-utils` / `httpd-tools`):

```bash
htpasswd -nBC 12 '' | cut -d: -f2
```

- `-n` print the result instead of writing a password file, `-B` use bcrypt, `-C 12` bcrypt cost
- `''` empty user name: `htpasswd` prints `user:hash`, here `:$2y$12$...`
- `cut -d: -f2` keeps what comes after the `:`, i.e. just the hash
- it asks for the password, so it doesn't end up in your shell history

Without `htpasswd` installed, run `docker run --rm -it httpd:alpine htpasswd -nBC 12 ''` and copy
everything after the leading `:`.

Put the hash in `.env` in single quotes, otherwise Docker Compose treats its `$` signs as variables:

```
ADMIN_PASSWORD_HASH='$2y$12$...'
```

Changing the hash logs out every session.

Each token is only ever sent to its own host. For `GIT_CREDENTIALS` use user `oauth2` with a
`read_repository` token on GitLab, and your username with a _repository: read_ token on Gitea/Forgejo:

```
GIT_CREDENTIALS=https://oauth2:glpat-xxx@gitlab.example.com,https://me:xxx@gitea.example.com
```

**Private Helm repos and registries:** classic Helm repos (ChartMuseum, Nexus, Artifactory, Harbor's
ChartMuseum…) take a login per URL; the longest matching prefix wins, so one host can serve repos
with different logins:

```
HELM_REPO_CREDENTIALS=https://ci:xxx@nexus.example.com/repository/helm-private,https://u:xxx@charts.example.com
```

Registries (image tags, OCI charts, and the image pulls of the vulnerability scan) use a Docker
`config.json` with plain `"auths"` entries. Uncomment the `DOCKER_CONFIG` lines in
`docker-compose.yml` and put the file at `secrets/docker/config.json`:

```json
{ "auths": { "harbor.example.com": { "auth": "<base64 of user:password>" } } }
```

Docker Hub can be keyed `docker.io`, `index.docker.io` or `https://index.docker.io/v1/`. The file is
checked at startup: a `credsStore` (e.g. Docker Desktop's) stops the app, since it holds every login;
hosts under `credHelpers` or with an empty entry get a warning and are accessed without login. Cloud
registries with short-lived tokens (ECR, GCR/Artifact Registry, ACR) aren't supported yet. A refused
login (or a 404 from a host we have a login for, which may mean missing permissions) shows up as a
warning on the scan, and logins never appear in warnings or errors.

**Notifications:** add a Discord, Slack (incoming webhook) or JSON webhook channel under Settings
(gear icon), then pick it in a monitor along with what to report: new vulnerabilities from a chosen
severity (optionally only ones with a fix), new chart versions (all of them, or only those whose
upgrade fixes vulnerabilities from that severity up) and failed scans. The first scan sends an
overview, later scans only what is new since the previous one. The JSON webhook gets all the data
plus a plain-text `text`, for n8n, Zapier, Home Assistant or your own script; services that expect
their own format (Teams, ntfy, Gotify) need one of those in between.

**Internal CA:** if your git server or Helm repo uses a certificate from a private CA, uncomment the
`EXTRA_CA_CERTS` lines in `docker-compose.yml` and mount the CA file there.

## What's supported

- `Application` and `ApplicationSet`, single `source` or multiple `sources`
- generators: `list`, `git` (directories and files), `matrix`, `merge`, plus generator `values`
- `goTemplate: true` with plain placeholders (`{{ .name }}`, not template functions)
- Helm values from `valueFiles` (`$ref/...`), `values` and `valuesObject`
- umbrella charts (a git `path` whose `Chart.yaml` depends on external charts)
- Helm repos over HTTPS and OCI, public or with a login

Anything skipped (e.g. `clusters` or `pullRequest` generators, which only exist inside a running
ArgoCD) is listed as a warning on the scan.

## Development

Requires Node.js 24+, pnpm, git, helm and a running `trivy server`.

```bash
pnpm install
pnpm --filter @chart-monitor/backend run db:migrate
pnpm dev   # UI with hot reload on http://localhost:5173, API on :3000
```

To try private repos and registries, the `auth-test` profile starts a registry and ChartMuseum
with TLS and a login, seeded with a chart (classic and OCI) that uses a private image:

```bash
sh dev/auth-test/setup.sh   # throwaway CA, certificates and password into dev/auth-test/generated
docker compose -f docker-compose.yml -f dev/auth-test/app.yaml --profile auth-test up -d --build
```

Then add a monitor for `https://auth-git:3000/testuser/gitops.git`, a private repo in Forgejo (the
app gets a token for it in `GIT_CREDENTIALS`). Its Applications (`dev/auth-test/gitops`) use the
chart from ChartMuseum and as OCI, one of them with the image tag set in its values.

## Security

Anyone who can log in can make the app clone and fetch arbitrary URLs, so keep the password strong.
Put the app behind HTTPS (a reverse proxy) when it is reachable from outside your network.
