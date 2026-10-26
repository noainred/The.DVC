/**
 * veeam/em/view.js — '서버 › Veeam › EM' 탭 응답 만들기(순수 · v2.788).
 *  · EM 별: 수집 상태(항목별 성공·사유 · 인증 정지 · 오래됨) + 마지막 성공 결과(실패 중이면 lastOk — 그 사실과 함께).
 *  · 라이선스: B&R 서버별(veeam/licenseWatch.js currentLicenses — EM 에서는 읽지 않는다, 출처를 밝힌다) + 합계(아는 것만 — 모르는 서버 수를 따로).
 *  · 이력: 라이선스 사용(서버별) · 저장소 용량(EM 저장소별) 최근 90일.
 * 못 읽은 값은 null 그대로 — 0 으로 채우지 않는다.
 */
import { licenseExpiryStatus } from '../../util/licenseExpiry.js';
import { mapKey } from './mapping.js';

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

const norm = (v) => String(v || '').trim().toLowerCase().split('.')[0];
/** 이름으로 짝짓기(자동) — B&R 등록의 표시명 또는 주소 첫 마디가 EM 의 백업 서버 이름과 같으면(대소문자·도메인 꼬리 무시). */
export function autoBrMatch(serverName, brServers) {
  const n = norm(serverName);
  if (!n) return null;
  return (brServers || []).find((b) => norm(b.name) === n || norm(b.host) === n) || null;
}

/**
 * v2.788.1 매핑 — EM 이 아는 백업 서버마다 포탈 B&R 등록·vCenter(법인)를 붙인다(순수).
 *  · B&R: 매핑 br 'none' 이면 짝짓지 않음(사람이 '포탈에 없음' 으로 확정) · id 면 그 등록(지워졌으면 missing) · 없으면 이름 자동 짝짓기.
 *  · vCenter: 매핑 vcenterIds 가 있으면 그것(manual) · 없으면 짝지어진 B&R 등록의 vCenter(br) · 둘 다 없으면 모름(vcSource null — 빈 목록을 '법인 없음' 으로 단정하지 않는다).
 * @param {object} o { emId, map(getEmMap), brServers(비밀 없음), vcName(Map id→이름) }
 */
export function mapBackupServers(backupServers, { emId = '', map = {}, brServers = [], vcName = new Map() } = {}) {
  return (Array.isArray(backupServers) ? backupServers : []).map((s) => {
    const e = map[mapKey(emId, s.name)] || null;
    let br = null; let brSource = null;
    if (e?.br === 'none') brSource = 'none';
    else if (e?.br) { br = (brServers || []).find((b) => b.id === e.br) || null; brSource = br ? 'manual' : 'missing'; }
    else { br = autoBrMatch(s.name, brServers); brSource = br ? 'auto' : null; }
    let vcenterIds = []; let vcSource = null;
    if (e?.vcenterIds?.length) { vcenterIds = e.vcenterIds; vcSource = 'manual'; }
    else if (br?.vcenterIds?.length) { vcenterIds = br.vcenterIds; vcSource = 'br'; }
    return {
      ...s, registered: !!br, brId: br?.id || '', brName: br?.name || '', brSource,
      vcenterIds, vcNames: vcenterIds.map((id) => vcName.get(id) || id), vcSource,
    };
  });
}
/** 하위 호환(v2.788) — 매핑 없이 이름 자동 짝짓기만. */
export const markRegistered = (backupServers, brServers) => mapBackupServers(backupServers, { brServers });

/**
 * EM 1대 → 화면 모양.
 * @param {object} em 등록부(비밀 없음) @param {object|null} rec store.getEmRecord @param {object} o { brServers, maxAgeMs, now }
 */
export function emView(em, rec, { brServers = [], map = {}, vcName = new Map(), maxAgeMs = 3 * 900_000, now = Date.now() } = {}) {
  const r = rec?.result || null;
  const data = r?.ok ? r : (rec?.lastOk || null);
  const lastOkTs = data?.ts ?? null;
  const servers = data?.backupServers ? mapBackupServers(data.backupServers, { emId: em.id, map, brServers, vcName }) : null;
  // 작업·세션·저장소에 법인 이름을 붙인다(백업 서버 이름으로 — EM 결과의 server 필드). 모르면 null(빈 배열과 구분).
  const vcBy = new Map((servers || []).filter((x) => x.vcSource).map((x) => [String(x.name).trim().toLowerCase(), x.vcNames]));
  const withVc = (x) => ({ ...x, vcNames: vcBy.get(String(x.server || '').trim().toLowerCase()) || null });
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
      backupServers: servers,
      repositories: data.repositories ? repositoriesView(data.repositories).map(withVc) : null,
      jobs: data.jobs ? (() => { const v = jobsView(data.jobs); return { ...v, items: v.items.map(withVc) }; })() : null,
      sessions: data.sessions ? { ...data.sessions, recentBad: (data.sessions.recentBad || []).map(withVc) } : null,
    } : null,
  };
}
