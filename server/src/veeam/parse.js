/**
 * veeam/parse.js — Veeam Backup & Replication REST 응답 → 'VM 단위 백업 상태' 정리 + vCenter VM 과의 대조(순수, v2.751).
 *
 * 사용자 요청(2026-10-22): "빔 백업에서 백업 진행하고 있는 VM 을 저 목록(vCenter › VM 및 폴더)에 표시 —
 *   'Off VM 포함' 처럼 'Veeam 백업 VM 표시' 기능 · vCenter 별 Veeam 서버를 스토리지 원격 점검처럼 그 법인 엣지가 읽게".
 * 선택: **백업 대상 + 지금 백업 중** · 배지만 표시(목록은 그대로) · B&R v12 이상 REST(포트 9419, /api/v1).
 *
 * ⚠ 정직 기록 — 응답 필드 근거(2026-10-22 확인 범위):
 *  · 확인: `/api/v1/backupObjects` 의 VMware 항목은 `platformName: 'VMware'` 와 `objectId`(vSphere moref, 예 vm-1067)를 가진다
 *    (Veeam REST 참조·R&D 포럼 검색 결과). 목록 응답은 `{ data:[…], pagination:{…} }` 모양이다.
 *  · 추정(실서버 미확인): 작업의 `virtualMachines.includes[]` 원소가 `{ inventoryObject:{type,hostName,name,objectId}, size }`
 *    (또는 감싸지 않은 `{type,hostName,name,objectId}`) 라는 것, `/api/v1/jobs/states` 의 `status`·`lastResult`·`lastRun`,
 *    `/api/v1/sessions` 의 `state`·`jobId`·`progressPercent`, `/api/v1/sessions/{id}/taskSessions` 의 원소 모양.
 *    그래서 이 모듈은 **두 모양을 다 받고, 모르는 모양은 버리고 센다**(지어내지 않는다). 실제 서버의 응답이 다르면 표시가
 *    비고 `notes` 가 그 사실을 말한다 — '백업 안 됨' 으로 단정하지 않는다(화면 문구도 '표시 없음 = 미백업' 이라 말하지 않는다).
 *  · 컨테이너(폴더·클러스터·호스트·태그·데이터센터) 단위 포함은 VM 으로 펼치지 않는다 — 포탈이 Veeam 의 펼침 규칙(제외·태그 평가)을
 *    흉내 내면 틀린 배지를 단다. 그런 VM 은 복원 지점이 생기면(backupObjects) 또는 실행 중 작업의 task 로 잡힌다. 개수는 `containers` 로 밝힌다.
 */

/** 문자열만 받아 자르고 제어문자를 공백으로(상주 값·화면 값). */
export const s = (v, max = 200) => (typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max) : ''); // eslint-disable-line no-control-regex
const numOrNull = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
/** ISO 시각 → epoch ms. 못 읽으면 null(0 을 지어내지 않는다). */
export function timeOf(v) {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) && t > 0 ? t : null;
}

/** 목록 응답의 원소 배열. `{data:[…]}` 또는 배열 그대로. */
export function listOf(body) {
  if (Array.isArray(body)) return body;
  if (isObj(body) && Array.isArray(body.data)) return body.data;
  return [];
}

/** vSphere moref 형태만(vm-123). 그 밖(GUID·urn)은 moref 가 아니다. */
const RE_MOREF = /^vm-\d{1,12}$/;
export const morefOrEmpty = (v) => (typeof v === 'string' && RE_MOREF.test(v.trim()) ? v.trim() : '');

/**
 * 호스트 비교 키 — 소문자 · 스킴·포트·경로 제거. `https://VC01.corp.local:443/sdk` → `vc01.corp.local`.
 * 짧은 이름(첫 마디)도 함께 돌려준다 — Veeam 에 vCenter 를 짧은 이름으로 등록한 현장이 있다.
 */
export function hostKey(v) {
  let h = String(v || '').trim().toLowerCase();
  if (!h) return { full: '', short: '' };
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  h = h.split('/')[0];
  if (h.startsWith('[')) h = h.slice(1, h.indexOf(']') > 0 ? h.indexOf(']') : undefined);
  else if ((h.match(/:/g) || []).length === 1) h = h.split(':')[0];
  h = h.replace(/\.$/, '');
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':');
  return { full: h, short: isIp ? h : h.split('.')[0] };
}

/**
 * Veeam 이 적은 vCenter 이름(hostName)이 이 vCenter 인가. 둘 중 하나라도 비면 판정하지 않는다(true) — 호출부가 따로 다룬다.
 * 짧은 이름 비교는 **한쪽이 점 없는 짧은 이름일 때만**이다(v2.751 검토 #3): 둘 다 FQDN 이면 첫 마디만 같은 다른 vCenter
 * (vc01.pl.corp · vc01.kr.corp)를 같은 것으로 보면 다른 법인 VM 에 배지가 붙는다.
 */
export function sameHost(a, b) {
  const x = hostKey(a); const y = hostKey(b);
  if (!x.full || !y.full) return true;
  if (x.full === y.full) return true;
  const shortOnly = (k) => !k.full.includes('.') && !k.full.includes(':');
  return (shortOnly(x) || shortOnly(y)) && x.short === y.short;
}

/** backupObjects 의 path(`vc01.corp.local\Datacenter\…`)에서 첫 마디 — 형식이 다르면 빈 값. */
export function hostFromPath(p) {
  const t = s(p, 1024);
  if (!t) return '';
  const first = t.split(/[\\/]/).filter(Boolean)[0] || '';
  return /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(first) && first.includes('.') ? first : '';
}

const RUNNING_RE = /^(running|working|starting|resuming|postprocessing)$/i;
const PENDING_RE = /^(pending|waiting|queued)$/i;

/**
 * 작업 목록 + 작업 상태 + 백업 객체 + 실행 중 세션의 task → 서버 1대의 결과(push·보관 모양).
 * @param {object} raw
 * @param {any} raw.jobs           GET /api/v1/jobs 응답
 * @param {any} [raw.states]       GET /api/v1/jobs/states 응답
 * @param {any} [raw.backupObjects] GET /api/v1/backupObjects 응답(페이지를 합친 배열도 받는다)
 * @param {Array<{session:object, tasks:any, tasksError?:string}>} [raw.sessions] 실행 중 세션과 그 task 응답
 * @returns {{jobs:object[], vms:object[], counts:object, notes:string[]}}
 *   vms 원소: { n:이름, m:moref, h:vCenter 호스트, j:[작업 인덱스], rp:복원지점수|null, run:0|1|2(1=백업 중·2=대기), pg:진행률|null, by:'task'|'job'|'' }
 */
export function buildServerResult(raw = {}, { maxVms = 20_000 } = {}) {
  const notes = [];
  const counts = { jobs: 0, vmJobs: 0, containers: 0, backupObjects: 0, sessions: 0, running: 0, pending: 0, skipped: 0 };
  // ── 작업 ─────────────────────────────────────────────────────────────────
  const jobs = [];
  const jobIdx = new Map();
  const stateOf = new Map();
  for (const st of listOf(raw.states)) {
    if (!isObj(st)) continue;
    const id = s(st.id, 64);
    if (id) stateOf.set(id, st);
  }
  const vmMap = new Map();
  const keyOf = (host, moref, name) => `${hostKey(host).full}|${moref ? `m:${moref}` : `n:${String(name).toLowerCase()}`}`;
  const touch = (host, moref, name) => {
    const k = keyOf(host, moref, name);
    let e = vmMap.get(k);
    if (!e) {
      if (vmMap.size >= maxVms) { counts.skipped++; return null; }
      e = { n: name, m: moref, h: host, j: [], rp: null, run: 0, pg: null, by: '' };
      vmMap.set(k, e);
    }
    if (!e.m && moref) e.m = moref;
    if (!e.h && host) e.h = host;
    return e;
  };
  for (const j of listOf(raw.jobs)) {
    if (!isObj(j)) continue;
    const id = s(j.id, 64);
    if (!id || jobIdx.has(id)) continue;
    const st = stateOf.get(id) || {};
    const status = s(st.status, 32) || s(j.status, 32);
    const job = {
      id, name: s(j.name, 128) || s(st.name, 128) || id, type: s(j.type, 48) || s(st.type, 48),
      disabled: j.isDisabled === true || /^disabled$/i.test(status),
      status, lastResult: s(st.lastResult, 32), lastRun: timeOf(st.lastRun), nextRun: timeOf(st.nextRun),
      running: RUNNING_RE.test(status), containers: 0, vms: 0,
    };
    const incs = Array.isArray(j.virtualMachines?.includes) ? j.virtualMachines.includes : [];
    const idx = jobs.length;
    for (const inc of incs.slice(0, 50_000)) {
      const o = isObj(inc?.inventoryObject) ? inc.inventoryObject : inc;
      if (!isObj(o)) continue;
      const type = s(o.type, 40);
      if (/^virtualmachine$/i.test(type) || /^vm$/i.test(type)) {
        const name = s(o.name, 256);
        const moref = morefOrEmpty(o.objectId);
        if (!name && !moref) continue;
        const e = touch(s(o.hostName, 256), moref, name || moref);
        if (!e) continue;
        if (!e.j.includes(idx)) e.j.push(idx);
        job.vms++;
      } else if (type) { job.containers++; }
    }
    counts.containers += job.containers;
    counts.vmJobs += job.vms;
    jobIdx.set(id, idx);
    jobs.push(job);
  }
  counts.jobs = jobs.length;
  // ── 백업 객체(복원 지점이 있는 VM) ──────────────────────────────────────────
  for (const o of listOf(raw.backupObjects)) {
    if (!isObj(o)) continue;
    const plat = s(o.platformName, 32);
    if (plat && !/^vmware$/i.test(plat)) continue;
    const type = s(o.type, 40) || s(o.viType, 40);
    if (type && !/^(vm|virtualmachine)$/i.test(type)) continue;
    const name = s(o.name, 256);
    const moref = morefOrEmpty(o.objectId);
    if (!name && !moref) continue;
    const e = touch(s(o.hostName, 256) || hostFromPath(o.path), moref, name || moref);
    if (!e) continue;
    counts.backupObjects++;
    const rp = numOrNull(o.restorePointsCount);
    e.rp = rp != null ? Math.max(e.rp ?? 0, Math.max(0, Math.round(rp))) : (e.rp ?? -1); // -1 = 복원 지점 있음(개수 모름)
  }
  // ── 실행 중 세션 ────────────────────────────────────────────────────────────
  const runningJobs = new Set(jobs.filter((x) => x.running).map((x) => x.id));
  const jobLevel = new Set();
  for (const it of Array.isArray(raw.sessions) ? raw.sessions : []) {
    const ses = isObj(it?.session) ? it.session : null;
    if (!ses) continue;
    counts.sessions++;
    const jid = s(ses.jobId, 64);
    if (jid) runningJobs.add(jid);
    const tasks = listOf(it.tasks);
    if (it.tasksError || !tasks.length) { if (jid) jobLevel.add(jid); continue; }
    for (const t of tasks) {
      if (!isObj(t)) continue;
      const state = s(t.state, 32);
      const run = RUNNING_RE.test(state) ? 1 : PENDING_RE.test(state) ? 2 : 0;
      if (!run) continue;
      const name = s(t.name, 256) || s(t.objectName, 256);
      const moref = morefOrEmpty(t.objectId);
      if (!name && !moref) continue;
      const e = touch(s(t.hostName, 256), moref, name || moref);
      if (!e) continue;
      const pg = numOrNull(t.progress?.progressPercent ?? t.progressPercent);
      if (run === 1 || e.run !== 1) { e.run = run; e.by = 'task'; e.pg = pg != null ? Math.max(0, Math.min(100, Math.round(pg))) : null; }
      if (jid && jobIdx.has(jid) && !e.j.includes(jobIdx.get(jid))) e.j.push(jobIdx.get(jid));
    }
  }
  // task 를 못 읽은 실행 중 작업 — 작업에 VM 단위로 포함된 VM 을 '백업 중(작업 단위)' 으로 둔다(어느 VM 차례인지는 모른다).
  for (const jid of runningJobs) {
    if (!jobIdx.has(jid)) continue;
    const idx = jobIdx.get(jid);
    jobs[idx].running = true;
    const hadTasks = !jobLevel.has(jid) && (raw.sessions || []).some((x) => s(x?.session?.jobId, 64) === jid);
    if (hadTasks) continue;
    for (const e of vmMap.values()) if (e.j.includes(idx) && !e.run) { e.run = 1; e.by = 'job'; }
  }
  const vms = [...vmMap.values()];
  for (const e of vms) { if (e.run === 1) counts.running++; else if (e.run === 2) counts.pending++; }
  if (counts.skipped) notes.push(`VM 상한(${maxVms})을 넘어 ${counts.skipped}건을 버렸습니다`);
  if (counts.containers) notes.push(`작업이 폴더·클러스터·태그 같은 컨테이너 ${counts.containers}개를 포함합니다 — 그 안의 VM 은 복원 지점이 생기거나 백업 중일 때만 표시됩니다`);
  return { jobs, vms, counts, notes };
}

/* ── 중앙 수신 정제(엣지가 보낸 결과) ───────────────────────────────────────── */

const FUTURE_SKEW_MS = 5 * 60_000;
/**
 * 엣지 결과 1건 정제 — 아는 필드만·객체만·상한·문자열 수치는 수로. ts 는 수신 시각으로 자르고 원본은 edgeTs.
 * @returns {object|null} 형식이 틀리면 null
 */
export function sanitizeServerResult(r, now = Date.now(), { maxVms = 20_000, maxJobs = 2_000 } = {}) {
  if (!isObj(r)) return null;
  let ts = numOrNull(r.ts);
  if (ts == null || ts <= 0) return null;
  let edgeTs = null;
  if (ts > now + FUTURE_SKEW_MS) { edgeTs = ts; ts = now; }
  const jobs = (Array.isArray(r.jobs) ? r.jobs : []).slice(0, maxJobs).filter(isObj).map((j) => ({
    id: s(j.id, 64), name: s(j.name, 128), type: s(j.type, 48), disabled: j.disabled === true, status: s(j.status, 32),
    lastResult: s(j.lastResult, 32), lastRun: numOrNull(j.lastRun), nextRun: numOrNull(j.nextRun), running: j.running === true,
    containers: Math.max(0, Math.round(numOrNull(j.containers) ?? 0)), vms: Math.max(0, Math.round(numOrNull(j.vms) ?? 0)),
  }));
  const nJobs = jobs.length;
  const vms = [];
  for (const v of (Array.isArray(r.vms) ? r.vms : []).slice(0, maxVms)) {
    if (!isObj(v)) continue;
    const n = s(v.n, 256); const m = morefOrEmpty(v.m);
    if (!n && !m) continue;
    const j = (Array.isArray(v.j) ? v.j : []).map((x) => numOrNull(x)).filter((x) => x != null && Number.isInteger(x) && x >= 0 && x < nJobs).slice(0, 64);
    const rp = numOrNull(v.rp);
    const run = v.run === 1 || v.run === 2 ? v.run : 0;
    const pg = numOrNull(v.pg);
    vms.push({ n, m, h: s(v.h, 256), j, rp: rp == null ? null : Math.max(-1, Math.round(rp)), run, pg: pg == null ? null : Math.max(0, Math.min(100, Math.round(pg))), by: v.by === 'task' || v.by === 'job' ? v.by : '' });
  }
  const c = isObj(r.counts) ? r.counts : {};
  const counts = {};
  for (const k of ['jobs', 'vmJobs', 'containers', 'backupObjects', 'sessions', 'running', 'pending', 'skipped']) counts[k] = numOrNull(c[k]);
  return {
    ok: r.ok === true, ts: Math.round(ts), ...(edgeTs != null ? { edgeTs } : {}), ms: numOrNull(r.ms),
    error: s(r.error, 600), kind: s(r.kind, 32), apiVersion: s(r.apiVersion, 32),
    notes: (Array.isArray(r.notes) ? r.notes : []).filter((x) => typeof x === 'string').slice(0, 10).map((x) => s(x, 300)),
    authStop: isObj(r.authStop) ? { since: numOrNull(r.authStop.since), attempts: numOrNull(r.authStop.attempts), reason: s(r.authStop.reason, 200) } : null,
    jobs, vms, counts,
  };
}

/* ── vCenter VM 과 대조 ───────────────────────────────────────────────────── */

/** 배지 근거가 되는 작업인가 — 꺼진 작업·복제(replica)·백업 복사(copy) 작업은 'Veeam 백업 대상' 근거가 아니다(v2.751 검토 #4). */
export function jobCountsAsBackup(jb) {
  if (!jb || typeof jb !== 'object') return false;
  if (jb.disabled === true) return false;
  return !/replica|copy/i.test(String(jb.type || ''));
}

/**
 * 한 vCenter 의 VM 목록과 그 vCenter 에 연결된 Veeam 서버 결과를 맞춘다. **틀린 배지(거짓 '백업됨')가 빠진 배지보다 나쁘다** —
 * 애매하면 맞추지 않고 센다.
 *  · Veeam 이 적은 vCenter 이름(h)이 이 vCenter 주소와 다르면 **다른 vCenter 의 VM** 이다(moref 는 vCenter 마다 겹친다) — 세기만 한다.
 *  · moref 가 있으면 **moref 로만** 찾는다(v2.751 검토 #1) — 못 찾으면 이름으로 대신하지 않는다(지운 VM 의 복원 지점이 같은 이름의 새 VM 에 붙지 않게).
 *    h 가 비어 있으면(task·백업 객체는 vCenter 이름을 안 줄 수 있다) moref 로 찾은 VM 의 이름도 같아야 한다(검토 #2 — 다른 vCenter 의 같은 moref).
 *  · moref 가 없으면 이름(대소문자 무시)으로 — 이 vCenter 안에서 이름이 하나뿐일 때만(동명이면 고르지 않는다).
 *  · 꺼진 작업·복제·복사 작업에만 든 VM 은 배지를 달지 않는다(검토 #4). 복원 지점·실행 중 task 는 작업과 무관하게 근거다.
 * @param {{id:string, host:string}} vc
 * @param {Array<{id:string, name:string}>} vms   이 vCenter 의 VM(포탈 인벤토리)
 * @param {Array<{server:{id,name}, result:object}>} results
 * @returns {{ byVm: Record<string, object>, unmatched:number, otherVcenter:number, ambiguous:number }}
 */
export function matchToVcenter(vc, vms, results) {
  const prefix = `${vc.id}:`;
  const byMoref = new Map();
  const byName = new Map();
  const nameOf = new Map();
  for (const v of Array.isArray(vms) ? vms : []) {
    if (!v || typeof v.id !== 'string' || !v.id.startsWith(prefix)) continue;
    byMoref.set(v.id.slice(prefix.length), v.id);
    const k = String(v.name || '').trim().toLowerCase();
    nameOf.set(v.id, k);
    if (!k) continue;
    byName.set(k, byName.has(k) ? null : v.id); // null = 동명 VM 이 둘 이상
  }
  const byVm = {};
  let unmatched = 0; let otherVcenter = 0; let ambiguous = 0;
  for (const { server, result } of Array.isArray(results) ? results : []) {
    if (!result || !Array.isArray(result.vms)) continue;
    const jobs = Array.isArray(result.jobs) ? result.jobs : [];
    for (const e of result.vms) {
      const okJobs = (e.j || []).map((ji) => jobs[ji]).filter(jobCountsAsBackup);
      const hasEvidence = okJobs.length > 0 || (e.rp != null && e.rp !== 0) || e.run === 1 || e.run === 2;
      if (!hasEvidence) continue;
      if (e.h && !sameHost(e.h, vc.host)) { otherVcenter++; continue; }
      const nm = String(e.n || '').trim().toLowerCase();
      let id;
      if (e.m) {
        id = byMoref.get(e.m);
        if (id && !e.h && nm && nameOf.get(id) !== nm) id = undefined; // vCenter 를 모르는 moref — 이름까지 같아야 이 vCenter 의 그 VM 이다
      } else {
        const hit = byName.get(nm);
        if (hit === null) { ambiguous++; continue; }
        id = hit;
      }
      if (!id) { unmatched++; continue; }
      const cur = byVm[id] || (byVm[id] = { jobs: [], run: 0, pg: null, by: '', rp: null, lastRun: null, lastResult: '', servers: [] });
      if (!cur.servers.includes(server.name)) cur.servers.push(server.name);
      for (const jb of okJobs) {
        if (cur.jobs.includes(jb.name)) continue;
        cur.jobs.push(jb.name);
        if (jb.lastRun != null && (cur.lastRun == null || jb.lastRun > cur.lastRun)) { cur.lastRun = jb.lastRun; cur.lastResult = jb.lastResult || ''; }
      }
      if (e.rp != null && e.rp !== 0) cur.rp = cur.rp == null ? e.rp : Math.max(cur.rp, e.rp);
      if (e.run === 1 || (e.run === 2 && cur.run !== 1)) { cur.run = e.run; cur.pg = e.pg; cur.by = e.by; }
    }
  }
  return { byVm, unmatched, otherVcenter, ambiguous };
}

/**
 * 대조 전에 '지금 백업 중' 을 낡은 결과에서 지운다(v2.751 검토 #6) — 이번 읽기가 실패해 마지막 성공분을 쓰거나 결과가 주기의 2배보다
 * 오래됐으면, 그때의 '백업 중 37%' 는 지금 사실이 아니다. 백업 대상(작업·복원 지점)은 그대로 둔다(그것은 금방 바뀌지 않는다).
 * @param {object} result  usableResult 값
 * @param {{failed:boolean, now:number, maxAgeMs:number}} o
 */
export function withoutStaleRunning(result, { failed = false, now = Date.now(), maxAgeMs = 1_200_000 } = {}) {
  if (!result || !Array.isArray(result.vms)) return result;
  const stale = failed || !(Number(result.ts) > 0) || now - Number(result.ts) > maxAgeMs;
  if (!stale) return result;
  return { ...result, runningStale: true, vms: result.vms.map((v) => (v.run ? { ...v, run: 0, pg: null, by: '' } : v)) };
}
