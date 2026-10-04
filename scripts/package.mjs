import { spawnSync } from "node:child_process";
import { chmod, cp, lstat, mkdir, readdir, readlink, realpath, rm, writeFile } from "node:fs/promises";
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
  linux: {
    upstreamAsset: `postgresql-${postgresVersion}.tar.gz`,
    upstreamUrl: `https://ftp.postgresql.org/pub/source/v${postgresVersion}/postgresql-${postgresVersion}.tar.gz`,
    archiveType: "tar.gz",
    binary: "bin/postgres",
    psql: "bin/psql",
    build: "source",
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
      'Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:LASSO_PACKAGE_ROOT, $env:LASSO_PACKAGE_OUTPUT)',
    ], { env: { ...process.env, LASSO_PACKAGE_ROOT: packageRoot, LASSO_PACKAGE_OUTPUT: outputPath } });
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

function findSourceRoot(root, version) {
  const candidates = [
    path.join(root, `postgresql-${version}`),
    root,
  ];

  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "configure")) && existsSync(path.join(candidate, "src"))) {
      return candidate;
    }
  }

  throw new Error(`Could not find PostgreSQL source root under ${root}.`);
}

async function buildSourceDistribution(sourceRoot, packageRoot) {
  const jobs = process.env.MAKE_JOBS ?? "2";
  run("./configure", [`--prefix=${packageRoot}`], { cwd: sourceRoot });
  run("make", [`-j${jobs}`], { cwd: sourceRoot });
  run("make", ["install"], { cwd: sourceRoot });
}

async function copyDistribution(distributionRoot, packageRoot, platform) {
  for (const folder of ["bin", "include", "lib", "share", "doc"]) {
    const source = path.join(distributionRoot, folder);
    if (existsSync(source)) {
      // Materialize Darwin dylib-link targets so the release archive remains
      // relocatable after extraction, regardless of how the source links resolve.
      await cp(source, path.join(packageRoot, folder), {
        recursive: true,
        dereference: platform === "darwin",
      });
    }
  }
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function dylibFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await dylibFiles(entryPath));
    } else if (entry.name.endsWith(".dylib")) {
      files.push(entryPath);
    }
  }
  return files;
}

export async function verifyDarwinLibraryLinks(packageRoot) {
  const libraryRoot = path.join(packageRoot, "lib");
  const canonicalLibraryRoot = await realpath(libraryRoot);

  for (const libraryPath of await dylibFiles(libraryRoot)) {
    if (!(await lstat(libraryPath)).isSymbolicLink()) continue;

    const target = await readlink(libraryPath);
    if (path.isAbsolute(target)) {
      throw new Error(`Darwin package library link must be relative: ${libraryPath} -> ${target}`);
    }

    const resolvedTarget = path.resolve(path.dirname(libraryPath), target);
    let canonicalTarget;
    try {
      canonicalTarget = await realpath(resolvedTarget);
    } catch {
      throw new Error(`Darwin package library link is dangling: ${libraryPath} -> ${target}`);
    }
    if (!isWithin(canonicalLibraryRoot, canonicalTarget)) {
      throw new Error(`Darwin package library link escapes lib: ${libraryPath} -> ${target}`);
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

  if (target.build === "source") {
    const sourceRoot = findSourceRoot(extractRoot, version);
    await buildSourceDistribution(sourceRoot, packageRoot);
  } else {
    const distributionRoot = findDistributionRoot(extractRoot, target);
    await copyDistribution(distributionRoot, packageRoot, platform);
  }

  await writeFile(path.join(packageRoot, "lasso-postgres.mjs"), await readFile(path.join(repoRoot, "runtime", "launcher.mjs"), "utf8"), "utf8");

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

  if (platform === "darwin") {
    await verifyDarwinLibraryLinks(packageRoot);
  }

  await compressPackage(packageRoot, outputPath, target.archiveType);
  console.log(`[lasso-postgres] packaged ${outputPath}`);
  return outputPath;
}


if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await packagePostgres();
}
