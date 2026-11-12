/**
 * central/focusMonEdge.js — 집중 모니터링 **엣지 동기화**의 중앙 쪽(v2.976): 받은 묶음 정제 · 적재 · 그 엣지가 지금 수집할 목록 응답 · 엣지 깨우기.
 *
 * ── 엣지가 보낸 것은 믿지 않는다(루트 CLAUDE.md ‘엣지가 보낸 것은 정제한다’ · server/CLAUDE.md central 규약) ─────────────
 *  · 이름은 **토큰으로 인증된 agent** 만 쓴다(본문의 agent 를 읽지 않는다). 라우트가 개별 토큰(agent 모드)이 아니면 403.
 *  · 그 엣지가 맡지 않은 대상 id 는 버린다 — 다른 법인 서버의 값 · 상태 · 시험 결과를 덮어쓰지 못한다(버린 수를 센다).
 *  · 아는 필드만 · 객체만 · 배열 상한(대상 20 × 표본 300 · 인터페이스 64 · 장치 512 · 프로세스 30) · 문자열은 글자 · 길이 검사 · 수치는 numOrNull.
 *  · 엣지 시각은 **수신 시각으로 옮긴다**: ts = 수신 시각 − (엣지 보낸 시각 − 엣지 표본 시각), 앞뒤를 [수신 − 10분, 수신] 으로 자른다(엣지 시계 오차에 둔감).
 *  · 응답의 목록(주소 · 포트 · 계정 · 주기)은 비밀이 아니다 — 비밀번호 · 개인키는 이 경로에 없다(엣지는 자기 키를 쓴다).
 *  · 응답의 `validUntil`(30초) — 엣지는 그 안에 다시 동기화하지 못하면 모든 수집기를 닫는다(받는 쪽 TTL 보다 짧은 보류 시한).
 */
import { numOrNull } from '../util/numOrNull.js';
import { strOf } from '../util/coercionTrap.js';
import { pullFromEdge } from './edgePull.js';
import { featureMinEdgeVersion } from './featureMinEdgeVersion.js';
import * as store from '../focusmon/store.js';
import { listTargets, registryLoadError, getSettings } from '../focusmon/registry.js';
import { setWakeImpl } from '../focusmon/service.js';
import { IOSTAT_COLS, TOP_N } from '../focusmon/rates.js';
import { INTERVALS, PROC_EVERY_CHOICES } from '../focusmon/script.js';

export const VALID_MS = 30_000;
export const MAX_SAMPLES = 6000;
export const MAX_PER_TARGET = 300;
const BACKLOG_MS = 10 * 60_000;
const STATES = new Set(['connecting', 'ok', 'stale', 'auth', 'hostkey', 'unreachable', 'no-key', 'unsupported-os', 'limit', 'stopped', 'error']);
const TEST_KINDS = new Set(['ok', 'os-unverified', 'no-key', 'auth', 'auth-stopped', 'hostkey', 'timeout', 'unreachable', 'unsupported-os', 'bad-output']);
const NAME_RE = /^[^\s:/]{1,32}$/;
const DEV_RE = /^[A-Za-z0-9_.!:+-]{1,64}$/;
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const n = numOrNull;
const arr = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
const enumOr = (v, set, def) => (typeof v === 'string' && set.has(v) ? v : def);
const nameOr = (v, re = NAME_RE) => (typeof v === 'string' && re.test(v) ? v : null);

export function cleanHello(h) {
  if (!isObj(h)) return null;
  return {
    kernel: strOf(h.kernel, 120), isLinux: h.isLinux === true, release: strOf(h.release, 120),
    rhelMajor: typeof h.rhelMajor === 'string' && /^\d{1,2}\.\d{1,2}$/.test(h.rhelMajor) ? h.rhelMajor : null,
    tck: n(h.tck), page: n(h.page), ncpu: n(h.ncpu), hidepid: h.hidepid === true ? true : h.hidepid === false ? false : null,
    dacct: h.dacct === true ? true : h.dacct === false ? false : null, // v2.981 지연 집계(디스크 대기)
    hostname: strOf(h.hostname, 64).replace(/[^A-Za-z0-9._-]/g, ''),
  };
}

/** 표본 하나 정제(rates.computeSample 모양만 통과). */
export function cleanSample(s) {
  if (!isObj(s)) return null;
  const cpu = isObj(s.cpu) ? { pct: n(s.cpu.pct), usr: n(s.cpu.usr), sys: n(s.cpu.sys), iow: n(s.cpu.iow), stl: n(s.cpu.stl), irq: n(s.cpu.irq), cores: arr(s.cpu.cores, 1024).map(n) } : null;
  const mem = isObj(s.mem) ? Object.fromEntries(['pct', 'total', 'used', 'avail', 'bc', 'free', 'swT', 'swU', 'dirty', 'slab'].map((k) => [k, n(s.mem[k])])) : null;
  const net = arr(s.net, 64).filter(isObj).map((x) => ({
    n: nameOr(x.n), k: enumOr(x.k, new Set(['bond', 'phys', 'virt']), 'virt'), sp: n(x.sp), st: typeof x.st === 'string' && /^[a-z]{2,16}$/.test(x.st) ? x.st : null,
    m: nameOr(x.m), md: typeof x.md === 'string' && /^[a-z0-9-]{2,20}$/.test(x.md) ? x.md : null, mem: arr(x.mem, 16).map((y) => nameOr(y)).filter(Boolean), act: nameOr(x.act),
    rx: n(x.rx), tx: n(x.tx), u: n(x.u), er: n(x.er), dr: n(x.dr),
  })).filter((x) => x.n);
  const dsk = arr(s.dsk, 512).filter(isObj).map((d) => ({
    n: nameOr(d.n, DEV_RE), dn: d.dn == null ? null : strOf(d.dn, 128), k: enumOr(d.k, new Set(['disk', 'part', 'lvm', 'mpath', 'raid', 'other']), 'other'),
    p: nameOr(d.p, DEV_RE), mp: strOf(d.mp, 200), sz: n(d.sz),
    v: IOSTAT_COLS.map((_, i) => n(Array.isArray(d.v) ? d.v[i] : null)), fl: n(d.fl), ...(d.stuck === true ? { stuck: true } : {}),
  })).filter((d) => d.n);
  const dtot = Array.isArray(s.dtot) ? IOSTAT_COLS.map((_, i) => n(s.dtot[i])) : null;
  return {
    dt: n(s.dt), cpu, mem, net, dsk, dtot, nPhys: n(s.nPhys),
    load: Array.isArray(s.load) ? [n(s.load[0]), n(s.load[1]), n(s.load[2])] : null, run: n(s.run), blk: n(s.blk), thr: n(s.thr),
  };
}

/** comm(프로세스 이름) — 원격 awk 가 바꾼 안전한 글자만. */
const COMM_RE = /^[A-Za-z0-9._:@+*-]{1,64}$/;
/** 서비스 이름(v2.981) — parse.js UNIT_RE 와 같은 규칙(.service · .scope · 점 둘 없음). */
const UNIT_OK = (v) => typeof v === 'string' && /^(?!.*\.\.)[A-Za-z0-9@_:-][A-Za-z0-9@._:-]{0,95}$/.test(v) && /\.(service|scope)$/.test(v);
/** 0 이상 · 상한 이하 수(음수 · 글자 · 무한 → null). */
const nn = (v, max = 1e12) => { const x = n(v); return x == null || x < 0 || x > max ? null : x; };
/** 0 이상 정수 · 상한(반증 F9: sk 1.5 · 1e21 이 그대로 통과해 화면이 400 을 5초마다 되풀이했다). */
const ii = (v, max) => { const x = n(v); return x != null && Number.isInteger(x) && x >= 0 && x <= max ? x : null; };
/** 엣지가 실은 새 칸(v2.981) — 값이 있는 것만(null 칸은 싣지 않는다 · 반증 F10 DB 크기). */
function procExtra(x) {
  const o = {
    us: nn(x.us, 1e6), sy: nn(x.sy, 1e6), pp: ii(x.pp, 4_194_304), pc: typeof x.pc === 'string' && COMM_RE.test(x.pc) ? x.pc : null,
    sv: UNIT_OK(x.sv) ? x.sv : null, ns: ii(x.ns, 1e6),
    ni: (() => { const v = n(x.ni); return v != null && Number.isInteger(v) && v >= -20 && v <= 19 ? v : null; })(),
    st: typeof x.st === 'string' && /^[A-Za-z]$/.test(x.st) ? x.st : null,
    vsz: nn(x.vsz, 1e9), mf: nn(x.mf, 1e9), io: nn(x.io, 1e4), rb: nn(x.rb, 1e7), wb: nn(x.wb, 1e7), sk: ii(x.sk, Number.MAX_SAFE_INTEGER),
  };
  for (const k of Object.keys(o)) if (o[k] == null) delete o[k];
  return o;
}
export function cleanProcs(p) {
  if (!isObj(p)) return null;
  return {
    n: n(p.n),
    top: arr(p.top, TOP_N).filter(isObj).map((x) => ({
      pid: n(x.pid), c: typeof x.c === 'string' && COMM_RE.test(x.c) ? x.c : '?',
      u: typeof x.u === 'string' && /^[A-Za-z0-9._@+-]{1,32}$/.test(x.u) ? x.u : null,
      cpu: n(x.cpu), sh: n(x.sh), rss: n(x.rss), th: n(x.th), et: n(x.et),
      ...procExtra(x), // v2.981 프로세스 세부 정보 — 아는 칸만 · 형식 · 범위 · 옛 엣지는 없음(읽는 쪽 null)
    })).filter((x) => x.pid != null),
    da: p.da === true ? true : p.da === false ? false : null,
  };
}

function cleanStatus(st, now) {
  if (!isObj(st)) return null;
  return {
    state: enumOr(st.state, STATES, 'error'), error: strOf(st.error, 240),
    lastSampleAt: (() => { const v = n(st.lastSampleAt); return v == null ? null : Math.min(v, now); })(),
    interval: INTERVALS.includes(n(st.interval)) ? n(st.interval) : null,
    osVerified: st.osVerified === true ? true : st.osVerified === false ? false : null,
    hello: cleanHello(st.hello),
  };
}

/** 엣지 공개키 보기(지문 · 공개키 · 종류만 — 개인키 칸은 애초에 없다). */
export function cleanKey(k) {
  if (!isObj(k)) return null;
  const pub = typeof k.publicKey === 'string' && /^(ecdsa-sha2-nistp(256|384|521)|ssh-ed25519|ssh-rsa) [A-Za-z0-9+/=]{20,8192}( [\x20-\x7e]{0,80})?$/.test(k.publicKey) ? k.publicKey : null;
  return {
    present: k.present === true, usable: k.usable === true, type: typeof k.type === 'string' && /^[a-z0-9-]{3,40}$/.test(k.type) ? k.type : null,
    fingerprint: typeof k.fingerprint === 'string' && /^SHA256:[A-Za-z0-9+/]{20,64}$/.test(k.fingerprint) ? k.fingerprint : null,
    publicKey: pub, source: enumOr(k.source, new Set(['env', 'generated', 'copied']), null), error: k.error ? strOf(k.error, 200) : undefined,
  };
}

/**
 * 엣지 연결 진단(v2.978) 정제 — 수치는 음수 · 비수치를 null 로, 상한으로 자른다. 시각은 **나이(ms)** 로만 받는다(엣지 시계를 믿지 않는다 —
 * 중앙이 수신 시각에서 빼 시각을 만든다 · 최대 7일). 글자는 마지막 오류 한 줄(200자) — 엣지 콘솔 원문이 아니라 워커가 만든 사유다.
 */
const DIAG_AGE_MAX = 7 * 86_400_000;
export function cleanDiag(d, now = Date.now()) {
  if (!isObj(d)) return null;
  const cnt = (v, max) => { const x = n(v); return x == null || x < 0 ? null : Math.min(max, Math.round(x)); };
  const age = cnt(d.lastErrorAgoMs, DIAG_AGE_MAX);
  const err = d.lastError ? strOf(d.lastError, 200).replace(/[\x00-\x1f\x7f]/g, ' ') : '';
  return {
    rttMs: cnt(d.rttMs, 600_000), fails: cnt(d.fails, 1_000_000), buffered: cnt(d.buffered, 100_000), dropped: cnt(d.dropped, 1e12),
    collectors: cnt(d.collectors, 1000), testsBusy: cnt(d.testsBusy, 1000), idleMs: cnt(d.idleMs, 3_600_000),
    lastError: err || null, lastErrorAt: err && age != null ? now - age : null,
  };
}

/**
 * v2.983 수집 부하 창 정제(엣지가 보낸 것) — 아는 칸만 · 수는 0 이상 상한 · 정수 칸은 정수 · 주기는 허용 목록. 모르는 칸 · 글자 · at · demo 는 버린다.
 * 필수 칸(windowS · cpuPct 중 하나라도 수가 아님)이 없으면 null.
 */
const numIn = (v, max) => { const x = n(v); return x == null || x < 0 ? null : Math.min(max, x); };
const intIn = (v, max) => { const x = n(v); return x == null || x < 0 || !Number.isInteger(x) ? null : Math.min(max, x); };
export function cleanLoad(l) {
  if (!isObj(l)) return null;
  const windowS = numIn(l.windowS, 600); const cpuPct = numIn(l.cpuPct, 100_000);
  if (windowS == null || cpuPct == null) return null;
  const groups = {};
  for (const g of ['base', 'topo', 'proc']) {
    const x = isObj(l.groups) && isObj(l.groups[g]) ? l.groups[g] : {};
    groups[g] = { pct: numIn(x.pct, 100_000), runs: intIn(x.runs, 100_000), msPerRun: numIn(x.msPerRun, 600_000) };
  }
  const by = isObj(l.bpsBy) ? l.bpsBy : {}; const per = isObj(l.bytesPerRun) ? l.bytesPerRun : {};
  return {
    windowS, cpuPct, serverPct: numIn(l.serverPct, 100), sshdPct: numIn(l.sshdPct, 100_000), groups,
    bps: numIn(l.bps, 1e10),
    bpsBy: { base: numIn(by.base, 1e10), topo: numIn(by.topo, 1e10), proc: numIn(by.proc, 1e10), self: numIn(by.self, 1e10) },
    bytesPerRun: { base: intIn(per.base, 1e9), topo: intIn(per.topo, 1e9), proc: intIn(per.proc, 1e9) },
    rssBytes: intIn(l.rssBytes, 1e12), sshdRssBytes: intIn(l.sshdRssBytes, 1e12), ncpu: intIn(l.ncpu, 4096),
    interval: INTERVALS.includes(n(l.interval)) ? n(l.interval) : null, procEvery: PROC_EVERY_CHOICES.includes(n(l.procEvery)) ? n(l.procEvery) : null,
    procs: intIn(l.procs, 1_000_000),
  };
}
/** v2.983 엣지 노드 표본 정제(diag.node) — 아는 칸만. 모두 수가 아니면 null. */
export function cleanNodeLoad(x) {
  if (!isObj(x)) return null;
  const out = {
    windowS: numIn(x.windowS, 3600), cpuPct: numIn(x.cpuPct, 100_000), fmPct: numIn(x.fmPct, 100_000), rssBytes: intIn(x.rssBytes, 1e13),
    elMaxMs: numIn(x.elMaxMs, 600_000), eluPct: numIn(x.eluPct, 100), rxBps: numIn(x.rxBps, 1e10), sessions: intIn(x.sessions, 10_000), txBps: numIn(x.txBps, 1e10),
  };
  return Object.values(out).some((v) => v != null) ? out : null;
}

/**
 * 엣지 시각 → 중앙 시각. 엣지 시계를 믿지 않는다 — '보낸 시각 − 표본 시각'(나이)만 쓰고 수신 시각에서 뺀다.
 * 미래(나이 < 0)는 수신 시각으로, 너무 오래된 것(BACKLOG_MS 초과)은 BACKLOG_MS 로 자른다. 값이 없으면 null.
 */
export function edgeTimeToCentral(t, sentAt, now) {
  const v = n(t);
  if (v == null) return null;
  const age = sentAt != null ? Math.max(0, sentAt - v) : 0;
  return Math.max(now - BACKLOG_MS, Math.min(now, now - age));
}
export const EDGE_BACKLOG_MS = BACKLOG_MS;

/**
 * 동기화 한 번 처리.
 * @param {string} agent  토큰으로 인증된 엣지 이름
 * @param {object} body
 * @returns {object} 응답 본문
 */
export function handleEdgeSync(agent, body, now = Date.now()) {
  const b = isObj(body) ? body : {};
  const key = String(agent || '').toLowerCase();
  // 등록부를 못 읽으면 빈 목록(200)을 주지 않는다 — 엣지가 수집기를 다 닫고 '대상 없음' 으로 잘못 기록한다(반증 10번 · registryUnreadable 규약).
  if (registryLoadError()) return { ok: false, code: 'registryUnreadable', reason: '중앙의 집중 모니터링 등록부를 읽지 못했습니다 — 중앙 관리자가 손상 보존본을 확인해야 합니다.' };
  const mine = new Map(listTargets().filter((t) => String(t.agent || '').toLowerCase() === key).map((t) => [t.id, t]));
  const sentAt = n(b.sentAt);
  const toCentral = (t) => edgeTimeToCentral(t, sentAt, now);
  const got = { samples: 0, procs: 0, foreign: 0, bad: 0, idle: 0 };
  const perTarget = new Map();
  // 지금 수집 중이거나 막 끝난 수집의 대상만 받는다 — 아무도 시작하지 않은 대상의 값을 엣지가 밀어 넣어 메모리 · DB 를 채우지 못하게(반증 1번).
  const accepting = store.acceptingTargetIds(now);
  for (const x of arr(b.samples, MAX_SAMPLES)) {
    if (!isObj(x) || typeof x.id !== 'string') { got.bad += 1; continue; }
    if (!mine.has(x.id)) { got.foreign += 1; continue; }
    if (!accepting.has(x.id)) { got.idle += 1; continue; }
    const c = (perTarget.get(x.id) || 0) + 1; perTarget.set(x.id, c);
    if (c > MAX_PER_TARGET) { got.bad += 1; continue; }
    const ts = toCentral(x.t); const s = cleanSample(x.s);
    if (ts == null || !s) { got.bad += 1; continue; }
    if (store.ingestSample(x.id, ts, s, cleanHello(x.hello), now)) got.samples += 1;
  }
  for (const id of perTarget.keys()) store.flushReopened(id); // 늦은 표본은 분마다 한 번만 다시 쓴다
  for (const x of arr(b.procs, 2000)) {
    if (!isObj(x) || typeof x.id !== 'string') { got.bad += 1; continue; }
    if (!mine.has(x.id)) { got.foreign += 1; continue; }
    if (!accepting.has(x.id)) { got.idle += 1; continue; }
    const ts = toCentral(x.t); const p = cleanProcs(x.p);
    if (ts == null || !p) { got.bad += 1; continue; }
    if (store.ingestProcs(x.id, ts, p)) got.procs += 1;
  }
  if (isObj(b.status)) {
    for (const [id, st] of Object.entries(b.status).slice(0, 200)) {
      if (!mine.has(id)) { got.foreign += 1; continue; }
      const c = cleanStatus(st, now);
      if (c) store.setStatus(id, { ...c, via: 'edge' }, now);
    }
  }
  for (const x of arr(b.tests, 50)) {
    if (!isObj(x) || !mine.has(x.id) || !isObj(x.result)) continue;
    const r = x.result;
    store.putTestResult(x.id, { ok: r.ok === true, kind: enumOr(r.kind, TEST_KINDS, 'unreachable'), error: r.error ? strOf(r.error, 240) : '', hello: cleanHello(r.hello), ms: n(r.ms), via: 'edge' }, now);
  }
  // v2.983 수집 부하 — 이 엣지가 맡고 지금 받는 대상만 · 정제(cleanLoad 화이트리스트) · 시각은 수신 시각
  if (isObj(b.load)) {
    for (const [id, l] of Object.entries(b.load).slice(0, 200)) {
      if (!mine.has(id)) { got.foreign += 1; continue; }
      if (!accepting.has(id)) { got.idle += 1; continue; }
      const c = cleanLoad(l);
      if (c) store.setLoad(id, { ...c, via: 'edge' }, now); else got.bad += 1;
    }
  }
  const diag = cleanDiag(b.diag, now); // 노드 카드 진단 · 아래 시험 배달(진행 중 시험 수)이 같은 정제값을 쓴다
  const node = isObj(b.diag) ? cleanNodeLoad(b.diag.node) : null;
  // 반증 F1: 맡은 서버가 없거나 수집기가 0 인 엣지의 표본은 받지 않는다(집중 모니터링을 쓰지 않아도 엣지마다 분당 한 줄이 쌓였다) · 같은 표본의 재전송은 store 가 거른다
  if (node && mine.size > 0 && node.sessions > 0) store.setNodeLoad(key, node, now);
  store.noteEdgeSync(agent, { version: typeof b.version === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(b.version) ? b.version : '', key: cleanKey(b.key), diag }, now);

  const desired = store.desiredFor(key, (id) => mine.get(id) || null, now);
  const tests = store.pendingTestsFor(key, now, { busy: diag ? diag.testsBusy : null }).filter((id) => mine.has(id)).map((id) => { const t = mine.get(id); return { id, host: t.host, port: t.port, username: t.username }; });
  return {
    ok: true, now, validUntil: now + VALID_MS,
    targets: desired.map((d) => ({ id: d.id, host: d.host, port: d.port, username: d.username, interval: d.interval, procEvery: getSettings().procEvery })), // v2.983 procEvery — 프로세스 표본 주기(중앙 설정)
    // retries(id) 는 옛 판 엣지용 · retryTargets(v2.978)는 접속 정보까지 — 수집 중이 아닌 대상(시험만 한 서버)의 인증 정지도 엣지가 풀 수 있게.
    //   예전에는 엣지가 수집 목록에서만 대상을 찾아, 시험만 한 서버의 '다시 연결' 이 아무것도 풀지 못했다(사용자 보고 2026-11-12 — 키를 넣어도 '거부로 멈춤').
    ...(() => { const ids = store.takeEdgeRetries(key, now).filter((id) => mine.has(id)); return { retries: ids, retryTargets: ids.map((id) => { const t = mine.get(id); return { id, host: t.host, port: t.port, username: t.username }; }) }; })(),
    tests,
    ensureKey: mine.size > 0,
    // v2.978 시작 지연 줄이기: 맡은 서버가 있는 엣지는 쉬는 동안에도 이 주기로 조회한다(깨우기가 닿지 않는 중계 엣지 — 예전 30초 고정).
    // 맡은 서버가 없으면 싣지 않는다(엣지 기본 30초). 옛 판 엣지는 이 칸을 모르고 30초를 쓴다.
    ...(mine.size > 0 ? { idleMs: getSettings().edgeIdleSec * 1000 } : {}),
    accepted: got,
  };
}

/** 엣지에 집중 모니터링이 처음 실린 판(안내 문구용 — 게이트가 아니다. featureMinEdgeVersion 규약). */
export const FOCUS_EDGE_TITLE_RE = /특수 기능 › 서버 › 집중 모니터링/;
/** 엣지 연결 진단 · 쉬는 주기 단축이 처음 실린 판(v2.978 표지 — 릴리스 노트 제목에 그대로 넣는다). */
export const FOCUS_DIAG_TITLE_RE = /서버 집중 모니터링 — CSV 대량 등록/;
export const focusEdgeMinVersion = (o) => featureMinEdgeVersion(FOCUS_EDGE_TITLE_RE, o);
export const focusDiagMinVersion = (o) => featureMinEdgeVersion(FOCUS_DIAG_TITLE_RE, o);

/**
 * 엣지 깨우기 — 수집 시작 · 시험 · 다시 연결 때 한 번(실패해도 엣지의 쉬는 주기 조회가 받는다). 결과는 노드 카드 진단에 남긴다(v2.978).
 * 옛 판(경로 없음 → 401/404)은 kind 'old-version'. 이름 검사는 pullFromEdge 의 등록부 조회가 한다(등록부에 없는 이름은 접속하지 않는다).
 */
export async function wakeEdge(agent, { by = 'auto', pull = pullFromEdge } = {}) {
  let out;
  try {
    const r = await pull(agent, '/api/collector/focus-mon/wake', {
      method: 'POST', jsonBody: {}, retries: 0, timeoutMs: 8_000, missing401: true, minVersion: focusEdgeMinVersion(),
      what: '서버 집중 모니터링을 엣지에서 돌릴', label: '엣지 집중 모니터링 깨우기', bodyOk: (body) => isObj(body) && body.ok === true,
    });
    out = { ok: !!r.ok, kind: r.ok ? 'ok' : (r.kind || 'error'), ms: n(r.ms), reason: r.ok ? '' : strOf(r.reason, 200) };
  } catch (e) { out = { ok: false, kind: 'error', ms: null, reason: String(e?.message || e).slice(0, 160) }; }
  store.noteEdgeWake(agent, { ...out, by });
  return out;
}
setWakeImpl((agent) => { wakeEdge(agent).catch(() => {}); });
