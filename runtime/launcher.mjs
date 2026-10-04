import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync, readdirSync, lstatSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const binRoot = path.join(packageRoot, 'bin');
const serviceRoot = process.env.SERVICE_ROOT ?? process.cwd();
const dataRoot = process.env.POSTGRES_DATA_DIR ?? path.join(serviceRoot, 'runtime', 'data');
const runtimeRoot = path.join(serviceRoot, 'runtime');
const port = process.env.POSTGRES_PORT ?? process.env.SERVICE_PORT ?? '8500';
const host = process.env.POSTGRES_HOST ?? '127.0.0.1';
const user = process.env.POSTGRES_USER ?? 'pgadmin';
const password = process.env.POSTGRES_PASSWORD ?? 'pgadmin';
const databases = (process.env.POSTGRES_DATABASES ?? '').split(',').map(x => x.trim()).filter(Boolean);
const env = { ...process.env, PATH: binRoot + path.delimiter + (process.env.PATH ?? ''), PGPASSWORD: password, PGCONNECT_TIMEOUT: '2' };
if (process.platform === 'linux') env.LD_LIBRARY_PATH = path.join(packageRoot, 'lib');
const exe = name => path.join(binRoot, name + (process.platform === 'win32' ? '.exe' : ''));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let child;
let exited;
let stopping = false;

function run(name, args) {
  const result = spawnSync(exe(name), args, { env, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(name + ' failed with exit code ' + result.status);
}

async function stop() {
  if (stopping) return;
  stopping = true;
  if (child && child.exitCode === null && child.signalCode === null) {
    // pg_ctl stop addresses only this retained cluster; postgres remains a
    // foreground child. Windows cannot receive a catchable child.kill signal.
    const control = spawn(exe('pg_ctl'), ['-D', dataRoot, '-m', 'fast', '-w', '-t', '20', 'stop'], { env, stdio: 'inherit', windowsHide: true });
    await new Promise(resolve => { control.once('error', resolve); control.once('exit', resolve); });
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
  }
  if (process.connected) process.disconnect();
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
// Internal parent-only graceful control, used by the Windows archive verifier.
process.on('message', message => { if (message === 'shutdown') void stop(); });

try {
  if (!existsSync(path.join(dataRoot, 'PG_VERSION'))) {
    mkdirSync(runtimeRoot, { recursive: true });
    mkdirSync(path.dirname(dataRoot), { recursive: true });
    // Recover only the exact empty placeholder created by the old installer.
    // Preserve it outside the cluster; never clear other retained contents.
    if (existsSync(dataRoot) && !lstatSync(dataRoot).isSymbolicLink()) {
      const entries = readdirSync(dataRoot);
      const placeholder = path.join(dataRoot, '.keep');
      if (entries.length === 1 && entries[0] === '.keep') {
        const stat = lstatSync(placeholder);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.size === 0) {
          const retained = path.join(runtimeRoot, 'legacy-data-placeholder-' + process.pid + '-' + Date.now() + '.keep');
          if (existsSync(retained)) throw new Error('Legacy placeholder receipt already exists.');
          renameSync(placeholder, retained);
          console.log('[lasso-postgres] retained legacy empty install placeholder outside the cluster');
        }
      }
    }
    const passwordFile = path.join(runtimeRoot, 'postgres-init-' + process.pid + '.password');
    writeFileSync(passwordFile, password + '\n', { mode: 0o600, flag: 'wx' });
    try {
      run('initdb', ['--encoding', 'UTF8', '-D', dataRoot, '-U', user, '--pwfile', passwordFile, '--auth-host=scram-sha-256']);
    } finally {
      unlinkSync(passwordFile);
    }
  }
  if (!stopping) {
    child = spawn(exe('postgres'), ['-D', dataRoot, '-h', host, '-p', port], { env, stdio: 'inherit', windowsHide: true, detached: false });
    exited = new Promise(resolve => {
      child.once('error', error => { console.error(error.message); process.exitCode = 1; resolve(); });
      child.once('exit', (code, signal) => {
        if (!stopping) process.exitCode = code === 0 ? 1 : (code ?? 1);
        console.log('[lasso-postgres] foreground server exited' + (signal ? ' (' + signal + ')' : ''));
        resolve();
      });
    });
    const deadline = Date.now() + 30_000;
    let ready = false;
    while (!stopping && child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
      let owner;
      try { owner = Number(readFileSync(path.join(dataRoot, 'postmaster.pid'), 'utf8').split('\n')[0]); } catch {}
      if (owner !== child.pid) { await sleep(200); continue; }
      const result = spawnSync(exe('psql'), ['-h', host, '-p', port, '-U', user, '-d', 'postgres', '-At', '-c', 'select 1'], { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 2000, windowsHide: true });
      if (result.status === 0) { ready = true; break; }
      await sleep(200);
    }
    if (!stopping && !ready) throw new Error('Owned PostgreSQL did not become ready within 30 seconds. Preserve the cluster and inspect its logs.');
    if (!stopping) {
      for (const database of databases) {
        // Literal SQL escaping keeps configurable database names out of syntax.
        const literal = "'" + database.replaceAll("'", "''") + "'";
        const existing = spawnSync(exe('psql'), ['-h', host, '-p', port, '-U', user, '-d', 'postgres', '-At', '-c', 'select 1 from pg_database where datname = ' + literal], { env, encoding: 'utf8', timeout: 5000, windowsHide: true });
        if (existing.status !== 0) throw new Error('Failed to inspect requested PostgreSQL database.');
        if (existing.stdout.trim() !== '1') run('createdb', ['-h', host, '-p', port, '-U', user, '--', database]);
      }
      console.log('[lasso-postgres] ready; foreground server pid ' + child.pid);
    }
    await exited;
    if (process.connected) process.disconnect();
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
  await stop();
}
