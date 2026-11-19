/**
 * bmusage/peakWindow.js — 피크 수집 A 안(v2.922 · 3a): **같은 SSH 세션 안에서** `/proc/stat`·`/proc/diskstats`·`/proc/net/dev` 를
 * 1초 간격으로 N+1 번 읽어, 창(N초) 안 1초 구간의 최대를 피크로 낸다(설계 PROFILES §6 끝 ‘피크 수집 3안’ — A 가 기본).
 *
 *  · 순수 모듈(명령 문자열 · 예산 계산 · 파싱 · 피크 계산) — 수집기(osSsh.js)가 명령을 실행하고 이 모듈이 계산한다.
 *  · ⚠ **1초 샘플은 DB 에 넣지 않는다**(설계 §4.4): computePeaks 는 서버·장치별 `{ peak, at }` 만 돌려주고 표본 배열은 호출부에서 버린다.
 *  · 정의는 5분 평균과 같다: CPU 는 jiffies 비율(idle = idle + iowait — rates.cpuPctFromJiffies 와 같은 규약) · 디스크는 장치 중 최대
 *    (busy = Δio_ticks ÷ Δt · IOPS · await = Δticks ÷ ΔIO(I/O 0 건이면 null) · 대기열 = Δweighted ÷ Δt) · NIC 처리량은 rx+tx 의 장치 중 최대 ·
 *    사용률은 물리 회선만 max(rx,tx) ÷ 속도(속도 모르면 null — linkPct). 리셋(음수 Δ)·너무 짧은 간격은 그 구간을 건너뛴다(0 으로 두지 않는다).
 *  · 시각: 원격 `/proc/uptime`(초, 소수 2자리)로 구간 길이를 재고, 피크 시각은 **이 노드 시계** 기준(명령 시작 직전 시각 + 경과)이다 —
 *    원격 시계와 어긋남을 섞지 않는다. 오차는 명령 전송 지연(RTT/2) 정도(정직 기록).
 *  · 세션 예산(SESSION_BUDGET_MS 50초) 안에서만 돈다: 남은 예산이 모자라면 N 을 줄이고(planWindow) 실제 길이를 행에 적는다(peak_window_s).
 */
import { parseDiskstats, parseNetDev } from './parse/linuxProc.js';
import { linkPct } from './rates.js';

/** 창 한 번의 바깥 비용(명령 왕복·출력 전송 여유) — 예산에서 먼저 뺀다(추정값). */
export const PEAK_OVERHEAD_MS = 3_000;
/** 출력 상한 — 표본마다 디스크 512줄·NIC 256줄 · 31표본이면 약 1.6MB 가 최악(sshExec 4MB 아래). */
export const PEAK_DISK_LINES = 512;
export const PEAK_NET_LINES = 256;
export const PEAK_OUTPUT_MAX = 2 * 1024 * 1024;
const MIN_DT_S = 0.5;

/**
 * 예산 안의 창 길이(초). want 0 이면 끔. 남은 시간에서 바깥 비용을 빼고 1초 단위로 내림 — 2초 미만이면 0(피크라 부를 수 없다).
 * @returns {{windowS:number, reduced:boolean, reason:string}}
 */
export function planWindow({ wantS = 10, remainingMs = 0, overheadMs = PEAK_OVERHEAD_MS } = {}) {
  const want = Math.max(0, Math.floor(Number(wantS) || 0));
  if (!want) return { windowS: 0, reduced: false, reason: 'off' };
  const fit = Math.floor((Number(remainingMs) - overheadMs) / 1000);
  const w = Math.min(want, fit);
  if (w < 2) return { windowS: 0, reduced: true, reason: 'budget' };
  return { windowS: w, reduced: w < want, reason: w < want ? 'budget' : '' };
}

/**
 * 창 명령 — 표본 windowS+1 개(사이 1초). 변수 삽입은 정수 하나(windowS)뿐이다. 장치 줄은 loop·ram·zram·sr 를 셸에서 먼저 뺀다(awk 앵커 패턴).
 * ⚠ LC_ALL=C · 출력 전체 상한(head -c).
 */
export function peakCommand(windowS) {
  const s = Math.max(1, Math.min(60, Math.floor(Number(windowS) || 0)));
  const loop = [
    'i=0',
    `while [ $i -le ${s} ]; do echo "##PK $i \`cut -d' ' -f1 /proc/uptime 2>/dev/null\`"; grep '^cpu ' /proc/stat 2>/dev/null; echo '##PKD'; awk '$3 !~ /^(loop|ram|zram|sr)[0-9]/' /proc/diskstats 2>/dev/null | head -n ${PEAK_DISK_LINES}; echo '##PKN'; tail -n +3 /proc/net/dev 2>/dev/null | head -n ${PEAK_NET_LINES}; i=$((i+1)); if [ $i -le ${s} ]; then sleep 1; fi; done`,
    "echo '##PKEND'",
  ];
  return `export LC_ALL=C; { ${loop.join('; ')}; } | head -c ${PEAK_OUTPUT_MAX}`;
}

/** 창 출력 → 표본 배열(순수). 표지가 깨진 표본(잘림)은 버린다. ##PKEND 가 없으면 truncated. */
export function parsePeakOutput(text, { partitions = false } = {}) {
  const lines = String(text || '').split('\n');
  const samples = [];
  let cur = null; let part = '';
  const flush = () => { if (cur && cur.cpu && Number.isFinite(cur.up)) samples.push({ up: cur.up, cpu: cur.cpu, disks: parseDiskstats(cur.d, { partitions }) || [], nets: parseNetDev(cur.n) || [] }); };
  let ended = false;
  for (const raw of lines) {
    const l = raw.length > 4096 ? raw.slice(0, 4096) : raw;
    if (l.startsWith('##PKEND')) { flush(); cur = null; ended = true; break; }
    const m = /^##PK (\d{1,3}) ([0-9]{1,12}(?:\.[0-9]{1,3})?)\s*$/.exec(l);
    if (m) { flush(); cur = { up: Number(m[2]), cpu: null, d: [], n: [] }; part = 'c'; continue; }
    if (!cur) continue;
    if (l.startsWith('##PKD')) { part = 'd'; continue; }
    if (l.startsWith('##PKN')) { part = 'n'; continue; }
    if (part === 'c' && l.startsWith('cpu ')) {
      const f = l.trim().split(/\s+/).slice(1).map(Number);
      if (f.length >= 5 && f.slice(0, 5).every(Number.isFinite)) {
        const total = f.slice(0, 8).filter(Number.isFinite).reduce((a, b) => a + b, 0);
        cur.cpu = { total, idle: f[3] + f[4], iowait: f[4] };
      }
    } else if (part === 'd') cur.d.push(l);
    else if (part === 'n') cur.n.push(l);
  }
  if (!ended && cur) { /* 잘린 마지막 표본은 버린다(숫자 중간 절단 — v2.919 D1 과 같은 이유) */ }
  return { samples, truncated: !ended };
}

const better = (acc, k, v, at) => { if (v == null || !Number.isFinite(v)) return; if (!acc[k] || v > acc[k].peak) acc[k] = { peak: Math.round(v * 100) / 100, at }; };
const d = (a, b) => (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b) || b < a ? null : b - a);

/**
 * 표본 → 피크(순수). 서버 피크(PEAK_COLS 이름)와 장치별 피크(`disk|sda` · `nic|eth0` → {busy_pct, await_ms, iops, aqu, rx_bps, tx_bps, util_pct}).
 * @param {object} p
 * @param {Array} p.samples      parsePeakOutput().samples
 * @param {number} p.startWall   명령 시작 직전 이 노드 시각(ms)
 * @param {object} [p.nicInfo]   iface → { bitsPerSec, virtual }(같은 주기 ##NETINFO)
 * @returns {{server:object, devices:Map, intervals:number, windowS:number}}
 */
export function computePeaks({ samples = [], startWall = Date.now(), nicInfo = {} } = {}) {
  const server = {}; const devices = new Map();
  let intervals = 0;
  const up0 = samples[0]?.up;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]; const b = samples[i];
    const dt = b.up - a.up;
    if (!(dt >= MIN_DT_S)) continue;
    intervals += 1;
    const at = Math.round(startWall + (b.up - up0) * 1000);
    // CPU
    const dTot = d(a.cpu?.total, b.cpu?.total); const dIdle = d(a.cpu?.idle, b.cpu?.idle); const dIow = d(a.cpu?.iowait, b.cpu?.iowait);
    if (dTot && dIdle != null && dTot >= dIdle) better(server, 'cpu_pct', Math.min(100, ((dTot - dIdle) / dTot) * 100), at);
    if (dTot && dIow != null) better(server, 'cpu_iowait_pct', Math.min(100, (dIow / dTot) * 100), at);
    // 디스크(장치마다 → 서버 대표값 최대)
    for (const x of b.disks) {
      const p = a.disks.find((y) => y.name === x.name);
      if (!p) continue;
      const dev = devices.get(`disk|${x.name}`) || {};
      const ms = dt * 1000;
      const tk = d(p.ioTicksMs, x.ioTicksMs);
      const busy = tk == null ? null : Math.min(100, (tk / ms) * 100);
      const ios = (d(p.reads, x.reads) ?? NaN) + (d(p.writes, x.writes) ?? NaN);
      const iops = Number.isFinite(ios) ? ios / dt : null;
      const rt = (d(p.readTicksMs, x.readTicksMs) ?? NaN) + (d(p.writeTicksMs, x.writeTicksMs) ?? NaN);
      const aw = Number.isFinite(ios) && ios > 0 && Number.isFinite(rt) ? rt / ios : null;
      const wq = d(p.weightedTicksMs, x.weightedTicksMs);
      const aqu = wq == null ? null : wq / ms;
      better(dev, 'busy_pct', busy, at); better(dev, 'iops', iops, at); better(dev, 'await_ms', aw, at); better(dev, 'aqu', aqu, at);
      devices.set(`disk|${x.name}`, dev);
      better(server, 'disk_busy_pct', busy, at); better(server, 'disk_iops', iops, at); better(server, 'disk_await_ms', aw, at); better(server, 'disk_aqu', aqu, at);
    }
    // NIC
    for (const x of b.nets) {
      const p = a.nets.find((y) => y.iface === x.iface);
      if (!p) continue;
      const rx = d(p.rxBytes, x.rxBytes); const tx = d(p.txBytes, x.txBytes);
      const rxs = rx == null ? null : rx / dt; const txs = tx == null ? null : tx / dt;
      const info = nicInfo[x.iface] || {};
      if (rxs != null && txs != null) better(server, 'net_bps', rxs + txs, at);
      if (info.virtual) continue;   // 가상 인터페이스는 사용률·장치 피크 대상이 아니다(기존 규칙)
      const util = rxs == null || txs == null ? null : linkPct(Math.max(rxs, txs), info.bitsPerSec);
      better(server, 'net_pct', util, at);
      const dev = devices.get(`nic|${x.iface}`) || {};
      better(dev, 'rx_bps', rxs, at); better(dev, 'tx_bps', txs, at); better(dev, 'util_pct', util, at);
      devices.set(`nic|${x.iface}`, dev);
    }
  }
  return { server, devices, intervals, windowS: intervals };
}

/**
 * 피크 출처(행의 peak_src) — 창 피크가 있으면 window10(A 안 이름 — 실제 길이는 peak_window_s), 샘플러 파일이 검증됐으면 sampler,
 *   둘 다 없고 PSI 가 있으면 psi(C 안: 피크 값은 없고 PSI avg10 이 포화의 보조), 아니면 none.
 */
export function peakSrcOf({ windowS = 0, sampler = null, psiRead = false } = {}) {
  if (sampler?.state === 'ok') return 'sampler';
  if (windowS >= 1) return 'window10';
  if (psiRead) return 'psi';
  return 'none';
}
