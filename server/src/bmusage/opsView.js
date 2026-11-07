/**
 * bmusage/opsView.js — 리눅스 성능 4단계(v2.923 예정) 서버 상세 탭 · 함대 보기의 **조립**(순수에 가까운 도메인 모듈 — 라우트는 routes/api/bmUsage.js).
 *
 *  · 튜닝: tuning/judge.js(판정) + profiles/match.js(기능 프로파일이 덮는 항목) + tuning/overrides.js(관리자 덮어쓰기) — 이 모듈은 셋을 이어 붙이기만 한다.
 *  · 용도: profiles/match.js profileView 그대로 + 함대 매트릭스(OS × 기능 칸의 서버 수 · 상태 수).
 *  · 장애 기록: **새 수집 없음** — 부품 장애 모듈의 장애별 묶음(partfault/incidents.js · 라우트 computeIncidents)을 서버 하나로 좁힌다.
 *    상태 · 종료 사유 · 보류 사유는 그 모듈의 code 그대로(다시 판정하지 않는다) · 요약 5칸은 그 code 를 세기만 한다.
 * ⚠ 판정 · 문구를 웹에 두지 않는다(웹은 code → 문장).
 */
import { parseJsonCol } from './perfView.js';
import { judgeTuning } from './tuning/judge.js';
import { TUNING_ITEMS, CATEGORIES, ROLES, TUNING_STATUS, TUNING_REASON } from './tuning/catalog.js';
import { TUNING_SOURCES, PROFILE_SOURCES, SOURCES_CHECKED_AT } from './tuning/sources.js';
import { profileView, appRulesForJudge, detectProfiles } from './profiles/match.js';
import { catalogView, APP_IDS, CHECK_STATUS, CHECK_REASON, PROFILE_STATUS, PLANNED_PROFILES, PROFILES } from './profiles/index.js';
import { INCIDENT_END, closeReasonToEnd } from '../partfault/incidents.js';

const t = (v) => String(v ?? '').trim();

/** 행(이 노드 최신값) → 사실. 엣지 보관분은 이미 객체(정제본)라 그대로. */
export function factsOfRow(row) {
  return { tuning: parseJsonCol(row?.tuning_json), detail: parseJsonCol(row?.detail_json) };
}

/** 튜닝 탭 한 서버 — 판정 + 근거 문서 + 분류. */
export function tuningViewFor({ tuning = null, detail = null, manual = null, vcenterId = '', overridesFor = null } = {}) {
  const det = detectProfiles(tuning, { manual, detail });
  const app = appRulesForJudge(det.activeApps);
  const ov = typeof overridesFor === 'function' ? overridesFor({ role: det.role, vcenterId }) : { map: {}, error: null };
  const j = judgeTuning({ tuning, detail, role: det.role, appRules: app.rules, overrides: ov.map || {} });
  return {
    ...j, roleManual: det.roleManual, activeApps: det.activeApps, osProfile: det.os.profile, os: det.os,
    categories: CATEGORIES, sources: TUNING_SOURCES, sourcesCheckedAt: SOURCES_CHECKED_AT,
    ...(app.conflicts.length ? { conflicts: app.conflicts } : {}),
    sections: tuning?.sections || null,
    ...(tuning?.trimmed ? { trimmed: tuning.trimmed } : {}),
  };
}

/** 용도 프로파일이 인용하는 문서(용도 11건 + 프로파일 항목이 가리키는 튜닝 문서 — 예: rocky9-base 의 TuneD 점검 H1). */
const PROFILE_REF_IDS = new Set(PROFILES.flatMap((p) => [...p.sources, ...p.checks.flatMap((c) => c.sources), ...p.tunings.flatMap((x) => x.sources)]));
export const PROFILE_VIEW_SOURCES = Object.freeze([...PROFILE_SOURCES, ...TUNING_SOURCES.filter((s) => PROFILE_REF_IDS.has(s.id))]);
/** 용도 탭 한 서버. */
export function profileViewFor({ tuning = null, detail = null, entry = null, row = null, manual = null } = {}) {
  return { ...profileView({ tuning, detail, entry, row, manual }), sources: PROFILE_VIEW_SOURCES, sourcesCheckedAt: SOURCES_CHECKED_AT };
}

/**
 * 함대 — OS × 기능 매트릭스 + 서버 목록 + 튜닝 항목별 상태 수.
 * @param {Array<{key,name,vcenterId,agent,tuning,detail,entry,row,manual,overridesFor}>} items  보이는 서버(범위 · 가림은 라우트가 이미 적용)
 */
export function fleetProfileView(items = [], { overridesFor = null } = {}) {
  const cells = new Map();   // osKey → { label, osProfile, byApp:{ appId|'none': {servers, status:{…}} } }
  const servers = [];
  const tuningCounts = Object.fromEntries(TUNING_ITEMS.map((x) => [x.id, { advise: 0, ok: 0, info: 0, unknown: 0 }]));
  let noFacts = 0;
  for (const it of items) {
    if (!it.tuning) noFacts += 1;
    const pv = profileView({ tuning: it.tuning, detail: it.detail, entry: it.entry, row: it.row, manual: it.manual });
    const det = pv.detection;
    const os = det.os;
    if (!cells.has(os.key)) cells.set(os.key, { osKey: os.key, label: os.label, osProfile: os.profile, byApp: {} });
    const c = cells.get(os.key);
    const apps = det.activeApps.length ? det.activeApps : ['none'];
    for (const a of apps) {
      const b = (c.byApp[a] ||= { servers: 0, status: Object.fromEntries(PROFILE_STATUS.map((s) => [s, 0])) });
      b.servers += 1;
      b.status[pv.status] += 1;
    }
    const tv = tuningViewFor({ tuning: it.tuning, detail: it.detail, manual: it.manual, vcenterId: it.vcenterId, overridesFor: it.overridesFor || overridesFor });
    for (const x of tv.items) tuningCounts[x.id][x.status] += 1;
    servers.push({
      key: it.key, name: it.name, vcenterId: it.vcenterId || '', ...(it.agent ? { agent: it.agent } : {}),
      os: os.label, osProfile: os.profile, apps: det.activeApps, manual: det.manualApplied, role: det.role, roleManual: det.roleManual,
      status: pv.status, factsRead: !!it.tuning,
      tuning: tv.counts,
      checkCounts: pv.profiles.reduce((acc, p) => { for (const ch of p.checks) acc[ch.status] = (acc[ch.status] || 0) + 1; return acc; }, {}),
    });
  }
  return {
    columns: [...APP_IDS, 'none'],
    rows: [...cells.values()].sort((a, b) => (b.osProfile ? 1 : 0) - (a.osProfile ? 1 : 0) || a.label.localeCompare(b.label)),
    servers, noFacts,
    tuningItems: TUNING_ITEMS.map((x) => ({ id: x.id, cat: x.cat, title: x.title, grade: x.grade, sources: x.sources, counts: tuningCounts[x.id] })),
    catalog: catalogView(), planned: PLANNED_PROFILES,
    categories: CATEGORIES, sources: [...TUNING_SOURCES, ...PROFILE_SOURCES], sourcesCheckedAt: SOURCES_CHECKED_AT,
  };
}

/** 계약 표(웹이 code 를 문장으로 바꿀 때 대조하는 열거 — 응답에 싣는다). */
export const OPS_CODES = Object.freeze({ tuningStatus: TUNING_STATUS, tuningReason: TUNING_REASON, checkStatus: CHECK_STATUS, checkReason: CHECK_REASON, profileStatus: PROFILE_STATUS, roles: ROLES });

/* ── 장애 기록(부품 장애 모듈 재사용) ─────────────────────────────────────────── */

/**
 * 장애별 묶음에서 이 서버 것만. 장비 축은 iDRAC(scope 'idrac') · 장비 키(서비스 태그) 또는 등록부 id, 법인 축은 그 서버를 수집하는 노드 이름(agent).
 * 중앙 자신의 직접 수집분은 agent '' 로 적재된다 — hwFacts 와 같은 규칙(이 노드 이름이 있으면 '' 도 받는다).
 */
export function incidentsForServer(incidents = [], { agent = '', serviceTag = '', regId = '' } = {}) {
  const ag = t(agent); const tag = t(serviceTag).toUpperCase(); const rid = t(regId);
  if (!tag && !rid) return [];
  return (Array.isArray(incidents) ? incidents : []).filter((i) => {
    if (t(i.scope) !== 'idrac') return false;
    if (!(t(i.agent) === ag || (ag && t(i.agent) === ''))) return false;
    return (tag && t(i.deviceKey).toUpperCase() === tag) || (rid && t(i.deviceId) === rid);
  });
}

/**
 * 요약 5칸 — 부품 장애 모듈의 code 를 세기만 한다(다시 판정하지 않는다).
 *  · 열린 = ongoing · 기간 발생 = 기간 안에 시작한 것(이월 제외) · 평균 지속 = 정상 복귀 · 부품 제거로 끝난 것만(수동 닫음 · 시작 모름 제외 — incidents.js 규약) ·
 *    교체 = 종료 사유 removed · 종료 기록 없음 = 종료 사유 unknown(‘정상 복귀’ 가 아니다).
 */
export function faultKpis(list = [], { since = 0 } = {}) {
  const arr = Array.isArray(list) ? list : [];
  const dur = arr.filter((i) => !i.ongoing && i.openedAt != null && (i.endReason === INCIDENT_END.ok || i.endReason === INCIDENT_END.removed));
  return {
    open: arr.filter((i) => i.ongoing).length,
    started: arr.filter((i) => i.openedAt != null && i.openedAt >= since && !i.startedBefore).length,
    avgDurationMs: dur.length ? Math.round(dur.reduce((a, i) => a + Math.max(0, (i.closedAt || 0) - i.openedAt), 0) / dur.length) : null,
    durationSamples: dur.length,
    removed: arr.filter((i) => i.endReason === INCIDENT_END.removed).length,
    endUnknown: arr.filter((i) => i.endReason === INCIDENT_END.unknown).length,
    total: arr.length,
  };
}

/** 표 · 시간순용으로 장애 한 건을 줄인다(필드 그대로 — 판정 없음). */
export function incidentRow(i) {
  return {
    id: i.id, kind: i.kind, label: i.label, openedAt: i.openedAt ?? null, closedAt: i.closedAt ?? null, ongoing: !!i.ongoing,
    durationMs: i.durationMs ?? null, state: i.state ?? null, peak: i.peak ?? null, rawState: i.rawState || '', endReason: i.endReason ?? null,
    holdReason: i.holdReason ?? null, startUnknown: !!i.startUnknown, startedBefore: !!i.startedBefore, migratedFrom: i.migratedFrom ? true : false,
    occurrences: i.occurrences ?? 1,
    // 반증 W5: 닫힘 이벤트의 종료 사유 code 는 서버(incidents.js closeReasonToEnd)가 정한다 — 웹은 문구로만 바꾼다.
    events: (i.events || []).slice(0, 20).map((e) => ({ at: e.at, event: e.event, state: e.state ?? null, prevState: e.prevState ?? null, closeReason: e.closeReason ?? null, endReason: e.event === 'close' ? closeReasonToEnd(e.closeReason) : null })),
  };
}
