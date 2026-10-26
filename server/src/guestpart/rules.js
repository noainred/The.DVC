/**
 * guestpart/rules.js — 게스트 파티션 사용률 경보의 **순수 판정 코어**(v2.749). 파일·DB·타이머 없음 — 라우트·메일·테스트가 같이 쓴다.
 *
 * 사용자 요구: vCenter 의 모든 게스트 파티션에서 할당 대비 사용률이 지정한 %(기본 80) 이상인 게스트를 전체·특정 vCenter 로 본다.
 *   Windows/Linux 별로 무시할 파티션·드라이브를 정한다(시안 ③ 승인).
 *
 * ── 정의 ────────────────────────────────────────────────────────────────────
 *  · 사용률 = 사용 ÷ 용량 × 100(VMware Tools 가 보고한 게스트 파일시스템). 용량이 0 이하이거나 사용을 모르면 **null** — 0% 가 아니다.
 *  · OS 는 경로 모양으로 가린다: 'C:\' 처럼 드라이브 문자로 시작하거나 '\\' 로 시작하면 Windows, '/' 로 시작하면 Linux, 그 밖은 other.
 *    VM 의 게스트 OS 칸이 비어 있어도(Tools 가 OS 를 못 알아도) 판정된다.
 *  · 무시 규칙은 경보·메일에서만 뺀다(수집·저장은 그대로). 무시한 파티션은 이유와 함께 센다(조용히 사라지지 않게).
 *  · 판정 단위: 'part' = 파티션 하나라도 임계 이상이면 그 파티션이 초과 · 'vm' = VM 의 (무시하지 않은·값을 아는) 파티션 합계 사용률로 판정.
 *  · 임계는 vCenter 별 덮어쓰기(vcThresholds)가 있으면 그 값, 없으면 기본값.
 *
 * ── 패턴 ────────────────────────────────────────────────────────────────────
 *  · '*' 하나만 특수 문자(아무 글자, 0개 이상 — '/'·'\' 포함). 정규식을 쓰지 않는다(외부 입력 패턴 × 경로 1,024자 — ReDoS 규약).
 *    두 포인터 와일드카드 매칭이라 최악 O(경로 × 패턴)이다(둘 다 상한이 있다).
 *  · Windows 경로·VM 이름은 대소문자를 구분하지 않고, Linux 경로는 구분한다. Windows 는 끝의 '\' 유무를 같게 본다('E:\Backup' = 'E:\Backup\').
 */

export const RANGES = Object.freeze({
  threshold: Object.freeze({ min: 50, max: 99, def: 80 }),
  tinyGB: Object.freeze({ min: 0, max: 100, def: 1 }),
});
export const PATTERN_MAX = 50;
export const PATTERN_LEN_MAX = 200;
export const VC_THRESHOLD_MAX = 200;
export const MODES = Object.freeze(['part', 'vm']);
export const CRIT_PCT = 95;
/** Windows CD-ROM·ISO 추정: 남은 공간 0 이고 용량이 이 값(GB) 이하 — 경로로는 드라이브 종류를 알 수 없어 **추정**이다(화면 문구도 그렇게 말한다). C: 는 제외(v2.785 H-B4). */
export const WIN_ISO_MAX_GB = 10;

export const WIN_RULE_KEYS = Object.freeze(['reserved', 'iso', 'mountdir']);
export const LNX_RULE_KEYS = Object.freeze(['boot', 'virt', 'snap', 'iso', 'docker']);

export const DEFAULT_RULES = Object.freeze({
  win: Object.freeze({ letters: Object.freeze([]), reserved: true, iso: true, mountdir: false, patterns: Object.freeze([]) }),
  lnx: Object.freeze({ boot: true, virt: true, snap: true, iso: true, docker: false, patterns: Object.freeze([]) }),
  tinyOn: true, tinyGB: RANGES.tinyGB.def, vmPatterns: Object.freeze([]),
});

/** 무시 사유 코드 → 화면 문구(웹 guestPartText 의 표와 1:1 — 웹 테스트가 대조한다). */
export const IGNORE_TEXT = Object.freeze({
  'win-letter': 'Windows 드라이브 통째 무시', 'win-reserved': 'Windows 시스템 예약·복구 볼륨', 'win-iso': 'Windows CD-ROM·ISO(추정)',
  'win-mountdir': 'Windows 폴더 마운트 지점', 'win-pattern': 'Windows 경로 패턴',
  'lnx-boot': 'Linux /boot', 'lnx-virt': 'Linux 메모리 파일시스템(/dev·/run·/sys·/proc)', 'lnx-snap': 'Linux /snap', 'lnx-iso': 'Linux ISO·이동식 매체',
  'lnx-docker': 'Linux 컨테이너 overlay', 'lnx-pattern': 'Linux 마운트 지점 패턴', tiny: '작은 파티션', vm: 'VM 이름 패턴',
});

const NORMALIZED = Symbol('rulesOf');   // 이미 정규화한 규칙 표지(판정 루프가 파티션마다 다시 정규화하지 않게) — JSON 에 실리지 않는다
const CTRL = /[\u0000-\u001f\u007f]/;   // eslint-disable-line no-control-regex

/** 경로 → 'win' | 'lnx' | 'other'. */
export function osOfPath(path) {
  const s = String(path ?? '');
  if (/^[A-Za-z]:(\\|\/|$)/.test(s) || s.startsWith('\\\\')) return 'win';
  if (s.startsWith('/')) return 'lnx';
  return 'other';
}

/**
 * '*' 와일드카드 매칭(정규식 없음). ci = 대소문자 무시.
 * 고전 두 포인터 알고리즘 — 마지막 '*' 위치로 되돌아가며 한 칸씩 늘린다. 최악 O(n×m).
 */
export function globMatch(pattern, text, ci = false) {
  const p = ci ? String(pattern).toLowerCase() : String(pattern);
  const t = ci ? String(text).toLowerCase() : String(text);
  let i = 0; let j = 0; let star = -1; let mark = 0;
  while (i < t.length) {
    if (j < p.length && p[j] !== '*' && p[j] === t[i]) { i++; j++; continue; }
    if (j < p.length && p[j] === '*') { star = j++; mark = i; continue; }
    if (star >= 0) { j = star + 1; i = ++mark; continue; }
    return false;
  }
  while (j < p.length && p[j] === '*') j++;
  return j === p.length;
}

const winTrim = (s) => { let e = s.length; while (e > 3 && (s[e - 1] === '\\' || s[e - 1] === '/')) e--; return s.slice(0, e); };

/** 저장된 규칙(빈 값 보정). */
export function rulesOf(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const w = r.win && typeof r.win === 'object' ? r.win : {};
  const l = r.lnx && typeof r.lnx === 'object' ? r.lnx : {};
  const D = DEFAULT_RULES;
  const flag = (o, k, d) => (typeof o[k] === 'boolean' ? o[k] : d);
  const pats = (v, ok) => (Array.isArray(v) ? v : []).filter((x) => typeof x === 'string' && ok(x)).slice(0, PATTERN_MAX);
  const tiny = Number(r.tinyGB);
  return {
    win: {
      letters: [...new Set((Array.isArray(w.letters) ? w.letters : []).map((x) => String(x).toUpperCase()).filter((x) => /^[A-Z]$/.test(x)))].sort(),
      reserved: flag(w, 'reserved', D.win.reserved), iso: flag(w, 'iso', D.win.iso), mountdir: flag(w, 'mountdir', D.win.mountdir),
      patterns: pats(w.patterns, isWinPattern),
    },
    lnx: {
      boot: flag(l, 'boot', D.lnx.boot), virt: flag(l, 'virt', D.lnx.virt), snap: flag(l, 'snap', D.lnx.snap), iso: flag(l, 'iso', D.lnx.iso), docker: flag(l, 'docker', D.lnx.docker),
      patterns: pats(l.patterns, isLnxPattern),
    },
    tinyOn: flag(r, 'tinyOn', D.tinyOn),
    tinyGB: Number.isFinite(tiny) && tiny >= RANGES.tinyGB.min && tiny <= RANGES.tinyGB.max ? tiny : D.tinyGB,
    vmPatterns: pats(r.vmPatterns, isVmPattern),
    [NORMALIZED]: true,
  };
}

export function isWinPattern(s) { return typeof s === 'string' && s.length <= PATTERN_LEN_MAX && !CTRL.test(s) && (/^[A-Za-z*]:[\\/]/.test(s) || s.startsWith('\\\\')); }
export function isLnxPattern(s) { return typeof s === 'string' && s.length <= PATTERN_LEN_MAX && !CTRL.test(s) && s.startsWith('/') && !/\s/.test(s); }
export function isVmPattern(s) { return typeof s === 'string' && s.trim() !== '' && s.length <= 100 && !CTRL.test(s); }

/**
 * 규칙 정규화(저장 경로). 빠진 칸은 이전 값, 틀린 패턴은 저장하지 않고 { error, field } — 조용히 빼면 사용자가 넣은 규칙이 사라진다.
 */
export function normalizeRules(input, prev) {
  const p = rulesOf(prev);
  if (input == null) return { rules: p };
  if (typeof input !== 'object' || Array.isArray(input)) return { error: '무시 규칙 형식이 잘못됐습니다.', field: 'rules' };
  const w = input.win && typeof input.win === 'object' ? input.win : {};
  const l = input.lnx && typeof input.lnx === 'object' ? input.lnx : {};
  const list = (v, ok, field, what) => {
    if (v == null) return { keep: true };
    if (!Array.isArray(v)) return { error: `${what} 형식이 잘못됐습니다.`, field };
    const clean = [...new Set(v.map((x) => String(x ?? '').trim()).filter(Boolean))];
    const bad = clean.filter((x) => !ok(x));
    if (bad.length) return { error: `${what}이 올바르지 않습니다: ${bad.slice(0, 3).join(', ')}`, field };
    if (clean.length > PATTERN_MAX) return { error: `${what}은 ${PATTERN_MAX}개까지입니다.`, field };
    return { value: clean };
  };
  const wp = list(w.patterns, isWinPattern, 'rules.win.patterns', 'Windows 경로 패턴(C:\\ 처럼 드라이브 문자로 시작)');
  if (wp.error) return wp;
  const lp = list(l.patterns, isLnxPattern, 'rules.lnx.patterns', 'Linux 마운트 지점 패턴(/ 로 시작, 공백 없음)');
  if (lp.error) return lp;
  const vp = list(input.vmPatterns, isVmPattern, 'rules.vmPatterns', 'VM 이름 패턴');
  if (vp.error) return vp;
  let letters = p.win.letters;
  if (w.letters != null) {
    if (!Array.isArray(w.letters) || w.letters.some((x) => !/^[A-Za-z]$/.test(String(x)))) return { error: '드라이브 문자는 A~Z 한 글자여야 합니다.', field: 'rules.win.letters' };
    letters = [...new Set(w.letters.map((x) => String(x).toUpperCase()))].sort();
  }
  let tinyGB = p.tinyGB;
  if (input.tinyGB != null && input.tinyGB !== '') {
    const n = Number(input.tinyGB);
    if (!Number.isFinite(n) || n < RANGES.tinyGB.min || n > RANGES.tinyGB.max) return { error: `작은 파티션 기준은 ${RANGES.tinyGB.min}~${RANGES.tinyGB.max} GB 여야 합니다.`, field: 'rules.tinyGB' };
    tinyGB = n;
  }
  const fl = (o, k, d) => (typeof o[k] === 'boolean' ? o[k] : d);
  return {
    rules: {
      win: { letters, reserved: fl(w, 'reserved', p.win.reserved), iso: fl(w, 'iso', p.win.iso), mountdir: fl(w, 'mountdir', p.win.mountdir), patterns: wp.keep ? p.win.patterns : wp.value },
      lnx: { boot: fl(l, 'boot', p.lnx.boot), virt: fl(l, 'virt', p.lnx.virt), snap: fl(l, 'snap', p.lnx.snap), iso: fl(l, 'iso', p.lnx.iso), docker: fl(l, 'docker', p.lnx.docker), patterns: lp.keep ? p.lnx.patterns : lp.value },
      tinyOn: fl(input, 'tinyOn', p.tinyOn), tinyGB, vmPatterns: vp.keep ? p.vmPatterns : vp.value,
    },
  };
}

const under = (path, root) => path === root || path.startsWith(`${root}/`);

/**
 * 파티션 하나를 무시하는가 — 사유 코드(IGNORE_TEXT 의 키) 또는 null.
 * part: { path, capGB, usedGB, vmName }
 */
export function ignoreReason(part, rules) {
  const r = rules && rules[NORMALIZED] ? rules : rulesOf(rules);
  const path = String(part?.path ?? '');
  if (r.vmPatterns.length && r.vmPatterns.some((pt) => globMatch(pt, String(part?.vmName ?? ''), true))) return 'vm';
  const cap = part?.capGB == null ? null : Number(part.capGB);
  if (r.tinyOn && cap != null && Number.isFinite(cap) && cap < r.tinyGB) return 'tiny';
  const os = osOfPath(path);
  if (os === 'win') {
    if (path.startsWith('\\\\')) return r.win.reserved ? 'win-reserved' : null;
    const letter = path[0].toUpperCase();
    if (r.win.letters.includes(letter)) return 'win-letter';
    const t = winTrim(path);
    if (r.win.mountdir && t.length > 3) return 'win-mountdir';
    const used = part?.usedGB == null ? null : Number(part.usedGB);
    // v2.785(GH H-B4): C: 는 ISO 추정에서 뺀다 — GB 0.1 단위 반올림이라 여유 50MB 미만이면 used==cap 이 되어, 가득 찬 10GB 이하 C: 가
    //   정확히 가득 찬 순간 경보에서 빠졌다(99% 는 울리고 100% 는 침묵). OS 드라이브가 CD-ROM 일 수는 없다. 기본 켜짐·D: 이후 추정은 그대로.
    if (r.win.iso && letter !== 'C' && cap != null && used != null && cap > 0 && cap <= WIN_ISO_MAX_GB && used >= cap) return 'win-iso';
    if (r.win.patterns.some((pt) => globMatch(winTrim(pt), t, true) || globMatch(pt, path, true))) return 'win-pattern';
    return null;
  }
  if (os === 'lnx') {
    if (r.lnx.boot && under(path, '/boot')) return 'lnx-boot';
    if (r.lnx.virt && ['/dev', '/run', '/sys', '/proc'].some((x) => under(path, x))) return 'lnx-virt';
    if (r.lnx.snap && under(path, '/snap')) return 'lnx-snap';
    if (r.lnx.iso && (path.startsWith('/mnt/cdrom') || path.startsWith('/media/') || path === '/media')) return 'lnx-iso';
    if (r.lnx.docker && ['/var/lib/docker', '/var/lib/containers', '/var/lib/kubelet/pods'].some((x) => under(path, x))) return 'lnx-docker';
    if (r.lnx.patterns.some((pt) => globMatch(pt, path, false))) return 'lnx-pattern';
    return null;
  }
  return null;
}

/** 사용률(%) — 소수 1자리. 모르면 null. */
export function pctOf(usedGB, capGB) {
  if (usedGB == null || capGB == null) return null;
  const u = Number(usedGB); const c = Number(capGB);
  if (!Number.isFinite(u) || !Number.isFinite(c) || !(c > 0)) return null;
  return Math.round((u / c) * 1000) / 10;
}

/** 임계(%) 정규화 — 범위 안 정수만, 아니면 null. */
export function thresholdOk(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= RANGES.threshold.min && n <= RANGES.threshold.max ? n : null;
}

/** 그 vCenter 의 임계 — 덮어쓰기가 있으면 그 값. */
export function thresholdFor(vcenterId, settings) {
  const o = settings?.vcThresholds?.[String(vcenterId)];
  return thresholdOk(o) ?? thresholdOk(settings?.threshold) ?? RANGES.threshold.def;
}

/**
 * 판정(순수). parts = listPartLatest 행. 반환:
 *  { parts:[{...part, os, pct, ignored, over, crit, thr}], vms: Map<vmId,{...}> } — vms 는 VM 합계(무시·값 모름 제외).
 * thrOverride: 화면에서 고른 임계(모든 vCenter 공통) — 주면 vCenter 별 덮어쓰기보다 우선한다(화면 슬라이더).
 */
export function evaluate(parts, settings, { thrOverride = null, mode = null } = {}) {
  const rules = rulesOf(settings?.rules);
  const m = MODES.includes(mode) ? mode : (MODES.includes(settings?.mode) ? settings.mode : 'part');
  const thrOf = (vc) => thresholdOk(thrOverride) ?? thresholdFor(vc, settings);
  const out = [];
  const vms = new Map();
  for (const p of parts || []) {
    const thr = thrOf(p.vcenterId);
    const ignored = ignoreReason(p, rules);
    const pct = p.unknown ? null : pctOf(p.usedGB, p.capGB);
    const row = { ...p, os: osOfPath(p.path), pct, ignored, thr, over: false, crit: false };
    out.push(row);
    let v = vms.get(p.vmId);
    if (!v) { v = { vmId: p.vmId, vmName: p.vmName, vcenterId: p.vcenterId, vcenterName: p.vcenterName, capGB: 0, usedGB: 0, known: 0, unknown: 0, ignored: 0, parts: 0, thr, ts: p.ts }; vms.set(p.vmId, v); }
    v.parts++;
    if (ignored) { v.ignored++; continue; }
    if (pct == null) { v.unknown++; continue; }
    v.known++; v.capGB += Number(p.capGB); v.usedGB += Number(p.usedGB);
    if (m === 'part' && pct >= thr) { row.over = true; row.crit = pct >= CRIT_PCT; }
  }
  for (const v of vms.values()) {
    v.capGB = Math.round(v.capGB * 10) / 10; v.usedGB = Math.round(v.usedGB * 10) / 10;
    v.pct = v.known ? pctOf(v.usedGB, v.capGB) : null;
    v.maxPct = null;
    v.over = false; v.crit = false;
  }
  for (const r of out) {
    if (r.ignored || r.pct == null) continue;
    const v = vms.get(r.vmId);
    if (v.maxPct == null || r.pct > v.maxPct) v.maxPct = r.pct;
  }
  for (const v of vms.values()) {
    if (m === 'vm') { v.over = v.pct != null && v.pct >= v.thr; v.crit = v.over && v.pct >= CRIT_PCT; }
  }
  if (m === 'part') {
    // 파티션 단위면 VM 은 '초과 파티션이 하나라도 있는가' 다 — 집합으로 한 번에 모은다(VM×파티션 이중 루프를 피한다).
    const overVm = new Set(out.filter((r) => r.over).map((r) => r.vmId));
    const critVm = new Set(out.filter((r) => r.crit).map((r) => r.vmId));
    for (const v of vms.values()) { v.over = overVm.has(v.vmId); v.crit = critVm.has(v.vmId); }
  }
  return { mode: m, parts: out, vms };
}

/** 메일 '새로 넘음' 비교용 키 — 판정 단위에 따라 파티션(vmId+경로) 또는 VM. */
export function overKeys(ev) {
  if (ev.mode === 'vm') return [...ev.vms.values()].filter((v) => v.over).map((v) => v.vmId);
  return ev.parts.filter((r) => r.over).map((r) => `${r.vmId}\u0000${r.path}`);
}

/**
 * 가득 참 예상(일) — 지난 7일 증가(GB)를 그대로 이어 간 단순 추정. 증가가 없거나(≤0) 모르면 null.
 * growthGB 는 diff-저장(변화가 기준 GB 이상일 때만 기록) 기준이라 그만큼 오차가 있다 — 화면 문구가 말한다.
 */
export function etaDays(freeGB, growth7dGB) {
  const f = Number(freeGB); const g = Number(growth7dGB);
  if (growth7dGB == null || !Number.isFinite(g) || g <= 0 || !Number.isFinite(f)) return null;
  return Math.max(0, Math.round((f / (g / 7)) * 10) / 10);
}

/** 사용률 구간(히스토그램) — 경계는 '이상' 쪽. 값 모름·무시는 세지 않는다(따로 센다). */
export const HIST_BINS = Object.freeze([[0, 50], [50, 60], [60, 70], [70, 80], [80, 90], [90, 95], [95, 101]]);
export function histogram(rows) {
  const counts = HIST_BINS.map(() => 0);
  for (const r of rows) {
    if (r.ignored || r.pct == null) continue;
    const i = HIST_BINS.findIndex(([a, b]) => r.pct >= a && r.pct < b);
    if (i >= 0) counts[i]++;
  }
  return HIST_BINS.map(([a, b], i) => ({ from: a, to: Math.min(b, 100), count: counts[i] }));
}

