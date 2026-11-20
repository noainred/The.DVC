/**
 * bmusage/logs/parse.js — 7a단계 로그 읽기 명령(command.js) 출력의 **파서**(순수).
 *
 * 결과: { ended, items[{src, unit, ts, msg}], sources{<src>:{status, n, emitted, truncated, …}}, next{읽기 위치}, authSrc }.
 *   · status: ok(읽음) · perm(권한 없음 — scope: none 저널 하나도 못 엶 · own 자기 저널만 · dir 폴더 · file 파일) · absent(그 출처가 없다 — 파일 · 도구 · 폴더 · 저널 파일 없음) ·
 *     failed(명령 실패) · missing(표지가 안 왔다) · cut(출력이 잘려 그 구획을 버림) · nofile(폴더는 있는데 파일 없음)
 *   · ⚠⚠ 권한 없음 · 도구 없음 · 잘림을 0(‘로그 없음’)으로 세지 않는다 — status 로 따로 둔다(앞 단계 반증의 반복 결함). n · emitted 는 읽은 출처만 수다(그 밖은 null).
 *   · ⚠ 잘림(##END 미도착 — 세션 시한 · sshExec 상한)이면 **마지막 구획을 통째로 버린다**(1단계 D1 규약): 읽기 위치를 넘기지 않으므로 다음 주기에 같은 줄을 다시 읽는다.
 *     출처마다 바이트 상한(command.js SRC_BYTES — 합 + 메타 여유 ≤ head -c 상한)이 있어 head -c 로는 잘리지 않는다(반증 F4 — 한 출처가 다른 구획을 영구히 밀어내던 결함).
 *   · 읽기 위치(next)는 **화이트리스트를 통과한 값만**(command.js *_RE) — 통과하지 못하면 직전 값을 유지하거나(그 출처를 못 읽음) 비운다(커서 오류 → 처음 읽기로).
 *   · journald(J · Q)는 JSON 한 줄 = 한 항목이다(반증 F5 — 커서는 awk 가 본 마지막 항목의 것: 시한 · 상한에서도 본 데까지 넘어가 같은 줄을 다시 세지 않는다).
 *   · ⚠ 시각: 범위(지금 −30일 ~ +5분) 밖이거나 못 읽은 줄은 **지어내지 않는다** — 지금보다 하루 안쪽 미래(서버 시계가 빠름)는 받은 시각으로 두고 skew 로 세고,
 *     그 밖(30일보다 오래됨 · 시각 없음)은 ts=null(분류 · 시간 칸 · 알림에서 빠지고 ‘시각 모름’ 으로만 센다 — 반증 F6).
 * 줄 머리 접두(J| · Q| · K| · S| · A| · G| · F|)가 없는 줄은 버린다 — 구획 표지는 splitSections(정확 일치 · 순서 · 재개방 금지)가 가른다.
 */
import { splitSections } from '../parse/linuxProc.js';
import { parseTextLine } from '../../loganalysis/parse.js';
import { LOG_SECTIONS, LOG_PREFIX, CURSOR_RE, BOOT_RE, SECS_RE, DIGITS_RE, APP_LOGS, AUTH_IDENTS, JSON_WIDTH } from './command.js';

/** 메시지 본문 상한(규칙 매칭 · 서명 · 표본의 입력 — 길이를 먼저 자른다). */
export const MSG_MAX = 500;
const LINE_MAX = 700;
const CONTENT_MAX = JSON_WIDTH + 8;
const FUTURE_MS = 5 * 60_000;
/** 서버 시계가 이만큼까지 빠르면 받은 시각으로 둔다(증분 읽기라 새 줄이다) — 그보다 먼 미래는 시각 모름. */
export const SKEW_MAX_MS = 86_400_000;
const PAST_MS = 30 * 86_400_000;
export const SRC_OF_PREFIX = Object.freeze(Object.fromEntries(Object.entries(LOG_PREFIX).map(([k, v]) => [v, k])));
const SECTION_SRCS = Object.freeze({ JOURNAL: ['journal'], JSEC: ['jsec'], DMESG: ['kernel'], SECURE: ['secure'], AUDIT: ['audit'], APPLOG: APP_LOGS.map((a) => a.id) });
export const STATUS = Object.freeze(['ok', 'perm', 'absent', 'failed', 'missing', 'cut', 'nofile']);
/** 권한 없음의 범위(화면 안내 — 무엇을 못 보는지). */
export const PERM_SCOPES = Object.freeze(['none', 'own', 'dir', 'file']);
const AUTH_SET = new Set(AUTH_IDENTS);

const intOf = (v) => (typeof v === 'string' && /^-?\d{1,19}$/.test(v) ? Number(v) : null);
/** 시각 판정 → { ts, why? } — why: skew(빠른 시계 → 받은 시각) · old · future · none(시각 없음 → ts null). */
export function dateOf(ts, now) {
  if (!Number.isFinite(ts)) return { ts: null, why: 'none' };
  if (ts > now + FUTURE_MS) return ts <= now + SKEW_MAX_MS ? { ts: now, why: 'skew' } : { ts: null, why: 'future' };
  if (ts < now - PAST_MS) return { ts: null, why: 'old' };
  return { ts };
}
const cleanMsg = (s) => String(s ?? '').slice(0, MSG_MAX).replace(/[\u0000-\u001f\u007f]/g, ' ');
const unitOf = (p) => String(p || '').replace(/\[\d{1,10}\]$/, '').slice(0, 64);

/** dmesg -x 줄(‘kern  :warn  : [    1.257889] 메시지’ — 이 컨테이너 실측 형식) → { level, secs, msg } | null. */
const DMESG_RE = /^(\w{1,10}) {0,8}:(\w{1,8}) {0,8}: \[ {0,14}(\d{1,10}\.\d{1,9})\] ?(.{0,700})$/;
export function parseDmesgLine(line) {
  const m = DMESG_RE.exec(String(line ?? '').slice(0, LINE_MAX));
  return m ? { facility: m[1], level: m[2], secs: Number(m[3]), msg: cleanMsg(m[4]) } : null;
}
/** audit.log 줄 → { ts, msg }(시각은 msg=audit(초.밀리:일련)). */
const AUDIT_TS_RE = /^type=[A-Z_]{1,32} msg=audit\((\d{1,12})\.(\d{1,3}):\d{1,20}\)/;
export function parseAuditLine(line) {
  const s = String(line ?? '').slice(0, LINE_MAX);
  const m = AUDIT_TS_RE.exec(s);
  return { ts: m ? Number(m[1]) * 1000 + Number(m[2].padEnd(3, '0')) : null, msg: cleanMsg(s) };
}
/**
 * GPDB · PostgreSQL csvlog 줄 → { ts, msg:'<수준>: <메시지>' }. 열 순서(G1): 시각 · … · error_severity · sql_state_code · message · … — 수준 열 뒤 따옴표 칸을 읽는다(""는 ").
 *   시각은 ‘YYYY-MM-DD HH:MM:SS(.ffffff) <시간대 약어>’ — 약어(KST 등)는 해석하지 않고 **엣지 시간대로** 본다(정직 기록 — 법인 서버와 엣지가 같은 시간대라는 가정).
 */
const GP_SEV_RE = /,"(LOG|WARNING|ERROR|FATAL|PANIC|NOTICE|INFO|DEBUG\d?)","([0-9A-Z]{5})","/;
export function parseGpdbLine(line) {
  const s = String(line ?? '').slice(0, LINE_MAX);
  const t = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(s);
  const ts = t ? new Date(Number(t[1]), Number(t[2]) - 1, Number(t[3]), Number(t[4]), Number(t[5]), Number(t[6])).getTime() : null;
  const m = GP_SEV_RE.exec(s);
  if (!m) return { ts, msg: cleanMsg(s) };
  let i = m.index + m[0].length; let out = '';
  while (i < s.length && out.length < MSG_MAX) {
    const c = s[i];
    if (c === '"') { if (s[i + 1] === '"') { out += '"'; i += 2; continue; } break; }
    out += c; i += 1;
  }
  return { ts, msg: cleanMsg(`${m[1]}: ${out}`) };
}
/** Airflow 로그 줄(‘[2026-11-06T13:43:20.123+0900] {파일:줄} ERROR - 메시지’) → { ts, msg:'<수준> - <메시지>' }. */
const AF_RE = /^\[(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,6})?(?:[+-]\d{2}:?\d{2}|Z)?)\] \{[^}]{0,160}\} ([A-Z]{3,10}) - (.{0,700})$/;
export function parseAirflowLine(line) {
  const s = String(line ?? '').slice(0, LINE_MAX);
  const m = AF_RE.exec(s);
  if (!m) return { ts: null, msg: cleanMsg(s) };
  const iso = m[1].replace(' ', 'T').replace(',', '.').replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const ts = Date.parse(iso);
  return { ts: Number.isFinite(ts) ? ts : null, msg: cleanMsg(`${m[2]} - ${m[3]}`) };
}

/* ── journald JSON(한 줄 = 한 항목) ─────────────────────────────────────── */
// 잘린 JSON(JSON_WIDTH)이면 필드를 정규식으로 꺼낸다 — 갈래가 서로 겹치지 않는 길이 한정 반복(선형).
const J_MSG_RE = /"MESSAGE":"((?:[^"\\]|\\.){0,1200})/;
const J_ID_RE = /"SYSLOG_IDENTIFIER":"((?:[^"\\]|\\.){0,64})"/;
const J_COMM_RE = /"_COMM":"([^"\\]{0,64})"/;
const J_RT_RE = /"__REALTIME_TIMESTAMP":"(\d{1,20})"/;
const unq = (s) => {
  const t = String(s).replace(/\\(?:u[0-9a-fA-F]{0,3})?$/, '');
  try { return JSON.parse(`"${t}"`); } catch { return t.replace(/\\(.)/g, '$1'); }
};
/** 필드 값 → 글자(journald JSON: 글자 · 바이트 배열(인쇄 불가 값) · 같은 필드 여러 값이면 배열 — 첫 값). */
function fieldStr(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    if (v.length && v.every((x) => Number.isInteger(x) && x >= 0 && x < 256)) return Buffer.from(v.slice(0, 1_200)).toString('utf8');
    const s = v.find((x) => typeof x === 'string');
    return typeof s === 'string' ? s : '';
  }
  return '';
}
const rtMs = (v) => (typeof v === 'string' && /^\d{1,20}$/.test(v) ? Math.floor(Number(v) / 1000) : null);
/** journald JSON 줄 → { ts(ms|null), ident, comm, msg, cut? } | null(형식 아님). */
export function parseJournalJson(line) {
  const s = String(line ?? '').slice(0, CONTENT_MAX);
  if (s[0] !== '{') return null;
  let o = null;
  try { o = JSON.parse(s); } catch { o = null; }
  if (o && typeof o === 'object' && !Array.isArray(o)) {
    return { ts: rtMs(o.__REALTIME_TIMESTAMP), ident: fieldStr(o.SYSLOG_IDENTIFIER).slice(0, 64), comm: fieldStr(o._COMM).slice(0, 64), msg: cleanMsg(fieldStr(o.MESSAGE)) };
  }
  // 잘린 JSON — 아는 필드만 정규식으로(MESSAGE 는 잘린 앞부분)
  const m = J_MSG_RE.exec(s);
  return { ts: rtMs(J_RT_RE.exec(s)?.[1]), ident: String(unq(J_ID_RE.exec(s)?.[1] || '')).slice(0, 64), comm: (J_COMM_RE.exec(s)?.[1] || '').slice(0, 64), msg: m ? cleanMsg(unq(m[1])) : '', cut: true };
}

/** 메타 줄(‘X#k=v’ · ‘X#flag’)을 출처별 맵으로. 내용 줄은 출처별 배열. 접두 없는 줄은 버린다(센다). */
function collect(lines, srcs) {
  const meta = {}; const body = {}; let stray = 0;
  for (const s of srcs) { meta[s] = {}; body[s] = []; }
  for (const raw of lines) {
    const l = String(raw).slice(0, CONTENT_MAX);
    const src = SRC_OF_PREFIX[l[0]];
    if (!src || !srcs.includes(src)) { if (l.trim()) stray += 1; continue; }
    if (l[1] === '|') { body[src].push(l.slice(2)); continue; }
    if (l[1] === '#') {
      const kv = l.slice(2, 2 + 240); const eq = kv.indexOf('=');
      const k = eq < 0 ? kv : kv.slice(0, eq);
      if (/^[a-z]{1,8}$/.test(k) && !Object.hasOwn(meta[src], k)) meta[src][k] = eq < 0 ? true : kv.slice(eq + 1).slice(0, 220);
      continue;
    }
    stray += 1;
  }
  return { meta, body, stray };
}

const blank = (status, extra = {}) => ({ status, n: null, emitted: null, truncated: null, ...extra });
const permScope = (v) => (typeof v === 'string' && PERM_SCOPES.includes(v) ? v : 'file');

/** 수집 계정 정보(journald 메타 — 화면 권한 안내용 · uid 숫자 · 소속 그룹은 systemd-journal · adm · wheel 중에서만). */
function acctOf(m) {
  const uid = typeof m.uid === 'string' && /^\d{1,10}$/.test(m.uid) ? Number(m.uid) : null;
  const groups = typeof m.grp === 'string' ? m.grp.split(',').filter((g) => /^(?:systemd-journal|adm|wheel)$/.test(g)) : null;
  return { ...(uid != null ? { uid } : {}), ...(groups ? { groups } : {}) };
}

/**
 * journald 출처(journal · jsec) 상태 · 항목 · 다음 위치.
 *   ⚠ rc 124(timeout — command.js JOURNAL_TIMEOUT_S)는 실패가 아니라 ‘부분’ 이다 — 본 항목까지 커서가 넘어갔으므로 그 줄은 이번에 센다(다음 주기는 그 뒤부터). 본 항목이 없으면 실패 · 커서 유지.
 *   ⚠ 그 밖의 실패(rc ≠ 0 · 본 항목 0)는 커서를 비운다(커서가 지워진 저널이면 계속 실패한다 → 다음 주기는 ‘최근 60분’ 으로 다시 잡는다 · 그 사이는 모른다).
 *   ⚠ 본 항목이 있는데 커서를 못 꺼냈으면(형식 이상) 세지 않는다 — 넘기지 못한 줄을 세면 다음 주기에 두 번 센다.
 */
function journaldSource(src, m, b, prevCur, now, items) {
  const keep = prevCur ? { cursor: prevCur } : null;
  const acct = acctOf(m);
  if (m.absent) return { st: blank('absent', { tool: 'absent' }), next: keep };
  if (m.nofiles) return { st: blank('absent', { nofiles: true, ...acct }), next: keep };
  const n = intOf(m.n); const rc = intOf(m.rc);
  const cur = typeof m.cur === 'string' && CURSOR_RE.test(m.cur) ? m.cur : null;
  if (m.perm === 'none') return { st: blank('perm', { scope: 'none', ...acct }), next: keep };
  // 자기 저널만(시스템 · 다른 사용자 메시지는 권한 없음) — 수집 계정 자신의 줄은 서버 상태와 무관하다: 세지 않고 위치만 넘긴다.
  if (m.perm === 'own') return { st: blank('perm', { scope: 'own', ...acct }), next: cur ? { cursor: cur } : keep };
  if (n == null) return { st: blank('failed', { reason: 'meta', ...(rc != null ? { rc } : {}) }), next: keep };
  const timeout = rc === 124;
  if (rc != null && rc !== 0 && n === 0) {
    if (timeout) return { st: blank('failed', { reason: 'timeout', rc }), next: keep };
    return { st: blank('failed', { rc, ...(prevCur ? { cursorReset: true } : {}), ...(m.err ? { toolMsg: true } : {}) }), next: null };
  }
  if (n > 0 && !cur) return { st: blank('failed', { reason: 'cursor', ...(rc != null ? { rc } : {}) }), next: keep };
  let authSkipped = 0; let undated = 0; let skew = 0; let cut = 0;
  for (const l of b) {
    const j = parseJournalJson(l);
    if (!j || !j.msg) continue;
    if (j.cut) cut += 1;
    // 주 저널(JOURNAL)의 sshd · sudo 계열 줄은 보안 읽기(JSEC)가 info 이상으로 따로 읽는다 — 여기서 빼고 센다(두 번 세지 않게).
    if (src === 'journal' && AUTH_SET.has(j.ident)) { authSkipped += 1; continue; }
    const d = dateOf(j.ts, now);
    if (d.ts == null) undated += 1; else if (d.why === 'skew') skew += 1;
    items.push({ src, unit: unitOf(j.ident || j.comm), ts: d.ts, msg: j.msg });
  }
  return {
    st: { status: 'ok', n, emitted: b.length, truncated: Math.max(0, n - b.length), ...(timeout ? { partial: 'timeout' } : rc ? { rc } : {}), ...(m.err ? { toolMsg: true } : {}),
      ...(prevCur ? {} : { first: true }), ...(authSkipped ? { authSkipped } : {}), ...(undated ? { undated } : {}), ...(skew ? { skew } : {}), ...(cut ? { jsonCut: cut } : {}), ...acct },
    next: cur ? { cursor: cur } : keep,
  };
}

/** 파일 출처(secure · audit · 용도) 상태 · 다음 위치. */
function fileSource(meta, emitted, prev) {
  if (meta.absent) return { st: blank('absent'), next: prev || null };
  if (meta.perm) return { st: blank('perm', { scope: permScope(meta.perm) }), next: prev || null };
  if (meta.nofile) return { st: blank('nofile'), next: prev || null };
  const ino = typeof meta.ino === 'string' && DIGITS_RE.test(meta.ino) ? meta.ino : '';
  const off = typeof meta.off === 'string' && DIGITS_RE.test(meta.off) ? meta.off : '';
  const n = intOf(meta.n);
  if (meta.fail || !ino || !off || n == null) return { st: blank('failed', meta.fail ? { reason: String(meta.fail).slice(0, 16) } : {}), next: prev || null };
  const mode = ['first', 'inc', 'shrink', 'rot'].includes(meta.mode) ? meta.mode : null;
  const part = intOf(meta.part); const skipb = intOf(meta.skipb);
  return {
    st: { status: 'ok', n, emitted, truncated: Math.max(0, n - emitted), mode, ...(mode === 'first' ? { first: true } : {}), ...(mode === 'rot' ? { rotated: true, lost: meta.old !== '1' } : {}),
      ...(mode === 'shrink' ? { shrunk: true } : {}), ...(part > 0 ? { partial: part } : {}), ...(skipb > 0 ? { skippedBytes: skipb } : {}) },
    next: { ino, off },
  };
}

/**
 * 보안 줄(계정 · 로그인 · sudo)을 셀 출처 하나를 고른다(순수 · 반증 F1 — 같은 사건을 두 출처에서 두 번 세지 않게).
 *   우선순위: /var/log/secure(읽음 · rsyslog 가 돌거나 모름) → journald 보안(JSEC · 읽음 — 자기 저널만이면 읽음이 아니다) → auditd(인증 실패 · 계정 변경만).
 *   secure 가 먼저인 이유: 설계 §17 이 이름을 댄 출처이고 authpriv 전체(sshd · sudo · su · login · 계정 도구 밖의 프로그램 포함)를 담는다.
 *   rsyslog 가 멈췄으면(‘active’ 가 아님 — secure 에 새 줄이 안 쌓인다) JSEC 를 쓴다. 주 저널(JOURNAL)의 같은 식별자 줄은 파서가 이미 뺐다.
 * @returns {'secure'|'jsec'|'audit'|null}
 */
export function pickAuthSource(sources = {}) {
  const okS = sources.secure?.status === 'ok';
  const okQ = sources.jsec?.status === 'ok';
  const svc = sources.secure?.svc;
  const stale = okS && typeof svc === 'string' && svc !== 'active';
  if (okS && !(stale && okQ)) return 'secure';
  if (okQ) return 'jsec';
  if (sources.audit?.status === 'ok') return 'audit';
  return null;
}

/**
 * @param {string} stdout  로그 읽기 명령 출력
 * @param {{prev?:object, now?:number}} o  prev = 직전 읽기 위치(next 모양) · now = 이 노드가 받은 시각
 */
export function parseLogOutput(stdout, { prev = {}, now = Date.now() } = {}) {
  const sec = splitSections(String(stdout ?? ''), { order: LOG_SECTIONS });
  const P = prev && typeof prev === 'object' ? prev : {};
  const ended = Array.isArray(sec.END);
  let cutName = null;
  if (!ended) { const names = Object.keys(sec); cutName = names.at(-1) || null; if (cutName) delete sec[cutName]; }
  const sources = {}; let items = []; const next = { apps: {} };
  const keepPrev = (src) => {
    if (src === 'journal' || src === 'jsec' || src === 'kernel' || src === 'secure' || src === 'audit') next[src] = P[src] || null;
    else next.apps[src] = P.apps?.[src] || null;
  };
  let stray = 0;
  for (const name of LOG_SECTIONS.slice(0, -1)) {
    const srcs = SECTION_SRCS[name];
    if (!Array.isArray(sec[name])) { for (const s of srcs) { sources[s] = blank(name === cutName ? 'cut' : 'missing'); keepPrev(s); } continue; }
    const { meta, body, stray: st0 } = collect(sec[name], srcs);
    stray += st0;
    for (const src of srcs) {
      const m = meta[src]; const b = body[src];
      if (src === 'journal' || src === 'jsec') {
        const prevCur = typeof P[src]?.cursor === 'string' && CURSOR_RE.test(P[src].cursor) ? P[src].cursor : null;
        const r = journaldSource(src, m, b, prevCur, now, items);
        sources[src] = r.st; next[src] = r.next;
        continue;
      }
      if (src === 'kernel') {
        if (m.absent) { sources[src] = blank('absent'); keepPrev(src); continue; }
        const n = intOf(m.n); const rc = intOf(m.rc);
        if (m.perm || (rc != null && rc !== 0 && !n)) { sources[src] = blank(m.perm ? 'perm' : 'failed', rc != null ? { rc } : {}); keepPrev(src); continue; }
        const boot = typeof m.boot === 'string' && BOOT_RE.test(m.boot) ? m.boot : '';
        const last = typeof m.last === 'string' && SECS_RE.test(m.last) ? m.last : '';
        const up = Number(m.up); const rnow = intOf(m.now);
        // 부팅 시각(서버 시계) = 서버 now − uptime. 커널 [초] + 부팅 시각 = 그 줄의 벽시계(dmesg -T 와 같은 근사 — 일시 정지가 없는 서버 기준).
        const bootAt = Number.isFinite(up) && up > 0 && rnow != null ? rnow * 1000 - up * 1000 : null;
        let undated = 0; let skew = 0;
        for (const l of b) {
          const d = parseDmesgLine(l);
          if (!d) continue;
          const dt = dateOf(bootAt != null ? Math.round(bootAt + d.secs * 1000) : NaN, now);
          if (dt.ts == null) undated += 1; else if (dt.why === 'skew') skew += 1;
          items.push({ src, unit: 'kernel', ts: dt.ts, msg: d.msg, level: d.level });
        }
        // 첫 읽기(직전 boot 없음)는 가동 마지막 60분만 센다 — 그 앞 줄 수는 older(세지 않음 · 위치만 잡는다 · 반증 F6).
        const older = intOf(typeof m.first === 'string' ? m.first : null);
        sources[src] = {
          status: n == null ? 'failed' : 'ok', n, emitted: b.length, truncated: n == null ? null : Math.max(0, n - b.length),
          ...(m.first != null ? { first: true, ...(older != null ? { older } : {}) } : {}), ...(P.kernel?.boot && boot && P.kernel.boot !== boot ? { rebooted: true } : {}),
          ...(undated ? { undated } : {}), ...(skew ? { skew } : {}),
        };
        next.kernel = boot && n != null ? { boot, ...(last ? { last } : {}) } : (P.kernel || null);
        continue;
      }
      // 파일 출처
      const prevPos = src === 'secure' || src === 'audit' ? P[src] : P.apps?.[src];
      const fsrc = fileSource(m, b.length, prevPos);
      const svc = (src === 'audit' || src === 'secure') && typeof m.svc === 'string' ? { svc: /^[a-z-]{1,16}$/.test(m.svc) ? m.svc : null } : {};
      sources[src] = { ...fsrc.st, ...svc };
      if (APP_LOGS.some((a) => a.id === src)) {
        const dir = intOf(typeof m.dir === 'string' ? m.dir : null);
        if (fsrc.next && dir != null) fsrc.next.dir = dir;
        next.apps[src] = fsrc.next;
      } else next[src] = fsrc.next;
      if (fsrc.st.status !== 'ok') continue;
      let undated = 0; let skew = 0;
      const push = (unit, ts, msg) => {
        const d = dateOf(ts, now);
        if (d.ts == null) undated += 1; else if (d.why === 'skew') skew += 1;
        items.push({ src, unit, ts: d.ts, msg });
      };
      for (const l of b) {
        if (src === 'secure') {
          const p = parseTextLine(l.slice(0, LINE_MAX), { now });
          if (!p || p.cont) continue;
          push(unitOf(p.proc), p.ts, cleanMsg(p.msg));
        } else if (src === 'audit') {
          const p = parseAuditLine(l); push('audit', p.ts, p.msg);
        } else if (src === 'gpdb') {
          const p = parseGpdbLine(l); push('postgres', p.ts, p.msg);
        } else if (src === 'airflow') {
          const p = parseAirflowLine(l); push('airflow', p.ts, p.msg);
        }
      }
      if (undated) sources[src].undated = undated;
      if (skew) sources[src].skew = skew;
    }
  }
  // 보안 출처 하나 — 고르지 않은 JSEC 줄은 secure 와 같은 기록이라 빼고 센다(dup — 선형 filter: 큰 배열에서 splice 반복 금지).
  const authSrc = pickAuthSource(sources);
  if (sources.jsec?.status === 'ok' && authSrc !== 'jsec') {
    const before = items.length;
    items = items.filter((x) => x.src !== 'jsec');
    sources.jsec.dup = before - items.length; sources.jsec.dupOf = authSrc;
  }
  return { ended, cut: cutName, items, sources, next, authSrc, ...(stray ? { stray } : {}) };
}
