/**
 * central/bmPerfSanitize.js — 엣지 봉투의 리눅스 성능 항목(v2.919) **중앙 정제 화이트리스트**.
 *
 * 루트 CLAUDE.md ‘엣지가 보낸 것은 정제한다’: **아는 필드만 · 객체만 · 상한 · 문자열 수치는 수로**. 봉투 모양은
 *   `bmusage/edgePull.js` + `bmusage/perfView.js buildPerfEntry` 가 정한다 — 그 필드만 그 타입으로 담는다.
 * ⚠ 중앙은 **다시 판정하지 않는다** — code·line 은 엣지가 만든 값을 허용 목록(enum) 안에서만 그대로 전한다. 목록 밖 값은 'missing'.
 * ⚠ 모르는 필드는 버리고, 버린 원소 수는 `sanitizeDropped` 에 더한다(조용한 축약 금지 — 호출부가 합친다).
 */
import { sanitizeCollectHealth } from './bmCollectHealthSanitize.js'; // 6단계 수집 건강
import { strOf } from '../util/coercionTrap.js';
import { numOrNull } from '../util/numOrNull.js';
import { PERF_COL_NAMES } from '../bmusage/perfCols.js';
import { PERF_DEFAULTS } from '../bmusage/settings.js';
import { SYSCTL_PATHS } from '../bmusage/parse/linuxProc.js';
import { clampEdgeTs } from '../util/clampEdgeTs.js';
import { DETECT_ACCOUNTS, KARG_KEYS } from '../bmusage/parse/linuxFacts.js'; // v2.923: 4단계 감지 · 튜닝 사실(화이트리스트 원천)
import { HEALTH_CELLS, HEALTH_CODES } from '../bmusage/health.js'; // v2.929: 점검 소모품 칸(화이트리스트 원천)
import { sanitizeFocusSummary, sanitizeAlertSent } from './bmPerfOpsPull.js'; // v2.929: 봉투의 집중 요약 · 알림 발송 기록

export const PERF_LIST_MAX = 2_000;
const DEV_MAX = 32;
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const num = numOrNull;
const str = (v, max) => strOf(v, max);
const bool = (v) => v === true;
const oneOf = (v, list, def) => (typeof v === 'string' && list.includes(v) ? v : def);
const list = (v, max, fn) => (Array.isArray(v) ? v.slice(0, max).filter(isObj).map(fn) : []);
// 배열 원소 상한은 앞 max 개만 훑는다(문자열 .slice 가 아니다 — 각 원소는 strOf 가 capStr 로 자른다).
const strList = (v, max, len) => {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (let i = 0; i < v.length && out.length < max; i += 1) if (typeof v[i] === 'string') out.push(str(v[i], len));
  return out;
};

const CODES = ['ok', 'warn', 'bad', 'none', 'missing', 'nopath', 'stale'];
const RES = ['cpu', 'mem', 'disk', 'net', 'hw'];
const UES = ['U', 'S', 'E'];
const COVERAGE = ['both', 'os', 'idrac', 'none'];
const VERDICTS = ['bottleneck', 'saturated', 'errors', 'warn', 'ok', 'partial', 'stale', 'unknown'];
const CROSS_STATES = ['candidate', 'clear', 'inactive', 'missing', 'nopath'];
const SECTION_STATES = ['ok', 'absent', 'missing'];
const SECTION_NAMES = ['stat', 'load', 'psi', 'vmstat', 'snmp', 'blkq', 'sysctl', 'hugepages', 'irq', 'dfi'];
const SYSCTL_KEYS = Object.values(SYSCTL_PATHS);

function numKeys(o, keys) {
  if (!isObj(o)) return null;
  return Object.fromEntries(keys.map((k) => [k, num(o[k])]));
}
function sections(o, names) {
  if (!isObj(o)) return null;
  const out = {};
  for (const k of names) if (Object.hasOwn(o, k)) out[k] = oneOf(o[k], SECTION_STATES, 'missing');
  return out;
}
const faultList = (v) => (Array.isArray(v) ? list(v, 16, (f) => ({ kind: str(f.kind, 16), label: str(f.label, 80), state: str(f.state, 16) })) : null);

function cellsOf(c) {
  if (!isObj(c)) return null;
  const out = {};
  for (const r of RES) {
    const rc = isObj(c[r]) ? c[r] : {};
    out[r] = {};
    for (const k of UES) {
      const x = isObj(rc[k]) ? rc[k] : {};
      out[r][k] = {
        code: oneOf(x.code, CODES, 'missing'),
        basis: list(x.basis, 8, (b) => ({
          key: str(b.key, 32), label: str(b.label, 64), value: num(b.value), unit: str(b.unit, 16), code: oneOf(b.code, CODES, 'missing'),
          ...(typeof b.device === 'string' && b.device ? { device: str(b.device, 64) } : {}),
        })),
      };
    }
  }
  return out;
}
function codesOf(c) {
  const out = {};
  for (const r of RES) {
    const rc = isObj(c?.[r]) ? c[r] : {};
    out[r] = Object.fromEntries(UES.map((k) => [k, oneOf(rc[k], CODES, 'missing')]));
  }
  return out;
}
/**
 * v2.929(5단계) — 점검 소모품 칸 정제(아는 칸 · code enum · 값은 수 · 짧은 글자만). full = 상세(값 포함) · 아니면 code · since 만.
 */
const HEALTH_NUM = ['offsetMs', 'stratum', 'limitMs', 'failed', 'delta', 'total', 'rc', 'err24', 'warn24', 'err', 'warn', 'limit', 'upDays', 'fdPct', 'conntrackPct', 'limitFd', 'limitCt', 'days', 'count'];
export function healthOf(h, rcv, { full = true } = {}) {
  if (!isObj(h) || !isObj(h.cells)) return null;
  const cells = {};
  for (const k of HEALTH_CELLS) {
    const c = h.cells[k];
    if (!isObj(c)) continue;
    const since = isObj(h.since) ? clampEdgeTs(h.since[k], rcv) : clampEdgeTs(c.since, rcv);
    if (!full) { cells[k] = { code: oneOf(c.code, HEALTH_CODES, 'missing'), ...(since != null ? { since } : {}) }; continue; }
    const out = { code: oneOf(c.code, HEALTH_CODES, 'missing') };
    for (const f of HEALTH_NUM) if (Object.hasOwn(c, f)) out[f] = num(c[f]);
    for (const f of ['leap', 'kernel', 'tuned', 'selinux', 'firewalld', 'why']) if (Object.hasOwn(c, f)) out[f] = c[f] == null ? null : str(c[f], 64);
    for (const f of ['synced', 'needsRestart', 'conntrackAbsent']) if (Object.hasOwn(c, f)) out[f] = c[f] == null ? null : c[f] === true;
    cells[k] = out;
  }
  const since = {};
  if (full && isObj(h.since)) for (const k of HEALTH_CELLS) { const v = clampEdgeTs(h.since[k], rcv); if (v != null) since[k] = v; }
  return { ...(full ? { v: num(h.v), counts: isObj(h.counts) ? numKeys(h.counts, HEALTH_CODES) : null, since } : {}), cells, attention: num(h.attention) ?? 0, at: clampEdgeTs(h.at, rcv) };
}
function detailOf(d, rcv) {
  if (!isObj(d)) return null;
  const psi = isObj(d.psi) ? {
    cpu: numKeys(d.psi.cpu, ['some10', 'some60', 'some300']),
    memory: numKeys(d.psi.memory, ['some10', 'full10', 'full60', 'full300']),
    io: numKeys(d.psi.io, ['some10', 'full10', 'full60', 'full300']),
  } : null;
  return {
    v: num(d.v), at: clampEdgeTs(d.at, rcv), osKind: oneOf(d.osKind, ['linux', 'windows'], null), firstSample: bool(d.firstSample),
    cores: num(d.cores), coresTruncated: bool(d.coresTruncated), procsRunning: num(d.procsRunning), threads: num(d.threads),
    psi,
    disks: list(d.disks, DEV_MAX, (x) => ({ name: str(x.name, 64), busyPct: num(x.busyPct), iops: num(x.iops), awaitMs: num(x.awaitMs), aqu: num(x.aqu), inFlight: num(x.inFlight) })),
    disksTotal: num(d.disksTotal),
    nics: list(d.nics, DEV_MAX, (x) => ({
      iface: str(x.iface, 64), errDelta: num(x.errDelta), dropDelta: num(x.dropDelta), rxErrDelta: num(x.rxErrDelta), txErrDelta: num(x.txErrDelta),
      rxDropDelta: num(x.rxDropDelta), txDropDelta: num(x.txDropDelta), state: str(x.state, 16),
    })),
    nicsTotal: num(d.nicsTotal),
    inodes: Array.isArray(d.inodes) ? list(d.inodes, 16, (x) => ({ mount: str(x.mount, 256), inodes: num(x.inodes), iused: num(x.iused), ifree: num(x.ifree), iusePct: num(x.iusePct) })) : null,
    streak: numKeys(d.streak, ['netErr', 'netDrop', 'oom']),
    sections: sections(d.sections, SECTION_NAMES),
    truncated: bool(d.truncated),
    ...(Array.isArray(d.cutSections) ? { cutSections: strList(d.cutSections, 4, 16) } : {}),
    ...(Array.isArray(d.linesCapped) ? { linesCapped: strList(d.linesCapped, 8, 16) } : {}),
    // v2.929: 점검 소모품(엣지 판정 칸 그대로 — 다시 판정하지 않는다)
    ...(isObj(d.health) ? { health: healthOf(d.health, rcv, { full: true }) } : {}),
  };
}
function tuningOf(tu, rcv) {
  if (!isObj(tu)) return null;
  let sysctl = null;
  if (isObj(tu.sysctl)) { sysctl = {}; for (const k of SYSCTL_KEYS) if (Object.hasOwn(tu.sysctl, k)) sysctl[k] = tu.sysctl[k] == null ? null : str(tu.sysctl[k], 128); }
  return {
    v: num(tu.v), at: clampEdgeTs(tu.at, rcv),
    sysctl,
    hugepages: numKeys(tu.hugepages, ['total', 'free', 'sizeKb']),
    blkq: Array.isArray(tu.blkq) ? list(tu.blkq, DEV_MAX, (x) => ({
      name: str(x.name, 64), scheduler: x.scheduler == null ? null : str(x.scheduler, 32), schedulers: strList(x.schedulers, 8, 32) || [],
      nrRequests: num(x.nrRequests), rotational: x.rotational === true ? true : x.rotational === false ? false : null, readAheadKb: num(x.readAheadKb),
    })) : null,
    blkqTotal: num(tu.blkqTotal),
    irq: isObj(tu.irq) ? { irqbalance: tu.irq.irqbalance == null ? null : str(tu.irq.irqbalance, 32), ...numKeys(tu.irq, ['nicIrqs', 'spreadMin', 'spreadMax', 'cpus']) } : null,
    // v2.923(4단계) — 감지 · 튜닝 사실(엣지 tuning 의 새 필드 · 아는 필드만 · 상한 · 문자열 수치는 수로). 웹·튜닝 판정·용도 매칭이 읽는다.
    ...tuningFactsOf(tu),
    sections: sections(tu.sections, TUNING_SECTION_NAMES),
  };
}
const TUNING_SECTION_NAMES = ['sysctl', 'hugepages', 'blkq', 'irq', 'osrel', 'units', 'ports', 'procs', 'acct', 'kargs', 'softnet', 'netq', 'xfs'];
const NAME_RE = /^[A-Za-z0-9@._:\\-]{1,96}$/;
/** v2.923 — 감지 · 튜닝 사실(엣지 usage.js tuning 의 같은 이름 필드). 목록 · 객체 모양이 아니면 null(못 읽음과 같다 — 지어내지 않는다). */
export function tuningFactsOf(tu) {
  const o = isObj(tu.os) ? {
    id: tu.os.id == null ? null : str(tu.os.id, 32), versionId: tu.os.versionId == null ? null : str(tu.os.versionId, 32), prettyName: tu.os.prettyName == null ? null : str(tu.os.prettyName, 128),
    pageSize: num(tu.os.pageSize), selinux: tu.os.selinux == null ? null : str(tu.os.selinux, 16), removeIpc: oneOf(tu.os.removeIpc, ['yes', 'no'], null),
  } : null;
  const names = (v, max, re) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && re.test(x)).slice(0, max) : null);
  // v2.923(반증 R7): 목록이 null 이면(엣지가 systemctl 실패로 못 읽음) null 그대로 — 빈 목록으로 바꾸면 ‘running 0개’ 를 지어낸다.
  const units = isObj(tu.units) ? { list: names(tu.units.list, 256, NAME_RE), failed: num(tu.units.failed), capped: bool(tu.units.capped), filtered: bool(tu.units.filtered) } : null;
  const ports = isObj(tu.ports) ? { list: (Array.isArray(tu.ports.list) ? tu.ports.list : []).map(num).filter((p) => p != null && Number.isInteger(p) && p >= 1 && p <= 65535).slice(0, 512), capped: bool(tu.ports.capped), filtered: bool(tu.ports.filtered) } : null;
  const procs = isObj(tu.procs) ? { list: names(tu.procs.list, 512, /^[\x21-\x7e][\x20-\x7e]{0,31}$/) || [], capped: bool(tu.procs.capped), filtered: bool(tu.procs.filtered) } : null;
  const accounts = Array.isArray(tu.accounts) ? tu.accounts.filter((a) => DETECT_ACCOUNTS.includes(a)) : null;
  let kargs = null;
  if (isObj(tu.kargs)) { kargs = {}; for (const k of KARG_KEYS) if (Object.hasOwn(tu.kargs, k) && typeof tu.kargs[k] === 'string') kargs[k] = str(tu.kargs[k], 180); }
  const softnet = isObj(tu.softnet) ? numKeys(tu.softnet, ['cpus', 'processed', 'dropped', 'squeezed']) : null;
  const netq = Array.isArray(tu.netq) ? list(tu.netq, 64, (x) => ({ name: str(x.name, 32), txqlen: num(x.txqlen), rxq: num(x.rxq), txq: num(x.txq) })).filter((x) => x.name) : null;
  const xfs = Array.isArray(tu.xfs) ? list(tu.xfs, 32, (x) => ({ mount: str(x.mount, 128), opts: strList(x.opts, 32, 64) || [] })).filter((x) => x.mount) : null;
  return {
    os: o, units, ports, procs, accounts, kargs, softnet, netq, xfs, memTotalKb: num(tu.memTotalKb), cores: num(tu.cores),
    ...(Array.isArray(tu.trimmed) ? { trimmed: strList(tu.trimmed, 8, 16) } : {}),
  };
}
function hwOf(h, rcv) {
  if (!isObj(h)) return null;
  return {
    read: bool(h.read),
    power: isObj(h.power) ? { ...numKeys(h.power, ['watts', 'capWatts', 'capPct']), at: clampEdgeTs(h.power.at, rcv) } : null,
    inletC: num(h.inletC), sensorAt: clampEdgeTs(h.sensorAt, rcv), cpuPct: num(h.cpuPct), inventoryAt: clampEdgeTs(h.inventoryAt, rcv), inventoryStale: bool(h.inventoryStale),
    dimmBad: strList(h.dimmBad, 16, 64), dimmWarn: strList(h.dimmWarn, 16, 64), diskPredicted: strList(h.diskPredicted, 16, 64),
    selCritical: num(h.selCritical), faultCount: num(h.faultCount),
    faults: faultList(h.faults), cpuFaults: faultList(h.cpuFaults), dimmFaults: faultList(h.dimmFaults), diskFaults: faultList(h.diskFaults), nicFaults: faultList(h.nicFaults),
    throttle: null, eccCorrectable: null, smartRealloc: null, nicCrc: num(h.nicCrc),
  };
}

/** 성능 항목 하나(목록·상세 공용 — 상세 필드가 없으면 싣지 않는다). */
/**
 * @param {object} e  엣지 성능 항목
 * @param {number} [rcv] 수신 시각 — 엣지 시각(ts·osAt·idracAt·detail.at·hw.*At)을 이 시각으로 자른다(반증 D3). 자른 원본은 `edgeTsRaw`.
 */
export function sanitizePerfEntry(e, rcv = Date.now()) {
  if (!isObj(e)) return null;
  const key = str(e.key, 256);
  if (!key) return null;   // 키가 없는 항목은 어느 서버 것인지 알 수 없다 — 버리고 센다
  const mm = isObj(e.mismatch) && isObj(e.mismatch.cpu)
    ? { cpu: { os: num(e.mismatch.cpu.os), idrac: num(e.mismatch.cpu.idrac), diffPp: num(e.mismatch.cpu.diffPp), flag: bool(e.mismatch.cpu.flag) } } : null;
  const out = {
    key, ts: clampEdgeTs(e.ts, rcv),
    coverage: oneOf(e.coverage, COVERAGE, 'none'), osAt: clampEdgeTs(e.osAt, rcv), idracAt: clampEdgeTs(e.idracAt, rcv),
    verdict: oneOf(e.verdict, VERDICTS, 'unknown'), focus: oneOf(e.focus, RES, null), line: str(e.line, 300), bottleneckCount: num(e.bottleneckCount),
    read: isObj(e.read) ? numKeys(e.read, ['judged', 'applicable']) : null, rowStale: bool(e.rowStale),
    counts: Object.fromEntries(CODES.map((k) => [k, num(e.counts?.[k]) ?? 0])),
    codes: codesOf(e.codes),
    perResource: Object.fromEntries(RES.map((r) => [r, oneOf(e.perResource?.[r], VERDICTS, 'unknown')])),
    cross: list(e.cross, 4, (c) => ({ id: num(c.id), state: oneOf(c.state, CROSS_STATES, 'missing'), code: str(c.code, 32) })),
    mismatch: mm, firstSample: bool(e.firstSample),
    psiAbsent: bool(e.psiAbsent),   // v2.920 — 보드 ‘PSI 없음’ 수(perfView.buildPerfEntry 와 같은 필드)
    health: healthOf(e.health, rcv, { full: false }),   // v2.929 — 점검 소모품 칸 code · since(보드 · 함대 표)
  };
  // 자른 원본은 따로(루트 규약 — 원본을 버리지 않는다). 자르지 않았으면 싣지 않는다.
  const raw = {};
  for (const k of ['ts', 'osAt', 'idracAt']) { const v = num(e[k]); if (v != null && out[k] !== v) raw[k] = v; }
  if (Object.keys(raw).length) out.edgeTsRaw = raw;
  if (isObj(e.cells)) out.cells = cellsOf(e.cells);
  if (Array.isArray(e.crossDetail)) {
    out.crossDetail = list(e.crossDetail, 4, (c) => ({
      id: num(c.id), title: str(c.title, 120), state: oneOf(c.state, CROSS_STATES, 'missing'), code: str(c.code, 32),
      evidence: strList(c.evidence, 6, 120) || [], ...(Array.isArray(c.devices) ? { devices: strList(c.devices, 8, 64) } : {}),
    }));
  }
  if (isObj(e.values)) out.values = Object.fromEntries(PERF_COL_NAMES.map((c) => [c, num(e.values[c])]));
  if ('detail' in e) out.detail = detailOf(e.detail, rcv);
  if ('tuning' in e) out.tuning = tuningOf(e.tuning, rcv);
  if ('hw' in e) out.hw = hwOf(e.hw, rcv);
  return out;
}

/** 봉투의 성능 필드 묶음 → 정제본 + 버린 원소 수. */
export function sanitizePerfFields(snap, rcv = Date.now()) {
  const arr = Array.isArray(snap?.perf) ? snap.perf : [];
  const perf = arr.slice(0, PERF_LIST_MAX).map((e) => sanitizePerfEntry(e, rcv)).filter(Boolean);
  const pt = isObj(snap?.perfTruncated) ? snap.perfTruncated : null;
  const th = isObj(snap?.perfThresholds) ? Object.fromEntries(Object.keys(PERF_DEFAULTS).map((k) => [k, num(snap.perfThresholds[k])])) : null;
  const cols = Array.isArray(snap?.perfCols)
    ? list(snap.perfCols, 64, (c) => ({ col: str(c.col, 64), res: str(c.res, 8), use: str(c.use, 2), judged: bool(c.judged), unit: str(c.unit, 16), label: str(c.label, 80) }))
    : null;
  return {
    fields: {
      perfVersion: num(snap?.perfVersion), perf, perfThresholds: th, perfCols: cols,
      ...(typeof snap?.perfError === 'string' && snap.perfError ? { perfError: str(snap.perfError, 300) } : {}),
      // v2.919(반증 D2): 엣지가 봉투 크기 상한으로 성능 상세를 뺐다는 표지 — 그대로 전한다(화면이 ‘왜 상세가 없는지’ 를 말한다).
      ...(pt ? { perfTruncated: { reason: str(pt.reason, 32), level: oneOf(pt.level, ['compact', 'dropped'], 'dropped'), bytesBefore: num(pt.bytesBefore), bytesAfter: num(pt.bytesAfter), maxBytes: num(pt.maxBytes), overStill: bool(pt.overStill) } } : {}),
      // v2.929(5단계): 집중 모니터링 요약(진행 중 · 대기 · 최근 24시간 — 상세는 볼 때 당긴다) · 성능 알림 발송 기록(채널 URL 없음).
      ...(Array.isArray(snap?.focusSummary) ? { focusSummary: sanitizeFocusSummary(snap.focusSummary, rcv) } : {}),
      ...(Array.isArray(snap?.perfAlertSent) ? { perfAlertSent: sanitizeAlertSent(snap.perfAlertSent, rcv) } : {}),
      // 6단계 수집 건강(엣지가 매 주기 쓴 값 — 화이트리스트 · 상한 · 시각 clamp). 구버전 엣지는 이 필드가 없다(중앙 화면이 ‘엣지 v… 이상’).
      ...(snap?.collectHealth && typeof snap.collectHealth === 'object' ? { collectHealth: sanitizeCollectHealth(snap.collectHealth, rcv) } : {}),
    },
    dropped: arr.length - perf.length,
  };
}
