# PostgreSQL for Service Lasso

Give your app a local PostgreSQL database that Lasso installs, starts, checks, and stops for you.

**[Add PostgreSQL and connect a working app](https://github.com/service-lasso/service-lasso/blob/develop/docs/first-useful-service.md)**

The walkthrough installs a pinned release, finds the allocated connection port, and proves a real database write/read. It includes configuration, failure diagnosis, and shutdown without deleting your data.

[Configure and recover](https://github.com/service-lasso/service-lasso/blob/develop/docs/operate-your-service.md) · [Package your app](https://github.com/service-lasso/service-lasso/blob/develop/docs/package-your-app.md) · [Releases](https://github.com/service-lasso/lasso-postgres/releases)

Public bootstrap credentials are for local evaluation. Use a proper secret policy for a distributed app. See the walkthrough's pinned-release data-directory note before first initialization.

The corrected development package uses the managed `@node` provider and keeps
PostgreSQL as its foreground child. Install files stay outside the cluster;
first boot initializes an empty cluster, and later starts retain it. Requested
databases are provisioned idempotently after server readiness. No tutorial
launcher adapter is required for this package.
An older failed install containing only its empty `.keep` placeholder is
recovered by retaining that file outside the cluster. Other existing contents
are preserved and initialization fails with diagnostic logs.

`npm test` builds/extracts the archive, materializes the actual manifest install
files, asserts child ownership, writes SQL, stops the launcher and checks the
listener closes, then restarts and reads the original row. On Windows that archive
test uses parent IPC for graceful shutdown; actual native Core lifecycle is a
separate consumer gate. Set `POSTGRES_PACKAGE_ARCHIVE` to verify a held archive
without rebuilding it. Development publication is an explicit `publish=true`
dispatch on `develop`, after all three platform checks pass.
PostgreSQL runs with an ordinary user token on Windows. The disposable hosted
runner uses a dedicated non-administrator account for the same archive checks;
the upstream server refuses administrative tokens.

[Service contract, packaging, and maintainer commands](docs/maintainer-reference.md)
