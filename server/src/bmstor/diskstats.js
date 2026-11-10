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
 * @returns {{ uptimeSec:number|null, devices: Map<string,{rdSectors:number, wrSectors:number, ioMs:number}> }}
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
    devices.set(name, { rdSectors, wrSectors, ioMs });
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
  let rd = 0; let wr = 0; let busyPct = 0; let busiestDev = ''; let disks = 0; let skipped = 0;
  let cRd = 0; let cWr = 0; let cIo = 0;
  for (const [name, a] of after.devices) {
    const b = before.devices.get(name);
    if (!b) { skipped += 1; continue; }
    const dRd = a.rdSectors - b.rdSectors; const dWr = a.wrSectors - b.wrSectors; const dIo = a.ioMs - b.ioMs;
    if (dRd < 0 || dWr < 0 || dIo < 0) { skipped += 1; continue; }   // 카운터 역행 — 이 장치는 이번 표본에서 뺀다
    disks += 1;
    rd += dRd; wr += dWr;
    cRd += a.rdSectors; cWr += a.wrSectors; cIo += a.ioMs;
    const busy = Math.min(100, (dIo / (elapsed * 1000)) * 100);
    if (busy > busyPct || !busiestDev) { busyPct = busy; busiestDev = name; }
  }
  if (!disks) return { ok: false, error: after.devices.size ? '모든 디스크의 카운터가 역행했습니다(재부팅 직후?)' : '/proc/diskstats 에 통짜 디스크(sd · nvme · vd)가 없습니다' };
  const readBps = Math.round((rd * SECTOR_BYTES) / elapsed);
  const writeBps = Math.round((wr * SECTOR_BYTES) / elapsed);
  return {
    ok: true,
    io: {
      readBps, writeBps, totalBps: readBps + writeBps,
      busyPct: Math.round(busyPct * 10) / 10, busiestDev, disks, skipped,
      sampleMs: Math.round(elapsed * 1000),
      // 누적 카운터(통짜 디스크 합) — 중앙 I/O 시계열 DB 가 수집 사이의 **구간 평균**을 차분으로 낸다(설계 §4.5).
      counters: { rdSectors: cRd, wrSectors: cWr, ioMs: cIo, uptimeSec: Number(after.uptimeSec) },
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

/**
 * 수집 사이의 **구간 평균**(순수 — 중앙 I/O 시계열 DB 가 쓴다). prev·cur 는 { ts, counters:{rdSectors,wrSectors,ioMs,uptimeSec} }.
 * 경과는 uptime 차(둘 다 있고 늘었을 때) 아니면 ts 차. 공백이 maxGapMs 를 넘거나 카운터·uptime 이 줄었으면 null(모름 — 0 아님).
 * @returns {{ avgReadBps:number, avgWriteBps:number, avgBusyPct:number }|null}
 */
export function intervalAvg(prev, cur, { maxGapMs } = {}) {
  const pc = prev?.counters; const cc = cur?.counters;
  if (!pc || !cc) return null;
  const dTs = Number(cur.ts) - Number(prev.ts);
  if (!Number.isFinite(dTs) || dTs <= 0) return null;
  if (Number.isFinite(Number(maxGapMs)) && Number(maxGapMs) > 0 && dTs > Number(maxGapMs)) return null;
  const pu = numOrNull(pc.uptimeSec); const cu = numOrNull(cc.uptimeSec);
  if (pu != null && cu != null && cu <= pu) return null;             // 재부팅
  const dRd = Number(cc.rdSectors) - Number(pc.rdSectors);
  const dWr = Number(cc.wrSectors) - Number(pc.wrSectors);
  const dIo = Number(cc.ioMs) - Number(pc.ioMs);
  if (![dRd, dWr, dIo].every(Number.isFinite) || dRd < 0 || dWr < 0 || dIo < 0) return null;
  const sec = pu != null && cu != null ? cu - pu : dTs / 1000;
  if (!(sec > 0)) return null;
  return {
    avgReadBps: Math.round((dRd * SECTOR_BYTES) / sec),
    avgWriteBps: Math.round((dWr * SECTOR_BYTES) / sec),
    avgBusyPct: Math.round(Math.min(100, (dIo / (sec * 1000)) * 100) * 10) / 10,
  };
}
