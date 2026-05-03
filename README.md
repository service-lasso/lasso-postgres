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
- `lasso-postgres-15.17-linux.tar.gz`
- `service.json`
- `SHA256SUMS.txt`

Windows and macOS artifacts are packaged from EnterpriseDB installer binary archives. Linux artifacts are built in CI from the official PostgreSQL source archive for the pinned version, then verified with the same start/connect/stop smoke test before release.

## Local Verification

```powershell
npm test
```

This packages the current platform artifact, extracts it, runs the launcher, waits for TCP readiness, verifies `psql` can connect, and stops the managed process.

## Environment Contract

The Service Lasso manifest publishes auth defaults, the data path, TCP health, the `keycloak` bootstrap database, and both `POSTGRES_*` plus compatibility `POSTGRE_*` global environment outputs.
