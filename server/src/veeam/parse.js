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
/** 0 이상 유한 수만(시각·바이트·개수·비율) — 그 밖은 null. */
const posNum = (v) => { const n = numOrNull(v); return n != null && n >= 0 ? n : null; };
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
 * @param {Array<{session:object, tasks:any}>} [raw.lastTasks] 작업마다 마지막으로 끝난 세션과 그 task 응답
 * @param {any} [raw.restorePoints]  GET /api/v1/restorePoints(페이지를 합친 배열)
 * @param {Array<{backup:object, files:any}>} [raw.backups] GET /api/v1/backups 원소와 그 backupFiles(못 읽었으면 files:null)
 * @returns {{jobs:object[], vms:object[], counts:object, notes:string[], backups:object[]}}
 *   vms 원소: { n:이름, m:moref, h:vCenter 호스트, j:[작업 인덱스], rp:복원지점수|null, run:0|1|2(1=백업 중·2=대기), pg:진행률|null, by:'task'|'job'|'',
 *              lt?:{r 결과, m 메시지, s 시작, e 끝, ps 처리, rs 읽음, ts 전송, j 작업}, rn?:복원 지점 수, ro?:가장 오래된, rl?:[최근 10개 시각], rb?:[백업 인덱스], sz?:VM 별 파일 용량 }
 *   backups 원소: { id, name, j:작업 인덱스, repo, n:파일 수|null, bs:백업 파일 합|null, ds:데이터 크기 합|null, dd·cr:최근 파일의 중복 제거·압축 비율, lf:최근 파일 시각 }
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
  // 같은 VM 을 응답마다 다르게 가리킨다 — 작업 includes 는 vCenter 이름을 주고 task·백업 객체는 안 줄 수 있다. vCenter 를 모르는 항목은
  // 같은 moref(없으면 이름)의 항목이 **하나뿐일 때만** 그것에 합친다(둘 이상이면 어느 vCenter 것인지 모르므로 따로 둔다 — 대조가 다시 거른다).
  const sameIdx = new Map(); // 'm:<moref>' | 'n:<이름>' → 항목 배열
  const idKey = (moref, name) => (moref ? `m:${moref}` : `n:${String(name).toLowerCase()}`);
  const touch = (host, moref, name) => {
    const ik = idKey(moref, name);
    const peers = sameIdx.get(ik) || [];
    let e = vmMap.get(keyOf(host, moref, name));
    if (!e && !host && peers.length > 1 && moref) { // moref 가 여러 vCenter 에 있으면 이름까지 같은 것이 하나뿐일 때만
      const same = peers.filter((x) => String(x.n).toLowerCase() === String(name).toLowerCase());
      if (same.length === 1) e = same[0];
    }
    // 한쪽이 vCenter 를 모르면 하나뿐인 같은 VM 에 합친다 — 둘 다 진짜 이름을 가지면 이름도 같아야 한다(다른 vCenter 의 같은 moref 를 합쳐 거짓 배지가 나지 않게).
    const realName = (x) => x && x !== moref;
    if (!e && peers.length === 1 && (!host || !peers[0].h)
      && (!realName(name) || !realName(peers[0].n) || String(peers[0].n).toLowerCase() === String(name).toLowerCase())) e = peers[0];
    if (!e) {
      if (vmMap.size >= maxVms) { counts.skipped++; return null; }
      e = { n: name, m: moref, h: host, j: [], rp: null, run: 0, pg: null, by: '' };
      vmMap.set(keyOf(host, moref, name), e);
      peers.push(e); sameIdx.set(ik, peers);
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
  // ── 작업마다 마지막으로 끝난 세션의 VM 별 결과(v2.751 사용자 요청 '백업 완료 날짜·시간' · 상세 창) ─────────────────
  // ⚠ 정직 기록: task 의 결과·시각·용량 필드 이름은 실서버로 확인하지 못했다(추정 — result 는 문자열 또는 {result,message},
  //   시각은 creationTime/startTime·endTime, 용량은 progress.processedSize·readSize·transferredSize). 없으면 null 로 둔다(0 을 만들지 않는다).
  for (const it of Array.isArray(raw.lastTasks) ? raw.lastTasks : []) {
    const ses = isObj(it?.session) ? it.session : null;
    if (!ses) continue;
    const jid = s(ses.jobId, 64);
    for (const t of listOf(it.tasks).slice(0, 20_000)) {
      if (!isObj(t)) continue;
      const name = s(t.name, 256) || s(t.objectName, 256);
      const moref = morefOrEmpty(t.objectId);
      if (!name && !moref) continue;
      const res = s(isObj(t.result) ? t.result.result : t.result, 32);
      const en = timeOf(t.endTime);
      const e = touch(s(t.hostName, 256), moref, name || moref);
      if (!e) continue;
      if (e.lt && (e.lt.e ?? 0) >= (en ?? 0)) continue;
      const pr = isObj(t.progress) ? t.progress : {};
      const ji = jid && jobIdx.has(jid) ? jobIdx.get(jid) : null;
      e.lt = {
        r: res, m: s(isObj(t.result) ? t.result.message : '', 300), s: timeOf(t.creationTime) ?? timeOf(t.startTime), e: en,
        ps: numOrNull(pr.processedSize ?? t.processedSize), rs: numOrNull(pr.readSize ?? t.readSize),
        ts: numOrNull(pr.transferredSize ?? pr.transferedSize ?? t.transferredSize), j: ji,
      };
      if (ji != null && !e.j.includes(ji)) e.j.push(ji);
      counts.lastTasks = (counts.lastTasks || 0) + 1;
    }
  }
  // ── 복원 지점(VM 별 개수·가장 오래된·최근 10개 시각) ─────────────────────────────────────────────
  // 복원 지점은 VM 을 이름(name)으로만 가리킨다(확인된 필드: creationTime·backupId·platformId). 한 Veeam 서버 안에서 같은 이름의
  // VM 항목이 둘 이상이면(다른 vCenter 의 동명 VM) 어느 쪽 것인지 모르므로 붙이지 않고 센다.
  const byLowerName = new Map();
  for (const e of vmMap.values()) { const k = String(e.n || '').toLowerCase(); byLowerName.set(k, byLowerName.has(k) ? null : e); }
  const rpOwner = new Map(); // 복원 지점 id → VM 항목(파일 용량을 VM 에 돌리는 데 쓴다)
  const rpLists = new Map();
  let rpAmbiguous = 0;
  for (const p of listOf(raw.restorePoints).slice(0, 200_000)) {
    if (!isObj(p)) continue;
    const plat = s(p.platformName, 32);
    if (plat && !/^vmware$/i.test(plat)) continue;
    const name = s(p.name, 256);
    const t = timeOf(p.creationTime);
    if (!name || t == null) continue;
    const e = byLowerName.get(name.toLowerCase());
    if (e === null) { rpAmbiguous++; continue; }
    if (!e) continue; // 이 서버가 VM 으로 모르는 이름(컨테이너로만 든 VM 은 백업 객체로 이미 잡힌다)
    let l = rpLists.get(e); if (!l) { l = []; rpLists.set(e, l); }
    const id = s(p.id, 64);
    l.push({ t, b: s(p.backupId, 64) });
    if (id) rpOwner.set(id, e);
  }
  // ── 백업(체인)과 그 파일 — 용량 ───────────────────────────────────────────────────────────────
  // ⚠ 추정: /api/v1/backups/{id}/backupFiles 의 원소가 backupSize·dataSize·dedupRatio·compressRatio·creationTime·objectRestorePointIds 를 준다
  //   (Enterprise Manager API 의 같은 이름 필드로 확인 — B&R v1 판은 미확인). 없으면 용량은 '—'.
  const backups = [];
  const bIdx = new Map();
  for (const it of (Array.isArray(raw.backups) ? raw.backups : []).slice(0, 500)) {
    const b = isObj(it?.backup) ? it.backup : null;
    const id = b ? s(b.id, 64) : '';
    if (!id || bIdx.has(id)) continue;
    const files = it.files == null ? null : listOf(it.files);
    let bs = null; let ds = null; let lf = null; let dd = null; let cr = null;
    for (const f of files || []) {
      if (!isObj(f)) continue;
      const fb = numOrNull(f.backupSize); const fd = numOrNull(f.dataSize); const ft = timeOf(f.creationTime);
      if (fb != null) bs = (bs ?? 0) + fb;
      if (fd != null) ds = (ds ?? 0) + fd;
      if (ft != null && (lf == null || ft > lf)) { lf = ft; dd = numOrNull(f.dedupRatio); cr = numOrNull(f.compressRatio); }
      // 파일 하나가 이 VM 의 복원 지점만 담으면(VM 별 백업 파일) 그 용량을 VM 에 돌린다 — 여러 VM 이 섞인 파일은 나누지 않는다.
      const ids = Array.isArray(f.objectRestorePointIds) ? f.objectRestorePointIds.filter((x) => typeof x === 'string') : [];
      if (fb != null && ids.length) {
        const owners = new Set(ids.map((x) => rpOwner.get(x)).filter(Boolean));
        if (owners.size === 1 && ids.every((x) => rpOwner.has(x))) { const o = [...owners][0]; o.sz = (o.sz ?? 0) + fb; }
      }
    }
    const ji = jobIdx.has(s(b.jobId, 64)) ? jobIdx.get(s(b.jobId, 64)) : null;
    bIdx.set(id, backups.length);
    backups.push({ id, name: s(b.name, 128), j: ji, repo: s(b.repositoryName, 128) || s(b.repositoryId, 64), n: files ? files.length : null, bs, ds, dd, cr, lf });
  }
  for (const [e, l] of rpLists) {
    l.sort((a, b2) => b2.t - a.t);
    e.rn = l.length;
    e.ro = l[l.length - 1].t;
    e.rl = l.slice(0, 10).map((x) => x.t);
    e.rb = [...new Set(l.map((x) => bIdx.get(x.b)).filter((x) => x != null))].slice(0, 5);
    if (e.rp == null || e.rp === -1) e.rp = l.length;
  }
  if (rpAmbiguous) notes.push(`이름이 같은 VM 이 둘 이상이라 복원 지점 ${rpAmbiguous}개를 어느 VM 것인지 정하지 못했습니다`);
  counts.restorePoints = [...rpLists.values()].reduce((a, l) => a + l.length, 0);
  counts.backups = backups.length;
  const vms = [...vmMap.values()];
  for (const e of vms) { if (e.run === 1) counts.running++; else if (e.run === 2) counts.pending++; }
  if (counts.skipped) notes.push(`VM 상한(${maxVms})을 넘어 ${counts.skipped}건을 버렸습니다`);
  if (counts.containers) notes.push(`작업이 폴더·클러스터·태그 같은 컨테이너 ${counts.containers}개를 포함합니다 — 그 안의 VM 은 복원 지점이 생기거나 백업 중일 때만 표시됩니다`);
  return { jobs, vms, counts, notes, backups };
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
  const backups = (Array.isArray(r.backups) ? r.backups : []).slice(0, 500).filter(isObj).map((b) => {
    const bj = numOrNull(b.j);
    return { id: s(b.id, 64), name: s(b.name, 128), j: bj != null && Number.isInteger(bj) && bj >= 0 && bj < nJobs ? bj : null, repo: s(b.repo, 128),
      n: posNum(b.n), bs: posNum(b.bs), ds: posNum(b.ds), dd: posNum(b.dd), cr: posNum(b.cr), lf: posNum(b.lf) };
  });
  const nBackups = backups.length;
  const vms = [];
  for (const v of (Array.isArray(r.vms) ? r.vms : []).slice(0, maxVms)) {
    if (!isObj(v)) continue;
    const n = s(v.n, 256); const m = morefOrEmpty(v.m);
    if (!n && !m) continue;
    const j = (Array.isArray(v.j) ? v.j : []).map((x) => numOrNull(x)).filter((x) => x != null && Number.isInteger(x) && x >= 0 && x < nJobs).slice(0, 64);
    const rp = numOrNull(v.rp);
    const run = v.run === 1 || v.run === 2 ? v.run : 0;
    const pg = numOrNull(v.pg);
    const out = { n, m, h: s(v.h, 256), j, rp: rp == null ? null : Math.max(-1, Math.round(rp)), run, pg: pg == null ? null : Math.max(0, Math.min(100, Math.round(pg))), by: v.by === 'task' || v.by === 'job' ? v.by : '' };
    if (isObj(v.lt)) {
      const lj = numOrNull(v.lt.j);
      out.lt = { r: s(v.lt.r, 32), m: s(v.lt.m, 300), s: posNum(v.lt.s), e: posNum(v.lt.e), ps: posNum(v.lt.ps), rs: posNum(v.lt.rs), ts: posNum(v.lt.ts), j: lj != null && Number.isInteger(lj) && lj >= 0 && lj < nJobs ? lj : null };
    }
    if (Array.isArray(v.rl)) out.rl = v.rl.map(posNum).filter((x) => x != null).slice(0, 10);
    if (v.rn != null) out.rn = posNum(v.rn);
    if (v.ro != null) out.ro = posNum(v.ro);
    if (v.sz != null) out.sz = posNum(v.sz);
    if (Array.isArray(v.rb)) out.rb = v.rb.map((x) => numOrNull(x)).filter((x) => x != null && Number.isInteger(x) && x >= 0 && x < nBackups).slice(0, 5);
    vms.push(out);
  }
  const c = isObj(r.counts) ? r.counts : {};
  const counts = {};
  for (const k of ['jobs', 'vmJobs', 'containers', 'backupObjects', 'sessions', 'running', 'pending', 'skipped', 'lastTasks', 'restorePoints', 'backups']) counts[k] = numOrNull(c[k]);
  return {
    ok: r.ok === true, ts: Math.round(ts), ...(edgeTs != null ? { edgeTs } : {}), ms: numOrNull(r.ms),
    error: s(r.error, 600), kind: s(r.kind, 32), apiVersion: s(r.apiVersion, 32),
    notes: (Array.isArray(r.notes) ? r.notes : []).filter((x) => typeof x === 'string').slice(0, 10).map((x) => s(x, 300)),
    authStop: isObj(r.authStop) ? { since: numOrNull(r.authStop.since), attempts: numOrNull(r.authStop.attempts), reason: s(r.authStop.reason, 200) } : null,
    jobs, vms, counts, backups,
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
/** 마지막 백업 완료 시각 — 마지막 task 가 성공·경고로 끝났으면 그 끝 시각(완료), 아니면 최신 복원 지점 생성 시각. */
export function lastBackupOf(e) {
  if (e?.lt && /^(success|warning)$/i.test(String(e.lt.r || '')) && e.lt.e != null) return { t: e.lt.e, src: 'task' };
  if (Array.isArray(e?.rl) && e.rl.length) return { t: e.rl[0], src: 'rp' };
  return null;
}

export function matchToVcenter(vc, vms, results, { refsFor = null } = {}) {
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
      const taskOk = !!(e.lt && /^(success|warning)$/i.test(String(e.lt.r || '')));
      const hasEvidence = okJobs.length > 0 || (e.rp != null && e.rp !== 0) || e.run === 1 || e.run === 2 || taskOk;
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
      const cur = byVm[id] || (byVm[id] = { jobs: [], run: 0, pg: null, by: '', rp: null, lastRun: null, lastResult: '', servers: [], lb: null, lbSrc: '' });
      if (!cur.servers.includes(server.name)) cur.servers.push(server.name);
      const lb = lastBackupOf(e);
      if (lb && (cur.lb == null || lb.t > cur.lb)) { cur.lb = lb.t; cur.lbSrc = lb.src; }
      if (refsFor && id === refsFor) (cur.refs || (cur.refs = [])).push({ server, result, entry: e });
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

/**
 * VM 1대의 백업 상세(배지를 누르면 뜨는 창) — matchToVcenter(…, { refsFor }) 가 모은 원소들로 만든다(순수).
 * 값이 없으면 null 로 둔다(화면이 '—' 와 이유를 말한다). 백업(체인) 용량은 **그 백업 전체**다 — 작업 단위 백업이면 다른 VM 과 공유한다.
 * @returns {object|null}
 */
export function buildVmDetail(cur) {
  if (!cur || !Array.isArray(cur.refs) || !cur.refs.length) return null;
  const jobsOut = []; const backupsOut = []; const rlAll = [];
  let rn = null; let ro = null; let sz = null; let lastTask = null; const servers = [];
  for (const { server, result, entry: e } of cur.refs) {
    const jobs = Array.isArray(result.jobs) ? result.jobs : [];
    if (!servers.some((x) => x.name === server.name)) servers.push({ name: server.name, ts: result.ts ?? null });
    for (const ji of e.j || []) {
      const jb = jobs[ji];
      if (!jb || jobsOut.some((x) => x.name === jb.name)) continue;
      jobsOut.push({ name: jb.name, type: jb.type || '', status: jb.status || '', lastResult: jb.lastResult || '', lastRun: jb.lastRun ?? null, nextRun: jb.nextRun ?? null,
        disabled: jb.disabled === true, running: jb.running === true, counts: jobCountsAsBackup(jb) });
    }
    if (e.rn != null) rn = (rn ?? 0) + e.rn;
    if (e.ro != null) ro = ro == null ? e.ro : Math.min(ro, e.ro);
    if (Array.isArray(e.rl)) for (const t of e.rl.slice(0, 10)) rlAll.push(t);
    if (e.sz != null) sz = (sz ?? 0) + e.sz;
    if (e.lt && (lastTask == null || (e.lt.e ?? 0) > (lastTask.end ?? 0))) {
      const lj = e.lt.j != null ? jobs[e.lt.j] : null;
      lastTask = { result: e.lt.r || '', message: e.lt.m || '', start: e.lt.s ?? null, end: e.lt.e ?? null,
        durationSec: e.lt.s != null && e.lt.e != null && e.lt.e >= e.lt.s ? Math.round((e.lt.e - e.lt.s) / 1000) : null,
        processed: e.lt.ps ?? null, read: e.lt.rs ?? null, transferred: e.lt.ts ?? null, job: lj ? lj.name : '' };
    }
    const bks = Array.isArray(result.backups) ? result.backups : [];
    for (const bi of e.rb || []) {
      const b = bks[bi];
      if (!b || backupsOut.some((x) => x.id === b.id)) continue;
      backupsOut.push({ id: b.id, name: b.name, job: b.j != null && jobs[b.j] ? jobs[b.j].name : '', repo: b.repo || '', files: b.n ?? null,
        backupSize: b.bs ?? null, dataSize: b.ds ?? null, dedup: b.dd ?? null, compress: b.cr ?? null, lastFile: b.lf ?? null });
    }
  }
  rlAll.sort((a, b) => b - a);
  return {
    running: cur.run === 1 ? { progress: cur.pg ?? null, by: cur.by || '' } : null, pending: cur.run === 2,
    lastBackup: cur.lb ?? null, lastBackupSrc: cur.lbSrc || '',
    lastTask,
    restorePoints: { count: rn ?? (cur.rp != null && cur.rp >= 0 ? cur.rp : null), oldest: ro, latest: rlAll[0] ?? null, recent: [...new Set(rlAll)].slice(0, 10) },
    vmSize: sz, backups: backupsOut, jobs: jobsOut, servers,
  };
}

