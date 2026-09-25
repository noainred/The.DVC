/**
 * portalcheck/toolCatalog.js — 배포된 특수 기능 카탈로그(`web/dist/special-tools.json`) 리더(v2.614).
 *
 * 왜: 아키텍처 점검(`archScan.js`)이 권한 키·toolcats 배치·라우트 게이트를 카탈로그와 대조하려면 **배포된
 * 서버가** 카탈로그를 읽어야 한다. 서버는 `web/src` 를 갖지 않는다(오프라인 패키지·업그레이드 번들은 `web/dist`
 * 만 담는다). 그래서 빌드가 `scripts/tools-catalog.mjs` 로 `web/public/special-tools.json` 을 생성하고 vite 가
 * `dist/` 로 복사한 것을 여기서 읽는다.
 *
 * 규약:
 *  · **없으면 추측하지 않는다** — 파일이 없거나(구버전 dist·dev 서버) 못 읽으면 `source:'missing'` + `reason` 이고
 *    호출부는 카탈로그 의존 항목을 **unknown** 으로 둔다(정상으로도 결함으로도 세지 않는다 — v2.548 규약).
 *  · **던지지 않는다** — 점검 라우트가 매달리지 않게(express 4 async throw, v2.548 S1). 모든 실패는 반환값이다.
 *  · 크기 상한 1MB(`CATALOG_MAX_BYTES`) — 생성물은 91개에 14KB 다. 넘으면 우리 파일이 아니다.
 *  · 모양 검증 — `{ generatedAt, count, tools:[{k,…}] }`. `tools` 가 배열이 아니거나 원소의 `k` 가 빈 문자열·중복이거나
 *    `count` 가 원소 수와 다르면 통째로 `missing`(`reason:'shape'`). 부분을 살리지 않는다 — 틀린 카탈로그로 판정하면
 *    '고아 키' 같은 거짓 결함을 만든다(v2.530 '틀린 값은 빈 값보다 나쁘다').
 *  · 원소는 계약 여섯 필드로 **좁혀서** 돌려준다(adminOnly/topTab/comingSoon 은 boolean, perm/external 은 string|null) —
 *    파일에 다른 필드가 있어도 새지 않는다.
 *  · `generatedAt` 은 **epoch ms 숫자**(못 읽으면 null)로 돌려준다(v2.562 '시각 표기는 epoch ms 하나').
 *    ⚠ 숫자 문자열은 `Date.parse` 에 넘기지 않는다(`Date.parse('12345')` 는 연도 12345 다).
 *  · `path` 는 절대 경로다 — 응답에 실을 때는 `scopeFilePaths` 규약(admin 전체 범위만)을 호출부가 적용한다.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

export const CATALOG_FILE = 'special-tools.json';
export const CATALOG_MAX_BYTES = 1_048_576;
/** 계약 필드 — `scripts/tools-catalog.mjs CATALOG_FIELDS` 와 같은 목록(테스트가 대조). */
export const CATALOG_FIELDS = Object.freeze(['k', 'adminOnly', 'perm', 'external', 'topTab', 'comingSoon']);

const strOrNull = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** 원소 하나를 계약 모양으로 좁힌다. k 가 비면 null. */
function narrowTool(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return null;
  const k = typeof t.k === 'string' ? t.k.trim() : '';
  if (!k) return null;
  return {
    k,
    adminOnly: t.adminOnly === true,
    perm: strOrNull(t.perm),
    external: strOrNull(t.external),
    topTab: t.topTab === true,
    comingSoon: t.comingSoon === true,
  };
}

function generatedAtMs(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
  if (typeof v !== 'string' || !v.trim() || /^\d+$/.test(v.trim())) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

const missing = (reason, file, extra = {}) => ({
  source: 'missing', reason, tools: [], count: 0, generatedAt: null, path: file, ...extra,
});

/**
 * 파싱된 객체를 검증·정규화한다(순수). 실패면 `{ ok:false, reason }`.
 * @returns {{ok:true, tools:Array, count:number, generatedAt:number|null} | {ok:false, reason:string, detail?:string}}
 */
export function validateCatalog(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, reason: 'shape', detail: '객체가 아닙니다' };
  if (!Array.isArray(obj.tools)) return { ok: false, reason: 'shape', detail: 'tools 가 배열이 아닙니다' };
  if (obj.tools.length === 0) return { ok: false, reason: 'shape', detail: 'tools 가 비어 있습니다' };
  const seen = new Set();
  const tools = [];
  for (let i = 0; i < obj.tools.length; i += 1) {
    const t = narrowTool(obj.tools[i]);
    if (!t) return { ok: false, reason: 'shape', detail: `tools[${i}] 의 k 가 비어 있습니다` };
    if (seen.has(t.k)) return { ok: false, reason: 'shape', detail: `k '${t.k}' 가 두 번 있습니다` };
    seen.add(t.k);
    tools.push(t);
  }
  if (obj.count !== undefined && obj.count !== tools.length) {
    return { ok: false, reason: 'shape', detail: `count(${obj.count})가 원소 수(${tools.length})와 다릅니다` };
  }
  return { ok: true, tools, count: tools.length, generatedAt: generatedAtMs(obj.generatedAt) };
}

/**
 * 배포된 카탈로그를 읽는다. **던지지 않는다.**
 * @param {{dir?:string}} [opts]  dir — 기본 `config.webDist`(테스트가 임시 디렉터리를 준다)
 * @returns {{source:'dist'|'missing', reason?:string, detail?:string, tools:Array, count:number, generatedAt:number|null, path:string|null}}
 */
export function readToolCatalog(opts = {}) {
  const dir = typeof opts?.dir === 'string' && opts.dir ? opts.dir : config.webDist;
  let file = null;
  try {
    file = path.join(dir, CATALOG_FILE);
  } catch (e) {
    return missing('path', null, { detail: String(e?.message || e) });
  }
  let st;
  try {
    st = fs.statSync(file);
  } catch (e) {
    return missing(e?.code === 'ENOENT' ? 'not-found' : 'stat', file, { detail: String(e?.code || e?.message || e) });
  }
  if (!st.isFile()) return missing('not-file', file);
  if (st.size > CATALOG_MAX_BYTES) return missing('too-large', file, { detail: `${st.size} bytes > ${CATALOG_MAX_BYTES}` });
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return missing('read', file, { detail: String(e?.code || e?.message || e) });
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    return missing('parse', file, { detail: String(e?.message || e).slice(0, 200) });
  }
  const v = validateCatalog(obj);
  if (!v.ok) return missing(v.reason, file, { detail: v.detail });
  return { source: 'dist', tools: v.tools, count: v.count, generatedAt: v.generatedAt, path: file };
}
