/**
 * Local LLM (Ollama) settings for natural-language search. Stored in
 * CONFIG_DIR/llm.json (editable in 설정 → AI 검색), falling back to env. Only the
 * query INTERPRETATION goes to the LLM; the actual data never leaves the portal.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { makeJsonFileReader } from '../util/jsonFileRead.js';   // 107회차: 읽기 오류 ≠ 손상(공용 읽기 — 30초 간격 재읽기)
import { ssrfBlockReason } from '../util/ssrfBlock.js';
import { numOrNull } from '../util/numOrNull.js';
import { reqTimeoutMs } from '../agent/envTimeout.js';
import { parseJsonObject } from '../util/jsonObject.js'; // v3.17.2: 객체가 아닌 JSON(수 · 글자 · 배열)은 깨진 JSON 과 같이 — 손상 보존 경로로

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

/**
 * 71회차(67회차 반증 — 재현): 이미 저장된 사용 여부도 로드에서 불리언으로. 67회차는 **저장** 만 불리언으로 좁혀 옛 파일(손으로 고친
 * `"enabled": "false"` 등)은 그대로 남았다 — 자연어 검색 · ChatOps · 상태 점검(참/거짓)은 켜짐, 설정 현황 · 링크 점검(=== true)은 꺼짐으로
 * 여전히 갈렸고, 화면은 불러온 값을 그대로 다시 보내 **어떤 저장도 400** 이 됐다. 글자 'true'(대소문자 · 앞뒤 공백 무시)만 켜짐, 그 밖은 꺼짐.
 */
export function normLlmEnabled(v) {
  if (typeof v === 'boolean') return v;
  return typeof v === 'string' && v.trim().toLowerCase() === 'true';
}

/*
 * 107회차(재현 — EISDIR): 읽기 오류(EACCES · EIO · EISDIR)는 손상이 아니다 — 예전 catch 하나는 온전한 원본을 .corrupt 로 옮기고 빈 값 · 기본값을 캐시해
 *   다음 저장이 원본 자리를 덮었다. 읽기 단계는 공용 읽기: 원본을 두고 · 캐시하지 않고(30초 간격 재읽기) · 저장을 거절한다(503 settingsUnreadable). parse 실패는 예전과 같다.
 */
const _reader = makeJsonFileReader(() => FILE, { parse: (t) => t, preserve: false, tag: 'llm' });
let _readErr = '';
/** 107회차: 읽기 오류 중의 저장 거절 본문(503) 또는 null. */
export function llmConfigWriteRefusal() {
  loadLlmConfig();
  return _readErr ? { ok: false, status: 503, code: 'settingsUnreadable', readError: true, reason: `AI 검색(LLM) 설정 파일(${path.basename(FILE)})을 읽지 못해 저장하지 않았습니다 — 읽기 오류(${_readErr})이고 원본은 그대로 있습니다. 파일 권한 · 소유자 · 디스크를 확인하세요(30초마다 다시 읽고, 읽히면 저장이 다시 열립니다).` } : null;
}
let _lastSaved = null;   // 107회차: 마지막으로 읽은 값 — 읽기 오류 동안 env 기본값(꺼짐 · localhost)으로 뒤집히지 않게
export function loadLlmConfig() {
  let saved = {};
  const rr = _reader.read();
  if (rr.kind === 'read-error') { _readErr = String(rr.error?.code || 'read-error').slice(0, 32); saved = _lastSaved || {}; }
  else {
    _readErr = '';
    try { if (rr.kind === 'ok') saved = parseJsonObject(rr.value); } catch (e) { preserveCorrupt(FILE, e.message); saved = {}; } // v2.479(감사 S-9)
    _lastSaved = saved;
  }
  const merged = { ...DEFAULTS, ...saved };
  // 이미 저장된 문자열·범위 밖 값도 로드에서 복구한다(저장 경로만 고치면 옛 파일이 계속 검색을 막는다).
  merged.timeoutMs = normTimeoutMs(merged.timeoutMs) ?? DEFAULTS.timeoutMs;
  merged.enabled = normLlmEnabled(merged.enabled);
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
  { const no = llmConfigWriteRefusal(); if (no) throw Object.assign(new Error(no.reason), no, { extra: { code: no.code, readError: true } }); }   // 107회차: 읽기 오류 중에는 빈 값 · 기본값 위에 쓰지 않는다

  // 주소를 **바꿀 때만** 검증한다 — 이미 저장된 주소로 다른 항목(사용 여부·모델)을 바꾸는 저장까지 막지 않는다.
  if (partial.url !== undefined && String(partial.url).trim() !== String(cur.url || '').trim()) {
    const why = llmUrlIssue(partial.url);
    if (why) { const e = new Error(why); e.status = 400; throw e; }
  }
  // 67회차 개선: 형식을 본다 — 예전에는 아무 값이나 그대로 저장했다. 'enabled' 가 문자열 "false" 면 자연어 검색 · ChatOps · 상태 점검(참/거짓으로 읽는다)은
  //   켜짐으로, 설정 현황(settingsStatus — === true)은 꺼짐으로 읽어 두 판정이 갈렸다.
  const bad = (msg) => { const e = new Error(msg); e.status = 400; return e; };
  if (partial.enabled !== undefined && typeof partial.enabled !== 'boolean') throw bad('사용 여부(enabled)는 true 또는 false 여야 합니다.');
  if (partial.provider !== undefined && typeof partial.provider !== 'string') throw bad('LLM 제공자는 글자여야 합니다.');
  // eslint-disable-next-line no-control-regex
  if (partial.model !== undefined && (typeof partial.model !== 'string' || !/^[^\s\u0000-\u001f\u007f]{1,200}$/.test(partial.model.trim()))) throw bad('모델 이름은 공백 없는 200자 이하 글자여야 합니다(예: llama3.1:8b).');
  if (partial.url !== undefined && typeof partial.url !== 'string') throw bad('LLM 주소는 글자여야 합니다.');
  const next = { ...cur };
  for (const k of ['enabled', 'provider', 'url', 'model']) if (partial[k] !== undefined) next[k] = typeof partial[k] === 'string' ? partial[k].trim() : partial[k];
  // v2.606 TIM2606-01: 빈 칸·잘못된 값은 미지정 → 이전 값 유지(명시적인 양수만 값이다).
  if (partial.timeoutMs !== undefined) next.timeoutMs = normTimeoutMs(partial.timeoutMs) ?? cur.timeoutMs;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  atomicWriteFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  try { fs.chmodSync(FILE, 0o600); } catch { /* mode는 신규생성 시에만 적용 — 덮어쓰기에도 0600 보장 */ }
  return next;
}
