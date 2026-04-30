import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const postgresVersion = process.env.POSTGRES_VERSION ?? "15.17";
const targetPlatform = process.env.TARGET_PLATFORM ?? process.platform;

const targets = {
  win32: {
    upstreamAsset: `postgresql-${postgresVersion}-1-windows-x64-binaries.zip`,
    upstreamUrl: `https://get.enterprisedb.com/postgresql/postgresql-${postgresVersion}-1-windows-x64-binaries.zip`,
    archiveType: "zip",
    binary: "bin/postgres.exe",
    psql: "bin/psql.exe",
  },
  darwin: {
    upstreamAsset: `postgresql-${postgresVersion}-1-osx-binaries.zip`,
    upstreamUrl: `https://get.enterprisedb.com/postgresql/postgresql-${postgresVersion}-1-osx-binaries.zip`,
    archiveType: "tar.gz",
    binary: "bin/postgres",
    psql: "bin/psql",
  },
};

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

function versionedAssetName(version, platform, archiveType) {
  return `lasso-postgres-${version}-${platform}.${archiveType === "zip" ? "zip" : "tar.gz"}`;
}

async function download(url, destination) {
  if (existsSync(destination)) {
    return;
  }

  const response = await fetch(url, {
    headers: {
      "user-agent": "service-lasso-lasso-postgres-packager",
    },
  });

  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(destination, bytes);
}

async function compressPackage(packageRoot, outputPath, archiveType) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await rm(outputPath, { force: true });

  if (archiveType === "zip") {
    run("powershell", [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path ${JSON.stringify(path.join(packageRoot, "*"))} -DestinationPath ${JSON.stringify(outputPath)} -Force`,
    ]);
    return outputPath;
  }

  run("tar", ["-czf", outputPath, "-C", packageRoot, "."]);
  return outputPath;
}

function findDistributionRoot(root, target) {
  const candidates = [
    path.join(root, "pgsql"),
    path.join(root, "postgresql"),
    root,
  ];

  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, target.binary)) && existsSync(path.join(candidate, target.psql))) {
      return candidate;
    }
  }

  throw new Error(`Could not find PostgreSQL distribution root under ${root}.`);
}

async function copyDistribution(distributionRoot, packageRoot) {
  for (const folder of ["bin", "include", "lib", "share", "doc"]) {
    const source = path.join(distributionRoot, folder);
    if (existsSync(source)) {
      await cp(source, path.join(packageRoot, folder), { recursive: true });
    }
  }
}

export async function packagePostgres(platform = targetPlatform, version = postgresVersion) {
  const target = targets[platform];
  if (!target) {
    throw new Error(`Unsupported target platform: ${platform}. Supported platforms: ${Object.keys(targets).join(", ")}.`);
  }

  if (!/^\d+\.\d+$/.test(version)) {
    throw new Error(`Expected PostgreSQL version like "15.17", got "${version}".`);
  }

  const vendorRoot = path.join(repoRoot, "vendor", version, platform);
  const outputRoot = path.join(repoRoot, "output", "package", version, platform);
  const extractRoot = path.join(outputRoot, "extract");
  const packageRoot = path.join(outputRoot, "payload");
  const upstreamArchive = process.env.POSTGRES_VENDOR_ARCHIVE
    ? path.resolve(process.env.POSTGRES_VENDOR_ARCHIVE)
    : path.join(vendorRoot, target.upstreamAsset);
  const assetName = versionedAssetName(version, platform, target.archiveType);
  const outputPath = path.join(repoRoot, "dist", assetName);

  await mkdir(vendorRoot, { recursive: true });
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(extractRoot, { recursive: true });
  await mkdir(packageRoot, { recursive: true });

  if (!process.env.POSTGRES_VENDOR_ARCHIVE) {
    await download(target.upstreamUrl, upstreamArchive);
  }
  run("tar", ["-xf", upstreamArchive, "-C", extractRoot]);

  const distributionRoot = findDistributionRoot(extractRoot, target);
  await copyDistribution(distributionRoot, packageRoot);
  await writeFile(path.join(packageRoot, "lasso-postgres.mjs"), launcherSource, "utf8");

  if (platform !== "win32") {
    await chmod(path.join(packageRoot, target.binary), 0o755);
    await chmod(path.join(packageRoot, "lasso-postgres.mjs"), 0o755);
  }

  await writeFile(
    path.join(packageRoot, "SERVICE-LASSO-PACKAGE.json"),
    `${JSON.stringify(
      {
        serviceId: "postgres",
        upstream: {
          vendor: "EnterpriseDB",
          source: "https://productsdl.enterprisedb.com/download-postgresql-binaries",
          version,
          asset: target.upstreamAsset,
          url: target.upstreamUrl,
        },
        packagedBy: "service-lasso/lasso-postgres",
        platform,
        arch: "x64",
        command: "node ./lasso-postgres.mjs",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await compressPackage(packageRoot, outputPath, target.archiveType);
  console.log(`[lasso-postgres] packaged ${outputPath}`);
  return outputPath;
}

const launcherSource = String.raw`import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === "win32";
const binRoot = path.join(packageRoot, "bin");
const serviceRoot = process.env.SERVICE_ROOT ?? process.cwd();
const dataRoot = process.env.POSTGRES_DATA_DIR ?? path.join(serviceRoot, "runtime", "data");
const runtimeRoot = path.join(serviceRoot, "runtime");
const passwordFile = path.join(runtimeRoot, "postgres.password");
const port = process.env.POSTGRES_PORT ?? process.env.SERVICE_PORT ?? "8500";
const host = process.env.POSTGRES_HOST ?? "127.0.0.1";
const user = process.env.POSTGRES_USER ?? "pgadmin";
const password = process.env.POSTGRES_PASSWORD ?? "pgadmin";
const databases = (process.env.POSTGRES_DATABASES ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);
const env = {
  ...process.env,
  PATH: binRoot + path.delimiter + (process.env.PATH ?? ""),
  PGPASSWORD: password,
};
let serverStarted = false;
let stopping = false;

function exe(name) {
  return path.join(binRoot, isWindows ? name + ".exe" : name);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env,
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(command + " " + args.join(" ") + " failed with exit code " + result.status);
  }
}

function startServer() {
  run(exe("pg_ctl"), ["-D", dataRoot, "-o", "-h " + host + " -p " + port, "-w", "start"]);
  serverStarted = true;
}

function stopServer() {
  if (!serverStarted) {
    return;
  }

  spawnSync(exe("pg_ctl"), ["-D", dataRoot, "-m", "fast", "-w", "stop"], {
    stdio: "inherit",
    env,
  });
  serverStarted = false;
}

function stop() {
  if (stopping) {
    return;
  }

  stopping = true;
  stopServer();
  process.exit(0);
}

process.on("SIGTERM", stop);
process.on("SIGINT", stop);

function initializeIfNeeded() {
  if (existsSync(path.join(dataRoot, "PG_VERSION"))) {
    return;
  }

  mkdirSync(runtimeRoot, { recursive: true });
  writeFileSync(passwordFile, password + "\n", "utf8");

  run(exe("initdb"), ["--encoding", "UTF8", "-D", dataRoot, "-U", user, "--pwfile", passwordFile]);

  if (databases.length === 0) {
    return;
  }

  startServer();
  try {
    for (const database of databases) {
      run(exe("createdb"), ["-h", host, "-p", port, "-U", user, database]);
    }
  } finally {
    stopServer();
  }
}

initializeIfNeeded();

startServer();
setInterval(() => {
  if (stopping) {
    return;
  }

  const status = spawnSync(exe("pg_ctl"), ["-D", dataRoot, "status"], {
    stdio: "ignore",
    env,
  });
  if (status.status !== 0) {
    process.exit(status.status ?? 1);
  }
}, 2_000);
`;

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await packagePostgres();
}
