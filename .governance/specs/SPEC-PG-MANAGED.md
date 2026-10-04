# Managed PostgreSQL lifecycle (#12 / Core #1667)

Development scope: correct the existing PostgreSQL service package, preserving retained clusters and upstream 15.17 artifacts. No Core process-manager, GA or promotion change.

- PG-1: Actual default install files leave an uninitialized cluster directory empty; initdb creates it without deleting or silently repairing nonempty retained directories.
- PG-2: The packaged Node launcher owns a foreground postgres child for its lifetime; no pg_ctl start or detached readiness/status loop. A failed child exits the launcher nonzero.
- PG-3: First boot and warm boot provision requested databases idempotently, with bounded readiness and no plaintext initialization password file left behind.
- PG-4: Launcher graceful shutdown stops its own child and waits for exit. Windows verifier may use parent IPC graceful shutdown because Node child.kill cannot deliver a catchable signal there; direct native Core Stop/Start separately proves actual managed Windows ownership and persistence.
- PG-5: Verification extracts the held archive, materializes actual manifest install.files, asserts server parent identity, writes SQL, stops the launcher first, proves the listener closed, restarts the same data directory and reads the original row. No independent pre-stop hiding lifecycle failure.
- PG-6: Manifest uses supported Node provider execution, acquired artifact-relative command, source tag and SHA256 bindings. Literal released import/install/config/start/stop/start without Core tutorial adapter must pass.
- PG-7: Explicit development publication from develop only, default off, needs terminal platform package/lifecycle jobs. Exact tag, source SHA and archive checksum receipts are retained. Original failures remain evidence; candidate verification does not declare GA.
