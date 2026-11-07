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

/**
 * v2.919: 장비 출력은 **줄 길이와 줄 수를 먼저 자른다**(루트 CLAUDE.md '정규식' — 외부 입력에 무제한 반복을 돌리기 전에).
 *   `/proc/stat` 의 intr 줄은 수천 칸이고 `/proc/interrupts` 는 코어 수만큼 넓다 — 파서가 쓰는 앞부분만 남긴다.
 *   구획당 줄 수 상한은 명령의 `head -n` 과 별개의 2중 방어다(명령이 바뀌어도 파서가 무제한으로 돌지 않게).
 */
export const MAX_LINE_CHARS = 4_096;
export const MAX_SECTION_LINES = 20_000;

/** 구획 표지로 쪼갠다. 표지가 없으면 빈 객체 — '형식 미인식' 이다. */
export function splitSections(text) {
  const out = {};
  let cur = null;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.length > MAX_LINE_CHARS ? raw.slice(0, MAX_LINE_CHARS) : raw;
    const m = /^##([A-Z]+)\s*$/.exec(line.trim());
    if (m) { cur = m[1]; out[cur] = []; continue; }
    if (cur && out[cur].length < MAX_SECTION_LINES) out[cur].push(line);
  }
  return out;
}

/**
 * v2.919 — 구획 하나를 **값 · absent · missing** 으로 읽는다(새 구획 공용 규약).
 *  · 표지가 오지 않았다(출력이 잘렸거나 명령이 그 앞에서 끝났다) → `missing`(못 읽음)
 *  · 표지는 왔는데 비어 있지 않은 줄이 0개 → `absent`(그 커널·장비에 **구조적으로 없다** — 예: PSI 없는 RHEL 8)
 *  · 줄은 있는데 파서가 값을 못 만들었다 → `missing`(형식이 달라 못 읽음 — 없다고 단정하지 않는다)
 * ⚠ absent 와 missing 을 같은 칸에 넣지 말 것(v2.550 FC HBA 규약) — 판정(useJudge)이 둘을 따로 센다.
 */
export function readSection(sec, name, fn) {
  if (!sec || !Array.isArray(sec[name])) return { value: null, absent: false, missing: true };
  const lines = sec[name].filter((l) => String(l).trim() !== '');
  if (!lines.length) return { value: null, absent: true, missing: false };
  let value = null;
  try { value = fn(lines); } catch { value = null; }
  return value == null ? { value: null, absent: false, missing: true } : { value, absent: false, missing: false };
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
export function parseDiskstats(lines = [], { partitions = false } = {}) {
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
    // v2.922: 파티션 I/O 는 서버 옵트인(partitionIo) — 켜면 파티션 행도 내되 `part:true` 로 표시한다(대표값·장치별 기본 대상에서는 뺀다).
    const whole = isWholeDisk(name, names);
    if (!whole && !(partitions && !/^(loop|ram|zram|sr)\d*$/.test(name))) continue;
    const rdSec = num(f[5]); const wrSec = num(f[9]); const ticks = num(f[12]);
    if (rdSec == null && wrSec == null && ticks == null) continue;
    out.push({
      name,
      readBytes: rdSec == null ? null : rdSec * 512,
      writeBytes: wrSec == null ? null : wrSec * 512,
      ioTicksMs: ticks,
      /*
       * v2.919(리눅스 성능 1단계): 14열 전부 — 4 reads · 7 read_ticks(ms) · 8 writes · 11 write_ticks(ms) · 12 in_flight(순간값) ·
       *   14 weighted_ticks(ms). await = Δ(read+write ticks) ÷ Δ(reads+writes) · 평균 대기열(aqu-sz) = Δweighted ÷ 경과(ms) —
       *   iostat 과 같은 계산(rates.js 가 한다). 열이 모자란 옛 커널 줄은 그 칸만 null(지어내지 않는다).
       */
      reads: num(f[3]), readTicksMs: num(f[6]), writes: num(f[7]), writeTicksMs: num(f[10]),
      inFlight: num(f[11]), weightedTicksMs: f.length > 13 ? num(f[13]) : null,
      ...(whole ? {} : { part: true }),
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
    // v2.919: 16열 — rx(0 bytes 1 packets 2 errs 3 drop 4 fifo 5 frame …) · tx(8 bytes 9 packets 10 errs 11 drop 12 fifo 13 colls 14 carrier …).
    out.push({
      iface, rxBytes: f[0], txBytes: f[8], rxErrs: f[2] ?? null, txErrs: f[10] ?? null,
      rxPackets: f[1] ?? null, txPackets: f[9] ?? null, rxDrop: f[3] ?? null, txDrop: f[11] ?? null,
      rxFifo: f[4] ?? null, rxFrame: f[5] ?? null, txFifo: f[12] ?? null, txColls: f[13] ?? null, txCarrier: f[14] ?? null,
    });
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
    /*
     * v2.605(COL2605-01): 넷째 필드 `0` = 물리 장치가 아니다(tun/tap·veth·bridge·vlan). 그 드라이버의 speed 는
     *   링크 속도가 아니라 고정값이라(tun 은 10Mb/s) 사용률(%)을 내면 거짓 100% 가 된다 → 속도를 null 로 두고
     *   `virtual` 로 밝힌다(처리량은 그대로 낸다). 넷째 필드가 없는 옛 출력은 예전처럼 속도를 믿는다(판정 근거 없음).
     */
    const virtual = f[3] === '0';
    map[f[0]] = {
      bitsPerSec: !virtual && mbit != null && mbit > 0 ? mbit * 1e6 : null,
      state: f[2] && f[2] !== '-' ? f[2] : '',
      ...(virtual ? { virtual: true } : {}),
    };
  }
  return map;
}

/**
 * `##FC` — HBA 한 대당 `<host> <port_state> <speed 원문> <tx_words> <rx_words>`.
 * ⚠ `tx_words`·`rx_words` 는 **4바이트 단위**이고 16진수(`0x…`)로 나올 수 있다.
 * ⚠ 속도 원문은 `16 Gbit` / `unknown` / `not negotiated` 등 — **'unknown' 을 0 으로 바꾸지 말 것**.
 * ⚠ `bitsPerSec` 는 **명목 등급**(16 Gbit = 16e9)이다 — 사용률 분모로 그대로 쓰지 말 것. FC 표준 데이터율 환산은
 *   `parse/fcRate.js fcUtilization` 하나가 한다(v2.743 DEV-03 — 명목으로 나누면 포화가 80% 에서 멈춘다).
 */
export function parseFcHosts(lines = []) {
  const out = [];
  for (const l of lines) {
    const s = String(l).trim();
    if (!s) continue;
    const f = s.split(/\|/);                       // 속도 원문에 공백이 있어 `|` 로 구분해 받는다
    if (f.length < 5) continue;
    const [host, state, speedRaw, txw, rxw] = f.map((x) => String(x).trim());
    // v2.603(감사 SEC2603-04): 숫자·점 구간의 **시작에서만** 매치를 시도한다(뒤보기). 예전 `/([\d.]+)\s*gbit/i` 는
    //   구간 안의 모든 위치에서 끝까지 다시 훑어 O(n²) 였다('0.' 2만 번에 수 초). 결과는 같다 — 가장 왼쪽 매치는
    //   언제나 구간의 시작이다(중간에서 매치되면 시작에서도 같은 끝으로 매치된다).
    const gb = /(?<![\d.])([\d.]+)\s*gbit/i.exec(speedRaw);
    const tw = fcWords(txw); const rw = fcWords(rxw);
    out.push({
      host,
      state: state || '',
      speedRaw: speedRaw || '',
      bitsPerSec: gb ? Number(gb[1]) * 1e9 : null,   // 못 읽으면 null — 퍼센트를 내지 않는다
      txBytes: tw.value == null ? null : tw.value * 4,
      rxBytes: rw.value == null ? null : rw.value * 4,
      // v2.744(감사 DEV-01): '-1 표지'를 만났다는 사실 — 화면·노트가 '못 읽음' 을 말한다(빈 값과 구분).
      ...(tw.invalid || rw.invalid ? { countersInvalid: true } : {}),
    });
  }
  return out.length ? out : null;
}

/**
 * FC 통계 한 칸 → `{ value, invalid }`.
 * ⚠⚠ v2.744(감사 DEV-01): **`0xffffffffffffffff`(-1 표지)는 카운터가 아니라 '못 읽음' 이다.** Linux qla2xxx 는 통계 구조체를 -1 로
 *   채운 뒤(memset(p,-1)) 칩 다운·ISP 재설정·PCI 오프라인·통계 조회 실패면 그대로 돌려주고, scsi_transport_fc 는 그 값을 `0x%llx`
 *   로 sysfs 에 낸다. 예전에는 그것을 1.8e19 단어(×4 바이트)로 읽어, 정상 → 표지 주기에 약 491 PB/s 가 원시 표본과 5년 일 롤업
 *   최대에 남았고(오류 없이 틀린 값), 표지 → 표지 주기는 0 B/s('트래픽 없음' 이라는 거짓)였다.
 *   음수(10진 '-1')·10진 2^64−1(부호 없는 -1)도 카운터가 아니다. 64비트에 담을 수 없는 값(2^64 이상 — 반올림으로 표지와 같아지는 값
 *   포함)도 같은 취급이다. 빈 칸은 예전처럼 null(표지 아님).
 * ⚠ v2.744(회귀 검토 GB-R3): **2^53 을 넘는 정상 카운터는 표지가 아니다** — 값으로 읽는다(근사). 예전에는 2^53(= 36 PB 단어) 초과를 표지와
 *   같이 '못 읽음' 으로 처리해, 32GFC 를 한 방향 1.6GB/s 로 약 260일 돌린 HBA 의 처리량이 칩 재설정 전까지 영원히 비었고 노트는
 *   ''-1' 표지' 라는 틀린 원인을 말했다. 정밀도는 문제가 되지 않는다 — 2^57 근처 double 의 ulp 는 32 단어(128 바이트)라 5분 차이의
 *   오차는 1 B/s 에 못 미친다(2^63 근처도 ulp 2,048 단어 = 8KB → 약 27 B/s). 남는 쓰레기 값은 물리 상한(fcRate.fcPlausibleBps)이 거른다.
 */
const FC_U64_SENTINEL_DEC = '18446744073709551615';
const FC_U64_LIMIT = 2 ** 64;
function fcWords(v) {
  const s = String(v ?? '').trim();
  if (!s) return { value: null, invalid: false };
  if (/^0x[0-9a-f]+$/i.test(s)) {
    if (/^0xf{16}$/i.test(s)) return { value: null, invalid: true };
    const n = Number.parseInt(s, 16);
    return Number.isFinite(n) && n < FC_U64_LIMIT ? { value: n, invalid: false } : { value: null, invalid: true };
  }
  if (s === FC_U64_SENTINEL_DEC) return { value: null, invalid: true };
  const n = num(s);
  if (n == null) return { value: null, invalid: false };
  return n >= 0 && n < FC_U64_LIMIT ? { value: n, invalid: false } : { value: null, invalid: true };
}

/** `##TICK` — `getconf CLK_TCK`(보통 100). 값이 없으면 null(우리 계산은 비율이라 필요 없지만 진단용). */
export function parseClkTck(lines = []) {
  for (const l of lines) { const n = num(l); if (n != null && n > 0) return n; }
  return null;
}


/* ════════════════════════════════════════════════════════════════════════════
 * v2.919 리눅스 성능 1단계 — 새 구획 파서(전부 순수 · 원시값만 · 누적은 rates.js 가 환산).
 * 형식의 근거는 **커널 문서(Documentation/filesystems/proc.rst · accounting/psi.rst · iostats.rst)** 다 — 이 현장 실장비 출력은
 *   본 적이 없다(정직 기록). 그래서 파서는 관용적이고(열이 모자라면 그 칸만 null) 못 읽으면 null 로 돌려준다.
 * 정규식은 전부 앵커가 있거나 겹치지 않는 문자 클래스라 선형이다(테스트가 비율로 고정한다).
 * ════════════════════════════════════════════════════════════════════════════ */

/** CPU 열 이름(`/proc/stat` cpu 줄 순서 — guest·guest_nice 는 user·nice 에 이미 포함). */
// ⚠ 원시 idle 은 `idleRaw` 다 — `idle` 이름은 기존 규약(idle + iowait)이 쓴다(덮으면 cpu_pct 와 분해가 서로 다른 idle 을 쓴다 — 자체 실측에서 잡았다).
const CPU_FIELDS = ['user', 'nice', 'system', 'idleRaw', 'iowait', 'irq', 'softirq', 'steal'];
/** 코어 줄 상한 — 명령의 `head -n` 과 같은 값(넘으면 coresTruncated). */
export const MAX_CORES = 1_024;

/**
 * `##STAT`(확장) — `/proc/stat` 전체 → `{ cpu:{total,idle,user,nice,system,idleRaw,iowait,irq,softirq,steal}, cores:[total0,idle0,…],
 *   coreCount, coresTruncated, ctxt, intr, procsRunning, procsBlocked }`.
 * ⚠ idle 은 기존 규약 그대로 `idle + iowait`(parseProcStat 과 같은 값 — 같은 행의 cpu_pct 와 분해가 어긋나지 않게).
 * ⚠ 코어별은 메모리를 아끼려고 **평탄 배열**(total, idle 쌍)로 둔다 — 1,000대 × 256코어를 객체로 들면 수십 MB 다.
 * ⚠ intr 줄은 첫 칸(합계)만 쓴다 — 나머지 수천 칸은 splitSections 가 줄 길이로 이미 잘랐다.
 */
export function parseProcStatFull(lines = []) {
  let cpu = null; const cores = []; let coreCount = 0;
  const kv = {};
  for (const l of lines) {
    const s = String(l).trim();
    const m = /^(cpu\d*)\s+(\d[\d\s]*)$/.exec(s.length > 512 ? s.slice(0, 512) : s);
    if (m) {
      const f = m[2].trim().split(/\s+/).map(num);
      if (f.length < 4 || f.slice(0, 4).some((x) => x == null)) continue;
      const total = f.slice(0, 8).reduce((a, b) => a + (b ?? 0), 0);
      const idle = (f[3] ?? 0) + (f[4] ?? 0);
      if (m[1] === 'cpu') {
        cpu = { total, idle };
        CPU_FIELDS.forEach((k, i) => { cpu[k] = f[i] ?? null; });
      } else {
        coreCount += 1;
        if (cores.length < MAX_CORES * 2) cores.push(total, idle);
      }
      continue;
    }
    const k = /^(ctxt|intr|procs_running|procs_blocked|processes)\s+(\d+)/.exec(s);
    if (k) kv[k[1]] = num(k[2]);
  }
  if (!cpu && kv.ctxt == null) return null;
  return {
    cpu, cores, coreCount: coreCount || null, coresTruncated: coreCount > MAX_CORES,
    ctxt: kv.ctxt ?? null, intr: kv.intr ?? null,
    procsRunning: kv.procs_running ?? null, procsBlocked: kv.procs_blocked ?? null,
  };
}

/** `##LOAD` — `/proc/loadavg` `0.52 0.58 0.59 2/1234 5678` → `{ load1, load5, load15, runnable, threads }`. */
export function parseLoadavg(lines = []) {
  for (const l of lines) {
    const s = String(l).trim().slice(0, 256);
    const m = /^([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s+(\d+)\/(\d+))?/.exec(s);
    if (!m) continue;
    const v = { load1: num(m[1]), load5: num(m[2]), load15: num(m[3]), runnable: num(m[4]), threads: num(m[5]) };
    return v.load1 == null ? null : v;
  }
  return null;
}

/**
 * `##PSI` — 명령이 `<자원> <원문 줄>` 로 붙여 보낸다(`cpu some avg10=0.00 avg60=0.00 avg300=0.00 total=123`).
 * → `{ cpu:{some:{avg10,avg60,avg300,total}, full:{…}|null}, memory:{…}, io:{…} }` · 읽은 자원이 하나도 없으면 null.
 * ⚠ 구획이 비면 **absent**(커널 4.20 미만 · RHEL 8 은 `psi=1` 부팅 옵션 필요) — readSection 이 정한다(여기서 0 을 만들지 않는다).
 * ⚠ cpu 의 full 줄은 커널 5.13+ 에만 있고 시스템 수준에선 0 이다 — 판정은 cpu some 을 쓴다.
 */
export function parsePsi(lines = []) {
  const out = {};
  for (const l of lines) {
    const s = String(l).trim().slice(0, 256);
    const m = /^(cpu|memory|io)\s+(some|full)\s+avg10=([\d.]+)\s+avg60=([\d.]+)\s+avg300=([\d.]+)(?:\s+total=(\d+))?/.exec(s);
    if (!m) continue;
    out[m[1]] = out[m[1]] || { some: null, full: null };
    out[m[1]][m[2]] = { avg10: num(m[3]), avg60: num(m[4]), avg300: num(m[5]), total: num(m[6]) };
  }
  return Object.keys(out).length ? out : null;
}

/** `##VMSTAT` — `/proc/vmstat` 중 넷(누적). `oom_kill` 은 커널 4.13+ — 없으면 그 칸만 null. */
export function parseVmstat(lines = []) {
  const out = { pswpin: null, pswpout: null, pgmajfault: null, oomKill: null };
  let seen = 0;
  for (const l of lines) {
    const m = /^(pswpin|pswpout|pgmajfault|oom_kill)\s+(\d+)\s*$/.exec(String(l).trim().slice(0, 128));
    if (!m) continue;
    out[m[1] === 'oom_kill' ? 'oomKill' : m[1]] = num(m[2]); seen += 1;
  }
  return seen ? out : null;
}

/**
 * `##SNMP` — `/proc/net/snmp` 의 Tcp 두 줄(머리글 + 값) → `{ retransSegs, outSegs, inErrs, inSegs, currEstab, activeOpens }`.
 * 머리글 이름으로 칸을 찾는다(커널마다 칸 수가 다를 수 있다 — 순번을 굳히지 않는다).
 */
export function parseSnmpTcp(lines = []) {
  let head = null; let vals = null;
  for (const l of lines) {
    const s = String(l).trim().slice(0, 1_024);
    if (!s.startsWith('Tcp:')) continue;
    const f = s.slice(4).trim().split(/\s+/);
    if (!head && f.length && /^[A-Za-z]/.test(f[0])) head = f;
    else if (head && !vals) vals = f;
  }
  if (!head || !vals) return null;
  const at = (k) => { const i = head.indexOf(k); return i >= 0 ? num(vals[i]) : null; };
  const v = { retransSegs: at('RetransSegs'), outSegs: at('OutSegs'), inSegs: at('InSegs'), inErrs: at('InErrs'), currEstab: at('CurrEstab'), activeOpens: at('ActiveOpens') };
  return v.retransSegs == null && v.outSegs == null ? null : v;
}

/**
 * `##BLKQ` — 장치별 `<name>|<scheduler 원문>|<nr_requests>|<rotational>`.
 * scheduler 원문 `mq-deadline kyber [bfq] none` 에서 대괄호가 현재값이다(없으면 그 원문 하나가 현재값 — `none` 만 있는 NVMe).
 */
export const MAX_BLKQ = 64;
/** v2.922(D7): 명령이 보내는 BLKQ 줄 상한(장치 × 3 파일) — 장치 수 상한은 설정(store.blkqMax)이 파서에서 정한다. */
export const BLKQ_SHELL_LINES = 4 * 1_024;   // store.blkqMax 상한(1,024) × 4 파일(v2.923: read_ahead_kb 추가) — 바이트 합 산수(D1)를 테스트가 고정한다
/** 장치 이름 → 우선순위(물리 디스크 먼저 · md · dm 마지막 — 멀티패스 서버에서 dm-* 가 물리 디스크 큐를 밀어내지 않게 · D7). */
export function blkqRank(name) {
  const n0 = String(name || '');
  if (/^(sd|nvme|vd|xvd|hd)/.test(n0)) return 0;
  if (/^md\d/.test(n0)) return 1;
  if (/^dm-\d/.test(n0)) return 2;
  return 1;
}
/**
 * `##BLKQ` — 두 형식을 받는다:
 *  · v2.922(D7) `grep -H '' /sys/block/<name>/queue/{scheduler,nr_requests,rotational}` 한 번 → `/sys/block/<name>/queue/<file>:<값>`
 *  · v2.919 `<name>|<scheduler 원문>|<nr_requests>|<rotational>`(옛 명령 · 테스트 표본)
 * scheduler 원문 `mq-deadline kyber [bfq] none` 에서 대괄호가 현재값이다(없으면 그 원문 하나가 현재값 — `none` 만 있는 NVMe).
 * 물리 디스크 → md → dm 순으로 정렬해 앞 max 개만(나머지는 결과 배열의 `total` 로 센다).
 */
export function parseBlkq(lines = [], { max = MAX_BLKQ } = {}) {
  const map = new Map();
  const get = (name) => { if (!map.has(name)) map.set(name, { name, raw: null, nr: null, ro: null, ra: null }); return map.get(name); };
  for (const l of lines) {
    const s0 = String(l).trim().slice(0, 512);
    const g = /^\/sys\/block\/([A-Za-z0-9._:-]{1,64})\/queue\/(scheduler|nr_requests|rotational|read_ahead_kb):(.*)$/.exec(s0);
    if (g) {
      const e = get(g[1]);
      if (g[2] === 'scheduler') e.raw = g[3]; else if (g[2] === 'nr_requests') e.nr = g[3]; else if (g[2] === 'read_ahead_kb') e.ra = g[3]; else e.ro = g[3];
      continue;
    }
    const f = s0.split('|');
    if (f.length < 4 || !/^[A-Za-z0-9._:-]{1,64}$/.test(f[0])) continue;
    const e = get(f[0]); e.raw = f[1]; e.nr = f[2]; e.ro = f[3];
  }
  const all = [...map.values()].filter((e) => !/^(loop|ram|zram|sr)\d/.test(e.name))
    .map((e, i) => ({ e, i })).sort((a, b) => blkqRank(a.e.name) - blkqRank(b.e.name) || a.i - b.i).map((x) => x.e);
  const cap = Math.max(1, Math.floor(Number(max) || MAX_BLKQ));
  const out = all.slice(0, cap).map((e) => {
    const raw = String(e.raw ?? '').trim();
    const act = /\[([A-Za-z0-9_-]{1,32})\]/.exec(raw);
    const list = raw.replace(/[[\]]/g, ' ').split(/\s+/).filter((x) => /^[A-Za-z0-9_-]{1,32}$/.test(x)).slice(0, 8);
    return {
      name: e.name, scheduler: act ? act[1] : (list.length === 1 ? list[0] : null), schedulers: list,
      nrRequests: num(e.nr), rotational: num(e.ro) === 1 ? true : num(e.ro) === 0 ? false : null,
      // v2.923: read_ahead_kb(KB — GPDB 요구 ‘blockdev 16384’ 는 512B 섹터 단위라 8192KB 와 같다 · 튜닝 판정이 단위를 맞춘다). 못 읽으면 null.
      readAheadKb: num(e.ra),
    };
  });
  if (!out.length) return null;
  out.total = all.length;   // 상한으로 뺀 수(= total − length)는 tuning.blkqTotal 로 밝힌다
  return out;
}

/**
 * `##SYSCTL` — `<경로>:<값>` 한 줄씩(명령이 `grep -H '' <파일들>` 한 번으로 읽는다 — 키마다 프로세스를 띄우지 않는다).
 *   없는 파일은 줄이 없다 → 그 키는 결과에 없다(‘확인 불가’ — 0 이 아니다). `=` 구분도 받는다(옛 형식·테스트 표본).
 * **아는 경로만** 받는다(화이트리스트 — 이름표는 이 표가 소유한다). 값이 비면 null(‘확인 불가’ — 0 이 아니다).
 */
export const SYSCTL_PATHS = Object.freeze({
  '/proc/sys/vm/swappiness': 'vm.swappiness',
  '/proc/sys/vm/dirty_ratio': 'vm.dirty_ratio',
  '/proc/sys/vm/dirty_background_ratio': 'vm.dirty_background_ratio',
  '/proc/sys/vm/min_free_kbytes': 'vm.min_free_kbytes',
  '/proc/sys/vm/overcommit_memory': 'vm.overcommit_memory',
  '/proc/sys/vm/zone_reclaim_mode': 'vm.zone_reclaim_mode',
  '/proc/sys/kernel/numa_balancing': 'kernel.numa_balancing',
  '/proc/sys/net/core/somaxconn': 'net.core.somaxconn',
  '/proc/sys/net/core/netdev_max_backlog': 'net.core.netdev_max_backlog',
  '/proc/sys/net/core/rmem_max': 'net.core.rmem_max',
  '/proc/sys/net/core/wmem_max': 'net.core.wmem_max',
  '/proc/sys/net/ipv4/tcp_rmem': 'net.ipv4.tcp_rmem',
  '/proc/sys/net/ipv4/tcp_wmem': 'net.ipv4.tcp_wmem',
  '/proc/sys/net/ipv4/tcp_max_syn_backlog': 'net.ipv4.tcp_max_syn_backlog',
  '/proc/sys/fs/file-max': 'fs.file-max',
  '/sys/kernel/mm/transparent_hugepage/enabled': 'thp.enabled',
  '/sys/kernel/mm/transparent_hugepage/defrag': 'thp.defrag',
  '/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor': 'cpu.governor',
  '/sys/devices/system/cpu/cpu0/cpufreq/scaling_driver': 'cpu.scaling_driver',
  '/etc/tuned/active_profile': 'tuned.active_profile',
  // v2.923(4단계 — 튜닝 탭 · gpdb OS 요구값 G1): 읽기 전용 추가분. 없는 파일은 줄이 없다(= 확인 불가).
  '/proc/sys/vm/overcommit_ratio': 'vm.overcommit_ratio',
  '/proc/sys/vm/dirty_bytes': 'vm.dirty_bytes',
  '/proc/sys/vm/dirty_background_bytes': 'vm.dirty_background_bytes',
  '/proc/sys/kernel/shmall': 'kernel.shmall',
  '/proc/sys/kernel/shmmax': 'kernel.shmmax',
  '/proc/sys/kernel/shmmni': 'kernel.shmmni',
  '/proc/sys/kernel/sem': 'kernel.sem',
  '/proc/sys/kernel/core_pattern': 'kernel.core_pattern',
  '/proc/sys/net/ipv4/ip_local_port_range': 'net.ipv4.ip_local_port_range',
  '/proc/sys/net/core/rmem_default': 'net.core.rmem_default',
  '/proc/sys/net/core/wmem_default': 'net.core.wmem_default',
  '/proc/sys/net/ipv4/tcp_tw_reuse': 'net.ipv4.tcp_tw_reuse',
  '/proc/sys/net/core/netdev_budget': 'net.core.netdev_budget',
  '/proc/sys/net/core/netdev_budget_usecs': 'net.core.netdev_budget_usecs',
});
export function parseSysctl(lines = []) {
  const out = {};
  let seen = 0;
  for (const l of lines) {
    const s = String(l).slice(0, 512);
    const ci = s.indexOf(':'); const ei = s.indexOf('=');
    const i = ci > 0 && (ei < 0 || ci < ei) ? ci : ei;
    if (i <= 0) continue;
    const key = SYSCTL_PATHS[s.slice(0, i).trim()];
    if (!key || Object.hasOwn(out, key)) continue;
    let v = s.slice(i + 1).replace(/\s+/g, ' ').trim().slice(0, 128);
    // THP 원문 `always [madvise] never` → 현재값만(대괄호). 대괄호가 없으면 원문 그대로.
    if (key.startsWith('thp.')) { const m = /\[([a-z_+-]{1,32})\]/.exec(v); if (m) v = m[1]; }
    out[key] = v === '' ? null : v;
    seen += 1;
  }
  return seen ? out : null;
}

/** `##MEM` 에서 HugeTLB 현재값(개수 — kB 단위가 아니다. parseMemInfo 는 이 줄을 바이트로 바꾸므로 여기서 따로 읽는다). */
export function parseHugePages(lines = []) {
  const out = { total: null, free: null, sizeKb: null };
  let seen = 0;
  for (const l of lines) {
    const m = /^(HugePages_Total|HugePages_Free|Hugepagesize):\s+(\d+)/.exec(String(l).trim().slice(0, 128));
    if (!m) continue;
    out[m[1] === 'HugePages_Total' ? 'total' : m[1] === 'HugePages_Free' ? 'free' : 'sizeKb'] = num(m[2]); seen += 1;
  }
  return seen ? out : null;
}

/**
 * `##IRQ` — 명령의 awk 요약 `<irq>|<0 아닌 코어 수>|<전체 코어 수>|<이름>`(NIC 큐로 보이는 줄만) + `irqbalance=<상태>` 한 줄.
 * → `{ irqbalance, nicIrqs, spreadMin, spreadMax, cpus, lines:[{irq,nonzero,cpus,name}] }`.
 * ⚠ ‘몇 코어에 퍼졌나’ 는 **부팅 이후 누적 카운트가 0 이 아닌 코어 수**다(지금 분배가 아니다 — 친화도를 바꾼 직후엔 옛 값이 섞인다). 문구가 그렇게 말한다.
 */
export const MAX_IRQ_LINES = 256;
export function parseIrq(lines = []) {
  let irqbalance = null; const rows = [];
  for (const l of lines) {
    const s = String(l).trim().slice(0, 256);
    const b = /^irqbalance=([a-z-]{0,32})$/.exec(s);
    if (b) { irqbalance = b[1] || null; continue; }
    if (rows.length >= MAX_IRQ_LINES) continue;
    const f = s.split('|');
    if (f.length < 4) continue;
    const nz = num(f[1]); const cpus = num(f[2]);
    if (nz == null || cpus == null) continue;
    rows.push({ irq: f[0].replace(/:$/, '').slice(0, 12), nonzero: nz, cpus, name: f[3].slice(0, 48) });
  }
  if (irqbalance == null && !rows.length) return null;
  const nz = rows.map((r) => r.nonzero);
  return {
    irqbalance, nicIrqs: rows.length,
    spreadMin: nz.length ? Math.min(...nz) : null, spreadMax: nz.length ? Math.max(...nz) : null,
    cpus: rows.length ? rows[0].cpus : null, lines: rows.slice(0, 32),
  };
}

/**
 * `##DFI` — `df -P -i` 등록 마운트의 inode(8단계 용량 예측이 쓴다). `Filesystem Inodes IUsed IFree IUse% Mounted on`.
 * ⚠ xfs·btrfs 는 inode 를 동적으로 만든다 — Inodes 가 0 이거나 IUse% 가 `-` 면 사용률을 내지 않는다(null — ‘가득’ 도 ‘여유’ 도 아니다).
 */
export function parseDfInodes(lines = []) {
  const out = [];
  for (const l of lines) {
    const s = String(l).trim().slice(0, 1_024);
    if (!s || /^Filesystem\s/.test(s)) continue;
    const f = s.split(/\s+/);
    if (f.length < 6) continue;
    const inodes = num(f[1]); const used = num(f[2]); const free = num(f[3]);
    const pctRaw = /^(\d+)%$/.exec(f[4]);
    out.push({
      mount: f.slice(5).join(' ').slice(0, 256), inodes, iused: used, ifree: free,
      iusePct: inodes != null && inodes > 0 && pctRaw ? num(pctRaw[1]) : null,
    });
    if (out.length >= 64) break;
  }
  return out.length ? out : null;
}
