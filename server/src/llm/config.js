/**
 * Local LLM (Ollama) settings for natural-language search. Stored in
 * CONFIG_DIR/llm.json (editable in 설정 → AI 검색), falling back to env. Only the
 * query INTERPRETATION goes to the LLM; the actual data never leaves the portal.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { ssrfBlockReason } from '../util/ssrfBlock.js';

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
  try { if (fs.existsSync(FILE)) saved = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch (e) { preserveCorrupt(FILE, e.message); saved = {}; } // v2.479(감사 S-9)
  return { ...DEFAULTS, ...saved };
}

/**
 * v2.590 D6: LLM 주소 검증 — http(s) 만, SSRF 가드(링크로컬·메타데이터 169.254.x·우회 표기) 통과. 예전에는 저장·
 * 연결 테스트 모두 무검증이라 IP 리터럴(169.254.169.254)이 가드를 지나갔다(호스트명은 wanAgent lookup 이 막지만
 * IP 리터럴은 lookup 을 타지 않는다). 루프백은 이 저장소 전체 규약대로 SSRF_ALLOW_LOOPBACK=true 일 때만이며,
 * 거부 사유가 그 사실을 말한다(예전 기본값 localhost 는 원인 없이 'fetch failed' 로만 실패했다).
 * @returns {string|null} 거부 사유 또는 null
 */
export function llmUrlIssue(url) {
  const u = String(url || '').trim();
  if (!u) return 'LLM 주소가 비어 있습니다.';
  let parsed;
  try { parsed = new URL(u); } catch { return `LLM 주소 형식이 올바르지 않습니다: ${u}`; }
  if (!/^https?:$/.test(parsed.protocol)) return 'LLM 주소는 http:// 또는 https:// 여야 합니다.';
  return ssrfBlockReason(u);
}

export function saveLlmConfig(partial = {}) {
  const cur = loadLlmConfig();
  // 주소를 **바꿀 때만** 검증한다 — 이미 저장된 주소로 다른 항목(사용 여부·모델)을 바꾸는 저장까지 막지 않는다.
  if (partial.url !== undefined && String(partial.url).trim() !== String(cur.url || '').trim()) {
    const why = llmUrlIssue(partial.url);
    if (why) { const e = new Error(why); e.status = 400; throw e; }
  }
  const next = { ...cur };
  for (const k of ['enabled', 'provider', 'url', 'model', 'timeoutMs']) if (partial[k] !== undefined) next[k] = partial[k];
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  atomicWriteFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  try { fs.chmodSync(FILE, 0o600); } catch { /* mode는 신규생성 시에만 적용 — 덮어쓰기에도 0600 보장 */ }
  return next;
}
