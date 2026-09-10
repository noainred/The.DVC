/**
 * dirusage/settings.js — 폴더 사용량 리포트 설정 (`dirusage.json`, v2.454).
 *
 * 담는 것: 스캔 대상 목록(엣지·경로·주기·Top N) · 메일 수신자 · SMTP 접속 정보.
 * SMTP 비밀번호는 봉인 대상이라 `SECRET_FILES` 에 이 파일을 등록했다(secretVault).
 *
 * 규약(되돌리지 말 것):
 *  - **비밀 값은 어떤 API 응답에도 싣지 않는다** — `redact()` 가 `hasPassword` 불리언만 남긴다
 *    (통합 계정 관리 v2.419 와 같은 규약). '보기'·'내보내기' 경로를 만들지 말 것.
 *  - 저장 시 **빈 비밀번호 = 기존 유지** — 화면이 값을 못 받으므로 그대로 저장하면 지워진다.
 *  - 원자적 쓰기 + 손상 보존(preserveCorrupt). 조용한 빈값 반환 금지.
 *  - 검증은 순수 함수(`targetIssue`·`mailIssue`·`smtpIssue`)로 분리한다 — 웹 테스트가 node 환경이라
 *    화면 렌더 테스트가 불가하므로 판정을 여기에 고정한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { openSecretsDeep, sealSecretsDeep } from '../security/secretVault.js';
import { TOP_N_MIN, TOP_N_MAX } from './scan.js';
import { normalizeAddresses } from '../util/smtp.js';

const FILE = path.join(config.configDir, 'dirusage.json');

/** 대상 개수 상한 — 하나하나가 엣지에서 수 분 걸리는 du 라 무제한으로 늘리면 안 된다. */
export const MAX_TARGETS = 50;
/** 최소 주기(시간). du 는 무거운 작업이라 시간 단위 아래로 내리지 않는다. */
export const MIN_INTERVAL_HOURS = 1;
export const MAX_INTERVAL_HOURS = 24 * 30;

/** 절대경로만. 상위 참조(`..`)·제어문자·따옴표 금지 — argv 로 넘어가지만 방어적으로 막는다. */
// eslint-disable-next-line no-control-regex
const PATH_RE = /^\/[^\x00-\x1f\x7f'"`$\\]{0,1023}$/;

export const DEFAULTS = Object.freeze({
  enabled: false,
  targets: [],                      // [{ id, label, agent, instance, path, topN, intervalHours, enabled }]
  mail: {
    enabled: false,
    to: [],
    cc: [],
    subject: '[VMware Portal] {root} 폴더 사용량 Top {topN} ({date})',
    onlyOnChange: false,            // true 면 직전과 Top 목록이 같으면 보내지 않는다
  },
  smtp: {
    host: '', port: 25, secure: false, startTls: true,
    user: '', password: '', from: '', rejectUnauthorized: true, timeoutMs: 20000,
  },
  retentionDays: 365,               // 스캔 이력 보존
});

let cache = null;

function normTarget(t, i) {
  const id = String(t?.id || '').trim() || `t${Date.now().toString(36)}${i}`;
  return {
    id,
    label: String(t?.label || '').slice(0, 80),
    agent: String(t?.agent || '').trim(),
    instance: String(t?.instance || '').trim(),
    path: String(t?.path || '').trim(),
    topN: clamp(t?.topN, TOP_N_MIN, TOP_N_MAX, 20),
    intervalHours: clamp(t?.intervalHours, MIN_INTERVAL_HOURS, MAX_INTERVAL_HOURS, 24),
    enabled: t?.enabled !== false,
  };
}

function clamp(v, lo, hi, def) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, n));
}

export function load() {
  if (cache) return cache;
  const out = structuredClone(DEFAULTS);
  try {
    if (fs.existsSync(FILE)) {
      const p = openSecretsDeep(JSON.parse(fs.readFileSync(FILE, 'utf8')) || {});
      if (typeof p.enabled === 'boolean') out.enabled = p.enabled;
      if (Array.isArray(p.targets)) out.targets = p.targets.slice(0, MAX_TARGETS).map(normTarget);
      if (p.mail && typeof p.mail === 'object') {
        out.mail = {
          ...out.mail, ...p.mail,
          to: normalizeAddresses(p.mail.to).ok,
          cc: normalizeAddresses(p.mail.cc).ok,
          subject: String(p.mail.subject || DEFAULTS.mail.subject).slice(0, 200),
          enabled: p.mail.enabled === true,
          onlyOnChange: p.mail.onlyOnChange === true,
        };
      }
      if (p.smtp && typeof p.smtp === 'object') out.smtp = { ...out.smtp, ...p.smtp };
      if (p.retentionDays != null) out.retentionDays = clamp(p.retentionDays, 1, 3650, 365);
    }
  } catch (e) {
    // 손상 파일을 조용히 빈 설정으로 넘기면 다음 저장이 원본(수신자·SMTP 계정)을 지운다.
    preserveCorrupt(FILE);
    console.warn(`[dirusage] 설정 로드 실패 — 원본을 .corrupt 로 보존하고 기본값으로 시작합니다: ${e.message}`);
  }
  cache = out;
  return cache;
}

/** 저장 — 빈 비밀번호는 기존 값을 유지한다(화면이 비밀번호를 되받지 못하므로). */
export function save(body = {}) {
  const cur = load();
  const next = structuredClone(cur);
  if (typeof body.enabled === 'boolean') next.enabled = body.enabled;
  if (Array.isArray(body.targets)) next.targets = body.targets.slice(0, MAX_TARGETS).map(normTarget);
  if (body.mail && typeof body.mail === 'object') {
    next.mail = {
      enabled: body.mail.enabled === true,
      to: normalizeAddresses(body.mail.to).ok,
      cc: normalizeAddresses(body.mail.cc).ok,
      subject: String(body.mail.subject || DEFAULTS.mail.subject).slice(0, 200),
      onlyOnChange: body.mail.onlyOnChange === true,
    };
  }
  if (body.smtp && typeof body.smtp === 'object') {
    const s = body.smtp;
    next.smtp = {
      host: String(s.host ?? cur.smtp.host).trim().slice(0, 253),
      port: clamp(s.port, 1, 65535, cur.smtp.port || 25),
      secure: s.secure === true,
      startTls: s.startTls !== false,
      user: String(s.user ?? cur.smtp.user).trim().slice(0, 200),
      // ★ 빈 값 = 기존 유지. 지우려면 명시적으로 clearPassword 를 보낸다.
      password: s.clearPassword === true ? '' : (s.password ? String(s.password) : cur.smtp.password),
      from: String(s.from ?? cur.smtp.from).trim().slice(0, 253),
      rejectUnauthorized: s.rejectUnauthorized !== false,
      timeoutMs: clamp(s.timeoutMs, 1000, 120000, cur.smtp.timeoutMs || 20000),
    };
  }
  if (body.retentionDays != null) next.retentionDays = clamp(body.retentionDays, 1, 3650, 365);

  atomicWriteFileSync(FILE, JSON.stringify(sealSecretsDeep(next), null, 2), { mode: 0o600 });
  cache = next;
  return next;
}

export function invalidate() { cache = null; }

/** API 응답용 — 비밀 값을 제거하고 존재 여부만 남긴다. */
export function redact(cfg = load()) {
  const { password, ...smtp } = cfg.smtp || {};
  return { ...cfg, smtp: { ...smtp, hasPassword: !!password } };
}

/* ── 검증(순수) ─────────────────────────────────────────────────────────── */

/** 대상 1건의 문제점. 없으면 null. */
export function targetIssue(t) {
  if (!t || typeof t !== 'object') return '대상이 비어 있습니다.';
  if (!String(t.agent || '').trim()) return '엣지(법인)를 선택하세요.';
  const p = String(t.path || '').trim();
  if (!p) return '스캔할 경로를 입력하세요.';
  if (!PATH_RE.test(p)) return '경로는 절대경로여야 하며 따옴표·제어문자·백슬래시를 쓸 수 없습니다.';
  if (p.split('/').includes('..')) return "경로에 '..' 를 쓸 수 없습니다.";
  if (p === '/') return '루트(/) 전체는 스캔하지 않습니다 — 대상 폴더를 지정하세요.';
  const n = Number(t.topN);
  if (!Number.isFinite(n) || n < TOP_N_MIN || n > TOP_N_MAX) return `Top N 은 ${TOP_N_MIN}~${TOP_N_MAX} 사이여야 합니다.`;
  const h = Number(t.intervalHours);
  if (!Number.isFinite(h) || h < MIN_INTERVAL_HOURS || h > MAX_INTERVAL_HOURS) {
    return `주기는 ${MIN_INTERVAL_HOURS}~${MAX_INTERVAL_HOURS}시간 사이여야 합니다(du 는 무거운 작업이라 시간 단위 아래로 내리지 않습니다).`;
  }
  return null;
}

/** 메일 설정의 문제점(발송을 켰을 때만 엄격). */
export function mailIssue(mail, smtp) {
  if (!mail?.enabled) return null;
  const to = normalizeAddresses(mail.to);
  const cc = normalizeAddresses(mail.cc || []);
  if (to.bad.length || cc.bad.length) return `주소 형식 오류: ${[...to.bad, ...cc.bad].join(', ')}`;
  if (!to.ok.length && !cc.ok.length) return '받는 사람을 한 명 이상 입력하세요.';
  return smtpIssue(smtp);
}

/** SMTP 설정의 문제점. */
export function smtpIssue(smtp) {
  if (!String(smtp?.host || '').trim()) return 'SMTP 서버 주소를 입력하세요.';
  const from = String(smtp?.from || '').trim();
  if (!from) return '보내는 사람(From) 주소를 입력하세요.';
  if (normalizeAddresses([from]).ok.length !== 1) return '보내는 사람(From) 주소 형식이 올바르지 않습니다.';
  const port = Number(smtp?.port);
  if (!Number.isFinite(port) || port < 1 || port > 65535) return '포트는 1~65535 사이여야 합니다.';
  if (smtp?.user && !smtp?.password) return '계정을 입력했다면 비밀번호도 필요합니다(이미 저장돼 있다면 비워 두세요).';
  return null;
}

/** 설정 전체 검증 — 저장 전에 호출한다. 문제 목록(빈 배열이면 통과). */
export function validate(cfg) {
  const out = [];
  for (const [i, t] of (cfg?.targets || []).entries()) {
    const e = targetIssue(t);
    if (e) out.push(`대상 ${i + 1}(${t?.path || '경로 없음'}): ${e}`);
  }
  const ids = (cfg?.targets || []).map((t) => t.id);
  if (new Set(ids).size !== ids.length) out.push('대상 id 가 중복되었습니다.');
  const m = mailIssue(cfg?.mail, cfg?.smtp);
  if (m) out.push(`메일: ${m}`);
  return out;
}

export const _FILE = FILE;
