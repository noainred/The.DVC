/**
 * isidu/settings.js — 아이실론 디렉터리 사용량 수집 대상 설정(v2.736).
 *
 * 파일(중앙): `isidu-settings.json` — 대상 목록 + 보존일. **비밀이 없다**(접속은 노드 SSH 키 또는 스토리지 등록부 계정을 쓴다 —
 *   이 파일에 비밀번호를 담지 않으므로 SECRET_FILES 대상이 아니다).
 * 파일(엣지): `isidu-edge-targets.json` — 중앙이 내려준 '이 엣지 몫' 사본(상태 파일 — 중앙이 진실, 재시작 직후 중앙이 안 닿아도 이어서 돈다).
 *
 * ── 대상의 두 형태 ────────────────────────────────────────────────────────────
 *  ① 스토리지 등록부의 아이실론(deviceId): 주소·담당 노드(agent)·법인(datacenterId)은 **등록부에서 실행 시점에 읽는다**
 *     (사본을 저장하지 않는다 — 등록부에서 담당 엣지를 바꾸면 그대로 따라간다). 사용자 요청 "각각의 edge 가 속한 동일한 법인의
 *     아이실론 장비" 가 이 형태다.
 *  ② 직접 입력(host): 주소·실행 노드·법인을 이 설정이 가진다. 실행 노드·법인은 기존 목록에서만 고른다(cvp/formChoices — 오타 방지).
 *  ③ v2.736 실행 노드 지정(runVia:'node'): 등록부 아이실론이어도 **다른 노드(메인 또는 특정 엣지)에서** 명령을 실행하게 한다
 *     (사용자 요청 "명령어를 특정 엣지 서버에서 실행하는 기능 … idrac 조사하는 것처럼 원격에서"). 기본은 장비 담당 노드를 따른다.
 *     ⚠ 등록부 계정 인증은 장비 담당 노드나 메인에서만 — 다른 엣지의 스토리지 등록부에는 그 장비(계정)가 없다.
 *
 * ── 지키는 것 ────────────────────────────────────────────────────────────────
 *  · 경로는 `/ifs` 아래 절대 경로만, 작은따옴표·역슬래시·$·백틱·제어 문자·`.`/`..` 조각 금지(원격 셸에 작은따옴표로 감싸 넣는다).
 *  · 숫자 칸의 빈 값은 '미지정' — 이전 값을 유지한다(v2.596 규약. `Number('')===0` 이 하한으로 승격되는 사고 방지).
 *  · 손상 파일은 보존하고(preserveCorrupt) 로드 오류를 세운다 — 설정 pull 이 503 으로 답해 엣지 사본을 지우지 않게(v2.631).
 *  · v2.738 결과 메일: 공통 수신자(`mail.commonTo`)와 대상별 `mail`(to·excludeCommon·onlyOnChange·onFailure). 규칙은 `mailRules.js`.
 *    v2.745: 대상별 보내는 때(when 'scan'|'schedule' · days · time · skipIfNoNew · since — since 는 서버가 정한다).
 *    형식이 틀린 주소는 저장하지 않고 400 으로 거부한다. **엣지로 내려가지 않는다**(edgeTargetView·cleanEdgeTarget 이 싣지 않는다 —
 *    메일은 중앙만 보낸다. 주소 목록을 28곳에 퍼뜨리지 않는다).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { makeSettingsLoadError } from '../util/settingsLoadError.js';
import { registerStateFile } from '../util/stateFiles.js';
import { numOrNull } from '../util/numOrNull.js';
import { DEADLINE_LONG_MAX_MS } from '../util/deadline.js';
import { normPath, SIZE_MODES } from './parse.js';
import { normalizeTargetMail, normalizeCommonMail, isEmail, targetMailIsDefault } from './mailRules.js';
import { digestOf, normalizeDigest } from './digestRules.js';
import { ssrfBlockReason } from '../util/ssrfBlock.js';

const FILE = () => path.join(config.configDir, 'isidu-settings.json');
registerStateFile('isidu-edge-targets.json');
const EDGE_FILE = () => path.join(config.configDir, 'isidu-edge-targets.json');   // ⚠ 리터럴 형태 유지 — scripts/config-doc.mjs 가 이 모양으로 찾는다

export const MAX_TARGETS = 100;
export const RANGES = Object.freeze({
  intervalHours: { min: 1, max: 720, def: 24 },
  // v2.736: 상한 120분 — 사용자 보고 "원격으로 돌리는데 10분이 넘게 걸릴 때도 있어". 명령 시한은 sshExec 의 긴 명령 관문이 받는다(v2.739 부터 상한 180분 · 관문 3시간).
  // v2.739: 기본값 30분 → 120분(사용자 요청 "스캔 대기 시간을 기본으로 2시간"). 예전 기본값으로 저장된 대상은 load 가 한 번 옮긴다(migrateTimeoutDefault).
  timeoutMin: { min: 1, max: 180, def: 120 },   // v2.739: 기본 2시간 · 최대 3시간(사용자 요청)
  topN: { min: 5, max: 50, def: 10 },
  port: { min: 1, max: 65535, def: 22 },
  retentionDays: { min: 30, max: 3650, def: 400 },
});
export const AUTH_MODES = Object.freeze(['key', 'device']);
const RE_ID = /^[A-Za-z0-9_-]{1,40}$/;
const RE_HOST = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,253}$/;
const RE_USER = /^[A-Za-z0-9._@\\-]{1,64}$/;
const lo = (v) => String(v ?? '').trim().toLowerCase();

export const DEFAULTS = Object.freeze({ targets: [], retentionDays: RANGES.retentionDays.def, mail: Object.freeze({ commonTo: Object.freeze([]) }) });
/** 빈 설정 값(공유 참조를 남기지 않게 매번 새로 만든다). */
const emptyValue = () => ({ targets: [], retentionDays: RANGES.retentionDays.def, mail: { commonTo: [], digest: digestOf(null) } });
/**
 * 저장된 공통 메일 설정 정리(옛 파일은 필드가 없다 · 형식이 틀린 주소는 버린다 — 저장 경로가 이미 거부하므로 손으로 고친 파일뿐).
 * v2.742: 종합 메일 설정(`digest`)도 여기 산다 — 정리는 `digestRules.digestOf` 하나다.
 */
const commonMailOf = (m) => ({ commonTo: (Array.isArray(m?.commonTo) ? m.commonTo : []).filter(isEmail).slice(0, 50), digest: digestOf(m?.digest) });
const cloneDigest = (d) => { const g = digestOf(d); return { ...g, days: [...g.days], to: [...g.to] }; };

/**
 * 조사 경로 판정(순수). 문제가 없으면 null, 있으면 사유 문장.
 * @param {unknown} p
 */
export function pathIssue(p) {
  const raw = String(p ?? '').trim();
  if (!raw) return '조사할 디렉터리를 입력하세요.';
  if (raw.length > 1024) return '경로가 너무 깁니다(1024자 이하).';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return '경로에 제어 문자가 있습니다.';
  if (/['\\$`]/.test(raw)) return '경로에 작은따옴표·역슬래시·$·백틱은 쓸 수 없습니다.';
  const n = normPath(raw);
  if (!(n === '/ifs' || n.startsWith('/ifs/'))) return '아이실론 경로(/ifs 아래 절대 경로)만 쓸 수 있습니다.';
  if (n.split('/').some((seg) => seg === '.' || seg === '..')) return "경로에 '.' 이나 '..' 조각은 쓸 수 없습니다.";
  return null;
}

/** 숫자 칸 하나 — 빈 값·숫자 아님은 이전 값(없으면 기본값), 숫자는 범위로 자른다. */
function numField(v, range, prev) {
  const n = numOrNull(v);
  const p = numOrNull(prev);
  if (n == null) return p != null ? p : range.def;
  return Math.max(range.min, Math.min(range.max, Math.round(n)));
}

/**
 * 대상의 명령 시한(ms) — 설정 범위로 자른다(빈 값·숫자 아님은 기본값 — v2.739 부터 120분). 수집기·연결 시험·'지금 수집' 큐 시한이 같은 값을 쓴다.
 * 세션 시한은 이 값 + 30초이고 `util/deadline.js` 긴 작업 상한(3시간 — v2.739)에 걸리면 명령 시한을 15초 줄인다(세션이 먼저 끊기면 결과가 버려진다).
 */
export function timeoutMsOf(t) {
  return numField(t?.timeoutMin, RANGES.timeoutMin, null) * 60_000;
}
export const SESSION_MAX_MS = DEADLINE_LONG_MAX_MS;   // v2.739: 3시간 — util/deadline.js 긴 작업 상한과 같은 값(collect 가 withDeadline(…, { long: true }))
export function sessionPlanOf(t) {
  const cmd = timeoutMsOf(t);
  const session = Math.min(SESSION_MAX_MS, cmd + 30_000);
  return { cmdMs: Math.min(cmd, session - 15_000), sessionMs: session };
}

const loadErr = makeSettingsLoadError(FILE, { label: '아이실론 디렉터리 사용량 설정', confirm: () => { saveSettingsRaw(emptyValue()); } });
export function isiduSettingsLoadError() { load(); return loadErr.get(); }

let _cache = null; // { mtime, size, value }

/** v2.739: 시한 기본값 이전을 이미 했다는 표지(파일 최상위 키)와 예전 기본값. */
export const TIMEOUT_MARK = 'timeoutDefaultMin';
export const OLD_TIMEOUT_DEF = 30;
/**
 * v2.739 시한 기본값 이전(순수) — 파일에 표지(TIMEOUT_MARK)가 없으면(2.738 이하가 쓴 파일) 시한이 **예전 기본값 30분**인 대상만 120분으로 옮긴다
 * (사용자 선택 — 30분이 아닌 값으로 직접 정한 대상은 그대로). 표지가 있으면 아무것도 바꾸지 않는다 — 저장은 언제나 표지를 싣으므로,
 * 이전 뒤에 사람이 다시 30분으로 고친 값을 다음 읽기가 120분으로 되돌리지 않는다.
 * @param {object} raw 파일에서 읽은 객체
 * @returns {{raw:object, moved:number, needWrite:boolean}}
 */
export function migrateTimeoutDefault(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { raw, moved: 0, needWrite: false };
  if (numOrNull(raw[TIMEOUT_MARK]) != null) return { raw, moved: 0, needWrite: false };
  let moved = 0;
  const targets = (Array.isArray(raw.targets) ? raw.targets : []).map((t) => {
    if (!t || typeof t !== 'object' || numOrNull(t.timeoutMin) !== OLD_TIMEOUT_DEF) return t;
    moved++;
    return { ...t, timeoutMin: RANGES.timeoutMin.def };
  });
  return { raw: { ...raw, ...(Array.isArray(raw.targets) ? { targets } : {}), [TIMEOUT_MARK]: RANGES.timeoutMin.def }, moved, needWrite: true };
}

function load() {
  let st = null;
  try { st = fs.statSync(FILE()); } catch { st = null; }
  if (!st) { loadErr.missing(); _cache = { mtime: 0, size: -1, value: emptyValue() }; return _cache.value; }
  if (_cache && _cache.mtime === st.mtimeMs && _cache.size === st.size) return _cache.value;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('형식 오류');
  } catch (e) {
    preserveCorrupt(FILE(), e?.message);
    loadErr.corrupt(e);
    _cache = { mtime: 0, size: -1, value: emptyValue() };
    return _cache.value;
  }
  // v2.739 시한 기본값 이전 — 쓰기 실패는 손상이 아니다(다음 읽기가 다시 시도한다 · 이번 읽기는 옮긴 값으로 동작한다).
  const mg = migrateTimeoutDefault(raw);
  if (mg.needWrite) {
    raw = mg.raw;
    try {
      atomicWriteFileSync(FILE(), JSON.stringify(raw, null, 2), { mode: 0o600 });
      try { st = fs.statSync(FILE()); } catch { /* 다음 읽기가 다시 본다 */ }
      if (mg.moved) console.log(`[isidu] 시한 기본값 변경(30분 → ${RANGES.timeoutMin.def}분): 예전 기본값 30분이던 대상 ${mg.moved}개를 옮겼습니다.`);
    } catch (e) {
      console.warn(`[isidu] 시한 기본값 이전을 파일에 쓰지 못했습니다(이번에는 메모리에서만 적용 — 다음 읽기가 다시 시도합니다): ${e?.message || e}`);
      st = null;
    }
  }
  try {
    const targets = (Array.isArray(raw.targets) ? raw.targets : []).filter((t) => t && typeof t === 'object' && RE_ID.test(String(t.id || ''))).slice(0, MAX_TARGETS);
    const value = { targets, retentionDays: numField(raw.retentionDays, RANGES.retentionDays, null), mail: commonMailOf(raw.mail) };
    loadErr.ok();
    _cache = st ? { mtime: st.mtimeMs, size: st.size, value } : { mtime: 0, size: -1, value };
    return value;
  } catch (e) {
    preserveCorrupt(FILE(), e?.message);
    loadErr.corrupt(e);
    _cache = { mtime: 0, size: -1, value: emptyValue() };
    return _cache.value;
  }
}

export function loadSettings() {
  const v = load();
  return { ...v, targets: v.targets.map((t) => ({ ...t, ...(t.mail && typeof t.mail === 'object' ? { mail: { ...t.mail, to: Array.isArray(t.mail.to) ? [...t.mail.to] : [], ...(Array.isArray(t.mail.days) ? { days: [...t.mail.days] } : {}) } } : {}) })), mail: { commonTo: [...(v.mail?.commonTo || [])], digest: cloneDigest(v.mail?.digest) } };
}

function saveSettingsRaw(v) {
  // v2.739: 표지를 언제나 싣는다 — 없으면 다음 읽기가 이전을 다시 돌려 사람이 정한 30분을 120분으로 바꾼다.
  atomicWriteFileSync(FILE(), JSON.stringify({ ...v, [TIMEOUT_MARK]: RANGES.timeoutMin.def }, null, 2), { mode: 0o600 });
  _cache = null;
  loadErr.ok();
}

/**
 * 대상 하나 정규화 + 검증. 문제가 있으면 { error, field }.
 * @param {object} input 요청 값
 * @param {object|null} prev 같은 id 의 저장된 대상
 * @param {{devices:object[], agents:string[], dcs:{id,name}[], pickAgent:Function, pickDatacenter:Function, ssrfBlockReason:Function}} ctx
 */
export function normalizeTarget(input, prev, ctx) {
  const t = input && typeof input === 'object' ? input : {};
  let id = String(t.id || prev?.id || '').trim();
  if (!id) id = `t${crypto.randomBytes(4).toString('hex')}`;
  if (!RE_ID.test(id)) return { error: '대상 id 형식이 잘못됐습니다.', field: 'id' };
  // eslint-disable-next-line no-control-regex
  const label = String(t.label ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80);
  const pIss = pathIssue(t.path);
  if (pIss) return { error: pIss, field: 'path' };
  const out = {
    id, label,
    path: normPath(String(t.path).trim()),
    sizeMode: SIZE_MODES.includes(t.sizeMode) ? t.sizeMode : (prev?.sizeMode || 'h'),
    intervalHours: numField(t.intervalHours, RANGES.intervalHours, prev?.intervalHours),
    timeoutMin: numField(t.timeoutMin, RANGES.timeoutMin, prev?.timeoutMin),
    topN: numField(t.topN, RANGES.topN, prev?.topN),
    port: numField(t.port, RANGES.port, prev?.port),
    enabled: t.enabled !== false,
    auth: AUTH_MODES.includes(t.auth) ? t.auth : 'key',
    // v2.737: 장비에서 분리 실행(nohup — 포탈이 재시작해도 du 가 계속 돌고 결과를 이어 받는다). 기본 켬 · false 만 끔.
    detach: t.detach !== false,
  };
  // v2.738 결과 메일 — 요청에 mail 이 없으면 이전 값 유지(옛 화면·다른 경로의 저장이 지우지 않게).
  // v2.745 보내는 때(when·days·time·skipIfNoNew) — 빠진 칸도 이전 값, since 는 서버가 정한다(mailRules.normalizeTargetMail).
  const m = normalizeTargetMail(t.mail, prev?.mail ?? null);
  if (m.error) return { error: m.error, field: m.field };
  // 기본값과 같으면 저장하지 않는다(파일을 작게 — 없는 것과 같은 뜻). v2.745: 새 필드가 기본값과 다를 때도 저장한다.
  if (!targetMailIsDefault(m.mail)) out.mail = m.mail;
  const user = String(t.username ?? prev?.username ?? '').trim();
  const deviceId = String(t.deviceId || '').trim();
  if (deviceId) {
    const dev = (ctx.devices || []).find((d) => d && String(d.id) === deviceId);
    if (!dev && !(prev && prev.deviceId === deviceId)) return { error: '고른 아이실론이 스토리지 등록부에 없습니다.', field: 'deviceId' };
    if (dev && dev.type !== 'isilon') return { error: '고른 장비가 아이실론(PowerScale)이 아닙니다.', field: 'deviceId' };
    out.deviceId = deviceId;
    // 계정: 비우면 등록부 계정(키 인증이면 그 계정 이름으로 키 로그인). 입력하면 그 계정.
    if (user && !RE_USER.test(user)) return { error: '계정 이름 형식이 잘못됐습니다.', field: 'username' };
    out.username = user;
    // 실행 노드 — 'device'(장비 담당 노드를 따른다, 기본) | 'node'(agent 로 고른 노드. '' = 메인).
    out.runVia = t.runVia === 'node' ? 'node' : 'device';
    if (out.runVia === 'node') {
      const ag = ctx.pickAgent(t.agent, ctx.agents || [], prev?.agent || '');
      if (ag.error) return { error: ag.error, field: 'agent' };
      out.agent = ag.value;
      if (out.auth === 'device' && dev && out.agent && lo(out.agent) !== lo(dev.agent)) {
        const where = dev.agent ? `장비 담당 노드(엣지 ‘${dev.agent}’)나 메인` : '메인';
        return { error: `'스토리지 등록부 계정' 인증은 ${where}에서 실행할 때만 쓸 수 있습니다 — 엣지 ‘${out.agent}’ 의 스토리지 등록부에는 그 장비 계정이 없습니다. SSH 키 인증으로 바꾸거나 실행 노드를 ${where}으로 두세요.`, field: 'auth' };
      }
    }
  } else {
    if (out.auth === 'device') return { error: "'스토리지 등록부 계정' 인증은 등록부의 아이실론을 골랐을 때만 쓸 수 있습니다.", field: 'auth' };
    const host = String(t.host || '').trim();
    if (!host || !RE_HOST.test(host)) return { error: 'SSH 주소(IP 또는 호스트명)를 입력하세요.', field: 'host' };
    const ssrf = typeof ctx.ssrfBlockReason === 'function' ? ctx.ssrfBlockReason(host) : null;
    if (ssrf) return { error: `이 주소로는 접속할 수 없습니다(${ssrf}).`, field: 'host' };
    if (!user || !RE_USER.test(user)) return { error: '접속 계정을 입력하세요(예: admin).', field: 'username' };
    const ag = ctx.pickAgent(t.agent, ctx.agents || [], prev?.agent || '');
    if (ag.error) return { error: ag.error, field: 'agent' };
    const dc = ctx.pickDatacenter(t.datacenterId, ctx.dcs || [], prev?.datacenterId || '');
    if (dc.error) return { error: dc.error, field: 'datacenterId' };
    Object.assign(out, { host, username: user, agent: ag.value, datacenterId: dc.value });
  }
  return { target: out };
}

/**
 * 설정 저장(전체 목록 교체). 같은 id 의 이전 값을 기준으로 숫자 빈 칸을 메운다.
 * @returns {{ok:true, settings:object} | {ok:false, error:string, field?:string, index?:number}}
 */
export function saveSettings(input, ctx) {
  const cur = load();
  const list = Array.isArray(input?.targets) ? input.targets : null;
  if (!list) return { ok: false, error: 'targets 배열이 필요합니다.' };
  if (list.length > MAX_TARGETS) return { ok: false, error: `대상은 ${MAX_TARGETS}개까지입니다.` };
  const prevById = new Map(cur.targets.map((t) => [t.id, t]));
  const out = []; const ids = new Set();
  for (let i = 0; i < list.length; i++) {
    const r = normalizeTarget(list[i], prevById.get(String(list[i]?.id || '')) || null, ctx);
    if (r.error) return { ok: false, error: `대상 ${i + 1}: ${r.error}`, field: r.field, index: i };
    if (ids.has(r.target.id)) return { ok: false, error: `대상 ${i + 1}: id 가 겹칩니다.`, field: 'id', index: i };
    ids.add(r.target.id);
    out.push(r.target);
  }
  const cm = normalizeCommonMail(input?.mail, cur.mail);
  if (cm.error) return { ok: false, error: cm.error, field: cm.field };
  // v2.742: 종합 메일 설정은 이 저장이 바꾸지 않는다(전용 저장 saveDigestSettings — 대상 목록 저장이 그 값을 지우지 않게).
  const value = { targets: out, retentionDays: numField(input?.retentionDays, RANGES.retentionDays, cur.retentionDays), mail: { ...cm.mail, digest: cloneDigest(cur.mail?.digest) } };
  saveSettingsRaw(value);
  return { ok: true, settings: loadSettings() };
}

/**
 * 종합 메일 설정만 저장(v2.742) — 대상 목록·보존일·공통 수신자는 그대로 둔다. 파일을 읽지 못한 상태면 저장하지 않는다
 * (빈 값 위에 쓰면 기존 대상이 사라진다 — 라우트가 409 로 말한다).
 * @returns {{ok:true, digest:object}|{ok:false, error:string, field?:string}}
 */
export function saveDigestSettings(input, now = Date.now()) {
  const cur = load();
  if (loadErr.get()) return { ok: false, error: '저장된 설정 파일을 읽지 못해 저장하지 않았습니다.', field: 'digest', unreadable: true };
  const r = normalizeDigest(input, cur.mail?.digest || null, now);
  if (r.error) return { ok: false, error: r.error, field: r.field };
  saveSettingsRaw({ ...cur, mail: { commonTo: [...(cur.mail?.commonTo || [])], digest: r.digest } });
  return { ok: true, digest: cloneDigest(loadSettings().mail.digest) };
}

/**
 * 대상 → 실행 정보(등록부에서 주소·담당 노드·법인을 채운다). 문제가 있으면 issue 를 싣는다(실행하지 않는다).
 * @param {object} t
 * @param {{devices:object[]}} ctx
 */
export function resolveTarget(t, ctx = {}) {
  if (!t) return null;
  if (t.deviceId) {
    const dev = (ctx.devices || []).find((d) => d && String(d.id) === String(t.deviceId));
    if (!dev) return { ...t, host: '', agent: t.runVia === 'node' ? String(t.agent || '') : '', datacenterId: '', deviceName: '', issue: 'device-missing' };
    if (dev.type !== 'isilon') return { ...t, host: dev.host || '', agent: t.runVia === 'node' ? String(t.agent || '') : (dev.agent || ''), datacenterId: dev.datacenterId || '', deviceName: dev.name || '', issue: 'device-not-isilon' };
    const override = t.runVia === 'node';
    return {
      ...t, host: String(dev.host || ''), agent: override ? String(t.agent || '') : String(dev.agent || ''),
      deviceAgent: String(dev.agent || ''), agentSource: override ? 'override' : 'device', datacenterId: String(dev.datacenterId || ''),
      deviceName: String(dev.name || ''), username: t.username || String(dev.username || ''),
      ...(dev.enabled === false ? { deviceDisabled: true } : {}),
    };
  }
  return { ...t, deviceName: '', agentSource: 'direct' };
}

/** 엣지로 내려보낼 모양(비밀 없음). */
export function edgeTargetView(r) {
  return {
    id: r.id, label: r.label, host: r.host, port: r.port, username: r.username, auth: r.auth, deviceId: r.deviceId || '',
    // 등록부에서 장비를 비활성으로 두면 엣지도 주기 조사를 하지 않는다('지금 수집' 도 엣지 쪽 runNow 는 사본의 enabled 를 보지 않는다 —
    // 사람이 누른 것이다).
    path: r.path, sizeMode: r.sizeMode, intervalHours: r.intervalHours, timeoutMin: r.timeoutMin, topN: r.topN, enabled: r.enabled !== false && !r.deviceDisabled,
    detach: r.detach !== false, // v2.737
  };
}

// ── 엣지: 중앙이 내려준 '이 엣지 몫' 사본 ─────────────────────────────────────────
let _edge = null; // { at, targets, retentionDays }

export function edgeTargets() {
  if (_edge) return _edge;
  try {
    const raw = JSON.parse(fs.readFileSync(EDGE_FILE(), 'utf8'));
    _edge = { at: numOrNull(raw?.at), targets: Array.isArray(raw?.targets) ? raw.targets.filter((t) => t && RE_ID.test(String(t.id || ''))) : [], retentionDays: numField(raw?.retentionDays, RANGES.retentionDays, null) };
  } catch { _edge = { at: null, targets: [], retentionDays: RANGES.retentionDays.def }; }
  return _edge;
}

/**
 * 중앙이 보낸 대상 하나를 엣지에서 다시 검증·정리한다(형식이 틀리면 null). 사본 적용과 원격 연결 시험이 같은 함수를 쓴다 —
 * 중앙이 보낸 값도 원격 셸에 들어가므로 경로·주소·계정 판정을 엣지에서도 한다.
 */
export function cleanEdgeTarget(t) {
  if (!t || typeof t !== 'object' || !RE_ID.test(String(t.id || '')) || pathIssue(t.path) || !RE_HOST.test(String(t.host || '')) || !RE_USER.test(String(t.username || ''))) return null;
  // v2.740 C-01: 메인 normalizeTarget 과 같은 SSRF 판정(링크로컬·메타데이터·루프백·우회 표기). 엣지 /isidu-test 는 이 함수만 지나 SSH 접속을 시도한다.
  if (ssrfBlockReason(String(t.host))) return null;
  return {
    id: String(t.id), label: String(t.label || '').slice(0, 80), host: String(t.host), port: numField(t.port, RANGES.port, 22),
    username: String(t.username), auth: AUTH_MODES.includes(t.auth) ? t.auth : 'key', deviceId: String(t.deviceId || '').slice(0, 64),
    path: normPath(String(t.path)), sizeMode: SIZE_MODES.includes(t.sizeMode) ? t.sizeMode : 'h',
    intervalHours: numField(t.intervalHours, RANGES.intervalHours, null), timeoutMin: numField(t.timeoutMin, RANGES.timeoutMin, null),
    topN: numField(t.topN, RANGES.topN, null), enabled: t.enabled !== false,
    detach: t.detach !== false, // v2.737 — 구버전 중앙은 이 필드를 보내지 않는다(없으면 켬)
  };
}

/**
 * 중앙 사본 적용(엣지). 받은 대상은 다시 검증한다(중앙이 보낸 값도 원격 셸에 들어간다 — 경로·주소 판정을 엣지에서도 한다).
 * @returns {{applied:boolean, count:number, rejected:number, removed:string[]}}
 */
export function applyEdgeTargets(list, retentionDays) {
  const prev = edgeTargets();
  const clean = []; let rejected = 0;
  for (const t of (Array.isArray(list) ? list : []).slice(0, MAX_TARGETS)) {
    const c = cleanEdgeTarget(t);
    if (c) clean.push(c); else rejected++;
  }
  const next = { at: Date.now(), targets: clean, retentionDays: numField(retentionDays, RANGES.retentionDays, prev.retentionDays) };
  const sig = (v) => JSON.stringify([v.targets, v.retentionDays]);
  const changed = sig(next) !== sig(prev);
  const removed = prev.targets.map((t) => t.id).filter((id) => !clean.some((c) => c.id === id));
  _edge = next;
  try { atomicWriteFileSync(EDGE_FILE(), JSON.stringify(next, null, 2), { mode: 0o600 }); }
  catch (e) { console.warn(`[isidu] 중앙 대상 사본을 저장하지 못했습니다(메모리로 계속): ${e.message}`); }
  return { applied: changed, count: clean.length, rejected, removed };
}

export function _resetForTest() { _cache = null; _edge = null; loadErr.ok(); }
