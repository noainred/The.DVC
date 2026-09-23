/**
 * bmusage/parse/linuxProc.js — Linux `/proc`·`/sys` 출력 파서(순수, v2.550).
 *
 * 한 SSH 세션에서 **명령 1회**로 전부 받아 온 뒤 구획 표지로 쪼개 파싱한다
 * (`##STAT` / `##MEM` / `##DISK` / `##NET` / `##NETINFO` / `##FC` / `##DF` / `##TICK`).
 * 왕복을 늘리지 않는 것이 설계다 — 200대 × 항목 7개면 왕복만 1,400회가 된다.
 *
 * ⚠ **읽지 못한 항목은 만들지 않는다**(v2.525 Unity 규약) — 0 을 지어내면 화면이 '부하 없음' 이라는
 *   거짓을 말한다. 파서는 `null` 을 돌려주고 호출부가 '확인 불가' 로 다룬다.
 * ⚠ 누적 카운터는 여기서 비율로 바꾸지 않는다 — **원시 누적값을 그대로** 돌려주고 `rates.js` 가
 *   이전 표본과 비교한다(첫 표본·리셋을 null 로 다루는 판정이 한 곳에 있어야 한다).
 */
const num = (v) => {
  /*
   * ⚠⚠ **빈 문자열을 먼저 걸러낸다** — `Number('') === 0` 이고 `Number.isFinite(0)` 이 참이라
   *   그냥 두면 **'모름' 이 0 으로 둔갑**한다(v2.525 `Number(null)===0` 규약의 변형).
   *   v2.550 초판이 실제로 그랬고 자체 테스트가 잡았다 — `DISK=D:|3|2000398934016|`(여유 공간 미상)이
   *   `usedPct: 100`(디스크 가득)으로 계산됐다. **오류 없이 틀린 값**이라 화면은 정상처럼 보인다.
   */
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** 구획 표지로 쪼갠다. 표지가 없으면 빈 객체 — '형식 미인식' 이다. */
export function splitSections(text) {
  const out = {};
  let cur = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^##([A-Z]+)\s*$/.exec(line.trim());
    if (m) { cur = m[1]; out[cur] = []; continue; }
    if (cur) out[cur].push(line);
  }
  return out;
}

/**
 * `/proc/stat` 의 `cpu` 집계 줄 → 누적 jiffies.
 * 형식: `cpu  user nice system idle iowait irq softirq steal guest guest_nice` — guest 는 user 에 이미 포함(합에서 뺀다)
 * ⚠ **idle 은 `idle + iowait`** 다 — iowait 를 busy 로 세면 디스크 대기 중인 서버가 CPU 100% 로 보인다.
 */
export function parseProcStat(lines = []) {
  for (const l of lines) {
    const m = /^cpu\s+(.*)$/.exec(String(l).trim());
    if (!m) continue;
    const f = m[1].trim().split(/\s+/).map(num);
    if (f.length < 4 || f.slice(0, 4).some((x) => x == null)) return null;
    // v2.590 F11: guest·guest_nice(9·10번째)는 커널이 user·nice 에 **이미 포함**해 누적한다(account_guest_time) —
    // 10개를 다 더하면 KVM 을 돌리는 물리 서버에서 guest 시간을 두 번 세어 CPU 가 과대(실측 정답 50% → 64.3%).
    // procps top·mpstat 처럼 user~steal(앞 8개)만 합한다.
    const total = f.slice(0, 8).reduce((a, b) => a + (b ?? 0), 0);
    const idle = (f[3] ?? 0) + (f[4] ?? 0);
    return { total, idle };
  }
  return null;
}

/** `/proc/meminfo` → 바이트. `MemAvailable` 이 있으면 그것을 쓴다(free+buff/cache 보다 정확하다). */
export function parseMemInfo(lines = []) {
  const kv = {};
  for (const l of lines) {
    const m = /^([A-Za-z_()]+):\s+(\d+)(?:\s+kB)?\s*$/.exec(String(l).trim());
    if (m) kv[m[1]] = Number(m[2]) * 1024;
  }
  const total = kv.MemTotal ?? null;
  // MemAvailable 은 커널 3.14+ — 없으면 MemFree + Buffers + Cached 로 되돌려 쓰고 그 사실을 밝힌다.
  let avail = kv.MemAvailable ?? null;
  let availSource = 'MemAvailable';
  if (avail == null && kv.MemFree != null) {
    avail = kv.MemFree + (kv.Buffers ?? 0) + (kv.Cached ?? 0);
    availSource = 'MemFree+Buffers+Cached';
  }
  if (total == null || avail == null) return null;
  const used = Math.max(0, total - avail);
  return {
    totalBytes: total, availBytes: avail, usedBytes: used,
    usedPct: total > 0 ? Math.round((used / total) * 1000) / 10 : null,
    availSource,
    swapTotalBytes: kv.SwapTotal ?? null,
    swapUsedBytes: (kv.SwapTotal != null && kv.SwapFree != null) ? Math.max(0, kv.SwapTotal - kv.SwapFree) : null,
  };
}

/** 파티션·가상 블록장치를 제외할지 — 물리 디스크(와 dm/md)만 본다. */
export function isWholeDisk(name, present = new Set()) {
  const n = String(name || '');
  if (!n) return false;
  if (/^(loop|ram|zram|sr)\d*$/.test(n)) return false;
  if (/^dm-\d+$/.test(n) || /^md\d+$/.test(n) || /^nbd\d+$/.test(n)) return true;
  // nvme0n1p1 → 부모 nvme0n1 이 목록에 있으면 파티션이다.
  const nvme = /^(nvme\d+n\d+)p\d+$/.exec(n);
  if (nvme) return !present.has(nvme[1]);
  // sda1 / vdb2 → 숫자를 떼어낸 이름이 목록에 있으면 파티션이다.
  const part = /^([a-z]+)\d+$/.exec(n);
  if (part) return !present.has(part[1]);
  return true;
}

/**
 * `/proc/diskstats` → 장치별 누적. 필드(1-기준): 1 major · 2 minor · 3 name ·
 * 6 rd_sectors · 10 wr_sectors · **13 io_ticks(ms)**.
 * 섹터는 항상 512B 다(커널 고정 — 장치 논리 섹터 크기와 무관).
 */
export function parseDiskstats(lines = []) {
  const rows = [];
  const names = new Set();
  for (const l of lines) {
    const f = String(l).trim().split(/\s+/);
    if (f.length < 13) continue;
    if (num(f[0]) == null || num(f[1]) == null) continue;
    names.add(f[2]);
    rows.push(f);
  }
  if (!rows.length) return null;
  const out = [];
  for (const f of rows) {
    const name = f[2];
    if (!isWholeDisk(name, names)) continue;
    const rdSec = num(f[5]); const wrSec = num(f[9]); const ticks = num(f[12]);
    if (rdSec == null && wrSec == null && ticks == null) continue;
    out.push({
      name,
      readBytes: rdSec == null ? null : rdSec * 512,
      writeBytes: wrSec == null ? null : wrSec * 512,
      ioTicksMs: ticks,
    });
  }
  return out.length ? out : null;
}

/**
 * `/proc/net/dev` → 인터페이스별 누적 바이트.
 * 형식: `  eth0: rxBytes rxPkts rxErrs rxDrop rxFifo rxFrame rxComp rxMulti txBytes txPkts …`
 * ⚠ `lo` 는 제외한다(자기 자신 트래픽은 회선 사용률이 아니다).
 */
export function parseNetDev(lines = []) {
  const out = [];
  for (const l of lines) {
    const m = /^\s*([^:\s]+):\s*(.*)$/.exec(String(l));
    if (!m) continue;
    const iface = m[1];
    if (iface === 'lo') continue;
    const f = m[2].trim().split(/\s+/).map(num);
    if (f.length < 9) continue;
    out.push({ iface, rxBytes: f[0], txBytes: f[8], rxErrs: f[2] ?? null, txErrs: f[10] ?? null });
  }
  return out.length ? out : null;
}

/**
 * `##NETINFO` — `<iface> <speedMbit|-1|빈값> <operstate>` 한 줄씩.
 * ⚠ **`-1`·빈 값은 '속도를 모른다'** 다(0 이 아니다). 그러면 사용률(%)을 내지 않고 처리량만 낸다.
 */
export function parseNetInfo(lines = []) {
  const map = {};
  for (const l of lines) {
    const f = String(l).trim().split(/\s+/);
    if (f.length < 2 || !f[0]) continue;
    const mbit = num(f[1]);
    map[f[0]] = {
      bitsPerSec: mbit != null && mbit > 0 ? mbit * 1e6 : null,
      state: f[2] || '',
    };
  }
  return map;
}

/**
 * `##FC` — HBA 한 대당 `<host> <port_state> <speed 원문> <tx_words> <rx_words>`.
 * ⚠ `tx_words`·`rx_words` 는 **4바이트 단위**이고 16진수(`0x…`)로 나올 수 있다.
 * ⚠ 속도 원문은 `16 Gbit` / `unknown` / `not negotiated` 등 — **'unknown' 을 0 으로 바꾸지 말 것**.
 */
export function parseFcHosts(lines = []) {
  const out = [];
  for (const l of lines) {
    const s = String(l).trim();
    if (!s) continue;
    const f = s.split(/\|/);                       // 속도 원문에 공백이 있어 `|` 로 구분해 받는다
    if (f.length < 5) continue;
    const [host, state, speedRaw, txw, rxw] = f.map((x) => String(x).trim());
    const gb = /([\d.]+)\s*gbit/i.exec(speedRaw);
    out.push({
      host,
      state: state || '',
      speedRaw: speedRaw || '',
      bitsPerSec: gb ? Number(gb[1]) * 1e9 : null,   // 못 읽으면 null — 퍼센트를 내지 않는다
      txBytes: hexOrDec(txw) == null ? null : hexOrDec(txw) * 4,
      rxBytes: hexOrDec(rxw) == null ? null : hexOrDec(rxw) * 4,
    });
  }
  return out.length ? out : null;
}

function hexOrDec(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (/^0x[0-9a-f]+$/i.test(s)) { const n = Number.parseInt(s, 16); return Number.isFinite(n) ? n : null; }
  return num(s);
}

/** `##TICK` — `getconf CLK_TCK`(보통 100). 값이 없으면 null(우리 계산은 비율이라 필요 없지만 진단용). */
export function parseClkTck(lines = []) {
  for (const l of lines) { const n = num(l); if (n != null && n > 0) return n; }
  return null;
}
