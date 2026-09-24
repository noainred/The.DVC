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
import { numOrNull } from '../util/numOrNull.js';
import { reqTimeoutMs } from '../agent/envTimeout.js';

const FILE = path.join(config.configDir, 'llm.json');

const DEFAULTS = {
  enabled: process.env.LLM_ENABLED === 'true',
  provider: 'ollama',
  url: process.env.OLLAMA_URL || 'http://localhost:11434',
  model: process.env.OLLAMA_MODEL || 'llama3.1',
  timeoutMs: reqTimeoutMs(process.env.LLM_TIMEOUT_MS, 30000),   // v2.606 TIM2606-01: 음수·2^31 초과 env 차단
};

/**
 * v2.606(TIM2606-01): LLM 타임아웃 → [1초, 10분] 정수 ms, 빈 값·숫자 아님·0 이하면 null(= 미지정 → 이전 값).
 * 예전에는 화면이 보낸 문자열('60000')을 그대로 저장해 AbortSignal.timeout('60000') 이 ERR_INVALID_ARG_TYPE 을
 * 던졌다 — 칸을 한 번 고치면 자연어 검색·ChatOps·연결 테스트가 전부 실패했다(v2.601 AD normTimeoutMs 의 형제 누락).
 */
export function normTimeoutMs(v) {
  const n = numOrNull(v);
  if (n == null || n <= 0) return null;
  return Math.min(600_000, Math.max(1000, Math.round(n)));
}

export function loadLlmConfig() {
  let saved = {};
  try { if (fs.existsSync(FILE)) saved = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch (e) { preserveCorrupt(FILE, e.message); saved = {}; } // v2.479(감사 S-9)
  const merged = { ...DEFAULTS, ...saved };
  // 이미 저장된 문자열·범위 밖 값도 로드에서 복구한다(저장 경로만 고치면 옛 파일이 계속 검색을 막는다).
  merged.timeoutMs = normTimeoutMs(merged.timeoutMs) ?? DEFAULTS.timeoutMs;
  return merged;
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
  for (const k of ['enabled', 'provider', 'url', 'model']) if (partial[k] !== undefined) next[k] = partial[k];
  // v2.606 TIM2606-01: 빈 칸·잘못된 값은 미지정 → 이전 값 유지(명시적인 양수만 값이다).
  if (partial.timeoutMs !== undefined) next.timeoutMs = normTimeoutMs(partial.timeoutMs) ?? cur.timeoutMs;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  atomicWriteFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  try { fs.chmodSync(FILE, 0o600); } catch { /* mode는 신규생성 시에만 적용 — 덮어쓰기에도 0600 보장 */ }
  return next;
}
