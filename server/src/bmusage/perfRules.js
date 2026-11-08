/**
 * bmusage/perfRules.js — 리눅스 성능 5단계(v2.929 예정) **알림 규칙 · 집중 모니터링 · 베이스라인 · 점검 소모품 · 변경 이벤트 · 구간 비교** 설정(설계 PROFILES §13·§14 · 아트보드 Alerts).
 *
 * ⚠ 파일을 나눈 이유: 베어메탈 사용률 설정(`bmusage-settings.json` · settings.js)은 엣지 배포(DISTRIBUTED_KEYS · 서명)와 묶여 있다 — 여기 값을 그 파일에 넣으면
 *   배포 서명이 바뀌어 구버전 엣지가 영원히 ‘적용 대기’ 가 된다(v2.919 `perf` 와 같은 판단). 그래서 **이 노드 전용 파일**(`bm-perf-rules.json`)이고
 *   엣지는 자기 화면에서 정한다. 중앙 → 엣지 배포는 다음 판(전 엣지가 이 판 이상일 때 — 정직 기록 · idrac-server.md v2.929).
 *
 * 규칙(아트보드 ⑨): 종류 6 — use(USE 판정 변화) · cross(교차 판정 성립) · focusEnd(집중 결론) · baseline(베이스라인 이탈) · health(점검 소모품) · profile(용도 점검 실패).
 *   열 — 켬 · 조건 · 지속(주기) · 재발 억제(분) · 채널(기존 알림 채널) · 이슈 자동 등록 · 자동 집중 · 법인 예외. **켠 규칙만 저장한다**(false 를 쌓지 않는다 — v2.550 ‘켠 법인만’ 과 같은 판단).
 * 파일 스토어 규약(perf-db.md v2.582): 원자 쓰기 · 손상 보존 · 손상이면 기본값(전부 꺼짐)으로 동작하고 저장은 거부하지 않되 화면이 loadError 로 말한다(settingsLoadError 등록).
 *   비밀 없음(채널 URL 은 alerts.json 에 있고 여기에는 채널 **이름**만 — 웹훅 URL 은 비밀이라 싣지 않는다).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { makeSettingsLoadError } from '../util/settingsLoadError.js';
import { HEALTH_DEFAULTS } from './health.js';
import { LINE_CAP_RANGE, LINE_CAP_DEFAULT } from './logs/command.js';

const FILE = () => path.join(config.configDir, 'bm-perf-rules.json');

// 6단계: collect(수집 건강 — 서버가 아니라 이 수집 노드 한 칸: 주기 소요 · 성공률 · DB 상한 · 인증 정지).
// 7a단계: logs(로그 분석 — 이번 주기에 읽은 줄 중 장애 분류 · 보안 high 이상이 있으면 · 기본 꺼짐).
// 8a단계: capacity(용량 소진 예측 — 목표선 도달 ≤ N일 · 기본 꺼짐 · 수집 노드의 하루 계산 결과 bm-capacity.json 을 쓴다).
export const RULE_IDS = Object.freeze(['use', 'cross', 'focusEnd', 'baseline', 'health', 'profile', 'collect', 'logs', 'capacity']);
/** 규칙별 조건 선택지(웹 문구 표와 1:1). */
export const RULE_CONDS = Object.freeze({
  use: Object.freeze(['sat-err', 'bottleneck', 'errors']),
  cross: Object.freeze(['any']),
  focusEnd: Object.freeze(['not-ok', 'any']),
  baseline: Object.freeze(['band']),
  health: Object.freeze(['any', 'bad']),
  profile: Object.freeze(['bad']),
  collect: Object.freeze(['any', 'cycle', 'success', 'db', 'auth', 'error']),
  logs: Object.freeze(['fault-sec', 'fault', 'sec']),
  capacity: Object.freeze(['fs-inode', 'any', 'fs', 'inode']),
});
/** 기존 알림 채널(alerts.js channels) — 새 채널을 만들지 않는다. */
export const CHANNELS = Object.freeze(['email', 'webhook', 'slack', 'teams']);
/** 베이스라인 이탈 감시 지표(1시간 롤업에 합·개수가 있는 열). */
export const BASELINE_METRICS = Object.freeze(['cpu_pct', 'mem_pct', 'disk_busy_pct', 'disk_await_ms', 'net_pct']);

/** 규칙 기본값(아트보드 표 그대로 — 꺼짐). */
export const RULE_DEFAULTS = Object.freeze({
  use: Object.freeze({ cond: 'sat-err', sustain: 2, repeatMin: 360, channels: ['email', 'webhook'], issue: false, autoFocus: false }),
  cross: Object.freeze({ cond: 'any', sustain: 1, repeatMin: 1440, channels: ['email'], issue: false, autoFocus: false }),
  focusEnd: Object.freeze({ cond: 'not-ok', sustain: 1, repeatMin: 0, channels: ['email', 'webhook'], issue: false, autoFocus: false }),
  baseline: Object.freeze({ cond: 'band', sustain: 3, repeatMin: 240, channels: ['webhook'], issue: false, autoFocus: false }),
  health: Object.freeze({ cond: 'any', sustain: 1, repeatMin: 720, channels: ['email'], issue: false, autoFocus: false }),
  profile: Object.freeze({ cond: 'bad', sustain: 1, repeatMin: 30, channels: ['email', 'webhook'], issue: false, autoFocus: false }),
  collect: Object.freeze({ cond: 'any', sustain: 2, repeatMin: 360, channels: ['email'], issue: false, autoFocus: false }),
  logs: Object.freeze({ cond: 'fault-sec', sustain: 1, repeatMin: 60, channels: ['email'], issue: false, autoFocus: false }),
  capacity: Object.freeze({ cond: 'fs-inode', sustain: 1, repeatMin: 1440, channels: ['email'], issue: false, autoFocus: false }),
});
export const LIMITS = Object.freeze({
  sustain: [1, 48], repeatMin: [0, 10_080], corpsOff: 200,
  daily: { alerts: [1, 1_000], issues: [1, 500], autoFocus: [1, 200], manualFocus: [1, 500] },
  focus: { intervalS: [30, 600], durationMin: [1, 60], corpMax: [1, 32], nodeMax: [1, 64], keepDays: [1, 90], autoSuppressMin: [5, 1_440] },
  baseline: { weeks: [2, 12], bandPct: [5, 300], minWeeks: [2, 12], maxMissingPct: [0, 90] },
  health: { chronyMs: [1, 600_000], fdPct: [10, 99], conntrackPct: [10, 99], dmesgErr24h: [0, 100_000], certDays: [1, 365] },
  changes: { keepDays: [7, 400] },
  // 6단계: maxServers — 서버 비교 한 화면의 서버 수 상한(설계 §15 ‘2~5대 · 상한 설정 · 기본 5’ — 바깥 한계 8: 열이 늘면 400 폭 · 엣지 요청이 그만큼 는다).
  compare: { diffPct: [1, 500], maxServers: [2, 8] },
  // 6단계 수집 건강 기준(보드 상태 · 알림 규칙 ‘수집 건강’ 행이 같은 값 — collectHealth.collectCells). dbCapGb 0 = 상한 없음(DB 칸은 판정 보류).
  collect: { cyclePct: [10, 100], successPct: [10, 100], dbPct: [10, 100], dbCapGb: [0, 10_000] },
  // 7a단계 로그 분석 — 주기당 출처별 줄 상한 · 보관(일) · SSH 실패 집중(같은 IP · 창 분 · 임계 줄).
  //   줄 상한의 범위는 명령의 산수(command.js LINE_CAP_RANGE — 앱 두 개가 한 구획이라 2 × 상한 + 메타 < 구획 줄 상한 · 반증 F4)에서 온다.
  logs: { lineCap: [...LINE_CAP_RANGE], keepDays: [1, 90], burstCount: [2, 1_000], burstWindowMin: [1, 60] },
  // 8a단계 용량 소진 예측 — 목표선(%) · 데이터 부족 기준(14일 창 안 점 수) · 알림 ‘소진 ≤ N일’.
  capacity: { targetPct: [50, 99], minDays: [3, 14], days: [1, 90] },
  // 8b단계 ⑳ 프로세스 Top-N — 5분 표본 보존(일 · 날 파일) · comm 별 시간 집계 보존(일). on=false 면 ##TOP 구획이 ‘꺼짐’ 한 줄(1초 대기 없음).
  top: { keepDays: [1, 14], hourlyDays: [7, 365] },
  // 8b단계 ㉑ 저활용 — 창(일 · 30 기본 · 90 옵션) · 데이터 부족(<21일) · 후보/관찰 점수 · 가중치 6 · ‘낮다’ 기준(관행 — 설정값) · 주기 사용 판정(높은 날 기준 %).
  idle: { windowDays: [14, 90], minDays: [7, 90], candidate: [1, 100], watch: [0, 99], wCpu: [0, 100], wMem: [0, 100], wDisk: [0, 100], wNet: [0, 100], wPower: [0, 100], wAct: [0, 100],
    cpuAvgPct: [1, 50], cpuMaxPct: [1, 100], memAvgPct: [1, 90], diskBusyMaxPct: [1, 90], netMaxPct: [1, 90], powerIdlePct: [101, 300], periodicHighPct: [10, 100] },
  // 8b단계 ㉒ 전력 · 온도 — 흡기 기준(°C · 모델별 권장 아님 — 설정값) · PowerCap ‘걸림’(측정 ≥ 상한 × %) · 랙 여유 주의(%). 랙 배치는 racks(아래 normalizeRacks).
  power: { inletWarnC: [15, 45], capHitPct: [80, 100], rackLowPct: [1, 50] },
  racks: { max: 500, serversPerRack: 256, textBytes: 64 * 1024 },
});
export const DEFAULTS = Object.freeze({
  rules: {},
  // manualFocus(반증 F11): 사람이 누르는 집중도 법인당 하루 상한 — 누를 때마다 SSH · Redfish 를 분마다 연다(스냅샷 dailyCorpMax 와 같은 판단).
  daily: { alerts: 50, issues: 20, autoFocus: 10, manualFocus: 20 },
  // 집중 모니터링(§13): 기본 10분 × 1분 · 간격 하한 30초 · 길이 상한 60분 · 법인당 동시 5 · 30일 보관 · 자동 집중은 기본 꺼짐(법인 옵트인) · 같은 서버 재발 억제 30분.
  // nodeMax(반증 L11): 이 노드 전체 동시 집중 상한 — 법인 상한만 있으면 중앙 직접 수집(엣지 없는 법인 여럿)에서 법인 수 × 5 가 앞자리 대기로 슬롯을 먼저 가져간다.
  focus: { intervalS: 60, durationMin: 10, corpMax: 5, nodeMax: 10, keepDays: 30, autoCorps: [], autoSuppressMin: 30 },
  baseline: { weeks: 4, bandPct: 40, minWeeks: 4, maxMissingPct: 25 },
  health: { ...HEALTH_DEFAULTS },
  changes: { keepDays: 30 },
  compare: { diffPct: 20, maxServers: 5 },
  collect: { cyclePct: 80, successPct: 90, dbPct: 90, dbCapGb: 20 },
  // 7a단계 로그 분석(설계 §17 — 줄 상한 5,000 · 보관 30일 · ‘외부 IP 집중’ 5분 20회 — 설정값). on=false 면 로그 읽기 exec 를 붙이지 않는다.
  logs: { on: true, lineCap: LINE_CAP_DEFAULT, keepDays: 30, burstCount: 20, burstWindowMin: 5 },
  // 8a단계 용량 소진 예측(설계 ⑱ — 목표 90% · 데이터 부족 7일 · 알림 7일 — 설정값).
  capacity: { targetPct: 90, minDays: 7, days: 7 },
  // 8b단계 ⑳ 프로세스 Top-N(설계 — 5분 7일 · 시간 집계 90일 · 실측 뒤 보존 조정).
  top: { on: true, keepDays: 7, hourlyDays: 90 },
  // 8b단계 ㉑ 저활용(설계 점수표 그대로 — 가중 CPU 30 · 메모리 15 · 디스크 15 · 네트 15 · 전력 15 · 활동 10 · ≥70 후보 · 40~69 관찰 · 21일 미만 데이터 부족).
  idle: { on: true, windowDays: 30, minDays: 21, candidate: 70, watch: 40, wCpu: 30, wMem: 15, wDisk: 15, wNet: 15, wPower: 15, wAct: 10,
    cpuAvgPct: 5, cpuMaxPct: 20, memAvgPct: 20, diskBusyMaxPct: 5, netMaxPct: 2, powerIdlePct: 110, periodicHighPct: 50 },
  // 8b단계 ㉒ 전력 · 온도(흡기 27 °C · 걸림 98% · 랙 여유 주의 10% — 설정값).
  power: { inletWarnC: 27, capHitPct: 98, rackLowPct: 10 },
  // 유지보수 창 억제(Bareos · Veeam 스케줄) — 베어메탈 서버의 백업 창을 읽는 원천이 아직 없다(perfAlerts.maintenanceFor 머리말). 켜 두면 원천이 생길 때 바로 쓴다.
  maintenance: { backupWindows: true },
});

const _err = makeSettingsLoadError(FILE, { label: '베어메탈 성능 알림 규칙 · 집중 모니터링', confirm: () => writeFile(normalizeRules({}, { strict: false }).value) });
let _cache = null; let _mtime = '';
const mtimeOf = () => { try { const st = fs.statSync(FILE()); return `${st.mtimeMs}:${st.size}`; } catch { return ''; } };
function fieldError(field, msg) { const e = new Error(`${field}: ${msg}`); e.status = 400; e.field = field; return e; }
const VC_RE = /^[A-Za-z0-9._:@-]{1,128}$/;
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty']);

/**
 * 정규화(엄격 = 저장 · 느슨 = 읽기). 켠 규칙만 남긴다. 숫자는 범위 밖이면 400(엄격) 또는 기본값(느슨 — 버린 수를 센다).
 * @returns {{ value:object, dropped:number }}
 */
export function normalizeRules(raw, { strict = true } = {}) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  let dropped = 0;
  const bad = (field, msg) => { if (strict) throw fieldError(field, msg); dropped += 1; };
  const int = (v, [lo, hi], field, def) => {
    if (v == null || v === '') return def;
    const x = typeof v === 'number' ? v : (typeof v === 'string' && /^-?\d{1,7}$/.test(v.trim()) ? Number(v) : NaN);
    if (Number.isInteger(x) && x >= lo && x <= hi) return x;
    bad(field, `${lo}~${hi} 의 정수여야 합니다`); return def;
  };
  const vcList = (v, field, max = LIMITS.corpsOff) => {
    if (v == null) return [];
    if (!Array.isArray(v)) { bad(field, '배열이어야 합니다'); return []; }
    const out = [...new Set(v.map((x) => String(x ?? '').trim()).filter(Boolean))];
    if (out.length > max || out.some((x) => !VC_RE.test(x) || BAD_KEYS.has(x))) { bad(field, `vCenter id 형식 · ${max}개까지입니다`); return out.filter((x) => VC_RE.test(x) && !BAD_KEYS.has(x)).slice(0, max); }
    return out;
  };
  const rules = {};
  const rin = r.rules && typeof r.rules === 'object' && !Array.isArray(r.rules) ? r.rules : {};
  for (const id of Object.keys(rin)) if (!RULE_IDS.includes(id)) bad(`rules.${id}`, '모르는 규칙입니다');
  for (const id of RULE_IDS) {
    const x = Object.hasOwn(rin, id) ? rin[id] : null;
    if (!x || typeof x !== 'object' || Array.isArray(x)) continue;
    if (x.on !== true) continue;   // 켠 규칙만 저장(false 를 쌓지 않는다)
    const d = RULE_DEFAULTS[id];
    const cond = x.cond == null ? d.cond : (RULE_CONDS[id].includes(x.cond) ? x.cond : (bad(`rules.${id}.cond`, `${RULE_CONDS[id].join('·')} 중 하나여야 합니다`), d.cond));
    let channels = d.channels;
    if (x.channels != null) {
      if (!Array.isArray(x.channels) || x.channels.some((c) => !CHANNELS.includes(c))) { bad(`rules.${id}.channels`, `${CHANNELS.join('·')} 만 쓸 수 있습니다`); channels = (Array.isArray(x.channels) ? x.channels : []).filter((c) => CHANNELS.includes(c)); }
      else channels = [...new Set(x.channels)];
    }
    rules[id] = {
      on: true, cond,
      sustain: int(x.sustain, LIMITS.sustain, `rules.${id}.sustain`, d.sustain),
      repeatMin: int(x.repeatMin, LIMITS.repeatMin, `rules.${id}.repeatMin`, d.repeatMin),
      channels,
      issue: x.issue === true,
      // 집중 결론 규칙은 그 자체가 집중의 끝이라 자동 집중을 걸지 않는다(되먹임 고리). 수집 건강은 서버가 아니라 노드 칸이라 집중 대상이 없다.
      autoFocus: id === 'focusEnd' || id === 'collect' || id === 'capacity' ? false : x.autoFocus === true,   // 8a capacity 는 하루 추세라 1분 집중이 뜻이 없다   // 7a ‘logs’ 는 자동 집중 허용(로그 장애 · 보안 → 그 서버 1분 집중 — 법인 옵트인 규약 그대로)
      corpsOff: vcList(x.corpsOff, `rules.${id}.corpsOff`),
    };
  }
  const sec = (name, defs, lim) => {
    const s = r[name] && typeof r[name] === 'object' && !Array.isArray(r[name]) ? r[name] : {};
    const out = {};
    for (const k of Object.keys(defs)) {
      if (Array.isArray(defs[k])) continue;
      if (typeof defs[k] === 'boolean') { out[k] = s[k] == null ? defs[k] : s[k] === true; continue; }
      out[k] = lim?.[k] ? int(s[k], lim[k], `${name}.${k}`, defs[k]) : defs[k];
    }
    return { s, out };
  };
  const daily = sec('daily', DEFAULTS.daily, LIMITS.daily).out;
  const fs0 = sec('focus', DEFAULTS.focus, LIMITS.focus);
  const focus = { ...fs0.out, autoCorps: vcList(fs0.s.autoCorps, 'focus.autoCorps') };
  const baseline = sec('baseline', DEFAULTS.baseline, LIMITS.baseline).out;
  if (baseline.minWeeks > baseline.weeks) { bad('baseline.minWeeks', '표본 주 수(weeks)보다 클 수 없습니다'); baseline.minWeeks = baseline.weeks; }
  const health = sec('health', DEFAULTS.health, LIMITS.health).out;
  const changes = sec('changes', DEFAULTS.changes, LIMITS.changes).out;
  const compare = sec('compare', DEFAULTS.compare, LIMITS.compare).out;
  const collect = sec('collect', DEFAULTS.collect, LIMITS.collect).out;
  const maintenance = sec('maintenance', DEFAULTS.maintenance, null).out;
  const logs = sec('logs', DEFAULTS.logs, LIMITS.logs).out;
  const capacity = sec('capacity', DEFAULTS.capacity, LIMITS.capacity).out;
  const top = sec('top', DEFAULTS.top, LIMITS.top).out;
  const idle = sec('idle', DEFAULTS.idle, LIMITS.idle).out;
  if (idle.watch >= idle.candidate) { bad('idle.watch', '관찰 기준은 후보 기준보다 작아야 합니다'); idle.watch = Math.min(DEFAULTS.idle.watch, idle.candidate - 1); }
  if (idle.minDays > idle.windowDays) { bad('idle.minDays', '데이터 부족 기준은 창(windowDays)보다 클 수 없습니다'); idle.minDays = idle.windowDays; }
  if (['wCpu', 'wMem', 'wDisk', 'wNet', 'wPower', 'wAct'].every((k) => !idle[k])) { bad('idle.wCpu', '가중치가 모두 0 입니다'); Object.assign(idle, { wCpu: DEFAULTS.idle.wCpu }); }
  const p0 = sec('power', DEFAULTS.power, LIMITS.power);
  const racks = normalizeRacks(p0.s, bad);
  const power = { ...p0.out, racks };
  return {
    value: { v: 1, rules, daily, focus, baseline, health, changes, compare, collect, maintenance, logs, capacity, top, idle, power, by: String(r.by || '').slice(0, 64), at: Number(r.at) || 0 },
    dropped,
  };
}

/*
 * 8b단계 ㉒ 랙 배치 — 등록 CSV(7b)에 ‘랙/위치’ 열이 없고 iDRAC 위치 속성은 읽지 않는다(Redfish 왕복을 늘리지 않는다) — 그래서 이 설정이 랙의 **유일한 원천**이다.
 *   racks: [{ vcenterId, rack, capKw|null, servers: [{ key, u|null }] }] — 화면은 텍스트(한 줄 = `법인,랙,상한 kW(비우면 미설정),서버키[@U] 서버키[@U] …` · # 주석)로 고치고
 *   서버가 이 함수로 읽는다(웹이 형식을 다시 해석하지 않는다). 같은 (법인, 랙) 두 번 · 한 서버(법인, 키)가 두 랙 · 형식 밖은 400(엄격) 또는 그 줄을 버린다(느슨).
 */
const RACK_RE = /^[^\u0000-\u001f\u007f,]{1,32}$/;
const SKEY_RE = /^[^\s\u0000-\u001f\u007f,@]{1,256}$/;
export function parseRackText(text, bad = () => {}) {
  const out = [];
  const lines = String(text ?? '').slice(0, LIMITS.racks.textBytes).split(/\r?\n/).slice(0, LIMITS.racks.max + 200);
  lines.forEach((raw, i) => {
    const l = raw.trim();
    if (!l || l.startsWith('#')) return;
    const f = l.split(',');
    if (f.length < 4) { bad(`power.racksText.${i + 1}`, `${i + 1}번째 줄 — ‘법인,랙,상한 kW,서버 키 …’ 네 칸이 필요합니다`); return; }
    const [vc, rack, cap, ...rest] = f.map((x) => x.trim());
    const servers = rest.join(',').split(/\s+/).filter(Boolean).map((tok) => { const m = /^(.+?)(?:@(\d{1,2}))?$/.exec(tok); return { key: m ? m[1] : tok, u: m && m[2] ? Number(m[2]) : null }; });
    out.push({ vcenterId: vc, rack, capKw: cap === '' || cap === '-' ? null : cap, servers, line: i + 1 });
  });
  return out;
}
export function normalizeRacks(src = {}, bad = () => {}) {
  const list0 = typeof src?.racksText === 'string' ? parseRackText(src.racksText, bad) : (Array.isArray(src?.racks) ? src.racks : []);
  if (list0.length > LIMITS.racks.max) bad('power.racks', `랙은 ${LIMITS.racks.max}개까지입니다`);
  const seen = new Set(); const owner = new Map(); const out = [];
  for (const [i, r] of list0.slice(0, LIMITS.racks.max).entries()) {
    const at = r?.line ? `${r.line}번째 줄` : `${i + 1}번째 랙`;
    const vc = String(r?.vcenterId ?? '').trim(); const rack = String(r?.rack ?? '').trim();
    if (!VC_RE.test(vc) || BAD_KEYS.has(vc)) { bad('power.racks', `${at} — 법인(vCenter id) 형식이 다릅니다`); continue; }
    if (!RACK_RE.test(rack)) { bad('power.racks', `${at} — 랙 이름은 1~32자(쉼표 · 제어문자 없음)입니다`); continue; }
    const id = `${vc}|${rack}`;
    if (seen.has(id)) { bad('power.racks', `${at} — 같은 법인에 같은 랙(${rack})이 두 번 있습니다`); continue; }
    let capKw = null;
    if (r.capKw != null && r.capKw !== '') {
      const x = typeof r.capKw === 'number' ? r.capKw : (/^\d{1,4}(?:\.\d{1,2})?$/.test(String(r.capKw).trim()) ? Number(r.capKw) : NaN);
      if (!(Number.isFinite(x) && x >= 0.1 && x <= 1000)) { bad('power.racks', `${at} — 상한 kW 는 0.1~1000 입니다(비우면 미설정)`); continue; }
      capKw = Math.round(x * 100) / 100;
    }
    const servers = [];
    for (const sv of Array.isArray(r.servers) ? r.servers.slice(0, LIMITS.racks.serversPerRack + 1) : []) {
      const key = String(sv?.key ?? '').trim();
      const u = sv?.u == null || sv.u === '' ? null : Number(sv.u);
      if (!SKEY_RE.test(key) || (u != null && !(Number.isInteger(u) && u >= 1 && u <= 60))) { bad('power.racks', `${at} — 서버 키 형식이 다르거나 U 가 1~60 밖입니다(${String(key).slice(0, 40)})`); continue; }
      const sid = `${vc}|${key}`;
      if (owner.has(sid) && owner.get(sid) !== id) { bad('power.racks', `${at} — 서버 ${key} 가 다른 랙(${owner.get(sid).split('|')[1]})에도 있습니다`); continue; }
      if (owner.has(sid)) continue;
      owner.set(sid, id); servers.push({ key, u });
    }
    if ((r.servers || []).length > LIMITS.racks.serversPerRack) bad('power.racks', `${at} — 랙당 서버는 ${LIMITS.racks.serversPerRack}대까지입니다`);
    seen.add(id);
    out.push({ vcenterId: vc, rack, capKw, servers: servers.slice(0, LIMITS.racks.serversPerRack) });
  }
  return out;
}
/** 랙 배치 → 편집 텍스트(서버가 만든다 — 웹은 그대로 보여 주고 고친 텍스트를 보낸다). */
export function racksToText(racks = []) {
  return (Array.isArray(racks) ? racks : []).map((r) => `${r.vcenterId},${r.rack},${r.capKw == null ? '' : r.capKw},${(r.servers || []).map((x) => (x.u == null ? x.key : `${x.key}@${x.u}`)).join(' ')}`).join('\n');
}

function load() {
  const mt = mtimeOf();
  if (_cache && mt === _mtime) return _cache;
  _mtime = mt;
  if (!mt) { _err.missing(); _cache = normalizeRules({}, { strict: false }).value; return _cache; }
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('객체가 아닙니다');
    const { value, dropped } = normalizeRules(raw, { strict: false });
    if (dropped) console.warn(`[bmusage] bm-perf-rules.json 의 형식 밖 항목 ${dropped}개를 읽지 않았습니다(기본값으로)`);
    _cache = value;
    _err.ok();
  } catch (e) {
    preserveCorrupt(FILE(), String(e?.message || e));
    _err.corrupt(e);
    console.warn('[bmusage] bm-perf-rules.json 을 읽지 못해 기본값(알림 규칙 전부 꺼짐 · 자동 집중 꺼짐)으로 동작합니다 — 손상본은 보존했습니다');
    _cache = normalizeRules({}, { strict: false }).value;
    _mtime = mtimeOf();
  }
  return _cache;
}
function writeFile(obj) {
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  atomicWriteFileSync(FILE(), JSON.stringify(obj, null, 2), { mode: 0o600 });
  _cache = null; _mtime = '';
  _err.ok();
  for (const fn of _listeners) { try { fn(); } catch { /* 구독자 오류는 저장을 막지 않는다 */ } }
}
const _listeners = new Set();
export function onPerfRulesChange(fn) { if (typeof fn === 'function') _listeners.add(fn); return () => _listeners.delete(fn); }

/** 현재 설정(사본). */
export function loadPerfRules() { return JSON.parse(JSON.stringify(load())); }
export function perfRulesLoadError() { load(); return _err.get(); }
/**
 * 저장(엄격 정규화 — 형식 밖은 400). 반환: 저장된 값 + 이전 값(감사 diff 용 — 비밀 없음).
 */
export function savePerfRules(body, { by = '' } = {}) {
  const prev = load();
  const { value } = normalizeRules({ ...(body && typeof body === 'object' ? body : {}) }, { strict: true });
  const next = { ...value, by: String(by).slice(0, 64), at: Date.now() };
  writeFile(next);
  return { ok: true, value: loadPerfRules(), prev };
}
/** 감사 요약 — 켠 규칙 id · 바뀐 절(비밀 없음 · 300자). */
export function rulesAuditSummary(prev, next) {
  const on = (x) => Object.keys(x?.rules || {}).sort().join(',');
  const changed = ['daily', 'focus', 'baseline', 'health', 'changes', 'compare', 'collect', 'maintenance', 'logs', 'capacity', 'top', 'idle', 'power'].filter((k) => JSON.stringify(prev?.[k]) !== JSON.stringify(next?.[k]));
  return JSON.stringify({ before: on(prev), after: on(next), changed }).slice(0, 300);
}
export function _resetPerfRulesForTest() { _cache = null; _mtime = ''; _err.ok(); _listeners.clear(); }
