/**
 * bmusage/logs/parse.js — 7a단계 로그 읽기 명령(command.js) 출력의 **파서**(순수).
 *
 * 결과: { ended, items[{src, unit, ts, msg}], sources{<src>:{status, n, emitted, truncated, …}}, next{읽기 위치} }.
 *   · status: ok(읽음) · perm(권한 없음) · absent(그 출처가 없다 — 파일 · 도구 · 폴더 없음) · failed(명령 실패 — rc ≠ 0) · missing(표지가 안 왔다) · cut(출력이 잘려 그 구획을 버림) · nofile(폴더는 있는데 파일 없음)
 *   · ⚠⚠ 권한 없음 · 도구 없음 · 잘림을 0(‘로그 없음’)으로 세지 않는다 — status 로 따로 둔다(앞 단계 반증의 반복 결함). n · emitted 는 읽은 출처만 수다(그 밖은 null).
 *   · ⚠ 잘림(##END 미도착 — head -c 상한 · 세션 시한)이면 **마지막 구획을 통째로 버린다**(1단계 D1 규약): 그 구획의 마지막 줄이 중간에서 잘렸을 수 있고,
 *     읽기 위치를 넘기지 않으므로 다음 주기에 같은 줄을 다시 읽는다(버린 줄을 세면 두 번 센다). 그 뒤 구획은 missing.
 *   · 읽기 위치(next)는 **화이트리스트를 통과한 값만**(command.js *_RE) — 통과하지 못하면 직전 값을 유지하거나(그 출처를 못 읽음) 비운다(커서 오류 → 처음 읽기로).
 * 줄 머리 접두(J| · K| · S| · A| · G| · F|)가 없는 줄은 버린다 — 구획 표지는 splitSections(정확 일치 · 순서 · 재개방 금지)가 가른다.
 */
import { splitSections } from '../parse/linuxProc.js';
import { parseTextLine } from '../../loganalysis/parse.js';
import { LOG_SECTIONS, LOG_PREFIX, CURSOR_RE, BOOT_RE, SECS_RE, DIGITS_RE, APP_LOGS } from './command.js';

/** 메시지 본문 상한(규칙 매칭 · 서명 · 표본의 입력 — 길이를 먼저 자른다). */
export const MSG_MAX = 500;
const LINE_MAX = 700;
const FUTURE_MS = 5 * 60_000;
const PAST_MS = 30 * 86_400_000;
export const SRC_OF_PREFIX = Object.freeze(Object.fromEntries(Object.entries(LOG_PREFIX).map(([k, v]) => [v, k])));
const SECTION_SRCS = Object.freeze({ JOURNAL: ['journal'], DMESG: ['kernel'], SECURE: ['secure'], AUDIT: ['audit'], APPLOG: APP_LOGS.map((a) => a.id) });
export const STATUS = Object.freeze(['ok', 'perm', 'absent', 'failed', 'missing', 'cut', 'nofile']);

const intOf = (v) => (typeof v === 'string' && /^-?\d{1,19}$/.test(v) ? Number(v) : null);
const clampTs = (ts, now) => (Number.isFinite(ts) && ts <= now + FUTURE_MS && ts >= now - PAST_MS ? ts : null);
const cleanMsg = (s) => String(s ?? '').slice(0, MSG_MAX).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ');

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

/** 메타 줄(‘X#k=v’ · ‘X#flag’)을 출처별 맵으로. 내용 줄은 출처별 배열. 접두 없는 줄은 버린다(센다). */
function collect(lines, srcs) {
  const meta = {}; const body = {}; let stray = 0;
  for (const s of srcs) { meta[s] = {}; body[s] = []; }
  for (const raw of lines) {
    const l = String(raw).slice(0, LINE_MAX);
    const src = SRC_OF_PREFIX[l[0]];
    if (!src || !srcs.includes(src)) { if (l.trim()) stray += 1; continue; }
    if (l[1] === '|') { body[src].push(l.slice(2)); continue; }
    if (l[1] === '#') {
      const kv = l.slice(2); const eq = kv.indexOf('=');
      const k = eq < 0 ? kv : kv.slice(0, eq);
      if (/^[a-z]{1,8}$/.test(k) && !Object.hasOwn(meta[src], k)) meta[src][k] = eq < 0 ? true : kv.slice(eq + 1).slice(0, 220);
      continue;
    }
    stray += 1;
  }
  return { meta, body, stray };
}

/** 파일 출처(secure · audit · 용도) 상태 · 다음 위치. */
function fileSource(meta, emitted, prev) {
  if (meta.absent) return { st: { status: 'absent', n: null, emitted: null, truncated: null }, next: prev || null };
  if (meta.perm) return { st: { status: 'perm', n: null, emitted: null, truncated: null }, next: prev || null };
  if (meta.nofile) return { st: { status: 'nofile', n: null, emitted: null, truncated: null }, next: prev || null };
  const ino = typeof meta.ino === 'string' && DIGITS_RE.test(meta.ino) ? meta.ino : '';
  const off = typeof meta.off === 'string' && DIGITS_RE.test(meta.off) ? meta.off : '';
  const n = intOf(meta.n);
  if (meta.fail || !ino || !off || n == null) return { st: { status: 'failed', n: null, emitted: null, truncated: null, ...(meta.fail ? { reason: String(meta.fail).slice(0, 16) } : {}) }, next: prev || null };
  const mode = ['first', 'inc', 'shrink', 'rot'].includes(meta.mode) ? meta.mode : null;
  return {
    st: { status: 'ok', n, emitted, truncated: Math.max(0, n - emitted), mode, ...(mode === 'rot' ? { rotated: true, lost: meta.old !== '1' } : {}), ...(mode === 'shrink' ? { shrunk: true } : {}) },
    next: { ino, off },
  };
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
  const sources = {}; const items = []; const next = { apps: {} };
  const miss = (src, why) => { sources[src] = { status: why, n: null, emitted: null, truncated: null }; };
  const keepPrev = (src) => {
    if (src === 'journal') next.journal = P.journal || null;
    else if (src === 'kernel') next.kernel = P.kernel || null;
    else if (src === 'secure' || src === 'audit') next[src] = P[src] || null;
    else next.apps[src] = P.apps?.[src] || null;
  };
  let stray = 0;
  for (const name of LOG_SECTIONS.slice(0, -1)) {
    const srcs = SECTION_SRCS[name];
    if (!Array.isArray(sec[name])) { for (const s of srcs) { miss(s, name === cutName ? 'cut' : 'missing'); keepPrev(s); } continue; }
    const { meta, body, stray: st0 } = collect(sec[name], srcs);
    stray += st0;
    for (const src of srcs) {
      const m = meta[src]; const b = body[src];
      if (src === 'journal') {
        if (m.absent) { miss(src, 'absent'); keepPrev(src); continue; }
        const n = intOf(m.n); const rc = intOf(m.rc);
        const cur = typeof m.cur === 'string' && CURSOR_RE.test(m.cur) ? m.cur : null;
        if (m.perm) { sources[src] = { status: 'perm', n: null, emitted: null, truncated: null }; next.journal = cur ? { cursor: cur } : (P.journal || null); continue; }
        if (n == null || (rc != null && rc !== 0 && !n)) {
          // 실패 — 커서가 있었으면 비운다(커서가 지워진 저널이면 계속 실패한다 → 다음 주기는 ‘최근 60분’ 으로 다시 잡는다 · 그 사이는 모른다)
          sources[src] = { status: 'failed', n: null, emitted: null, truncated: null, rc, ...(P.journal?.cursor ? { cursorReset: true } : {}), ...(m.err ? { toolMsg: true } : {}) };
          next.journal = null; continue;
        }
        const its = [];
        let cont = 0;
        for (const l of b) {
          // journalctl 은 여러 줄 메시지의 다음 줄을 들여 쓴다 — 따로 세지 않는다(오류 1건이 여러 건으로 부풀지 않게 · loganalysis 의 스택 줄 규약과 같은 뜻)
          if (/^[ \t]/.test(l)) { cont += 1; continue; }
          const p = parseTextLine(l.slice(0, LINE_MAX), { now });
          if (!p) continue;
          if (p.cont) { cont += 1; continue; }
          its.push({ src, unit: String(p.proc || '').slice(0, 64), ts: clampTs(p.ts, now), msg: cleanMsg(p.msg) });
        }
        for (const x of its) items.push(x);   // 전개 push 금지(큰 배열 RangeError — 스윕)
        sources[src] = { status: 'ok', n, emitted: b.length, truncated: Math.max(0, n - b.length), cont, ...(rc ? { rc } : {}), ...(m.err ? { toolMsg: true } : {}), ...(P.journal?.cursor ? {} : { first: true }) };
        next.journal = cur ? { cursor: cur } : (P.journal || null);
        continue;
      }
      if (src === 'kernel') {
        if (m.absent) { miss(src, 'absent'); keepPrev(src); continue; }
        const n = intOf(m.n); const rc = intOf(m.rc);
        if (m.perm || (rc != null && rc !== 0 && !n)) { sources[src] = { status: m.perm ? 'perm' : 'failed', n: null, emitted: null, truncated: null, ...(rc != null ? { rc } : {}) }; keepPrev(src); continue; }
        const boot = typeof m.boot === 'string' && BOOT_RE.test(m.boot) ? m.boot : '';
        const last = typeof m.last === 'string' && SECS_RE.test(m.last) ? m.last : '';
        const up = Number(m.up); const rnow = intOf(m.now);
        // 부팅 시각(서버 시계) = 서버 now − uptime. 커널 [초] + 부팅 시각 = 그 줄의 벽시계(dmesg -T 와 같은 근사 — 일시 정지가 없는 서버 기준).
        const bootAt = Number.isFinite(up) && up > 0 && rnow != null ? rnow * 1000 - up * 1000 : null;
        for (const l of b) {
          const d = parseDmesgLine(l);
          if (!d) continue;
          items.push({ src, unit: 'kernel', ts: bootAt != null ? clampTs(Math.round(bootAt + d.secs * 1000), now) : null, msg: d.msg, level: d.level });
        }
        sources[src] = { status: n == null ? 'failed' : 'ok', n, emitted: b.length, truncated: n == null ? null : Math.max(0, n - b.length), ...(P.kernel?.boot && boot && P.kernel.boot !== boot ? { rebooted: true } : {}) };
        next.kernel = boot ? { boot, ...(last ? { last } : {}) } : (P.kernel || null);
        continue;
      }
      // 파일 출처
      const prevPos = src === 'secure' || src === 'audit' ? P[src] : P.apps?.[src];
      const fsrc = fileSource(m, b.length, prevPos);
      sources[src] = { ...fsrc.st, ...(src === 'audit' && typeof m.svc === 'string' ? { svc: /^[a-z-]{1,16}$/.test(m.svc) ? m.svc : null } : {}) };
      if (APP_LOGS.some((a) => a.id === src)) {
        const dir = intOf(typeof m.dir === 'string' ? m.dir : null);
        if (fsrc.next && dir != null) fsrc.next.dir = dir;
        next.apps[src] = fsrc.next;
      } else next[src] = fsrc.next;
      if (fsrc.st.status !== 'ok') continue;
      for (const l of b) {
        if (src === 'secure') {
          const p = parseTextLine(l.slice(0, LINE_MAX), { now });
          if (!p || p.cont) continue;
          items.push({ src, unit: String(p.proc || '').slice(0, 64), ts: clampTs(p.ts, now), msg: cleanMsg(p.msg) });
        } else if (src === 'audit') {
          const p = parseAuditLine(l); items.push({ src, unit: 'audit', ts: clampTs(p.ts, now), msg: p.msg });
        } else if (src === 'gpdb') {
          const p = parseGpdbLine(l); items.push({ src, unit: 'postgres', ts: clampTs(p.ts, now), msg: p.msg });
        } else if (src === 'airflow') {
          const p = parseAirflowLine(l); items.push({ src, unit: 'airflow', ts: clampTs(p.ts, now), msg: p.msg });
        }
      }
    }
  }
  return { ended, cut: cutName, items, sources, next, ...(stray ? { stray } : {}) };
}
