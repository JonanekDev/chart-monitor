# Chart Monitor

Add a GitOps repo as a monitor and it is scanned on a schedule (or on demand): the app finds the
ArgoCD `Application`s and `ApplicationSet`s, then checks every Helm chart they deploy:

- is there a newer chart version?
- are there newer tags for the images the chart renders (with the app's own values)?
- what vulnerabilities do those images have (Trivy)?

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

| Variable              | Purpose                                                                                |
| --------------------- | -------------------------------------------------------------------------------------- |
| `ADMIN_PASSWORD_HASH` | **Required.** bcrypt hash of the login password, in single quotes (see below).         |
| `AUTH_DISABLED`       | `true` turns the login off, for setups with SSO in front of the app (default `false`). |
| `GITHUB_TOKEN`        | Private GitHub repos. Fine-grained token, _Contents: Read-only_.                       |
| `GIT_CREDENTIALS`     | Private repos on other hosts, comma-separated `https://user:token@host` (see below).   |
| `TZ`                  | Time zone for scan schedules, e.g. `Europe/Prague` (default `UTC`).                    |
| `SCAN_RETENTION`      | Scans kept per monitor; older ones are deleted (default `10`).                         |
| `PORT`                | Port the app is published on (default `3000`).                                         |
| `INCLUDE_PRERELEASES` | Also treat pre-release versions (`1.2.0-rc.1`) as updates (default `false`).           |

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

**Internal CA:** if your git server or Helm repo uses a certificate from a private CA, uncomment the
`EXTRA_CA_CERTS` lines in `docker-compose.yml` and mount the CA file there.

## What's supported

- `Application` and `ApplicationSet`, single `source` or multiple `sources`
- generators: `list`, `git` (directories and files), `matrix`, `merge`, plus generator `values`
- `goTemplate: true` with plain placeholders (`{{ .name }}`, not template functions)
- Helm values from `valueFiles` (`$ref/...`), `values` and `valuesObject`
- umbrella charts (a git `path` whose `Chart.yaml` depends on external charts)
- Helm repos over HTTPS and OCI

Anything skipped (e.g. `clusters` or `pullRequest` generators, which only exist inside a running
ArgoCD) is listed as a warning on the scan.

## Development

Requires Node.js 24+, pnpm, git, helm and a running `trivy server`.

```bash
pnpm install
pnpm --filter @chart-monitor/backend run db:migrate
pnpm dev   # UI with hot reload on http://localhost:5173, API on :3000
```

## Security

Anyone who can log in can make the app clone and fetch arbitrary URLs, so keep the password strong.
Put the app behind HTTPS (a reverse proxy) when it is reachable from outside your network.
