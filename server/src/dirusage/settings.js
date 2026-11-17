/**
 * dirusage/settings.js — 폴더 사용량 리포트 설정 (`dirusage.json`, v2.454).
 *
 * 담는 것: 스캔 대상 목록(엣지·경로·주기·Top N) · 이 리포트의 수신자.
 *
 * ⚠️ **SMTP 접속 정보는 여기 두지 않는다.** 포탈 공용 메일 설정(`mail.json`, 설정 › 메일 발송)
 * 한 곳에서만 정하고 이 기능은 `sendPortalMail({ kind: 'dirusage' })` 로 보낸다. 기능마다 SMTP 를
 * 따로 두면 운영자가 같은 값을 여러 번 입력하고, 한쪽만 고쳐 놓고 "왜 이 메일만 안 오지" 를 겪는다.
 * 수신자를 비워 두면 공용 설정의 종류별/기본 수신자로 간다.
 *
 * 규약(되돌리지 말 것):
 *  - 원자적 쓰기 + 손상 보존(preserveCorrupt). 조용한 빈값 반환 금지.
 *  - 검증은 순수 함수(`targetIssue`·`mailIssue`)로 분리한다 — 웹 테스트가 node 환경이라
 *    화면 렌더 테스트가 불가하므로 판정을 여기에 고정한다.
 */
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, safeLoadText } from '../util/atomicWrite.js';
import { makeJsonFileReader } from '../util/jsonFileRead.js';   // 97회차 F14: 읽기 오류 ≠ 손상
import { corruptOnlyReason } from '../util/registryCore.js';   // 100회차(97 ③ 결정): 본 파일 없음 + 손상 보존본만 = 아직 못 읽은 설정
import { TOP_N_MIN, TOP_N_MAX } from './scan.js';
import { normalizeAddresses } from '../util/smtp.js';
import { numOrNull } from '../util/numOrNull.js';
import { parseJsonObject } from '../util/jsonObject.js'; // v3.17.2: 객체가 아닌 JSON(수 · 글자 · 배열)은 깨진 JSON 과 같이 — 손상 보존 경로로

const FILE = path.join(config.configDir, 'dirusage.json');

/** 대상 개수 상한 — 하나하나가 엣지에서 수 분 걸리는 du 라 무제한으로 늘리면 안 된다. */
export const MAX_TARGETS = 50;
/** 최소 주기(시간). du 는 무거운 작업이라 시간 단위 아래로 내리지 않는다. */
export const MIN_INTERVAL_HOURS = 1;
export const MAX_INTERVAL_HOURS = 24 * 30;

/** 절대경로만. 상위 참조(`..`)·제어문자·따옴표 금지 — argv 로 넘어가지만 방어적으로 막는다. */
// eslint-disable-next-line no-control-regex
const PATH_RE = /^\/[^\x00-\x1f\x7f'"`$\\]{0,1023}$/;

/** 보관 일수 상한(저장 판정과 같은 값). 97회차 F14 후속: 설정을 못 읽는 동안의 이력 정리는 이 상한으로 한다(멈춤에도 상한 — 83 R1). */
export const RETENTION_MAX_DAYS = 3650;
export const DEFAULTS = Object.freeze({
  enabled: false,
  targets: [],                      // [{ id, label, agent, instance, path, topN, intervalHours, enabled }]
  mail: {
    enabled: false,
    to: [],                         // 비우면 공용 설정(설정 › 메일 발송)의 수신자를 쓴다
    cc: [],
    subject: '[VMware Portal] {root} 폴더 사용량 Top {topN} ({date})',
    onlyOnChange: false,            // true 면 직전과 Top 목록이 같으면 보내지 않는다
  },
  retentionDays: 365,               // 스캔 이력 보존
});

let cache = null;

/**
 * v2.605(감사 WEB2605-01): 대상의 숫자 칸(topN·intervalHours)이 **비어 있으면**(빈 값·숫자 아님) '미지정' 이다 —
 * 같은 id 의 기존 대상 값을 유지하고, 새 대상이면 기본값. 예전에는 빈 칸이 `Number('')=0` → 하한 1 로 저장돼
 * 24시간 주기가 1시간(24배 du 스캔)이 됐다. 명시적 숫자만 값이다(v2.596 규약).
 */
function blankNum(v) { return numOrNull(v) == null; }

function normTarget(t, i, prev = null) {
  const id = String(t?.id || '').trim() || `t${Date.now().toString(36)}${i}`;
  const pTopN = prev && Number.isFinite(prev.topN) ? prev.topN : 20;
  const pHours = prev && Number.isFinite(prev.intervalHours) ? prev.intervalHours : 24;
  return {
    id,
    label: String(t?.label || '').slice(0, 80),
    agent: String(t?.agent || '').trim(),
    instance: String(t?.instance || '').trim(),
    path: String(t?.path || '').trim(),
    topN: blankNum(t?.topN) ? pTopN : clamp(t?.topN, TOP_N_MIN, TOP_N_MAX, pTopN),
    intervalHours: blankNum(t?.intervalHours) ? pHours : clamp(t?.intervalHours, MIN_INTERVAL_HOURS, MAX_INTERVAL_HOURS, pHours),
    enabled: t?.enabled !== false,
  };
}

function clamp(v, lo, hi, def) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, n));
}

/*
 * 97회차 F14(재현 — EISDIR): 예전 catch 하나는 **읽기 오류**(EACCES · EIO · EISDIR)도 손상으로 보고 온전한 원본을 `.corrupt.*` 로 옮긴 뒤 기본값을 캐시했다 —
 *   보관 일수가 기본값(365일)이 되어 다음 정리(prune)가 사용자가 늘려 둔 기간의 이력을 지웠고(되돌릴 수 없다), 다음 저장이 기본값 위에 썼다.
 *   판정은 공용 읽기(util/jsonFileRead.js): 읽기 오류는 원본을 두고 · 캐시하지 않고(30초 간격 재읽기) · 저장을 거절하고(409) · 정리는 저장 상한(RETENTION_MAX_DAYS)으로만 한다.
 *   손상은 예전처럼 보존본으로 옮기고 기본값으로 돌되, 표지를 세워 정리를 저장 상한으로만 한다(진짜 보관 일수는 보존본에 있다 — 추측으로 지우지 않는다).
 *   100회차: 재시작 뒤(본 파일 없음 + 손상 보존본만)에도 같은 표지 — 관리자가 다시 저장하면 풀린다.
 */
const _reader = makeJsonFileReader(() => FILE, { parse: parseJsonObject, tag: 'dirusage' });
let _loadError = null;   // { at, reason, readError? }
export function load() {
  if (cache) return cache;
  const out = structuredClone(DEFAULTS);
  const r = _reader.read();
  if (r.kind === 'read-error') {
    _loadError = { at: _loadError?.readError ? _loadError.at : Date.now(), readError: true, reason: `디렉터리 사용량 설정(dirusage.json) 파일을 읽지 못했습니다(읽기 오류 ${String(r.error?.code || '').slice(0, 32)}) — 원본은 그대로 둡니다 · 저장을 멈추고 이력 정리는 최대 보관 일수(${RETENTION_MAX_DAYS}일)로만 합니다(30초마다 다시 읽음)` };
    return out;   // 캐시하지 않는다
  }
  if (r.kind === 'corrupt') {
    _loadError = { at: Date.now(), reason: `디렉터리 사용량 설정(dirusage.json) 파일이 손상돼 보존본으로 옮겼습니다 — 기본값으로 돌고 이력 정리는 최대 보관 일수(${RETENTION_MAX_DAYS}일)로만 합니다(저장하면 풀림)` };
    console.warn(`[dirusage] 설정 로드 실패 — 원본을 .corrupt 로 보존하고 기본값으로 시작합니다(이력 정리는 저장 전까지 최대 보관 일수 ${RETENTION_MAX_DAYS}일로만): ${safeLoadText(r.error) || '사유 미상'}`);
  } else if (r.kind === 'missing' && corruptOnlyReason(FILE)) {
    // 100회차(97회차 남긴 것 ③ — 결정 · 재현): 손상으로 보존본만 남긴 뒤 재시작하면 '파일 없음' 이라 표지가 사라져 기본 보관 일수(365일)로 스캔 이력을 지웠다
    //   (늘려 둔 보관 일수는 보존본에만 있다). 본 파일이 없고 그 보존본이 남아 있으면 관리자가 다시 저장할 때까지 같은 표지를 세운다(저장은 허용 —
    //   readError 아님 · 저장하면 본 파일이 생겨 풀린다. 보존본을 치워도 풀린다 — veeam/backupMarks marksCorruptKept 와 같은 판정).
    _loadError = { at: _loadError?.corruptKept ? _loadError.at : Date.now(), corruptKept: true, reason: `디렉터리 사용량 설정(dirusage.json) 파일이 없고 손상 보존본만 남아 있습니다 — 기본값으로 돌고 이력 정리는 최대 보관 일수(${RETENTION_MAX_DAYS}일)로만 합니다(설정을 다시 저장하면 풀림)` };
  } else _loadError = null;
  if (r.kind === 'ok') {
    const p = r.value;
    if (typeof p.enabled === 'boolean') out.enabled = p.enabled;
    if (Array.isArray(p.targets)) out.targets = p.targets.slice(0, MAX_TARGETS).map((t, i) => normTarget(t, i));
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
    if (p.retentionDays != null) out.retentionDays = clamp(p.retentionDays, 1, RETENTION_MAX_DAYS, 365);
  }
  cache = out;
  return cache;
}
/** 97회차 F14 · 100회차: 설정을 못 읽었으면(읽기 오류 · 이 프로세스에서 본 손상 · 본 파일 없이 손상 보존본만) `{ at, reason, readError?, corruptKept? }`, 아니면 null — 이력 정리(prune)는 이 값이 있으면 저장 상한(RETENTION_MAX_DAYS)으로만 한다(메인 검토 — 건너뛰면 무한 증식). */
export function settingsLoadError() { load(); return _loadError; }

/** 저장 — 대상·수신자만 다룬다(SMTP 는 공용 mail.json). */
export function save(body = {}) {
  if (settingsLoadError()?.readError) throw Object.assign(new Error(`디렉터리 사용량 설정(dirusage.json) 파일을 읽지 못한 상태라 저장하지 않았습니다 — 읽기 오류이고 원본은 그대로 있습니다. 파일 권한 · 소유자 · 디스크를 확인하세요(30초마다 다시 읽습니다).`), { status: 409, code: 'settings-unreadable' });   // 97회차 F14
  const cur = load();
  const next = structuredClone(cur);
  if (typeof body.enabled === 'boolean') next.enabled = body.enabled;
  if (Array.isArray(body.targets)) {
    const prevById = new Map((cur.targets || []).map((t) => [t.id, t]));
    next.targets = body.targets.slice(0, MAX_TARGETS).map((t, i) => normTarget(t, i, prevById.get(String(t?.id || '').trim()) || null));
  }
  if (body.mail && typeof body.mail === 'object') {
    next.mail = {
      enabled: body.mail.enabled === true,
      to: normalizeAddresses(body.mail.to).ok,
      cc: normalizeAddresses(body.mail.cc).ok,
      subject: String(body.mail.subject || DEFAULTS.mail.subject).slice(0, 200),
      onlyOnChange: body.mail.onlyOnChange === true,
    };
  }
  // v2.604(감사 LEFT2604-01 — 재현): 빈 칸('')을 Number 로 읽으면 0 → 하한 1일이 되어 **스캔 이력이 하루치만 남았다**
  //   (오류 없이 '저장됨'). 빈 값·숫자 아님은 '미지정' = 현재 값 유지. 명시적 숫자만 값이다(v2.596 규약).
  // v2.605(감사 RECENT2605-06·WEB2605-01 — 재현): **0 이하도 미지정**이다. 0 은 하한 1일로 클램프돼 스캔 이력이
  //   하루치만 남았다(이 저장소의 다른 설정은 0 = 무제한이 흔해 사용자가 그 뜻으로 넣는다). relaycheck(LEFT2604-02)와 같은 규칙.
  const rd = numOrNull(body.retentionDays);
  if (rd != null && rd > 0) next.retentionDays = clamp(rd, 1, RETENTION_MAX_DAYS, cur.retentionDays);

  atomicWriteFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  cache = next; _loadError = null; _reader.reset();
  return next;
}

export function invalidate() { cache = null; _loadError = null; _reader.reset(); }

/** API 응답용. 이 파일에는 비밀 값이 없다(SMTP 는 공용 mail.json 소관). */
export function redact(cfg = load()) { return cfg; }

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
  // 빈 칸은 '미지정'(저장 시 기존 값·기본값 유지 — normTarget). 명시한 숫자만 범위를 검사한다(v2.605 WEB2605-01).
  const n = blankNum(t.topN) ? TOP_N_MIN : Number(t.topN);
  if (!Number.isFinite(n) || n < TOP_N_MIN || n > TOP_N_MAX) return `Top N 은 ${TOP_N_MIN}~${TOP_N_MAX} 사이여야 합니다.`;
  const h = blankNum(t.intervalHours) ? MIN_INTERVAL_HOURS : Number(t.intervalHours);
  if (!Number.isFinite(h) || h < MIN_INTERVAL_HOURS || h > MAX_INTERVAL_HOURS) {
    return `주기는 ${MIN_INTERVAL_HOURS}~${MAX_INTERVAL_HOURS}시간 사이여야 합니다(du 는 무거운 작업이라 시간 단위 아래로 내리지 않습니다).`;
  }
  return null;
}

/**
 * 메일 설정의 문제점(발송을 켰을 때만 엄격).
 * 수신자를 **비워 두는 것은 오류가 아니다** — 공용 설정(설정 › 메일 발송)의 수신자를 쓴다는 뜻이다.
 * SMTP 자체의 검증은 공용 설정(mail/settings.js smtpIssue)이 소유한다.
 */
export function mailIssue(mail) {
  if (!mail?.enabled) return null;
  const to = normalizeAddresses(mail.to);
  const cc = normalizeAddresses(mail.cc || []);
  if (to.bad.length || cc.bad.length) return `주소 형식 오류: ${[...to.bad, ...cc.bad].join(', ')}`;
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
  const m = mailIssue(cfg?.mail);
  if (m) out.push(`메일: ${m}`);
  return out;
}

export const _FILE = FILE;
