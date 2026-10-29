/**
 * veeam/em/parse.js — Veeam Backup Enterprise Manager REST(9398) 응답 정규화(순수 · v2.788).
 *
 * ⚠ 정직 기록: 이 모듈의 경로·필드 이름은 Veeam EM REST 참조(9.5~12 판)의 기억과 공개 검색 결과에 기댄 것이다 — 구현 시점에 공식 문서 사이트에
 *   접속하지 못했고 실제 EM 장비로 확인하지 못했다. 그래서:
 *   · 필드는 PascalCase·camelCase·대소문자 무시 순으로 찾는다(pick) · 목록은 응답 안의 첫 객체 배열을 찾는다(firstArray).
 *   · 모르는 값은 null(못 읽음) — 0 으로 채우지 않는다(util/numOrNull.js). 화면은 null 을 '—' 로 보인다.
 *   · 크기 필드는 바이트, 소요 시간 필드는 초로 **가정**한다(EM 문서의 예시 값 기준 — 실측 전).
 *  모르는 필드는 버리고 문자열은 길이를 자른다(외부 입력).
 */
import { numOrNull } from '../../util/numOrNull.js';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v, n = 200) => (typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, n) : (typeof v === 'number' && Number.isFinite(v) ? String(v) : '')); // eslint-disable-line no-control-regex

/** 필드 하나 — 주어진 이름들을 정확히, 없으면 대소문자 무시로 찾는다. */
export function pick(o, ...names) {
  if (!isObj(o)) return undefined;
  for (const n of names) if (Object.prototype.hasOwnProperty.call(o, n)) return o[n];
  const lower = new Map(Object.keys(o).map((k) => [k.toLowerCase(), k]));
  for (const n of names) { const k = lower.get(String(n).toLowerCase()); if (k !== undefined) return o[k]; }
  return undefined;
}
const num = (o, ...names) => numOrNull(pick(o, ...names));
const tsOf = (v) => { const t = typeof v === 'string' && v.trim() ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };

/** 응답 안의 첫 '객체 배열'(깊이 4까지) — 목록 응답의 감싼 이름이 판마다 달라도(Jobs·Entities.BackupJobSessions.BackupJobSessions 등) 찾는다. */
export function firstArray(body, depth = 4) {
  if (Array.isArray(body)) return body.filter(isObj);
  if (!isObj(body) || depth <= 0) return [];
  for (const v of Object.values(body)) if (Array.isArray(v) && v.some(isObj)) return v.filter(isObj);
  for (const v of Object.values(body)) { if (isObj(v)) { const a = firstArray(v, depth - 1); if (a.length) return a; } }
  return [];
}

/** Links 에서 종류(Type)가 맞는 참조의 이름 — 작업·세션의 백업 서버 이름. */
export function linkName(o, typeRe) {
  const links = pick(o, 'Links', 'links');
  const list = Array.isArray(links) ? links : firstArray(links, 2);
  for (const l of list) {
    if (typeRe.test(str(pick(l, 'Type', 'type'), 120))) { const n = str(pick(l, 'Name', 'name'), 120); if (n) return n; }
  }
  return '';
}

/** 결과 문자열 → 'ok'|'warn'|'fail'|'none'. */
export function resultKey(v) {
  const s = String(v || '').toLowerCase();
  if (/^succ/.test(s)) return 'ok';
  if (/^warn/.test(s)) return 'warn';
  if (/^fail|^error/.test(s)) return 'fail';
  return 'none';
}
/** 상태 문자열이 실행 중인가(끝나지 않음). */
export const isRunningState = (v) => /^(working|starting|stopping|postprocessing|resuming|pausing|waiting)/i.test(String(v || ''));

export function overviewOf(b) {
  if (!isObj(b)) return null;
  return {
    backupServers: num(b, 'BackupServers'), proxyServers: num(b, 'ProxyServers'), repositoryServers: num(b, 'RepositoryServers'),
    runningJobs: num(b, 'RunningJobs'), scheduledJobs: num(b, 'ScheduledJobs'),
    // Veeam 응답의 실제 철자는 'Lastest'(오타) 로 알려져 있다 — 바른 철자도 받는다.
    vmOk: num(b, 'SuccessfulVmLastestStates', 'SuccessfulVmLatestStates'),
    vmWarn: num(b, 'WarningVmLastestStates', 'WarningVmLatestStates'),
    vmFail: num(b, 'FailedVmLastestStates', 'FailedVmLatestStates'),
  };
}
export function jobStatsOf(b) {
  if (!isObj(b)) return null;
  return {
    running: num(b, 'RunningJobs'), scheduled: num(b, 'ScheduledJobs'), scheduledBackup: num(b, 'ScheduledBackupJobs'), scheduledReplica: num(b, 'ScheduledReplicaJobs'),
    totalRuns: num(b, 'TotalJobRuns'), okRuns: num(b, 'SuccessfulJobRuns'), warnRuns: num(b, 'WarningsJobRuns', 'WarningJobRuns'), failRuns: num(b, 'FailedJobRuns'),
    maxDurSec: num(b, 'MaxJobDuration'), maxBackupDurSec: num(b, 'MaxBackupJobDuration'), maxReplicaDurSec: num(b, 'MaxReplicaJobDuration'),
    maxBackupName: str(pick(b, 'MaxDurationBackupJobName'), 120), maxReplicaName: str(pick(b, 'MaxDurationReplicaJobName'), 120),
  };
}
export function vmsOverviewOf(b) {
  if (!isObj(b)) return null;
  return {
    protected: num(b, 'ProtectedVms'), backedUp: num(b, 'BackedUpVms'), replicated: num(b, 'ReplicatedVms'), restorePoints: num(b, 'RestorePoints'),
    fullSize: num(b, 'FullBackupPointsSize'), incSize: num(b, 'IncrementalBackupPointsSize'), replicaSize: num(b, 'ReplicaRestorePointsSize'),
    sourceSize: num(b, 'SourceVmsSize'), successPct: num(b, 'SuccessBackupPercents'),
  };
}
const dayPoints = (v) => (Array.isArray(v) ? v : firstArray(v, 2)).slice(0, 400).map((p) => [tsOf(pick(p, 'Timestamp', 'Date')), num(p, 'Count')]).filter(([t]) => t != null);
/*
 * v2.795: 문서(ProcessedVmsReportFrame)는 날짜마다 Day 원소 하나에 BackupedVms·ReplicatedVms·Timestamp 를 싣는다고 적는다 — v2.788 은 BackupDays/Count 만
 *   읽어 그 꼴이면 빈 배열이었다(추정 — 실물 미확인). 두 꼴을 다 받는다(앞의 꼴이 있으면 그것).
 */
const dayPointsOf = (v, field) => (Array.isArray(v) ? v : firstArray(v, 2)).slice(0, 400).map((p) => [tsOf(pick(p, 'Timestamp', 'Date')), num(p, field)]).filter(([t]) => t != null);
export function processedOf(b) {
  if (!isObj(b)) return null;
  const byDay = pick(b, 'Day', 'Days');
  const old = { backupDays: dayPoints(pick(b, 'BackupDays')), replicaDays: dayPoints(pick(b, 'ReplicaDays')) };
  if (old.backupDays.length || old.replicaDays.length || byDay == null) return old;
  return { backupDays: dayPointsOf(byDay, 'BackupedVms'), replicaDays: dayPointsOf(byDay, 'ReplicatedVms') };
}
/** 저장소 보고서(Periods) — 이름·용량·여유·백업 크기(바이트 가정). */
export function repoReportOf(b) {
  const list = isObj(b) ? (Array.isArray(pick(b, 'Periods')) ? pick(b, 'Periods') : firstArray(b)) : firstArray(b);
  return list.slice(0, 500).map((p) => ({
    name: str(pick(p, 'Name'), 120), capacity: num(p, 'Capacity'), free: num(p, 'FreeSpace'), backupSize: num(p, 'BackupSize'),
  })).filter((r) => r.name);
}
export function backupServersOf(b) {
  return firstArray(b).slice(0, 500).map((s) => ({
    name: str(pick(s, 'Name'), 120), uid: str(pick(s, 'UID', 'Uid', 'Id'), 200), version: str(pick(s, 'Version'), 40),
    port: num(s, 'Port'), description: str(pick(s, 'Description'), 200),
  })).filter((s) => s.name);
}
/**
 * v2.817 EM 의 HierarchyRoot(백업 서버에 등록된 가상화 호스트 — vCenter·ESXi·Hyper-V) — GET /api/hierarchyRoots?format=Entity.
 *   ⚠ 응답 모양은 Veeam EM REST 문서 기준 추정(실장비 미확인): Name(호스트명·IP) · HostType(VC/ESX/HyperV…) · UniqueId · Links(BackupServerReference).
 *   이름이 없으면 버린다 · 상한 2000. server 는 Links 의 백업 서버 참조 이름(없으면 '' — 어느 서버 것인지 모름).
 */
export function hierarchyRootsOf(b) {
  return firstArray(b).slice(0, 2000).map((o) => ({
    name: str(pick(o, 'Name', 'HostName'), 255), hostType: str(pick(o, 'HostType', 'Type'), 40),
    uid: str(pick(o, 'UID', 'Uid', 'HierarchyRootId', 'Id'), 200), uniqueId: str(pick(o, 'UniqueId'), 200),
    server: linkName(o, /BackupServer/i),
  })).filter((r) => r.name);
}
/** VC 형 루트인가(HostType 'VC' · 'VCenter' · 'vCenter Server' …) — ESXi 단독·Hyper-V 는 아니다. 종류를 모르면(빈 값) 넣지 않는다. */
export const isVcRoot = (r) => /^(vc|vcenter)/i.test(String(r?.hostType || '').replace(/\s+/g, ''));
export function repositoriesOf(b) {
  return firstArray(b).slice(0, 1000).map((r) => ({
    name: str(pick(r, 'Name'), 120), uid: str(pick(r, 'UID', 'Uid', 'Id'), 200), kind: str(pick(r, 'Kind', 'Type'), 40),
    capacity: num(r, 'Capacity'), free: num(r, 'FreeSpace'), server: linkName(r, /BackupServer/i),
  })).filter((r) => r.name);
}
export function sessionsOf(list) {
  return (Array.isArray(list) ? list : []).filter(isObj).map((s) => ({
    uid: str(pick(s, 'UID', 'Uid', 'Id'), 200),   // v2.788.1 상세(세션 하위 VM 결과)를 누를 때 이 세션을 EM 에서 다시 읽는다
    job: str(pick(s, 'JobName'), 160), jobUid: str(pick(s, 'JobUid', 'JobUID'), 200), type: str(pick(s, 'JobType'), 40),
    result: resultKey(pick(s, 'Result')), state: str(pick(s, 'State'), 40),
    start: tsOf(pick(s, 'CreationTimeUTC', 'CreationTime')), end: tsOf(pick(s, 'EndTimeUTC', 'EndTime')),
    retry: pick(s, 'IsRetry') === true, server: linkName(s, /BackupServer/i),
  })).filter((s) => s.job || s.jobUid);
}

const sessKey = (x) => x.jobUid || `${x.server}|${x.job}`;
/**
 * 작업 목록 + 세션 → 작업별 마지막 결과·24시간 집계(순수).
 * '마지막 결과' 는 끝난 세션 중 가장 늦게 끝난 것. 세션 창(기본 7일) 안에 기록이 없으면 last:null(모름 — '정상' 이라 하지 않는다).
 */
export function jobsWithResults(jobsBody, sessions, { now = Date.now(), dayMs = 86_400_000 } = {}) {
  const byKey = new Map();
  for (const s of sessions) { const k = sessKey(s); const a = byKey.get(k); if (a) a.push(s); else byKey.set(k, [s]); }
  const byName = new Map();
  for (const s of sessions) { const k = `${s.server}|${s.job}`; const a = byName.get(k); if (a) a.push(s); else byName.set(k, [s]); }
  return firstArray(jobsBody).slice(0, 5000).map((j) => {
    const name = str(pick(j, 'Name'), 160); const uid = str(pick(j, 'UID', 'Uid', 'Id'), 200); const server = linkName(j, /BackupServer/i);
    const ss = (uid && byKey.get(uid)) || byName.get(`${server}|${name}`) || [];
    const running = ss.find((s) => isRunningState(s.state)) || null;
    let last = null;
    for (const s of ss) { if (isRunningState(s.state) || s.end == null) continue; if (!last || s.end > last.end) last = s; }
    const runs24 = { ok: 0, warn: 0, fail: 0 };
    for (const s of ss) if (s.end != null && now - s.end <= dayMs && runs24[s.result] != null) runs24[s.result]++;
    return {
      name, uid, server, type: str(pick(j, 'JobType'), 40), platform: str(pick(j, 'Platform'), 40),
      scheduleEnabled: typeof pick(j, 'ScheduleEnabled') === 'boolean' ? pick(j, 'ScheduleEnabled') : null,
      nextRun: tsOf(pick(j, 'NextRun')),
      running: running ? { start: running.start } : null,
      last: last ? { uid: last.uid || '', result: last.result, start: last.start, end: last.end, durSec: last.start != null ? Math.max(0, Math.round((last.end - last.start) / 1000)) : null } : null,
      runs24,
    };
  }).filter((j) => j.name);
}

/** 세션 → 24시간 집계(끝난 세션만) + 최근 실패·경고(새것부터, 상한). */
export function sessionDigest(sessions, { now = Date.now(), dayMs = 86_400_000, max = 200 } = {}) {
  const c = { total: 0, ok: 0, warn: 0, fail: 0, running: 0 };
  const bad = [];
  for (const s of sessions) {
    if (isRunningState(s.state)) { c.running++; continue; }
    if (s.end == null || now - s.end > dayMs) continue;
    c.total++; if (c[s.result] != null && s.result !== 'none') c[s.result]++;
    if (s.result === 'fail' || s.result === 'warn') bad.push(s);
  }
  bad.sort((a, b) => b.end - a.end);
  return { counts24: c, recentBad: bad.slice(0, max).map(({ uid, job, server, result, start, end }) => ({ uid: uid || '', job, server, result, start, end })), recentBadTotal: bad.length };
}

/**
 * v2.788.1 세션 하위 VM 결과(BackupTaskSession) → 화면 줄. 사유(Reason)는 EM 이 준 문구 그대로(길이 상한 · 비밀 가림은 호출부 maskText).
 * ⚠ 필드 이름은 미검증(머리 주석) — VmDisplayName·Name 둘 다 받는다.
 */
export function taskSessionsOf(body, { max = 2000, reasonMax = 2000 } = {}) {
  return firstArray(body).slice(0, max).map((t) => ({
    vm: str(pick(t, 'VmDisplayName', 'VmName', 'Name', 'ObjectName'), 200),
    result: resultKey(pick(t, 'Result')), state: str(pick(t, 'State'), 40),
    reason: typeof pick(t, 'Reason') === 'string' ? pick(t, 'Reason').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+/g, '').trim().slice(0, reasonMax) : '', // eslint-disable-line no-control-regex
    start: tsOf(pick(t, 'CreationTimeUTC', 'CreationTime')), end: tsOf(pick(t, 'EndTimeUTC', 'EndTime')),
    size: num(t, 'TotalSize'),
  })).filter((t) => t.vm || t.reason);
}
/** 세션 1건(BackupJobSession 엔터티) → 머리 정보. 실패 사유가 세션에만 있는 판도 있어 Reason 도 받는다(있으면). */
export function sessionHeadOf(b) {
  const o = !isObj(b) ? null : (pick(b, 'JobName') !== undefined || pick(b, 'Result') !== undefined ? b : (firstArray(b)[0] || null));   // 엔터티 그대로 또는 한 겹 감싼 것
  if (!o) return null;
  return {
    job: str(pick(o, 'JobName', 'Name'), 160), result: resultKey(pick(o, 'Result')), state: str(pick(o, 'State'), 40),
    start: tsOf(pick(o, 'CreationTimeUTC', 'CreationTime')), end: tsOf(pick(o, 'EndTimeUTC', 'EndTime')),
    reason: typeof pick(o, 'Reason') === 'string' ? pick(o, 'Reason').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+/g, '').trim().slice(0, 2000) : '', // eslint-disable-line no-control-regex
    retry: pick(o, 'IsRetry') === true,
  };
}

/*
 * v2.795 VM 단위 기록(사용자 요청 'EM 에서 등록되면 vCenter 화면·세부 백업 내용에도 반영' · 결정 'VM 단위까지').
 *  · BackupTaskSession(VM 별 작업 결과)·VmRestorePoint(VM 별 복원 지점) 질의 행 → 축약 행. 필드 이름은 문서 검색 결과로 확인했으나 **실물 응답 미확인**
 *    (머리 주석과 같은 이유) — 여러 이름을 받는다.
 *  · moref 는 HierarchyObjRef 끝의 'vm-숫자'(예 urn:VMware:Vm:<루트 GUID>.vm-62228)만 — 루트 GUID 는 vCenter 식별자와 같다는 보장이 없어 쓰지 않는다.
 *  · 백업 서버는 BackupServer 링크 이름(작업·세션과 같은 linkName). 없으면 ''(호출부가 EM 의 백업 서버가 하나뿐일 때만 그 서버로 본다).
 */
const RE_REF_MOREF = /(?:^|[.:/])(vm-\d{1,12})$/;
/** HierarchyObjRef → moref('vm-123') 또는 ''. */
export function morefOfRef(v) {
  const m = RE_REF_MOREF.exec(String(typeof v === 'string' ? v : '').trim().slice(-200));
  return m ? m[1] : '';
}
/** 복원 지점 이름 'VM이름@2026-10-26 01:00:00' 꼴이면 VM 이름만. */
const vmNameOf = (o) => {
  const n = str(pick(o, 'VmDisplayName', 'VmName', 'ObjectName'), 200);
  if (n) return n;
  const full = str(pick(o, 'Name'), 260);
  const at = full.lastIndexOf('@');
  return (at > 0 ? full.slice(0, at) : full).trim().slice(0, 200);
};
/** 질의 행의 생성 시각(새것부터 페이지를 넘길 때 멈출 기준). */
export const rowTimeOf = (o) => tsOf(pick(o, 'CreationTimeUTC', 'CreationTime'));

/** BackupTaskSession 행 → { vm, server, job, result('ok'|'warn'|'fail'|'none'), running, start, end, moref }. */
export function vmTasksOf(list, { max = 200_000 } = {}) {
  return (Array.isArray(list) ? list : []).filter(isObj).slice(0, max).map((t) => ({
    vm: vmNameOf(t), server: linkName(t, /BackupServer/i), job: linkName(t, /JobSession|^Job/i).replace(/@.*$/, '').trim().slice(0, 160),
    result: resultKey(pick(t, 'Result')), running: isRunningState(pick(t, 'State')),
    start: tsOf(pick(t, 'CreationTimeUTC', 'CreationTime')), end: tsOf(pick(t, 'EndTimeUTC', 'EndTime')),
    moref: morefOfRef(pick(t, 'HierarchyObjRef', 'ObjectRef')),
  })).filter((t) => t.vm);
}
/** VmRestorePoint 행 → { vm, server, ts, moref }. */
export function vmPointsOf(list, { max = 200_000 } = {}) {
  return (Array.isArray(list) ? list : []).filter(isObj).slice(0, max).map((p) => ({
    vm: vmNameOf(p), server: linkName(p, /BackupServer/i),
    ts: tsOf(pick(p, 'CreationTimeUTC', 'CreationTime')), moref: morefOfRef(pick(p, 'HierarchyObjRef', 'ObjectRef')),
  })).filter((p) => p.vm && p.ts != null);
}
