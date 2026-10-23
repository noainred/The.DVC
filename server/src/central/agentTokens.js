/**
 * 엣지(에이전트)별 개별 central 토큰 — 공유 CENTRAL_TOKEN 1개의 광역 스코프를 좁힌다.
 *
 * 문제(보안 점검): /api/central/* 은 단일 공유 CENTRAL_TOKEN만 검사하고 `?agent=` 는 호출자가
 * 임의로 지정한다. 그래서 토큰을 가진 엣지 한 곳(또는 토큰 유출)만으로 **다른 모든 사이트**의
 * iDRAC 평문 비번(/assignment)·게스트 SSH 비번(/gpu-guest-config)·사용자 passwordHash
 * (/users-config)를 agent 이름만 바꿔 전부 인출할 수 있었다(엣지 1대 침해 → 전 플릿 BMC 장악).
 *
 * 해결: 엣지별 개별 토큰을 발급해 '토큰 ↔ agent'를 바인딩한다. 개별 토큰으로 인증한 요청은
 * 자기 agent의 데이터만 조회할 수 있고, 남의 이름을 지정하면 403이다.
 *
 * 엣지 측 코드 변경이 필요 없다 — 엣지는 이미 이 값을 `X-Central-Token` 헤더로 보내므로,
 * 그 엣지의 CENTRAL_TOKEN(EDGE_TOKEN) 값만 개별 토큰으로 바꿔주면 된다. 따라서 사이트별로
 * 하나씩 점진 이관할 수 있고, 이관 전 엣지는 공유 토큰으로 계속 동작한다(무중단).
 *
 * 저장: CONFIG_DIR/central-agent-tokens.json (0600, 원자적 쓰기). 토큰 원문은 저장하지 않고
 * SHA-256 해시만 보관한다(파일이 유출돼도 토큰을 복원할 수 없다). 발급 시 1회만 평문을 보여준다.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, safeLoadText } from '../util/atomicWrite.js';
import { capStr } from '../util/capStr.js';
import { makeLoadError, summarizeRegistryError } from '../util/registryCore.js'; // v2.771(점검 R6-F4-2): '읽지 못함' 표지

const FILE = path.join(config.configDir, 'central-agent-tokens.json');
const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest();
const norm = (a) => String(a || '').trim().toLowerCase();

let cache = null; // [{ agent, hash(hex), createdAt, lastUsedAt, note }]

/**
 * v2.771(점검 R6-F4-2): 토큰 파일을 **읽지 못했다**는 사실. 예전에는 손상/읽기 오류면 rename 뒤 cache=[] 를 프로세스 수명 동안 고정해
 *   관리 화면이 '0개 발급' 으로 보였고(발급 없음과 구분 불가), 개별 토큰 엣지는 전부 '토큰 불일치' 403, 공유 토큰이 없으면 'central 비활성화' 404 였다.
 *   이제 표지를 두고(관리 화면·getCentralAuthStats·central 게이트 503 이 읽는다), 표지가 선 동안은 캐시를 고정하지 않고 파일이
 *   다시 나타나면(사람이 보존본을 되돌림) 다시 읽는다. 첫 설치(파일·보존본 모두 없음)는 오류가 아니다. 해제는 정상 읽기·관리자 발급/회수 저장뿐.
 */
const loadErr = makeLoadError();

function load() {
  if (cache && !loadErr.get()) return cache;
  let exists = false;
  try { exists = fs.existsSync(FILE); } catch { exists = false; }
  if (!exists) {
    // 표지가 선 채 파일이 없으면(보존본으로 옮겨진 뒤) 빈 목록 그대로 — 매 요청 existsSync 1회뿐이다.
    if (!cache) { loadErr.checkCorruptOnly(FILE); cache = []; }
    return cache;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cache = Array.isArray(parsed?.tokens) ? parsed.tokens.filter((t) => t && t.agent && t.hash) : [];
    loadErr.clear();
    return cache;
  } catch (e) {
    // 손상 파일을 조용히 빈 값으로 덮어쓰면 전 엣지 토큰이 유실된다 → 보존 후 경고.
    // v2.744(최종 수정분 검토 RV2744F-LOAD-01): 사유는 요약(safeLoadText) — V8 JSON.parse 오류 원문은 파일 조각을 싣는다(콘솔 → /admin/logs·엣지 로그).
    try { fs.renameSync(FILE, `${FILE}.corrupt.${Date.now()}`); } catch { /* */ }
    console.error(`[central-token] central-agent-tokens.json 파싱 실패(${safeLoadText(e) || '사유 미상'}) — 손상본을 .corrupt로 보존했습니다. 개별 토큰 인증은 보존본을 되돌리거나 토큰을 다시 발급할 때까지 503 으로 답합니다.`);
    loadErr.set(e);
  }
  cache = [];
  return cache;
}

function save() {
  // v2.771(R6-F4-2): 다시 읽지 않고 메모리 목록(cache — 발급·회수·touch 가 고친 것)을 쓴다. 표지가 선 동안 load() 는 파일을 다시 읽으므로
  //   보존 rename 이 실패해 손상 파일이 남아 있으면 방금 발급한 항목이 빈 목록으로 덮였다.
  atomicWriteFileSync(FILE, JSON.stringify({ tokens: cache || load() }, null, 2), { mode: 0o600 });
  loadErr.clear(); // v2.771(R6-F4-2): 관리자 발급/회수 저장이 성공하면 그 목록이 진실이다(touch 는 해석된 항목이 있을 때만 — 읽지 못한 동안엔 없다)
}

/**
 * v2.771(R6-F4-2): 토큰 파일을 읽지 못했으면 **요약**(원문 없음), 아니면 null. 관리 화면·central 게이트가 '발급 없음' 과 가른다.
 * @returns {null|{at:(number|null), code:(string|null), text:string}}
 */
export function agentTokensLoadError() {
  load();
  const e = loadErr.get();
  if (!e) return null;
  const s = summarizeRegistryError(e);
  return { at: Number.isFinite(e.at) ? e.at : null, code: s?.code || null, text: s?.text || '사유 미상' };
}

/** 개별 토큰이 하나라도 발급돼 있는가(있으면 per-agent 인증 경로가 활성). */
export function hasAnyAgentToken() { return load().length > 0; }

/** 관리 화면용 목록 — 해시/토큰은 절대 노출하지 않는다. */
export function listAgentTokens() {
  return load().map((t) => ({ agent: t.agent, createdAt: t.createdAt || null, lastUsedAt: t.lastUsedAt || null, note: t.note || '' }));
}

/**
 * 엣지용 토큰 발급(재발급 시 기존 것을 대체 — 회전). 평문은 이 반환값에서만 얻을 수 있다.
 * @returns {{ ok:boolean, agent?:string, token?:string, reason?:string }}
 */
export function issueAgentToken(agent, { note = '' } = {}) {
  const name = String(agent || '').trim();
  if (!name) return { ok: false, reason: '에이전트 이름이 필요합니다.' };
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) return { ok: false, reason: '에이전트 이름 형식이 올바르지 않습니다(영숫자·._- 64자 이내).' };
  const token = crypto.randomBytes(32).toString('base64url'); // 256bit — 공유 토큰보다 강하게
  const list = load();
  const i = list.findIndex((t) => norm(t.agent) === norm(name));
  const entry = { agent: name, hash: sha256(token).toString('hex'), createdAt: Date.now(), lastUsedAt: null, note: capStr(note || '', 200) }; // v2.607(TIM2607-01)
  if (i >= 0) list[i] = entry; else list.push(entry);
  save();
  return { ok: true, agent: name, token };
}

export function revokeAgentToken(agent) {
  const list = load();
  const next = list.filter((t) => norm(t.agent) !== norm(agent));
  if (next.length === list.length) return { ok: false, reason: `발급된 토큰이 없습니다: ${agent}` };
  cache = next;
  save();
  return { ok: true };
}

// lastUsedAt 갱신은 요청마다 디스크를 쓰면 안 된다(엣지 28대 × 여러 엔드포인트 × 60초 주기 =
// 초당 수 회 쓰기). 에이전트별 60초 스로틀로 묶는다.
const TOUCH_MS = 60_000;
function touch(entry) {
  const now = Date.now();
  if (entry.lastUsedAt && now - entry.lastUsedAt < TOUCH_MS) return;
  entry.lastUsedAt = now;
  try { save(); } catch { /* 사용시각 기록 실패는 인증에 영향 없음 */ }
}

/**
 * 제시된 토큰이 어느 엣지의 개별 토큰인지 해석. 상수시간 비교(해시 32바이트 고정)로,
 * 등록된 항목 전부를 순회해도 일치 위치가 타이밍으로 새지 않는다.
 * @returns {string|null} agent 이름(원래 표기) 또는 null
 */
export function resolveAgentByToken(token) {
  const t = String(token || '');
  if (!t) return null;
  const h = sha256(t);
  let found = null;
  for (const e of load()) {
    let stored;
    try { stored = Buffer.from(String(e.hash), 'hex'); } catch { continue; }
    if (stored.length !== h.length) continue;
    // 첫 일치에서 break 하지 않는다 — 조기 종료는 '몇 번째에서 맞았는지'를 타이밍으로 노출한다.
    if (crypto.timingSafeEqual(stored, h)) found = e;
  }
  if (!found) return null;
  touch(found);
  return found.agent;
}

/** 테스트용 — 캐시를 비워 파일을 다시 읽게 한다. */
export function _resetAgentTokenCache() { cache = null; loadErr.clear(); }
