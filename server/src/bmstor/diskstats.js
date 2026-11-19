/**
 * bmstor/diskstats.js — 베어메탈 서버 디스크 I/O 표본(순수, v2.915 — 설계 docs/design/bm-san-compare §4.1).
 *
 * df 와 같은 SSH 세션에서 **상수 명령 하나**를 더 보낸다(입력이 들어가는 자리가 없다 — 주입 면):
 *   cat /proc/uptime; cat /proc/diskstats; sleep N; echo __DVC_IO_SEP__; cat /proc/uptime; cat /proc/diskstats
 * 두 번 읽은 누적 카운터의 차이 ÷ 경과(uptime 차 — 서버 쪽 시계라 왕복 지연과 무관)로 **그 순간의 속도**를 만든다.
 *
 * 규칙(설계 §3):
 *  · **통짜 디스크만** 센다(sd* · hd* · vd* · xvd* · nvme*n* · mmcblk*). dm-* · md* · 파티션은 같은 I/O 의 중복이라 더하면 두 배가 된다.
 *  · 섹터는 diskstats 규약대로 **항상 512 바이트**다(장치 섹터 크기와 무관 — 커널 문서 Documentation/admin-guide/iostats.rst).
 *  · 카운터가 줄었으면(재부팅 · 장치 교체) 그 장치는 이번 표본에서 뺀다. 0 으로 세지 않는다.
 *  · 못 읽으면 io 는 null 이고 ioError 가 사유를 말한다 — df 가 성공했으면 서버를 오류로 만들지 않는다(용량은 살린다).
 *  · 바쁨(%) = Δio_ticks(ms) ÷ 경과(ms) 의 **장치별 최댓값**(가장 바쁜 디스크 — iostat %util 과 같은 뜻 · 평균이 아니다).
 *  · v2.962(비교 세트): IOPS = Δ(읽기+쓰기 완료 횟수) ÷ 경과 · 응답 시간(ms) = Δ(읽기+쓰기 소요 ms) ÷ Δ(읽기+쓰기 횟수) — iostat await 와 같은 정의이고
 *    디스크 전체의 **I/O 가중 평균**이다(디스크별 평균의 평균이 아니다). I/O 가 0 이면 응답 시간은 null(0 ms 가 아니다 — 모름).
 *  · v2.971(사용자 질문 2026-11-11 "전송속도 피크/평균이 그룹 서버 IO 를 합친 거야?" — 화면에서 피크 < 평균을 보고 찾은 결함):
 *    수집 사이 **구간 평균은 디스크별 누적 카운터로** 낸다(`counters.disks` — 이름 → [rd_sectors, wr_sectors, io_ms, rd_ios, wr_ios, rw_ticks]).
 *    v2.970 까지는 디스크 **합계** 카운터 하나만 기억해, 한 번 목록에서 빠졌다 돌아온 디스크의 평생 누적이 그 구간에 한꺼번에 일어난 것으로
 *    계산됐다(재현: 2초 표본 128 KB/s · 구간 평균 667 GB/s) · 구간 평균 바쁨은 **모든 디스크 io_ms 합** ÷ 경과(디스크 20개 × 3% → 60%)였다.
 *    이제 두 수집 모두에 있는 디스크만 비교하고(카운터가 준 디스크는 그 구간에서 뺀다) 바쁨은 디스크별 최댓값(2초 표본과 같은 뜻)이다.
 *
 * 입력 크기는 먼저 자른다(설계 규칙 — 외부 출력에 앵커 없는 반복 금지): 줄 4,000개 · 1MB 상한.
 */
import { numOrNull } from '../util/numOrNull.js';

export const WHOLE_DISK_RE = /^(sd[a-z]+|hd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;
export const IO_SEP = '__DVC_IO_SEP__';
export const SECTOR_BYTES = 512;
const MAX_LINES = 4000;
const MAX_TEXT = 1024 * 1024;
const SAMPLE_SEC_MIN = 1;
const SAMPLE_SEC_MAX = 10;
const SAMPLE_SEC_DEFAULT = 2;
/** 디스크별 누적 카운터 맵 상한 — 넘으면 맵을 싣지 않는다(구간 평균은 그때 ‘모름’). 엣지 회신 크기 · 중앙 정제 상한과 같은 값. */
export const DISK_MAP_MAX = 1024;
/** /proc/diskstats 의 시간 열(rd_ticks · wr_ticks · io_ticks — ms)은 커널이 unsigned int 로 찍어 2^32 ms(약 49.7일)에서 0 으로 돈다
 *  (섹터 · 완료 횟수는 unsigned long). 바쁜 디스크의 rd/wr_ticks 는 지연의 합이라 벽시계보다 빨리 쌓여 며칠 만에도 돈다(반증 F4). */
const U32 = 2 ** 32;
/** 시간 열 차분 — 줄었으면 2^32 넘침으로 보고 보정(최대 times 번 — rw_ticks 는 rd+wr 두 열의 합이라 둘 다 돌 수 있다). 보정해도 음수면 null. */
export function tickDelta(cur, prev, times = 1) {
  let d = cur - prev;
  for (let k = 0; d < 0 && k < times; k++) d += U32;
  return d >= 0 && Number.isFinite(d) ? d : null;
}

/** 표본 간격(초) — env BMSTOR_IO_SAMPLE_SEC. 0 = 끔(df 만). 빈 값·범위 밖은 기본 2. */
export function ioSampleSec(env = process.env) {
  const raw = env.BMSTOR_IO_SAMPLE_SEC;
  if (raw === undefined || raw === null || String(raw).trim() === '') return SAMPLE_SEC_DEFAULT;
  const n = numOrNull(raw);
  if (n == null) return SAMPLE_SEC_DEFAULT;
  if (n <= 0) return 0;
  return Math.max(SAMPLE_SEC_MIN, Math.min(SAMPLE_SEC_MAX, Math.round(n)));
}

/** 상수 명령 — 숫자 하나만 끼운다(정수로 굳힌 뒤). */
export function ioSampleCommand(sec) {
  const s = Math.max(SAMPLE_SEC_MIN, Math.min(SAMPLE_SEC_MAX, Math.round(Number(sec) || SAMPLE_SEC_DEFAULT)));
  return `cat /proc/uptime; cat /proc/diskstats; sleep ${s}; echo ${IO_SEP}; cat /proc/uptime; cat /proc/diskstats`;
}

/**
 * 한 구간(uptime 한 줄 + diskstats 여러 줄) 파싱.
 * diskstats 열: major minor name rd_ios rd_merges rd_sectors rd_ticks wr_ios wr_merges wr_sectors wr_ticks in_flight io_ticks …
 *   (0      1     2    3      4         5          6        7      8         9          10       11        12)
 * @returns {{ uptimeSec:number|null, devices: Map<string,{rdSectors:number, wrSectors:number, ioMs:number, rdIos:number|null, wrIos:number|null, rwTicks:number|null}> }}
 */
export function parseDiskstats(text) {
  const t = String(text || '');
  const lines = (t.length > MAX_TEXT ? t.slice(0, MAX_TEXT) : t).split('\n', MAX_LINES);
  let uptimeSec = null;
  const devices = new Map();
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const cols = line.split(/\s+/, 16);
    // /proc/uptime: '12345.67 98765.43' — 숫자 두 개뿐인 줄
    if (uptimeSec === null && cols.length === 2 && /^\d+(\.\d+)?$/.test(cols[0]) && /^\d+(\.\d+)?$/.test(cols[1])) {
      uptimeSec = Number(cols[0]);
      continue;
    }
    if (cols.length < 14) continue;
    const name = cols[2];
    if (!WHOLE_DISK_RE.test(name)) continue;
    const rdSectors = numOrNull(cols[5]); const wrSectors = numOrNull(cols[9]); const ioMs = numOrNull(cols[12]);
    if (rdSectors == null || wrSectors == null || ioMs == null) continue;
    // v2.962: 완료 횟수 · 소요 ms — 셋 다 읽혀야 IOPS · 응답 시간을 낸다(하나라도 없으면 null — 용량 · 처리량은 그대로).
    const rdIos = numOrNull(cols[3]); const wrIos = numOrNull(cols[7]);
    const rdTicks = numOrNull(cols[6]); const wrTicks = numOrNull(cols[10]);
    const okIo = rdIos != null && wrIos != null && rdTicks != null && wrTicks != null;
    devices.set(name, { rdSectors, wrSectors, ioMs, rdIos: okIo ? rdIos : null, wrIos: okIo ? wrIos : null, rwTicks: okIo ? rdTicks + wrTicks : null });
  }
  return { uptimeSec, devices };
}

/** 명령 출력 전체(구분자로 나뉜 두 구간) → { before, after } 또는 { error }. */
export function parseIoSample(stdout) {
  const s = String(stdout || '');
  const i = s.indexOf(IO_SEP);
  if (i < 0) return { error: 'I/O 표본 출력에 구분자가 없습니다(명령이 중간에 끊김)' };
  const before = parseDiskstats(s.slice(0, i));
  const after = parseDiskstats(s.slice(i + IO_SEP.length));
  if (before.uptimeSec == null || after.uptimeSec == null) return { error: '/proc/uptime 을 읽지 못했습니다' };
  return { before, after };
}

/**
 * 두 구간의 차이 → 속도. 경과는 서버 uptime 차(초). 카운터가 준 장치는 뺀다.
 * @returns {{ ok:true, io:object } | { ok:false, error:string }}
 */
export function ioRate(before, after) {
  const elapsed = Number(after?.uptimeSec) - Number(before?.uptimeSec);
  if (!Number.isFinite(elapsed) || elapsed <= 0) return { ok: false, error: '표본 간격이 0 이하입니다(uptime 역행 — 재부팅?)' };
  let rd = 0; let wr = 0; let busyPct = null; let busiestDev = ''; let disks = 0; let skipped = 0;   // 바쁨을 잰 디스크가 없으면 null(0 이 아니다)
  let cRd = 0; let cWr = 0; let cIo = 0;
  // v2.962: I/O 횟수 · 소요 ms — 통짜 디스크 **전부**가 그 열을 읽었을 때만 합한다(일부만이면 부분 합 — null).
  let dRdIos = 0; let dWrIos = 0; let dTicks = 0; let cRdIos = 0; let cWrIos = 0; let cTicks = 0; let ioCols = true;
  for (const [name, a] of after.devices) {
    const b = before.devices.get(name);
    if (!b) { skipped += 1; continue; }
    const dRd = a.rdSectors - b.rdSectors; const dWr = a.wrSectors - b.wrSectors;
    if (dRd < 0 || dWr < 0) { skipped += 1; continue; }   // 섹터 역행 = 장치 교체 · 재연결 — 이 장치는 이번 표본에서 뺀다
    // v2.971(반증 F4): io_ms 만 줄었으면 32비트 넘침 — 보정한다(예전에는 처리량까지 통째로 뺐다). 보정 값이 경과보다 크면 바쁨만 모름.
    const dIoRaw = tickDelta(a.ioMs, b.ioMs);
    const dIo = dIoRaw != null && dIoRaw <= elapsed * 1000 * 1.05 + 1000 ? dIoRaw : null;
    disks += 1;
    rd += dRd; wr += dWr;
    cRd += a.rdSectors; cWr += a.wrSectors; cIo += a.ioMs;
    if (dIo != null) {
      const busy = Math.min(100, (dIo / (elapsed * 1000)) * 100);
      if (busyPct == null || busy > busyPct) { busyPct = busy; busiestDev = name; }
    }
    if (a.rdIos == null || b.rdIos == null || a.rwTicks == null || b.rwTicks == null) { ioCols = false; continue; }
    const r1 = a.rdIos - b.rdIos; const w1 = a.wrIos - b.wrIos; const t1 = tickDelta(a.rwTicks, b.rwTicks, 2);
    if (r1 < 0 || w1 < 0 || t1 == null) { ioCols = false; continue; }
    dRdIos += r1; dWrIos += w1; dTicks += t1;
    cRdIos += a.rdIos; cWrIos += a.wrIos; cTicks += a.rwTicks;
  }
  if (!disks) return { ok: false, error: after.devices.size ? '모든 디스크의 카운터가 역행했습니다(재부팅 직후?)' : '/proc/diskstats 에 통짜 디스크(sd · nvme · vd)가 없습니다' };
  // v2.971: 디스크별 누적 카운터 — 2초 표본에서 뺀 디스크(앞 구간에 없던 · 2초 사이 역행)도 **'after' 시점의 누적 상태**로 싣는다.
  //   수집 사이 구간 평균은 두 수집에 모두 있는 디스크끼리만 뺀다(intervalAvg) — 합계 하나로 빼면 디스크 구성이 바뀐 구간이 튄다.
  let diskMap = null;
  if (after.devices.size <= DISK_MAP_MAX) {
    diskMap = {};
    for (const [name, a] of after.devices) diskMap[name] = [a.rdSectors, a.wrSectors, a.ioMs, a.rdIos, a.wrIos, a.rwTicks];
  }
  const readBps = Math.round((rd * SECTOR_BYTES) / elapsed);
  const writeBps = Math.round((wr * SECTOR_BYTES) / elapsed);
  const ios = dRdIos + dWrIos;
  const r2 = (x) => Math.round(x * 100) / 100;
  return {
    ok: true,
    io: {
      readBps, writeBps, totalBps: readBps + writeBps,
      busyPct: busyPct == null ? null : Math.round(busyPct * 10) / 10, busiestDev, disks, skipped,
      sampleMs: Math.round(elapsed * 1000),
      // v2.962: IOPS · 응답 시간(I/O 가중 평균 ms). 열을 못 읽었으면 null · I/O 가 0 이면 응답 시간 null(모름 — 0 ms 아님).
      readIops: ioCols ? r2(dRdIos / elapsed) : null, writeIops: ioCols ? r2(dWrIos / elapsed) : null, iops: ioCols ? r2(ios / elapsed) : null,
      latMs: ioCols && ios > 0 ? r2(dTicks / ios) : null,
      // 누적 카운터(통짜 디스크 합) — 중앙 I/O 시계열 DB 가 수집 사이의 **구간 평균**을 차분으로 낸다(설계 §4.5).
      counters: { rdSectors: cRd, wrSectors: cWr, ioMs: cIo, uptimeSec: Number(after.uptimeSec),
        ...(ioCols ? { rdIos: cRdIos, wrIos: cWrIos, rwTicks: cTicks } : {}),
        ...(diskMap ? { disks: diskMap } : {}) },
    },
  };
}

/** SSH exec 결과({ code, stdout, stderr }) → { io } | { io:null, ioError }. */
export function ioResultFromExec(r) {
  const stderr = String(r?.stderr || '');
  const stdout = String(r?.stdout || '');
  if (/diskstats.*(No such file|not found|없습니다)/i.test(stderr) || (!stdout.includes('__DVC_IO_SEP__') && /No such file/i.test(stderr))) {
    return { io: null, ioError: '/proc/diskstats 없음(Linux 가 아닙니다) — 용량만 수집' };
  }
  const p = parseIoSample(stdout);
  if (p.error) return { io: null, ioError: `${p.error}${stderr.trim() ? ` — ${stderr.trim().split('\n')[0].slice(0, 120)}` : ''}` };
  const rate = ioRate(p.before, p.after);
  return rate.ok ? { io: rate.io, ioError: null } : { io: null, ioError: rate.error };
}

/** counters.disks 가 쓸 수 있는 맵인가(객체 · 배열 아님 · 상한 이내). */
const isDiskMap = (m) => !!m && typeof m === 'object' && !Array.isArray(m) && Object.keys(m).length <= DISK_MAP_MAX;
const fin = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * 수집 사이의 **구간 평균**(순수 — 중앙 I/O 시계열 DB 가 쓴다). prev·cur 는 { ts, counters:{ rdSectors, wrSectors, ioMs, uptimeSec, rdIos?, wrIos?, rwTicks?, disks? } }.
 * 경과는 uptime 차(둘 다 있고 늘었을 때) 아니면 ts 차. 공백이 maxGapMs 를 넘거나 uptime 이 줄었으면 null(모름 — 0 아님).
 *
 * v2.971 — 기준은 **디스크별 카운터**(`counters.disks`, basis 'disk'):
 *  · 두 수집 **모두에 있는** 디스크끼리만 뺀다. 섹터 · io_ms 중 하나라도 준 디스크(교체 · 재연결 — 카운터가 0 부터)는 그 구간에서 뺀다.
 *  · 처리량 · IOPS = 그 디스크들의 합 ÷ 경과 · 바쁨 = **디스크별 Δio_ms ÷ 경과의 최댓값**(2초 표본 busyPct 와 같은 뜻 — 가장 바쁜 디스크).
 *  · IOPS · 응답 시간 재료(dIos · dTicks)는 비교한 디스크 **전부**에 그 열이 있고 줄지 않았을 때만(부분 합 금지 — 아니면 셋 다 null).
 *  · 비교할 디스크가 하나도 없으면 null.
 * 한쪽만 맵이 있으면(업그레이드 직후 첫 구간 · 맵 상한 초과 전환) **null** — 합계와 디스크별을 섞어 빼지 않는다(한 구간만 비운다).
 * 두 쪽 모두 맵이 없으면(구버전 엣지 회신) 예전처럼 합계로 빼되(basis 'total') **바쁨 평균은 null** — 합계 io_ms 로는 가장 바쁜 디스크를 알 수 없다
 *   (v2.970 까지 낸 ‘모든 디스크 합’ 은 디스크 수만큼 부풀었다). 합계 기준은 디스크 구성이 바뀐 구간이 튈 수 있다 — 엣지를 올리면 사라진다.
 * @returns {{ avgReadBps:number, avgWriteBps:number, avgBusyPct:number|null, avgIops:number|null, dIos:number|null, dTicks:number|null, basis:'disk'|'total', disks:number|null }|null}
 */
export function intervalAvg(prev, cur, { maxGapMs } = {}) {
  const pc = prev?.counters; const cc = cur?.counters;
  if (!pc || !cc) return null;
  const dTs = Number(cur.ts) - Number(prev.ts);
  if (!Number.isFinite(dTs) || dTs <= 0) return null;
  if (Number.isFinite(Number(maxGapMs)) && Number(maxGapMs) > 0 && dTs > Number(maxGapMs)) return null;
  const pu = numOrNull(pc.uptimeSec); const cu = numOrNull(cc.uptimeSec);
  if (pu != null && cu != null && cu <= pu) return null;             // 재부팅
  // v2.971(반증 F5): 연속 재부팅 — 앞 수집의 가동 시간이 짧았으면 재부팅 뒤에도 cu > pu 일 수 있다. 가동 시간은 벽시계와 같은 속도로 늘므로
  //   uptime 차가 수집 시각 차보다 한참 작으면 그 사이에 재부팅이 있었다(여유 = 120초 또는 25% — 수집 시각은 중앙 수신 시각이라 엣지 지연이 낀다).
  if (pu != null && cu != null && (cu - pu) < dTs / 1000 - Math.max(120, dTs / 4000)) return null;
  const sec = pu != null && cu != null ? cu - pu : dTs / 1000;
  if (!(sec > 0)) return null;
  const pMap = isDiskMap(pc.disks); const cMap = isDiskMap(cc.disks);
  if (pMap !== cMap) return null;                                     // 합계 ↔ 디스크별 전환 구간 — 섞어 빼지 않는다
  if (pMap) return perDiskAvg(pc.disks, cc.disks, sec);
  return totalsAvg(pc, cc, sec);
}

function perDiskAvg(pd, cd, sec) {
  let rd = 0; let wr = 0; let busy = null; let n = 0;
  let ios = 0; let ticks = 0; let ioOk = true;
  for (const name of Object.keys(cd)) {
    if (!Object.prototype.hasOwnProperty.call(pd, name)) continue;   // 이번에 새로 보인 디스크 — 비교할 앞 값이 없다
    const c = cd[name]; const p = pd[name];
    if (!Array.isArray(c) || !Array.isArray(p)) continue;
    if (![c[0], c[1], c[2], p[0], p[1], p[2]].every(fin)) continue;
    const d0 = c[0] - p[0]; const d1 = c[1] - p[1];
    if (d0 < 0 || d1 < 0) continue;   // 섹터가 준 디스크(교체 · 재연결 — 카운터가 0 부터)는 뺀다
    n += 1; rd += d0; wr += d1;
    // io_ms 만 줄었으면 32비트 넘침 — 보정(반증 F4). 보정 값이 경과보다 크면 이 디스크는 바쁨에서만 뺀다(처리량은 그대로).
    const d2 = tickDelta(c[2], p[2]);
    if (d2 != null && d2 <= sec * 1000 * 1.05 + 1000) {
      const b = Math.min(100, (d2 / (sec * 1000)) * 100);
      busy = busy == null ? b : Math.max(busy, b);
    }
    if (!ioOk) continue;
    const dt = fin(c[5]) && fin(p[5]) ? tickDelta(c[5], p[5], 2) : null;   // rw_ticks = rd_ticks + wr_ticks(둘 다 32비트)
    if (![c[3], c[4], p[3], p[4]].every(fin) || c[3] < p[3] || c[4] < p[4] || dt == null) { ioOk = false; continue; }
    ios += (c[3] - p[3]) + (c[4] - p[4]); ticks += dt;
  }
  if (!n) return null;
  return {
    avgReadBps: Math.round((rd * SECTOR_BYTES) / sec),
    avgWriteBps: Math.round((wr * SECTOR_BYTES) / sec),
    avgBusyPct: busy == null ? null : Math.round(busy * 10) / 10,
    avgIops: ioOk ? Math.round((ios / sec) * 100) / 100 : null, dIos: ioOk ? ios : null, dTicks: ioOk ? ticks : null,
    basis: 'disk', disks: n,
  };
}

function totalsAvg(pc, cc, sec) {
  // v2.971(반증 F1): 합계 카운터는 그 수집의 2초 표본이 비교한 디스크만 더한 값이다 — 디스크 수가 다르면 두 합계는 다른 디스크 집합이라
  //   빼면 튄다(한 번 빠졌다 돌아온 디스크의 평생 누적). 수를 알면 같을 때만 뺀다(같은 수로 바뀐 경우까지는 못 잡는다 — 엣지를 올리면 디스크별).
  const pn = numOrNull(pc.nDisks); const cn = numOrNull(cc.nDisks);
  if (pn != null && cn != null && pn !== cn) return null;
  const dRd = Number(cc.rdSectors) - Number(pc.rdSectors);
  const dWr = Number(cc.wrSectors) - Number(pc.wrSectors);
  const dIo = Number(cc.ioMs) - Number(pc.ioMs);
  if (![dRd, dWr, dIo].every(Number.isFinite) || dRd < 0 || dWr < 0 || dIo < 0) return null;
  // v2.962: I/O 횟수 · 소요 ms — 두 쪽 모두 있고 줄지 않았을 때만(없으면 null · 처리량 평균은 그대로 낸다).
  let avgIops = null; let dIos = null; let dTicks = null;
  const pIo = [numOrNull(pc.rdIos), numOrNull(pc.wrIos), numOrNull(pc.rwTicks)];
  const cIo = [numOrNull(cc.rdIos), numOrNull(cc.wrIos), numOrNull(cc.rwTicks)];
  if (pIo.every((v) => v != null) && cIo.every((v) => v != null)) {
    const di = (cIo[0] - pIo[0]) + (cIo[1] - pIo[1]); const dt = cIo[2] - pIo[2];
    if (di >= 0 && dt >= 0 && cIo[0] >= pIo[0] && cIo[1] >= pIo[1]) { dIos = di; dTicks = dt; avgIops = Math.round((di / sec) * 100) / 100; }
  }
  return {
    avgReadBps: Math.round((dRd * SECTOR_BYTES) / sec),
    avgWriteBps: Math.round((dWr * SECTOR_BYTES) / sec),
    avgBusyPct: null,   // v2.971: 합계 io_ms ÷ 경과는 ‘가장 바쁜 디스크’ 가 아니다(디스크 수만큼 부푼다) — 모름
    avgIops, dIos, dTicks, basis: 'total', disks: null,
  };
}
