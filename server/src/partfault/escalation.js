/**
 * partfault/escalation.js — 부품 장애 알림 **단계 올리기 · 당직**(v3.51 · 설계 docs/design/bm-feature-proposals ⑪).
 *
 *  · 대상은 **부품 장애 알림**만(다른 알림 규칙은 지금처럼 한 번 간다). 기본은 **꺼짐** — 전체 범위 관리자가 켠다.
 *  · ‘바로’ 단계는 지금 알림(partfault/notify.js — 파트당 1건 즉시)이다. 여기 단계는 **확인(ack)이 없을 때** 정해 둔 분이 지나면
 *    더 보낸다: 적은 메일 주소 · 알림 채널(설정 › 알림의 Slack · Teams · 웹훅 · 메일) · 그 수집 주체(법인 엣지)의 **이번 주 당직**(요일별 이름 · 메일).
 *  · 확인하면 그 장애의 단계 올리기가 멈춘다(부품 장애 화면 ‘확인’ — 전체 범위 · 운영자 이상 · 감사). 장애가 닫히면 기록을 지운다.
 *  · 켠 시점 전부터 열려 있던 장애는 **켠 때부터** 시간을 센다(켜자마자 옛 장애에 단계 알림이 쏟아지지 않게).
 *    엔진이 꺼져 있던 동안 여러 단계가 지났으면 **가장 높은 단계 하나만** 보낸다(낮은 단계는 건너뜀으로 적는다).
 *  · 한 번 도는 동안 보내는 수에 상한(ESC_SENDS_PER_RUN) — 넘친 것은 다음 회차로(조용히 버리지 않는다 · 수를 남긴다).
 *  · 법인 축은 **수집 주체**(부품 장애의 agent — '' = 이 포탈 · 엣지 이름)다. 부품 장애에는 vCenter 법인이 없다(설계와 다른 점 — README §13 에 적는다).
 *  · 요일은 **이 포탈 서버의 시각**으로 정한다(법인 현지 시각이 아니다 — 화면이 밝힌다).
 *
 * 파일: partfault-escalation.json(설정 — 백업 · 복원 그대로) · partfault-escalation-state.json(진행 기록 — 복원 때 지금 것 유지: 되돌리면 보낸 단계를 다시 보낸다).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { makeJsonFileLoader } from '../util/jsonFileLoad.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { readJsonFile } from '../util/jsonFileRead.js';
import { registerStateFile } from '../util/stateFiles.js';
import { numOrNull } from '../util/numOrNull.js';
import { localClock } from '../util/dayKey.js';

export const ESC_POLICIES_MAX = 20;
export const ESC_STEPS_MAX = 4;
export const ESC_EMAILS_MAX = 10;
export const ESC_AFTER_MIN = 5;          // 단계 사이 최소 분
export const ESC_AFTER_MAX = 1440;       // 하루
export const ESC_SENDS_PER_RUN = 20;
export const ESC_ITEMS_MAX = 5000;
export const ESC_STATES = Object.freeze(['fault', 'warn']);
export const ESC_DAYS = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
const DAY_KO = ['월', '화', '수', '목', '금', '토', '일'];
export const ESC_ALL = '*';              // 당직 · 정책의 ‘모든 수집 주체’

const SETTINGS_FILE = () => path.join(config.configDir, 'partfault-escalation.json');
const STATE_NAME = registerStateFile('partfault-escalation-state.json');
const STATE_FILE = () => path.join(config.configDir, 'partfault-escalation-state.json');

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const EMAIL_RE = /^[^\s@<>()",;]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const isEmail = (v) => typeof v === 'string' && v.length <= 254 && EMAIL_RE.test(v);
/**
 * 수집 주체 이름 — 소문자 · 64자 · '' = 이 포탈 · '*' = 모두. 엣지 등록 이름은 trim 만 하므로(collector/registry.js) 한글 · 공백도 받는다(반증 A18) —
 * 제어 문자 · 쉼표 · 세미콜론(화면 구분자) · 객체 원형 이름(__proto__ · constructor · prototype)은 받지 않는다. 글자가 아니면 null.
 */
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
export function agentKeyOf(v) {
  if (typeof v !== 'string') return null;
  const x = v.trim().toLowerCase();
  if (x === ESC_ALL) return ESC_ALL;
  if (x.length > 64 || RESERVED_KEYS.has(x) || /[\u0000-\u001f\u007f,;]/.test(x)) return null;
  return x;
}

/** 빈 설정 — 꺼짐 · 정책 없음 · 당직 없음. */
export const emptyEscalation = () => ({ v: 1, enabled: false, enabledAt: null, policies: [], oncall: {}, at: null, by: '' });

/**
 * 설정 꼴(읽을 때 — 모르는 값은 버린다 · 꼴이 다르면 빈 값). 저장 검증은 normalizeEscalation(더 엄격 — 사유를 돌려준다).
 */
export function escalationShape(d) {
  const out = emptyEscalation();
  if (!isObj(d)) return out;
  out.enabled = d.enabled === true;
  out.enabledAt = numOrNull(d.enabledAt);
  out.at = numOrNull(d.at); out.by = str(d.by, 80);
  const r = normalizeEscalation({ policies: d.policies, oncall: d.oncall, enabled: d.enabled === true }, { lenient: true });
  if (r.ok) { out.policies = r.value.policies; out.oncall = r.value.oncall; }
  return out;
}

/**
 * 저장할 설정 검증(순수). lenient = 읽기(틀린 줄은 버린다) · 아니면 첫 오류의 사유를 돌려준다(저장 거절).
 * @returns {{ ok:true, value:{ enabled:boolean, policies:Array, oncall:object } } | { ok:false, reason:string }}
 */
export function normalizeEscalation(body, { lenient = false } = {}) {
  const b = isObj(body) ? body : {};
  const fail = (reason) => ({ ok: false, reason });
  const policies = [];
  const src = Array.isArray(b.policies) ? b.policies : [];
  if (!lenient && src.length > ESC_POLICIES_MAX) return fail(`정책은 ${ESC_POLICIES_MAX}개까지입니다.`);
  const ids = new Set();
  for (const [pi, p] of src.slice(0, ESC_POLICIES_MAX).entries()) {
    const where = `정책 ${pi + 1}`;
    if (!isObj(p)) { if (lenient) continue; return fail(`${where}: 형식이 아닙니다.`); }
    let id = str(p.id, 40);
    if (!/^[a-z0-9-]{1,40}$/.test(id) || ids.has(id)) { let n = pi + 1; id = `p${n}`; while (ids.has(id)) { n += 1; id = `p${n}`; } }   // 대체 id 도 겹치지 않게(반증 A13)
    ids.add(id);
    const name = str(p.name, 80) || `정책 ${pi + 1}`;
    const agents = [];
    const agentSrc = Array.isArray(p.agents) ? p.agents : [];
    if (!lenient && agentSrc.length > 64) return fail(`${where}: 수집 주체는 64개까지입니다.`);
    for (const a of agentSrc.slice(0, 64)) {
      const k = agentKeyOf(a);
      if (k == null) { if (lenient) continue; return fail(`${where}: 수집 주체 이름이 틀렸습니다(64자 · 쉼표 · 세미콜론 · 제어 문자 없이).`); }
      if (k === ESC_ALL) { if (!lenient && agentSrc.length > 1) return fail(`${where}: ‘모두(*)’ 는 다른 수집 주체와 함께 줄 수 없습니다(비우면 모두).`); continue; }   // 조용히 버리지 않는다(디버깅 1회차 판정 #11)
      if (!agents.includes(k)) agents.push(k);
    }
    const stateSrc = Array.isArray(p.states) ? p.states : [];
    if (!lenient && stateSrc.some((x) => !ESC_STATES.includes(x))) return fail(`${where}: 모르는 대상 상태가 있습니다(이상 · 주의만).`);
    const states = stateSrc.filter((x) => ESC_STATES.includes(x));
    if (!states.length) { if (lenient) continue; return fail(`${where}: 대상 상태(이상 · 주의)를 하나 이상 고르십시오.`); }
    const steps = [];
    let prev = 0;
    for (const [si, s] of (Array.isArray(p.steps) ? p.steps : []).slice(0, ESC_STEPS_MAX + (lenient ? 0 : 1)).entries()) {
      const sw = `${where} · ${si + 2}단계`;   // 1단계 = 지금 알림(바로) — 화면과 같은 표기(반증 B9)
      if (!lenient && si >= ESC_STEPS_MAX) return fail(`${where}: 단계는 ${ESC_STEPS_MAX}개까지입니다.`);
      if (!isObj(s)) { if (lenient) continue; return fail(`${sw}: 형식이 아닙니다.`); }
      const after = numOrNull(s.afterMin);
      if (after == null || !Number.isInteger(after) || after < ESC_AFTER_MIN || after > ESC_AFTER_MAX || after <= prev) {
        if (lenient) continue;
        return fail(`${sw}: 몇 분 뒤인지는 ${ESC_AFTER_MIN}~${ESC_AFTER_MAX} 의 정수이고 앞 단계보다 커야 합니다.`);
      }
      const emails = [];
      // 중복을 먼저 지우고 개수를 본다 — 앞에서 자른 뒤 지우면 마지막 주소가 조용히 빠졌다(반증 A13)
      for (const e of Array.isArray(s.emails) ? s.emails.slice(0, 200) : []) {
        const x = str(e, 254);
        if (!x) continue;
        if (!isEmail(x)) { if (lenient) continue; return fail(`${sw}: 메일 주소가 틀렸습니다 — ${x.slice(0, 60)}`); }
        if (!emails.includes(x)) emails.push(x);
      }
      if (!lenient && emails.length > ESC_EMAILS_MAX) return fail(`${sw}: 메일 주소는 ${ESC_EMAILS_MAX}개까지입니다.`);
      const channels = s.channels === true; const oncall = s.oncall === true;
      if (!emails.length && !channels && !oncall) { if (lenient) continue; return fail(`${sw}: 받는 곳(메일 주소 · 알림 채널 · 당직)을 하나 이상 고르십시오.`); }
      steps.push({ afterMin: after, emails: emails.slice(0, ESC_EMAILS_MAX), channels, oncall });
      prev = after;
    }
    if (!steps.length) { if (lenient) continue; return fail(`${where}: 단계가 하나도 없습니다.`); }
    policies.push({ id, name, agents, states, steps });
  }
  const oncall = Object.create(null);
  const oc = isObj(b.oncall) ? b.oncall : {};
  if (!lenient && Object.keys(oc).length > 128) return fail('당직표는 128개까지입니다.');
  for (const [k, v] of Object.entries(oc).slice(0, 128)) {
    const ak = agentKeyOf(k);
    if (ak == null || !isObj(v) || !Array.isArray(v.days)) { if (lenient) continue; return fail(`당직표: 수집 주체 ‘${String(k).slice(0, 40)}’ 의 형식이 틀렸습니다.`); }
    if (!lenient && Object.hasOwn(oncall, ak)) return fail(`당직표: 수집 주체 ‘${ak === ESC_ALL ? '모두' : ak || '이 포탈'}’ 의 표가 둘 이상입니다(대소문자만 다른 이름 포함).`);   // 뒤 것만 남기지 않는다(판정 #11)
    const days = [];
    for (let i = 0; i < 7; i += 1) {
      const d = isObj(v.days[i]) ? v.days[i] : {};
      const name = str(d.name, 60); const email = str(d.email, 254);
      if (email && !isEmail(email)) { if (lenient) { days.push({ name, email: '' }); continue; } return fail(`당직표 ${ak === ESC_ALL ? '모두' : ak || '이 포탈'} · ${DAY_KO[i]}요일: 메일 주소가 틀렸습니다.`); }
      days.push({ name, email });
    }
    if (days.some((d) => d.name || d.email)) oncall[ak] = { days };
  }
  if (!lenient && b.enabled === true && !policies.length) return fail('켜려면 정책이 하나 이상 있어야 합니다.');
  return { ok: true, value: { enabled: b.enabled === true, policies, oncall: { ...oncall } } };
}

// ───────── 저장소 ─────────
// 모르는 꼴(객체가 아님 · 모르는 판 번호)은 손상이다 — 빈 설정으로 덮지 않고 쓰기를 막는다
const parseSettings = (text) => { const v = JSON.parse(text); if (!isObj(v)) throw new Error('형식이 아닙니다(객체여야 합니다)'); if (v.v !== undefined && v.v !== 1) throw new Error('이 판이 모르는 파일 판 번호입니다'); return v; };
const _settingsFile = makeJsonFileLoader(SETTINGS_FILE, { label: '부품 장애 알림 단계 · 당직 설정', tag: 'partfault-escalation', parse: parseSettings, confirm: () => escalationStore._confirm() });
let _cache = null;
export const escalationStore = {
  get() {
    if (_cache && !_settingsFile.recheckDue()) return _cache;
    const r = _settingsFile.load();
    if (r.kind === 'read-error') return emptyEscalation();
    _cache = r.kind === 'ok' ? escalationShape(r.value) : emptyEscalation();
    return _cache;
  },
  loadError: () => { escalationStore.get(); return _settingsFile.loadError(); },
  refusal: (what = '부품 장애 알림 단계 · 당직 설정') => { escalationStore.get(); return _settingsFile.refusal(what); },
  /** body → 검증 → 저장. 켜는 순간을 enabledAt 으로 적는다(그 전부터 열린 장애는 이때부터 센다). */
  save(body, { by = '', now = Date.now() } = {}) {
    const refused = escalationStore.refusal();
    if (refused) return { ok: false, status: 409, ...refused };
    const n = normalizeEscalation(body);
    if (!n.ok) return { ok: false, status: 400, reason: n.reason };
    const cur = escalationStore.get();
    const enabledAt = n.value.enabled ? (cur.enabled && cur.enabledAt != null ? cur.enabledAt : now) : null;
    const next = { v: 1, ...n.value, enabledAt, at: now, by: String(by).slice(0, 80) };
    try { fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true }); atomicWriteFileSync(SETTINGS_FILE(), JSON.stringify(next, null, 2)); } catch (e) { return { ok: false, status: 500, reason: `설정 파일을 쓰지 못했습니다 — ${String(e?.code || e?.message || e).slice(0, 120)}` }; }
    _cache = escalationShape(next); _settingsFile.saved();
    return { ok: true, value: _cache, turnedOn: n.value.enabled && !cur.enabled, turnedOff: !n.value.enabled && cur.enabled };
  },
  _confirm() { atomicWriteFileSync(SETTINGS_FILE(), JSON.stringify(emptyEscalation(), null, 2)); _cache = null; _settingsFile.saved(); },
  _resetForTest() { _cache = null; _settingsFile.resetRetry(); },
};

// 진행 기록 — 장애(수집 주체|파트 키)마다 { since, sig, sent:[[단계 번호, 시각, 결과 글자, 종류]], ackedAt, ackBy }.
//   종류: ok(받는 곳 하나 이상에 감) · fail(시도했으나 안 감 — 다음 회차에 다시, ESC_RETRY_MAX 번까지) · skip(엔진이 멈춰 있던 동안 지남) · give(다시 시도 끝).
//   since = 엔진이 그 장애를 **정책 대상으로 처음 본 때**(켠 때 · 정책을 고친 때 · 상태가 바뀐 때 옛 장애에 쏟아지지 않게 — 반증 A2).
//   sig = 수집 주체|장비군|장비 id|종류|부품 id — 장비 키만 바뀐 같은 장애(migratedFrom)가 기록 · 확인을 이어받게(반증 A4).
export const ESC_RETRY_MAX = 3;
let _state = null; let _stateErr = ''; let _stateReadError = false;
const KINDS = ['ok', 'fail', 'skip', 'give'];
const itemShape = (x) => {
  if (!isObj(x)) return null;
  const since = numOrNull(x.since);
  if (since == null) return null;
  const sent = (Array.isArray(x.sent) ? x.sent : []).filter((e) => Array.isArray(e) && Number.isInteger(e[0]) && e[0] >= 0 && e[0] < ESC_STEPS_MAX).slice(0, ESC_STEPS_MAX * (ESC_RETRY_MAX + 2))
    .map((e) => [e[0], numOrNull(e[1]), typeof e[2] === 'string' ? e[2].slice(0, 120) : '', KINDS.includes(e[3]) ? e[3] : 'ok']);
  return { since, sig: str(x.sig, 400), sent, ackedAt: numOrNull(x.ackedAt), ackBy: str(x.ackBy, 80), pol: str(x.pol, 40) };
};
// 읽기 오류는 캐시하지 않는다 — 파일을 고치면 다음 재읽기(30초 간격)에 풀린다(v3.52 디버깅 1회차 성능 P4: 예전에는 재시작 전까지 멈췄다)
export const ESC_STATE_RETRY_MS = 30_000;
let _stateRetryAt = 0; let _stateErrUntil = 0;
export const ESC_STATE_NOTE_MS = 24 * 3600_000;
export function loadEscalationState(now = Date.now()) {
  if (_state) return _state;
  if (_stateReadError && now < _stateRetryAt) return { v: 1, items: {}, enabledAt: null };
  const items = {}; let enabledAt = null;
  // 읽기는 공용 판정(util/jsonFileRead.js) — 없음 · 읽기 오류 · 손상(보존은 공용이 한다)을 가른다(97회차 스윕)
  const r = readJsonFile(STATE_FILE(), { parse: (text) => { const d = JSON.parse(text); if (!isObj(d) || !isObj(d.items)) throw new Error('진행 기록 꼴이 아닙니다'); return d; } });
  if (r.kind === 'read-error') {
    // 읽기 오류(권한 등 — 없음이 아님)는 보내지도 쓰지도 않는다: 보낸 단계를 모르는 채 쓰면 원본을 덮고, 보내면 같은 단계를 매 회차 다시 보낸다(반증 A6)
    _stateReadError = true; _stateRetryAt = now + ESC_STATE_RETRY_MS;
    _stateErr = `진행 기록을 읽지 못해(${String(r.error?.code || 'error')}) 단계 알림을 멈췄습니다 — 파일 권한을 확인하십시오(고치면 ${ESC_STATE_RETRY_MS / 1000}초 안에 다시 읽습니다).`;
    return { v: 1, items: {}, enabledAt: null };
  }
  if (_stateReadError) { _stateReadError = false; _stateErr = ''; }   // 다시 읽혔다 — 멈춤 안내를 지운다
  if (r.kind === 'corrupt') {
    // 손상 — 공용이 옆으로 보존했다. 빈 기록으로 시작한다(새 기록은 since = 지금이라 열린 장애에 바로 쏟아지지 않는다 — 정한 분이 지난 뒤 2단계부터 다시)
    _stateErr = '진행 기록이 손상돼 보존본을 남기고 새로 시작했습니다 — 열린 장애는 지금부터 다시 셉니다(이미 보낸 2단계가 한 번 더 갈 수 있습니다).';
    _stateErrUntil = now + ESC_STATE_NOTE_MS;   // 손상 안내는 하루 보인다 — 재시작 전까지 남지 않게(성능 P4 ②) · 바로 지우면 아무도 못 본다
  } else if (r.kind === 'ok') {
    enabledAt = numOrNull(r.value.enabledAt);
    for (const [k, v] of Object.entries(r.value.items).slice(0, ESC_ITEMS_MAX)) { const it = itemShape(v); if (it && typeof k === 'string' && k.length <= 600) items[k] = it; }
  }
  _state = { v: 1, items, enabledAt };
  return _state;
}
export function saveEscalationState(st) {
  if (_stateReadError) return false;
  _state = st;
  try { fs.mkdirSync(path.dirname(STATE_FILE()), { recursive: true }); atomicWriteFileSync(STATE_FILE(), JSON.stringify(st)); return true; } catch { return false; }
}
export const escalationStateError = (now = Date.now()) => (_stateErr && (_stateReadError || now < _stateErrUntil) ? _stateErr : '');
export const escalationStateUnreadable = () => { loadEscalationState(); return _stateReadError; };
export function _resetEscalationStateForTest() { _state = null; _stateErr = ''; _stateReadError = false; _stateRetryAt = 0; _stateErrUntil = 0; }
export { STATE_NAME as ESC_STATE_FILE_NAME };

// ───────── 판정(순수) ─────────
export const partKeyOf = (p) => `${String(p?.agent || '').trim().toLowerCase()}|${String(p?.partKey || '')}`;
export const partSigOf = (p) => [String(p?.agent || '').trim().toLowerCase(), p?.scope, p?.deviceId, p?.kind, p?.partId].map((x) => String(x ?? '').slice(0, 120)).join('|');
/** 그 장애에 맞는 첫 정책(수집 주체 · 상태). 없으면 null. */
export function policyFor(settings, p) {
  const ag = String(p?.agent || '').trim().toLowerCase();
  for (const pol of settings?.policies || []) {
    if (!pol.states.includes(p?.state)) continue;
    if (pol.agents.length && !pol.agents.includes(ag)) continue;
    return pol;
  }
  return null;
}
/** 그 수집 주체의 오늘 당직(이 포탈 서버 시각의 요일) — 수집 주체 표 → ‘모두’ 표. 없으면 null. */
export function oncallFor(settings, agent, now = Date.now()) {
  // 요일은 포탈 지역 시계(DAY_OFFSET — 프로세스 TZ 가 아니다: 패키지 유닛은 TZ 를 정하지 않는다 · perf-db ‘스케줄은 localClock’ — 디버깅 1회차 판정 #1)
  const lc = localClock(now);
  if (!lc.day) return null;
  const dow = (new Date(`${lc.day}T00:00:00Z`).getUTCDay() + 6) % 7;   // 월=0 … 일=6
  const ag = String(agent || '').trim().toLowerCase();
  const oc = settings?.oncall;
  for (const k of [ag, ESC_ALL]) {
    if (!oc || !Object.hasOwn(oc, k)) continue;
    const d = oc[k]?.days?.[dow];
    if (d && (d.name || d.email)) return { name: d.name, email: d.email, agent: k, day: ESC_DAYS[dow] };
  }
  return null;
}
/** 그 단계가 끝났는가 — 갔음 · 건너뜀 · 다시 시도 끝(안 간 것은 ESC_RETRY_MAX 번까지 다시). */
const stepDone = (sent, i) => sent.some((e) => e[0] === i && e[3] !== 'fail') || sent.filter((e) => e[0] === i && e[3] === 'fail').length >= ESC_RETRY_MAX;

/**
 * 이번 회차에 보낼 것(순수).
 * @param {{ settings:object, state:{items:object, enabledAt?:number|null}, open:Array, now:number, maxSends?:number, hold?:Set<string>, holdKeyOf?:Function }} a
 *   hold = 정비 창 보류 장비 열쇠(holdKeyOf(수집 주체, deviceId)) — 그 장비의 장애는 이번 회차에 보내지 않는다(기록은 둔다)
 * @returns {{ sends:Array<{ key, part, policy, step, to, skipped:number[] }>, items:object, enabledAt:number|null, deferred:number, overCap:number, held:number }}
 */
export function escalationPlan({ settings, state, open, now = Date.now(), maxSends = ESC_SENDS_PER_RUN, hold = null, holdKeyOf = null }) {
  const items = {};
  const sends = []; let deferred = 0; let overCap = 0; let held = 0; const heldKeys = [];
  const prev = state?.items || {};
  const list = Array.isArray(open) ? open : [];
  const openKeys = new Set(list.map(partKeyOf));
  // 닫힌 장애의 기록 — 키만 바뀐 같은 장애가 이어받을 후보(sig). 꺼져 있어도 닫힌 것은 정리한다(다시 열린 장애가 옛 확인을 물려받지 않게 — 반증 A5)
  const staleBySig = new Map();
  for (const [k, v] of Object.entries(prev)) if (!openKeys.has(k) && v.sig) staleBySig.set(v.sig, v);
  const enabled = settings?.enabled === true;
  const enabledAt = numOrNull(settings?.enabledAt);
  // 다시 켰다(켠 시각이 바뀌었다) — 확인하지 않은 기록은 지금부터 다시 센다(옛 since 로 켜자마자 높은 단계가 가지 않게 — 반증 A5)
  const reEnabled = enabled && (numOrNull(state?.enabledAt) ?? null) !== enabledAt;
  const reserved = list.reduce((n, p) => n + (Object.hasOwn(prev, partKeyOf(p)) ? 1 : 0), 0);   // 이미 기록이 있는 열린 장애(자리를 먼저 둔다)
  let newCount = 0;
  for (const p of list) {
    const key = partKeyOf(p);
    const sig = partSigOf(p);
    let cur = Object.hasOwn(prev, key) ? prev[key] : null;
    if (!cur && staleBySig.has(sig)) { cur = staleBySig.get(sig); staleBySig.delete(sig); }   // 키 이전 — 기록 · 확인을 이어받는다
    if (cur && reEnabled && !cur.ackedAt) cur = { ...cur, since: now, sent: [] };
    const pol = enabled ? policyFor(settings, p) : null;
    // 다른 정책으로 넘어감(예: 주의 → 이상 — 받는 곳이 다른 팀) — 그 정책의 단계는 아직 하나도 가지 않았다: 지금부터 다시 센다(디버깅 1회차 판정 #3)
    if (pol && cur && !cur.ackedAt && cur.pol && cur.pol !== pol.id) cur = { ...cur, since: now, sent: [], pol: pol.id };
    // 정책 밖(꺼짐 · 맞는 정책 없음 · 상태가 바뀜)이어도 열려 있는 동안은 기록을 둔다 — 상태가 오가도 보낸 단계를 다시 보내지 않게(반증 A3)
    if (!pol) { if (cur) items[key] = { ...cur, sig }; continue; }
    // 상한 — 기록할 수 없는 장애에는 보내지 않는다(반증 A7). 이미 기록이 있는 열린 장애 수를 먼저 떼어 두고 새 것만 센다(O(N) — 판정 #13)
    if (!cur) { if (newCount + reserved >= ESC_ITEMS_MAX) { overCap += 1; continue; } newCount += 1; }
    const it = cur ? { ...cur, sig, sent: [...cur.sent], pol: pol.id } : { since: now, sig, sent: [], ackedAt: null, ackBy: '', pol: pol.id };
    items[key] = it;
    if (it.ackedAt) continue;
    if (hold && holdKeyOf && hold.has(holdKeyOf(p.agent, p.deviceId))) { held += 1; heldKeys.push(key); continue; }
    const mins = (now - it.since) / 60_000;
    let due = -1;
    pol.steps.forEach((s, i) => { if (mins >= s.afterMin && !stepDone(it.sent, i)) due = i; });
    if (due < 0) continue;
    if (sends.length >= maxSends) { deferred += 1; continue; }
    const skipped = pol.steps.map((_, i) => i).filter((i) => i < due && !stepDone(it.sent, i));
    const step = pol.steps[due];
    const oc = step.oncall ? oncallFor(settings, p.agent, now) : null;
    const attempt = it.sent.filter((e) => e[0] === due && e[3] === 'fail').length + 1;   // 다시 시도 번호 — 채널 억제 열쇠에 넣는다(같은 열쇠면 억제 창에 막혀 다시 시도가 0번이었다 — 판정 #2)
    sends.push({ key, part: p, policy: pol, step: due, attempt, skipped, to: { emails: step.emails, channels: step.channels, oncall: oc, oncallWanted: step.oncall } });
  }
  return { sends, items, enabledAt: enabled ? enabledAt : (numOrNull(state?.enabledAt) ?? null), deferred, overCap, held, heldKeys };
}
/**
 * 보낸 결과를 기록에 적는다(순수 — 새 items). results[i] = { text, delivered:boolean }.
 *   안 간 것(delivered false)은 fail — 다음 회차에 다시(ESC_RETRY_MAX 번째면 give). 화면은 ‘보냄’ 과 ‘안 감’ 을 가른다(반증 A8).
 */
export function recordSends(items, sends, results, now = Date.now()) {
  const out = { ...items };
  sends.forEach((s, i) => {
    const it = out[s.key]; if (!it) return;
    const r = results[i] || {};
    if (r.notSent) return;   // 보내기 직전에 확인됨 — 적지 않는다
    const sent = [...it.sent];
    for (const k of s.skipped) sent.push([k, now, '건너뜀(이 단계 시각이 지난 뒤 처음 본 회차라 더 높은 단계를 보냄)', 'skip']);   // 엔진 정지 · 회차 상한 미룸 모두(반증 B · S2)
    const fails = sent.filter((e) => e[0] === s.step && e[3] === 'fail').length;
    sent.push([s.step, now, String(r.text || '').slice(0, 120), r.delivered ? 'ok' : fails + 1 >= ESC_RETRY_MAX ? 'give' : 'fail']);
    out[s.key] = { ...it, sent };
  });
  return out;
}

// ───────── 확인(ack) ─────────
// 화면에 싣는 확인 열쇠 — 장애 키(수집 주체|파트 키)를 그대로 싣지 않는다(비관리자 판본은 파트 키를 가린다 — 가린 행에서도 확인할 수 있게).
const ACK_SECRET = crypto.randomBytes(24);
export const ackIdOf = (p) => crypto.createHmac('sha256', ACK_SECRET).update(partKeyOf(p)).digest('base64url').slice(0, 22);
/** 열린 장애 가운데 ackId 가 맞는 것. */
export const partOfAckId = (open, ackId) => (typeof ackId === 'string' && ackId.length <= 64 ? (open || []).find((p) => ackIdOf(p) === ackId) || null : null);
/**
 * 확인 — 그 장애의 단계 올리기를 멈춘다(이미 확인했으면 바뀌지 않음). 진행 기록에 없던 장애(정책 밖 · 아직 안 봄)도 확인을 적는다.
 * @returns {{ ok:boolean, changed?:boolean, reason?:string }}
 */
export function ackEscalation(p, { by = '', now = Date.now() } = {}) {
  if (!p) return { ok: false, reason: '열린 장애가 아닙니다.' };
  const st = loadEscalationState();
  const key = partKeyOf(p);
  const cur = Object.hasOwn(st.items, key) ? st.items[key] : null;
  if (cur?.ackedAt) return { ok: true, changed: false };
  const next = { ...st, items: { ...st.items, [key]: { ...(cur || { since: now, sig: partSigOf(p), sent: [] }), ackedAt: now, ackBy: String(by).slice(0, 80) } } };
  return saveEscalationState(next) ? { ok: true, changed: true } : { ok: false, reason: '진행 기록을 쓰지 못했습니다.' };
}
/**
 * 화면에 싣는 행 표지 — { ackId, covered(정책 대상인가 — 켜져 있고 맞는 정책이 있다), step(받는 곳에 간 가장 높은 화면 단계 번호 · 없으면 null),
 *   tried(시도했으나 안 간 가장 높은 화면 단계 — step 보다 높을 때만), acked, ackBy?, ackedAt? }.
 *   정책 밖 장애에 ‘1단계(바로)’ · 확인 단추를 붙이지 않게(화면 판독 — 다음 단계가 없는 장애였다).
 */
/**
 * run = 마지막 회차 { why, heldKeys:Set } — 회차가 보내지 않는 상태(데모 · 부품 장애 점검 꺼짐 · 진행 기록 못 읽음)면 paused 에 그 사유 · 정비 창 보류 장비면 held.
 *   행 표지가 ‘보냅니다’ 라고 약속하지 않게(디버깅 1회차 화면 U7).
 */
export function escalationMarkOf(p, items, settings = null, run = null) {
  const it = items && Object.hasOwn(items, partKeyOf(p)) ? items[partKeyOf(p)] : null;
  const ok = (it?.sent || []).filter((e) => e[3] === 'ok').map((e) => e[0]);
  const bad = (it?.sent || []).filter((e) => e[3] === 'fail' || e[3] === 'give').map((e) => e[0]);
  const step = ok.length ? Math.max(...ok) + 2 : null;
  const tried = bad.length && Math.max(...bad) + 2 > (step ?? 1) ? Math.max(...bad) + 2 : null;
  // 그 단계를 그만뒀는가(다시 시도 상한) — 화면이 ‘다시 시도 중’ 과 ‘그만둠’ 을 가른다(반증 B1)
  const gaveUp = tried != null && (it?.sent || []).some((e) => e[0] === tried - 2 && e[3] === 'give');
  const covered = !!(settings?.enabled && policyFor(settings, p));
  const why = covered && typeof run?.why === 'string' && run.why && run.why !== 'off' ? run.why : '';
  const held = covered && !why && run?.heldKeys instanceof Set && run.heldKeys.has(partKeyOf(p));
  return { ackId: ackIdOf(p), covered, step, ...(tried ? { tried, ...(gaveUp ? { gaveUp: true } : {}) } : {}), acked: !!it?.ackedAt, ...(it?.ackedAt ? { ackedAt: it.ackedAt, ackBy: it.ackBy } : {}),
    ...(why ? { paused: why } : {}), ...(held ? { held: true } : {}) };
}
