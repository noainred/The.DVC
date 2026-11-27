/**
 * bmusage/keyDecisions.js — 다음 점검 ①(2차 · 사용자 결정 2026-11-08) **식별 키가 겹치는 서버의 수집 여부 결정** 저장소(`bm-key-decisions.json`).
 *
 * 왜: 같은 노드에서 식별 키(dk = 서비스태그 소문자 || serverId)가 겹치는 둘째 서버는 분류(classifyFleet)가 bareMetal 에 넣지 않고,
 *   가상화 호스트는 같은 키의 대상이 있으면 건너뛴다 — 예전에는 그 서버가 대상에도 ‘대상이 아닌 서버’ 에도 없었다(조용한 제외 · 반증 F1).
 *   이제 그 서버를 ‘식별 키가 겹치는 서버’ 로 보이고, 사용자가 **‘수집에 추가’**(겹치지 않는 별도 키 `<법인>:<serverId>` 로 수집) 또는
 *   **‘제외 유지’**(그대로 수집하지 않음 — 확인했다는 기록)를 고른다. 결정을 지우면(되돌리기) 처음 상태(결정 없음 = 수집 안 함)다.
 * 파일 스토어 규약(perf-db.md v2.582 · compareSets.js 와 같다): 원자 쓰기(0600) · 손상이면 보존(preserveCorrupt) 후 **읽기 503 · 쓰기 거부**
 *   (빈 목록으로 덮어 다른 결정을 지우지 않는다) · 쓰기는 **직렬 큐** 안의 한 동기 구간(load → 수정 → 쓰기 · await 없음).
 *   ⚠ 못 읽으면 결정을 하나도 적용하지 않는다(별도 키로 수집하던 서버도 그동안 수집하지 않는다 — 모르는 키로 적재하지 않는 쪽 · 화면이 사유를 말한다).
 * 권한 · 범위 · 감사는 라우트(routes/api/bmKeyOverlaps.js)가 본다 — 이 모듈은 형식과 저장만.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { makeSettingsLoadError } from '../util/settingsLoadError.js';

const FILE = () => path.join(config.configDir, 'bm-key-decisions.json');
export const DECISIONS = Object.freeze(['add', 'exclude']);
export const DECISIONS_MAX = 2_000;
const CTRL_RE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;
const t = (v) => (typeof v === 'string' ? v.replace(CTRL_RE, '').trim() : (typeof v === 'number' && Number.isFinite(v) ? String(v) : ''));

const _err = makeSettingsLoadError(FILE, { label: '베어메탈 사용률 식별 키 겹침 결정', confirm: () => writeAll({ v: 1, items: [] }) });
function fail(status, code, reason) { const e = new Error(reason); e.status = status; e.code = code; return e; }
function writeAll(obj) { atomicWriteFileSync(FILE(), JSON.stringify(obj, null, 2), { mode: 0o600 }); _err.ok(); }

/**
 * 결정의 별도 키(순수) — `<법인>:<serverId>`(가상화 호스트는 `<법인>:host:<이름>` · 귀속 없음은 `-`).
 *   보통 키(서비스태그 대문자 · dk 소문자 · serverId)는 법인 id 와 ‘:’ 로 시작하지 않으므로 겹치지 않는다(겹치면 라우트가 409).
 */
export function decidedKeyOf({ role = 'bm', vcenterId = '', serverId = '', name = '' } = {}) {
  const vc = t(vcenterId) || '-';
  const id = role === 'virt' ? `host:${t(name)}` : (t(serverId) || `name:${t(name)}`);
  return `${vc}:${id}`.slice(0, 256);
}
/** 겹친 서버 하나의 식별(순수) — 결정 파일의 열쇠. 같은 서버가 다른 법인으로 옮겨 가면 다른 열쇠다(그 결정은 적용되지 않고 다시 고른다). */
export function overlapIdOf({ role = 'bm', vcenterId = '', serverId = '', name = '' } = {}) {
  return role === 'virt' ? `virt|${t(vcenterId)}|${t(name)}`.slice(0, 400) : `bm|${t(vcenterId)}|${t(serverId) || `name:${t(name)}`}`.slice(0, 400);
}

function cleanRec(r) {
  if (!r || typeof r !== 'object') return null;
  const oid = t(r.oid).slice(0, 400);
  const decision = DECISIONS.includes(r.decision) ? r.decision : '';
  if (!oid || !decision) return null;
  const key = decision === 'add' ? t(r.key).slice(0, 256) : '';
  if (decision === 'add' && !key) return null;
  return { oid, decision, ...(key ? { key } : {}), role: r.role === 'virt' ? 'virt' : 'bm', vcenterId: t(r.vcenterId).slice(0, 128), serverId: t(r.serverId).slice(0, 256),
    name: t(r.name).slice(0, 256), serviceTag: t(r.serviceTag).slice(0, 128), by: t(r.by).slice(0, 64), at: Number(r.at) || 0 };
}
/** 동기 로드 — 손상이면 보존 후 throw(503). 파일 없음은 빈 목록(보존본만 남은 ‘못 읽음’ 이면 throw). */
function loadAll() {
  let raw;
  try { raw = fs.readFileSync(FILE(), 'utf8'); }
  catch (e) {
    if (e?.code !== 'ENOENT') throw fail(503, 'settingsUnreadable', '식별 키 겹침 결정 파일을 읽지 못했습니다.');
    _err.missing();
    if (_err.get()) throw fail(503, 'settingsUnreadable', _err.get().reason);
    return { v: 1, items: [] };
  }
  try {
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object' || Array.isArray(o) || !Array.isArray(o.items)) throw new Error('형식이 다릅니다');
    _err.ok();
    return { v: 1, items: o.items.map(cleanRec).filter(Boolean).slice(0, DECISIONS_MAX) };
  } catch (e) {
    preserveCorrupt(FILE(), String(e?.message || e));
    _err.corrupt(e);
    console.warn('[bmusage] bm-key-decisions.json 을 읽지 못했습니다 — 손상본을 보존했고, 확정 전까지 결정 적용 · 저장을 멈춥니다');
    throw fail(503, 'settingsUnreadable', _err.get()?.reason || '식별 키 겹침 결정 파일을 읽지 못했습니다.');
  }
}

/** 결정 전체(oid → 결정). 못 읽으면 { ok:false, error }(호출부가 결정을 하나도 적용하지 않고 사유를 싣는다). */
export function readKeyDecisions() {
  try { const all = loadAll(); return { ok: true, map: new Map(all.items.map((r) => [r.oid, r])) }; }
  catch (e) { return { ok: false, map: new Map(), error: { status: e?.status || 503, code: e?.code || 'settingsUnreadable', reason: String(e?.message || e).slice(0, 200) } }; }
}

// 직렬 큐 — 쓰기는 한 번에 하나(같은 프로세스의 동시 요청이 서로의 저장을 덮지 않는다). 큐 안은 동기 구간(load → 수정 → 쓰기).
let _q = Promise.resolve();
function enqueue(fn) { const p = _q.then(fn, fn); _q = p.then(() => {}, () => {}); return p; }

/**
 * 결정 저장(새로 · 바꿈). rec = { oid, decision, key?(add), role, vcenterId, serverId, name, serviceTag }. 반환 { ok, rec, prev }.
 *   ⚠ 키 겹침 검사는 호출부(현재 대상 키를 아는 라우트)가 하고, 여기서는 **다른 결정의 키와** 겹치지 않는지만 본다.
 */
export function setKeyDecision(rec, { by = '', now = Date.now() } = {}) {
  return enqueue(() => {
    const r = cleanRec({ ...rec, by, at: now });
    if (!r) throw fail(400, 'bad-request', '결정 형식이 다릅니다(수집에 추가 · 제외 유지 중 하나).');
    const all = loadAll();
    const i = all.items.findIndex((x) => x.oid === r.oid);
    if (r.decision === 'add' && all.items.some((x) => x.oid !== r.oid && x.decision === 'add' && x.key === r.key)) throw fail(409, 'key-taken', '그 키는 다른 결정이 이미 씁니다.');
    if (i < 0 && all.items.length >= DECISIONS_MAX) throw fail(409, 'cap', `결정은 ${DECISIONS_MAX}건까지입니다.`);
    const prev = i >= 0 ? all.items[i] : null;
    if (i >= 0) all.items[i] = r; else all.items.push(r);
    writeAll(all);
    return { ok: true, rec: r, prev };
  });
}
/** 결정 지우기(되돌리기 — 결정 없음 = 수집 안 함). 없으면 404. */
export function clearKeyDecision(oid) {
  return enqueue(() => {
    const id = t(oid);
    const all = loadAll();
    const i = all.items.findIndex((x) => x.oid === id);
    if (i < 0) throw fail(404, 'not-found', '그 결정을 찾지 못했습니다.');
    const [prev] = all.items.splice(i, 1);
    writeAll(all);
    return { ok: true, prev };
  });
}
export function keyDecisionsLoadError() { try { loadAll(); } catch { /* get 이 말한다 */ } return _err.get(); }
export function _resetKeyDecisionsForTest() { _err.ok(); _q = Promise.resolve(); }
