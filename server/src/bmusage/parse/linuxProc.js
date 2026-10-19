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
 *   2^53 을 넘는 값은 JS 수로 정확히 담을 수도 없으므로 **표지가 아니어도** 같은 취급이다(정밀도를 잃은 누적값으로 차이를 내지 않는다).
 *   음수(10진 '-1')도 카운터가 아니다. 빈 칸은 예전처럼 null(표지 아님).
 */
function fcWords(v) {
  const s = String(v ?? '').trim();
  if (!s) return { value: null, invalid: false };
  if (/^0x[0-9a-f]+$/i.test(s)) {
    if (/^0xf{16}$/i.test(s)) return { value: null, invalid: true };
    const n = Number.parseInt(s, 16);
    return Number.isSafeInteger(n) ? { value: n, invalid: false } : { value: null, invalid: true };
  }
  const n = num(s);
  if (n == null) return { value: null, invalid: false };
  return n >= 0 && n <= Number.MAX_SAFE_INTEGER ? { value: n, invalid: false } : { value: null, invalid: true };
}

/** `##TICK` — `getconf CLK_TCK`(보통 100). 값이 없으면 null(우리 계산은 비율이라 필요 없지만 진단용). */
export function parseClkTck(lines = []) {
  for (const l of lines) { const n = num(l); if (n != null && n > 0) return n; }
  return null;
}
