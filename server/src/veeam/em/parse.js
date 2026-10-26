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
export function processedOf(b) {
  if (!isObj(b)) return null;
  return { backupDays: dayPoints(pick(b, 'BackupDays')), replicaDays: dayPoints(pick(b, 'ReplicaDays')) };
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
export function repositoriesOf(b) {
  return firstArray(b).slice(0, 1000).map((r) => ({
    name: str(pick(r, 'Name'), 120), uid: str(pick(r, 'UID', 'Uid', 'Id'), 200), kind: str(pick(r, 'Kind', 'Type'), 40),
    capacity: num(r, 'Capacity'), free: num(r, 'FreeSpace'), server: linkName(r, /BackupServer/i),
  })).filter((r) => r.name);
}
export function sessionsOf(list) {
  return (Array.isArray(list) ? list : []).filter(isObj).map((s) => ({
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
      last: last ? { result: last.result, start: last.start, end: last.end, durSec: last.start != null ? Math.max(0, Math.round((last.end - last.start) / 1000)) : null } : null,
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
  return { counts24: c, recentBad: bad.slice(0, max).map(({ job, server, result, start, end }) => ({ job, server, result, start, end })), recentBadTotal: bad.length };
}
