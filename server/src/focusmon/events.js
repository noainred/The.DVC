/**
 * focusmon/events.js — 사건 표시(v3.13.0 ⑭ B3 — 시안 History · 컨펌 ⑥ '직접 적는 사건: 관리자 · 전체 쓰기 범위 · 30일 · 감사').
 *
 *  · 자동 사건: 재부팅(가동 시간이 줄어듦 · 시각은 켜진 시각) · 키 로그인 거부 · 호스트키 승인 필요(store.queueEvent — 'connecting' 을 뺀 안정 상태가 바뀐 순간만) ·
 *    수집 시작 · 끝 · 더함 · 뺌(store 가 서버마다 적는다 — 업그레이드 전 수집은 fm_run 에서 만든다).
 *    OOM 은 ⑯ 에서 더한다.
 *  · 직접 적는 사건: 이 서버 · 그 서버의 그룹 · 그 서버가 든 수집 전체 — **적는 때 대상들로 펴서** 서버마다 한 줄(같은 id). 대상 상한 `SCOPE_MAX`.
 *    글은 300자 · 제어 글자는 공백 · 앞뒤 공백 정리 · 빈 글 거절 · 시각은 지금 ±30일 안(미래 1시간까지).
 *  · 화면에는 번호(시각 순)를 붙여 차트 위 표시와 목록을 잇는다.
 */
import crypto from 'node:crypto';
import * as db from './db.js';
import * as store from './store.js';

export const SCOPE_MAX = 200;
export const TEXT_MAX = 300;
export const SCOPES = Object.freeze(['server', 'group', 'session']);
export const EVENT_TEXT = Object.freeze({ reboot: '재부팅', auth: '키 로그인 거부', hostkey: '호스트키 승인 필요', start: '수집 시작', stop: '수집 끝', user: '직접 적음' });

/** 글 정리 — 제어 글자 → 공백 · 앞뒤 공백 · 상한. 비면 ''. */
export function cleanEventText(s) {
  let t = String(s ?? '').slice(0, TEXT_MAX * 2).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' '); // eslint-disable-line no-control-regex
  let a = 0; let b = t.length;
  while (a < b && t.charCodeAt(a) === 32) a += 1;
  while (b > a && t.charCodeAt(b - 1) === 32) b -= 1;
  t = t.slice(a, b);
  return t.length > TEXT_MAX ? t.slice(0, TEXT_MAX) : t;
}

/**
 * 직접 적는 사건 — 대상(서버 하나)을 기준으로 범위를 펴서 같은 id 로 서버마다 한 줄.
 * @param {{target:object, all:object[], scope:string, text:string, at?:number, by:string}} o  target = 등록부 대상 · all = 보이는 대상 전부
 * @returns {{ok:true, id:string, targets:string[]} | {ok:false, code:string, reason:string}}
 */
export function planUserEvent({ target, all = [], scope = 'server', text, at, by = '' }, now = Date.now()) {
  const t = cleanEventText(text);
  if (!t) return { ok: false, code: 'empty', reason: '사건 내용을 적어 주세요.' };
  const sc = SCOPES.includes(scope) ? scope : 'server';
  const when = at == null || at === '' ? now : Number(at);
  if (!Number.isFinite(when) || when < now - 30 * 86_400_000 || when > now + 3_600_000) return { ok: false, code: 'bad-at', reason: '시각은 지금부터 30일 앞 ~ 1시간 뒤 사이여야 합니다.' };
  let ids = [target.id];
  if (sc === 'group') {
    const g = String(target.group || '');
    if (!g) return { ok: false, code: 'no-group', reason: '이 서버는 그룹이 없습니다 — ‘이 서버’ 로 적으세요.' };
    ids = all.filter((x) => String(x.group || '').toLowerCase() === g.toLowerCase()).map((x) => x.id);
  } else if (sc === 'session') {
    const s = store.sessionOfTarget(target.id);
    if (!s) return { ok: false, code: 'no-session', reason: '이 서버는 지금 수집 중이 아닙니다 — ‘이 서버’ 로 적으세요.' };
    const vis = new Set(all.map((x) => x.id));
    ids = s.targets.filter((x) => vis.has(x));
  }
  ids = [...new Set(ids)].slice(0, SCOPE_MAX);
  return { ok: true, id: `ev-${crypto.randomBytes(6).toString('hex')}`, targets: ids, text: t, at: Math.round(when), scope: sc, by: String(by || '').slice(0, 64) };
}

/** 계획한 직접 사건을 쓴다(한 트랜잭션). */
export async function writeUserEvent(plan) {
  const rows = plan.targets.map((tid) => ({ kind: 'e', id: plan.id, target: tid, at: plan.at, ekind: 'user', text: plan.text, by: plan.by, scope: plan.scope }));
  return db.writeBlocks(rows);
}

/**
 * 대상 하나의 사건 [from, to] — 기록된 사건 + 수집 시작 · 끝(fm_run). 시각 순 · 번호.
 * @returns {Promise<{events: Array<{n, id, at, kind, label, text, by, scope, user:boolean}>, partial:boolean}>}
 */
export async function eventsFor(id, from, to) {
  const rows = await db.readEvents(id, from, to, 200);
  const runs = await db.listRuns(from - 31 * 86_400_000, 400);
  const out = [];
  const explicit = new Set(); // `${수집}:s|e` — 서버마다 적은 시작 · 끝이 있는 수집 · 종류
  for (const r of rows || []) {
    // 시작 · 더함은 누가 시작했는지를 싣는다 · 그 밖의 자동 사건에는 사람 이름이 없다
    out.push({ id: r.id, at: r.at, kind: r.kind, text: r.text, by: r.kind === 'user' || r.kind === 'start' ? r.by || '' : '', scope: r.scope || 'server' });
    const m = /^run:([^:]+):([se]):/.exec(r.id); if (m) explicit.add(`${m[1]}:${m[2]}`);
  }
  // 서버마다 적은 시작 · 끝이 없는 것만 fm_run 에서 만든다(반증 F11) — **종류별로**(재검토 N5: 업그레이드 전에 시작해 지금 끝난 수집은 끝만 적혀 있어 시작 합성까지 건너뛰었다)
  for (const r of runs || []) {
    if (!Array.isArray(r.targets) || !r.targets.includes(id)) continue;
    const mode = r.mode === 'record' ? '계속 수집' : '잠깐 보기';
    if (!explicit.has(`${r.id}:s`) && r.started >= from && r.started <= to) out.push({ id: `run-${r.id}-s`, at: r.started, kind: 'start', text: `${mode} 시작(${r.interval}초)`, by: r.by || '', scope: 'session' });
    if (!explicit.has(`${r.id}:e`) && r.ended != null && r.ended >= from && r.ended <= to) out.push({ id: `run-${r.id}-e`, at: r.ended, kind: 'stop', text: `${mode} 끝`, by: '', scope: 'session' });
  }
  out.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  // 최근 200건(오래된 쪽을 자른다 — 반증 F2) · 번호는 남은 것의 시각 순
  const kept = out.length > 200 ? out.slice(out.length - 200) : out;
  return { events: kept.map((e, i) => ({ n: i + 1, ...e, label: EVENT_TEXT[e.kind] || e.kind, user: e.kind === 'user' })), partial: rows == null || runs == null, cut: out.length - kept.length };
}
