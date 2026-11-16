# Chart Monitor

Zadáš GitOps repo → najde ArgoCD `Application` a `ApplicationSet` manifesty → pro každý použitý Helm
chart zjistí, jestli existuje novější verze chartu (Helm repo `index.yaml` / OCI tagy), jestli
existují novější tagy images uvnitř chartu (přes `helm template` s values z aplikace) a jaké
zranitelnosti v nich jsou (Trivy).

Repa se stahují přes `git clone`, takže funguje jakékoli git repo: GitHub, GitLab (gitlab.com i
self-hosted), Gitea/Forgejo… SSH URL (`git@host:org/repo.git`) se automaticky převádí na HTTPS na
stejném hostu.

**Podporováno:**

- `Application` i `ApplicationSet`, jeden `source` i více `sources`
- generátory `list`, `git` (directories i files), `matrix`, `merge`, `values:` u generátorů
- `goTemplate: true` (jednoduché `{{ .klic }}`, ne funkce)
- Helm values: `valueFiles` přes `$ref/...`, `values`, `valuesObject`
- umbrella charty (git `path:` s `Chart.yaml`, jehož `dependencies` jsou externí charty)
- Helm repa přes HTTPS i OCI (i `repoURL` bez `oci://`, jako v ArgoCD)

Co se přeskočí (generátory `clusters`/`scmProvider`/`pullRequest`, které existují jen v běžícím ArgoCD,
chybějící values soubory, selhaný `helm template`…), se ukáže u scanu jako varování.

## Požadavky

- Docker Compose, nebo lokálně: Node.js 24+, pnpm, git, helm a běžící `trivy server`
- data jsou v SQLite souboru, žádná databáze se instalovat nemusí

## Privátní repa

V `.env` v rootu repa:

- **GitHub:** `GITHUB_TOKEN` – fine-grained token, jen vybraná repa, oprávnění *Contents: Read-only*.
- **Cokoli jiného** (GitLab, Gitea, Forgejo, self-hosted): `GIT_CREDENTIALS`, čárkou oddělené záznamy
  `https://uzivatel:token@host`. Každý token se posílá jen na svůj host.
  - GitLab: uživatel `oauth2`, token s scope `read_repository` (stačí project/group access token)
  - Gitea / Forgejo: tvoje uživatelské jméno, token s oprávněním *repository: read*

  ```
  GIT_CREDENTIALS=https://oauth2:glpat-xxx@gitlab.firma.cz,https://jonas:xxx@gitea.example.com
  ```

Backend používá jen tyhle tokeny, ne přihlášení z tvého systému (keyring, VS Code…), takže se lokálně
chová stejně jako v Dockeru.

## Self-hosted s interní certifikační autoritou

Když git server nebo Helm repo používá certifikát od interní CA, ulož CA (PEM) třeba do
`certs/internal-ca.crt` a v `docker-compose.yml` u služby `app` odkomentuj řádky s `EXTRA_CA_CERTS`
a připojením `./certs/internal-ca.crt`. CA se přidá k systémovým, takže veřejné servery fungují dál
(platí pro git, helm, trivy i backend samotný).

Bez Dockeru nastav `GIT_SSL_CAINFO` a `SSL_CERT_FILE` na bundle systémových CA + tvé CA a
`NODE_EXTRA_CA_CERTS` na soubor s tvou CA, nebo CA přidej do systémového úložiště.

## Setup s Dockerem

```bash
cp .env.example .env   # volitelné, bez tokenů funguje i bez něj
docker compose up --build
```

Aplikace (UI i API) běží na http://localhost:3000. Jiný port nastavíš přes `PORT` v `.env`.

## Setup bez Dockeru

```bash
pnpm install
cp .env.example .env
pnpm --filter @chart-monitor/backend run db:migrate
pnpm dev
```

UI s hot reloadem běží na http://localhost:5173 a volání `/api` přesměrovává na backend
(http://localhost:3000). Pro běh bez vývojového serveru stačí `pnpm build` a pak
`pnpm --filter @chart-monitor/backend start`, backend pak servíruje i sestavené UI.

> API nemá autentizaci a backend klonuje/stahuje z URL, které mu pošleš. Provozuj ho jen v
> důvěryhodné síti nebo za reverse proxy s přihlášením.
