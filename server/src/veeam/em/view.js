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

/* ── v2.817 EM 연결 현황 — EM 이 본 가상화 호스트(hierarchyRoots)를 포탈 vCenter 에 맞춘다 ── */
const hostOf = (v) => {
  const t = String(v || '').trim().toLowerCase();
  if (!t) return '';
  try { return /^[a-z]+:\/\//.test(t) ? new URL(t).hostname.replace(/^\[|\]$/g, '') : t.replace(/:\d+$/, '').replace(/\/.*$/, ''); } catch { return ''; }
};
/**
 * 포탈 vCenter 색인 — 등록부 host(URL 의 호스트명 · 소문자) · 이름(소문자). 같은 키가 둘이면(모호) 그 키로는 맞추지 않는다.
 * @param {Array<{id,name,host}>} list 등록부(비밀 없음) + 스냅샷 이름
 */
export function vcIndexOf(list) {
  const byHost = new Map(); const byName = new Map(); const name = new Map(); const amb = new Set();
  const put = (m, k, id) => { if (!k) return; const key = `${m === byHost ? 'h' : 'n'}:${k}`; if (m.has(k) && m.get(k) !== id) amb.add(key); else m.set(k, id); };
  for (const v of Array.isArray(list) ? list : []) {
    if (!v?.id) continue;
    name.set(v.id, v.name || v.id);
    put(byHost, hostOf(v.host), v.id);
    put(byName, String(v.name || '').trim().toLowerCase(), v.id);
  }
  for (const k of amb) { const [t, ...rest] = k.split(':'); (t === 'h' ? byHost : byName).delete(rest.join(':')); }
  return { byHost, byName, name };
}
/**
 * EM 이 본 호스트 이름 → 포탈 vCenter id(없으면 null). 호스트명 **정확 일치**(대소문자·URL·포트 무시) → 이름 정확 일치.
 *   ⚠ 앞 마디만 비교하지 않는다(autoBrMatch 의 split('.')[0] 은 'vc01.corpA' 와 'vc01.corpB' · IP '10.x' 를 한데 묶는다).
 */
export function matchVcenter(rootName, idx) {
  const h = hostOf(rootName);
  if (!h || !idx) return null;
  return idx.byHost.get(h) || idx.byName.get(h) || idx.byName.get(String(rootName || '').trim().toLowerCase()) || null;
}
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
/**
 * 백업 서버 하나의 EM 루트 대조 — roots(그 서버에 등록된 호스트, 포탈 vCenter 로 맞춘 것) · vcCheck:
 *   'unknown'(EM 루트를 못 읽음) · 'none'(EM 에 등록된 호스트가 없음) · 'unmapped'(포탈 매핑·B&R 이 없음) · 'same' · 'diff'.
 */
export function rootsCheck(server, roots, idx) {
  if (!Array.isArray(roots)) return { roots: null, emVcenterIds: null, vcCheck: 'unknown' };
  const key = String(server?.name || '').trim().toLowerCase();
  const mine = roots.filter((r) => String(r.server || '').trim().toLowerCase() === key).slice(0, 200).map((r) => {
    const id = matchVcenter(r.name, idx);
    return { name: r.name, hostType: r.hostType || '', vcenterId: id, vcName: id ? (idx.name.get(id) || id) : null };
  });
  const emVcenterIds = [...new Set(mine.map((r) => r.vcenterId).filter(Boolean))];
  let vcCheck;
  if (!mine.length) vcCheck = 'none';
  else if (!server?.vcSource) vcCheck = 'unmapped';
  else vcCheck = sameSet(emVcenterIds, server.vcenterIds || []) ? 'same' : 'diff';
  return { roots: mine, emVcenterIds, vcCheck };
}

/**
 * EM 1대 → 화면 모양.
 * @param {object} em 등록부(비밀 없음) @param {object|null} rec store.getEmRecord @param {object} o { brServers, maxAgeMs, now }
 */
export function emView(em, rec, { brServers = [], map = {}, vcName = new Map(), vcIndex = null, maxAgeMs = 3 * 900_000, now = Date.now() } = {}) {
  const r = rec?.result || null;
  const data = r?.ok ? r : (rec?.lastOk || null);
  const lastOkTs = data?.ts ?? null;
  // v2.817: 각 백업 서버에 EM 이 본 호스트(roots)와 포탈 매핑 대조(vcCheck) — 루트를 못 읽었으면(null) 'unknown'
  const idx = vcIndex || vcIndexOf([...vcName.entries()].map(([id, name]) => ({ id, name })));
  const rootsAll = Array.isArray(data?.hierarchyRoots) ? data.hierarchyRoots : null;
  const servers = data?.backupServers ? mapBackupServers(data.backupServers, { emId: em.id, map, brServers, vcName }).map((x) => ({ ...x, ...rootsCheck(x, rootsAll, idx) })) : null;
  const known = new Set((servers || []).map((x) => String(x.name).trim().toLowerCase()));
  const orphanRoots = rootsAll && servers ? rootsAll.filter((r) => !known.has(String(r.server || '').trim().toLowerCase())).slice(0, 200)
    .map((r) => { const id = matchVcenter(r.name, idx); return { name: r.name, hostType: r.hostType || '', server: r.server || '', vcenterId: id, vcName: id ? (idx.name.get(id) || id) : null }; }) : null;
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
      hierarchyRootsKnown: !!rootsAll, orphanRoots,
      repositories: data.repositories ? repositoriesView(data.repositories).map(withVc) : null,
      jobs: data.jobs ? (() => { const v = jobsView(data.jobs); return { ...v, items: v.items.map(withVc) }; })() : null,
      sessions: data.sessions ? { ...data.sessions, recentBad: (data.sessions.recentBad || []).map(withVc) } : null,
    } : null,
  };
}
