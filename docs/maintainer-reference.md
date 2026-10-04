# lasso-postgres

Release-backed PostgreSQL service for Service Lasso.

This repo packages PostgreSQL `15.17` into Service Lasso release artifacts and publishes a current `service.json` manifest that apps can copy into their own `services/postgres/service.json`.

## Service Contract

- Service ID: `postgres`
- Primary endpoint: `service` (`tcp`, loopback, preferred port `8500`)
- URL endpoint: `postgresql://${endpoint.service.bind}:${endpoint.service.port}/postgres`
- Health: singular `healthcheck` TCP readiness on `${endpoint.service.bind}:${endpoint.service.port}` for current Core importer compatibility
- Execution: managed `@node` provider runs the acquired `lasso-postgres.mjs` launcher
- Data path: `${SERVICE_ROOT}/runtime/data`
- Default bootstrap user: `pgadmin`
- Default bootstrap password: `pgadmin`
- Default bootstrap database: `keycloak`

The launcher initializes the data directory with `initdb` on first start, creates any comma-separated databases from `POSTGRES_DATABASES`, then runs PostgreSQL in the foreground so Service Lasso can supervise the process.

## Release Assets

An explicit `publish=true` workflow dispatch on `develop`, after all three platform lifecycle jobs pass, creates a development prerelease named `yyyy.m.d-<shortsha>` with:

- `lasso-postgres-15.17-win32.zip`
- `lasso-postgres-15.17-darwin.tar.gz`
- `lasso-postgres-15.17-linux.tar.gz`
- `service.json`
- `SHA256SUMS.txt`
- `source.json` binding the exact source SHA and publication run

Windows and macOS artifacts are packaged from EnterpriseDB installer binary archives. Linux artifacts are built in CI from the official PostgreSQL source archive for the pinned version, then verified with the same start/connect/stop smoke test before release.

## Local Verification

```powershell
npm test
```

This packages the current platform artifact, validates the canonical endpoint manifest, extracts it and materializes the actual install files. It verifies foreground child ownership, cold/warm SQL persistence, listener closure, failure/recovery, retained-data refusal and configured connection limits. Set `POSTGRES_PACKAGE_ARCHIVE` to test a held archive without rebuilding. Windows archive shutdown uses parent IPC; actual native Core Stop/Start is a separate consumer gate.

## Environment Contract

The Service Lasso manifest authors service interfaces through canonical `endpoints[]` entries. It keeps exported aliases outside endpoint entries for compatibility:

- `POSTGRES_HOST`
- `POSTGRES_PORT`
- `POSTGRES_URL`
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `POSTGRES_HOME`
- `POSTGRE_HOST`
- `POSTGRE_PORT`
- `POSTGRE_URL`
- `POSTGRE_AUTH_USERNAME`
- `POSTGRE_AUTH_PASSWORD`
- `POSTGRE_HOME`
