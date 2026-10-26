/**
 * veeam/em/view.js — '서버 › Veeam › EM' 탭 응답 만들기(순수 · v2.788).
 *  · EM 별: 수집 상태(항목별 성공·사유 · 인증 정지 · 오래됨) + 마지막 성공 결과(실패 중이면 lastOk — 그 사실과 함께).
 *  · 라이선스: B&R 서버별(veeam/licenseWatch.js currentLicenses — EM 에서는 읽지 않는다, 출처를 밝힌다) + 합계(아는 것만 — 모르는 서버 수를 따로).
 *  · 이력: 라이선스 사용(서버별) · 저장소 용량(EM 저장소별) 최근 90일.
 * 못 읽은 값은 null 그대로 — 0 으로 채우지 않는다.
 */
import { licenseExpiryStatus } from '../../util/licenseExpiry.js';

const ORDER = { fail: 0, warn: 1, run: 2, ok: 3, none: 4 };
/** 작업 상태 키 — 실행 중이면 run, 아니면 마지막 결과, 기록 없으면 none. */
export const jobState = (j) => (j?.running ? 'run' : (j?.last?.result && j.last.result !== 'none' ? j.last.result : 'none'));

export function jobsView(jobs, { max = 1000 } = {}) {
  const list = (Array.isArray(jobs) ? jobs : []).map((j) => ({ ...j, state: jobState(j) }));
  list.sort((a, b) => (ORDER[a.state] - ORDER[b.state]) || ((b.last?.end ?? 0) - (a.last?.end ?? 0)) || String(a.name).localeCompare(String(b.name)));
  const counts = { all: list.length, fail: 0, warn: 0, run: 0, ok: 0, none: 0 };
  for (const j of list) counts[j.state]++;
  return { items: list.slice(0, max), counts, truncated: list.length > max || undefined };
}

export function repositoriesView(repos) {
  return (Array.isArray(repos) ? repos : []).map((r) => {
    const usedPct = r.capacity != null && r.capacity > 0 && r.free != null ? Math.round(((r.capacity - r.free) / r.capacity) * 1000) / 10 : null;
    return { ...r, usedPct };
  }).sort((a, b) => ((b.usedPct ?? -1) - (a.usedPct ?? -1)) || String(a.name).localeCompare(String(b.name)));
}

/** 라이선스 합계 — 사용·전체 인스턴스는 둘 다 읽은 서버만 더한다(모르는 서버 수는 따로). 가장 이른 만료. */
export function licenseTotals(items, now = Date.now()) {
  const t = { servers: items.length, known: 0, unknown: 0, used: 0, licensed: 0, earliest: null, earliestSupport: null };
  for (const it of items) {
    const i = it.license?.instances;
    if (i && i.used != null && i.licensed != null) { t.known++; t.used += i.used; t.licensed += i.licensed; } else t.unknown++;
    const e = it.license?.expires; const se = it.license?.supportExpires;
    if (e != null && (t.earliest == null || e < t.earliest.ts)) t.earliest = { ts: e, server: it.name, ...licenseExpiryStatus(e, { now }) };
    if (se != null && (t.earliestSupport == null || se < t.earliestSupport.ts)) t.earliestSupport = { ts: se, server: it.name, ...licenseExpiryStatus(se, { now }) };
  }
  if (!t.known) { t.used = null; t.licensed = null; }
  return t;
}

/** EM 결과의 백업 서버를 포탈에 등록된 B&R 서버와 이름으로 짝짓는다(대소문자·도메인 꼬리 무시). */
export function markRegistered(backupServers, brServers) {
  const norm = (v) => String(v || '').trim().toLowerCase().split('.')[0];
  const names = new Set();
  for (const b of brServers || []) { names.add(norm(b.name)); names.add(norm(b.host)); }
  return (Array.isArray(backupServers) ? backupServers : []).map((s) => ({ ...s, registered: names.has(norm(s.name)) }));
}

/**
 * EM 1대 → 화면 모양.
 * @param {object} em 등록부(비밀 없음) @param {object|null} rec store.getEmRecord @param {object} o { brServers, maxAgeMs, now }
 */
export function emView(em, rec, { brServers = [], maxAgeMs = 3 * 900_000, now = Date.now() } = {}) {
  const r = rec?.result || null;
  const data = r?.ok ? r : (rec?.lastOk || null);
  const lastOkTs = data?.ts ?? null;
  return {
    id: em.id, name: em.name, host: em.host, port: em.port, enabled: em.enabled !== false, ...(em.demo ? { demo: true } : {}),
    status: r ? {
      ok: r.ok === true, ts: r.ts ?? null, error: r.error || '', kind: r.kind || '', authStop: r.authStop || null, lastOkTs,
      stale: lastOkTs == null || now - lastOkTs > maxAgeMs,
      sections: data?.sections || r.sections || {}, notes: Array.isArray(data?.notes) ? data.notes.slice(0, 10) : [],
    } : null,
    data: data ? {
      overview: data.overview || null, jobStats: data.jobStats || null, vms: data.vms || null, processed: data.processed || null,
      repoReport: data.repoReport || null,
      backupServers: data.backupServers ? markRegistered(data.backupServers, brServers) : null,
      repositories: data.repositories ? repositoriesView(data.repositories) : null,
      jobs: data.jobs ? jobsView(data.jobs) : null,
      sessions: data.sessions || null,
    } : null,
  };
}
