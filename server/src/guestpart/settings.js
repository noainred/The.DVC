/**
 * guestpart/settings.js — 게스트 파티션 사용률 경보 설정(`guest-partition.json`, v2.749).
 *
 * 담는 것: 기본 임계(%) · 판정 단위 · vCenter 별 임계 · Windows/Linux 무시 규칙 · 메일(보내는 사람 · 공통 수신자 · 전체 법인 통합 메일 ·
 *   vCenter 별 담당자 메일). **수집 켜기·주기는 여기 없다** — 게스트 디스크 회수와 같은 수집을 쓰므로 `guest-disk.json`(guestdisk/settings.js)
 *   한 곳이다(두 곳에 두면 한쪽만 바꾸고 '왜 안 도나' 를 겪는다).
 *
 * 메일 규칙은 아이실론 디렉터리 사용량과 **같은 코어**를 쓴다(사용자 요청 '아이실론을 참고해서 동일하게'):
 *   주소 목록·형식 검사 = isidu/mailRules.normalizeMailList · vCenter 별 메일 = normalizeTargetMail(받는 사람·공통 빼기·변화 없으면 생략·
 *   실패 알림·보내는 때·요일·시각·since) · 요일·시각 형식 = digestRules.TIME_RE. 사본을 만들지 않는다.
 *
 * 비밀이 없는 설정이지만 손상 시 조용히 기본값으로 넘기면 다음 저장이 관리자 설정을 지우므로, 원자적 쓰기 + preserveCorrupt 를 지킨다.
 * 저장 경로의 틀린 값은 **저장하지 않고 { error, field }**(조용히 고치지 않는다 — 사용자가 고른 값이 사라진다).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt, safeLoadText } from '../util/atomicWrite.js';
import { normalizeMailList, isEmail, MAIL_LIST_MAX, normalizeTargetMail, targetMailOf, targetMailIsDefault } from '../isidu/mailRules.js';
import { TIME_RE } from '../isidu/digestRules.js';
import { rulesOf, normalizeRules, thresholdOk, RANGES, MODES, VC_THRESHOLD_MAX } from './rules.js';

const FILE = path.join(config.configDir, 'guest-partition.json');

export const DIGEST_TOPN = Object.freeze({ min: 1, max: 50, def: 15 });
export const VC_MAIL_MAX = 500;
const FROM_NAME_MAX = 80;
const CTRL = /[\u0000-\u001f\u007f]/;   // eslint-disable-line no-control-regex

export const DIGEST_DEFAULTS = Object.freeze({
  enabled: false, days: Object.freeze([1]), time: '09:00', includeAdmin: true, to: Object.freeze([]),
  thr: null, topN: DIGEST_TOPN.def, newOnly: false, skipIfNoNew: true, critNow: false, csv: true, since: null,
});

const intDays = (v) => [...new Set((Array.isArray(v) ? v : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort((a, b) => a - b);
const sinceOf = (v) => { const n = Number(v); return v != null && v !== '' && Number.isFinite(n) && n > 0 ? n : null; };

/** 통합 메일 설정(빈 값 보정). */
export function digestOf(raw) {
  const d = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const topN = Number(d.topN);
  return {
    enabled: d.enabled === true,
    days: Array.isArray(d.days) ? intDays(d.days) : [...DIGEST_DEFAULTS.days],
    time: TIME_RE.test(String(d.time || '')) ? String(d.time) : DIGEST_DEFAULTS.time,
    includeAdmin: d.includeAdmin !== false,
    to: (Array.isArray(d.to) ? d.to : []).filter(isEmail).slice(0, MAIL_LIST_MAX),
    thr: thresholdOk(d.thr),
    topN: Number.isInteger(topN) && topN >= DIGEST_TOPN.min && topN <= DIGEST_TOPN.max ? topN : DIGEST_DEFAULTS.topN,
    newOnly: d.newOnly === true,
    skipIfNoNew: d.skipIfNoNew !== false,
    critNow: d.critNow === true,
    csv: d.csv !== false,
    since: sinceOf(d.since),
  };
}

/** 통합 메일 정규화(저장 경로). 빠진 칸은 이전 값. 켜거나 요일·시각을 바꾸면 since = now(소급 발송 방지 — 아이실론 종합 메일과 같은 규칙). */
export function normalizeDigest(input, prev, now = Date.now()) {
  const p = digestOf(prev);
  if (input == null) return { digest: p };
  if (typeof input !== 'object' || Array.isArray(input)) return { error: '통합 메일 설정 형식이 잘못됐습니다.', field: 'mail.digest' };
  const enabled = typeof input.enabled === 'boolean' ? input.enabled : p.enabled;
  const days = Array.isArray(input.days) ? intDays(input.days) : p.days;
  if (Array.isArray(input.days) && input.days.length !== days.length) return { error: '요일 값이 잘못됐습니다(0=일요일 ~ 6=토요일).', field: 'mail.digest.days' };
  if (enabled && !days.length) return { error: '통합 메일을 보낼 요일을 하나 이상 고르세요.', field: 'mail.digest.days' };
  const time = input.time == null ? p.time : String(input.time).trim();
  if (!TIME_RE.test(time)) return { error: '보내는 시각은 00:00~23:59 형식이어야 합니다.', field: 'mail.digest.time' };
  let thr = p.thr;
  if (input.thr !== undefined) {
    if (input.thr === null || input.thr === '') thr = null;
    else { thr = thresholdOk(input.thr); if (thr == null) return { error: `메일 임계는 ${RANGES.threshold.min}~${RANGES.threshold.max} 사이의 정수여야 합니다(비우면 기본 임계).`, field: 'mail.digest.thr' }; }
  }
  let topN = p.topN;
  if (input.topN != null && input.topN !== '') {
    const n = Number(input.topN);
    if (!Number.isInteger(n) || n < DIGEST_TOPN.min || n > DIGEST_TOPN.max) return { error: `본문에 실을 개수는 ${DIGEST_TOPN.min}~${DIGEST_TOPN.max} 사이의 정수여야 합니다.`, field: 'mail.digest.topN' };
    topN = n;
  }
  const to = input.to == null ? { list: p.to, invalid: [], over: 0 } : normalizeMailList(input.to);
  if (to.invalid.length) return { error: `추가 받는 사람 주소 형식이 잘못됐습니다: ${to.invalid.slice(0, 3).join(', ')}`, field: 'mail.digest.to' };
  if (to.over) return { error: `추가 받는 사람은 ${MAIL_LIST_MAX}명까지입니다(${to.over}명 초과).`, field: 'mail.digest.to' };
  const flag = (k) => (typeof input[k] === 'boolean' ? input[k] : p[k]);
  const out = {
    enabled, days, time, includeAdmin: flag('includeAdmin'), to: to.list, thr, topN,
    newOnly: flag('newOnly'), skipIfNoNew: flag('skipIfNoNew'), critNow: flag('critNow'), csv: flag('csv'), since: p.since,
  };
  const sameDef = p.enabled && p.days.join(',') === out.days.join(',') && p.time === out.time;
  if (enabled && !(sameDef && p.since)) out.since = now;
  if (!enabled) out.since = null;
  return { digest: out };
}

/** 메일 전체(빈 값 보정). */
export function mailOf(raw) {
  const m = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const vcenters = {};
  const src = m.vcenters && typeof m.vcenters === 'object' && !Array.isArray(m.vcenters) ? m.vcenters : {};
  for (const [id, v] of Object.entries(src).slice(0, VC_MAIL_MAX)) {
    if (!id || id.length > 200) continue;
    vcenters[id] = targetMailOf({ mail: v });
  }
  return {
    from: typeof m.from === 'string' && isEmail(m.from) ? m.from : '',
    fromName: typeof m.fromName === 'string' && !CTRL.test(m.fromName) ? m.fromName.slice(0, FROM_NAME_MAX) : '',
    commonTo: (Array.isArray(m.commonTo) ? m.commonTo : []).filter(isEmail).slice(0, MAIL_LIST_MAX),
    digest: digestOf(m.digest),
    vcenters,
  };
}

/** 저장된 전체 설정(빈 값 보정). */
export function settingsOf(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const vct = {};
  if (r.vcThresholds && typeof r.vcThresholds === 'object' && !Array.isArray(r.vcThresholds)) {
    for (const [id, v] of Object.entries(r.vcThresholds).slice(0, VC_THRESHOLD_MAX)) {
      const t = thresholdOk(v);
      if (id && id.length <= 200 && t != null) vct[id] = t;
    }
  }
  return {
    threshold: thresholdOk(r.threshold) ?? RANGES.threshold.def,
    mode: MODES.includes(r.mode) ? r.mode : 'part',
    vcThresholds: vct,
    rules: stripSym(rulesOf(r.rules)),
    mail: mailOf(r.mail),
  };
}
const stripSym = (o) => JSON.parse(JSON.stringify(o));   // 규칙의 내부 표지(Symbol)는 JSON 에 실리지 않는다 — 저장·응답 모양을 고정

let cache = null;
let loadError = null;

export function load() {
  if (cache) return cache;
  let raw = null;
  loadError = null;
  try {
    if (fs.existsSync(FILE)) raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    preserveCorrupt(FILE, e?.message || '');
    loadError = safeLoadText(e) || '사유 미상';
    console.warn(`[guestpart] 설정 로드 실패 — 원본을 .corrupt 로 보존하고 기본값으로 시작합니다: ${loadError}`);
  }
  cache = settingsOf(raw);
  return cache;
}
export function settingsLoadError() { load(); return loadError; }
export function invalidate() { cache = null; }

/**
 * 저장(부분 요청 — 빠진 칸은 이전 값). 문제가 있으면 { error, field } 이고 아무것도 쓰지 않는다.
 * body: { threshold?, mode?, vcThresholds?, rules?, mail?: { from?, fromName?, commonTo?, digest?, vcenters?: { id: mail|null } } }
 */
export function save(body = {}, now = Date.now()) {
  const cur = load();
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const next = JSON.parse(JSON.stringify(cur));
  if (b.threshold !== undefined) {
    const t = thresholdOk(b.threshold);
    if (t == null) return { error: `기본 임계는 ${RANGES.threshold.min}~${RANGES.threshold.max} 사이의 정수여야 합니다.`, field: 'threshold' };
    next.threshold = t;
  }
  if (b.mode !== undefined) {
    if (!MODES.includes(b.mode)) return { error: "판정 단위는 'part'(파티션 하나라도) 또는 'vm'(VM 합계)이어야 합니다.", field: 'mode' };
    next.mode = b.mode;
  }
  if (b.vcThresholds !== undefined) {
    if (!b.vcThresholds || typeof b.vcThresholds !== 'object' || Array.isArray(b.vcThresholds)) return { error: 'vCenter 별 임계 형식이 잘못됐습니다.', field: 'vcThresholds' };
    const out = {};
    const ent = Object.entries(b.vcThresholds);
    if (ent.length > VC_THRESHOLD_MAX) return { error: `vCenter 별 임계는 ${VC_THRESHOLD_MAX}개까지입니다.`, field: 'vcThresholds' };
    for (const [id, v] of ent) {
      if (!id || id.length > 200) return { error: 'vCenter id 가 잘못됐습니다.', field: 'vcThresholds' };
      const t = thresholdOk(v);
      if (t == null) return { error: `vCenter 별 임계는 ${RANGES.threshold.min}~${RANGES.threshold.max} 사이의 정수여야 합니다(${id}).`, field: 'vcThresholds' };
      out[id] = t;
    }
    next.vcThresholds = out;
  }
  if (b.rules !== undefined) {
    const r = normalizeRules(b.rules, cur.rules);
    if (r.error) return r;
    next.rules = stripSym(r.rules);
  }
  if (b.mail !== undefined) {
    const m = b.mail;
    if (!m || typeof m !== 'object' || Array.isArray(m)) return { error: '메일 설정 형식이 잘못됐습니다.', field: 'mail' };
    if (m.from !== undefined) {
      const f = String(m.from ?? '').trim();
      if (f && !isEmail(f)) return { error: '보내는 사람(From) 주소 형식이 잘못됐습니다(비우면 메일 서버 설정의 주소).', field: 'mail.from' };
      next.mail.from = f;
    }
    if (m.fromName !== undefined) {
      const n = String(m.fromName ?? '');
      if (CTRL.test(n) || n.length > FROM_NAME_MAX) return { error: `보내는 사람 이름은 제어 문자 없이 ${FROM_NAME_MAX}자까지입니다.`, field: 'mail.fromName' };
      next.mail.fromName = n.trim();
    }
    if (m.commonTo !== undefined) {
      const n = normalizeMailList(m.commonTo);
      if (n.invalid.length) return { error: `공통 받는 사람 주소 형식이 잘못됐습니다: ${n.invalid.slice(0, 3).join(', ')}`, field: 'mail.commonTo' };
      if (n.over) return { error: `공통 받는 사람은 ${MAIL_LIST_MAX}명까지입니다(${n.over}명 초과).`, field: 'mail.commonTo' };
      next.mail.commonTo = n.list;
    }
    if (m.digest !== undefined) {
      const d = normalizeDigest(m.digest, cur.mail.digest, now);
      if (d.error) return d;
      next.mail.digest = d.digest;
    }
    if (m.vcenters !== undefined) {
      if (!m.vcenters || typeof m.vcenters !== 'object' || Array.isArray(m.vcenters)) return { error: 'vCenter 별 메일 형식이 잘못됐습니다.', field: 'mail.vcenters' };
      for (const [id, v] of Object.entries(m.vcenters)) {
        if (!id || id.length > 200) return { error: 'vCenter id 가 잘못됐습니다.', field: 'mail.vcenters' };
        if (v === null) { delete next.mail.vcenters[id]; continue; }
        const r = normalizeTargetMail(v, cur.mail.vcenters[id] || null, now);
        if (r.error) return { error: `${id}: ${String(r.error).replace(/조사가/g, '수집이').replace(/조사/g, '수집')}`, field: `mail.vcenters.${r.field || ''}` };
        if (targetMailIsDefault(r.mail)) delete next.mail.vcenters[id]; else next.mail.vcenters[id] = r.mail;
      }
      if (Object.keys(next.mail.vcenters).length > VC_MAIL_MAX) return { error: `vCenter 별 메일은 ${VC_MAIL_MAX}개까지입니다.`, field: 'mail.vcenters' };
    }
  }
  atomicWriteFileSync(FILE, JSON.stringify(next, null, 2));
  cache = null; loadError = null;
  return { settings: load() };
}

/** 관리자가 아닌 계정에 줄 판본 — 메일 주소·보내는 사람을 싣지 않는다(판정 기준만). */
export function publicSettings(s = load()) {
  return { threshold: s.threshold, mode: s.mode, vcThresholds: s.vcThresholds, rules: s.rules };
}

export const _FILE = FILE;
