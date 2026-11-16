# Chart Monitor

Point it at a GitOps repo and it finds the ArgoCD `Application`s and `ApplicationSet`s, then checks
every Helm chart they deploy:

- is there a newer chart version?
- are there newer tags for the images the chart renders (with the app's own values)?
- what vulnerabilities do those images have (Trivy)?

Works with any git host (GitHub, GitLab, Gitea/Forgejo, self-hosted).

## Quick start

```bash
cp .env.example .env   # optional, only needed for private repos or custom settings
docker compose up --build
```

Open http://localhost:3000.

## Configuration

All settings go in `.env` in the repo root.

| Variable              | Purpose                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `GITHUB_TOKEN`        | Private GitHub repos. Fine-grained token, *Contents: Read-only*.                            |
| `GIT_CREDENTIALS`     | Private repos on other hosts, comma-separated `https://user:token@host` (see below).        |
| `PORT`                | Port the app is published on (default `3000`).                                              |
| `INCLUDE_PRERELEASES` | Also treat pre-release versions (`1.2.0-rc.1`) as updates (default `false`).                |

Each token is only ever sent to its own host. For `GIT_CREDENTIALS` use user `oauth2` with a
`read_repository` token on GitLab, and your username with a *repository: read* token on Gitea/Forgejo:

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

There is no authentication, and the app clones and fetches whatever URLs it is given. Run it on a
trusted network or behind a reverse proxy with login.
