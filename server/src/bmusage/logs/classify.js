/**
 * bmusage/logs/classify.js — 7a단계 로그 줄 → **분류 · 서명 · 시간 집계 · 보안 상위 · 집중**(엣지 — 설계 §17 ‘엣지에서 분류 · 집계 · 가림’).
 *
 * 엔진은 포탈 자체 로그 분석의 것을 그대로 쓴다: 규칙 정규화(loganalysis/rules.js normalizeRules) · 태그 색인(engine.js indexRules — 출처 태그 규칙 먼저, 그다음 태그 없는 규칙,
 *   처음 맞는 하나) · 템플릿(template.js templateOf — 숫자 · IP · UUID · 16진 · 식별자 치환) · 키 정리(engine.js safeKey — `__proto__` 같은 로그 문자열이 맵 키가 되어도 오염 없음).
 *   여기서 더하는 것은 경로 치환 · 보안 줄의 계정 · IP 치환(서명이 계정마다 갈라지지 않게 — 계정 · IP 는 보안 상위 표로 따로 센다)과 서명 해시뿐이다.
 * ⚠⚠ 가림 판정은 하나(반증 F7): 서명(templateFor)도 표본과 같은 redactSystemLogLine 을 거치고, 같은 줄에서 뽑은 계정 · 주소 값은 서명에서 값으로 한 번 더 치환한다
 *   (scrubFacts) — 표본 · 서명 · 보안 상위가 같은 줄에서 가림이 어긋나지 않는다. 보관된 서명도 읽을 때 같은 가림(maskStoredTmpl — view · 중앙 정제).
 * ⚠ 보안 출처 하나(반증 F1): /var/log/secure · journald 보안 · auditd 에 같은 사건이 함께 있으면 한 출처만 센다(parse.js pickAuthSource · 여기 authSrc —
 *   고르지 않은 auditd 의 인증 · 계정 사실은 패턴만 남기고 보안 상위에는 넣지 않는다).
 * ⚠ 시각 모름(ts null — parse.js dateOf)은 분류 · 시간 칸 · 알림에서 빼고 ‘#undated:<출처>’ 로만 센다(반증 F6 — 지금 시각으로 지어내지 않는다).
 *   알림 입력(장애 줄 · 보안 high · 집중)은 최근 FRESH_MS 안의 줄만.
 *
 * ⚠⚠ 분류 못 한 줄은 **세기만** 한다(출처 · 시간별 개수 — 원문 · 템플릿을 남기지 않는다 · 지어내지 않는다).
 * ⚠⚠ 원문 전체는 저장 · 전송하지 않는다 — 패턴마다 가린 표본(redactSystemLogLine) 최대 5줄만.
 * ⚠ 줄은 MSG_MAX(파서)로 먼저 잘린다 · 보안 추출 정규식도 길이 한정 · 시간 기준 양보(createYielder — 5,000줄 × 서버 수가 이벤트 루프를 막지 않게).
 * 보안 집중(SEC-SSH-FAIL-BURST): 실패 종류 줄을 IP 별로 모아 창(분) 안에서 임계 이상이면 그 줄을 집중 규칙으로 옮긴다(줄을 두 번 세지 않는다).
 *   주기 경계를 넘는 집중을 보려고 IP 별 최근 실패 시각을 carry(커서 상태 — IP 64개 · IP 당 임계 개수까지)로 넘긴다.
 *   ⚠ 판정은 알림까지 — 차단 · 계정 잠금은 하지 않는다(설계 §17).
 */
import crypto from 'node:crypto';
import { normalizeRules } from '../../loganalysis/rules.js';
import { indexRules, safeKey } from '../../loganalysis/engine.js';
import { templateOf } from '../../loganalysis/template.js';
import { redactSystemLogLine } from '../../edgelog/redact.js';
import { createYielder } from '../../util/timeSlice.js';
import { LOG_RULES, DERIVED_RULES, logRuleById } from './rules.js';
import { MSG_MAX } from './parse.js';

export const HOUR = 3_600_000;
export const SAMPLES_MAX = 5;
export const SEC_ITEMS_MAX = 20;          // 서버 · 시간 · 종류마다 상위 항목 수(넘치면 ‘(기타)’ 한 칸에)
export const CARRY_IPS_MAX = 64;
export const BURST_DEFAULTS = Object.freeze({ count: 20, windowMin: 5 });
export const BURST_RULE = DERIVED_RULES[0];
/** 알림 입력(장애 줄 · 보안 high · 집중)은 이 창 안에 일어난 줄만 — 첫 읽기의 지난 줄(파일 끝 200줄 · 반증 F6)이 ‘지금’ 알림이 되지 않게(journald 첫 읽기 창과 같은 60분). */
export const FRESH_MS = 60 * 60_000;
const OTHER = '(기타)';

let _idx = null;
/** 규칙 색인(한 번 — 정규화 · 태그 색인은 포탈 엔진 함수). */
export function ruleIndex() {
  if (!_idx) _idx = indexRules(normalizeRules(LOG_RULES));
  return _idx;
}
/** 한 줄 → 규칙(처음 맞는 하나) | null. 출처 태그 규칙 → 태그 없는 규칙 순(engine.addItem 과 같은 순서). */
export function matchRule(src, msg, idx = ruleIndex()) {
  const s = String(msg ?? '').slice(0, MSG_MAX);
  for (const r of (idx.byTag.get(String(src || '')) || []).concat(idx.byTag.get('') || [])) {
    r.re.lastIndex = 0;
    if (r.re.test(s)) return logRuleById(r.id) || r;
  }
  return null;
}

/** 경로 치환(서명 전) — 길이 한정(경로 조각 64자 · 깊이 16). */
const PATH_RE = /(^|[\s=:("'[])\/(?:[\w.@+-]{1,64}\/){0,16}[\w.@+-]{1,64}/g;
export const maskPaths = (s) => String(s ?? '').replace(PATH_RE, '$1<path>');

/* ── 보안 줄 추출(길이 한정 · 앵커) ───────────────────────────────────────── */
const FOR_FROM_RE = / for (?:invalid user )?(\S{0,64}) from (\S{1,64})/;
const INVALID_RE = /^Invalid user (\S{0,64}) from (\S{1,64})/;
/** OpenSSH 7.6+ 연결 식별 꼴 — ‘(invalid|authenticating) user 계정 주소 port N’ · ‘user 계정 주소 port N’(반증 F8: ‘from’ 다음 낱말을 주소로 뽑아 ‘invalid’ 가 IP 가 됐다). */
const CONNID_RE = /\b(?:(?:invalid|authenticating) )?user (\S{0,64}) (\S{1,64}) port \d{1,5}/;
/** 계정 없는 연결 꼴 — ‘Connection closed by 주소 port N’ 등. */
const PEER_RE = /^(?:Connection (?:closed|reset) by|Received disconnect from|Disconnected from|Unable to negotiate with|Did not receive identification string from) (\S{1,64}) port \d{1,5}/;
const RHOST_RE = /\brhost=(\S{0,64})/;
const PUSER_RE = /\buser=(\S{1,64})/;
const SUDO_RE = /^\s{0,4}(\S{1,64}) : /;
const SUDO_USER_RE = /; USER=(\S{1,64}) ;/;
const SUDO_CMD_RE = /; COMMAND=(\S{1,128})/;
const SU_RE = /^FAILED SU \(to (\S{1,64})\) (\S{1,64}) on /;
const ACCT_RE = /\bname=([^,\s]{1,64})|\buser '([^']{1,64})'|password changed for (\S{1,64})|^add '([^']{1,64})'|\bgroup '([^']{1,64})'/;
const AVC_RE = /\bcomm="([^"]{1,64})"/;
const TCLASS_RE = /\btclass=(\w{1,32})/;
const AUD_ACCT_RE = /\bacct="([^"]{0,64})"/;
const AUD_ADDR_RE = /\baddr=([\w.:-]{1,64})/;
const AUD_OP_RE = /\bop=([\w-]{1,40})/;
const GP_USER_RE = /\b(?:user|role) "([^"]{1,64})"/;
const GP_HOST_RE = /\bhost "([^"]{1,64})"/;
const clean = (v, n = 64) => String(v ?? '').slice(0, n).replace(/[\u0000-\u001f\u007f"'`\\]/g, '').trim();
const IPV4 = '\\d{1,3}(?:\\.\\d{1,3}){3}';
/** 주소 꼴만(IPv4 · IPv6(콜론 둘 이상) · 점이 있는 호스트 이름) — 아니면 ''(‘invalid’ · ‘user’ 같은 낱말이 주소로 들어가지 않게 · 반증 F8). */
const IP_RE = new RegExp(`^(?:${IPV4}|(?:[0-9a-fA-F]{0,4}:){2,7}(?:[0-9a-fA-F]{0,4}|${IPV4}))$`);
const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?){1,6}$/;
export const ipOf = (v) => { const s = clean(v).replace(/%[\w.-]{1,16}$/, ''); return s && (IP_RE.test(s) || (HOST_RE.test(s) && /[A-Za-z]/.test(s))) ? s : ''; };
/** sshd · 로그인 실패 계열 규칙(같은 추출 순서). */
const SSHISH_RE = /^SEC-(?:SSH|ROOT|LOGIN)/;

/** 보안 규칙 줄 → { user, ip, item }(없는 칸은 ''). 순수 · 길이 한정. */
export function secFacts(rule, msg) {
  const s = String(msg ?? '').slice(0, MSG_MAX);
  const id = rule?.id || '';
  let user = ''; let ip = ''; let item = '';
  let m;
  if (SSHISH_RE.test(id)) {
    if ((m = INVALID_RE.exec(s)) || (m = FOR_FROM_RE.exec(s)) || (m = CONNID_RE.exec(s))) { user = clean(m[1]); ip = ipOf(m[2]); }
    else if ((m = PEER_RE.exec(s))) ip = ipOf(m[1]);
    else if (RHOST_RE.test(s) || PUSER_RE.test(s)) { user = clean(PUSER_RE.exec(s)?.[1]); ip = ipOf(RHOST_RE.exec(s)?.[1]); }
    else if (id === 'SEC-LOGIN-FAIL') {
      const u = /\b(?:for )?user[= ]'?([\w.@-]{1,64})/.exec(s); if (u) user = clean(u[1]);
      const f = /\bfrom ([\w.:-]{1,64})/.exec(s); if (f) ip = ipOf(f[1]);
    }
  } else if (id === 'SEC-PAM-FAIL' || id === 'SEC-PAM-DUP') { user = clean(PUSER_RE.exec(s)?.[1]); ip = ipOf(RHOST_RE.exec(s)?.[1]); }
  else if (id === 'SEC-SU-FAIL' && (m = SU_RE.exec(s))) { user = clean(m[2]); item = `su → ${clean(m[1])}`; }
  else if (id === 'SEC-SUDO' || id === 'SEC-SUDO-FAIL') {
    user = clean(SUDO_RE.exec(s)?.[1]);
    const to = clean(SUDO_USER_RE.exec(s)?.[1]); const cmd = clean(SUDO_CMD_RE.exec(s)?.[1], 128);
    item = id === 'SEC-SUDO' ? `${user || '?'} → ${to || '?'} ${cmd ? cmd.split('/').pop() : ''}`.trim() : `${user || '?'}`;
  } else if (id === 'SEC-ACCOUNT') {
    m = ACCT_RE.exec(s);
    const who = clean(m ? (m[1] || m[2] || m[3] || m[4] || m[5]) : '');
    const what = /^new user/.test(s) ? 'useradd' : /^new group/.test(s) ? 'groupadd' : /^delete user/.test(s) ? 'userdel' : /^delete group/.test(s) ? 'groupdel' : /password changed/.test(s) ? 'passwd' : /^add '/.test(s) ? 'group+' : 'usermod';
    user = who; item = `${what} ${who}`.trim();
  } else if (id === 'SEC-AVC') {
    item = `${clean(AVC_RE.exec(s)?.[1]) || '?'} · ${clean(TCLASS_RE.exec(s)?.[1]) || '?'}`;
  } else if (/^SEC-AUDIT/.test(id)) {
    user = clean(AUD_ACCT_RE.exec(s)?.[1]); ip = ipOf(AUD_ADDR_RE.exec(s)?.[1]);
    if (id === 'SEC-AUDIT-ACCT') item = `${clean(AUD_OP_RE.exec(s)?.[1]) || 'acct'} ${user}`.trim();
  } else if (id === 'APP-GP-AUTH-FAIL') {
    user = clean(GP_USER_RE.exec(s)?.[1]); ip = ipOf(GP_HOST_RE.exec(s)?.[1]);
  }
  return { user, ip, item };
}
/**
 * 보안 줄의 계정 · 주소를 치환(서명이 계정마다 갈라지지 않게 — 계정 · IP 는 보안 상위 표로). 꼴 치환(문구 구조)이다 — 값 치환은 scrubFacts 가 덧댄다.
 *   ⚠ 반증 F7 · F8: OpenSSH 연결 식별 꼴(invalid · authenticating user 계정 주소 port) · 계정 없는 연결 꼴 · GPDB `user "…"` · `host "…"` 를 더했다.
 */
export function secTemplate(msg) {
  return String(msg ?? '').slice(0, MSG_MAX)
    .replace(/( for (?:invalid user )?)\S{0,64}( from )\S{1,64}/, '$1<user>$2<ip>')
    .replace(/^(Invalid user )\S{0,64}( from )\S{1,64}/, '$1<user>$2<ip>')
    .replace(/\b((?:(?:invalid|authenticating) )?user )\S{0,64} \S{1,64}( port [\d<])/, '$1<user> <ip>$2')
    .replace(/^((?:Connection (?:closed|reset) by|Received disconnect from|Disconnected from|Unable to negotiate with|Did not receive identification string from) )(?!(?:invalid |authenticating )?user )\S{1,64}( port [\d<])/, '$1<ip>$2')
    .replace(/\b(rhost=)\S{0,64}/, '$1<ip>').replace(/\b(r?user=)\S{1,64}/g, '$1<user>')
    .replace(/^(\s{0,4})\S{1,64}( : )/, '$1<user>$2').replace(/(; USER=)\S{1,64}/, '$1<user>').replace(/(; COMMAND=\S{1,128})[ \t].{0,600}$/, '$1')
    .replace(/^(FAILED SU \(to )\S{1,64}(\) )\S{1,64}/, '$1<user>$2<user>')
    .replace(/(name=)[^,\s]{1,64}/, '$1<user>').replace(/(user ')[^']{1,64}'/, "$1<user>'").replace(/(password changed for )\S{1,64}/, '$1<user>').replace(/^(add ')[^']{1,64}'/, "$1<user>'")
    .replace(/(acct=")[^"]{0,64}"/, '$1<user>"').replace(/\b(addr=|hostname=)\S{1,64}/g, '$1<ip>')
    .replace(/\b(user|role) "[^"]{1,64}"/g, '$1 "<user>"').replace(/\bhost "[^"]{1,64}"/g, 'host "<ip>"');
}
const esc = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * 같은 줄에서 뽑은 계정 · 주소 값이 서명에 남지 않게 값으로 한 번 더 치환(반증 F7 — 보안 상위는 가림 토큰인데 서명에 원문이 나가던 결함).
 *   낱말 경계(공백 · 따옴표 · = · : · 괄호 · 쉼표)로만 — 값의 일부 글자를 지우지 않는다.
 */
export function scrubFacts(text, facts) {
  let out = String(text ?? '');
  for (const [v, tok] of [[facts?.user, '<user>'], [facts?.ip, '<ip>']]) {
    if (typeof v !== 'string' || !v || v === '?' || v.length > 64) continue;
    out = out.replace(new RegExp(`(^|[\\s"'=(:,<\\[])${esc(v)}(?=$|[\\s"'),:;>\\]])`, 'g'), `$1${tok}`);
  }
  return out;
}
/** 서명(순수 · 안정 — 출처 · 규칙 · 정규화 템플릿의 SHA-1 앞 16자). */
export function signatureOf(src, ruleId, tmpl) {
  return crypto.createHash('sha1').update(`${src}|${ruleId || '-'}|${tmpl}`).digest('hex').slice(0, 16);
}
/**
 * 줄 → 템플릿(서명 입력 · 화면 ‘서명’ 열 — 계정 · IP · 경로 · 숫자를 치환한 것이라 원문이 아니다).
 *   ⚠⚠ 가림 판정은 표본과 **같은 함수**(redactSystemLogLine — 비밀 · 메일 · 토큰 · 전화 · 카드)를 거친다(반증 F7 — 서명은 가림을 건너뛰어 같은 줄의 표본은 [가림] 인데 서명에 원문이 남았다).
 *   순서: 보안 꼴 치환(secTemplate) → 같은 줄 계정 · 주소 값 치환(scrubFacts) → 비밀 가림 → 경로 → 숫자 · IP · 16진(templateOf).
 */
export function templateFor(rule, msg, facts = null) {
  let base = String(msg ?? '').slice(0, MSG_MAX);
  if (rule?.cls === 'sec') base = scrubFacts(secTemplate(base), facts || secFacts(rule, base));
  return templateOf(maskPaths(redactSystemLogLine(base))).slice(0, 200);
}
/** 보관된 서명을 읽을 때 같은 가림을 다시 댄다(읽기 경로 방어 — 엣지 · 중앙이 받은 tmpl 도 같은 함수 · 멱등). */
export function maskStoredTmpl(cls, tmpl) {
  let s = String(tmpl ?? '').slice(0, 200);
  if (cls === 'sec') s = secTemplate(s);
  return redactSystemLogLine(s).slice(0, 200);
}

/**
 * IP 별 실패 시각 → 창 안 임계 이상 여부(순수). times 는 정렬된 ms 배열 · 반환은 이번 주기 사건(cur 집합)의 시각 중 집중에 든 것.
 */
export function burstTimes(times, cur, { count = BURST_DEFAULTS.count, windowMin = BURST_DEFAULTS.windowMin } = {}) {
  const w = Math.max(1, windowMin) * 60_000; const n = Math.max(2, count);
  const t = [...times].sort((a, b) => a - b);
  const hit = new Set();
  let lo = 0;
  for (let hi = 0; hi < t.length; hi += 1) {
    while (t[hi] - t[lo] > w) lo += 1;
    if (hi - lo + 1 >= n) for (let k = lo; k <= hi; k += 1) hit.add(t[k]);
  }
  return cur.filter((x) => hit.has(x));
}

const hourOf = (ts) => Math.floor(ts / HOUR) * HOUR;

/**
 * 한 서버 · 한 주기의 줄 묶음을 분류 · 집계한다.
 * @param {Array<{src,unit,ts,msg}>} items  파서 결과
 * @param {{now?:number, burst?:{count,windowMin}, carry?:object, sliceMs?:number}} o
 * @returns {Promise<{patterns:Map, hours:Map, sec:Map, counts:object, carry:object, bursts:Array}>}
 */
export async function classifyItems(items = [], { now = Date.now(), burst = BURST_DEFAULTS, carry = null, sliceMs = 15, authSrc = undefined, freshMs = FRESH_MS } = {}) {
  const idx = ruleIndex();
  const maybeYield = createYielder(sliceMs);
  const patterns = new Map(); const hours = new Map(); const sec = new Map();
  const counts = { fault: 0, perf: 0, sec: 0, issue: 0, none: 0, secHigh: 0, faultLines: 0, lines: 0, undated: 0, kindDup: 0 };
  const failEv = [];   // { i, ip, ts }
  const classified = [];
  const hourNow = hourOf(now);
  for (let i = 0; i < items.length; i += 1) {
    if ((i & 255) === 0) await maybeYield();
    const it = items[i];
    if (!it || typeof it.msg !== 'string' || !it.msg) continue;
    counts.lines += 1;
    const src = String(it.src || '');
    // ⚠ 시각을 모르는 줄(30일보다 오래됨 · 시각 없음 — parse.js dateOf)은 지금 시각으로 지어내지 않는다: 분류 · 시간 칸 · 알림에서 빼고 출처별 ‘시각 모름’ 으로만 센다(반증 F6).
    if (!Number.isFinite(it.ts)) {
      counts.undated += 1;
      const hk = `${hourNow}|#undated:${src}`;
      const h = hours.get(hk) || { hour: hourNow, sig: `#undated:${safeKey(src)}`, cls: 'undated', count: 0 };
      h.count += 1; hours.set(hk, h);
      continue;
    }
    const ts = it.ts;
    let rule = matchRule(src, it.msg, idx);
    // audit 의 인증 실패 · 계정 변경은 secure · journald 보안을 읽은 주기에는 같은 사건이다 — 패턴은 남기되 보안 사실(kind)은 세지 않는다(authSrc · 반증 F1).
    if (rule?.kind && rule.kind !== 'avc' && src === 'audit' && authSrc !== undefined && authSrc !== 'audit') { rule = { ...rule, kind: undefined }; counts.kindDup += 1; }
    if (!rule) {
      counts.none += 1;
      const hk = `${hourOf(ts)}|#none:${src}`;
      const h = hours.get(hk) || { hour: hourOf(ts), sig: `#none:${safeKey(src)}`, cls: 'none', count: 0 };
      h.count += 1; hours.set(hk, h);
      continue;
    }
    const facts = rule.cls === 'sec' ? secFacts(rule, it.msg) : null;
    classified.push({ it, rule, ts, facts, src });
    if (rule.kind === 'fail' && facts?.ip) failEv.push({ k: classified.length - 1, ip: facts.ip, ts });
  }
  // 보안 집중 — IP 별(이번 주기 + 직전 carry)
  const bursts = []; const nextCarry = { fails: {} };
  const prevFails = carry && typeof carry === 'object' && carry.fails && typeof carry.fails === 'object' ? carry.fails : {};
  const byIp = new Map();
  for (const e of failEv) { if (!byIp.has(e.ip)) byIp.set(e.ip, []); byIp.get(e.ip).push(e); }
  const winMs = Math.max(1, Number(burst?.windowMin) || BURST_DEFAULTS.windowMin) * 60_000;
  const thr = Math.max(2, Number(burst?.count) || BURST_DEFAULTS.count);
  for (const [ip, evs] of byIp) {
    const prevT = (Array.isArray(prevFails[ip]) ? prevFails[ip] : []).map(Number).filter(Number.isFinite);
    const curT = evs.map((e) => e.ts);
    const hitT = new Set(burstTimes([...prevT, ...curT], curT, { count: thr, windowMin: winMs / 60_000 }));
    if (hitT.size) {
      let c = 0; let from = Infinity; let to = -Infinity;
      for (const e of evs) if (hitT.has(e.ts)) { classified[e.k].rule = BURST_RULE; c += 1; from = Math.min(from, e.ts); to = Math.max(to, e.ts); }
      if (c) bursts.push({ ip, count: c, from, to });
    }
  }
  // carry — 최근 창 안 시각만 · IP 64개(최근 순) · IP 당 임계 개수
  const allIps = new Set([...Object.keys(prevFails), ...byIp.keys()]);
  const carryRows = [];
  for (const ip of allIps) {
    const t = [...(Array.isArray(prevFails[ip]) ? prevFails[ip] : []).map(Number), ...(byIp.get(ip) || []).map((e) => e.ts)].filter((x) => Number.isFinite(x) && x >= now - winMs).sort((a, b) => a - b).slice(-thr);
    if (t.length) carryRows.push([ip, t]);
  }
  carryRows.sort((a, b) => b[1].at(-1) - a[1].at(-1));
  for (const [ip, t] of carryRows.slice(0, CARRY_IPS_MAX)) nextCarry.fails[safeKey(ip)] = t;

  // 패턴 · 시간 · 보안 집계
  const secDistinct = new Map();   // '<시간>|<종류>' → 서로 다른 항목 수(상한 판정 — 키를 매번 훑지 않는다)
  for (let j = 0; j < classified.length; j += 1) {
    if ((j & 255) === 0) await maybeYield();
    const { it, rule, ts, facts, src } = classified[j];
    counts[rule.cls] += 1;
    const fresh = ts >= now - freshMs;
    if (rule.cls === 'fault' && fresh) counts.faultLines += 1;
    if (rule.cls === 'sec' && fresh && (rule.severity === 'high' || rule.severity === 'critical')) counts.secHigh += 1;
    const tmpl = templateFor(rule.id === BURST_RULE.id ? logRuleById('SEC-SSH-FAIL') : rule, it.msg, facts);
    const sig = signatureOf(src, rule.id, tmpl);
    let p = patterns.get(sig);
    if (!p) { p = { sig, cls: rule.cls, severity: rule.severity, ruleId: rule.id, src, unit: String(it.unit || '').slice(0, 64), tmpl, count: 0, first: ts, last: ts, samples: [] }; patterns.set(sig, p); }
    p.count += 1;
    if (ts < p.first) p.first = ts;
    if (ts >= p.last) p.last = ts;
    // 표본 — 가린 줄 최대 5(가장 최근 쪽을 남긴다)
    const text = redactSystemLogLine(it.msg).slice(0, 300);
    p.samples.push({ ts, text });
    if (p.samples.length > SAMPLES_MAX) { p.samples.sort((a, b) => a.ts - b.ts); p.samples.shift(); }
    const hk = `${hourOf(ts)}|${sig}`;
    const h = hours.get(hk) || { hour: hourOf(ts), sig, cls: rule.cls, count: 0 };
    h.count += 1; hours.set(hk, h);
    if (rule.cls === 'sec' && rule.kind) {
      const add = (kind, item) => {
        if (!item) return;
        const key0 = `${hourOf(ts)}|${kind}`;
        const ik = `${key0}|${safeKey(item)}`;
        const n = secDistinct.get(key0) || 0;
        const tk = sec.has(ik) || n < SEC_ITEMS_MAX ? ik : `${key0}|${OTHER}`;
        if (!sec.has(tk)) secDistinct.set(key0, n + 1);
        const e = sec.get(tk) || { hour: hourOf(ts), kind, item: tk === ik ? safeKey(item) : OTHER, count: 0 };
        e.count += 1; sec.set(tk, e);
      };
      const f = facts || {};
      const k = rule.kind;
      if (k === 'fail') { add('fail_ip', f.ip || '(IP 없음)'); add('fail_user', f.user || '(계정 없음)'); }
      else if (k === 'ok' || k === 'root') { add('ok', `${f.user || '?'} ${f.ip || ''}`.trim()); if (k === 'root') add('root', f.ip || '(IP 없음)'); }
      else if (k === 'sudo') add('sudo', f.item || f.user);
      else if (k === 'sudofail') add('sudofail', f.user || '?');
      else if (k === 'acct') add('acct', f.item || f.user || '?');
      else if (k === 'avc') add('avc', f.item || '?');
    }
  }
  counts.freshBursts = bursts.filter((b) => b.to >= now - freshMs).length;
  return { patterns, hours, sec, counts, carry: nextCarry, bursts };
}
