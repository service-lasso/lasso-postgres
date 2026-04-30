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

if (serviceManifest.id !== "postgres" || serviceManifest.version !== postgresVersion) {
  throw new Error(`Unexpected service manifest identity: ${JSON.stringify({ id: serviceManifest.id, version: serviceManifest.version })}`);
}

if (serviceManifest.healthcheck?.type !== "tcp" || serviceManifest.ports?.service !== 8500) {
  throw new Error(`PostgreSQL service.json health/ports drifted: ${JSON.stringify(serviceManifest)}`);
}

for (const key of ["POSTGRES_HOST", "POSTGRES_PORT", "POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRE_HOST", "POSTGRE_PORT"]) {
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
    POSTGRES_DATA_DIR: path.join(serviceRoot, "runtime", "data"),
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
  await stopChild(postgres);
}
