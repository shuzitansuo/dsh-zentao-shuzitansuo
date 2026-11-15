// Self-update helper: checks a JSON manifest and installs a plugin zip in place.
//
// Manifest format (hosted anywhere reachable from the DSH machine):
//   { "version": "0.0.3", "url": "https://.../dsh-zentao.zip",
//     "notes": "更新说明", "sha256": "可选，防篡改" }
//
// The zip may wrap the plugin in one top-level folder (the packaged share zip
// does); the folder containing package.json is treated as the plugin root.
// cordis.patch.yml (user config, credentials) is never overwritten.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_PATHS = new Set(['cordis.patch.yml', 'package-lock.json', 'pnpm-lock.yaml']);
const MAX_ARCHIVE_BYTES = 30 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30000;

export function parseVersion(value) {
  const match = String(value || '').match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return match ? [Number(match[1]) || 0, Number(match[2]) || 0, Number(match[3]) || 0] : [0, 0, 0];
}

function githubApiUrl(url) {
  const match = String(url || '').match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
  if (!match) return '';
  return 'https://api.github.com/repos/' + match[1] + '/' + match[2] + '/contents/' + match[4] + '?ref=' + match[3];
}

function withCacheBust(url) {
  return url + (url.includes('?') ? '&' : '?') + 't=' + Date.now();
}

export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'dsh-zentao-updater', 'cache-control': 'no-cache' } });
    if (!res.ok) throw new Error('更新服务器返回 HTTP ' + res.status);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

export async function currentVersion() {
  try {
    const pkg = JSON.parse(await readFile(path.join(PLUGIN_ROOT, 'package.json'), 'utf8'));
    return String(pkg.version || '0.0.0');
  } catch (error) {
    return '0.0.0';
  }
}

export async function checkForUpdate({ updateUrl } = {}) {
  const url = String(updateUrl || '').trim();
  if (!url) throw new Error('未配置更新地址（请在插件配置中设置 updateUrl）');
  let manifest;
  const readManifest = async (target) => {
    const res = await fetchText(withCacheBust(target));
    const data = await res.json();
    // GitHub Contents API returns { content: base64, encoding: "base64" }.
    if (data && typeof data.content === 'string' && data.encoding === 'base64') {
      return JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
    }
    return data;
  };
  try {
    manifest = await readManifest(url);
  } catch (firstError) {
    // raw.githubusercontent.com is often unreachable; fall back to the GitHub API.
    const fallback = githubApiUrl(url);
    if (!fallback) {
      const reason = firstError && firstError.cause && firstError.cause.code ? ' (' + firstError.cause.code + ')' : '';
      throw new Error('检查更新失败：' + (firstError && firstError.message ? firstError.message : String(firstError)) + reason);
    }
    try {
      manifest = await readManifest(fallback);
    } catch (error) {
      const reason = error && error.cause && error.cause.code ? ' (' + error.cause.code + ')' : '';
      throw new Error('检查更新失败：' + (error && error.message ? error.message : String(error)) + reason);
    }
  }
  const version = String((manifest && manifest.version) || '').replace(/^v/i, '').trim();
  const downloadUrl = String((manifest && (manifest.url || manifest.downloadUrl)) || '').trim();
  if (!version || !downloadUrl) throw new Error('更新清单格式不正确（需要 version 和 url）');
  if (!/^https?:\/\//i.test(downloadUrl)) throw new Error('更新下载地址必须是 http(s) URL');
  const current = await currentVersion();
  return {
    current,
    latest: version,
    hasUpdate: compareVersions(version, current) > 0,
    notes: String((manifest && manifest.notes) || ''),
    sha256: String((manifest && manifest.sha256) || '').trim(),
    downloadUrl,
    source: url,
  };
}

function safeEntryName(name) {
  const normalized = String(name || '').replace(/\\/g, '/');
  if (!normalized || normalized.endsWith('/')) return '';
  if (normalized.startsWith('/') || normalized.includes('..')) return '';
  return normalized;
}

function readZipEntries(buffer) {
  let eocd = -1;
  const min = Math.max(0, buffer.length - 66000);
  for (let i = buffer.length - 22; i >= min; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('更新包不是有效的 zip 文件');
  const count = buffer.readUInt16LE(eocd + 10);
  let pointer = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(pointer) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(pointer + 10);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const uncompressedSize = buffer.readUInt32LE(pointer + 24);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.slice(pointer + 46, pointer + 46 + nameLength).toString('utf8');
    const safeName = safeEntryName(name);
    pointer += 46 + nameLength + extraLength + commentLength;
    if (!safeName) continue;
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) continue;
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.slice(dataStart, dataStart + compressedSize);
    let content;
    if (method === 0) content = data;
    else if (method === 8) content = zlib.inflateRawSync(data);
    else continue;
    if (uncompressedSize && content.length > uncompressedSize + 1024) continue;
    entries.push({ name: safeName, data: content });
  }
  return entries;
}

export async function applyUpdateBuffer(buffer, { sha256 } = {}) {
  if (buffer.length > MAX_ARCHIVE_BYTES) throw new Error('更新包过大（超过 30MB）');
  if (sha256) {
    const digest = createHash('sha256').update(buffer).digest('hex');
    if (digest.toLowerCase() !== sha256.toLowerCase()) throw new Error('更新包校验失败（sha256 不匹配）');
  }
  const entries = readZipEntries(buffer);
  const pkgEntry = entries
    .filter((entry) => entry.name === 'package.json' || entry.name.endsWith('/package.json'))
    .sort((a, b) => a.name.length - b.name.length)[0];
  if (!pkgEntry) throw new Error('更新包里找不到 package.json');
  const rootPrefix = pkgEntry.name.slice(0, pkgEntry.name.length - 'package.json'.length);
  let version = '0.0.0';
  try {
    version = String(JSON.parse(pkgEntry.data.toString('utf8')).version || '0.0.0');
  } catch (error) {
    /* keep fallback */
  }
  if (compareVersions(version, await currentVersion()) <= 0) {
    throw new Error('更新包版本不高于当前版本');
  }
  const written = [];
  for (const entry of entries) {
    if (rootPrefix && !entry.name.startsWith(rootPrefix)) continue;
    const relative = rootPrefix ? entry.name.slice(rootPrefix.length) : entry.name;
    if (!relative || SKIP_PATHS.has(relative)) continue;
    if (relative.startsWith('node_modules/') || relative.startsWith('.git/') || relative.includes('/node_modules/')) continue;
    const target = path.join(PLUGIN_ROOT, relative);
    if (!target.startsWith(PLUGIN_ROOT + path.sep)) continue;
    await mkdir(path.dirname(target), { recursive: true });
    const temp = target + '.update-tmp';
    await writeFile(temp, entry.data);
    await rename(temp, target);
    written.push(relative);
  }
  return { version, files: written.length };
}

export async function applyUpdate({ downloadUrl, sha256 } = {}) {
  const url = String(downloadUrl || '').trim();
  if (!url) throw new Error('缺少更新包地址');
  const readBuffer = async (target) => {
    const res = await fetchText(withCacheBust(target));
    if (target.includes('api.github.com')) {
      const data = await res.json();
      if (data && typeof data.content === 'string' && data.encoding === 'base64') {
        return Buffer.from(data.content, 'base64');
      }
      throw new Error('更新包下载失败：GitHub API 返回了非文件内容');
    }
    return Buffer.from(await res.arrayBuffer());
  };
  let buffer;
  try {
    buffer = await readBuffer(url);
  } catch (firstError) {
    const fallback = githubApiUrl(url);
    if (!fallback) {
      const reason = firstError && firstError.cause && firstError.cause.code ? ' (' + firstError.cause.code + ')' : '';
      throw new Error('下载更新包失败：' + (firstError && firstError.message ? firstError.message : String(firstError)) + reason);
    }
    buffer = await readBuffer(fallback);
  }
  return await applyUpdateBuffer(buffer, { sha256 });
}
