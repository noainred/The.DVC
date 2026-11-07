/**
 * bmusage/profiles/match.js — 용도 프로파일 **감지 · 병합 · 상태**(순수 · v2.923 예정 · 설계 PROFILES §1).
 *
 *  · 감지: OS 는 os-release(ID · VERSION_ID), 기능은 각 프로파일의 `detect`(유닛 · 프로세스 이름 · 포트 · 계정 — 1단계 SSH 1회의 구획). 읽기 전용.
 *  · **수동 태그가 덮어쓴다**(fleet-tags.json `purposes` — 새 등록부 없음): `apps` 가 있으면 감지 결과 대신 그 목록(빈 목록 = ‘기능 없음’ 으로 확정), `role` 은 튜닝 역할.
 *  · 우선순위: **기능 > 역할 > OS 기본**. 기능 프로파일의 OS 요구값 중 카탈로그 항목과 같은 것(catalogId)은 튜닝 판정에서 역할 권장값을 덮는다(appRulesFor).
 *    한 서버에 기능이 둘이면 둘 다 적용하고, 같은 항목을 둘이 덮으면 APP_PRIORITY 앞쪽이 이기며 충돌을 밝힌다.
 *  · 상태: 점검(ok · warn · bad)과 요구값(advise → warn)을 모아 가장 나쁜 것. 미수집 · 확인 불가 · 참고는 판정에 넣지 않고 따로 센다(정상으로 세지 않는다).
 *    맞는 프로파일이 하나도 없으면 ‘프로파일 없음’(none — 점검하지 않음).
 * ⚠ 판정 · 문구 복제 금지 — 웹은 이 결과의 code 를 문장으로 바꾸기만 한다.
 */
import { PROFILES, APP_PROFILES, APP_IDS, APP_PRIORITY, OS_PROFILES, profileById } from './index.js';
import { evalRule } from '../tuning/judge.js';
import { ROLES, DEFAULT_ROLE } from '../tuning/catalog.js';

const RANK = { bad: 3, warn: 2, ok: 1 };
const OS_NAME = Object.freeze({ rocky: 'Rocky', rhel: 'RHEL', centos: 'CentOS', ubuntu: 'Ubuntu', debian: 'Debian', almalinux: 'AlmaLinux', ol: 'Oracle Linux', sles: 'SLES', amzn: 'Amazon Linux' });

/** OS 표시 이름(매트릭스 행) — os-release 가 없으면 Windows(수집 형식) 또는 ‘미확인’. */
export function osLabelOf(tu, detail = null) {
  const id = tu?.os?.id ? String(tu.os.id) : '';
  if (id) {
    const ver = tu.os.versionId ? String(tu.os.versionId) : '';
    return { key: `${id}|${ver}`, label: `${OS_NAME[id] || id}${ver ? ` ${ver}` : ''}`, id, versionId: ver || null };
  }
  if (detail?.osKind === 'windows') return { key: 'windows|', label: 'Windows', id: 'windows', versionId: null };
  return { key: 'unknown|', label: '미확인', id: null, versionId: null };
}

/**
 * 감지 + 수동 태그.
 * @param {object|null} tu       tuning(감지 사실)
 * @param {{manual?:{apps?:string[], role?:string}|null, detail?:object|null}} o
 */
export function detectProfiles(tu, { manual = null, detail = null } = {}) {
  const os = osLabelOf(tu, detail);
  const osProfile = OS_PROFILES.find((p) => { try { return p.match(tu); } catch { return false; } }) || null;
  const detected = APP_PROFILES.map((p) => {
    let d = { detected: false, evidence: [] };
    try { d = p.detect(tu); } catch { /* 감지 실패 — 감지 안 됨 */ }
    return { id: p.id, detected: !!d.detected, evidence: d.evidence || [], ...(d.role ? { gpRole: d.role } : {}) };
  });
  const manualApps = Array.isArray(manual?.apps) ? manual.apps.filter((a) => APP_IDS.includes(a)) : null;
  const apps = detected.map((x) => ({ ...x, active: manualApps ? manualApps.includes(x.id) : x.detected, manual: !!manualApps }));
  const role = manual?.role && ROLES.includes(manual.role) ? manual.role : DEFAULT_ROLE;
  return {
    os: { ...os, profile: osProfile ? osProfile.id : null },
    apps, activeApps: apps.filter((a) => a.active).map((a) => a.id),
    role, roleManual: !!(manual?.role && ROLES.includes(manual.role)),
    manualApplied: !!manualApps,
    // 감지 사실을 못 읽었으면(구획 missing) 그 사실을 밝힌다 — ‘감지 안 됨’ 과 ‘못 읽음’ 은 다르다.
    factsRead: {
      os: tu?.sections?.osrel || 'missing', units: tu?.sections?.units || 'missing', ports: tu?.sections?.ports || 'missing',
      procs: tu?.sections?.procs || 'missing', accounts: tu?.sections?.acct || 'missing',
    },
  };
}

/** 기능 프로파일 → 튜닝 카탈로그 덮어쓰기 규칙 { 항목 id: { rule, by, item } } + 충돌. */
export function appRulesFor(appIds = []) {
  const order = [...APP_PRIORITY.filter((id) => appIds.includes(id)), ...appIds.filter((id) => !APP_PRIORITY.includes(id))];
  const map = {}; const conflicts = [];
  for (const id of order) {
    const p = profileById(id);
    if (!p) continue;
    for (const t of p.tunings) {
      if (!t.catalogId) continue;
      if (map[t.catalogId]) { conflicts.push({ item: t.catalogId, kept: map[t.catalogId].by, dropped: `profile:${id}` }); continue; }
      map[t.catalogId] = { rule: { ...t.rule }, by: `profile:${id}`, profileItem: t };
    }
  }
  return { map, conflicts };
}

/**
 * 카탈로그 판정(judge.js)에 넘길 규칙 — 기능 프로파일 항목의 사실 읽기(fact)를 그대로 쓰도록 규칙만 넘긴다.
 * 장치 단위 항목은 카탈로그 항목의 장치 선택을 쓴다(같은 의미의 키이므로).
 */
export function appRulesForJudge(appIds = []) {
  const { map, conflicts } = appRulesFor(appIds);
  return { rules: Object.fromEntries(Object.entries(map).map(([k, v]) => [k, { rule: v.rule, by: v.by }])), conflicts };
}

/** 프로파일 하나 평가(점검 + 요구값). */
export function evalProfile(p, ctx = {}) {
  const { tu = null, detail = null } = ctx;
  const checks = p.checks.map((c) => {
    let r;
    try { r = c.judge(ctx) || { status: 'unknown', reason: 'notRead' }; } catch { r = { status: 'unknown', reason: 'notRead' }; }
    return { id: c.id, title: c.title, how: c.how, status: r.status, value: r.value ?? null, reason: r.reason ?? null, evidence: c.evidence, sources: c.sources, grade: c.grade };
  });
  const tunings = p.tunings.map((t) => {
    const value = typeof t.fact === 'function' ? t.fact(tu, detail) : undefined;
    const r = evalRule(t.rule, value, { tu, detail, item: t });
    const cur = t.valueKind === 'devices' || t.valueKind === 'xfs' || value === undefined || value === null ? null : String(value);
    return {
      key: t.key, title: t.title, reads: t.reads, current: cur, ...(r.devices ? { devices: r.devices } : {}),
      rec: t.rule.text || '', status: r.status, reason: r.reason ?? null, evidence: t.evidence, sources: t.sources, grade: t.grade,
      ...(t.catalogId ? { catalogId: t.catalogId } : {}),
    };
  });
  const judged = [...checks.map((c) => c.status), ...tunings.map((t) => (t.status === 'advise' ? 'warn' : t.status))].filter((s) => RANK[s]);
  const status = judged.length ? judged.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'ok') : 'unknown';
  const counts = {};
  for (const s of [...checks.map((c) => c.status), ...tunings.map((t) => `t:${t.status}`)]) counts[s] = (counts[s] || 0) + 1;
  return { id: p.id, kind: p.kind, title: p.title, status, checks, tunings, counts };
}

/**
 * 한 서버의 용도 보기.
 * @param {object} p
 * @param {object|null} p.tuning  tuning_json(사실)
 * @param {object|null} p.detail  detail_json
 * @param {object|null} p.entry   성능 항목(USE code 표 — gpdb 의 NIC/RAID 점검이 그대로 쓴다)
 * @param {object|null} p.row     usage_latest 행(disk_used_pct — gpdb 데이터 볼륨 공간)
 * @param {object|null} p.manual  수동 태그 { apps?, role? }
 */
export function profileView({ tuning = null, detail = null, entry = null, row = null, manual = null } = {}) {
  const det = detectProfiles(tuning, { manual, detail });
  const ctx = { tu: tuning, detail, entry, row, detection: det };
  const active = [det.os.profile, ...det.activeApps].filter(Boolean).map(profileById).filter(Boolean);
  const evaluated = active.map((p) => evalProfile(p, ctx));
  const sts = evaluated.map((e) => e.status).filter((s) => RANK[s]);
  const status = !evaluated.length ? 'none' : sts.length ? sts.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'ok') : 'unknown';
  const { conflicts } = appRulesFor(det.activeApps);
  return {
    detection: det, profiles: evaluated, status,
    osProfileMissing: !det.os.profile,
    ...(conflicts.length ? { conflicts } : {}),
  };
}

/** 전 프로파일 id(테스트 · 카탈로그). */
export const PROFILE_IDS = Object.freeze(PROFILES.map((p) => p.id));
