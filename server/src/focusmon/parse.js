/**
 * focusmon/parse.js — 수집 스크립트(script.js) 출력 줄을 **프레임**으로 묶고, 구획을 원시 카운터로 읽는다(순수 · v2.976).
 *
 * ── 표지는 위조되지 않게(docs/rules/security-api.md v2.923 ⑤ 와 같은 규칙) ──────────────────────────────
 *  · 표지는 **줄 전체 정확 일치**로만 받는다(`##STAT` · `##END` …). `##T` 는 `##T <소수> <정수>` 꼴만.
 *  · 한 프레임 안에서 구획은 **정해진 순서의 뒤쪽으로만** 열린다 — 같은 구획을 다시 열거나 앞 구획으로 돌아가면 그 프레임은 버린다.
 *  · `##END` 없이 다음 `##T` 가 오면 앞 프레임은 버린다(잘린 출력을 성공으로 읽지 않는다).
 *  · 데이터 줄은 길이(4KB)를 먼저 자르고, 구획마다 줄 수 상한을 둔다(넘으면 `truncated` 에 구획 이름).
 * ── 값 ─────────────────────────────────────────────────────────────────────────────────────────────────
 *  · 숫자는 `^\d+$`(카운터) · 소수(부하 · uptime)만 받는다. 읽지 못한 칸은 null — 0 으로 두지 않는다(루트 CLAUDE.md '못 읽은 값은 0 이 아니다').
 *  · 정규식은 전부 앵커가 있고 길이가 한정된 꼴이다(외부 입력 — ReDoS 규약).
 */

export const SECTIONS = Object.freeze(['STAT', 'LOAD', 'MEM', 'NET', 'DISK', 'VM', 'SNMP', 'SOCK', 'FS', 'FSI', 'KMSG', 'NETTOPO', 'BLK', 'PS', 'UNIT', 'PROC', 'IO', 'SELF']);
/** v2.983 수집 부하 — 구획 → 세 묶음(기본 지표 · 구성 · 프로세스 · 자기 측정). 원격 스크립트의 ck 위치와 같다(테스트가 대조). */
// v3.12.0(⑬): VM · SNMP · SOCK · FS · FSI 는 기본 묶음 — 수집 부하 탭이 그 비용을 기본 지표 몫으로 잰다(따로 묶지 않는다)
export const SECTION_GROUP = Object.freeze({ STAT: 'base', LOAD: 'base', MEM: 'base', NET: 'base', DISK: 'base', VM: 'base', SNMP: 'base', SOCK: 'base', FS: 'base', FSI: 'base', KMSG: 'base', NETTOPO: 'topo', BLK: 'topo', PS: 'topo', UNIT: 'topo', PROC: 'proc', IO: 'proc', SELF: 'self' });
const ORDER = Object.freeze(Object.fromEntries(SECTIONS.map((s, i) => [s, i])));
/** 구획별 줄 수 상한(스크립트의 head -n 과 같거나 조금 크다). */
export const SECTION_MAX_LINES = Object.freeze({ STAT: 1104, LOAD: 4, MEM: 128, NET: 258, DISK: 1024, VM: 64, SNMP: 8, SOCK: 8, FS: 258, FSI: 258, KMSG: 26, NETTOPO: 256, BLK: 512, PS: 20000, PROC: 20000, UNIT: 20000, IO: 20000, SELF: 4 });
export const LINE_MAX = 4096;
/** 프레임 하나가 붙잡을 수 있는 글자 수 상한(원래 줄 길이로 센다). 정상 프레임은 프로세스 2만 개여도 약 2MB —
 *  줄 수 상한 합(약 4만 3천 줄) × 줄 길이 상한이면 대상 1대가 수백 MB 를 붙잡을 수 있었다(2026-11-11 반증 4번). 넘으면 그 프레임을 버린다. */
export const FRAME_MAX_CHARS = 4 * 2 ** 20;
/** 원격에서 온 이름을 객체 키로 쓰기 전에 — 프로토타입 이름은 받지 않는다(lsblk KNAME="__proto__" 로 Object.prototype 오염 — 반증 2번). */
const RESERVED_KEY = /^(?:__proto__|constructor|prototype)$/;
export const safeKey = (k) => typeof k === 'string' && k.length > 0 && !RESERVED_KEY.test(k);
const HELLO_MAX_LINES = 32;

const T_RE = /^##T (\d{1,12}(?:\.\d{1,3})?) (\d{1,12})$/;
const MARK_RE = /^##([A-Z]{2,8})$/;
const DIGITS = /^\d{1,20}$/;

const intOrNull = (s) => (typeof s === 'string' && DIGITS.test(s) ? Number(s) : null);
const decOrNull = (s) => (typeof s === 'string' && /^\d{1,12}(?:\.\d{1,6})?$/.test(s) ? Number(s) : null);
const words = (line) => String(line).trim().split(/\s+/);

/**
 * 줄 → 프레임 묶기(상태 기계).
 * @param {{onHello?:(h:object)=>void, onFrame?:(f:object)=>void}} cb
 * @returns {{push:(line:string)=>void, stats:()=>object}}
 */
export function createFrameParser({ onHello, onFrame } = {}) {
  let mode = 'idle'; // idle | hello | frame
  let hello = null;
  let frame = null; let cur = null; let curOrder = -1; let broken = false; let chars = 0; let rawLen = 0;
  const st = { frames: 0, dropped: 0, stray: 0, hellos: 0, oversize: 0 };

  const startFrame = (up, epoch) => {
    if (mode === 'frame' && frame) st.dropped += 1; // END 없이 다음 프레임 — 앞 것은 버린다
    // v2.983 bytes: 받은 글자 수(줄바꿈 1 포함) — 묶음별(base 에는 ##T · 표지 · ##END 도) · 수집 부하의 '보내는 양'
    frame = { up, epoch, sec: Object.create(null), truncated: [], bytes: { base: rawLen + 1, topo: 0, proc: 0, self: 0 } }; cur = null; curOrder = -1; broken = false; chars = 0; mode = 'frame';
  };

  function push(raw) {
    const rawStr = String(raw ?? '');
    const line = rawStr.slice(0, LINE_MAX);
    if (line === '##HELLO 1') { if (mode === 'frame') st.dropped += 1; mode = 'hello'; hello = []; frame = null; return; }
    rawLen = rawStr.length;
    const tm = line.startsWith('##T ') ? T_RE.exec(line) : null;
    if (tm) { startFrame(Number(tm[1]), Number(tm[2])); return; }
    if (line === '##END') {
      if (mode === 'frame' && frame) frame.bytes.base += rawLen + 1;
      if (mode === 'hello') { st.hellos += 1; try { onHello?.(parseHello(hello)); } catch { /* */ } }
      else if (mode === 'frame' && frame) {
        if (broken) st.dropped += 1;
        else { st.frames += 1; try { onFrame?.(frame); } catch { /* */ } }
      } else st.stray += 1;
      mode = 'idle'; frame = null; hello = null; cur = null;
      return;
    }
    const mm = line.startsWith('##') ? MARK_RE.exec(line) : null;
    if (mm && Object.hasOwn(ORDER, mm[1])) {
      if (mode !== 'frame' || !frame) { st.stray += 1; return; }
      const o = ORDER[mm[1]];
      if (o <= curOrder || Object.hasOwn(frame.sec, mm[1])) { broken = true; return; } // 재개방 · 역순 → 이 프레임은 믿지 않는다
      curOrder = o; cur = mm[1]; frame.sec[cur] = [];
      frame.bytes[SECTION_GROUP[cur]] += rawLen + 1; // 표지 줄은 그 구획의 묶음에
      return;
    }
    if (mode === 'hello') { if (hello.length < HELLO_MAX_LINES) hello.push(line); return; }
    if (mode === 'frame' && frame && cur) {
      if (broken) return;
      frame.bytes[SECTION_GROUP[cur]] += rawLen + 1;
      chars += rawStr.length;
      if (chars > FRAME_MAX_CHARS) { broken = true; st.oversize += 1; frame.sec = Object.create(null); cur = null; return; } // 붙잡은 줄을 바로 놓는다
      const arr = frame.sec[cur];
      if (arr.length < SECTION_MAX_LINES[cur]) arr.push(line);
      else if (!frame.truncated.includes(cur)) frame.truncated.push(cur);
      return;
    }
    st.stray += 1;
  }
  return { push, stats: () => ({ ...st }) };
}

/** HELLO 구획 → 서버 정보. */
export function parseHello(lines = []) {
  const kv = Object.create(null);
  for (const l of lines) {
    const i = l.indexOf(' ');
    const k = i > 0 ? l.slice(0, i) : l;
    if (/^[a-z]{2,8}$/.test(k) && !Object.hasOwn(kv, k)) kv[k] = (i > 0 ? l.slice(i + 1) : '').trim().slice(0, 200);
  }
  const uname = kv.uname || '';
  const rel = kv.rel || '';
  return {
    kernel: uname.slice(0, 120),
    isLinux: /^Linux\b/.test(uname),
    release: rel.slice(0, 120),
    rhelMajor: (() => { const m = /release (\d{1,2})\.(\d{1,2})/.exec(rel); return m ? `${m[1]}.${m[2]}` : null; })(),
    tck: intOrNull(kv.tck),
    page: intOrNull(kv.page),
    ncpu: intOrNull(kv.ncpu),
    hidepid: intOrNull(kv.hidepid) != null ? intOrNull(kv.hidepid) > 0 : null,
    dacct: delayAcctOf(kv.dacct),
    hostname: (kv.host || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64),
  };
}

/** ##STAT → 전체 · 코어별 jiffies(앞 8칸: user nice system idle iowait irq softirq steal) + 실행 · 대기 프로세스 수 + (v3.12.0) ctxt · processes · intr 첫 합계(누적 · 없으면 null). */
export function parseStat(lines = []) {
  let all = null; const cores = []; let running = null; let blocked = null; let ctxt = null; let forks = null; let intr = null;
  for (const l of lines) {
    const f = words(l);
    if (f[0] === 'procs_running') { running = intOrNull(f[1]); continue; }
    if (f[0] === 'procs_blocked') { blocked = intOrNull(f[1]); continue; }
    if (f[0] === 'ctxt') { ctxt = intOrNull(f[1]); continue; }
    if (f[0] === 'processes') { forks = intOrNull(f[1]); continue; }
    if (f[0] === 'intr') { intr = intOrNull(f[1]); continue; }
    const m = /^cpu(\d{0,4})$/.exec(f[0]);
    if (!m) continue;
    const v = f.slice(1, 9).map(intOrNull);
    if (v.length < 4 || v.slice(0, 4).some((x) => x == null)) continue;
    while (v.length < 8) v.push(0); // 아주 옛 커널은 steal 이 없다 — 칸이 없는 것은 0(카운터가 없다 = 그 시간 0)
    if (m[1] === '') all = v; else { const i = Number(m[1]); if (i < 1024) cores[i] = v; }
  }
  return { all, cores: cores.filter(Boolean).length ? cores : [], running, blocked, ctxt, forks, intr };
}

/* ── v3.12.0(⑬ 더할 지표 — 시안 Metrics · 사용자 '기본값대로 모두 구현해줘') ─────────────────────────────── */
/** pgscan · pgsteal 의 합칠 이름 — 회수 경로별(kswapd · direct · khugepaged · proactive · 옛 커널은 _zone 접미). _anon · _file(5.8+ 내역 — 같은 수를 다시 센다) · direct_throttle(횟수)은 뺀다. */
const RECLAIM_RE = /^(pgscan|pgsteal)_(kswapd|direct|khugepaged|proactive)(_[a-z0-9]{1,16})?$/;
/** ##VM(/proc/vmstat 일부) → 누적 페이지 수(스왑 들어옴 · 나감 · major fault · 회수 스캔 · 회수 성공). 칸이 없으면 null(0 아님). */
export function parseVm(lines = []) {
  const kv = Object.create(null);
  for (const l of lines) { const f = words(l); if (f.length === 2 && /^[a-z_0-9]{2,40}$/.test(f[0])) { const v = intOrNull(f[1]); if (v != null) kv[f[0]] = v; } }
  let scan = null; let steal = null;
  for (const [k, v] of Object.entries(kv)) {
    const m = RECLAIM_RE.exec(k);
    if (!m || k === 'pgscan_direct_throttle') continue;
    if (m[1] === 'pgscan') scan = (scan ?? 0) + v; else steal = (steal ?? 0) + v;
  }
  return { swpin: kv.pswpin ?? null, swpout: kv.pswpout ?? null, majflt: kv.pgmajfault ?? null, scan, steal };
}

/** ##SNMP(/proc/net/snmp · netstat 의 Tcp · TcpExt 머리 · 값 줄 쌍) → 누적(재전송 · 보낸 세그먼트 · 리슨 큐 넘침 · 버림) + 지금 연결 수. */
export function parseSnmp(lines = []) {
  const tab = Object.create(null);
  let head = null;
  for (const l of lines) {
    const f = words(l);
    if (!/^(Tcp|TcpExt):$/.test(f[0] || '')) { head = null; continue; }
    if (f.slice(1).every((x) => /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(x))) { head = f; continue; }
    if (head && head[0] === f[0] && head.length === f.length) {
      for (let i = 1; i < f.length; i++) { const v = /^-?\d{1,20}$/.test(f[i]) ? Number(f[i]) : null; if (v != null && safeKey(head[i])) tab[`${f[0]}${head[i]}`] = v; }
    }
    head = null;
  }
  const g = (k) => (Object.hasOwn(tab, k) && tab[k] >= 0 ? tab[k] : null);
  return { retrans: g('Tcp:RetransSegs'), outSegs: g('Tcp:OutSegs'), estab: g('Tcp:CurrEstab'), lof: g('TcpExt:ListenOverflows'), ldrop: g('TcpExt:ListenDrops') };
}

/** ##SOCK(/proc/net/sockstat) → TCP 소켓 수(지금 값): 쓰는 중 · TIME_WAIT · 고아. */
export function parseSock(lines = []) {
  for (const l of lines) {
    const f = words(l);
    if (f[0] !== 'TCP:') continue;
    const kv = Object.create(null);
    for (let i = 1; i + 1 < f.length; i += 2) if (/^[a-z]{1,12}$/.test(f[i])) kv[f[i]] = intOrNull(f[i + 1]);
    return { inuse: kv.inuse ?? null, tw: kv.tw ?? null, orphan: kv.orphan ?? null };
  }
  return { inuse: null, tw: null, orphan: null };
}

/** 마운트 경로 — 원격 값이라 글자 · 길이를 제한한다(시리즈 이름 · 메타 열쇠가 된다). 공백 · 제어 글자 · '..' 가 든 경로는 버린다. */
const MNT_RE = /^\/[A-Za-z0-9._@+:,=-][A-Za-z0-9._@+:,=\/-]{0,126}$|^\/$/;
export const okMount = (m) => typeof m === 'string' && MNT_RE.test(m) && !m.includes('..') && !m.includes('//') && safeKey(m);
/** ##FS(df -P -l -T -k + 'rc N') → { rc, rows:[{m 마운트, t 종류, d 장치, kb 크기, used, avail, pct}] } · 사용률 = 사용 ÷ (사용 + 쓸 수 있는 양) — df 와 같은 분모(root 예약분 제외). */
export function parseFs(lines = []) {
  let rc = null; const rows = [];
  for (const l of lines) {
    const rm = /^rc (\d{1,3})$/.exec(l.trim());
    if (rm) { rc = Number(rm[1]); continue; }
    const f = words(l);
    if (f.length < 7 || f[0] === 'Filesystem') continue;
    const m = f.slice(6).join(' ');
    const [kb, used, avail] = [intOrNull(f[2]), intOrNull(f[3]), intOrNull(f[4])];
    if (!okMount(m) || kb == null || used == null || avail == null || rows.length >= 256 || rows.some((r) => r.m === m)) continue;
    const t = /^[a-z0-9._-]{1,24}$/.test(f[1]) ? f[1] : '?';
    const d = /^[A-Za-z0-9._:\/@+=-]{1,128}$/.test(f[0]) ? f[0] : '?';
    rows.push({ m, t, d, kb, used, avail, pct: used + avail > 0 ? Math.round((1000 * used) / (used + avail)) / 10 : null });
  }
  return { rc, rows };
}
/** ##FSI(df -P -l -i + 'rc N') → { rc, rows:[{m, ipct}] } — inode 수가 0(동적 · 모름)이면 null. */
/**
 * v3.16.0(⑯ C2) ##KMSG — `o <부팅 뒤 초> <이름>` · `e <줄 수> <마지막 초>` · `last <초>` · `rc <종료값>` · `on <OOM 전체 수>` · `f`(첫 확인) · `b <boot_id>`.
 * 시각은 글자 그대로(소수 6자리까지 — 같은 줄을 같은 열쇠로) · 이름은 COMM 규칙 · 20개 · 그 밖 줄은 버린다.
 * @returns {{rc:number|null, oom:Array<{s:string, c:string}>, en:number|null, es:string|null, last:string|null}}
 */
const KTS_RE = /^\d{1,10}(\.\d{1,6})?$/;
export const BOOT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function parseKmsg(lines = []) {
  const out = { rc: null, oom: [], en: null, es: null, last: null, on: null, f: false, bid: null };
  for (const l of lines.slice(0, 26)) {
    const f = words(l);
    if (f[0] === 'o' && f.length === 3 && KTS_RE.test(f[1]) && /^[A-Za-z0-9._:@+-]{1,64}$/.test(f[2]) && out.oom.length < 20) out.oom.push({ s: f[1], c: f[2] });
    else if (f[0] === 'e' && f.length === 3 && /^\d{1,9}$/.test(f[1]) && (f[2] === '0' || KTS_RE.test(f[2]))) { out.en = Number(f[1]); out.es = f[2] === '0' ? null : f[2]; }
    else if (f[0] === 'last' && f.length === 2 && KTS_RE.test(f[1])) out.last = f[1];
    else if (f[0] === 'rc' && f.length === 2 && /^\d{1,3}$/.test(f[1])) out.rc = Number(f[1]);
    else if (f[0] === 'on' && f.length === 2 && /^\d{1,9}$/.test(f[1])) out.on = Number(f[1]); // OOM 전체 수(20개를 넘을 때만 — 가장 최근 20개만 실린다)
    else if (f[0] === 'f' && f.length === 1) out.f = true; // 첫 확인(새 세션 — 커널 오류 수는 버퍼 전체)
    else if (f[0] === 'b' && f.length === 2 && BOOT_ID_RE.test(f[1])) out.bid = f[1]; // 부팅 식별(boot_id)
  }
  return out;
}

export function parseFsi(lines = []) {
  let rc = null; const rows = [];
  for (const l of lines) {
    const rm = /^rc (\d{1,3})$/.exec(l.trim());
    if (rm) { rc = Number(rm[1]); continue; }
    const f = words(l);
    if (f.length < 6 || f[0] === 'Filesystem') continue;
    const m = f.slice(5).join(' ');
    const [tot, iu] = [intOrNull(f[1]), intOrNull(f[2])];
    if (!okMount(m) || rows.length >= 256 || rows.some((r) => r.m === m)) continue;
    rows.push({ m, ipct: tot != null && tot > 0 && iu != null ? Math.round((1000 * iu) / tot) / 10 : null });
  }
  return { rc, rows };
}
/** FS + FSI → [{m, t, d, kb, pct, ipct}] · rc(df 종료값 — 137 = 시한에 걸림). xfs 는 inode 가 필요할 때 늘어 비율에 큰 뜻이 없어 null(시안 결정). */
export function mergeFs(fs, fsi) {
  if (!fs) return null;
  const im = new Map((fsi?.rows || []).map((r) => [r.m, r.ipct]));
  return { rc: fs.rc, irc: fsi?.rc ?? null, rows: fs.rows.map((r) => ({ m: r.m, t: r.t, d: r.d, kb: r.kb, pct: r.pct, ipct: r.t === 'xfs' ? null : (im.get(r.m) ?? null) })) };
}

/** ##LOAD → [1, 5, 15] 분 부하 + 실행/전체 스레드. */
export function parseLoad(lines = []) {
  const f = words(lines[0] || '');
  const rt = /^(\d{1,9})\/(\d{1,9})$/.exec(f[3] || '');
  return { load: [decOrNull(f[0]), decOrNull(f[1]), decOrNull(f[2])], runnable: rt ? Number(rt[1]) : null, threads: rt ? Number(rt[2]) : null };
}

/** ##MEM → 바이트. MemAvailable 이 없으면(커널 3.14 전 — RHEL 7 은 3.10 이지만 백포트로 있다) Free+Buffers+Cached 로 되돌리고 그 사실을 남긴다. */
export function parseMem(lines = []) {
  const kv = Object.create(null);
  for (const l of lines) {
    const m = /^([A-Za-z_()0-9]{1,32}):\s+(\d{1,20})(?: kB)?$/.exec(String(l).trim());
    if (m) kv[m[1]] = Number(m[2]) * 1024;
  }
  const total = kv.MemTotal ?? null;
  let avail = kv.MemAvailable ?? null; let availSource = 'MemAvailable';
  if (avail == null && kv.MemFree != null) { avail = kv.MemFree + (kv.Buffers ?? 0) + (kv.Cached ?? 0); availSource = 'MemFree+Buffers+Cached'; }
  return {
    total, avail, availSource, free: kv.MemFree ?? null,
    buffCache: kv.Buffers != null || kv.Cached != null ? (kv.Buffers ?? 0) + (kv.Cached ?? 0) + (kv.SReclaimable ?? 0) : null,
    swapTotal: kv.SwapTotal ?? null, swapFree: kv.SwapFree ?? null,
    dirty: kv.Dirty ?? null, slab: kv.Slab ?? null,
  };
}

/** ##NET(/proc/net/dev) → 인터페이스별 누적(수신 바이트 · 오류 · 드롭, 송신 바이트 · 오류 · 드롭). lo 는 뺀다. */
export function parseNetDev(lines = []) {
  const out = Object.create(null);
  for (const l of lines) {
    const i = l.indexOf(':');
    if (i < 1) continue;
    const name = l.slice(0, i).trim();
    if (!name || name === 'lo' || !/^[^\s:/]{1,32}$/.test(name) || !safeKey(name)) continue;
    const f = words(l.slice(i + 1)).map(intOrNull);
    if (f.length < 16 || f[0] == null || f[8] == null) continue;
    out[name] = { rxB: f[0], rxErr: f[2], rxDrop: f[3], txB: f[8], txErr: f[10], txDrop: f[11] };
  }
  return out;
}

/**
 * ##DISK(/proc/diskstats) → 장치별 11개 카운터. 커널 3.10(RHEL 7)은 14칸, 새 커널은 더 많지만 앞 14칸의 뜻은 같다.
 * [rdIos, rdMerges, rdSectors, rdTicks, wrIos, wrMerges, wrSectors, wrTicks, inFlight, ioTicks, timeInQueue]
 * 루프 · 램 · zram · 광학 장치는 뺀다(디스크 사용률이 아니다).
 */
export function parseDiskstats(lines = []) {
  const out = Object.create(null);
  for (const l of lines) {
    const f = words(l);
    if (f.length < 14) continue;
    const name = f[2];
    if (!/^[A-Za-z0-9_.!:+-]{1,64}$/.test(name) || !safeKey(name) || /^(loop|ram|zram|sr|fd)\d*$/.test(name)) continue;
    const v = f.slice(3, 14).map(intOrNull);
    if (v.some((x) => x == null)) continue;
    out[name] = v;
  }
  return out;
}

/** ##NETTOPO `i <이름> <속도|-1> <상태> <물리 0/1> <master|-> <본딩모드|-> <구성원,…|-> <active|->` */
export function parseNetTopo(lines = []) {
  const out = Object.create(null);
  const dash = (s) => (s && s !== '-' ? s : null);
  for (const l of lines) {
    const f = words(l);
    if (f[0] !== 'i' || f.length < 9) continue;
    const name = f[1];
    if (!/^[^\s:/]{1,32}$/.test(name) || !safeKey(name)) continue;
    const sp = /^-?\d{1,7}$/.test(f[2]) ? Number(f[2]) : null;
    out[name] = {
      speed: sp != null && sp > 0 ? sp : null, // -1 · 0 · 빈 값 = 모름(사용률을 내지 않는다)
      state: /^[a-z]{2,16}$/.test(f[3]) ? f[3] : 'unknown',
      phys: f[4] === '1',
      master: dash(f[5]) && /^[^\s:/]{1,32}$/.test(f[5]) ? f[5] : null,
      bondMode: dash(f[6]) && /^[a-z0-9-]{2,20}$/.test(f[6]) ? f[6] : null,
      slaves: dash(f[7]) ? f[7].split(',').filter((x) => /^[^\s:/]{1,32}$/.test(x) && safeKey(x)).slice(0, 16) : [],
      active: dash(f[8]) && /^[^\s:/]{1,32}$/.test(f[8]) ? f[8] : null,
    };
  }
  return out;
}

/**
 * lsblk -P 한 줄 → {NAME, KNAME, PKNAME, TYPE, SIZE, MOUNTPOINT}. 정규식 없이 한 번 훑는다(선형).
 * 값 안의 특수 문자는 lsblk 가 `\xNN` 으로 적는다 — 그대로 두고 화면은 글자로만 보인다.
 */
export function parseLsblkLine(line) {
  const s = String(line).slice(0, LINE_MAX);
  const out = Object.create(null);
  let i = 0;
  while (i < s.length) {
    while (s[i] === ' ') i += 1;
    const eq = s.indexOf('="', i);
    if (eq < 0) break;
    const key = s.slice(i, eq);
    const end = s.indexOf('"', eq + 2);
    if (end < 0) break;
    if (/^[A-Z:]{2,12}$/.test(key)) out[key] = s.slice(eq + 2, end);
    i = end + 1;
  }
  return out;
}

/** ##BLK → kname → {name, kname, parent, type, size, mount}. */
export function parseBlk(lines = []) {
  const out = Object.create(null);
  for (const l of lines) {
    const r = parseLsblkLine(l);
    const k = r.KNAME;
    if (!k || !/^[A-Za-z0-9_.!:+-]{1,64}$/.test(k) || !safeKey(k)) continue;
    if (out[k]) { // 같은 장치가 여러 부모 아래 나온다(멀티패스 등) — 첫 부모를 쓰고 마운트는 비어 있지 않은 것을 쓴다
      if (!out[k].mount && r.MOUNTPOINT) out[k].mount = r.MOUNTPOINT.slice(0, 200);
      continue;
    }
    out[k] = {
      name: String(r.NAME || k).slice(0, 128), kname: k,
      parent: r.PKNAME && /^[A-Za-z0-9_.!:+-]{1,64}$/.test(r.PKNAME) && safeKey(r.PKNAME) ? r.PKNAME : null,
      type: /^[a-z0-9_-]{1,16}$/.test(r.TYPE || '') ? r.TYPE : 'other',
      size: intOrNull(r.SIZE),
      mount: (r.MOUNTPOINT || '').slice(0, 200),
    };
  }
  return out;
}

/** ##PS → pid → 사용자 이름. */
export function parsePs(lines = []) {
  const out = new Map();
  for (const l of lines) {
    const f = words(l);
    if (f.length < 2 || !DIGITS.test(f[0])) continue;
    const u = f[1];
    if (/^[A-Za-z0-9._@+-]{1,32}$/.test(u)) out.set(Number(f[0]), u);
  }
  return out;
}

/**
 * ##PROC `pid ticks threads starttime rssPages comm [ppid utime stime nice vsizeBytes majflt blkioTicks state]` → 배열.
 * v2.981 이 comm 뒤에 8칸을 더했다 — 14칸이면 새 줄(comm 은 원격 awk 가 공백 없는 안전한 글자로 바꾼다), 6칸이면 옛 줄(새 칸 null), 그 밖은 버린다.
 */
export function parseProc(lines = []) {
  const out = [];
  for (const l of lines) {
    const f = words(l);
    // v2.981 반증 F4: 정확히 6칸(옛 줄) · 14칸(새 줄)만 — 빈 comm 이면 13칸이 돼 옛 경로로 '1_300_…' 같은 이름이 만들어졌다(원격도 빈 comm 을 '_' 로 바꾼다).
    if (f.length !== 6 && f.length !== 14) continue;
    const pid = intOrNull(f[0]); const ticks = intOrNull(f[1]); const thr = intOrNull(f[2]); const start = intOrNull(f[3]); const rss = intOrNull(f[4]);
    const ext = f.length === 14;
    const comm = f[5].slice(0, 64);
    if (pid == null || ticks == null || start == null || !/^[A-Za-z0-9._:@+-]{1,64}$/.test(comm)) continue;
    const row = { pid, ticks, thr, start, rss, comm, ppid: null, ut: null, st: null, ni: null, vsz: null, mf: null, bio: null, state: null };
    if (ext) {
      row.ppid = intOrNull(f[6]); row.ut = intOrNull(f[7]); row.st = intOrNull(f[8]);
      row.ni = /^-?\d{1,3}$/.test(f[9]) ? Number(f[9]) : null;
      row.vsz = intOrNull(f[10]); row.mf = intOrNull(f[11]); row.bio = intOrNull(f[12]);
      row.state = /^[A-Za-z]$/.test(f[13]) ? f[13] : null;
    }
    out.push(row);
  }
  return out;
}

/** 서비스 이름(v2.981) — `.service` · `.scope` 로 끝나는 안전한 글자만(점 둘 · 경로 글자 · 공백 없음). */
const UNIT_RE = /^(?!.*\.\.)[A-Za-z0-9@_:-][A-Za-z0-9@._:-]{0,95}$/;
/** ##UNIT `pid unit` → Map(pid → 서비스 이름). */
export function parseUnit(lines = []) {
  const out = new Map();
  for (const l of lines) {
    const f = words(l);
    if (f.length !== 2) continue;
    const pid = intOrNull(f[0]); const u = f[1];
    if (pid == null || !UNIT_RE.test(u) || !/\.(service|scope)$/.test(u)) continue;
    out.set(pid, u);
  }
  return out;
}

/** ##IO `pid readBytes writeBytes` → Map(pid → { r, w }) — 읽을 수 있었던 프로세스만(그 밖은 맵에 없다 = 모름). */
export function parseIo(lines = []) {
  const out = new Map();
  for (const l of lines) {
    const f = words(l);
    if (f.length !== 3) continue;
    const pid = intOrNull(f[0]); const r = intOrNull(f[1]); const w = intOrNull(f[2]);
    if (pid == null || r == null || w == null) continue;
    out.set(pid, { r, w });
  }
  return out;
}

/**
 * ##SELF(v2.983 수집 부하) → { self, sshd, groups } — 원격 반복문 셸(s) · sshd 세션(p)의 /proc/<pid>/stat ')' 뒤 칸과 세 묶음 누적 tick(c).
 *  · s/p: 칸 0 = 상태 글자, 11 utime · 12 stime · 13 cutime · 14 cstime · 21 rss(페이지) — 셸은 넷 합(끝난 자식 포함), sshd 는 utime + stime.
 *  · c: CB CC CP — 반복문이 시작된 뒤 묶음마다 더한 tick(정수 · 음수 없음).
 *  못 읽은 줄 · 칸이 모자란 줄은 null(0 아님). 같은 이름 줄이 둘이면 앞 것.
 */
export function parseSelf(lines = []) {
  const out = { self: null, sshd: null, groups: null };
  for (const l of lines) {
    const f = words(l);
    const k = f[0];
    if ((k === 's' || k === 'p') && out[k === 's' ? 'self' : 'sshd'] == null) {
      if (f.length < 23 || !/^[A-Za-z]$/.test(f[1])) continue;
      const v = f.slice(1).map(intOrNull); // v[0] 은 상태 글자(null)
      const ut = v[11]; const st = v[12]; const cu = v[13]; const cs = v[14]; const rss = v[21];
      if ([ut, st, cu, cs].some((x) => x == null)) continue;
      const rec = { ticks: k === 's' ? ut + st + cu + cs : ut + st, rssPages: rss };
      if (k === 's') out.self = rec; else out.sshd = rec;
    } else if (k === 'c' && out.groups == null) {
      if (f.length !== 4) continue;
      const g = f.slice(1).map(intOrNull);
      if (g.some((x) => x == null)) continue;
      out.groups = { base: g[0], topo: g[1], proc: g[2] };
    }
  }
  return out;
}

/**
 * 지연 집계(디스크 대기 tick)가 켜져 있나(v2.981) — HELLO `dacct <sysctl|-> <nodelayacct 개수>`.
 * sysctl 1/0 이 있으면 그 값(5.14 이후 · 기본 꺼짐) · 없으면(옛 커널 · RHEL 7) 부트 옵션 nodelayacct 가 없을 때 켜짐 · 줄이 없으면(옛 수집) 모름.
 */
export function delayAcctOf(v) {
  const m = /^(-|0|1)\s+(\d{1,4})$/.exec(String(v ?? '').trim());
  if (!m) return null;
  if (m[1] === '1') return true;
  if (m[1] === '0') return false;
  return Number(m[2]) === 0;
}

/** 프레임 → 원시 카운터 묶음(구획이 없으면 그 칸 null — 30초 구획은 보통 없다). */
export function frameToRaw(frame) {
  const s = frame?.sec || {};
  return {
    up: frame?.up ?? null, epoch: frame?.epoch ?? null,
    stat: s.STAT ? parseStat(s.STAT) : null,
    load: s.LOAD ? parseLoad(s.LOAD) : null,
    mem: s.MEM ? parseMem(s.MEM) : null,
    net: s.NET ? parseNetDev(s.NET) : null,
    disk: s.DISK ? parseDiskstats(s.DISK) : null,
    vm: s.VM ? parseVm(s.VM) : null, snmp: s.SNMP ? parseSnmp(s.SNMP) : null, sock: s.SOCK ? parseSock(s.SOCK) : null,
    fs: s.FS ? mergeFs(parseFs(s.FS), s.FSI ? parseFsi(s.FSI) : null) : null,
    kmsg: s.KMSG ? parseKmsg(s.KMSG) : null, // v3.16.0 ⑯ C2
    netTopo: s.NETTOPO ? parseNetTopo(s.NETTOPO) : null,
    blk: s.BLK ? parseBlk(s.BLK) : null,
    ps: s.PS ? parsePs(s.PS) : null,
    proc: s.PROC ? parseProc(s.PROC) : null,
    unit: s.UNIT ? parseUnit(s.UNIT) : null,
    io: s.IO ? parseIo(s.IO) : (s.PROC ? new Map() : null),
    self: s.SELF ? parseSelf(s.SELF) : null,
    bytes: frame?.bytes ? { ...frame.bytes } : null,
    truncated: Array.isArray(frame?.truncated) ? frame.truncated.slice() : [],
  };
}
