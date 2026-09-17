# Chart Monitor

Zadáš GitOps repo -> najde ArgoCD ApplicationSety (generátory `list` a `git` directories) -> pro
každý použitý Helm chart zjistí, jestli existuje novější verze chartu (Helm repo `index.yaml` /
OCI tagy) a jestli existují novější tagy images uvnitř chartu (přes `helm template`).

TODO: CVE/vulnerability scan (přes Trivy nebo API?)

## Požadavky

- Docker Compose nebo lokálně: Node.js 24+, pnpm, helm, PostgreSQL
- GitHub App nainstalovaná na repo(a), která chceš scanovat 

## Setup s Dockerem

```bash
cp packages/backend/.env.example packages/backend/.env 
mkdir -p secrets && cp cesta/k/stazenemu-private-key.pem secrets/github-app-key.pem

docker compose up --build
```

- Backend: http://localhost:3000
- Frontend: http://localhost:5173

## Setup bez Dockeru

```bash
pnpm install
cp packages/backend/.env.example packages/backend/.env
cp packages/frontend/.env.example packages/frontend/.env
pnpm --filter @chart-monitor/backend run db:migrate
pnpm dev
```
