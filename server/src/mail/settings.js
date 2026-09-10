/**
 * mail/settings.js — 포탈 공용 메일(SMTP) 설정 (`mail.json`, v2.454).
 *
 * **한 곳에서만** SMTP 를 설정하고 모든 기능이 그것을 쓴다. 기능마다 SMTP 를 따로 두면
 * 운영자가 같은 값을 여러 번 입력하고, 한쪽만 고쳐 놓고 "왜 이 알림만 안 오지" 를 겪는다.
 *
 * 규약(server/CLAUDE.md 자격증명 규칙과 동일):
 *  - SMTP 비밀번호는 봉인 저장(`SECRET_FILES` 에 `mail.json` 등록) + 0600 + 원자적 쓰기 + 손상 보존.
 *  - **비밀 값은 어떤 API 응답에도 싣지 않는다** — `redact()` 가 `hasPassword` 불리언만 남긴다.
 *  - 저장 시 **빈 비밀번호 = 기존 유지**(화면이 값을 되받지 못하므로 그대로 저장하면 지워진다).
 *  - 검증은 순수 함수(`smtpIssue`·`validate`)로 분리 — 웹 테스트가 node 환경이라 화면 렌더
 *    테스트가 불가하므로 판정을 여기에 고정한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { openSecretsDeep, sealSecretsDeep } from '../security/secretVault.js';
import { normalizeAddresses } from '../util/smtp.js';
import { KINDS, isKind } from './kinds.js';

const FILE = path.join(config.configDir, 'mail.json');

export const DEFAULTS = Object.freeze({
  enabled: false,                 // 설치만으로 메일이 나가면 안 된다 — 명시적으로 켠다
  smtp: {
    host: '', port: 25, secure: false, startTls: true,
    user: '', password: '', from: '', fromName: 'VMware Portal',
    rejectUnauthorized: true, timeoutMs: 20000,
  },
  defaultTo: [],                  // 종류별 수신자가 없을 때 쓰는 기본 수신자
  kinds: {},                      // { [kindId]: { enabled, to[], cc[] } }
  rateLimitPerHour: 60,           // 릴레이 보호 — 0 이면 제한 없음
  historyMax: 200,                // 발송 이력 보관 건수(메모리)
});

let cache = null;

const clamp = (v, lo, hi, def) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
};

function normKinds(raw) {
  const out = {};
  for (const k of KINDS) {
    const v = (raw || {})[k.id] || {};
    out[k.id] = {
      enabled: v.enabled !== false,                    // 기본 켜짐 — 전역 enabled 가 상위 스위치다
      to: normalizeAddresses(v.to).ok,
      cc: normalizeAddresses(v.cc).ok,
    };
  }
  return out;
}

export function load() {
  if (cache) return cache;
  const out = structuredClone(DEFAULTS);
  out.kinds = normKinds({});
  try {
    if (fs.existsSync(FILE)) {
      const p = openSecretsDeep(JSON.parse(fs.readFileSync(FILE, 'utf8')) || {});
      if (typeof p.enabled === 'boolean') out.enabled = p.enabled;
      if (p.smtp && typeof p.smtp === 'object') out.smtp = { ...out.smtp, ...p.smtp };
      out.defaultTo = normalizeAddresses(p.defaultTo).ok;
      out.kinds = normKinds(p.kinds);
      out.rateLimitPerHour = clamp(p.rateLimitPerHour, 0, 10000, DEFAULTS.rateLimitPerHour);
      out.historyMax = clamp(p.historyMax, 20, 2000, DEFAULTS.historyMax);
    }
  } catch (e) {
    // 손상 파일을 조용히 빈 설정으로 넘기면 다음 저장이 원본(수신자·SMTP 계정)을 지운다.
    preserveCorrupt(FILE);
    console.warn(`[mail] 설정 로드 실패 — 원본을 .corrupt 로 보존하고 기본값으로 시작합니다: ${e.message}`);
  }
  cache = out;
  return cache;
}

export function save(body = {}) {
  const cur = load();
  const next = structuredClone(cur);
  if (typeof body.enabled === 'boolean') next.enabled = body.enabled;
  if (body.smtp && typeof body.smtp === 'object') {
    const s = body.smtp;
    next.smtp = {
      host: String(s.host ?? cur.smtp.host).trim().slice(0, 253),
      port: clamp(s.port, 1, 65535, cur.smtp.port || 25),
      secure: s.secure === true,
      startTls: s.startTls !== false,
      user: String(s.user ?? cur.smtp.user).trim().slice(0, 200),
      // ★ 빈 값 = 기존 유지. 지우려면 clearPassword 를 명시적으로 보낸다.
      password: s.clearPassword === true ? '' : (s.password ? String(s.password) : cur.smtp.password),
      from: String(s.from ?? cur.smtp.from).trim().slice(0, 253),
      fromName: String(s.fromName ?? cur.smtp.fromName).slice(0, 80),
      rejectUnauthorized: s.rejectUnauthorized !== false,
      timeoutMs: clamp(s.timeoutMs, 1000, 120000, cur.smtp.timeoutMs || 20000),
    };
  }
  if (body.defaultTo != null) next.defaultTo = normalizeAddresses(body.defaultTo).ok;
  if (body.kinds && typeof body.kinds === 'object') next.kinds = normKinds(body.kinds);
  if (body.rateLimitPerHour != null) next.rateLimitPerHour = clamp(body.rateLimitPerHour, 0, 10000, DEFAULTS.rateLimitPerHour);
  if (body.historyMax != null) next.historyMax = clamp(body.historyMax, 20, 2000, DEFAULTS.historyMax);

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

/* ── 검증(순수) ─────────────────────────────────────────────────────── */

/** SMTP 설정의 문제점. 없으면 null. */
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

/** 저장 전 전체 검증. 문제 목록(빈 배열이면 통과). */
export function validate(cfg) {
  const out = [];
  if (!cfg?.enabled) return out;                       // 꺼져 있으면 형식만 맞으면 된다
  const s = smtpIssue(cfg.smtp);
  if (s) out.push(s);
  // 켜져 있는 종류 중 받는 사람을 어디서도 찾을 수 없는 것이 있으면 미리 알린다
  // (조용히 안 보내면 "왜 메일이 안 오지" 로 이어진다).
  const hasDefault = (cfg.defaultTo || []).length > 0;
  for (const k of KINDS) {
    if (k.id === 'test') continue;
    const per = (cfg.kinds || {})[k.id] || {};
    if (per.enabled === false) continue;
    if (!hasDefault && !(per.to || []).length && !(per.cc || []).length) {
      out.push(`'${k.label}' 의 받는 사람이 없습니다 — 기본 수신자 또는 종류별 수신자를 지정하세요.`);
    }
  }
  return out;
}

/** 알 수 없는 종류 id 를 저장하려는 시도를 걸러낸다(설정 파일 오염 방지). */
export function unknownKinds(kinds) {
  return Object.keys(kinds || {}).filter((k) => !isKind(k));
}

export const _FILE = FILE;
