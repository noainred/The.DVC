/**
 * focusmon/rates.js — 두 프레임의 누적 카운터 차이로 **표본**을 만든다(순수 · 판정 코어는 이것 하나 — 중앙 · 엣지가 같은 파일을 쓴다 · v2.976).
 *
 * ── 디스크는 iostat -x -m 과 같은 이름 · 같은 식(사용자 요청 2026-11-11 — iostat 출력 화면을 보내며 "이 내용도 반영") ─────────────
 *   rrqm/s · wrqm/s = Δ병합 / Δt          r/s · w/s = Δ완료 / Δt          rMB/s · wMB/s = Δ섹터 × 512 / 2^20 / Δt
 *   avgrq-sz = Δ(읽기+쓰기 섹터) / Δ(읽기+쓰기 완료)        avgqu-sz = Δ가중 대기 ms / (Δt × 1000)
 *   await = Δ(읽기 ms + 쓰기 ms) / Δ(완료 합)   r_await · w_await = Δ그 방향 ms / Δ그 방향 완료     svctm = Δio_ticks / Δ완료 합     %util = Δio_ticks / (Δt × 10)
 *  ⚠ iostat 과 일부러 다른 두 곳(사용자 화면에서 확인한 경우):
 *   ① 그 구간에 끝난 요청이 0건이면 지연 · 요청 크기 · 서비스 시간은 **null**(iostat 은 0.00 을 찍는다 — 0 ms 로 읽히면 안 된다).
 *   ② 끝난 요청이 0건인데 걸린 요청(in-flight)이 있고 사용률이 100% 면 `stuck`(응답 없음) — iostat 줄은 조용하지만 가장 나쁜 상태다.
 * ── 그 밖 ───────────────────────────────────────────────────────────────────────────────────────────────
 *  · Δt 는 대상 서버의 uptime 차이(초) — 대상 시계가 바뀌어도 흔들리지 않는다. Δt ≤ 0 이거나 카운터가 줄었으면(재부팅 · 넘침) 그 칸은 null.
 *  · CPU 사용률 = 1 − (Δidle + Δiowait) / Δ합 — I/O 대기는 따로 한 칸(‘wait’ 의 다른 뜻 — 설계 §10 ⑥ 둘 다 둔다).
 *  · 메모리 사용률 = (전체 − MemAvailable) / 전체 — 캐시로 쓰는 메모리는 ‘사용’ 에 넣지 않는다.
 *  · 인터페이스 사용률 = max(수신, 송신) / 링크 속도. 속도를 모르면 null(처리량만). 본딩 속도는 802.3ad · balance 계열은 올라온 구성원 합,
 *    active-backup 은 쓰는 구성원 하나. 구성원 속도를 하나라도 모르면 본딩이 스스로 말한 속도, 그것도 없으면 null.
 *  · 전체 디스크 = **물리 디스크만**(파티션 · LVM · 멀티패스 dm 은 같은 입출력을 다시 보는 것). 지연은 요청 수 가중 · 사용률은 최고.
 *  · 못 읽은 값은 null 이다. 0 이 아니다.
 */

export const IOSTAT_COLS = Object.freeze(['rrqm', 'wrqm', 'r', 'w', 'rMB', 'wMB', 'rqsz', 'qu', 'await', 'rAwait', 'wAwait', 'svctm', 'util']);
export const IOSTAT_NAME = Object.freeze({
  rrqm: 'rrqm/s', wrqm: 'wrqm/s', r: 'r/s', w: 'w/s', rMB: 'rMB/s', wMB: 'wMB/s', rqsz: 'avgrq-sz', qu: 'avgqu-sz',
  await: 'await', rAwait: 'r_await', wAwait: 'w_await', svctm: 'svctm', util: '%util',
});
const C = Object.freeze(Object.fromEntries(IOSTAT_COLS.map((c, i) => [c, i])));
export const TOP_N = 30;

const fin = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const delta = (a, b) => (a == null || b == null || b < a ? null : b - a);

/** 디스크 장치 종류 — lsblk 가 있으면 그 TYPE, 없으면 이름으로 짐작(sda1 은 sda 가 있을 때 파티션). */
export function classifyDisk(name, blk, names) {
  const b = blk?.[name];
  if (b) {
    const t = b.type;
    if (t === 'disk') return 'disk';
    if (t === 'part') return 'part';
    if (t === 'lvm') return 'lvm';
    if (t === 'mpath') return 'mpath';
    if (/^raid/.test(t)) return 'raid';
    return 'other';
  }
  if (/^dm-\d+$/.test(name)) return 'lvm';
  if (/^md\d+$/.test(name)) return 'raid';
  const nv = /^(nvme\d+n\d+)p\d+$/.exec(name);
  if (nv) return names.has(nv[1]) ? 'part' : 'disk';
  const p = /^([a-z]+)\d+$/.exec(name);
  if (p && names.has(p[1])) return 'part';
  return 'disk';
}
function guessParent(name, names) {
  const nv = /^(nvme\d+n\d+)p\d+$/.exec(name);
  if (nv && names.has(nv[1])) return nv[1];
  const p = /^([a-z]+)\d+$/.exec(name);
  return p && names.has(p[1]) ? p[1] : null;
}

/** 한 장치의 iostat 13칸 + 걸린 요청(순간값). a · b = parseDiskstats 의 11칸. */
export function iostatOf(a, b, dt) {
  if (!a || !b || !(dt > 0)) return null;
  const d = a.map((x, i) => (i === 8 ? null : delta(x, b[i])));
  const [rIos, rMer, rSec, rTk, wIos, wMer, wSec, wTk, , ioTk, tiq] = d;
  const ios = rIos != null && wIos != null ? rIos + wIos : null;
  const v = new Array(IOSTAT_COLS.length).fill(null);
  v[C.rrqm] = rMer == null ? null : rMer / dt;
  v[C.wrqm] = wMer == null ? null : wMer / dt;
  v[C.r] = rIos == null ? null : rIos / dt;
  v[C.w] = wIos == null ? null : wIos / dt;
  v[C.rMB] = rSec == null ? null : (rSec * 512) / 1048576 / dt;
  v[C.wMB] = wSec == null ? null : (wSec * 512) / 1048576 / dt;
  v[C.rqsz] = ios > 0 && rSec != null && wSec != null ? (rSec + wSec) / ios : null;
  v[C.qu] = tiq == null ? null : tiq / (dt * 1000);
  v[C.await] = ios > 0 && rTk != null && wTk != null ? (rTk + wTk) / ios : null;
  v[C.rAwait] = rIos > 0 && rTk != null ? rTk / rIos : null;
  v[C.wAwait] = wIos > 0 && wTk != null ? wTk / wIos : null;
  v[C.svctm] = ios > 0 && ioTk != null ? ioTk / ios : null;
  v[C.util] = ioTk == null ? null : Math.min(100, ioTk / (dt * 10));
  return { v: v.map((x) => r2(fin(x))), inflight: fin(b[8]), ios };
}

/** 장치 여러 개의 iostat 을 한 줄로(전체 디스크 · 구간 평균 공용). rows = [{v, w}] — w 는 가중(초 단위 길이, 기본 1). */
export function aggregateIostat(rows = []) {
  const out = new Array(IOSTAT_COLS.length).fill(null);
  const valid = rows.filter((x) => Array.isArray(x?.v));
  if (!valid.length) return out;
  const sum = (c) => { let s = 0; let any = false; for (const x of valid) { const y = x.v[C[c]]; if (y != null) { s += y; any = true; } } return any ? s : null; };
  const wavg = (c, wcol) => {
    let n = 0; let s = 0;
    for (const x of valid) { const y = x.v[C[c]]; const w = wcol(x.v); if (y != null && w != null && w > 0) { s += y * w; n += w; } }
    return n > 0 ? s / n : null;
  };
  for (const c of ['rrqm', 'wrqm', 'r', 'w', 'rMB', 'wMB', 'qu']) out[C[c]] = sum(c);
  const both = (v) => (v[C.r] != null && v[C.w] != null ? v[C.r] + v[C.w] : null);
  out[C.rAwait] = wavg('rAwait', (v) => v[C.r]);
  out[C.wAwait] = wavg('wAwait', (v) => v[C.w]);
  out[C.await] = wavg('await', both);
  out[C.svctm] = wavg('svctm', both);
  const ios = out[C.r] != null && out[C.w] != null ? out[C.r] + out[C.w] : null;
  out[C.rqsz] = ios > 0 && out[C.rMB] != null && out[C.wMB] != null ? ((out[C.rMB] + out[C.wMB]) * 2048) / ios : null;
  let u = null; for (const x of valid) { const y = x.v[C.util]; if (y != null && (u == null || y > u)) u = y; }
  out[C.util] = u;
  return out.map((x) => r2(fin(x)));
}

function cpuOf(a, b) {
  if (!a || !b) return null;
  const d = a.map((x, i) => delta(x, b[i]));
  if (d.some((x) => x == null)) return null;
  const tot = d.reduce((s, x) => s + x, 0);
  if (!(tot > 0)) return null;
  const [usr, nice, sys, idle, iow, irq, sirq, stl] = d;
  return {
    pct: r1(100 * (1 - (idle + iow) / tot)), usr: r1((100 * (usr + nice)) / tot), sys: r1((100 * sys) / tot),
    iow: r1((100 * iow) / tot), stl: r1((100 * stl) / tot), irq: r1((100 * (irq + sirq)) / tot),
  };
}

function bondSpeed(name, topo) {
  const t = topo[name];
  if (!t) return null;
  const mem = (t.slaves || []).map((m) => topo[m]).filter(Boolean);
  if (t.bondMode === 'active-backup') {
    const act = t.active ? topo[t.active] : null;
    return act?.speed ?? t.speed ?? null;
  }
  const up = (t.slaves || []).filter((m) => topo[m]?.state === 'up');
  if (up.length && up.every((m) => topo[m]?.speed != null)) return up.reduce((s, m) => s + topo[m].speed, 0);
  if (!mem.length) return t.speed ?? null;
  return t.speed ?? null;
}

/**
 * 표본 하나.
 * @param {object} prev  앞 프레임 원시(frameToRaw)
 * @param {object} cur   이번 프레임 원시
 * @param {object} ctx   { topo: 마지막 NETTOPO, blk: 마지막 BLK }
 */
export function computeSample(prev, cur, ctx = {}) {
  const dt = prev?.up != null && cur?.up != null ? Math.round((cur.up - prev.up) * 1000) / 1000 : null;
  const okDt = dt != null && dt > 0 && dt < 3600;
  const topo = ctx.topo || {}; const blk = ctx.blk || null;

  // CPU
  const cpuAll = okDt ? cpuOf(prev?.stat?.all, cur?.stat?.all) : null;
  let cores = [];
  if (cpuAll && Array.isArray(cur?.stat?.cores)) cores = cur.stat.cores.map((c, i) => cpuOf(prev?.stat?.cores?.[i], c)?.pct ?? null);

  // 메모리(순간값)
  const m = cur?.mem;
  const mem = m && m.total > 0 && m.avail != null ? {
    pct: r1((100 * Math.max(0, m.total - m.avail)) / m.total), total: m.total, used: Math.max(0, m.total - m.avail), avail: m.avail,
    bc: m.buffCache, free: m.free, swT: m.swapTotal, swU: m.swapTotal != null && m.swapFree != null ? Math.max(0, m.swapTotal - m.swapFree) : null,
    dirty: m.dirty, slab: m.slab, availSource: m.availSource,
  } : null;

  // 네트워크
  const net = [];
  if (okDt && cur?.net && prev?.net) {
    for (const [n, c] of Object.entries(cur.net)) {
      const p = prev.net[n];
      const t = topo[n] || {};
      const rxB = p ? delta(p.rxB, c.rxB) : null; const txB = p ? delta(p.txB, c.txB) : null;
      const kind = t.bondMode || (t.slaves && t.slaves.length && !t.phys) ? 'bond' : t.phys ? 'phys' : 'virt';
      const sp = kind === 'bond' ? bondSpeed(n, topo) : (t.speed ?? null);
      const rx = rxB == null ? null : (rxB * 8) / dt; const tx = txB == null ? null : (txB * 8) / dt;
      const u = sp > 0 && rx != null && tx != null ? Math.min(999, (100 * Math.max(rx, tx)) / (sp * 1e6)) : null;
      const sumD = (a, b) => (a == null || b == null ? null : a + b);
      net.push({
        n, k: kind, sp: sp ?? null, st: t.state || null, m: t.master || null, md: t.bondMode || null, mem: t.slaves || [], act: t.active || null,
        rx: rx == null ? null : Math.round(rx), tx: tx == null ? null : Math.round(tx), u: r1(u),
        er: p ? sumD(delta(p.rxErr, c.rxErr), delta(p.txErr, c.txErr)) : null,
        dr: p ? sumD(delta(p.rxDrop, c.rxDrop), delta(p.txDrop, c.txDrop)) : null,
      });
    }
  }

  // 디스크
  const dsk = [];
  if (okDt && cur?.disk && prev?.disk) {
    const names = new Set(Object.keys(cur.disk));
    for (const [n, b] of Object.entries(cur.disk)) {
      const io = iostatOf(prev.disk[n], b, dt);
      if (!io) continue;
      const k = classifyDisk(n, blk, names);
      const bi = blk?.[n];
      const util = io.v[C.util];
      const stuck = (io.ios === 0) && (io.inflight > 0) && util != null && util >= 99.5;
      dsk.push({ n, dn: bi?.name && bi.name !== n ? bi.name : null, k, p: bi?.parent ?? (bi ? null : guessParent(n, names)), mp: bi?.mount || '', sz: bi?.size ?? null,
        v: io.v, fl: io.inflight, ...(stuck ? { stuck: true } : {}) });
    }
  }
  const phys = dsk.filter((d) => d.k === 'disk');
  const total = phys.length ? aggregateIostat(phys) : null;

  return {
    dt: okDt ? dt : null,
    cpu: cpuAll ? { ...cpuAll, cores } : null,
    load: cur?.load?.load || null, run: cur?.stat?.running ?? null, blk: cur?.stat?.blocked ?? null, thr: cur?.load?.threads ?? null,
    mem, net, dsk, dtot: total, nPhys: phys.length,
    ...(cur?.truncated?.length ? { truncated: cur.truncated } : {}),
  };
}

/**
 * 프로세스 상위 N(CPU) — 두 PROC 구획의 누적 CPU 시간 차이. 같은 pid 라도 시작 시각이 다르면 다른 프로세스(재사용)라 버린다.
 * v2.981(프로세스 세부 정보): 사용자/커널 몫 · 부모(pid · 이름) · 서비스 · nice · 상태 · 가상 메모리 · major fault/s · 디스크 대기 % · 읽기/쓰기 MB/s ·
 *   같은 이름 수 · 시작 tick(sk — 같은 프로세스 판정)을 함께 싣는다. **못 읽은 값은 null**(0 아님):
 *   · 읽기/쓰기 — /proc/<pid>/io 를 못 읽은 프로세스(그 계정 · root 가 아님)
 *   · 디스크 대기 — 지연 집계가 꺼진 서버(dacct false) · 모름(null) · 칸 없는 커널
 *   · 옛 줄(새 칸 없음)의 새 값 전부
 * @param {Array} prevList  앞 PROC(parseProc)
 * @param {Array} curList   이번 PROC
 * @param {object} o        { dt(uptime 차이 초), tck, page, ncpu, up(이번 uptime), users: Map(pid → 사용자), units: Map(pid → 서비스),
 *                            io: Map(pid → {r,w}) 이번 · prevIo 앞, dacct: 지연 집계 켜짐(true|false|null),
 *                            usersUp · unitsUp: 사용자 · 서비스 맵을 읽은 프레임의 uptime(초) — 그 뒤에 시작한 프로세스에는 붙이지 않는다(반증 F6:
 *                            30초 묵은 맵이라 그 사이 pid 를 다시 쓴 새 프로세스에 예전 계정 · 서비스가 붙었다 → '모름') }
 * 반증 F10: 새 칸 가운데 null 은 싣지 않는다(DB 묶음 크기 — 읽는 쪽은 모두 `?? null`).
 */
const NEW_KEYS = Object.freeze(['us', 'sy', 'pp', 'pc', 'sv', 'ns', 'ni', 'st', 'vsz', 'mf', 'io', 'rb', 'wb', 'sk']);
export function topProcs(prevList, curList, { dt, tck, page, ncpu, up, users, units, io, prevIo, dacct = null, usersUp = null, unitsUp = null } = {}) {
  if (!Array.isArray(prevList) || !Array.isArray(curList) || !(dt > 0) || !(tck > 0)) return null;
  const before = new Map(prevList.map((p) => [p.pid, p]));
  const rows = [];
  for (const p of curList) {
    const q = before.get(p.pid);
    if (!q || q.start !== p.start) continue;
    const d = delta(q.ticks, p.ticks);
    if (d == null) continue;
    rows.push({ p, q, cpu: (d / tck / dt) * 100 });
  }
  rows.sort((a, b) => b.cpu - a.cpu || a.p.pid - b.p.pid);
  const pg = page > 0 ? page : 4096;
  const top = rows.slice(0, TOP_N);
  // 부모 이름 · 같은 이름 수는 상위에 든 것만 본다(전체 목록을 한 번 훑는다)
  const commOf = new Map(); const sameCount = new Map();
  if (top.length) {
    const want = new Set(top.map((x) => x.p.ppid).filter((v) => v != null && v > 0));
    const names = new Set(top.map((x) => x.p.comm));
    for (const p of curList) {
      if (want.has(p.pid)) commOf.set(p.pid, p.comm);
      if (names.has(p.comm)) sameCount.set(p.comm, (sameCount.get(p.comm) || 0) + 1);
    }
  }
  const pct = (a, b) => { const x = delta(a, b); return x == null ? null : r1((x / tck / dt) * 100); };
  const startedAfter = (mapUp, p) => mapUp != null && p.start != null && p.start / tck > mapUp;
  const out = top.map(({ p, q, cpu }) => {
    const i1 = io?.get?.(p.pid); const i0 = prevIo?.get?.(p.pid);
    const rd = i1 && i0 ? delta(i0.r, i1.r) : null; const wr = i1 && i0 ? delta(i0.w, i1.w) : null;
    const row = {
      pid: p.pid, c: p.comm, u: startedAfter(usersUp, p) ? null : (users?.get?.(p.pid) || null), cpu: r1(cpu),
      sh: ncpu > 0 ? r2(cpu / ncpu) : null,
      rss: p.rss == null ? null : r1((p.rss * pg) / 1048576), th: p.thr ?? null,
      et: up != null && p.start != null ? Math.max(0, Math.round(up - p.start / tck)) : null,
      us: pct(q.ut, p.ut), sy: pct(q.st, p.st),
      pp: p.ppid ?? null, pc: p.ppid > 0 ? (commOf.get(p.ppid) ?? null) : null,
      sv: startedAfter(unitsUp, p) ? null : (units?.get?.(p.pid) || null), ns: sameCount.get(p.comm) ?? null,
      ni: p.ni ?? null, st: p.state ?? null, vsz: p.vsz == null ? null : r1(p.vsz / 1048576),
      mf: (() => { const x = delta(q.mf, p.mf); return x == null ? null : r1(x / dt); })(),
      io: dacct === true ? pct(q.bio, p.bio) : null,
      rb: rd == null ? null : r2(rd / dt / 1048576), wb: wr == null ? null : r2(wr / dt / 1048576),
      sk: p.start ?? null,
    };
    for (const k of NEW_KEYS) if (row[k] == null) delete row[k];
    return row;
  });
  return { n: curList.length, top: out, da: dacct === true ? true : dacct === false ? false : null };
}

/** 개요 카드 요약(서버 1대 · 표본 1개) — 화면 · 비교 · 정렬이 같은 값을 쓴다. */
export function summaryOf(s) {
  if (!s) return null;
  const bonds = (s.net || []).filter((x) => x.k === 'bond');
  const pool = bonds.length ? bonds : (s.net || []).filter((x) => x.k === 'phys' && x.st === 'up');
  let best = null;
  for (const x of pool) { if (x.u != null && (best == null || x.u > best.u)) best = x; }
  if (!best) for (const x of pool) { const v = Math.max(x.rx ?? -1, x.tx ?? -1); if (v >= 0 && (best == null || v > Math.max(best.rx ?? -1, best.tx ?? -1))) best = x; }
  let busy = null;
  for (const d of (s.dsk || []).filter((x) => x.k === 'disk')) { const u = d.v[C.util]; if (u != null && (busy == null || u > busy.v[C.util])) busy = d; }
  return {
    cpu: s.cpu?.pct ?? null, mem: s.mem?.pct ?? null,
    net: best?.u ?? null, netIf: best?.n ?? null, netRx: best?.rx ?? null, netTx: best?.tx ?? null,
    disk: busy ? busy.v[C.util] : null, diskDev: busy?.n ?? null,
    wAwait: s.dtot ? s.dtot[C.wAwait] : null, rAwait: s.dtot ? s.dtot[C.rAwait] : null,
    // v2.992 카드 아래 줄을 사용자가 고른다(사용자 요청 '빨간 부분을 선택해서 볼 수 있게 — Disk write/read · Network in/out · disk wait 등') —
    //   물리 디스크 합(aggregateIostat: 횟수 · 처리량 · 대기열은 합) · CPU I/O 대기 · steal · 부하 평균(1분) · 코어 수 · 스왑. 못 읽은 값은 null(0 아님).
    rMB: s.dtot ? s.dtot[C.rMB] : null, wMB: s.dtot ? s.dtot[C.wMB] : null, rIo: s.dtot ? s.dtot[C.r] : null, wIo: s.dtot ? s.dtot[C.w] : null, qu: s.dtot ? s.dtot[C.qu] : null,
    iow: s.cpu?.iow ?? null, stl: s.cpu?.stl ?? null,
    load1: Array.isArray(s.load) ? (s.load[0] ?? null) : null, cores: Array.isArray(s.cpu?.cores) && s.cpu.cores.length ? s.cpu.cores.length : null,
    swU: s.mem?.swU ?? null, swT: s.mem?.swT ?? null,
    stuck: (s.dsk || []).some((d) => d.stuck && d.k === 'disk'),
  };
}

/**
 * 한 장치의 **시간 평균**(구간 평균) — 표본마다의 iostat 13칸을 요청 수로 가중해 다시 계산한다(표본 값의 단순 평균이 아니다).
 * 횟수 · 처리량 · 대기열 · 사용률은 평균, 지연은 그 방향 요청 수 가중, 요청 크기 · 서비스 시간은 전체 요청 수 가중.
 * 끝난 요청이 하나도 없으면 지연은 null(0 이 아니다).
 */
export function timeAverageIostat(rows = [], weights = null) {
  // v2.979(반증 1): 표본마다 1표가 아니라 **표본이 덮는 시간(ms)으로 가중**한다 — 보는 화면이 열리면 수집 주기가 10초 → 2초로 바뀌어
  //   한 구간 안에 성긴 표본과 촘촘한 표본이 섞이고, 표본 평균은 촘촘한 최근 몇 분 쪽으로 치우쳤다(재현: 실제 %util 23.3 → 화면 50).
  //   weights 가 없으면 모두 1(예전 동작). 지연 · 요청 크기 · 서비스 시간은 요청 수(= 초당 횟수 × 시간)로 가중한다.
  const valid = [];
  rows.forEach((v, i) => { if (Array.isArray(v)) { const w = weights ? Number(weights[i]) : 1; if (Number.isFinite(w) && w > 0) valid.push([v, w]); } });
  const out = new Array(IOSTAT_COLS.length).fill(null);
  if (!valid.length) return out;
  const mean = (c) => { let s = 0; let n = 0; for (const [v, w] of valid) { const y = v[C[c]]; if (y != null) { s += y * w; n += w; } } return n ? s / n : null; };
  const wavg = (c, f) => { let s = 0; let n = 0; for (const [v, w] of valid) { const y = v[C[c]]; const ff = f(v); if (y != null && ff != null && ff > 0) { s += y * ff * w; n += ff * w; } } return n > 0 ? s / n : null; };
  for (const c of ['rrqm', 'wrqm', 'r', 'w', 'rMB', 'wMB', 'qu', 'util']) out[C[c]] = mean(c);
  const both = (v) => (v[C.r] != null && v[C.w] != null ? v[C.r] + v[C.w] : null);
  out[C.rAwait] = wavg('rAwait', (v) => v[C.r]);
  out[C.wAwait] = wavg('wAwait', (v) => v[C.w]);
  out[C.await] = wavg('await', both);
  out[C.rqsz] = wavg('rqsz', both);
  out[C.svctm] = wavg('svctm', both);
  return out.map((x) => r2(fin(x)));
}
