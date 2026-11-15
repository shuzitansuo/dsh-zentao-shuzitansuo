// Local, user-editable workbench settings.
//
// Stored outside the plugin checkout so credentials never end up in git:
//   $HOME/.dsh/zentao/workbench-settings.json
// Values override cordis.patch.yml defaults; blank password/API key means
// "keep the configured value" when saved from the settings dialog.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SETTINGS_DIR = path.join(os.homedir(), '.dsh', 'zentao');
const SETTINGS_PATH = path.join(SETTINGS_DIR, 'workbench-settings.json');
const FIELDS = ['baseUrl', 'account', 'password', 'deepseekApiKey', 'deepseekBaseUrl', 'deepseekModel'];

export function loadSettings(defaults = {}) {
  const merged = {};
  for (const field of FIELDS) merged[field] = String(defaults[field] || '');
  try {
    const saved = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
    if (saved && typeof saved === 'object') {
      for (const field of FIELDS) {
        if (typeof saved[field] === 'string' && saved[field]) merged[field] = saved[field];
      }
    }
  } catch (error) {
    /* first run or unreadable file */
  }
  return merged;
}

export function saveSettings(values = {}) {
  const current = loadSettings();
  const next = Object.assign({}, current);
  for (const field of FIELDS) {
    if (typeof values[field] === 'string' && values[field]) next[field] = values[field];
  }
  if (values.baseUrl) next.baseUrl = String(values.baseUrl).replace(/\/+$/, '');
  try {
    mkdirSync(SETTINGS_DIR, { recursive: true, mode: 0o700 });
    const temp = SETTINGS_PATH + '.tmp';
    writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    renameSync(temp, SETTINGS_PATH);
  } catch (error) {
    /* persistence failure must not break the panel */
  }
  return next;
}
