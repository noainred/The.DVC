/**
 * focusmon/audit/parse.js — 디스크 점검 출력 해석(순수 · 선형 · 상한). 중앙이 **원문에서** 다시 만든다 — 엣지가 보낸 해석값은 믿지 않는다.
 *
 *  · parseReady  — 준비 확인(`##DR …`) → python · 두 파일(sha · 소유자 · 권한) · 경로 폴더 · sudo · 서버 모델
 *  · readyState  — 위 값 + 포탈 판본 → 'ready' | 'nopy' | 'pyold' | 'notinstalled' | 'unreadable' | 'version' | 'owner' | 'nosudo' | 'bad-output'
 *  · splitRun    — 실행 출력(`##DA …`) → 보고서 줄 · 종료값 · 디스크 목록(lsblk · RAID) · 오류 표지. **표지는 첫 줄의 난수가 붙은 줄만**(반증 F2 — 보고서에는
 *                  대상 서버 로그 내용이 들어가고 일반 계정도 줄바꿈이 든 로그를 남길 수 있다).
 *  · parseReport — 받은 프로그램의 보고서 글자 → 판정 줄 · 인벤토리 · 읽은 자료 · 근거 · 해석 범위 + **모양 검사**(shape — 구획 순서 · 완료 줄 · 근거 번호 ·
 *                  판정 건수 합). 받은 프로그램이 줄바꿈을 지우지 않아 로그 한 줄이 보고서 여러 줄이 될 수 있다 — 숫자를 바꾸는 꼴이면 그 회차의 숫자를 쓰지 않는다.
 *  · parseDisks  — 디스크 목록 → [{식별자 · 모델 · 크기 · 종류}]
 *  · summarize   — 위 둘을 합쳐 화면 · 묶어 보기가 쓰는 요약(종류별 줄 수 · 물리 디스크별 기록 · 모델)
 *
 * 프로그램의 글자 꼴은 rhel_disk_audit.py 의 emit 문자열 그대로다(바꾸면 이 파일과 픽스처 테스트를 같이 고친다).
 * 판정 글자([확정] · [추정] · [불명])는 **옮기기만** 한다 — 이 파일은 새 판정을 만들지 않는다(숫자는 줄 수일 뿐 장애 횟수가 아니다).
 */

export const LINE_MAX = 8000;           // 한 줄 상한(넘으면 자르고 표시)
export const REPORT_LINES_MAX = 60_000; // 해석할 보고서 줄 상한(원문 보관은 바이트 상한이 따로)
export const EVIDENCE_MAX = 2000;       // 화면 · 요약에 싣는 근거 줄 상한(넘으면 개수만)
export const DISK_ROWS_MAX = 1024;

export const ERROR_KINDS = Object.freeze(['매체 오류 기록', 'I/O·경로 오류 기록', '재할당 기록']);
export const OTHER_KINDS = Object.freeze(['파일시스템 생성 성공 기록', '파일시스템 생성 명령']);
const ALL_KINDS = new Set([...ERROR_KINDS, ...OTHER_KINDS]);
export const KIND_KEY = Object.freeze({ '매체 오류 기록': 'media', 'I/O·경로 오류 기록': 'io', '재할당 기록': 'realloc', '파일시스템 생성 성공 기록': 'fsok', '파일시스템 생성 명령': 'fscmd' });
export const VIRTUAL_SCOPE = '가상/논리 또는 RAID 경유 OS 장치';
export const SECTIONS = Object.freeze(['로그 수집 범위', 'PERC/StorCLI 조회', 'OS/SMART 조회', 'RAID 경유 물리 SMART 조회', '현재 디스크 인벤토리', '판정', '상세 근거', '해석 범위']);
const SECTION_SET = new Set(SECTIONS);
export const MIN_PY = [3, 6];

// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
/** 한 줄 정리 — 제어 문자 → '?' · 길이 상한 · 끝 공백(선형 — 정규식 /\s+$/ 금지 규약). */
export function cleanLine(s, max = LINE_MAX) {
  let t = String(s ?? '');
  if (t.length > max) t = `${t.slice(0, max)}…(잘림)`;
  t = t.replace(CTRL, '?');
  let e = t.length; while (e > 0 && (t.charCodeAt(e - 1) === 32 || t.charCodeAt(e - 1) === 9 || t.charCodeAt(e - 1) === 13)) e -= 1;
  return e === t.length ? t : t.slice(0, e);
}
const lead = (s) => { let i = 0; while (i < s.length && s.charCodeAt(i) === 32) i += 1; return i; };

/* ── 식별자(프로그램의 identity() 와 같은 규칙) ──────────────────────────── */
const SERIAL_OK = /^[A-Za-z0-9_.-]{1,64}$/;
const SERIAL_BAD = new Set(['none', 'unknown', 'n/a', 'na', 'null', 'serial', 'default']);
export function normSerial(v) {
  const s = String(v ?? '').trim();
  if (!SERIAL_OK.test(s) || SERIAL_BAD.has(s.toLowerCase())) return '';
  let only = true; for (const ch of s) if (ch !== '0' && ch !== '.' && ch !== '-') { only = false; break; }
  return only ? '' : s;
}
export function normWwn(v) {
  let s = String(v ?? '').trim().toLowerCase();
  for (const p of ['0x', 'naa.', 'eui.']) if (s.startsWith(p)) { s = s.slice(p.length); break; }
  if (!/^(?:[0-9a-f]{16}|[0-9a-f]{32})$/.test(s)) return '';
  let only = true; for (const ch of s) if (ch !== '0' && ch !== 'f') { only = false; break; }
  return only ? '' : s;
}
/** 'SN=ZC1 WWN=5000…' → {sn, wwn}. '식별자 없음' → {} */
export function parseIds(text) {
  const out = {};
  for (const tok of String(text || '').split(' ')) {
    const i = tok.indexOf('=');
    if (i <= 0) continue;
    const k = tok.slice(0, i); const v = tok.slice(i + 1);
    if (k === 'SN' && !out.sn) { const s = normSerial(v); if (s) out.sn = s; }
    if (k === 'WWN' && !out.wwn) { const w = normWwn(v); if (w) out.wwn = w; }
  }
  return out;
}
/** 같은 디스크인가 — 겹치는 식별자가 있고, 같은 종류의 식별자가 서로 다르지 않다(프로그램의 same_disk). */
export function sameDisk(a, b) {
  if (!a || !b) return false;
  const shared = (a.sn && a.sn === b.sn) || (a.wwn && a.wwn === b.wwn);
  if (!shared) return false;
  if (a.sn && b.sn && a.sn !== b.sn) return false;
  if (a.wwn && b.wwn && a.wwn !== b.wwn) return false;
  return true;
}

/* ── 준비 확인 ─────────────────────────────────────────────────────────── */
const FILE_LINE = /^##DR file (\S{1,200}) (\S{1,80}) (\S{1,40})$/;
const DIR_LINE = /^##DR dir (\S{1,200}) (\S{1,40})$/;
const OWN = /^(\d{1,10}):(\d{1,10}):([0-7]{3,4})$/;
function ownOf(s) { const m = OWN.exec(String(s || '')); return m ? { uid: Number(m[1]), gid: Number(m[2]), mode: parseInt(m[3], 8) } : null; }

export function parseReady(lines) {
  // 원격 줄에서 온 이름을 열쇠로 쓰는 표는 프로토타입 없는 객체(반증 F9-g — '__proto__' 줄)
  const r = { begun: false, ended: false, py: null, pyVer: null, files: Object.create(null), dirs: Object.create(null), sudo: null, dmi: null };
  for (const raw of (Array.isArray(lines) ? lines : String(lines || '').split('\n')).slice(0, 200)) {
    const l = cleanLine(raw, 400);
    if (l === '##DR 1') { r.begun = true; continue; }
    if (l === '##DR end') { r.ended = true; continue; }
    if (l.startsWith('##DR py ')) {
      const v = l.slice(8).trim();
      const m = /^(\d{1,2})\.(\d{1,3})\.(\d{1,3})$/.exec(v);
      r.py = v !== '-' && v !== ''; r.pyVer = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
      continue;
    }
    let m = FILE_LINE.exec(l);
    if (m) {
      const [, p, sha, own] = m;
      r.files[p] = sha === '-' ? { present: false } : sha === 'unreadable' ? { present: true, readable: false } : { present: true, readable: true, sha: /^[0-9a-f]{64}$/.test(sha) ? sha : null, own: ownOf(own) };
      continue;
    }
    m = DIR_LINE.exec(l);
    if (m) { r.dirs[m[1]] = ownOf(m[2]); continue; }
    if (l === '##DR sudo ok') { r.sudo = true; continue; }
    if (l === '##DR sudo no') { r.sudo = false; continue; }
    if (l.startsWith('##DR dmi ')) {
      const v = l.slice(9); const i = v.indexOf('|');
      const vendor = cleanLine(i >= 0 ? v.slice(0, i) : v, 64).trim(); const product = cleanLine(i >= 0 ? v.slice(i + 1) : '', 64).trim();
      r.dmi = vendor || product ? { vendor: vendor || null, product: product || null } : null;
    }
  }
  return r;
}

const safeOwn = (o, { file }) => !!o && o.uid === 0 && (o.mode & 0o022) === 0 && (!file || (o.mode & 0o6000) === 0);

/**
 * 준비 판정(판정 코어 — 화면 · 실행 문 · 묶어 보기가 이 값 하나를 쓴다).
 * @returns {{state:string, reason:string}}
 */
export function readyState(r, { programPath, wrapperPath, programSha, wrapperSha, dirs = null }) {
  if (!r || !r.begun || !r.ended) return { state: 'bad-output', reason: '준비 확인 출력을 끝까지 받지 못했습니다(셸이 sh 계열인지 확인하세요).' };
  if (!r.py) return { state: 'nopy', reason: 'python3 가 없습니다 — 점검 프로그램은 Python 3.6 이상이 필요합니다.' };
  if (!r.pyVer || r.pyVer[0] < MIN_PY[0] || (r.pyVer[0] === MIN_PY[0] && r.pyVer[1] < MIN_PY[1])) {
    return { state: 'pyold', reason: `python3 판이 낮거나 읽지 못했습니다(${r.pyVer ? r.pyVer.join('.') : '판 모름'}) — 3.6 이상이 필요합니다.` };
  }
  const p = r.files[programPath]; const w = r.files[wrapperPath];
  if (!p?.present || !w?.present) return { state: 'notinstalled', reason: '점검 프로그램이 설치돼 있지 않습니다 — 설치 파일을 root 로 실행해 주세요.' };
  if (p.readable === false || w.readable === false) return { state: 'unreadable', reason: '설치된 파일을 수집 계정이 읽지 못해 판본을 확인할 수 없습니다 — 설치 파일로 다시 설치해 주세요(0644 · 0755).' };
  if (p.sha !== programSha || w.sha !== wrapperSha) return { state: 'version', reason: '설치된 파일이 포탈 판본과 다릅니다 — 무엇이 실행될지 알 수 없어 실행하지 않습니다. 설치 파일로 다시 설치해 주세요.' };
  // v3.17.0: 경로 폴더는 설치 디렉터리에 따라(bundle.dirsToCheck — all: 있으면 root 소유 · 쓰기 금지 · need: 있어야 함). 주지 않으면 기본 경로(예전 그대로).
  const D = dirs || { all: ['/usr/local/libexec/dvc', '/usr/local/libexec', '/usr/local/sbin', '/usr/local'], need: ['/usr/local/libexec/dvc', '/usr/local/sbin'] };
  if (!safeOwn(p.own, { file: true }) || !safeOwn(w.own, { file: true }) || D.all.some((d) => r.dirs[d] !== undefined && r.dirs[d] !== null && !safeOwn(r.dirs[d], { file: false }))
    || D.need.some((d) => !r.dirs[d])) {
    return { state: 'owner', reason: '설치 파일이나 경로 폴더가 root 소유가 아니거나 다른 계정이 쓸 수 있습니다 — root 로 도는 파일을 바꿀 수 있게 되므로 실행하지 않습니다.' };
  }
  if (r.sudo !== true) return { state: 'nosudo', reason: '수집 계정이 점검 실행 파일을 비밀번호 없이 root 로 실행할 권한(sudoers 한 줄)이 없습니다.' };
  return { state: 'ready', reason: '' };
}

/* ── 실행 출력 나누기 ───────────────────────────────────────────────────── */
/** 실행 파일 첫 줄 — 판 2 · 실행마다 만든 표지(난수 16자). */
export const BEGIN_RE = /^##DA BEGIN 2 ([0-9a-f]{16})$/;
/** 실행 파일이 프로그램을 돌리기 전에 내는 오류(첫 줄). */
export const WRAPPER_ERRS = Object.freeze(['args', 'nopython', 'busy', 'tmp', 'nonce']);
/** 실행 출력의 첫 줄이 실행 파일의 줄인가 → {nonce} | {err} | null(실행 파일 출력이 아니다). 출력 보관(runner)과 나누기가 같은 판정을 쓴다. */
export function firstLineOf(l) {
  const m = BEGIN_RE.exec(String(l ?? ''));
  if (m) return { nonce: m[1] };
  const t = String(l ?? '');
  if (t.startsWith('##DA ERR ') && t.length <= 40) { const e = t.slice(9); return { err: WRAPPER_ERRS.includes(e) ? e : 'other' }; }
  return null;
}
/** 표지 줄 → 'EXIT n' · 'DISKS' · 'RAID' · 'END' 의 뒷부분(그 실행의 표지가 붙은 줄만) | null */
export function markOf(l, nonce) {
  if (!nonce) return null;
  const tag = `##DA ${nonce} `;
  const t = String(l ?? '');
  if (!t.startsWith(tag) || t.length > tag.length + 16) return null;
  const v = t.slice(tag.length);
  if (v === 'DISKS' || v === 'RAID' || v === 'END' || /^EXIT \d{1,3}$/.test(v)) return v;
  return null;
}
/**
 * @param {string[]} lines  실행 출력 줄(그대로)
 * @returns {{begun:boolean, ended:boolean, err:string|null, rc:number|null, nonce:string|null, report:string[], lsblk:string[], raid:string[]}}
 *  · 첫 줄(빈 줄 제외)이 BEGIN 이면 그 표지가 붙은 줄만 표지다 — 표지 없는 `##DA` 줄은 보고서 글자다(로그에서 온 것일 수 있다).
 *  · 첫 줄이 ERR 이면 실행 파일이 프로그램을 돌리지 않았다. 그 밖이면 실행 파일 출력이 아니다(아무것도 받지 않는다).
 *  · 같은 표지가 되풀이되면 처음 것만 · END 뒤는 버린다.
 */
export function splitRun(lines) {
  const out = { begun: false, ended: false, err: null, rc: null, nonce: null, report: [], lsblk: [], raid: [] };
  let part = ''; let started = false; const seen = new Set();
  for (const raw of lines || []) {
    const l = String(raw ?? '');
    if (!started) {
      if (!l) continue;
      started = true;
      const f = firstLineOf(l);
      if (f?.nonce) { out.begun = true; out.nonce = f.nonce; part = 'report'; continue; }
      if (f?.err) out.err = f.err;
      break;
    }
    const mk = markOf(l, out.nonce);
    if (mk) {
      const kind = mk.startsWith('EXIT ') ? 'EXIT' : mk;
      if (seen.has(kind)) continue;
      seen.add(kind);
      if (kind === 'EXIT') { const n = Number(mk.slice(5)); out.rc = Number.isInteger(n) && n >= 0 && n < 512 ? n : null; part = ''; continue; }
      if (kind === 'DISKS') { part = 'lsblk'; continue; }
      if (kind === 'RAID') { part = 'raid'; continue; }
      out.ended = true; break; // END
    }
    if (part === 'report') { if (out.report.length < REPORT_LINES_MAX) out.report.push(l); else out.reportCut = true; }
    else if (part === 'lsblk') { if (out.lsblk.length < DISK_ROWS_MAX) out.lsblk.push(l); }
    else if (part === 'raid') { if (out.raid.length < 8000) out.raid.push(l); }
  }
  return out;
}

/** 실행 출력의 한 줄이 보고서의 구획 머리인가 → 구획 이름(진행 단계 표시용). */
export function sectionOf(line) {
  const l = String(line || '');
  if (l.length < 3 || l.length > 40 || l[0] !== '[' || l[l.length - 1] !== ']') return null;
  const n = l.slice(1, -1);
  return SECTION_SET.has(n) ? n : null;
}

/* ── 보고서 ─────────────────────────────────────────────────────────────── */
const SOURCE_LINE = /^(.{1,300}) \| ([\d,]{1,12})줄, 후보 ([\d,]{1,12})줄, 해석 실패 ([\d,]{1,12})줄 \| (.{1,80}) ~ (.{1,80})$/;
const SLOT_RE = /^\/c\d{1,3}(?:\/e\d{1,4})?\/s\d{1,4}$/;
const num = (s) => { const n = Number(String(s).replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
const isoOk = (s) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(s);

/** describe(item) 한 줄 → 근거. '[종류] 위치 | 시각 | 식별자[ | 장치 x][ | /cN/eN/sN] | 기록' */
export function parseEvidence(text) {
  const t = String(text || '');
  if (t[0] !== '[') return null;
  const close = t.indexOf('] ');
  if (close < 2) return null;
  const kind = t.slice(1, close);
  if (!ALL_KINDS.has(kind)) return null;
  const parts = t.slice(close + 2).split(' | ');
  if (parts.length < 4) return null;
  const loc = parts[0]; const when = parts[1]; const idsText = parts[2];
  let i = 3; let dev = ''; let slot = '';
  if (parts[i] && parts[i].startsWith('장치 ') && parts.length > i + 1) { dev = parts[i].slice(3); i += 1; }
  if (parts[i] && SLOT_RE.test(parts[i]) && parts.length > i + 1) { slot = parts[i]; i += 1; }
  const colon = loc.lastIndexOf(':');
  const lineNo = colon > 0 && /^\d{1,9}$/.test(loc.slice(colon + 1)) ? Number(loc.slice(colon + 1)) : null;
  return {
    kind, key: KIND_KEY[kind], source: lineNo != null ? loc.slice(0, colon) : loc, line: lineNo,
    when: isoOk(when) ? when : null, ids: parseIds(idsText), idsText: idsText === '식별자 없음' ? '' : idsText,
    dev: cleanLine(dev, 120), slot, message: cleanLine(parts.slice(i).join(' | '), 2000),
  };
}

/**
 * 받은 프로그램의 보고서 → 구조. 구획이 없거나 모르는 줄은 버리고 센다(other).
 * @param {string|string[]} text
 */
export function parseReport(text) {
  const lines = Array.isArray(text) ? text : String(text || '').split('\n');
  const r = {
    header: null, complete: false, sections: [], verdicts: [], inventory: [], sources: [], missing: [], partial: [], evidence: [], others: [],
    evidenceTotal: 0, counts: { media: 0, io: 0, realloc: 0, fsok: 0, fscmd: 0 }, gaps: null, scope: [], judgeCounts: {}, fsPattern: null,
    cutSections: [], linesCut: lines.length > REPORT_LINES_MAX, shape: [], idCounts: new Map(), idCountsCut: false, unattributedAll: 0,
  };
  let sec = ''; let doneSeen = 0; let nextNo = 1; let unnumberedSeen = false; let rank = -1;
  const issue = (k) => { if (!r.shape.includes(k)) r.shape.push(k); };
  for (let k = 0; k < Math.min(lines.length, REPORT_LINES_MAX); k += 1) {
    const raw = cleanLine(lines[k]);
    if (!raw) continue;
    if (k < 3 && raw.startsWith('RHEL 디스크 오류 이력 점검 | ')) { r.header = raw.slice('RHEL 디스크 오류 이력 점검 | '.length); continue; }
    if (raw.startsWith('…(이 구획 ') && raw.endsWith('생략)')) { r.cut = (r.cut || 0) + 1; if (sec && !r.cutSections.includes(sec)) r.cutSections.push(sec); continue; }
    if (doneSeen) { issue('after-done'); continue; } // 완료 줄 뒤에는 아무 줄도 없다(프로그램의 마지막 줄)
    const s = sectionOf(raw);
    if (s) {
      // 모양 검사 — 구획은 프로그램 순서대로 한 번씩만 나온다(되풀이 · 거꾸로 = 로그에서 온 줄)
      const i = SECTIONS.indexOf(s);
      if (r.sections.includes(s) || i < rank) issue('section-order');
      rank = Math.max(rank, i); sec = s; if (!r.sections.includes(s)) r.sections.push(s); continue;
    }
    if (raw.startsWith('완료 | ')) { if (sec !== '해석 범위') issue('done-early'); doneSeen += 1; r.complete = true; continue; }
    if (k < 4 && raw.startsWith('보고서 | ')) continue; // 대상 서버의 임시 보고서 파일 경로(실행 파일이 끝나면 지운다)
    const ind = lead(raw); const body = raw.slice(ind);
    if (sec === '로그 수집 범위' || sec === 'PERC/StorCLI 조회' || sec === 'OS/SMART 조회' || sec === 'RAID 경유 물리 SMART 조회') {
      if (body.startsWith('수집 불가 | ')) { if (r.missing.length < 200) r.missing.push({ section: sec, what: cleanLine(body.slice(9), 300) }); continue; }
      if (body.startsWith('일부만 읽음 ')) { if (r.partial.length < 200) r.partial.push({ section: sec, what: cleanLine(body.slice(7), 300) }); continue; }
      const m = ind === 2 ? SOURCE_LINE.exec(body) : null;
      if (m) {
        if (r.sources.length < 500) r.sources.push({ name: cleanLine(m[1], 300), lines: num(m[2]), hits: num(m[3]), bad: num(m[4]), first: m[5] === '시간 비교 불가' ? null : m[5], last: m[6] === '시간 비교 불가' ? null : m[6] });
        continue;
      }
      continue; // 명령 줄 · 장치 줄 · SMART 값 줄 — 원문 보기에만
    }
    if (sec === '현재 디스크 인벤토리') {
      if (body === '수집된 디스크 없음') continue;
      const parts = body.split(' | ');
      if (parts.length >= 4 && parts[parts.length - 1].startsWith('마운트/스왑 표시 ') && r.inventory.length < 1000) {
        const label = parts[0]; const scope = parts[1]; const idsText = parts[2];
        r.inventory.push({ label: cleanLine(label, 160), scope: cleanLine(scope, 80), ids: parseIds(idsText), idsText: idsText === '식별자 없음' ? '' : cleanLine(idsText, 200), use: cleanLine(parts[parts.length - 1].slice(9), 60), virtual: scope === VIRTUAL_SCOPE });
      }
      continue;
    }
    if (sec === '판정') {
      const vm = /^\[(확정|추정|불명)\] /.exec(body);
      if (vm) { if (r.verdicts.length < 600) r.verdicts.push({ tag: vm[1], text: cleanLine(body.slice(vm[0].length), 600), depth: ind >= 4 ? 1 : 0 }); continue; }
      const cm = /^(.{2,20}) \| (\d{1,9})건$/.exec(body);
      if (cm && ERROR_KINDS.includes(cm[1])) { const jk = KIND_KEY[cm[1]]; if (jk in r.judgeCounts) issue('judge-dup'); r.judgeCounts[jk] = Number(cm[2]); continue; }
      const fm = /^파일시스템 생성 성공 패턴 (\d{1,9})줄, 명령\/시도 패턴 (\d{1,9})줄$/.exec(body);
      if (fm) { r.fsPattern = { ok: Number(fm[1]), cmd: Number(fm[2]) }; r.verdicts.push({ tag: '참고', text: body, depth: 0 }); continue; }
      if (ind === 2 && body.includes(' | 오류 근거 ')) { if (r.verdicts.length < 600) r.verdicts.push({ tag: '대상', text: cleanLine(body, 600), depth: 0 }); continue; }
      continue; // 판정 아래의 근거 되풀이 줄(6칸 들여쓰기)은 상세 근거에 같은 것이 있다
    }
    if (sec === '상세 근거') {
      let n = null; let rest = body;
      const hm = /^#(\d{1,7}) /.exec(body);
      if (hm) { n = Number(hm[1]); rest = body.slice(hm[0].length); }
      const ev = parseEvidence(rest);
      if (!ev) continue; // 근거 꼴이 아닌 줄(여러 줄 로그의 이어진 줄 등) — 숫자를 바꾸지 않으므로 버린다
      // 모양 검사 — 오류 근거는 #1 부터 빠짐없이 번호가 붙고, 번호 없는 기록(파일시스템 생성)은 그 뒤에만 나온다
      const isErr = ERROR_KINDS.includes(ev.kind);
      if (n != null) {
        if (!isErr) issue('evidence-kind');
        if (n !== nextNo || unnumberedSeen) issue('evidence-number');
        nextNo = n + 1;
      } else { if (isErr) issue('evidence-kind'); unnumberedSeen = true; }
      r.evidenceTotal += 1;
      r.counts[ev.key] += 1;
      if (isErr) {
        // 디스크별 계수는 **모든** 근거 줄로(반증 F5 — 화면에 싣는 근거 상한과 따로) · 식별자 조합마다 하나
        if (ev.ids.sn || ev.ids.wwn) {
          const ik = `${ev.ids.sn || ''}\u0000${ev.ids.wwn || ''}`;
          let c = r.idCounts.get(ik);
          if (!c) { if (r.idCounts.size >= ID_COUNTS_MAX) { r.idCountsCut = true; c = null; } else { c = { ids: ev.ids, media: 0, io: 0, realloc: 0 }; r.idCounts.set(ik, c); } }
          if (c) c[ev.key] += 1;
        } else r.unattributedAll += 1;
      }
      if (r.evidence.length < EVIDENCE_MAX) r.evidence.push({ n, ...ev });
      continue;
    }
    if (sec === '해석 범위') {
      const gm = /^확인하지 못했거나 일부만 수집한 소스\/항목 (\d{1,6})개\.$/.exec(body);
      if (gm) { if (r.gaps != null) issue('scope-dup'); r.gaps = Number(gm[1]); }
      if (r.scope.length < 40) r.scope.push(cleanLine(body, 300));
      continue;
    }
    if (r.others.length < 20) r.others.push(cleanLine(raw, 300));
  }
  // 판정 건수 합 = 번호 붙은 근거 수(근거를 다 읽었을 때만 — 잘렸으면 맞출 수 없다)
  if (!r.linesCut && !r.cutSections.includes('상세 근거') && r.sections.includes('상세 근거')) {
    const judged = ERROR_KINDS.reduce((a, kd) => a + (r.judgeCounts[KIND_KEY[kd]] || 0), 0);
    if (judged !== nextNo - 1) issue('judge-mismatch');
  }
  return r;
}
/** 식별자 조합 계수 상한(디스크별 계수 — 넘으면 디스크 값을 '모름' 으로). */
export const ID_COUNTS_MAX = 5000;
/** 모양 검사 결과 → 화면 글(판정 코어 — 웹은 열쇠만 받는다). */
export const SHAPE_TEXT = Object.freeze({
  'section-order': '구획 머리가 되풀이되거나 순서가 다릅니다', 'done-early': '완료 줄이 제자리에 있지 않습니다', 'after-done': '완료 줄 뒤에 줄이 더 있습니다',
  'judge-dup': '판정 건수 줄이 되풀이됩니다', 'judge-mismatch': '판정 건수 합이 근거 줄 수와 다릅니다', 'evidence-number': '근거 번호가 이어지지 않습니다',
  'evidence-kind': '근거 종류와 번호가 맞지 않습니다', 'scope-dup': '해석 범위 줄이 되풀이됩니다',
});

/* ── 디스크 목록(모델) ─────────────────────────────────────────────────── */
const LSBLK_PAIR = /([A-Z][A-Z0-9_-]{0,15})="([^"]{0,200})"/g;
function lsblkRow(line) {
  const row = {};
  const l = String(line || '').slice(0, 2000);
  LSBLK_PAIR.lastIndex = 0;
  let m; let guard = 0;
  while ((m = LSBLK_PAIR.exec(l)) && guard++ < 20) row[m[1]] = m[2].replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  return row;
}
const tidy = (s, n = 80) => cleanLine(String(s ?? '').trim(), n).trim();

/**
 * @returns {Array<{src:'os'|'raid', dev:string, sn:string, wwn:string, model:string, size:string, media:'HDD'|'SSD'|'', tran:string}>}
 */
export function parseDisks(lsblkLines = [], raidLines = []) {
  const out = [];
  for (const line of (lsblkLines || []).slice(0, DISK_ROWS_MAX)) {
    const r = lsblkRow(line);
    if (!r.NAME || (r.TYPE && r.TYPE !== 'disk')) continue;
    out.push({ src: 'os', dev: `/dev/${tidy(r.NAME, 40)}`, sn: normSerial(r.SERIAL), wwn: normWwn(r.WWN), model: tidy(r.MODEL), size: tidy(r.SIZE, 20), media: r.ROTA === '1' ? 'HDD' : r.ROTA === '0' ? 'SSD' : '', tran: tidy(r.TRAN, 16) });
  }
  const bySlot = new Map(); let cur = null;
  for (const raw of (raidLines || []).slice(0, 8000)) {
    const l = cleanLine(raw, 400);
    const h = /^Drive (\/c\d{1,3}\/e\d{1,4}\/s\d{1,4}|\/c\d{1,3}\/s\d{1,4})\b/.exec(l);
    if (h) { cur = h[1]; if (!bySlot.has(cur)) bySlot.set(cur, { src: 'raid', dev: cur, sn: '', wwn: '', model: '', size: '', media: '', tran: '' }); continue; }
    if (!cur) continue;
    const d = bySlot.get(cur);
    // 'SN = …' · 'WWN = …' · 'Model Number = …' — 정규식 되돌아가기 없이(반증 F9-c: 공백이 긴 줄 8,000개에 546ms) indexOf 로
    const eq = l.indexOf('=');
    const key = eq > 0 && eq <= 20 ? l.slice(0, eq).trimEnd() : '';
    if (key === 'SN' || key === 'WWN' || key === 'Model Number') {
      const v = l.slice(eq + 1).trim();
      if (v.length <= 120) {
        if (key === 'SN') d.sn = normSerial(v) || d.sn;
        else if (key === 'WWN') d.wwn = normWwn(v) || d.wwn;
        else d.model = tidy(v) || d.model;
      }
      continue;
    }
    const t = l.trim().split(/ +/);
    if (t.length >= 12 && /^\d{1,4}:\d{1,4}$/.test(t[0]) && /^\d{1,5}$/.test(t[1])) {
      d.size = d.size || tidy(`${t[4]} ${t[5]}`, 20);
      d.tran = d.tran || tidy(t[6], 16);
      d.media = d.media || (t[7] === 'HDD' || t[7] === 'SSD' ? t[7] : '');
      if (!d.model) d.model = tidy(t.slice(11, Math.max(12, t.length - 2)).join(' '));
    }
  }
  for (const d of bySlot.values()) if (out.length < DISK_ROWS_MAX) out.push(d);
  return out;
}

/* ── 요약 ───────────────────────────────────────────────────────────────── */
const physicalScope = (s) => s !== VIRTUAL_SCOPE;

/**
 * 보고서 + 디스크 목록 → 요약(DB 에 남기고 화면 · 묶어 보기가 읽는다).
 * 디스크는 식별자(SN · WWN)로 하나씩 센다. 식별자가 없는 근거는 디스크에 붙이지 않고 따로 센다(unattributed).
 */
export function summarize(report, diskRows = []) {
  const r = report || parseReport('');
  const ids = (d) => ({ sn: d.sn || '', wwn: d.wwn || '' });
  // 물리 디스크 = 인벤토리 중 가상/RAID 경유 OS 장치가 아닌 것 · 식별자가 있는 것
  const phys = [];
  for (const d of r.inventory) {
    if (!physicalScope(d.scope) || (!d.ids.sn && !d.ids.wwn)) continue;
    if (phys.some((p) => sameDisk(p.ids, d.ids))) continue;
    phys.push({ label: d.label, ids: d.ids, scope: d.scope, model: '', size: '', media: '', media_n: 0, realloc_n: 0, io_n: 0 });
  }
  for (const p of phys) {
    const hit = (diskRows || []).find((x) => sameDisk(ids(x), p.ids)) || null;
    if (hit) { p.model = hit.model || ''; p.size = hit.size || ''; p.media = hit.media || ''; }
  }
  let unattributed = r.unattributedAll || 0;
  // 근거를 다 받지 못했으면(보고서 상한 · 화면 상한) 종류별 수는 프로그램의 판정 줄(‘매체 오류 기록 | N건’)을 쓴다 — 받은 줄만 세면 적게 말한다
  const evidenceCut = r.evidenceTotal > r.evidence.length || !!r.cut || !!r.linesCut;
  // 디스크별 값은 상세 근거를 끝까지 읽었을 때만 안다(반증 F5) — 잘렸으면 디스크 값은 null(0 이 아니다 · 비율 분모에서 빠진다)
  const disksKnown = !r.linesCut && !r.idCountsCut && !(r.cutSections || []).includes('상세 근거');
  const counts = { ...r.counts };
  if (evidenceCut) for (const k of ['media', 'io', 'realloc']) if (Number.isInteger(r.judgeCounts[k])) counts[k] = Math.max(counts[k], r.judgeCounts[k]);
  for (const c of (r.idCounts instanceof Map ? r.idCounts.values() : [])) {
    const p = phys.find((x) => sameDisk(x.ids, c.ids));
    if (!p) { unattributed += c.media + c.io + c.realloc; continue; }
    p.media_n += c.media; p.realloc_n += c.realloc; p.io_n += c.io;
  }
  const errTotal = counts.media + counts.io + counts.realloc;
  const kn = (v) => (disksKnown ? v : null);
  return {
    complete: r.complete, counts, errTotal, evidenceTotal: r.evidenceTotal, evidenceCut, disksKnown, gaps: r.gaps,
    missing: r.missing.length, partial: r.partial.length, shape: [...(r.shape || [])],
    disks: phys.slice(0, 500).map((p) => ({ label: p.label, sn: p.ids.sn || '', wwn: p.ids.wwn || '', model: p.model, size: p.size, media: p.media, scope: p.scope, mediaN: kn(p.media_n), reallocN: kn(p.realloc_n), ioN: kn(p.io_n) })),
    unattributed: kn(unattributed), // 디스크에 붙이지 못한 오류 근거 줄(모든 근거 줄 기준 — 근거가 잘렸으면 null)
    hit: errTotal > 0,
  };
}

/** 근거 줄의 비교 열쇠(지난 회차에 같은 줄이 있었나 — ‘새’ 표지). 줄 번호는 로그 회전으로 바뀌므로 넣지 않는다. */
export const evidenceKey = (e) => `${e.kind}|${e.source}|${e.idsText}|${e.message}`;
