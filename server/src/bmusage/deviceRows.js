/**
 * bmusage/deviceRows.js — 한 서버 한 주기의 **장치별 이력 행**(v2.922 · 3a · 설계 §4.4 · PROFILES §9·§12). 순수 모듈.
 *
 *  · 대상: 물리 디스크 · dm/md(parseDiskstats 의 isWholeDisk — loop·ram·zram·sr·파티션 제외) · 물리 NIC · bond(##NETINFO 넷째 필드 1 —
 *    `device` 링크가 있거나 bonding 마스터. tun/tap·veth·bridge·vlan 은 virtual 이라 뺀다). 파티션 I/O 는 **서버 옵트인**(store.partitionIo)일 때만
 *    `part` 표시가 붙은 디스크 행으로 들어온다(병합·캐시 때문에 디스크 합과 다를 수 있다 — 화면 몫).
 *  · 서버당 장치 수 상한(store.deviceMax, 기본 32) — 디스크(물리 → md → dm → 파티션) · NIC(속도 아는 물리 → 나머지) 순으로 자르고 뺀 수를 `over` 로.
 *  · 마운트(공간·inode)는 원시 5분이 없다 — 일 1회 롤업 행만(mountRows).
 *  · 피크는 A 안 창의 장치별 최대(`<열>_peak`·`_peak_at`) — 창이 없으면 null(0 이 아니다).
 */
import { numOrNull } from '../util/numOrNull.js';
import { blkqRank } from './parse/linuxProc.js';
import { DEVICE_PEAK_COLS } from './perfCols.js';

const n = numOrNull;
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

/**
 * @param {object} p
 * @param {string} p.key  서버 키
 * @param {number} p.ts   표본 시각(행 ts 와 같다)
 * @param {Array}  p.disks  buildPerf 장치별 디스크(name·busyPct·awaitMs·rIops·wIops·iops·rBps·wBps·aqu·inFlight·part)
 * @param {Array}  p.nics   usage.js 인터페이스(iface·rxBps·txBps·pct·bitsPerSec·state·virtual) + 오류·드롭(errDelta·dropDelta)
 * @param {object} [p.peaks]  computePeaks().devices(`disk|sda` → { busy_pct:{peak,at}, … })
 * @param {number} [p.deviceMax]
 * @returns {{rows:Array, over:number, total:number}}
 */
export function buildDeviceRows({ key, ts, disks = [], nics = [], peaks = {}, deviceMax = 32 } = {}) {
  const peakOf = (id) => {
    const pk = peaks?.[id] || {};
    return Object.fromEntries(DEVICE_PEAK_COLS.flatMap((c) => [[`${c}_peak`, n(pk[c]?.peak)], [`${c}_peak_at`, n(pk[c]?.peak) == null ? null : n(pk[c]?.at)]]));
  };
  const dRows = disks.filter((d) => d && d.name)
    .map((d, i) => ({ d, i })).sort((a, b) => ((a.d.part ? 3 : blkqRank(a.d.name)) - (b.d.part ? 3 : blkqRank(b.d.name))) || a.i - b.i)
    .map(({ d }) => ({
      key, ts, kind: 'disk', dev: String(d.name).slice(0, 64),
      busy_pct: n(d.busyPct), await_ms: n(d.awaitMs), r_iops: n(d.rIops), w_iops: n(d.wIops), iops: n(d.iops),
      r_bps: n(d.rBps), w_bps: n(d.wBps), aqu: n(d.aqu), inflight: n(d.inFlight), err_delta: null,
      rx_bps: null, tx_bps: null, util_pct: null, drop_delta: null, speed_bps: null, oper: null,
      ...peakOf(`disk|${d.name}`), info: d.part ? 'part' : null,
    }));
  const nRows = nics.filter((x) => x && x.iface && !x.virtual)
    .map((x, i) => ({ x, i })).sort((a, b) => ((a.x.bitsPerSec ? 0 : 1) - (b.x.bitsPerSec ? 0 : 1)) || a.i - b.i)
    .map(({ x }) => ({
      key, ts, kind: 'nic', dev: String(x.iface).slice(0, 64),
      busy_pct: null, await_ms: null, r_iops: null, w_iops: null, iops: null, r_bps: null, w_bps: null, aqu: null, inflight: null,
      err_delta: n(x.errDelta), rx_bps: r1(n(x.rxBps)), tx_bps: r1(n(x.txBps)), util_pct: n(x.pct), drop_delta: n(x.dropDelta),
      speed_bps: n(x.bitsPerSec), oper: x.state ? String(x.state).slice(0, 16) : null,
      ...peakOf(`nic|${x.iface}`), info: null,
    }));
  const all = [...dRows, ...nRows];
  const cap = Math.max(1, Math.floor(Number(deviceMax) || 32));
  // 종류를 번갈아 자르지 않는다 — 디스크 몫과 NIC 몫을 비율대로(한쪽이 다 차지하지 않게): 각 종류 최소 절반 보장.
  let rows = all;
  if (all.length > cap) {
    const half = Math.ceil(cap / 2);
    const dn = Math.min(dRows.length, Math.max(half, cap - nRows.length));
    rows = [...dRows.slice(0, dn), ...nRows.slice(0, cap - dn)];
  }
  return { rows, over: all.length - rows.length, total: all.length };
}

/** 마운트 일 롤업 행 — 등록 마운트(df)와 inode(df -i)를 마운트 이름으로 잇는다. */
export function buildMountRows({ key, ts, mounts = [], inodes = [] } = {}) {
  const ino = new Map((inodes || []).map((x) => [x.mount, x]));
  return (mounts || []).filter((m) => m && m.mount).slice(0, 64).map((m) => ({
    key, ts, mount: String(m.mount).slice(0, 256), used_pct: n(m.usedPct), inode_pct: n(ino.get(m.mount)?.iusePct),
    size_bytes: n(m.totalBytes), used_bytes: n(m.usedBytes),
  }));
}
