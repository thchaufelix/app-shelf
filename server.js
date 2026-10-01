import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { isSea } from 'node:sea';
import { DatabaseSync } from 'node:sqlite';

const execFileAsync = promisify(execFile);

function crashLog(message) {
  try {
    const dir = path.join(process.env.APPDATA || os.tmpdir(), 'Shelf');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'shelf.log'), `[${new Date().toISOString()}] FATAL ${message}\n`);
  } catch {
    // Ignore logging failures during startup.
  }
}

process.on('uncaughtException', (error) => {
  crashLog(error.stack || String(error));
  process.exit(1);
});

const PACKAGED = isSea();
const ROOT = PACKAGED
  ? path.dirname(process.execPath)
  : path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = resolveDataDir();
const ICON_DIR = path.join(DATA_DIR, 'icons');
const HOST = '127.0.0.1';
const PREFERRED_PORT = Number(process.env.PORT) || 4173;

function resolveDataDir() {
  if (!PACKAGED) return path.join(ROOT, 'data');
  const portable = path.join(path.dirname(process.execPath), 'data');
  try {
    if (fs.existsSync(portable) && fs.statSync(portable).isDirectory()) return portable;
  } catch {
    // Fall through to AppData.
  }
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Shelf');
}

function setupPackagedLogging() {
  if (!PACKAGED) return;
  const logFile = path.join(DATA_DIR, 'shelf.log');
  const stream = fs.createWriteStream(logFile, { flags: 'a' });
  const originalLog = console.log.bind(console);
  const originalError = console.error.bind(console);
  const write = (level, args) => {
    const text = args.map((value) => {
      if (value instanceof Error) return value.stack || value.message;
      return typeof value === 'string' ? value : JSON.stringify(value);
    }).join(' ');
    stream.write(`[${new Date().toISOString()}] ${level} ${text}\n`);
  };
  console.log = (...args) => {
    write('INFO', args);
    originalLog(...args);
  };
  console.error = (...args) => {
    write('ERROR', args);
    originalError(...args);
  };
  process.on('uncaughtException', (error) => {
    console.error(error);
    process.exit(1);
  });
  process.on('unhandledRejection', (error) => {
    console.error(error);
  });
}

function printConsoleHints(address, alreadyRunning = false) {
  const line = (text = '') => console.log(text);
  line('');
  line('  Shelf');
  line('  -----');
  if (alreadyRunning) {
    line(`  Already running at ${address}`);
    line('  Opening that window in your browser.');
    line('');
    return;
  }
  line(`  Running at ${address}`);
  line(`  Data folder: ${DATA_DIR}`);
  line('');
  line('  Add      Drag an app or file from Explorer onto the page, or use Add.');
  line('  Open     Double-click an item.');
  line('  Edit     Click an item. Click the dimmed area or press Esc to close.');
  line('  Pin      Use the pin on a tile, or Select then Pin.');
  line('  Remove   Open an item and choose Remove, or Select then Remove.');
  line('');
  line('  Close this window or press Ctrl+C to stop Shelf.');
  line('');
}

fs.mkdirSync(ICON_DIR, { recursive: true });
setupPackagedLogging();

const db = new DatabaseSync(path.join(DATA_DIR, 'shelf.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    filename TEXT NOT NULL,
    alias TEXT,
    pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    opened_at TEXT
  );

  CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
  );

  CREATE TABLE IF NOT EXISTS item_tags (
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (item_id, tag_id)
  );

  CREATE INDEX IF NOT EXISTS idx_item_tags_tag ON item_tags(tag_id);

  CREATE TABLE IF NOT EXISTS item_todos (
    id INTEGER PRIMARY KEY,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE INDEX IF NOT EXISTS idx_item_todos_item ON item_todos(item_id, position, id);
`);

const pendingIcons = new Set();
const iconQueue = [];
let iconWorkers = 0;
const ICON_CONCURRENCY = 2;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function iconFile(id) {
  return path.join(ICON_DIR, `${id}.png`);
}

function kindOf(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.app') || lower.endsWith('.exe') || lower.endsWith('.lnk')) return 'app';
  try {
    return fs.statSync(filePath).isDirectory() ? 'folder' : 'file';
  } catch {
    return 'file';
  }
}

function displayNameOf(row) {
  const alias = typeof row.alias === 'string' ? row.alias.trim() : '';
  return alias || row.filename;
}

function serialize(row) {
  const tags = db.prepare(`
    SELECT t.id AS id, t.name AS name
    FROM item_tags it
    JOIN tags t ON t.id = it.tag_id
    WHERE it.item_id = ?
    ORDER BY t.name COLLATE NOCASE
  `).all(row.id);

  const todos = db.prepare(`
    SELECT id, text, done, position
    FROM item_todos
    WHERE item_id = ?
    ORDER BY position ASC, id ASC
  `).all(row.id);

  return {
    id: row.id,
    path: row.path,
    filename: row.filename,
    alias: row.alias,
    displayName: displayNameOf(row),
    pinned: Boolean(row.pinned),
    kind: kindOf(row.path),
    missing: !fs.existsSync(row.path),
    hasIcon: fs.existsSync(iconFile(row.id)),
    createdAt: row.created_at,
    openedAt: row.opened_at,
    tags: tags.map((tag) => ({ id: tag.id, name: tag.name })),
    todos: todos.map((todo) => ({
      id: todo.id,
      text: todo.text,
      done: Boolean(todo.done),
    })),
  };
}

function listPayload() {
  const rows = db.prepare('SELECT * FROM items').all();
  const items = rows
    .map(serialize)
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' });
    });
  const tags = db.prepare(`
    SELECT t.id AS id, t.name AS name, COUNT(it.item_id) AS count
    FROM tags t
    JOIN item_tags it ON it.tag_id = t.id
    GROUP BY t.id
    ORDER BY t.name COLLATE NOCASE
  `).all();
  return {
    items,
    tags: tags.map((tag) => ({ id: tag.id, name: tag.name, count: tag.count })),
    platform: process.platform,
    packaged: PACKAGED,
  };
}

function getItem(id) {
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, 'Item not found');
  return row;
}

function parseId(value) {
  if (!/^\d+$/.test(value)) throw new HttpError(400, 'Invalid item');
  return Number(value);
}

function normalizeDroppedPath(input) {
  let value = String(input).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim();
  }
  if (value.toLowerCase().startsWith('file:')) {
    try {
      const url = new URL(value);
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
      // file:///C:/Apps/App.exe arrives as /C:/Apps/App.exe
      if (/^\/[A-Za-z]:\//.test(pathname)) pathname = pathname.slice(1);
      value = pathname;
    } catch {
      // Keep the original text when the file URL cannot be parsed.
    }
  }
  if (process.platform === 'win32' && /^[A-Za-z]:\//.test(value)) {
    value = value.replace(/\//g, '\\');
  }
  return value;
}

function existingPath(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new HttpError(400, 'A path is required');
  }
  if (input.includes('\0')) throw new HttpError(400, 'Invalid path');
  const normalized = normalizeDroppedPath(input);
  const resolved = path.resolve(normalized);
  if (!path.isAbsolute(resolved) || !fs.existsSync(resolved)) {
    throw new HttpError(400, `Nothing exists at ${normalized}`);
  }
  return resolved;
}

function cleanAlias(alias) {
  if (alias == null) return null;
  if (typeof alias !== 'string') throw new HttpError(400, 'Alternate name must be text');
  const trimmed = alias.trim();
  if (!trimmed) return null;
  if (trimmed.length > 120) throw new HttpError(400, 'Alternate name is too long');
  if (/[\u0000-\u001f]/.test(trimmed)) throw new HttpError(400, 'Alternate name has invalid characters');
  return trimmed;
}

function cleanTag(name) {
  if (typeof name !== 'string') throw new HttpError(400, 'Tag name is required');
  const trimmed = name.trim().replace(/\s+/g, ' ');
  if (!trimmed) throw new HttpError(400, 'Tag name is required');
  if (trimmed.length > 32) throw new HttpError(400, 'Tag is too long');
  if (/[\u0000-\u001f]/.test(trimmed)) throw new HttpError(400, 'Tag has invalid characters');
  return trimmed;
}

function pruneTags() {
  db.prepare('DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM item_tags)').run();
}

function cleanTodo(text) {
  if (typeof text !== 'string') throw new HttpError(400, 'To-do text is required');
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (!trimmed) throw new HttpError(400, 'To-do text is required');
  if (trimmed.length > 120) throw new HttpError(400, 'To-do is too long');
  if (/[\u0000-\u001f]/.test(trimmed)) throw new HttpError(400, 'To-do has invalid characters');
  return trimmed;
}

function getTodo(itemId, todoId) {
  const row = db.prepare('SELECT * FROM item_todos WHERE id = ? AND item_id = ?').get(todoId, itemId);
  if (!row) throw new HttpError(404, 'To-do not found');
  return row;
}

function addPath(filePath) {
  const filename = path.basename(filePath);
  const existing = db.prepare('SELECT * FROM items WHERE path = ?').get(filePath);
  if (existing) return { item: serialize(existing), created: false };

  let id;
  try {
    const result = db.prepare('INSERT INTO items (path, filename) VALUES (?, ?)').run(filePath, filename);
    id = Number(result.lastInsertRowid);
  } catch (error) {
    if (error.errcode === 2067 || String(error.message).includes('UNIQUE')) {
      const row = db.prepare('SELECT * FROM items WHERE path = ?').get(filePath);
      return { item: serialize(row), created: false };
    }
    throw error;
  }

  enqueueIcon(id, filePath);
  return { item: serialize(getItem(id)), created: true };
}

function addPaths(inputs) {
  const unique = [...new Set(inputs)];
  const added = [];
  const existing = [];
  const errors = [];
  for (const input of unique) {
    try {
      const result = addPath(existingPath(input));
      (result.created ? added : existing).push(result.item);
    } catch (error) {
      errors.push(error instanceof HttpError ? error.message : 'Could not add that path');
    }
  }
  return { added, existing, errors };
}

function enqueueIcon(id, filePath) {
  if (pendingIcons.has(id)) return;
  pendingIcons.add(id);
  iconQueue.push({ id, filePath });
  pumpIcons();
}

function pumpIcons() {
  while (iconWorkers < ICON_CONCURRENCY && iconQueue.length) {
    const job = iconQueue.shift();
    iconWorkers += 1;
    renderIcon(job.filePath, iconFile(job.id))
      .catch((error) => {
        console.error(`Icon failed for ${job.filePath}: ${error.message}`);
      })
      .finally(() => {
        pendingIcons.delete(job.id);
        iconWorkers -= 1;
        pumpIcons();
      });
  }
}

async function renderIcon(filePath, dest) {
  if (process.platform === 'win32') {
    await renderWindowsIcon(filePath, dest);
    return;
  }
  if (process.platform !== 'darwin') return;
  const full = `${dest}.full.png`;
  const script = `
    ObjC.import('AppKit');
    function unwrap(value) {
      if (value === null || value === undefined) return null;
      if (typeof value.isNil === 'function' && value.isNil()) return null;
      return ObjC.unwrap(value);
    }
    const env = $.NSProcessInfo.processInfo.environment;
    const src = unwrap(env.objectForKey('SHELF_SRC'));
    const out = unwrap(env.objectForKey('SHELF_DEST'));
    if (!src || !out) throw new Error('missing icon path');
    const icon = $.NSWorkspace.sharedWorkspace.iconForFile($(src));
    const tiff = icon.TIFFRepresentation;
    if (!tiff || (typeof tiff.isNil === 'function' && tiff.isNil())) throw new Error('no icon');
    const rep = $.NSBitmapImageRep.imageRepWithData(tiff);
    const png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
    if (!png || (typeof png.isNil === 'function' && png.isNil())) throw new Error('no png');
    if (!png.writeToFileAtomically($(out), true)) throw new Error('could not write icon');
  `;
  await execFileAsync('osascript', ['-l', 'JavaScript', '-e', script], {
    timeout: 20000,
    env: { ...process.env, SHELF_SRC: filePath, SHELF_DEST: full },
  });
  try {
    await execFileAsync('sips', ['-z', '256', '256', full, '--out', dest], { timeout: 15000 });
    fs.rmSync(full, { force: true });
  } catch {
    fs.renameSync(full, dest);
  }
}

function backfillIcons() {
  for (const row of db.prepare('SELECT id, path FROM items').all()) {
    if (!fs.existsSync(iconFile(row.id)) && fs.existsSync(row.path)) enqueueIcon(row.id, row.path);
  }
}

async function renderWindowsIcon(filePath, dest) {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class ShelfIcon {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, EntryPoint = "PrivateExtractIconsW")]
  public static extern uint PrivateExtractIcons(string file, int index, int cx, int cy, IntPtr[] icons, uint[] ids, uint count, uint flags);
  [DllImport("user32.dll")]
  public static extern bool DestroyIcon(IntPtr handle);
}
'@
$src = $env:SHELF_SRC
$dest = $env:SHELF_DEST
$handle = [IntPtr]::Zero
$icon = $null
$ptrs = New-Object IntPtr[] 1
$ids = New-Object uint32[] 1
try {
  $count = [ShelfIcon]::PrivateExtractIcons($src, 0, 256, 256, $ptrs, $ids, 1, 0)
  if ($count -gt 0 -and $ptrs[0] -ne [IntPtr]::Zero) {
    $handle = $ptrs[0]
    $icon = [System.Drawing.Icon]::FromHandle($handle)
  }
} catch {}
if ($null -eq $icon) {
  $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($src)
}
if ($null -eq $icon) { exit 1 }
$source = $icon.ToBitmap()
$bmp = New-Object System.Drawing.Bitmap 256, 256
$graphics = [System.Drawing.Graphics]::FromImage($bmp)
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$graphics.Clear([System.Drawing.Color]::Transparent)
$graphics.DrawImage($source, 0, 0, 256, 256)
$bmp.Save($dest, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bmp.Dispose()
$source.Dispose()
$icon.Dispose()
if ($handle -ne [IntPtr]::Zero) { [ShelfIcon]::DestroyIcon($handle) | Out-Null }
`;
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeout: 20000,
    windowsHide: true,
    env: { ...process.env, SHELF_SRC: filePath, SHELF_DEST: dest },
  });
}

async function readDragPaths() {
  if (process.platform === 'win32') return readWindowsFileDrop();
  if (process.platform !== 'darwin') return [];
  const script = `
    ObjC.import('AppKit');
    function unwrap(value) {
      try {
        if (value === null || value === undefined) return null;
        if (typeof value.isNil === 'function' && value.isNil()) return null;
        return ObjC.unwrap(value);
      } catch (error) {
        return null;
      }
    }
    function resolve(urlString) {
      if (!urlString || String(urlString).indexOf('file:') !== 0) return null;
      const url = $.NSURL.URLWithString($(String(urlString)));
      if (!url || (typeof url.isNil === 'function' && url.isNil())) return null;
      const pathRef = Ref();
      const err = Ref();
      if (url.getResourceValueForKeyError(pathRef, $.NSURLPathKey, err)) {
        const resolved = unwrap(pathRef[0]);
        if (resolved) return resolved;
      }
      const filePathURL = url.filePathURL;
      if (filePathURL && !(typeof filePathURL.isNil === 'function' && filePathURL.isNil())) {
        const resolved = unwrap(filePathURL.path);
        if (resolved) return resolved;
      }
      return unwrap(url.path);
    }
    const pasteboard = $.NSPasteboard.pasteboardWithName($.NSPasteboardNameDrag);
    const paths = [];
    const seen = {};
    function push(filePath) {
      if (!filePath || seen[filePath]) return;
      seen[filePath] = true;
      paths.push(filePath);
    }
    const items = pasteboard.pasteboardItems;
    const count = items ? items.count : 0;
    for (let i = 0; i < count; i++) {
      const item = items.objectAtIndex(i);
      push(resolve(unwrap(item.stringForType('public.file-url'))));
    }
    if (!paths.length) push(resolve(unwrap(pasteboard.stringForType('public.file-url'))));
    try {
      const names = pasteboard.propertyListForType('NSFilenamesPboardType');
      if (names && typeof names.count === 'number') {
        for (let i = 0; i < names.count; i++) push(unwrap(names.objectAtIndex(i)));
      }
    } catch (error) {}
    const payload = JSON.stringify(paths);
    // JXA console.log goes to stderr. Also write stdout so either stream is enough.
    ObjC.import('Foundation');
    const handle = $.NSFileHandle.fileHandleWithStandardOutput;
    handle.writeData($(payload + '\\n').dataUsingEncoding($.NSUTF8StringEncoding));
    console.log(payload);
  `;
  try {
    const { stdout, stderr } = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', script], {
      timeout: 8000,
      encoding: 'utf8',
    });
    return parsePathList(stdout, stderr);
  } catch (error) {
    const recovered = parsePathList(error.stdout, error.stderr);
    if (recovered.length) return recovered;
    console.error(`Pasteboard read failed: ${error.message}`);
    return [];
  }
}

function parsePathList(stdout, stderr) {
  const lines = `${stdout || ''}\n${stderr || ''}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith('[')) continue;
    try {
      const parsed = JSON.parse(lines[i]);
      if (Array.isArray(parsed)) return parsed.filter((entry) => typeof entry === 'string');
    } catch {
      // A warning line can start with '['. Keep scanning.
    }
  }
  return [];
}

let captureInflight = null;
let lastCapture = { paths: [], at: 0 };

function captureDragPasteboard() {
  if (!captureInflight) {
    captureInflight = readDragPaths()
      .then((paths) => {
        if (paths.length) lastCapture = { paths, at: Date.now() };
        return paths;
      })
      .finally(() => {
        captureInflight = null;
      });
  }
  return captureInflight;
}

function parseDropFiles(body) {
  const files = Array.isArray(body.files)
    ? body.files
      .filter((entry) => entry && typeof entry.name === 'string' && entry.name.trim())
      .map((entry) => ({
        name: String(entry.name),
        size: Number.isFinite(entry.size) ? entry.size : null,
        lastModified: Number.isFinite(entry.lastModified) ? entry.lastModified : null,
        path: typeof entry.path === 'string' ? entry.path : '',
      }))
    : [];
  const names = Array.isArray(body.names)
    ? body.names.filter((entry) => typeof entry === 'string' && entry.trim())
    : files.map((file) => file.name);
  const clientPaths = [
    ...(Array.isArray(body.paths) ? body.paths.filter((entry) => typeof entry === 'string') : []),
    ...files.map((file) => file.path).filter(Boolean),
  ];
  return { files, names, clientPaths };
}

function metaForName(metas, filePath) {
  const base = path.basename(filePath).toLowerCase();
  return metas.find((meta) => meta.name.toLowerCase() === base) || null;
}

function narrowByMeta(filePaths, metas) {
  if (filePaths.length <= 1 || !metas.length) return filePaths;
  const bySize = filePaths.filter((filePath) => {
    const meta = metaForName(metas, filePath);
    if (!meta || meta.size == null || meta.size < 0) return true;
    try {
      const st = fs.statSync(filePath);
      return st.isDirectory() || st.size === meta.size;
    } catch {
      return false;
    }
  });
  const sized = bySize.length ? bySize : filePaths;
  if (sized.length <= 1) return sized;
  const byTime = sized.filter((filePath) => {
    const meta = metaForName(metas, filePath);
    if (!meta || !meta.lastModified) return true;
    try {
      const st = fs.statSync(filePath);
      return st.isDirectory() || Math.abs(st.mtimeMs - meta.lastModified) <= 5000;
    } catch {
      return false;
    }
  });
  return byTime.length ? byTime : sized;
}

function reconcileDrop(clientPaths, names, pasteboardPaths, metas = []) {
  const onDisk = (filePath) => {
    try {
      const resolved = path.resolve(normalizeDroppedPath(filePath));
      return path.isAbsolute(resolved) && fs.existsSync(resolved) ? resolved : null;
    } catch {
      return null;
    }
  };
  const fromClient = clientPaths.map(onDisk).filter(Boolean);
  if (fromClient.length) return fromClient;

  const fresh = Date.now() - lastCapture.at < 20000 ? lastCapture.paths : [];
  const candidates = [...new Set([...pasteboardPaths, ...fresh])].map(onDisk).filter(Boolean);
  if (!names.length) return candidates;

  const wanted = new Set(names.map((name) => name.toLowerCase()));
  return narrowByMeta(
    candidates.filter((filePath) => wanted.has(path.basename(filePath).toLowerCase())),
    metas,
  );
}

function isCancel(error) {
  const message = `${error.message || ''}\n${error.stderr || ''}\n${error.stdout || ''}`;
  return message.includes('-128') || /user cancel/i.test(message);
}

async function readWindowsFileDrop() {
  const outFile = path.join(os.tmpdir(), `shelf-drop-${process.pid}-${Date.now()}.txt`);
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$paths = New-Object System.Collections.Generic.List[string]
$seen = @{}
function Add-DropPath([string]$filePath) {
  if ([string]::IsNullOrWhiteSpace($filePath)) { return }
  if ($filePath.StartsWith('::')) { return }
  if (-not [System.IO.File]::Exists($filePath) -and -not [System.IO.Directory]::Exists($filePath)) { return }
  $key = $filePath.ToLowerInvariant()
  if ($seen.ContainsKey($key)) { return }
  $seen[$key] = $true
  [void]$paths.Add($filePath)
}
try {
  if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
    foreach ($item in @([System.Windows.Forms.Clipboard]::GetFileDropList())) {
      Add-DropPath $item
    }
  }
} catch {}
try {
  $shell = New-Object -ComObject Shell.Application
  $windows = $shell.Windows()
  for ($i = 0; $i -lt $windows.Count; $i++) {
    try {
      $window = $windows.Item($i)
      $fullName = [string]$window.FullName
      if ($fullName -notmatch '(?i)[\\\\/]explorer\\.exe$') { continue }
      $selected = $window.Document.SelectedItems()
      for ($j = 0; $j -lt $selected.Count; $j++) {
        Add-DropPath ([string]$selected.Item($j).Path)
      }
    } catch {}
  }
  try {
    $hwnd = 0
    $desktop = $windows.FindWindowSW([Type]::Missing, [Type]::Missing, 8, [ref]$hwnd, 1)
    if ($desktop) {
      $selected = $desktop.Document.SelectedItems()
      for ($j = 0; $j -lt $selected.Count; $j++) {
        Add-DropPath ([string]$selected.Item($j).Path)
      }
    }
  } catch {}
} catch {}
if ($paths.Count -lt 1) { exit 0 }
$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllLines($env:SHELF_OUT, $paths.ToArray(), $utf8)
`;
  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-Command', script], {
      timeout: 8000,
      windowsHide: true,
      env: { ...process.env, SHELF_OUT: outFile },
    });
    if (!fs.existsSync(outFile)) return [];
    return fs.readFileSync(outFile, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch (error) {
    console.error(`Windows drop read failed: ${error.message}`);
    return [];
  } finally {
    fs.rmSync(outFile, { force: true });
  }
}

function windowsSearchRoots(names = []) {
  const home = process.env.USERPROFILE || '';
  const userRoots = [
    path.join(home, 'Desktop'),
    path.join(home, 'Downloads'),
    path.join(home, 'Documents'),
    path.join(home, 'Pictures'),
    path.join(home, 'Videos'),
    path.join(home, 'Music'),
    path.join(home, 'OneDrive'),
    path.join(process.env.PUBLIC || '', 'Desktop'),
    path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(process.env.ProgramData || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  ];
  const looksLikeApp = names.some((name) => /\.(exe|lnk)$/i.test(name));
  const appRoots = looksLikeApp
    ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
    : [];
  return [...userRoots, ...appRoots].filter((root) => root && fs.existsSync(root));
}

function findUniqueWindowsApps(names, metas = []) {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const matches = new Map();
  const skip = new Set(['windowsapps', 'common files', 'windows defender advanced threat protection']);
  const deadline = Date.now() + 3500;
  let seen = 0;

  function walk(dir, depth) {
    if (depth > 5 || Date.now() > deadline || seen > 12000) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (seen > 12000 || Date.now() > deadline) return;
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      const key = entry.name.toLowerCase();
      if (entry.isDirectory()) {
        if (skip.has(key)) continue;
        if (wanted.has(key)) {
          const list = matches.get(key) || [];
          list.push(full);
          matches.set(key, list);
        }
        walk(full, depth + 1);
        continue;
      }
      seen += 1;
      if (!wanted.has(key)) continue;
      const list = matches.get(key) || [];
      list.push(full);
      matches.set(key, list);
    }
  }

  for (const root of windowsSearchRoots(names)) walk(root, 0);
  const found = [];
  for (const name of names) {
    const list = narrowByMeta(matches.get(name.toLowerCase()) || [], metas);
    if (list.length === 1) found.push(list[0]);
  }
  return found;
}

async function pickPaths(kind) {
  if (process.platform === 'darwin') {
    const script = kind === 'application'
      ? 'POSIX path of (choose application with prompt "Add an application to Shelf")'
      : 'POSIX path of (choose file with prompt "Add a file to Shelf")';
    try {
      const { stdout } = await execFileAsync('osascript', ['-e', script], {
        timeout: 300000,
        encoding: 'utf8',
      });
      const picked = stdout.trim();
      return picked ? [picked] : null;
    } catch (error) {
      if (isCancel(error)) return null;
      throw new HttpError(400, 'Finder could not open the picker');
    }
  }
  if (process.platform === 'win32') return pickWindowsPaths(kind);
  throw new HttpError(400, 'The file picker is not available on this system. Paste a path instead.');
}

async function pickWindowsPaths(kind) {
  const outFile = path.join(os.tmpdir(), `shelf-pick-${process.pid}-${Date.now()}.txt`);
  const startMenu = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const initial = kind === 'application' && fs.existsSync(startMenu)
    ? startMenu
    : (process.env.ProgramFiles || 'C:\\Program Files');
  const script = `
    Add-Type -AssemblyName System.Windows.Forms
    $owner = New-Object System.Windows.Forms.Form
    $owner.TopMost = $true
    $owner.ShowInTaskbar = $false
    $owner.FormBorderStyle = 'None'
    $owner.Opacity = 0
    $owner.Width = 1
    $owner.Height = 1
    $owner.Show()
    $owner.Activate()
    $dialog = New-Object System.Windows.Forms.OpenFileDialog
    $dialog.Title = $env:SHELF_TITLE
    $dialog.Filter = $env:SHELF_FILTER
    $dialog.Multiselect = $true
    $dialog.CheckFileExists = $true
    $dialog.RestoreDirectory = $true
    if ($env:SHELF_INITIAL -and (Test-Path -LiteralPath $env:SHELF_INITIAL)) {
      $dialog.InitialDirectory = $env:SHELF_INITIAL
    }
    $ok = $dialog.ShowDialog($owner)
    $owner.Close()
    if ($ok -ne [System.Windows.Forms.DialogResult]::OK) { exit 0 }
    $utf8 = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllLines($env:SHELF_OUT, $dialog.FileNames, $utf8)
  `;
  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
      timeout: 300000,
      windowsHide: true,
      env: {
        ...process.env,
        SHELF_OUT: outFile,
        SHELF_TITLE: kind === 'application' ? 'Add an application to Shelf' : 'Add a file to Shelf',
        SHELF_FILTER: kind === 'application'
          ? 'Applications (*.exe, *.lnk)|*.exe;*.lnk|All files (*.*)|*.*'
          : 'All files (*.*)|*.*',
        SHELF_INITIAL: initial,
      },
    });
    if (!fs.existsSync(outFile)) return null;
    const picked = fs.readFileSync(outFile, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return picked.length ? picked : null;
  } catch (error) {
    if (isCancel(error)) return null;
    throw new HttpError(400, 'Windows could not open the file picker');
  } finally {
    fs.rmSync(outFile, { force: true });
  }
}

function revealOnWindows(filePath) {
  const explorer = path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe');
  const target = String(filePath).replace(/"/g, '');
  return new Promise((resolve, reject) => {
    const child = spawn(explorer, [`/select,"${target}"`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      windowsVerbatimArguments: true,
    });
    child.once('error', (error) => {
      if (error.code === 'ENOENT') {
        reject(new HttpError(500, 'File Explorer is not available'));
        return;
      }
      reject(error);
    });
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

async function launch(filePath, reveal) {
  if (process.platform === 'darwin') {
    await execFileAsync('open', reveal ? ['-R', filePath] : [filePath], { timeout: 15000 });
    return;
  }
  if (process.platform === 'win32') {
    if (reveal) {
      await revealOnWindows(filePath);
      return;
    }
    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "$target = $env:SHELF_TARGET; if ($target.ToLower().EndsWith('.lnk')) { Start-Process -FilePath $target } else { Start-Process -FilePath $target -WorkingDirectory (Split-Path -Parent $target) }",
    ], {
      timeout: 20000,
      windowsHide: true,
      env: { ...process.env, SHELF_TARGET: filePath },
    });
    return;
  }
  await execFileAsync('xdg-open', [reveal ? path.dirname(filePath) : filePath], { timeout: 15000 });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new HttpError(413, 'Request is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function assertBrowserSafe(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    throw new HttpError(403, 'Cross-site request blocked');
  }
  const origin = req.headers.origin;
  if (!origin) return;
  let allowed = false;
  try {
    const url = new URL(origin);
    allowed = (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
      && url.protocol === 'http:'
      && url.port === String(server.address()?.port || PREFERRED_PORT);
  } catch {
    allowed = false;
  }
  if (!allowed) throw new HttpError(403, 'Cross-origin request blocked');
}

function contentType(filePath) {
  switch (path.extname(filePath)) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.ico': return 'image/x-icon';
    default: return 'application/octet-stream';
  }
}

function serveStatic(urlPath, res) {
  const requested = decodeURIComponent(urlPath.split('?')[0]);
  const relative = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');
  if (PACKAGED) {
    if (relative.includes('..') || relative.includes('/') || relative.includes('\\')) {
      throw new HttpError(403, 'Forbidden');
    }
    const assets = globalThis.SHELF_PUBLIC_ASSETS;
    if (!assets || !Object.hasOwn(assets, relative)) throw new HttpError(404, 'Not found');
    const body = Buffer.from(assets[relative], 'utf8');
    res.writeHead(200, {
      'Content-Type': contentType(relative),
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
    return;
  }
  const root = path.resolve(PUBLIC_DIR);
  const full = path.resolve(root, relative);
  if (full !== root && !full.startsWith(`${root}${path.sep}`)) {
    throw new HttpError(403, 'Forbidden');
  }
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    throw new HttpError(404, 'Not found');
  }
  const body = fs.readFileSync(full);
  res.writeHead(200, {
    'Content-Type': contentType(full),
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

async function waitForIcon(id) {
  const file = iconFile(id);
  const started = Date.now();
  while (Date.now() - started < 3500) {
    if (fs.existsSync(file)) return file;
    if (!pendingIcons.has(id)) return null;
    await new Promise((resolve) => setTimeout(resolve, 70));
  }
  return fs.existsSync(file) ? file : null;
}

const server = http.createServer(async (req, res) => {
  try {
    assertBrowserSafe(req);
    const url = new URL(req.url, `http://${req.headers.host || HOST}`);
    const { pathname } = url;

    if (req.method === 'GET' && pathname === '/api/items') {
      sendJson(res, 200, listPayload());
      return;
    }

    if (req.method === 'POST' && pathname === '/api/items') {
      const body = await readBody(req);
      const inputs = Array.isArray(body.paths) ? body.paths : body.path ? [body.path] : [];
      if (!inputs.length) throw new HttpError(400, 'Drop or paste a path to add it');
      sendJson(res, 200, addPaths(inputs));
      return;
    }

    if (req.method === 'POST' && pathname === '/api/quit') {
      sendJson(res, 200, { ok: true });
      setTimeout(() => shutdown(0), 50);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/pasteboard/capture') {
      const paths = await captureDragPasteboard();
      sendJson(res, 200, { paths });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/drop') {
      const body = await readBody(req);
      const { files, names, clientPaths } = parseDropFiles(body);
      if (captureInflight) await captureInflight;
      const pasteboardPaths = await readDragPaths();
      let resolved = reconcileDrop(clientPaths, names, pasteboardPaths, files);
      if (!resolved.length && process.platform === 'win32' && names.length) {
        resolved = findUniqueWindowsApps(names, files).filter((filePath) => fs.existsSync(filePath));
      }
      if (!resolved.length) {
        const example = process.platform === 'win32'
          ? 'Use Add, or paste a path such as C:\\Program Files\\App\\App.exe.'
          : 'Use Add, or paste the path.';
        sendJson(res, 200, {
          added: [],
          existing: [],
          errors: [`Could not read a file path from that drop. ${example}`],
        });
        return;
      }
      sendJson(res, 200, addPaths(resolved));
      return;
    }

    if (req.method === 'POST' && pathname === '/api/pick') {
      const body = await readBody(req);
      const kind = body.kind === 'file' ? 'file' : 'application';
      const picked = await pickPaths(kind);
      if (!picked?.length) {
        sendJson(res, 200, { cancelled: true, added: [], existing: [], errors: [] });
        return;
      }
      sendJson(res, 200, { cancelled: false, ...addPaths(picked) });
      return;
    }

    const iconMatch = pathname.match(/^\/api\/items\/(\d+)\/icon$/);
    if (req.method === 'GET' && iconMatch) {
      const id = parseId(iconMatch[1]);
      getItem(id);
      const file = await waitForIcon(id);
      if (!file) {
        sendJson(res, 404, { error: 'No icon yet' });
        return;
      }
      const body = fs.readFileSync(file);
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': body.length,
        'Cache-Control': 'no-cache',
      });
      res.end(body);
      return;
    }

    const itemMatch = pathname.match(/^\/api\/items\/(\d+)$/);
    if (itemMatch) {
      const id = parseId(itemMatch[1]);
      if (req.method === 'PATCH') {
        const body = await readBody(req);
        const row = getItem(id);
        const alias = Object.hasOwn(body, 'alias') ? cleanAlias(body.alias) : row.alias;
        const pinned = Object.hasOwn(body, 'pinned') ? (body.pinned ? 1 : 0) : row.pinned;
        db.prepare('UPDATE items SET alias = ?, pinned = ? WHERE id = ?').run(alias, pinned, id);
        sendJson(res, 200, serialize(getItem(id)));
        return;
      }
      if (req.method === 'DELETE') {
        getItem(id);
        db.prepare('DELETE FROM items WHERE id = ?').run(id);
        pruneTags();
        fs.rmSync(iconFile(id), { force: true });
        sendJson(res, 200, { ok: true });
        return;
      }
    }

    const tagMatch = pathname.match(/^\/api\/items\/(\d+)\/tags$/);
    if (req.method === 'POST' && tagMatch) {
      const id = parseId(tagMatch[1]);
      getItem(id);
      const body = await readBody(req);
      const name = cleanTag(body.name);
      const count = db.prepare('SELECT COUNT(*) AS n FROM item_tags WHERE item_id = ?').get(id).n;
      if (count >= 16) throw new HttpError(400, 'This item already has 16 tags');
      const found = db.prepare('SELECT id FROM tags WHERE name = ? COLLATE NOCASE').get(name);
      const tagId = found
        ? found.id
        : Number(db.prepare('INSERT INTO tags (name) VALUES (?)').run(name).lastInsertRowid);
      db.prepare('INSERT OR IGNORE INTO item_tags (item_id, tag_id) VALUES (?, ?)').run(id, tagId);
      sendJson(res, 200, serialize(getItem(id)));
      return;
    }

    const untagMatch = pathname.match(/^\/api\/items\/(\d+)\/tags\/(\d+)$/);
    if (req.method === 'DELETE' && untagMatch) {
      const id = parseId(untagMatch[1]);
      const tagId = parseId(untagMatch[2]);
      getItem(id);
      db.prepare('DELETE FROM item_tags WHERE item_id = ? AND tag_id = ?').run(id, tagId);
      pruneTags();
      sendJson(res, 200, serialize(getItem(id)));
      return;
    }

    const todosMatch = pathname.match(/^\/api\/items\/(\d+)\/todos$/);
    if (req.method === 'POST' && todosMatch) {
      const id = parseId(todosMatch[1]);
      getItem(id);
      const body = await readBody(req);
      const text = cleanTodo(body.text);
      const count = db.prepare('SELECT COUNT(*) AS n FROM item_todos WHERE item_id = ?').get(id).n;
      if (count >= 40) throw new HttpError(400, 'This item already has 40 to-dos');
      const nextPos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS n FROM item_todos WHERE item_id = ?').get(id).n;
      db.prepare('INSERT INTO item_todos (item_id, text, position) VALUES (?, ?, ?)').run(id, text, nextPos);
      sendJson(res, 200, serialize(getItem(id)));
      return;
    }

    const todoMatch = pathname.match(/^\/api\/items\/(\d+)\/todos\/(\d+)$/);
    if (todoMatch) {
      const id = parseId(todoMatch[1]);
      const todoId = parseId(todoMatch[2]);
      getItem(id);
      if (req.method === 'PATCH') {
        const body = await readBody(req);
        const row = getTodo(id, todoId);
        const text = Object.hasOwn(body, 'text') ? cleanTodo(body.text) : row.text;
        const done = Object.hasOwn(body, 'done') ? (body.done ? 1 : 0) : row.done;
        db.prepare('UPDATE item_todos SET text = ?, done = ? WHERE id = ? AND item_id = ?').run(text, done, todoId, id);
        sendJson(res, 200, serialize(getItem(id)));
        return;
      }
      if (req.method === 'DELETE') {
        getTodo(id, todoId);
        db.prepare('DELETE FROM item_todos WHERE id = ? AND item_id = ?').run(todoId, id);
        sendJson(res, 200, serialize(getItem(id)));
        return;
      }
    }

    const openMatch = pathname.match(/^\/api\/items\/(\d+)\/open$/);
    if (req.method === 'POST' && openMatch) {
      const row = getItem(parseId(openMatch[1]));
      if (!fs.existsSync(row.path)) throw new HttpError(404, 'That file is no longer there');
      await launch(row.path, false);
      db.prepare(`UPDATE items SET opened_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(row.id);
      sendJson(res, 200, serialize(getItem(row.id)));
      return;
    }

    const revealMatch = pathname.match(/^\/api\/items\/(\d+)\/reveal$/);
    if (req.method === 'POST' && revealMatch) {
      const row = getItem(parseId(revealMatch[1]));
      if (!fs.existsSync(row.path)) throw new HttpError(404, 'That file is no longer there');
      await launch(row.path, true);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (req.method === 'HEAD') {
        res.writeHead(200);
        res.end();
        return;
      }
      serveStatic(pathname, res);
      return;
    }

    throw new HttpError(405, 'Method not allowed');
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof HttpError ? error.message : 'Something went wrong';
    if (status === 500) console.error(error);
    if (!res.headersSent) sendJson(res, status, { error: message });
  }
});

function openInBrowser(address) {
  if (process.platform === 'darwin') {
    execFile('open', [address], () => {});
    return;
  }
  if (process.platform === 'win32') {
    execFile('powershell.exe', ['-NoProfile', '-Command', 'Start-Process $env:SHELF_URL'], {
      windowsHide: true,
      env: { ...process.env, SHELF_URL: address },
    }, () => {});
    return;
  }
  execFile('xdg-open', [address], () => {});
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('error', onError);
      reject(error);
    };
    server.once('error', onError);
    server.listen(port, HOST, () => {
      server.off('error', onError);
      resolve(port);
    });
  });
}

async function isShelfServer(port) {
  try {
    const response = await fetch(`http://${HOST}:${port}/api/items`, {
      headers: { 'X-Shelf': '1' },
      signal: AbortSignal.timeout(800),
    });
    if (!response.ok) return false;
    const data = await response.json();
    return Array.isArray(data.items) && typeof data.platform === 'string';
  } catch {
    return false;
  }
}

function shutdown(code = 0) {
  try { server.close(); } catch { /* already closed */ }
  try { db.close(); } catch { /* already closed */ }
  process.exit(code);
}

async function main() {
  backfillIcons();
  let port = PREFERRED_PORT;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    try {
      port = await listen(PREFERRED_PORT + attempt);
      break;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      const used = PREFERRED_PORT + attempt;
      if (PACKAGED && await isShelfServer(used)) {
        const address = `http://${HOST}:${used}`;
        printConsoleHints(address, true);
        if (process.env.SHELF_NO_OPEN !== '1') openInBrowser(address);
        await new Promise((resolve) => setTimeout(resolve, 400));
        process.exit(0);
      }
      if (attempt === 14) throw error;
    }
  }
  const address = `http://${HOST}:${port}`;
  printConsoleHints(address);
  if (process.env.SHELF_NO_OPEN !== '1') openInBrowser(address);
}

function isMainModule() {
  if (PACKAGED) return true;
  if (!process.argv[1]) return false;
  return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

if (isMainModule()) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
