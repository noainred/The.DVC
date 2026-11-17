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
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, safeLoadText } from '../util/atomicWrite.js';
import { makeJsonFileLoader } from '../util/jsonFileLoad.js';   // 결정(56~75 남긴 것) 73 ①
import { openSecretsDeep, sealSecretsDeep } from '../security/secretVault.js';
import { normalizeAddresses } from '../util/smtp.js';
import { KINDS, isKind } from './kinds.js';

import { ssrfBlockReason } from '../collector/registry.js';   // v2.575 SEC-15
import { clampSetting } from '../util/clampSetting.js';
import { parseJsonObject } from '../util/jsonObject.js'; // v3.17.2: 객체가 아닌 JSON(수 · 글자 · 배열)은 깨진 JSON 과 같이 — 손상 보존 경로로
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

// v2.598 L2598-03: 빈 칸('')·null 은 '미지정'(def = 이전 값) — 예전 `Math.floor(Number(''))` 는 0 이라 칸을 비우면
// 시간당 발송 한도 0(=제한 없음) · SMTP 포트 1 · 시한 1초로 **조용히 저장됐다**. 판정은 util/clampSetting.js 하나(v2.595).
const clamp = (v, lo, hi, def) => {
  const n = clampSetting(v, { min: lo, max: hi, def: null, round: false });
  return n == null ? def : Math.floor(n);
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

/*
 * 결정(56~75 남긴 것) 73 ①(73회차 남긴 것): 로드 catch 가 읽기 오류(EACCES · EIO · EMFILE)도 손상으로 보고 원본(SMTP 계정 · 수신자)을 .corrupt 로 옮겼다.
 *   이제 공용 로더 — 읽기 오류는 원본을 두고 기본값(발송 꺼짐)을 캐시하지 않으며(30초 간격 재읽기) · 손상은 예전처럼 보존 ·
 *   둘 다 로드 오류(서비스 점검 등재 — 확정은 설정 소유자: 쓰기 라우트가 requireSettingsOwner) · 오류 중 저장은 409(saveRefusal).
 *   parse 안의 openSecretsDeep 실패(봉인 손상)도 예전처럼 손상으로 본다.
 */
const _file = makeJsonFileLoader(() => FILE, { label: '메일 발송 설정(SMTP · 수신자 — mail.json) — 확정하면 기본값(발송 꺼짐 · SMTP · 수신자 없음)으로 저장됩니다', confirm: () => { atomicWriteFileSync(FILE, JSON.stringify(sealSecretsDeep(defaultsOut()), null, 2), { mode: 0o600 }); cache = null; _file.saved(); }, ownerOnly: true, parse: (text) => openSecretsDeep(parseJsonObject(text)), tag: 'mail' });
function defaultsOut() { const out = structuredClone(DEFAULTS); out.kinds = normKinds({}); return out; }
/** 메일 설정 파일을 못 읽었으면 { reason, at, readError }, 아니면 null(GET /admin/mail 표지). */
export function mailSettingsLoadError() { load(); return _file.marker(); }
/** 저장 거절 응답(409) 또는 null — PUT /admin/mail 이 검증보다 먼저 본다. */
export function mailSaveRefusal() { load(); return _file.refusal('메일 발송 설정'); }

export function load() {
  if (cache && !_file.recheckDue()) return cache;   // 결정 G2 반증 후속 ③: 오류 중에는 캐시를 믿지 않고 30초마다 다시 판정(보존본을 되돌리면 재시작 없이 풀린다)
  const out = defaultsOut();
  const r = _file.load();
  if (r.kind === 'read-error') return out;   // 73 ①: 기본값(발송 꺼짐)을 캐시하지 않는다 — 간격 뒤 다시 읽는다
  if (r.kind === 'ok') {
    const p = r.value;
    if (typeof p.enabled === 'boolean') out.enabled = p.enabled;
    if (p.smtp && typeof p.smtp === 'object') out.smtp = { ...out.smtp, ...p.smtp };
    out.defaultTo = normalizeAddresses(p.defaultTo).ok;
    out.kinds = normKinds(p.kinds);
    out.rateLimitPerHour = clamp(p.rateLimitPerHour, 0, 10000, DEFAULTS.rateLimitPerHour);
    out.historyMax = clamp(p.historyMax, 20, 2000, DEFAULTS.historyMax);
  } else if (r.kind === 'corrupt') {
    // 손상 파일을 조용히 빈 설정으로 넘기면 다음 저장이 원본(수신자·SMTP 계정)을 지운다 — 로더가 보존했다.
    // v2.744(최종 검토 RG2744-02): 사유는 요약이다(원문은 SMTP 비밀번호 앞부분 같은 파일 조각을 싣는다 — 원문은 mail.json.corrupt.* 에 있다).
    console.warn(`[mail] 설정 로드 실패 — 원본을 .corrupt 로 보존하고 기본값으로 시작합니다: ${safeLoadText(r.error) || '사유 미상'}`);
  }
  cache = out;
  return cache;
}

/**
 * SMTP 서버 주소를 저장 전에 검사한다 (v2.575 SEC-15).
 *
 * ⚠ 이 저장소는 **저장되는 접속처를 등록 시점에 `ssrfBlockReason` 으로 거른다**
 * (server/CLAUDE.md v2.537 — storage·sanswitch·pdu·iDRAC·NSX·bmstor 6개 등록부).
 * SMTP 만 그 규약 밖에 있었다 — 링크로컬(169.254.169.254 클라우드 메타데이터)·루프백·
 * 우회 표기를 넣어도 통과했고, 그 주소로 **계정·비밀번호가 나간다**.
 * ⚠ RFC1918(사내망)은 **허용**이다 — 사내 릴레이가 정상 구성이다. 막는 것은 링크로컬·
 *   루프백·우회 표기뿐이고, 그것이 `ssrfBlockReason` 의 정책 그대로다.
 * ⚠ **기존에 저장된 값은 재검증하지 않는다**(수정 시점에 걸린다) — 그러지 않으면 업그레이드
 *   직후 멀쩡히 돌던 현장의 메일이 저장도 못 한 채 죽는다(v2.537 규약과 같은 판단).
 * ⚠ 비우는 것(`host: ''`)은 '메일 끄기' 이므로 막지 않는다.
 */
export function smtpHostIssue(host) {
  const h = String(host ?? '').trim();
  if (!h) return null;                       // 미설정 = 끄기
  // ssrfBlockReason 은 URL 을 받는다. 포트는 별도 필드이므로 호스트만 검사한다.
  return ssrfBlockReason(h.includes(':') && !h.startsWith('[') ? `[${h}]` : h);
}

/**
 * 저장 후 SMTP 비밀번호와, 비밀번호가 비게 된 사유 — **save 와 PUT 검증이 같은 식을 쓴다**(v2.768 점검 R3-C5-04).
 * 예전 PUT 검증은 `body.password || cur.password` 로 기존 비번을 승계해 보고, save 는 호스트가 바뀌면 비웠다 — 검증을 통과한
 * '계정 있음 + 비밀번호 없음' 설정이 저장돼 자동 발송이 빈 비밀번호로 AUTH → 535 → 인증 정지로 이어졌다.
 *   · 빈 값 = 기존 유지. 지우려면 clearPassword 를 명시적으로 보낸다.
 *   · v2.480(3차 감사 S8): host 가 바뀌면 저장 비번 이월 금지(PDU S-1 규칙) — 새 SMTP 로 평문 자격증명 전송 방지.
 * @returns {{ password: string, dropped: 'cleared'|'hostChanged'|null }}
 */
export function nextSmtpPassword(s = {}, curSmtp = {}) {
  if (s?.clearPassword === true) return { password: '', dropped: curSmtp?.password ? 'cleared' : null };
  if (s?.password) return { password: String(s.password), dropped: null };
  const hostChanged = String(s?.host ?? curSmtp?.host ?? '').trim() !== String(curSmtp?.host || '').trim();
  if (hostChanged) return { password: '', dropped: curSmtp?.password ? 'hostChanged' : null };
  return { password: curSmtp?.password || '', dropped: null };
}

export function save(body = {}) {
  const cur = load();
  // 73 ①: 읽지 못한 값(기본값) 위에 덮어쓰지 않는다 — 라우트가 먼저 409 로 막고, 다른 호출부를 위해 여기서도 던진다.
  { const no = _file.refusal('메일 발송 설정'); if (no) throw Object.assign(new Error(no.reason), { status: 409, code: no.code }); }
  const next = structuredClone(cur);
  if (typeof body.enabled === 'boolean') next.enabled = body.enabled;
  if (body.smtp && typeof body.smtp === 'object') {
    const s = body.smtp;
    // ⚠ v2.575 SEC-15 — 바뀐 주소만 검사한다(기존 값 재검증 금지 — 위 주석).
    const newHost = String(s.host ?? cur.smtp.host).trim().slice(0, 253);
    if (newHost !== String(cur.smtp.host || '').trim()) {
      const issue = smtpHostIssue(newHost);
      if (issue) throw Object.assign(new Error(`SMTP 서버 주소를 쓸 수 없습니다 — ${issue}`), { status: 400 });
    }
    next.smtp = {
      host: newHost,
      port: clamp(s.port, 1, 65535, cur.smtp.port || 25),
      secure: s.secure === true,
      startTls: s.startTls !== false,
      user: String(s.user ?? cur.smtp.user).trim().slice(0, 200),
      // ★ 빈 값 = 기존 유지 · v2.480 host 가 바뀌면 이월 금지 — 판정은 nextSmtpPassword 한 벌(PUT 검증과 공유 — v2.768 R3-C5-04)
      password: nextSmtpPassword(s, cur.smtp).password,
      from: String(s.from ?? cur.smtp.from).trim().slice(0, 253),
      fromName: String(s.fromName ?? cur.smtp.fromName).slice(0, 80),
      rejectUnauthorized: s.rejectUnauthorized !== false,
      timeoutMs: clamp(s.timeoutMs, 1000, 120000, cur.smtp.timeoutMs || 20000),
    };
  }
  if (body.defaultTo != null) next.defaultTo = normalizeAddresses(body.defaultTo).ok;
  if (body.kinds && typeof body.kinds === 'object') next.kinds = normKinds(body.kinds);
  if (body.rateLimitPerHour != null) next.rateLimitPerHour = clamp(body.rateLimitPerHour, 0, 10000, cur.rateLimitPerHour ?? DEFAULTS.rateLimitPerHour);
  if (body.historyMax != null) next.historyMax = clamp(body.historyMax, 20, 2000, cur.historyMax ?? DEFAULTS.historyMax);

  atomicWriteFileSync(FILE, JSON.stringify(sealSecretsDeep(next), null, 2), { mode: 0o600 });
  cache = next;
  _file.saved();
  return next;
}

export function invalidate() { cache = null; _file.resetRetry(); }

/**
 * 결정 G2 · G3 반증 후속 ①: 메일 주소 목록 가림 — GET /admin/mail(73 ③)과 같은 기준. 전체 범위 관리자(조회 ∧ 쓰기 무제한 — auth/scope.js isFullReadWriteScope)가
 *   아니면 주소 대신 개수만 싣는다(통합 관리자 수신자를 보여 주는 도구 화면 — 스토리지 사용량 · 아이실론 종합 메일). 판정 결과(full)는 라우트가 넘긴다.
 * @returns {{ list:string[], count:number, masked:boolean }}
 */
export function maskedMailList(list, full) {
  const a = Array.isArray(list) ? list : [];
  return full ? { list: a, count: a.length, masked: false } : { list: [], count: a.length, masked: true };
}
/** 후속 ①: SMTP 계정 이름 가림 — 전체 범위가 아니면 '' + 있음 표지(통신 점검 설정 링크의 facts.user 등). */
export function maskedSmtpUser(user, full) {
  const u = typeof user === 'string' ? user : '';
  return full ? { user: u } : { user: '', hasUser: !!u, userMasked: true };
}

/** API 응답용 — 비밀 값을 제거하고 존재 여부만 남긴다. */
export function redact(cfg = load()) {
  const { password, ...smtp } = cfg.smtp || {};
  return { ...cfg, smtp: { ...smtp, hasPassword: !!password } };
}

/* ── 검증(순수) ─────────────────────────────────────────────────────── */

/**
 * SMTP 설정의 문제점. 없으면 null.
 * @param {string|null} [dropped] v2.768(점검 R3-C5-04): nextSmtpPassword 가 돌려준 '비밀번호가 비게 된 사유'(PUT 검증만 넘긴다).
 */
export function smtpIssue(smtp, dropped = null) {
  if (!String(smtp?.host || '').trim()) return 'SMTP 서버 주소를 입력하세요.';
  const from = String(smtp?.from || '').trim();
  if (!from) return '보내는 사람(From) 주소를 입력하세요.';
  if (normalizeAddresses([from]).ok.length !== 1) return '보내는 사람(From) 주소 형식이 올바르지 않습니다.';
  const port = Number(smtp?.port);
  if (!Number.isFinite(port) || port < 1 || port > 65535) return '포트는 1~65535 사이여야 합니다.';
  // v2.768(점검 R3-C5-04): 이 오류가 나는 것은 **저장된 비밀번호가 없거나 버려지는** 경우뿐이다(있으면 빈 칸이 기존 유지라
  //   통과한다) — 예전 '(이미 저장돼 있다면 비워 두세요)' 는 그 어느 경우에도 맞지 않는 안내였다. 사유별로 말한다.
  if (smtp?.user && !smtp?.password) {
    if (dropped === 'hostChanged') return 'SMTP 서버 주소가 바뀌어 저장된 비밀번호를 새 서버로 넘기지 않습니다 — 새 서버의 비밀번호를 다시 입력하세요(계정 없이 보내려면 계정을 비우세요).';
    if (dropped === 'cleared') return '비밀번호를 지우려면 계정도 비우세요 — 계정을 쓰려면 새 비밀번호를 입력하세요.';
    return '계정을 입력했다면 비밀번호도 필요합니다(저장된 비밀번호가 없습니다).';
  }
  return null;
}

/** 저장 전 전체 검증. 문제 목록(빈 배열이면 통과). */
export function validate(cfg, dropped = null) {
  const out = [];
  if (!cfg?.enabled) return out;                       // 꺼져 있으면 형식만 맞으면 된다
  const s = smtpIssue(cfg.smtp, dropped);
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

/**
 * 73회차 F4(재현): 저장 본문의 받는 사람 주소 중 형식이 틀린 것 — 기본 수신자 · 종류별 받는 사람 · 참조.
 *   save 는 `normalizeAddresses(...).ok` 만 남겨 **틀린 주소를 조용히 버렸다**('ops@corp' · 'a@b.com x@y.com' 같은 입력이 200 '저장되었습니다' 로
 *   사라지고, 화면 입력칸은 그대로라 저장된 줄 알았다). 라우트가 저장 전에 이것으로 400 을 돌려준다.
 * @returns {{ field: string, bad: string[] } | null}
 */
export function recipientIssue(body = {}) {
  // 75회차(73회차 F4 반증 — 재현): 글자 · 수 · 그 배열만 주소로 읽는다 — `{toString:1}` 같은 객체는 normalizeAddresses 의 String() 이 던져
  //   400 대신 500 이었다(72회차 F4 toolcats 와 같은 함정). 그런 값은 형식 오류(400)로 돌려준다.
  const scalar = (x) => x == null || typeof x === 'string' || typeof x === 'number';
  const check = (v, field) => {
    if (v == null) return null;
    if (!(Array.isArray(v) ? v.every(scalar) : scalar(v))) return { field, bad: ['(주소가 아닌 값)'] };
    const { bad } = normalizeAddresses(v);
    return bad.length ? { field, bad: bad.slice(0, 10) } : null;
  };
  const d = check(body?.defaultTo, 'defaultTo');
  if (d) return d;
  if (body?.kinds && typeof body.kinds === 'object') {
    for (const k of KINDS) {
      const v = body.kinds[k.id];
      if (!v || typeof v !== 'object') continue;
      const r = check(v.to, `kinds.${k.id}.to`) || check(v.cc, `kinds.${k.id}.cc`);
      if (r) return r;
    }
  }
  return null;
}

/** 저장될 종류별 설정(save 와 같은 정규화 — PUT 검증이 저장될 값으로 판정하게, 73회차 F4). */
export function normalizeKinds(raw) { return normKinds(raw); }

/** 알 수 없는 종류 id 를 저장하려는 시도를 걸러낸다(설정 파일 오염 방지). */
export function unknownKinds(kinds) {
  return Object.keys(kinds || {}).filter((k) => !isKind(k));
}

export const _FILE = FILE;
