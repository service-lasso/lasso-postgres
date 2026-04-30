# lasso-postgres

Release-backed PostgreSQL service for Service Lasso.

This repo packages PostgreSQL `15.17` into Service Lasso release artifacts and publishes a current `service.json` manifest that apps can copy into their own `services/postgres/service.json`.

## Service Contract

- Service ID: `postgres`
- Default port: `8500`
- Health: TCP readiness on `${SERVICE_PORT}`
- Data path: `${SERVICE_ROOT}/runtime/data`
- Default bootstrap user: `pgadmin`
- Default bootstrap password: `pgadmin`
- Default bootstrap database: `keycloak`

The launcher initializes the data directory with `initdb` on first start, creates any comma-separated databases from `POSTGRES_DATABASES`, then runs PostgreSQL in the foreground so Service Lasso can supervise the process.

## Release Assets

Protected pushes to `main` create a timestamped `yyyy.m.d-<shortsha>` GitHub release with:

- `lasso-postgres-15.17-win32.zip`
- `lasso-postgres-15.17-darwin.tar.gz`
- `service.json`
- `SHA256SUMS.txt`

Linux is intentionally not published in the first release because the current EDB binary archive page does not provide a supported PostgreSQL 15 Linux binary archive equivalent. Add Linux in a follow-up when an approved portable distribution source is selected.

## Local Verification

```powershell
npm test
```

This packages the current platform artifact, extracts it, runs the launcher, waits for TCP readiness, verifies `psql` can connect, and stops the managed process.

## Donor Source

This service is migrated from:

```text
C:\projects\typerefinery-ai\typerefinery\services\postgredb
```

The Service Lasso manifest keeps the important donor behavior: auth defaults, data path, TCP health, `keycloak` bootstrap database, and both `POSTGRES_*` plus legacy-compatible `POSTGRE_*` global environment outputs.
