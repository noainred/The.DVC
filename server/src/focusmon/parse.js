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

export const SECTIONS = Object.freeze(['STAT', 'LOAD', 'MEM', 'NET', 'DISK', 'NETTOPO', 'BLK', 'PS', 'PROC']);
const ORDER = Object.freeze(Object.fromEntries(SECTIONS.map((s, i) => [s, i])));
/** 구획별 줄 수 상한(스크립트의 head -n 과 같거나 조금 크다). */
export const SECTION_MAX_LINES = Object.freeze({ STAT: 1100, LOAD: 4, MEM: 128, NET: 258, DISK: 1024, NETTOPO: 256, BLK: 512, PS: 20000, PROC: 20000 });
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
  let frame = null; let cur = null; let curOrder = -1; let broken = false; let chars = 0;
  const st = { frames: 0, dropped: 0, stray: 0, hellos: 0, oversize: 0 };

  const startFrame = (up, epoch) => {
    if (mode === 'frame' && frame) st.dropped += 1; // END 없이 다음 프레임 — 앞 것은 버린다
    frame = { up, epoch, sec: Object.create(null), truncated: [] }; cur = null; curOrder = -1; broken = false; chars = 0; mode = 'frame';
  };

  function push(raw) {
    const rawStr = String(raw ?? '');
    const line = rawStr.slice(0, LINE_MAX);
    if (line === '##HELLO 1') { if (mode === 'frame') st.dropped += 1; mode = 'hello'; hello = []; frame = null; return; }
    const tm = line.startsWith('##T ') ? T_RE.exec(line) : null;
    if (tm) { startFrame(Number(tm[1]), Number(tm[2])); return; }
    if (line === '##END') {
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
      return;
    }
    if (mode === 'hello') { if (hello.length < HELLO_MAX_LINES) hello.push(line); return; }
    if (mode === 'frame' && frame && cur) {
      if (broken) return;
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
    hostname: (kv.host || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64),
  };
}

/** ##STAT → 전체 · 코어별 jiffies(앞 8칸: user nice system idle iowait irq softirq steal) + 실행 · 대기 프로세스 수. */
export function parseStat(lines = []) {
  let all = null; const cores = []; let running = null; let blocked = null;
  for (const l of lines) {
    const f = words(l);
    if (f[0] === 'procs_running') { running = intOrNull(f[1]); continue; }
    if (f[0] === 'procs_blocked') { blocked = intOrNull(f[1]); continue; }
    const m = /^cpu(\d{0,4})$/.exec(f[0]);
    if (!m) continue;
    const v = f.slice(1, 9).map(intOrNull);
    if (v.length < 4 || v.slice(0, 4).some((x) => x == null)) continue;
    while (v.length < 8) v.push(0); // 아주 옛 커널은 steal 이 없다 — 칸이 없는 것은 0(카운터가 없다 = 그 시간 0)
    if (m[1] === '') all = v; else { const i = Number(m[1]); if (i < 1024) cores[i] = v; }
  }
  return { all, cores: cores.filter(Boolean).length ? cores : [], running, blocked };
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

/** ##PROC `pid ticks threads starttime rssPages comm` → 배열. */
export function parseProc(lines = []) {
  const out = [];
  for (const l of lines) {
    const f = words(l);
    if (f.length < 6) continue;
    const pid = intOrNull(f[0]); const ticks = intOrNull(f[1]); const thr = intOrNull(f[2]); const start = intOrNull(f[3]); const rss = intOrNull(f[4]);
    const comm = f.slice(5).join('_').slice(0, 64);
    if (pid == null || ticks == null || start == null || !/^[A-Za-z0-9._:@+-]{1,64}$/.test(comm)) continue;
    out.push({ pid, ticks, thr, start, rss, comm });
  }
  return out;
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
    netTopo: s.NETTOPO ? parseNetTopo(s.NETTOPO) : null,
    blk: s.BLK ? parseBlk(s.BLK) : null,
    ps: s.PS ? parsePs(s.PS) : null,
    proc: s.PROC ? parseProc(s.PROC) : null,
    truncated: Array.isArray(frame?.truncated) ? frame.truncated.slice() : [],
  };
}
