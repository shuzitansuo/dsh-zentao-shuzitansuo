// Local usage ranking for ZenTao iterations.
//
// The chat target picker ("which iteration should receive this story/bug?")
// orders iterations by how often and how recently the user picked them, so a
// handful of everyday iterations stay at the top without any manual pinning.
//
// State lives in `$DSH_HOME/zentao/usage.json` and only records local choices —
// ZenTao itself is untouched.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const VERSION = 1;
const MAX_ENTRIES = 200;

export function createUsageStore(options = {}) {
  const stateDir = options.stateDir || path.join(os.homedir(), '.dsh', 'zentao');
  const statePath = path.join(stateDir, 'usage.json');
  let loaded = false;
  let dirty = false;
  let saving = null;
  const entries = new Map();

  async function load() {
    if (loaded) return;
    loaded = true;
    try {
      const raw = JSON.parse(await readFile(statePath, 'utf8'));
      if (raw && raw.entries && typeof raw.entries === 'object') {
        for (const [id, value] of Object.entries(raw.entries)) {
          const count = Number(value && value.count) || 0;
          const lastUsedAt = Number(value && value.lastUsedAt) || 0;
          if (!count && !lastUsedAt) continue;
          entries.set(String(id), {
            count,
            lastUsedAt,
            projectId: Number(value.projectId) || 0,
            executionName: String(value.executionName || ''),
            projectName: String(value.projectName || ''),
          });
        }
      }
    } catch (error) {
      // first run (or unreadable file): start empty
    }
  }

  async function flush() {
    if (saving) return saving;
    dirty = false;
    saving = (async () => {
      try {
        await mkdir(stateDir, { recursive: true });
        const trimmed = [...entries.entries()]
          .sort((a, b) => b[1].lastUsedAt - a[1].lastUsedAt)
          .slice(0, MAX_ENTRIES);
        const body = JSON.stringify({ version: VERSION, entries: Object.fromEntries(trimmed) }, null, 2);
        const tmp = statePath + '.tmp';
        await writeFile(tmp, body, 'utf8');
        await rename(tmp, statePath);
      } catch (error) {
        // persistence failures degrade to in-memory ranking only
      } finally {
        saving = null;
      }
    })();
    return saving;
  }

  /** Record one user choice of a target iteration. */
  async function record(target) {
    const executionId = Number(target && (target.executionId || target.id)) || 0;
    if (!executionId) return;
    await load();
    const id = String(executionId);
    const previous = entries.get(id) || { count: 0, lastUsedAt: 0 };
    entries.set(id, {
      count: Math.min(999, previous.count + 1),
      lastUsedAt: Date.now(),
      projectId: Number(target.projectId) || previous.projectId || 0,
      executionName: String(target.executionName || target.title || previous.executionName || ''),
      projectName: String(target.projectName || previous.projectName || ''),
    });
    dirty = true;
    return flush();
  }

  /** Read the ranking map: executionId -> {count, lastUsedAt, ...}. */
  async function rank() {
    await load();
    const out = {};
    for (const [id, value] of entries) out[id] = { ...value };
    return out;
  }

  return { record, rank, statePath };
}
