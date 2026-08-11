import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packagePostgres } from "./package.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const platform = process.env.TARGET_PLATFORM ?? process.platform;
const postgresVersion = process.env.POSTGRES_VERSION ?? "15.17";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: false,
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

async function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to reserve loopback port.")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForTcp(port, timeoutMs = 30_000) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: "127.0.0.1", port });
        socket.once("connect", () => {
          socket.end();
          resolve();
        });
        socket.once("error", reject);
      });
      return;
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }

  throw lastError ?? new Error(`Timed out waiting for PostgreSQL on ${port}.`);
}

async function waitForPsql(psql, port, timeoutMs = 30_000) {
  const startedAt = Date.now();
  let lastResult = null;

  while (Date.now() - startedAt < timeoutMs) {
    const result = spawnSync(
      psql,
      ["-h", "127.0.0.1", "-p", String(port), "-U", "pgadmin", "-d", "keycloak", "-c", "select 1;"],
      {
        env: {
          ...process.env,
          PGPASSWORD: "pgadmin",
          PATH: `${path.dirname(psql)}${path.delimiter}${process.env.PATH ?? ""}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        shell: false,
      },
    );

    if (result.status === 0) {
      process.stdout.write(result.stdout);
      return;
    }

    lastResult = result;
    await sleep(500);
  }

  throw new Error(`Timed out waiting for psql verification. Last exit code: ${lastResult?.status ?? "unknown"}.`);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("close", resolve)),
    sleep(10_000).then(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }),
  ]);
}

const artifact = await packagePostgres(platform, postgresVersion);
const verifyRoot = path.join(repoRoot, "output", "verify", postgresVersion, platform);
const serviceRoot = path.join(verifyRoot, "service");
const extractRoot = path.join(serviceRoot, ".state", "extracted", "current");
const serviceManifest = JSON.parse(await readFile(path.join(repoRoot, "service.json"), "utf8"));
const metadataPath = path.join(extractRoot, "SERVICE-LASSO-PACKAGE.json");
const tcpPort = await reserveLoopbackPort();
const dataRoot = path.join(serviceRoot, "runtime", "data");

if (serviceManifest.id !== "postgres" || serviceManifest.version !== postgresVersion) {
  throw new Error(`Unexpected service manifest identity: ${JSON.stringify({ id: serviceManifest.id, version: serviceManifest.version })}`);
}

if (serviceManifest.healthcheck) {
  throw new Error("PostgreSQL service.json must use canonical healthchecks[] instead of singular healthcheck.");
}

if (serviceManifest.ports) {
  throw new Error("PostgreSQL service.json must author network interfaces with canonical endpoints[] instead of legacy ports.");
}

if (serviceManifest.urls) {
  throw new Error("PostgreSQL service.json must author links with canonical endpoints[] instead of legacy urls.");
}

const endpointsById = new Map((serviceManifest.endpoints ?? []).map((endpoint) => [endpoint.id, endpoint]));
const serviceEndpoint = endpointsById.get("service");
const postgresEndpoint = endpointsById.get("postgres");
if (serviceEndpoint?.kind !== "network") {
  throw new Error("PostgreSQL service.json is missing the canonical service network endpoint.");
}
if (serviceEndpoint.label !== "PostgreSQL TCP") {
  throw new Error("PostgreSQL service endpoint label drifted.");
}
if (serviceEndpoint.direction !== "inbound") {
  throw new Error("PostgreSQL service endpoint must be inbound.");
}
if (serviceEndpoint.transport !== "tcp" || serviceEndpoint.protocol !== "tcp") {
  throw new Error("PostgreSQL service endpoint must use TCP transport/protocol.");
}
if (serviceEndpoint.bind !== "127.0.0.1") {
  throw new Error("PostgreSQL service endpoint must bind to loopback.");
}
if (serviceEndpoint.port?.default !== 8500 || serviceEndpoint.port?.strategy !== "preferred") {
  throw new Error("PostgreSQL service endpoint must preserve preferred default port 8500.");
}
if (serviceEndpoint.exposure !== "local" || serviceEndpoint.primary !== true) {
  throw new Error("PostgreSQL service endpoint must remain the primary local endpoint.");
}
if (postgresEndpoint?.kind !== "url") {
  throw new Error("PostgreSQL service.json is missing the canonical URL endpoint.");
}
if (postgresEndpoint.target !== "service") {
  throw new Error("PostgreSQL URL endpoint must target the service network endpoint.");
}
if (postgresEndpoint.url !== "postgresql://${endpoint.service.bind}:${endpoint.service.port}/postgres") {
  throw new Error("PostgreSQL URL endpoint must use endpoint selectors.");
}
if (postgresEndpoint.exposure !== "local" || postgresEndpoint.primary !== true) {
  throw new Error("PostgreSQL URL endpoint must remain the primary local URL.");
}

const [tcpHealthcheck] = serviceManifest.healthchecks ?? [];
if (
  serviceManifest.healthchecks?.length !== 1 ||
  tcpHealthcheck?.id !== "tcp-ready" ||
  tcpHealthcheck?.type !== "tcp" ||
  tcpHealthcheck?.address !== "${endpoint.service.bind}:${endpoint.service.port}"
) {
  throw new Error(`PostgreSQL service.json health/endpoints drifted: ${JSON.stringify(serviceManifest)}`);
}

if (serviceManifest.env?.POSTGRES_HOST !== "${endpoint.service.bind}") {
  throw new Error("POSTGRES_HOST must resolve from the service endpoint bind selector.");
}
if (serviceManifest.env?.POSTGRES_PORT !== "${endpoint.service.port}") {
  throw new Error("POSTGRES_PORT must resolve from the service endpoint port selector.");
}
if (serviceManifest.env?.POSTGRES_URL !== "${endpoint.postgres.url}") {
  throw new Error("POSTGRES_URL must resolve from the canonical URL endpoint.");
}

for (const key of ["POSTGRES_HOST", "POSTGRES_PORT", "POSTGRES_URL", "POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRE_HOST", "POSTGRE_PORT", "POSTGRE_URL"]) {
  if (!serviceManifest.globalenv?.[key] && !serviceManifest.env?.[key]) {
    throw new Error(`PostgreSQL service.json is missing env/globalenv ${key}.`);
  }
}

await rm(verifyRoot, { recursive: true, force: true });
await mkdir(extractRoot, { recursive: true });
run("tar", ["-xf", artifact, "-C", extractRoot]);

const packageMetadata = JSON.parse(await readFile(metadataPath, "utf8"));
if (
  packageMetadata.serviceId !== "postgres" ||
  packageMetadata.upstream?.version !== postgresVersion ||
  packageMetadata.packagedBy !== "service-lasso/lasso-postgres" ||
  packageMetadata.platform !== platform
) {
  throw new Error(`Unexpected package metadata: ${JSON.stringify(packageMetadata)}`);
}

const postgres = spawn(process.execPath, ["./lasso-postgres.mjs"], {
  cwd: extractRoot,
  env: {
    ...process.env,
    SERVICE_ROOT: serviceRoot,
    SERVICE_PORT: String(tcpPort),
    POSTGRES_HOST: "127.0.0.1",
    POSTGRES_PORT: String(tcpPort),
    POSTGRES_USER: "pgadmin",
    POSTGRES_PASSWORD: "pgadmin",
    POSTGRES_DATABASES: "keycloak",
    POSTGRES_DATA_DIR: dataRoot,
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let stdout = "";
let stderr = "";
postgres.stdout?.on("data", (chunk) => {
  stdout += chunk.toString();
});
postgres.stderr?.on("data", (chunk) => {
  stderr += chunk.toString();
});

try {
  await waitForTcp(tcpPort);
  const psql = path.join(extractRoot, "bin", platform === "win32" ? "psql.exe" : "psql");
  await waitForPsql(psql, tcpPort);
  console.log("[lasso-postgres] verification passed");
} catch (error) {
  console.error("[lasso-postgres] stdout:");
  console.error(stdout);
  console.error("[lasso-postgres] stderr:");
  console.error(stderr);
  throw error;
} finally {
  const pgctl = path.join(extractRoot, "bin", platform === "win32" ? "pg_ctl.exe" : "pg_ctl");
  spawnSync(pgctl, ["-D", dataRoot, "-m", "fast", "-w", "stop"], {
    env: {
      ...process.env,
      PATH: `${path.dirname(pgctl)}${path.delimiter}${process.env.PATH ?? ""}`,
    },
    stdio: "ignore",
    shell: false,
  });
  await stopChild(postgres);
}
