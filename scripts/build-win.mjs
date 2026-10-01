import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import esbuild from 'esbuild';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const { inject } = require('postject');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const PUBLIC = path.join(ROOT, 'public');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function publicAssets() {
  const assets = {};
  for (const name of ['index.html', 'app.js', 'styles.css']) {
    assets[name] = fs.readFileSync(path.join(PUBLIC, name), 'utf8');
  }
  return assets;
}

function fuseEnabled(exePath) {
  const buffer = fs.readFileSync(exePath);
  const offset = buffer.indexOf(FUSE);
  if (offset < 0) return false;
  return buffer[offset + FUSE.length] === 0x3a && buffer[offset + FUSE.length + 1] === 0x31;
}

async function bundle() {
  const outfile = path.join(DIST, 'sea.cjs');
  await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: [path.join(ROOT, 'server.js')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    target: 'node22',
    logLevel: 'info',
    logOverride: { 'empty-import-meta': 'silent' },
    banner: {
      js: `globalThis.SHELF_PUBLIC_ASSETS = ${JSON.stringify(publicAssets())};`,
    },
  });
  return outfile;
}

async function writeBlob(mainFile) {
  const configPath = path.join(DIST, 'sea-config.json');
  const blobPath = path.join(DIST, 'sea-prep.blob');
  fs.writeFileSync(configPath, `${JSON.stringify({
    main: mainFile,
    output: blobPath,
    disableExperimentalSEAWarning: true,
  }, null, 2)}\n`);
  await execFileAsync(process.execPath, ['--experimental-sea-config', configPath], { cwd: ROOT });
  return blobPath;
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('npm run dist:win only works on Windows');
  }
  fs.mkdirSync(DIST, { recursive: true });
  const mainFile = await bundle();
  const blobPath = await writeBlob(mainFile);
  const exePath = path.join(DIST, 'Shelf.exe');
  fs.copyFileSync(process.execPath, exePath);
  await inject(exePath, 'NODE_SEA_BLOB', fs.readFileSync(blobPath), {
    sentinelFuse: FUSE,
    overwrite: true,
  });
  if (!fuseEnabled(exePath)) {
    throw new Error('SEA fuse was not enabled. Shelf.exe would start as a bare Node binary.');
  }
  const size = fs.statSync(exePath).size;
  console.log(`Wrote ${exePath} (${Math.round(size / 1024 / 1024)} MB)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
