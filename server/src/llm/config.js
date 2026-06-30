/**
 * Local LLM (Ollama) settings for natural-language search. Stored in
 * CONFIG_DIR/llm.json (editable in 설정 → AI 검색), falling back to env. Only the
 * query INTERPRETATION goes to the LLM; the actual data never leaves the portal.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const FILE = path.join(config.configDir, 'llm.json');

const DEFAULTS = {
  enabled: process.env.LLM_ENABLED === 'true',
  provider: 'ollama',
  url: process.env.OLLAMA_URL || 'http://localhost:11434',
  model: process.env.OLLAMA_MODEL || 'llama3.1',
  timeoutMs: Number(process.env.LLM_TIMEOUT_MS) || 30000,
};

export function loadLlmConfig() {
  let saved = {};
  try { if (fs.existsSync(FILE)) saved = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { saved = {}; }
  return { ...DEFAULTS, ...saved };
}

export function saveLlmConfig(partial = {}) {
  const cur = loadLlmConfig();
  const next = { ...cur };
  for (const k of ['enabled', 'provider', 'url', 'model', 'timeoutMs']) if (partial[k] !== undefined) next[k] = partial[k];
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  try { fs.chmodSync(FILE, 0o600); } catch { /* mode는 신규생성 시에만 적용 — 덮어쓰기에도 0600 보장 */ }
  return next;
}
