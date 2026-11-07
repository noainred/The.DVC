/**
 * issues/autoCreate.js — 하드웨어 파트 장애 → 이슈 자동 등록(v2.880, 사용자 요청 2026-11-04
 * "하드웨어 파트 장애가 발생하면 자동으로 이슈 등록하는 기능 추가, 설정에서 어떤 장애에 대해서 자동으로 추가할 것인지 설정").
 * 시안: docs/design/wiki-issues ⑪(이슈 설정 › 자동 등록).
 *
 * 어디서 도나: **중앙** 파트 장애 폴러(partfault/poller.js)가 전이(열림 · 변화 · 해소 · 보류)를 DB 에 쓴 직후 한 번. 엣지에서는
 *   돌지 않는다(폴러가 엣지에서 돌지 않는다). 그래서 판정 기준은 파트 장애 화면과 같다 — 판정을 복제하지 않는다.
 *
 * 무엇을: 부품 종류 × 장비군 칸마다 끔 / fault / fault + warn. **unknown · absent 는 장애가 아니므로 등록하지 않는다**
 *   (types.js — 못 읽은 것은 정상도 장애도 아니다). 칸은 추출기가 실제로 보고하는 것만 연다(AUTO_SUPPORTED — partfault/extract/*.js
 *   를 읽고 적었다. ESXi · NIC · SFP 추출기는 없다 — 시안의 그 칸은 정정했다).
 *
 * 만드는 이슈: 유형 장애 · 법인 = ① iDRAC 이고 장비 키가 서비스 태그면 그 태그의 ESXi 호스트가 속한 vCenter(insights/analysisServers.js hostVcByTag —
 *   중앙 직접 수집처럼 한 수집 서버가 여러 vCenter 를 맡아도 정확하다) ② 아니면 그 수집 서버(agent)가 수집하는 vCenter 가 **하나일 때만** 그 vCenter
 *   ③ 둘 다 아니면 공용(지어내지 않는다 — 공용 이슈는 범위 계정에 보이지 않는다) ·
 *   컴포넌트 = 부품 종류 이름 → 이슈 설정의 자동 할당 규칙이 켜져 있으면 담당자를 정한다 · 우선순위 · 라벨 · 제목 틀은 설정.
 *   이슈에 출처(origin — store.js)를 남긴다: 어느 파트 키를 덮는지 · 해소된 키 · 다시 열린 횟수 · 보류 사유.
 *
 * 중복 · 폭주:
 *   · 같은 파트 키를 덮는 **열린** 이슈가 있으면 새로 만들지 않고 댓글('다시 열림 N회째' · 상태 변화).
 *   · 한 장비에서 burstWindowMin 분 안에 만들 이슈가 burstMax 건을 넘으면 **장비 단위 1건**(부품 목록은 본문) — 그 창 안에 이미 그 장비 이슈가
 *     열려 있으면 거기에 붙인다(댓글 + 키 추가).
 *   · 하루(포탈 날짜) 상한 dailyMax — 넘으면 만들지 않고 센다(status.capped · 콘솔 하루 한 줄). 조용히 버리지 않는다.
 *
 * 장애가 바뀌면: 해소(ok · removed) → 댓글 · 덮는 키가 모두 해소되면 onResolve='review' 일 때 상태를 '검토' 로(완료는 사람이) ·
 *   수동 닫음(manual) → 댓글만 · 키 변경(key-migrated) → 출처의 키만 바꾼다(같은 장애) · 보류(unknown · 수집 실패 등) → 사유가 바뀔 때 한 번 댓글, 닫지 않는다.
 *
 * 설정 파일 `issue-autocreate.json`(비밀 없음) — 손상은 보존하고 기본값(꺼짐)으로 읽고 화면이 loadError 로 말한다(등록부 공용 판정).
 * 저장은 라우트가 관리자 + 전체 범위 + 쓰기 범위 무제한으로 막는다(전 법인 공용 설정).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt, safeLoadText } from '../util/atomicWrite.js';
import { makeLoadError } from '../util/registryCore.js';
import { capStr } from '../util/capStr.js';
import { dayKey, DAY_MS, DAY_OFFSET_MIN } from '../util/dayKey.js';
import { PART_KIND_LABEL, SCOPE_LABEL, PART_STATE_LABEL } from '../partfault/types.js';
import { alertOf } from '../partfault/notify.js';
import { createIssue, addComment, setStatus, findByOrigin, patchOrigin, originCreatedSince, issueStats, PRIORITIES } from './store.js';
import { loadIssueSettings, suggestAssignee } from './settings.js';
import { issueViewers } from './visibility.js';

/** 추출기가 실제로 보고하는 칸(partfault/extract/{idrac,storage,sanswitch}.js). PDU 는 부품 상태 필드가 없다(types.js SCOPES_OUT_OF_RANGE). */
export const AUTO_SUPPORTED = Object.freeze({
  idrac: Object.freeze(['psu', 'disk', 'dimm', 'fan', 'cpu', 'gpu', 'controller', 'pcie']),
  storage: Object.freeze(['node', 'disk', 'dimm', 'fan', 'psu', 'battery', 'enclosure', 'pcie', 'other']),
  sanswitch: Object.freeze(['port', 'fan', 'psu']),
});
export const AUTO_SCOPES = Object.freeze(Object.keys(AUTO_SUPPORTED));
/** 화면 행 순서(중요한 것 먼저). */
export const AUTO_KINDS = Object.freeze(['disk', 'psu', 'dimm', 'fan', 'cpu', 'gpu', 'controller', 'node', 'port', 'battery', 'enclosure', 'pcie', 'other']);
/** off = 끔 · fault = fault 만 · warn = fault + warn. */
export const AUTO_LEVELS = Object.freeze(['off', 'fault', 'warn']);
const supported = (scope, kind) => !!AUTO_SUPPORTED[scope]?.includes(kind);

const DEFAULT_PRIORITY = Object.freeze({ cpu: 'p0', controller: 'p0', node: 'p0', disk: 'p1', psu: 'p1', dimm: 'p1', gpu: 'p1', fan: 'p2', port: 'p2', battery: 'p2', enclosure: 'p2', pcie: 'p3', other: 'p3' });
export const DEFAULT_TITLE_TPL = '[파트 장애] {법인} · {장비} · {부품종류} {부품} {상태}';
export const AUTO_LIMITS = Object.freeze({ titleTpl: 160, labels: 10, label: 30, agentsOff: 200, burstWindowMin: [1, 1440], burstMax: [1, 100], dailyMax: [1, 1000] });

export function defaultAutoCreate() {
  const matrix = {};
  for (const sc of AUTO_SCOPES) {
    matrix[sc] = {};
    for (const k of AUTO_SUPPORTED[sc]) matrix[sc][k] = (k === 'pcie' || k === 'other') ? 'off' : (k === 'disk' && sc !== 'sanswitch' ? 'warn' : 'fault');
  }
  return {
    partfault: {
      enabled: false, matrix, priority: { ...DEFAULT_PRIORITY }, labels: ['partfault', 'auto'], titleTpl: DEFAULT_TITLE_TPL,
      burstWindowMin: 5, burstMax: 5, dailyMax: 50, onResolve: 'review', agentsOff: [], replaceNotify: false,
    },
  };
}

function fieldError(field, msg) { const e = new Error(`${field}: ${msg}`); e.status = 400; e.field = field; return e; }
const intIn = (v, [lo, hi], field, strict, def) => {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d{1,6}$/.test(v.trim()) ? Number(v) : NaN);
  if (Number.isInteger(n) && n >= lo && n <= hi) return n;
  if (v == null || v === '') return def;
  if (strict) throw fieldError(field, `${lo}~${hi} 의 정수여야 합니다`);
  return def;
};
const AGENT_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** 저장 본문(또는 파일)을 좁힌다. strict = 저장(400) · false = 파일 읽기(형식 밖은 버리고 센다). */
export function normalizeAutoCreate(raw, { strict = true } = {}) {
  const d = defaultAutoCreate().partfault;
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw.partfault && typeof raw.partfault === 'object' ? raw.partfault : raw) : {};
  let dropped = 0;
  const matrix = {};
  for (const sc of AUTO_SCOPES) {
    matrix[sc] = {};
    for (const k of AUTO_SUPPORTED[sc]) {
      const v = r.matrix?.[sc]?.[k];
      if (v == null) { matrix[sc][k] = d.matrix[sc][k]; continue; }
      if (AUTO_LEVELS.includes(v)) matrix[sc][k] = v;
      else if (strict) throw fieldError(`matrix.${sc}.${k}`, `${AUTO_LEVELS.join('·')} 중 하나여야 합니다`);
      else { matrix[sc][k] = d.matrix[sc][k]; dropped += 1; }
    }
  }
  const priority = {};
  for (const k of AUTO_KINDS) {
    const v = r.priority?.[k];
    if (v == null) priority[k] = d.priority[k];
    else if (PRIORITIES.includes(v)) priority[k] = v;
    else if (strict) throw fieldError(`priority.${k}`, `${PRIORITIES.join('·')} 중 하나여야 합니다`);
    else { priority[k] = d.priority[k]; dropped += 1; }
  }
  let labels = d.labels;
  if (r.labels != null) {
    const list = Array.isArray(r.labels) ? r.labels : (typeof r.labels === 'string' ? r.labels.split(',') : null);
    if (!list) { if (strict) throw fieldError('labels', '배열이어야 합니다'); dropped += 1; }
    else {
      labels = [...new Set(list.map((x) => String(x ?? '').trim().toLowerCase().replace(/\s+/g, '-')).filter(Boolean))];
      if (labels.length > AUTO_LIMITS.labels || labels.some((x) => x.length > AUTO_LIMITS.label)) {
        if (strict) throw fieldError('labels', `라벨은 ${AUTO_LIMITS.label}자 · ${AUTO_LIMITS.labels}개까지입니다`);
        labels = labels.filter((x) => x.length <= AUTO_LIMITS.label).slice(0, AUTO_LIMITS.labels); dropped += 1;
      }
    }
  }
  let titleTpl = d.titleTpl;
  if (r.titleTpl != null) {
    // eslint-disable-next-line no-control-regex
    const s = typeof r.titleTpl === 'string' ? r.titleTpl.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : '';
    if (!s || s.length > AUTO_LIMITS.titleTpl) { if (strict) throw fieldError('titleTpl', `1~${AUTO_LIMITS.titleTpl}자여야 합니다`); dropped += 1; } else titleTpl = s;
  }
  let agentsOff = [];
  if (r.agentsOff != null) {
    const list = Array.isArray(r.agentsOff) ? r.agentsOff : null;
    if (!list) { if (strict) throw fieldError('agentsOff', '배열이어야 합니다'); dropped += 1; }
    else {
      for (const a of list.slice(0, AUTO_LIMITS.agentsOff)) {
        const s = String(a ?? '').trim();
        if (AGENT_RE.test(s)) { if (!agentsOff.includes(s.toLowerCase())) agentsOff.push(s.toLowerCase()); } else if (strict) throw fieldError('agentsOff', `‘${capStr(s, 40)}’ 는 수집 서버 이름 형식이 아닙니다`); else dropped += 1;
      }
      if (list.length > AUTO_LIMITS.agentsOff) { if (strict) throw fieldError('agentsOff', `${AUTO_LIMITS.agentsOff}개까지입니다`); dropped += 1; }
    }
  }
  const onResolve = r.onResolve == null ? d.onResolve : (['review', 'keep'].includes(r.onResolve) ? r.onResolve : (strict ? (() => { throw fieldError('onResolve', 'review·keep 중 하나여야 합니다'); })() : d.onResolve));
  return {
    value: {
      partfault: {
        enabled: r.enabled === true, matrix, priority, labels, titleTpl,
        burstWindowMin: intIn(r.burstWindowMin, AUTO_LIMITS.burstWindowMin, 'burstWindowMin', strict, d.burstWindowMin),
        burstMax: intIn(r.burstMax, AUTO_LIMITS.burstMax, 'burstMax', strict, d.burstMax),
        dailyMax: intIn(r.dailyMax, AUTO_LIMITS.dailyMax, 'dailyMax', strict, d.dailyMax),
        onResolve, agentsOff, replaceNotify: r.replaceNotify === true,
      },
    },
    dropped,
  };
}

/* ───── 저장소 ───── */
const fileOf = () => path.join(config.configDir, 'issue-autocreate.json');
let cache = null;
const loadErr = makeLoadError();
export function loadAutoCreate() {
  if (cache) return cache;
  const f = fileOf();
  loadErr.clear();
  try {
    if (fs.existsSync(f)) {
      const { value, dropped } = normalizeAutoCreate(JSON.parse(fs.readFileSync(f, 'utf8')), { strict: false });
      if (dropped) console.warn(`[issues] issue-autocreate.json 의 형식 밖 항목 ${dropped}개를 읽지 않았습니다`);
      cache = value;
      return cache;
    }
  } catch (e) {
    preserveCorrupt(f, e.message);
    loadErr.set(safeLoadText(e) || '사유 미상');
    console.warn(`[issues] issue-autocreate.json 을 읽지 못해 기본값(자동 등록 꺼짐)으로 시작합니다: ${loadErr.get().reason}`);
  }
  loadErr.checkCorruptOnly(f);
  cache = defaultAutoCreate();
  return cache;
}
export function autoCreateLoadError() { loadAutoCreate(); return loadErr.get()?.reason || null; }
export function saveAutoCreate(body) {
  const { value } = normalizeAutoCreate(body, { strict: true });
  atomicWriteFileSync(fileOf(), JSON.stringify(value, null, 1), { mode: 0o600 });
  cache = value; loadErr.clear();
  return value;
}
/** 테스트 전용. */
export function _resetAutoCreateForTest() { cache = null; loadErr.clear(); Object.assign(status, freshStatus()); capWarnedDay = ''; }

/* ───── 판정(순수) ───── */
const t = (v) => String(v ?? '').trim();
const idOf = (p) => `${t(p.agent).toLowerCase()}|${t(p.partKey)}`;
const devOf = (p) => `${t(p.agent).toLowerCase()}|${t(p.scope)}|${t(p.deviceId)}`;
/** 이 관측이 등록 대상인가 — 사유와 함께. */
export function eligibility(p, cfg) {
  if (!p || !p.partKey) return { ok: false, why: 'invalid' };
  if (cfg.agentsOff.includes(t(p.agent).toLowerCase())) return { ok: false, why: 'agent-off' };
  if (!supported(p.scope, p.kind)) return { ok: false, why: 'unsupported' };
  const level = cfg.matrix[p.scope]?.[p.kind] || 'off';
  if (level === 'off') return { ok: false, why: 'kind-off' };
  if (p.state === 'fault') return { ok: true };
  if (p.state === 'warn') return level === 'warn' ? { ok: true } : { ok: false, why: 'warn-off' };
  return { ok: false, why: 'not-fault' }; // unknown · absent · ok — 장애가 아니다
}

/**
 * 전이 → 할 일 목록(순수 — 시험 실행과 실제 실행이 같은 함수를 쓴다).
 * @param {{opened?:Array, updated?:Array, closed?:Array, held?:Array}} tr
 * @param {object} cfg  loadAutoCreate().partfault
 * @param {{ existing:Array<{key,status,createdAt,origin}>, now:number, createdToday:number }} ctx
 * @returns {{ actions:Array, skipped:Record<string,number>, capped:number }}
 */
export function planPartFault(tr, cfg, { existing = [], now = Date.now(), createdToday = 0 } = {}) {
  const actions = [];
  const skipped = {};
  const skip = (why) => { skipped[why] = (skipped[why] || 0) + 1; };
  // 열린 이슈 색인 — 파트 키 → 이슈(가장 최근 것)
  const byKey = new Map();
  for (const x of existing) for (const k of x.origin?.partKeys || []) byKey.set(k, x);
  const winMs = cfg.burstWindowMin * 60_000;
  const candidates = new Map(); // devKey → [p]

  const consider = (p, { reopen = false, change = null } = {}) => {
    const id = idOf(p);
    const ex = byKey.get(id);
    if (ex) {
      if (reopen) actions.push({ type: 'reopen', key: ex.key, id, p });
      else if (change) actions.push({ type: 'change', key: ex.key, id, p, from: change });
      return;
    }
    const el = eligibility(p, cfg);
    if (!el.ok) { skip(el.why); return; }
    const dk = devOf(p);
    if (!candidates.has(dk)) candidates.set(dk, []);
    candidates.get(dk).push(p);
  };

  for (const p of tr.opened || []) {
    // 키 변경으로 다시 열린 것은 같은 장애다 — 출처의 키만 바꾼다.
    if (p.migratedFrom) {
      const oldId = `${t(p.agent).toLowerCase()}|${t(p.migratedFrom)}`;
      const ex = byKey.get(oldId);
      if (ex) { actions.push({ type: 'migrate', key: ex.key, from: oldId, to: idOf(p) }); byKey.set(idOf(p), ex); continue; }
    }
    consider(p, { reopen: true });
  }
  for (const p of tr.updated || []) {
    if (p.sameState) continue;
    consider(p, { change: p.prevState || '' });
  }

  // 만들 것 — 장비 단위 폭주 판정 · 하루 상한
  let room = Math.max(0, cfg.dailyMax - createdToday);
  let capped = 0;
  for (const [dk, list] of candidates) {
    const recent = existing.filter((x) => `${t(x.origin?.agent).toLowerCase()}|${t(x.origin?.scope)}|${t(x.origin?.deviceId)}` === dk && now - (x.createdAt || 0) <= winMs);
    if (recent.length + list.length <= cfg.burstMax) {
      for (const p of list) {
        if (room <= 0) { capped += 1; continue; }
        room -= 1;
        actions.push({ type: 'create', parts: [p] });
      }
      continue;
    }
    const target = recent.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
    if (target) { actions.push({ type: 'attach', key: target.key, parts: list }); continue; }
    if (room <= 0) { capped += list.length; continue; }
    room -= 1;
    actions.push({ type: 'create', parts: list, device: true });
  }

  for (const p of tr.closed || []) {
    const id = idOf(p);
    const ex = byKey.get(id);
    if (!ex) continue;
    if (p.closeReason === 'key-migrated') continue; // opened(migratedFrom) 쪽이 처리했다
    actions.push({ type: 'resolve', key: ex.key, id, p, reason: p.closeReason || 'ok' });
  }
  for (const p of tr.held || []) {
    const ex = byKey.get(idOf(p));
    if (!ex || !p.holdReason || ex.origin?.hold === p.holdReason) continue;
    actions.push({ type: 'hold', key: ex.key, id: idOf(p), p, reason: p.holdReason });
  }
  return { actions, skipped, capped };
}

/* ───── 문구 ───── */
const HOLD_TEXT = Object.freeze({
  unknown: '이번 점검에서 상태를 읽지 못했습니다', 'device-failed': '그 장비의 이번 수집이 실패했습니다', 'collection-failed': '그 부품 종류 수집이 실패했습니다',
  missing: '이번 관측 목록에 보이지 않습니다', unassigned: '장비가 그 수집 서버 목록에서 빠졌습니다', 'no-report': '수집 서버 보고가 없습니다',
  'edge-stale': '수집 서버의 마지막 보고가 오래됐습니다', 'edge-legacy': '구버전 수집 서버라 해소를 판정할 수 없습니다', 'registry-unreadable': '그 장비군 등록부를 읽지 못했습니다',
});
const kindText = (k) => PART_KIND_LABEL[k] || k || '부품';
const stateText = (s) => PART_STATE_LABEL[s] || s || '';
/** 제목 틀 채우기 — 토큰: {법인} {장비} {장비군} {부품종류} {부품} {상태}. 결과는 200자로 자른다. */
export function titleOf(tpl, p, { corp = '', parts = 1 } = {}) {
  const dev = t(p.deviceName) || t(p.deviceId);
  const map = {
    '법인': corp || t(p.agent) || '중앙', '장비': dev, '장비군': SCOPE_LABEL[p.scope] || p.scope || '',
    '부품종류': parts > 1 ? '부품' : kindText(p.kind), '부품': parts > 1 ? `${parts}개` : (t(p.label) || t(p.partId)), '상태': parts > 1 ? '장애' : stateText(p.state),
  };
  const s = String(tpl || DEFAULT_TITLE_TPL).replace(/\{(법인|장비|장비군|부품종류|부품|상태)\}/g, (_, k) => map[k] || '');
  return capStr(s.replace(/\s{2,}/g, ' ').trim(), 200) || capStr(`[파트 장애] ${dev}`, 200);
}
/** 포탈 시각 'YYYY-MM-DD HH:MM'(util/dayKey 의 오프셋 — 한국 시각 기본). 못 읽으면 '모름'. */
function portalTime(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '모름';
  return new Date(n + DAY_OFFSET_MIN * 60_000).toISOString().slice(0, 16).replace('T', ' ');
}
function bodyOf(parts, { device = false } = {}) {
  const lines = [];
  if (device) lines.push(`한 장비에서 짧은 시간에 파트 장애 ${parts.length}건이 열려 장비 단위로 묶었습니다.`, '');
  for (const p of parts) {
    const a = alertOf(p);
    // 이슈 본문은 아직 마크다운을 그리지 않는다(위키 렌더러는 다음 묶음) — 제목 기호 없이 글자로만. 시각은 포탈 시각(dayKey 와 같은 오프셋).
    lines.push(`■ ${a.title}`, a.detail, `처음 감지: ${portalTime(p.firstSeenAt)}`, '');
  }
  lines.push('파트 장애 화면: 특수 기능 › 파트 장애(#/tools/part-faults)', '이 이슈는 파트 장애 자동 등록이 만들었습니다(이슈 › 설정 › 자동 등록). 해소되면 댓글이 달리고, 설정에 따라 상태가 ‘검토’ 로 바뀝니다 — 완료는 사람이 합니다.');
  return capStr(lines.join('\n'), 9_000);
}

/* ───── 실행 ───── */
const SYSTEM_USER = 'partfault';
// 메모리 상태(파일에 쓰지 않는다 — 화면 · 점검용). 이름에 last* 를 쓰지 않는다: 저장 레코드의 실행 필드로 오인된다(audit2613f TESTDOC2613-13 스윕).
const freshStatus = () => ({ ranAt: null, created: 0, attached: 0, commented: 0, review: 0, migrated: 0, capped: 0, errors: 0, error: null, skipped: {}, cappedAt: null });
const status = freshStatus();
let capWarnedDay = '';
export function autoCreateStatus() { return { ...status, skipped: { ...status.skipped } }; }

/** 포탈 날짜(dayKey) 오늘 0시(epoch ms). */
function todayStartMs(now) {
  const k = dayKey(now);
  return k ? Date.parse(`${k}T00:00:00Z`) - DAY_OFFSET_MIN * 60_000 : now - (now % DAY_MS);
}

let vcResolver = null;
/** 테스트 전용 — (agent, part) → vCenter 판정을 바꿔 끼운다. */
export function _setVcResolverForTest(fn) { vcResolver = fn; }
/**
 * 파트 → 법인 vCenter { id, name, via }. ① iDRAC 서비스 태그 → 호스트의 vCenter ② 수집 서버가 수집하는 vCenter 가 정확히 하나 ③ 공용('').
 * 판정 재료(스냅샷 · 등록부)는 한 실행에서 한 번만 읽는다(ctx 캐시).
 */
async function vcenterOfPart(p, ctx) {
  if (vcResolver) return vcResolver(p.agent, p);
  try {
    if (!ctx.loaded) {
      const [{ agentVcenterIds, LOCAL_AGENT }, { listRegistry }, { listCollectors }, { store }, { hostVcByTag }] = await Promise.all([
        import('../ipam/scanDatacenter.js'), import('../vcenter/registry.js'), import('../collector/registry.js'), import('../store.js'), import('../insights/analysisServers.js'),
      ]);
      const regs = listRegistry();
      ctx.names = new Map(regs.map((v) => [v.id, v.name || v.id]));
      for (const v of store.get()?.vcenters || []) if (v?.id && !ctx.names.has(v.id)) ctx.names.set(v.id, v.name || v.id);
      ctx.byTag = hostVcByTag();
      ctx.agentIds = (agent) => agentVcenterIds(t(agent) || LOCAL_AGENT, { vcenters: regs, snapVcenters: store.get()?.vcenters || [], collectors: listCollectors() });
      ctx.loaded = true;
    }
    const tag = p.scope === 'idrac' && p.deviceKeyKind === 'serviceTag' ? t(p.deviceKey).toLowerCase() : '';
    const byTag = tag ? ctx.byTag.get(tag) : '';
    if (byTag) return { id: byTag, name: ctx.names.get(byTag) || byTag, via: 'serviceTag' };
    const ids = ctx.agentIds(p.agent);
    if (ids.length === 1) return { id: ids[0], name: ctx.names.get(ids[0]) || ids[0], via: 'agent' };
    return { id: '', name: '', via: 'none' };
  } catch { return { id: '', name: '', via: 'none' }; }
}

/**
 * 전이를 받아 이슈를 만들고 고친다. 던지지 않는다(폴러를 막지 않는다).
 * @returns {Promise<{ enabled:boolean, handled:Set<string>, created:number, commented:number, skipped:object, capped:number }>}
 */
export async function applyPartFaultIssues(tr, { now = Date.now() } = {}) {
  const cfg = loadAutoCreate().partfault;
  const out = { enabled: !!cfg.enabled, handled: new Set(), created: 0, attached: 0, commented: 0, review: 0, skipped: {}, capped: 0 };
  if (!cfg.enabled) return out;
  status.ranAt = now;
  let plan;
  try {
    const existing = findByOrigin((o) => o.kind === 'partfault');
    plan = planPartFault(tr, cfg, { existing, now, createdToday: originCreatedSince('partfault', todayStartMs(now)) });
  } catch (e) { status.errors += 1; status.error = String(e?.message || e).slice(0, 200); return out; }
  out.skipped = plan.skipped; out.capped = plan.capped;
  for (const [k, n] of Object.entries(plan.skipped)) status.skipped[k] = (status.skipped[k] || 0) + n;
  if (plan.capped) {
    status.capped += plan.capped; status.cappedAt = now;
    const day = dayKey(now);
    if (capWarnedDay !== day) { capWarnedDay = day; console.warn(`[issues] 파트 장애 자동 등록 하루 상한(${cfg.dailyMax}건)에 닿아 ${plan.capped}건을 만들지 않았습니다 — 이슈 › 설정 › 자동 등록`); }
  }
  const settings = loadIssueSettings();
  const viewers = settings.autoAssign?.enabled ? issueViewers() : null;
  // v2.904(점검 S-4 — 재현): 자동 댓글이 실패해도(이슈당 댓글 200개 상한 등) 그 전이의 나머지('검토' 로 옮기기)는 한다 — 출처(해소 · 다시 열림)는
  // 이미 기록돼 다음 폴링에 같은 전이가 다시 오지 않으므로, 댓글에서 던지면 상태 전이가 영영 빠졌다. 실패는 errors · error 로 밝힌다.
  const comment = (key, body) => {
    try { addComment(key, { body: capStr(body, 1_900) }, SYSTEM_USER, { auto: true }); out.commented += 1; status.commented += 1; } // v2.932(점검 B1-03) 자동 댓글은 사람 몫과 따로 센다
    catch (e) { status.errors += 1; status.error = `comment ${key}: ${String(e?.message || e).slice(0, 160)}`; console.warn(`[issues] 파트 장애 자동 등록 댓글 실패(${status.error})`); }
  };
  const vcCtx = {};

  for (const a of plan.actions) {
    try {
      if (a.type === 'create') {
        const p0 = a.parts[0];
        const vc = await vcenterOfPart(p0, vcCtx);
        const kinds = [...new Set(a.parts.map((p) => p.kind))];
        const prio = a.parts.map((p) => cfg.priority[p.kind] || 'p2').sort()[0];
        const component = kinds.length === 1 ? kindText(kinds[0]) : '하드웨어';
        let auto = null;
        if (viewers) auto = suggestAssignee({ component, vcenterId: vc.id }, settings, issueStats().byAssignee, viewers.canSee);
        const body = {
          title: titleOf(cfg.titleTpl, p0, { corp: vc.name, parts: a.parts.length }), body: bodyOf(a.parts, { device: !!a.device }),
          type: 'incident', priority: prio, labels: cfg.labels, component, vcenterId: vc.id, status: 'backlog',
        };
        const origin = { kind: 'partfault', agent: t(p0.agent).toLowerCase(), scope: p0.scope, deviceId: p0.deviceId, deviceName: p0.deviceName, partKeys: a.parts.map(idOf) };
        let x;
        try { x = createIssue(body, SYSTEM_USER, { auto, origin }); } catch (e) {
          if (e?.field !== 'vcenterId') throw e;
          x = createIssue({ ...body, vcenterId: '' }, SYSTEM_USER, { auto, origin }); // 형식 밖 vCenter id — 공용으로
        }
        for (const p of a.parts) out.handled.add(idOf(p));
        out.created += 1; status.created += 1;
        void x;
      } else if (a.type === 'attach') {
        patchOrigin(a.key, (o) => ({ ...o, partKeys: [...o.partKeys, ...a.parts.map(idOf)] }));
        comment(a.key, `같은 장비에서 파트 장애가 더 열렸습니다(${a.parts.length}건) — 장비 단위 이슈에 붙입니다.\n${a.parts.map((p) => `· ${alertOf(p).title}`).join('\n')}`);
        for (const p of a.parts) out.handled.add(idOf(p));
        out.attached += 1; status.attached += 1;
      } else if (a.type === 'reopen') {
        const o = patchOrigin(a.key, (o2) => ({ ...o2, reopen: (o2.reopen || 0) + 1, resolved: o2.resolved.filter((k) => k !== a.id), hold: '' })).origin;
        comment(a.key, `같은 파트가 다시 열렸습니다(${o.reopen}회째) — ${alertOf(a.p).title} · ${stateText(a.p.state)}`);
        out.handled.add(a.id);
      } else if (a.type === 'change') {
        patchOrigin(a.key, (o) => ({ ...o, hold: '' }));
        comment(a.key, `상태가 바뀌었습니다: ${stateText(a.from) || '—'} → ${stateText(a.p.state)} — ${alertOf(a.p).title}`);
        out.handled.add(a.id);
      } else if (a.type === 'migrate') {
        patchOrigin(a.key, (o) => ({ ...o, partKeys: o.partKeys.map((k) => (k === a.from ? a.to : k)), resolved: o.resolved.filter((k) => k !== a.from) }));
        status.migrated += 1;
        out.handled.add(a.to);
      } else if (a.type === 'resolve') {
        const o = patchOrigin(a.key, (o2) => ({ ...o2, resolved: [...o2.resolved, a.id], hold: '' })).origin;
        const why = a.reason === 'removed' ? '부품이 제거되어 더 이상 보이지 않습니다 — 교체 여부를 확인하세요'
          : a.reason === 'manual' ? '파트 장애 화면에서 사람이 닫았습니다' : '정상으로 돌아왔습니다';
        const allDone = o.partKeys.every((k) => o.resolved.includes(k));
        comment(a.key, `해소: ${alertOf(a.p, { closed: true }).title} — ${why}${o.partKeys.length > 1 ? ` (${o.resolved.length}/${o.partKeys.length})` : ''}`);
        if (allDone && cfg.onResolve === 'review' && a.reason !== 'manual') {
          const cur = findByOrigin((_o, x) => x.key === a.key)[0];
          if (cur && cur.status !== 'review' && cur.status !== 'done') { setStatus(a.key, 'review', SYSTEM_USER); out.review += 1; status.review += 1; }
        }
        out.handled.add(a.id);
      } else if (a.type === 'hold') {
        patchOrigin(a.key, (o) => ({ ...o, hold: a.reason }));
        comment(a.key, `판정 보류(닫지 않음): ${HOLD_TEXT[a.reason] || a.reason} — 다음 점검에서 다시 판정합니다.`);
      }
    } catch (e) {
      status.errors += 1; status.error = `${a.type}: ${String(e?.message || e).slice(0, 180)}`;
      console.warn(`[issues] 파트 장애 자동 등록 실패(${status.error})`);
    }
  }
  return out;
}

/**
 * 시험 실행 — 지난 hours 시간의 파트 장애 이벤트에 지금 설정을 대 본다. 만들지 않는다.
 * 이벤트는 열림 · 변화 · 해소만 남아 있어 보류(held)는 빠진다(전이 표에 보류 이벤트가 없다 — db.js).
 */
export async function simulatePartFault({ hours = 24, now = Date.now(), cfgOverride = null } = {}) {
  const cfg = cfgOverride ? normalizeAutoCreate(cfgOverride, { strict: true }).value.partfault : loadAutoCreate().partfault;
  const h = Math.max(1, Math.min(168, Math.trunc(Number(hours)) || 24));
  const { recentEvents } = await import('../partfault/db.js');
  const evs = await recentEvents({ sinceMs: h * 3_600_000, limit: 2_000 });
  const tr = { opened: [], updated: [], closed: [], held: [] };
  for (const e of [...evs].reverse()) { // 최신 → 오래된 순으로 오므로 뒤집는다
    if (e.event === 'open') tr.opened.push({ ...e });
    else if (e.event === 'change') tr.updated.push({ ...e, sameState: false });
    else if (e.event === 'close') tr.closed.push({ ...e, state: e.prevState });
  }
  const existing = findByOrigin((o) => o.kind === 'partfault');
  const plan = planPartFault(tr, { ...cfg, dailyMax: cfg.dailyMax }, { existing, now, createdToday: originCreatedSince('partfault', todayStartMs(now)) });
  const count = (type) => plan.actions.filter((a) => a.type === type).length;
  const samples = plan.actions.filter((a) => a.type === 'create').slice(0, 10).map((a) => titleOf(cfg.titleTpl, a.parts[0], { parts: a.parts.length }));
  return {
    hours: h, events: evs.length, truncated: evs.length >= 2_000,
    create: count('create'), attach: count('attach'), comment: count('reopen') + count('change') + count('resolve') + count('attach'),
    review: plan.actions.filter((a) => a.type === 'resolve' && a.reason !== 'manual').length, skipped: plan.skipped, capped: plan.capped, samples,
  };
}
