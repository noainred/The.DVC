/**
 * bmusage/maint/store.js — 리눅스 성능 8a단계 **정비 창 저장소**(`maintenance-windows.json` · 엣지 배포본 `maintenance-windows-deployed.json`).
 *
 * 파일 스토어 규약(perf-db.md v2.582 · 6단계 annotations.js 와 같은 꼴):
 *   · 원자 쓰기(0600) · 손상 보존(preserveCorrupt) · **손상이면 읽기 503 · 쓰기 거부**(빈 목록으로 덮어 모두의 창을 지우지 않는다) ·
 *   · 읽기-수정-쓰기는 **직렬 큐 하나**(withStore — 라우트의 비동기 검사 뒤에 들어와도 앞 쓰기를 덮지 않는다) + 창마다 rev(고치기 · 끝내기 · 재확인 · 지우기는
 *     rev 가 **없거나** 다르면 409 — rev 없는 호출이 마지막 쓰기로 이기지 않게).
 *   · 지운 창은 **묘비**(deleted.at)로 남는다 — 지금 판정에서는 빠지고 지난 구간(⑤ 분모 제외 · 음영)에는 지운 시각까지 남는다(judge.js 머리말 · 보관 90일).
 *   · 상한 2,000 — 넘으면 지운 창 · 90일 전에 끝난 창부터 비우고 그래도 넘치면 409.
 * 정규화는 **한 함수**(normalizeWindow) — API 입력(엄격) · 파일 읽기 · 엣지가 받은 배포본(느슨 — 형식 밖 항목은 버리고 센다)이 같은 함수를 지난다.
 * 판정 입력(windowsForJudge) = 이 노드의 창 + 중앙 배포본(받은 지 DEPLOY_TTL_MS 안일 때만 — 배포가 끊긴 엣지가 지워진 창으로 영원히 억제하지 않게: 억제 시한)
 *   + 배포 history(중앙의 끝남 · 지움 · 만료 창 — 지난 구간 전용 · 시한 없음 · 지금 판정에서 빠진다: 점검 반복 3회차 D2).
 * ⚠ 손상 · 못 읽음이면 그 쪽 창은 판정에 넣지 않는다(억제하지 않는 쪽 — 알림이 나간다) + 상태(unreadable)를 올려 수집 건강 · 화면이 밝힌다.
 * 권한 · 범위 · 승인 등급은 라우트(routes/api/bmMaint.js)가 본다 — 이 모듈은 형식 · 저장 · 일정 상한만.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../../util/atomicWrite.js';
import { makeSettingsLoadError } from '../../util/settingsLoadError.js';
import { SCHED_KINDS, ONCE_MAX_MIN, RECUR_MAX_MIN, parseLocal, parseTime, localToUtc, validTz, DEFAULT_TZ, MIN, DAY, tzTransitions } from './schedule.js';
import { SCOPES, TARGET_KINDS, TAG_RE, windowStatus, expiresAt, effectiveOccurrences, matchTarget } from './judge.js';

const FILE = () => path.join(config.configDir, 'maintenance-windows.json');
const DEPLOYED_FILE = () => path.join(config.configDir, 'maintenance-windows-deployed.json');
export const WINDOWS_MAX = 2_000;
export const KEYS_MAX = 20;
export const NAME_MAX = 80;
export const REASON_MAX = 300;
export const EDITS_MAX = 20;
/** 일회 창의 시작은 지금부터 400일 안 · 끝은 지금 뒤(지난 창을 새로 만들지 않는다). */
export const FUTURE_MAX_DAYS = 400;
/** 끝난 창 보관(목록 ‘지난 창 90일 이력’) — 지나면 쓰기 때 비운다. */
export const KEEP_ENDED_DAYS = 90;
/** 엣지 배포본 신선도 — 받은 지 이보다 오래면 판정에 넣지 않는다(중앙이 지운 창이 끊긴 엣지에서 계속 억제하지 않게). 일회 창 상한(24h)과 같다. */
export const DEPLOY_TTL_MS = 24 * 3_600_000;
/** 소유자 등급이 필요한 길이(분) — 이보다 길면(일회 12~24h) 설정 소유자 등급. 반복은 상한이 12h 라 창 하나로는 해당 없음 —
 *  같은 서버를 덮는 **살아 있는 창 전부(소유자 창 포함)**의 합이 어느 24시간에서든 이 값을 넘어도 소유자 등급(coverNeedsOwner — 반증 F5 · 재확인 G1 · G2). */
export const OWNER_OVER_MIN = 12 * 60;
/** 엣지 배포본 시각이 이만큼 넘게 미래면(엣지 시계가 앞서 있다가 바로잡힘) 지금으로 자른다 — 시한이 시계에 기대 무력해지지 않게(반증 F7). */
export const DEPLOY_FUTURE_SKEW_MS = 5 * 60_000;
const ID_RE = /^mw-[a-z0-9]{6,32}$/;
const VC_RE = /^[A-Za-z0-9._:@-]{1,128}$/;
const KEY_RE = /^[^\u0000-\u001f\u007f]{1,256}$/;
const CTRL = new RegExp('[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2069\\ufeff]', 'g');

const _err = makeSettingsLoadError(FILE, { label: '베어메탈 성능 정비 창', confirm: () => writeAll({ v: 1, seq: 0, items: [] }) });
function fail(status, code, reason, field = null) { const e = new Error(reason); e.status = status; e.code = code; if (field) e.field = field; return e; }
export function cleanText(v, max) { return typeof v === 'string' ? v.replace(CTRL, '').replace(/\s+/g, ' ').trim().slice(0, max) : ''; }

/** 일정 길이(분 — 실제 경과 · 일회는 시간대로 계산). 형식 밖이면 null. */
export function durationMinOf(schedule, tz) {
  if (!schedule) return null;
  if (schedule.kind === 'once') {
    const a = parseLocal(schedule.start); const b = parseLocal(schedule.end);
    if (!a || !b || !validTz(tz)) return null;
    return Math.round((localToUtc(tz, b.y, b.mo, b.d, b.h, b.mi) - localToUtc(tz, a.y, a.mo, a.d, a.h, a.mi)) / MIN);
  }
  const d = Number(schedule.durMin);
  return Number.isInteger(d) ? d : null;
}
/** 소유자 등급이 필요한 창인가(순수 — 라우트 · 화면 문구가 같은 판정): 법인 전체 · 태그 · 12시간 초과. */
export function needsOwnerTier(w) {
  if (!w?.target || w.target.kind !== 'server') return true;
  const d = durationMinOf(w.schedule, w.tz);
  return d == null || d > OWNER_OVER_MIN;
}

/**
 * 합친 덮임 규칙(순수 — 반증 F5 · 재확인 G1 · G2): 후보 서버 창이 덮는 (법인, 키)마다 그 서버를 덮는 **살아 있는 창 전부**(소유자가 저장한 창 · 법인 창 · 태그 창 포함 ·
 *   지운 창 제외 · 만료 · 끝내기는 발생 계산이 자른다)와 후보를 합쳐, 후보의 발생에 걸치는 어느 24시간 구간에서든 덮임이 OWNER_OVER_MIN(12시간)을 넘으면 true(소유자 등급 필요).
 *   ‘12시간 넘게 덮는 억제는 소유자 등급’ 이라는 원래 뜻 — 소유자 창 옆에 운영자가 12시간을 붙여 24시간 상시가 되는 길(G1)을 막는다. approvedBy 는 **기록일 뿐 합 판정에 쓰지 않는다**
 *   (소유자가 운영자 창의 이름만 고쳐 approvedBy 가 붙어도 합에서 빠지지 않는다 — G2). 소유자 자신의 저장은 라우트가 이 검사 없이 허용한다.
 *   기준점: 반복 창은 앞으로 36일(매월은 400일) · 일회 창은 그 발생 — 발생마다 앞뒤 2일 안에서 24시간 창을 본다.
 *   + **매주 후보 수명(만료 · 400일 중 이른 것) 안의 시간대 전환 둘레**(전환 앞 2일 ~ 뒤 9일의 후보 발생 — 점검 반복 6회차 Y A3: 매주 창끼리의 겹침은 전환과 전환 사이에서만
 *   7일 주기라 36일 뒤의 전환(바르샤바 3월 · 뉴욕 3월 · 시드니 4월)이 바꾸는 겹침을 보지 못했다. 앞 2일 ~ 뒤 9일 = 섞인 구간 + 새 주기 첫 한 주. dstAnchors — 두 경로가 같은 함수).
 *   24시간 창 시작 후보 = 합친 구간의 시작 · (끝 − 24시간) + **후보 발생마다 (시작 − 24시간 + 1ms) · (끝 − 1ms)**(⚠ 점검 반복 3회차 재확인 R2: 합친 구간이 후보 발생 앞뒤로
 *   하루 넘게 이어지면 구간 끝점에서 시작하는 24시간 창이 후보와 겹치지 않아 하나도 세지 않았다 — 소유자 창으로 상시 덮인 서버에 운영자가 ‘수요일 00:00 12h’ · ‘수요일 12:00 12h’ 를 만들 수 있었다.
 *   덮임은 시작 위치에 대해 조각 선형이라 후보 발생과 겹치는 범위 안 최대는 꺾이는 점 또는 그 범위의 양끝에서 나온다).
 * @param {object} cand  정규화한 후보(고치기 뒤 · 재확인이면 confirmedAt 을 지금으로)
 * @param {Array} all   이 노드의 창 전부 + 신선한 배포본(후보의 앞 판 · 같은 id 는 뺀다)
 * @param {{tagsOf?:Function, exact?:boolean, memo?:object}} o  태그 창 판정(중앙 수동 용도 태그) — 없으면 태그 창은 펼친 keys 로만 ·
 *   exact = 빠른 길 · 메모 · 같은 동료 묶음 건너뛰기 없이 기준점마다 다시 센다(시험 대조용 — 답은 같다) ·
 *   memo = coverMemo(now) — 한 요청 안에서 같은 창 목록(all) · 같은 now 로 여러 후보를 볼 때(목록 canConfirm) 창별 발생 조각 · (법인, 키)별 동료 · 기준점을 다시 세지 않는다(3회차 재확인 R1).
 */
export function coverNeedsOwner(cand, all = [], now = Date.now(), o = {}) {
  const it = coverSteps(cand, all, now, o);
  let r = it.next();
  while (!r.done) r = it.next();
  return r.value;
}
/** coverNeedsOwner 와 같은 계산(같은 단계 함수) — 단계 사이에 yieldFn(시간 기준 양보)을 기다린다. 라우트(목록 · 쓰기)가 쓴다(3회차 재확인 R1 ④ — 큰 계산이 루프를 길게 막지 않게). */
export async function coverNeedsOwnerAsync(cand, all = [], now = Date.now(), { yieldFn = null, ...o } = {}) {
  const it = coverSteps(cand, all, now, o);
  let r = it.next();
  while (!r.done) { if (yieldFn) await yieldFn(); r = it.next(); }
  return r.value;
}
/** 판정 단계(생성기 — 동기 · 비동기 두 꼴이 같은 코어). yield = 양보해도 되는 자리(발생 조각을 새로 센 뒤 · 기준점 하나 뒤). */
function* coverSteps(cand, all, now, { tagsOf = null, exact = false, memo = null } = {}) {
  if (!cand || cand.target?.kind !== 'server' || cand.deleted) return false;
  const keys = cand.target.keys || [];
  const list = Array.isArray(all) ? all : [];
  const limit = OWNER_OVER_MIN * MIN;
  const horizon = (w) => (w.schedule?.kind === 'weekly' ? 36 * DAY : FUTURE_MAX_DAYS * DAY);
  if (exact) {
    // 정확 경로(시험 대조용 — 예전 계산 그대로 + R2 후보): 메모 · 빠른 길 · 같은 묶음 건너뛰기 없이 기준점마다 effectiveOccurrences 를 다시 센다.
    const live = list.filter((w) => w && w.id !== cand.id && !w.deleted && w.schedule);
    const anchorsOf = (w) => effectiveOccurrences(w, now - DAY, now + horizon(w));
    for (const key of keys) {
      const ps = live.filter((w) => matchTarget(w, { key, vcenterId: cand.vcenterId }, { tagsOf }));
      if (!ps.length) continue;
      const group = [cand, ...ps];
      const occ = (w, lo, hi) => effectiveOccurrences(w, lo, hi);
      for (const a of [...anchorsOf(cand), ...dstAnchors(cand, group, now, occ), ...ps.filter((w) => w.schedule?.kind !== 'weekly').flatMap(anchorsOf)]) {
        if (windowOver(a, cand, group, occ, limit)) return true;
      }
    }
    return false;
  }
  // 메모 — 같은 now · 같은 목록 · 같은 태그 판정일 때만 동료 묶음을 다시 쓴다(아니면 이 호출만의 메모)
  const M = memo && memo.now === now ? memo : coverMemo(now);
  if (M.all === undefined) { M.all = list; M.tagsOf = tagsOf; }
  const shareMembers = M.all === list && M.tagsOf === tagsOf;
  const membersOf = (key) => {
    const mk = `${String(cand.vcenterId ?? '').trim()}|${key}`;
    let ms = shareMembers ? M.members.get(mk) : null;
    if (!ms) {
      ms = list.filter((w) => w && !w.deleted && w.schedule && matchTarget(w, { key, vcenterId: cand.vcenterId }, { tagsOf }));
      if (shareMembers) M.members.set(mk, ms);
    }
    return ms;
  };
  const anchorsOf = (w) => {
    let a = M.anchors.get(w);
    if (!a) { a = effectiveOccurrences(w, now - DAY, now + horizon(w)); M.anchors.set(w, a); }
    return a;
  };
  // 발생 — 창마다 지금 기준 8일 조각으로 한 번 세고(OCC_MAX 에 잘리지 않게) 구간마다 겹치는 것만 고른다.
  //   같은 답: 발생 값은 세는 구간과 무관하고 effectiveOccurrences(w, lo, hi) = 조각 결과 중 [lo, hi) 와 겹치는 것.
  const chunksOf = (w) => { let c = M.occ.get(w); if (!c) { c = new Map(); M.occ.set(w, c); } return c; };
  const jRange = (lo, hi) => [Math.floor((lo - now) / CHUNK_MS), Math.floor((hi - 1 - now) / CHUNK_MS)];
  /** [lo, hi) 의 조각을 미리 센다 — 새로 센 것이 있으면 true(양보 자리). */
  const warm = (w, lo, hi) => {
    const byChunk = chunksOf(w); const [j0, j1] = jRange(lo, hi); let fresh = false;
    for (let j = j0; j <= j1; j += 1) if (!byChunk.has(j)) { byChunk.set(j, effectiveOccurrences(w, now + j * CHUNK_MS, now + (j + 1) * CHUNK_MS)); fresh = true; }
    return fresh;
  };
  const occOf = (w, lo, hi) => {
    warm(w, lo, hi);
    const byChunk = chunksOf(w); const [j0, j1] = jRange(lo, hi);
    const out = []; let last = -Infinity;
    for (let j = j0; j <= j1; j += 1) for (const o of byChunk.get(j)) if (o.start > last) { last = o.start; if (o.end > lo && o.start < hi) out.push(o); }
    return out;
  };
  const seen = new Set();
  let candAnchors = null;
  for (const key of keys) {
    const ps = membersOf(key).filter((w) => w.id !== cand.id);
    if (!ps.length) continue;
    // 같은 동료 묶음은 같은 답(법인 · 태그 창만 동료인 키들 — 3회차 재확인 R1 ②) — 앞에서 false 였으면 다시 세지 않는다
    const sig = ps.map((w) => w.id).join(',');
    if (seen.has(sig)) continue;
    seen.add(sig);
    const group = [cand, ...ps];
    // 빠른 길(3회차 — 답은 정확한 계산과 같다): 창 하나가 어느 24시간에서든 덮는 최대는 일회 = 그 길이 · 반복 = 길이 × 2(이웃 발생의 시작 간격은 시간대 변경이 있어도
    //   18시간을 넘으므로 한 24시간에 걸치는 발생은 둘까지). 그 합이 상한 이하면 어떤 24시간도 넘을 수 없다(위로 잡은 값).
    const bound = group.reduce((a, w) => { const d = durationMinOf(w.schedule, w.tz); return a + (d == null ? Infinity : (w.schedule?.kind === 'once' ? d : 2 * d)); }, 0);
    if (bound * MIN <= limit) continue;
    candAnchors ||= effectiveOccurrences(cand, now - DAY, now + horizon(cand));
    // A3(6회차 Y): 시간대 전환 둘레의 후보 발생 — 앞의 36일 기준점에 이미 있는 발생(같은 시작)은 다시 세지 않는다(답은 같고 비용만 는다)
    const have = new Set(candAnchors.map((o) => o.start));
    const extra = dstAnchors(cand, group, now, occOf).filter((o) => !have.has(o.start) && have.add(o.start));
    for (const a of [...candAnchors, ...extra, ...ps.filter((w) => w.schedule?.kind !== 'weekly').flatMap(anchorsOf)]) {
      const lo = a.start - 2 * DAY; const hi = a.end + 2 * DAY;
      if (!occOf(cand, lo, hi).length) continue;   // 그 둘레에 후보 발생이 없으면 동료를 세지 않는다(windowOver 와 같은 판단)
      for (const w of ps) if (warm(w, lo, hi)) yield;   // 동료 발생 조각을 새로 셌으면 양보 자리(R1 ④)
      if (windowOver(a, cand, group, occOf, limit)) return true;
      yield;
    }
  }
  return false;
}
/** 발생 세기 조각(coverNeedsOwner 메모) — 8일(매일 창도 조각 하나에 9개 안팎 · OCC_MAX 와 멀다). */
const CHUNK_MS = 8 * DAY;
/** 한 요청 안의 계산 메모(목록 canConfirm — 3회차 재확인 R1). 창 객체가 그 요청 동안 바뀌지 않는다는 전제(목록 한 번 · 같은 now). */
export function coverMemo(now) { return { now, all: undefined, tagsOf: undefined, members: new Map(), anchors: new WeakMap(), occ: new WeakMap() }; }
/** 전환 둘레 — 앞 2일 ~ 뒤 9일. 발생 o 의 덮임은 [o.start − 1일 − 12시간, o.end + 1일] 의 발생만 본다(창 24시간 · 동료 길이 ≤ 12시간) — 그래서 전환 T 가 섞이는 발생은
 *  시작이 (T − 1.5일, T + 1.5일] 이고, 새 주기의 첫 순수 한 주는 시작 [T + 1.5일, T + 8.5일) 이다. 둘을 덮고 여유를 둔다. */
const DST_BEFORE_MS = 2 * DAY;
const DST_AFTER_MS = 9 * DAY;
/**
 * 점검 반복 6회차 Y(A3): 매주 후보의 **시간대 전환 둘레 기준점**(빠른 길 · 정확 경로 · 메모가 같은 함수 — occOf 만 그 경로의 발생 세기).
 *   매주 창끼리의 덮임은 동료(매주) 시간대 · 후보 시간대의 오프셋이 그대로인 동안 7일 주기다 — 주기가 바뀌는 곳은 그 시간대들의 전환뿐이다(만료 · 끝내기 · 지움은 덮임을 줄이기만 한다 ·
 *   매월 · 일회 동료는 자기 발생이 기준점이다). 그래서 후보 수명(만료 · 400일 중 이른 것 — 끝 뒤 2일 안의 전환도: 수명 끝 직전 발생이 전환 뒤 동료와 섞인다) 안의 전환마다
 *   앞 2일 ~ 뒤 9일의 후보 발생을 기준점에 더하면 수명 전체를 본 것과 같다(시험: 수명 전체 발생을 30분 격자로 다 세는 독립 계산과 무작위 대조 — bmUsageLoop6y).
 *   매월 · 일회 후보는 이미 발생 전부가 기준점이라 해당 없음. 시간대가 하나뿐이고 전환이 없는 묶음(서울만)은 빈 목록 — 비용 0.
 */
function dstAnchors(cand, group, now, occOf) {
  if (cand.schedule?.kind !== 'weekly') return [];
  const exp = expiresAt(cand);
  const end = Math.min(exp ?? Infinity, now + FUTURE_MAX_DAYS * DAY);
  if (!(end > now)) return [];
  const tzs = new Set(group.filter((w) => w.schedule?.kind === 'weekly').map((w) => w.tz));
  const out = [];
  // 6회차 Y 재확인 Y1: 앞 끝은 기본 기준점과 같은 아래 끝(now − 1일)보다 이르지 않게 — 전환이 2일 안이면 T − 2일이 지난 발생까지 끌어와,
  //   앞으로는 12시간을 넘지 않는 창이 지난 발생 때문에 운영자에게 403 이었다(재현: 바르샤바 전환 2시간 전 · 지난 목요일만 12.5h).
  for (const tz of tzs) for (const T of tzTransitions(tz, now, end + DST_BEFORE_MS)) out.push(...occOf(cand, Math.max(T - DST_BEFORE_MS, now - DAY), T + DST_AFTER_MS));
  return out;
}
/** 기준점 하나 둘레(앞뒤 2일)에서 후보 발생과 겹치는 24시간 창 중 덮임이 상한을 넘는 것이 있는가(순수 — 빠른 길 · 정확 경로가 같은 함수). */
function windowOver(a, cand, group, occOf, limit) {
  const lo = a.start - 2 * DAY; const hi = a.end + 2 * DAY;
  const mine = occOf(cand, lo, hi);
  if (!mine.length) return false;
  const iv = group.flatMap((w) => occOf(w, lo, hi)).map((o) => ({ from: Math.max(lo, o.start), to: Math.min(hi, o.end) })).sort((x, y) => x.from - y.from);
  const m = [];
  for (const x of iv) { const l = m[m.length - 1]; if (l && x.from <= l.to) l.to = Math.max(l.to, x.to); else m.push({ ...x }); }
  // 24시간 창의 덮임 최대(후보 발생과 겹치는 창만)는 창 시작이 구간 시작 · 창 끝이 구간 끝인 꺾이는 점, 또는 후보 발생과 겹치는 범위의 양끝(R2)에서 나온다.
  const starts = [...m.flatMap((x) => [x.from, x.to - DAY]), ...mine.flatMap((o) => [o.start - DAY + 1, o.end - 1])];
  for (const s0 of starts) {
    const s1 = s0 + DAY;
    if (!mine.some((o) => o.start < s1 && o.end > s0)) continue;
    const cov = m.reduce((acc, x) => acc + Math.max(0, Math.min(s1, x.to) - Math.max(s0, x.from)), 0);
    if (cov > limit) return true;
  }
  return false;
}
/**
 * 정규화 하나(엄격 = API 입력 — 형식 밖 400 · 느슨 = 파일 · 배포본 — 형식 밖이면 null).
 * @param {object} raw
 * @param {{strict?:boolean, now?:number, fresh?:boolean}} o  fresh = 새로 만들기(일회 창은 끝이 지금 뒤 · 시작은 400일 안)
 */
export function normalizeWindow(raw, { strict = false, now = Date.now(), fresh = false } = {}) {
  const bad = (field, msg) => { if (strict) throw fail(400, 'bad-window', msg, field); return null; };
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  if (!r) return bad('body', '정비 창 형식이 다릅니다.');
  const name = cleanText(r.name, NAME_MAX);
  if (!name) return bad('name', `이름이 필요합니다(${NAME_MAX}자 이내).`);
  const reason = cleanText(r.reason, REASON_MAX);
  if (!reason) return bad('reason', `사유가 필요합니다(${REASON_MAX}자 이내 — 감사에 남습니다).`);
  const tz = r.tz == null || r.tz === '' ? DEFAULT_TZ : r.tz;
  if (!validTz(tz)) return bad('tz', '알 수 없는 시간대입니다(예: Asia/Seoul · Europe/Warsaw · America/New_York).');
  const vc = String(r.vcenterId ?? '').trim();
  if (!VC_RE.test(vc)) return bad('vcenterId', '법인(vCenter id)이 필요합니다.');
  // 대상 — 서버 · 태그 · 법인 중 하나(섞지 않는다)
  const tg = r.target && typeof r.target === 'object' && !Array.isArray(r.target) ? r.target : null;
  if (!tg || !TARGET_KINDS.includes(tg.kind)) return bad('target.kind', `대상은 ${TARGET_KINDS.join(' · ')} 중 하나입니다.`);
  const target = { kind: tg.kind };
  if (tg.kind === 'server' || tg.kind === 'tag') {
    const keys = Array.isArray(tg.keys) ? [...new Set(tg.keys.map((k) => String(k ?? '').trim()))] : [];
    if (keys.some((k) => !KEY_RE.test(k))) return bad('target.keys', '서버 키 형식이 다릅니다.');
    if (tg.kind === 'server' && (!keys.length || keys.length > KEYS_MAX)) return bad('target.keys', `대상 서버는 1~${KEYS_MAX}대입니다.`);
    target.keys = keys.slice(0, tg.kind === 'tag' ? 5_000 : KEYS_MAX);
    if (tg.kind === 'server') target.names = (Array.isArray(tg.names) ? tg.names : []).map((x) => cleanText(String(x ?? ''), 120)).slice(0, KEYS_MAX);
  }
  if (tg.kind === 'tag') {
    const tag = String(tg.tag ?? '').trim();
    if (!TAG_RE.test(tag)) return bad('target.tag', '태그는 role:<역할> 또는 app:<용도> 꼴입니다.');
    target.tag = tag;
  }
  // 일정
  const s = r.schedule && typeof r.schedule === 'object' && !Array.isArray(r.schedule) ? r.schedule : null;
  if (!s || !SCHED_KINDS.includes(s.kind)) return bad('schedule.kind', '일정은 일회 · 매주 · 매월 중 하나입니다.');
  let schedule;
  if (s.kind === 'once') {
    const a = parseLocal(s.start); const b = parseLocal(s.end);
    if (!a || !b) return bad('schedule', '시작 · 끝은 YYYY-MM-DDTHH:mm 입니다.');
    schedule = { kind: 'once', start: String(s.start), end: String(s.end) };
    const sMs = localToUtc(tz, a.y, a.mo, a.d, a.h, a.mi); const eMs = localToUtc(tz, b.y, b.mo, b.d, b.h, b.mi);
    if (!(eMs > sMs)) return bad('schedule.end', '끝이 시작보다 뒤여야 합니다.');
    if ((eMs - sMs) / MIN > ONCE_MAX_MIN) return bad('schedule.end', `일회 창은 ${ONCE_MAX_MIN / 60}시간까지입니다.`);
    if (fresh && eMs <= now) return bad('schedule.end', '이미 끝난 시각입니다 — 지난 창은 만들지 않습니다.');
    if (fresh && sMs > now + FUTURE_MAX_DAYS * DAY) return bad('schedule.start', `시작은 ${FUTURE_MAX_DAYS}일 안이어야 합니다.`);
  } else {
    const tm = parseTime(s.time);
    if (tm == null) return bad('schedule.time', '시작 시각은 HH:mm 입니다.');
    const dur = typeof s.durMin === 'number' ? s.durMin : (typeof s.durMin === 'string' && /^\d{1,4}$/.test(s.durMin) ? Number(s.durMin) : NaN);
    if (!Number.isInteger(dur) || dur < 1 || dur > RECUR_MAX_MIN) return bad('schedule.durMin', `반복 창 길이는 1~${RECUR_MAX_MIN}분(${RECUR_MAX_MIN / 60}시간)입니다.`);
    if (s.kind === 'weekly') {
      const days = Array.isArray(s.days) ? [...new Set(s.days)] : [];
      if (!days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return bad('schedule.days', '요일은 0(일)~6(토) 정수 배열입니다.');
      schedule = { kind: 'weekly', days: days.sort((x, y) => x - y), time: String(s.time), durMin: dur };
    } else {
      const nth = Number(s.nth); const wd = Number(s.weekday);
      if (!Number.isInteger(nth) || nth < 1 || nth > 5) return bad('schedule.nth', 'n째는 1~4 또는 5(마지막)입니다.');
      if (!Number.isInteger(wd) || wd < 0 || wd > 6) return bad('schedule.weekday', '요일은 0(일)~6(토)입니다.');
      schedule = { kind: 'monthly', nth, weekday: wd, time: String(s.time), durMin: dur };
    }
  }
  // 억제 범위 — 켠 것만(하나 이상)
  const sc = r.scopes && typeof r.scopes === 'object' && !Array.isArray(r.scopes) ? r.scopes : null;
  if (!sc) return bad('scopes', '억제 범위가 필요합니다.');
  for (const k of Object.keys(sc)) if (!SCOPES.includes(k)) return bad(`scopes.${k}`, `억제 범위는 ${SCOPES.join(' · ')} 입니다.`);
  const scopes = Object.fromEntries(SCOPES.filter((k) => sc[k] === true).map((k) => [k, true]));
  if (!Object.keys(scopes).length) return bad('scopes', '억제 범위를 하나 이상 켜세요.');
  const num = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null));
  const out = {
    id: ID_RE.test(String(r.id || '')) ? String(r.id) : null,
    name, reason, target, vcenterId: vc, tz, schedule, scopes,
    by: cleanText(String(r.by ?? ''), 64), at: num(r.at), rev: Number.isInteger(r.rev) && r.rev > 0 ? r.rev : 1,
    approvedBy: cleanText(String(r.approvedBy ?? ''), 64), confirmedAt: num(r.confirmedAt),
    ...(num(r.endedAt) != null ? { endedAt: num(r.endedAt), endedBy: cleanText(String(r.endedBy ?? ''), 64), ...(num(r.endedOccStart) != null ? { endedOccStart: num(r.endedOccStart) } : {}) } : {}),
    ...(r.deleted && typeof r.deleted === 'object' ? { deleted: { at: num(r.deleted.at), by: cleanText(String(r.deleted.by ?? ''), 64) } } : {}),
    edits: (Array.isArray(r.edits) ? r.edits : []).filter((e) => e && typeof e === 'object').slice(-EDITS_MAX)
      .map((e) => ({ at: num(e.at), by: cleanText(String(e.by ?? ''), 64), fields: (Array.isArray(e.fields) ? e.fields : []).map((f) => cleanText(String(f), 24)).slice(0, 12) })),
  };
  if (!strict && !out.id) return null;
  return out;
}

/* ── 파일(이 노드의 창) ─────────────────────────────────────────────── */
let _cache = null;   // { m, s, data }
function writeAll(obj) {
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  try { atomicWriteFileSync(FILE(), JSON.stringify(obj), { mode: 0o600 }); } catch (e) { _cache = null; throw e; }
  _err.ok();
  try { const st = fs.statSync(FILE()); _cache = { m: st.mtimeMs, s: st.size, data: obj }; } catch { _cache = null; }
}
function loadAll() {
  let st = null;
  try { st = fs.statSync(FILE()); } catch { st = null; }
  if (st && _cache && _cache.m === st.mtimeMs && _cache.s === st.size) return _cache.data;
  _cache = null;
  let raw;
  try { raw = fs.readFileSync(FILE(), 'utf8'); }
  catch (e) {
    if (e?.code !== 'ENOENT') throw fail(503, 'settingsUnreadable', '정비 창 파일을 읽지 못했습니다.');
    _err.missing();
    if (_err.get()) throw fail(503, 'settingsUnreadable', _err.get().reason);
    return { v: 1, seq: 0, items: [] };
  }
  try {
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object' || Array.isArray(o) || !Array.isArray(o.items)) throw new Error('형식이 다릅니다');
    let dropped = 0;
    const items = [];
    for (const x of o.items) { const w = normalizeWindow(x); if (w) items.push({ ...w, origin: 'local' }); else dropped += 1; }
    if (dropped) console.warn(`[bmusage] maintenance-windows.json 의 형식 밖 창 ${dropped}개를 읽지 않았습니다(억제하지 않습니다)`);
    _err.ok();
    const data = { v: 1, seq: Number(o.seq) || 0, items, ...(dropped ? { dropped } : {}) };
    if (st) _cache = { m: st.mtimeMs, s: st.size, data };
    return data;
  } catch (e) {
    preserveCorrupt(FILE(), String(e?.message || e));
    _err.corrupt(e);
    console.warn('[bmusage] maintenance-windows.json 을 읽지 못했습니다 — 손상본을 보존했고, 확정 전까지 정비 창 쓰기를 멈추고 이 노드의 창으로는 억제하지 않습니다');
    throw fail(503, 'settingsUnreadable', _err.get()?.reason || '정비 창 파일을 읽지 못했습니다.');
  }
}
const copy = (x) => JSON.parse(JSON.stringify(x));
/** 직렬 큐 — 읽기-수정-쓰기 한 단위(라우트의 비동기 검사 뒤에 와도 앞 쓰기를 덮지 않는다). */
let _chain = Promise.resolve();
function withStore(fn) {
  const run = _chain.then(() => {
    const all = loadAll();
    try { return fn(all); } catch (e) { _cache = null; throw e; }
  });
  _chain = run.catch(() => {});
  return run;
}
/**
 * 끝난 지 오래된 창 · 지운 창(묘비) 비우기(쓰기 때). 가벼운 판정만(반증 F6 — 쓰기마다 전 창의 발생을 세지 않는다):
 *   묘비 = 지운 시각 · 일회 = 유효 끝(지금 끝내기 · 상한 반영 — 창 판 id:rev 로 기억) · 반복 = 만료 시각(재확인 92일)만 본다.
 */
const _endMemo = new Map();   // `${id}:${rev}:${endedAt}` → 일회 창 유효 끝(ms · 없으면 0)
function onceEndOf(w) {
  const k = `${w.id}:${w.rev}:${w.endedAt ?? ''}`;
  if (_endMemo.has(k)) return _endMemo.get(k);
  const o = effectiveOccurrences(w, 0, 8_640_000_000_000_000);
  const end = o.length ? o[o.length - 1].end : 0;
  if (_endMemo.size > 5_000) _endMemo.clear();
  _endMemo.set(k, end);
  return end;
}
/**
 * 지난 구간 계산에 남는 창인가(가벼운 판정 하나 — 쓰기 때 정리 · 엣지 history 배포 · 엣지 history 보관이 같은 함수): 지운 지 · 끝난 지 · 만료된 지 KEEP_ENDED_DAYS 안.
 *   ‘중앙이 지난 구간 계산에 쓰는 것과 같은 집합’(점검 반복 3회차 D2 — 엣지에도 같은 날짜까지 남긴다).
 */
export function keptPast(w, now = Date.now()) {
  const keep = now - KEEP_ENDED_DAYS * DAY;
  if (!w) return false;
  if (w.deleted) return Number(w.deleted.at) > keep;
  if (w.schedule?.kind === 'once') return onceEndOf(w) > keep || Number(w.at) > keep;
  const exp = expiresAt(w);
  return exp == null || exp > keep;
}
function pruneOld(all, now) {
  all.items = all.items.filter((w) => keptPast(w, now));
}

/** rev 검사 — 없으면 409(마지막 쓰기 승리 금지 · 웹은 항상 보낸다) · 다르면 409. */
function revCheck(cur, rev) {
  if (rev == null || rev === '') throw fail(409, 'rev-required', '고칠 때는 지금 판(rev)을 함께 보내야 합니다 — 다시 불러온 뒤 고치세요.');
  if (Number(rev) !== cur.rev) throw fail(409, 'rev-changed', '그 사이 다른 사람이 이 창을 바꿨습니다 — 다시 불러온 뒤 고치세요.');
}
export function listWindows() { return loadAll().items; }
export function getWindow(id) { const x = loadAll().items.find((w) => w.id === String(id)); return x ? copy(x) : null; }
export function maintLoadError() { try { loadAll(); } catch { /* get 이 말한다 */ } return _err.get(); }

/** 만들기 — 라우트가 대상 · 범위 · 승인 등급을 확인한 입력. */
export function addWindow(input, { by = '', approvedBy = '', now = Date.now() } = {}) {
  const w0 = normalizeWindow({ ...input, id: undefined, rev: 1, by, at: now, approvedBy, confirmedAt: now, edits: [] }, { strict: true, now, fresh: true });
  return withStore((all) => {
    pruneOld(all, now);
    if (all.items.length >= WINDOWS_MAX) throw fail(409, 'cap', `정비 창이 상한(${WINDOWS_MAX})에 찼습니다 — 지난 창을 지우세요.`);
    all.seq += 1;
    const rec = { ...w0, id: `mw-${all.seq.toString(36)}${crypto.randomBytes(4).toString('hex')}`, origin: 'local' };
    all.items.push(rec);
    writeAll(all);
    return copy(rec);
  });
}
/**
 * 고치기 — rev 가 다르면 409(그 사이 누가 바꿨다). 대상 법인은 바꾸지 않는다(범위가 바뀌는 쓰기를 만들지 않는다 — 지우고 새로).
 * ⚠ 정정(점검 반복 3회차 D1): 고치기는 **재확인이 아니다** — confirmedAt 을 바꾸지 않는다(만료된 반복 창은 고쳐도 만료 그대로). 예전에는 고치기마다
 *   confirmedAt 을 지금으로 잡아 이름 · 사유만 고쳐도 92일 시한이 다시 잡혔고, 그 경로는 합 규칙(12시간 소유자 규칙)을 거치지 않아 운영자 혼자 만료된 12h 창 둘을
 *   되살려 24시간 상시 억제를 만들 수 있었다(재현 336/336 칸). 재확인(시한 연장)은 confirmWindow 하나 — 라우트가 소유자 등급 · 합 규칙을 본다.
 */
export function editWindow(id, input, { by = '', approvedBy = null, rev = null, now = Date.now() } = {}) {
  return withStore((all) => {
    const i = all.items.findIndex((w) => w.id === String(id));
    const cur = i >= 0 ? all.items[i] : null;
    if (!cur || cur.deleted) throw fail(404, 'not-found', '그 정비 창을 찾지 못했습니다.');
    revCheck(cur, rev);
    if (String(input?.vcenterId ?? cur.vcenterId) !== cur.vcenterId) throw fail(400, 'bad-window', '법인은 바꿀 수 없습니다 — 지우고 새로 만드세요.', 'vcenterId');
    const next = normalizeWindow({ ...cur, ...input, id: cur.id, by: cur.by, at: cur.at, rev: cur.rev + 1, approvedBy: approvedBy ?? cur.approvedBy, confirmedAt: cur.confirmedAt, edits: cur.edits }, { strict: true, now, fresh: input?.schedule != null });
    const fields = ['name', 'reason', 'target', 'tz', 'schedule', 'scopes'].filter((k) => JSON.stringify(next[k]) !== JSON.stringify(cur[k]));
    if (!fields.length) return copy(cur);
    next.edits = [...(cur.edits || []), { at: now, by: String(by).slice(0, 64), fields }].slice(-EDITS_MAX);
    delete next.endedAt; delete next.endedBy; delete next.endedOccStart;   // 일정이 바뀌면 앞의 ‘지금 끝내기’ 는 그 일정의 것이 아니다
    if (!fields.includes('schedule') && cur.endedAt != null) Object.assign(next, { endedAt: cur.endedAt, endedBy: cur.endedBy, ...(cur.endedOccStart != null ? { endedOccStart: cur.endedOccStart } : {}) });
    all.items[i] = { ...next, origin: 'local' };
    writeAll(all);
    return copy(all.items[i]);
  });
}
/** ‘지금 끝내기’ — 진행 중인 발생만 끊는다(반복 창의 다음 발생은 그대로). 진행 중이 아니면 409. */
export function endWindowNow(id, { by = '', rev = null, now = Date.now() } = {}) {
  return withStore((all) => {
    const cur = all.items.find((w) => w.id === String(id));
    if (!cur || cur.deleted) throw fail(404, 'not-found', '그 정비 창을 찾지 못했습니다.');
    revCheck(cur, rev);
    const st = windowStatus(cur, now);
    if (st.status !== 'active') throw fail(409, 'not-active', '진행 중인 창이 아닙니다.');
    Object.assign(cur, { endedAt: now, endedBy: String(by).slice(0, 64), endedOccStart: st.current.start, rev: cur.rev + 1 });
    cur.edits = [...(cur.edits || []), { at: now, by: String(by).slice(0, 64), fields: ['end-now'] }].slice(-EDITS_MAX);
    writeAll(all);
    return copy(cur);
  });
}
/** 반복 창 재확인(만료 시한을 다시 잡는다). */
export function confirmWindow(id, { by = '', rev = null, now = Date.now() } = {}) {
  return withStore((all) => {
    const cur = all.items.find((w) => w.id === String(id));
    if (!cur || cur.deleted) throw fail(404, 'not-found', '그 정비 창을 찾지 못했습니다.');
    if (cur.schedule.kind === 'once') throw fail(409, 'not-recurring', '일회 창은 재확인이 없습니다.');
    revCheck(cur, rev);
    Object.assign(cur, { confirmedAt: now, rev: cur.rev + 1 });
    cur.edits = [...(cur.edits || []), { at: now, by: String(by).slice(0, 64), fields: ['confirm'] }].slice(-EDITS_MAX);
    writeAll(all);
    return copy(cur);
  });
}
/** 지우기 — 흔적만 남긴다(억제는 즉시 멈춘다). */
export function deleteWindow(id, { by = '', rev = null, now = Date.now() } = {}) {
  return withStore((all) => {
    const cur = all.items.find((w) => w.id === String(id));
    if (!cur || cur.deleted) throw fail(404, 'not-found', '그 정비 창을 찾지 못했습니다.');
    revCheck(cur, rev);
    cur.deleted = { at: now, by: String(by).slice(0, 64) };
    cur.rev += 1;
    writeAll(all);
    return copy(cur);
  });
}

/* ── 엣지 배포본(중앙이 보낸 창 — 엣지에서만 쓴다) ─────────────────────── */
let _dep = null;   // { m, s, data }
/**
 * history(지난 구간용 — 점검 반복 3회차 D2) 상한: 개수 · 크기(JSON UTF-8 바이트 — 중앙이 보낼 때와 엣지가 받을 때 같은 값 · historySizeOf). 넘치면 최근 것부터 남기고 센다.
 *   크기 상한은 인출 본문 상한(agent/bmMaintPull BODY_MAX 4MB) 안에서 지금 억제 창(windows)의 자리를 빼앗지 않게 잡았다.
 */
export const DEPLOY_HISTORY_MAX = 500;
export const DEPLOY_HISTORY_BYTES_MAX = 1_000_000;
/** history 를 상한 안으로(순수 — 앞에서부터 남긴다: 호출자가 최근 것부터 줄 세운다). */
/** 크기 = JSON 의 **UTF-8 바이트**(3회차 재확인 2 — 글자 수로 재면 한글 이름 · 사유가 가득한 history 가 1,000,000자 · 2.7MB 가 되어 인출 본문 상한(바이트)을 먹었다). */
export const historySizeOf = (x) => Buffer.byteLength(JSON.stringify(x), 'utf8');
export function capHistory(list = [], { sizeOf = historySizeOf, maxBytes = DEPLOY_HISTORY_BYTES_MAX } = {}) {
  const out = []; let bytes = 0; let dropped = 0;
  for (const w of Array.isArray(list) ? list : []) {
    const n = sizeOf(w);
    if (out.length >= DEPLOY_HISTORY_MAX || bytes + n > maxBytes) { dropped += 1; continue; }
    out.push(w); bytes += n;
  }
  return { list: out, dropped };
}
/** 파일에 쓸 꼴 — 메모리 표지(origin · history)는 읽을 때 다시 붙인다. */
const bareWin = (w) => { const o = { ...w }; delete o.origin; delete o.history; return o; };
/** history 줄 세우기 열쇠(최근 것부터) — 가벼운 값만(지운 시각 · 끝낸 시각 · 재확인 · 만든 시각 중 늦은 것). */
/**
 * ⚠ 정정(3회차 재확인 R3): 처음 판은 지운 · 끝낸 · 재확인 · 만든 시각만 보아, 오래전에 만들어 어제 저절로 끝난 일회 창(지난 31일 계산에 실제로 걸리는 창)이 먼저 버려졌다.
 *   이제 그 창의 **유효 끝**(일회 = 마지막 발생의 끝 onceEndOf · 반복 = 재확인 만료 시각)과 지운 · 끝낸 시각 중 늦은 것.
 */
/**
 * ⚠ 정정(3회차 재확인 2 R3-2): 묘비는 지난 구간에 **지운 시각까지만** 남는다(effectiveOccurrences history) — 열쇠도 min(유효 끝, 지운 시각).
 *   max 로 두면 시작 전에 지운 일회 창 · 지운 반복 창의 열쇠가 미래(유효 끝 · 만료)가 되어, 한 번도 덮지 않은 묘비가 상한에서 진짜 지난 창을 밀어냈다.
 */
export const historyRecency = (w) => {
  if (!w) return 0;
  const end = Number(w.schedule?.kind === 'once' ? onceEndOf(w.deleted ? { ...w, deleted: undefined } : w) : (expiresAt(w) ?? 0)) || 0;
  const del = w.deleted ? Number(w.deleted.at) : NaN;
  if (Number.isFinite(del)) return end ? Math.min(end, del) : del;
  return Math.max(end, Number(w.endedAt) || 0);
};
/**
 * 배포본 저장(엣지 인출 워커) — 같은 정규화를 다시 거친다(엣지는 중앙 문자열을 그대로 믿지 않는다). 형식 밖은 버리고 센다.
 * @param {Array} list  지금 억제에 쓰는 창(진행 중 · 예정 — 24시간 시한)
 * @param {{sig?:string, now?:number, history?:Array|undefined}} o  history = 지난 구간용 창(끝남 · 지움 · 만료 — 3회차 D2).
 *   배열이 아니면(구버전 중앙 · 필드 없음) **직전 history 를 그대로 둔다**(과거 사실 — 억제가 아니라 시한을 걸지 않는다 · 90일 지난 것만 비운다).
 */
export function saveDeployed(list, { sig = '', now = Date.now(), history = undefined } = {}) {
  const items = []; let dropped = 0; let carried = 0;
  // v2.954(점검 D-1 반증 재수정): 중앙이 그 엣지 대상을 몰라 태그 창에 keysUnknown 을 달아 보내면(중앙 재시작 직후) 직전 배포본의 같은 창(id · 태그) keys 를 이어 쓴다 —
  //   빈 keys 로 억제가 꺼지지 않게. 직전 배포본이 없거나 시한이 지났거나 새 창이면 이어 쓸 것이 없다(0대 — 예전과 같다). history 도 같은 규칙(직전 items · history 에서).
  let prev = null;
  const prevOf = () => { if (!prev) { prev = { byId: new Map(), history: [], historyAt: 0 }; try { const d = loadDeployed(now); for (const p of [...(d?.items || []), ...(d?.history || [])]) if (!prev.byId.has(p.id)) prev.byId.set(p.id, p); prev.history = d?.history || []; prev.historyAt = Number(d?.historyAt) || 0; } catch { /* 직전 판을 못 읽으면 이어 쓸 것이 없다 */ } } return prev; };
  const carry = (x, w) => {
    if (!(x?.target?.keysUnknown === true && w.target?.kind === 'tag')) return;
    const p = prevOf().byId.get(w.id);
    if (p?.target?.kind === 'tag' && p.target.tag === w.target.tag && Array.isArray(p.target.keys) && p.target.keys.length) { w.target = { ...w.target, keys: p.target.keys.slice(0, 5_000) }; carried += 1; }
  };
  for (const x of (Array.isArray(list) ? list : []).slice(0, WINDOWS_MAX)) {
    const w = normalizeWindow(x);
    if (!w) { dropped += 1; continue; }
    carry(x, w);
    items.push({ ...w, origin: 'central' });
  }
  dropped += Math.max(0, (Array.isArray(list) ? list.length : 0) - WINDOWS_MAX);
  // history — 같은 정규화 · 지금 억제 창과 같은 id 는 뺀다(지금 창이 이긴다) · 90일 지난 것은 비운다 · 개수 · 크기 상한
  const liveIds = new Set(items.map((w) => w.id));
  let hist = []; let historyDropped = 0; let historyAt = 0;
  if (Array.isArray(history)) {
    const cand = [];   // { w, n } — 크기는 **받은 원문 길이**로 잰다(3회차 재확인 R3 — 정규화 뒤 꼴(edits 등)로 다시 재면 중앙이 상한 안에서 보낸 것 중 하나를 더 버렸다)
    for (const x of history.slice(0, DEPLOY_HISTORY_MAX * 2)) {
      const w = normalizeWindow(x);
      if (!w) { historyDropped += 1; continue; }
      carry(x, w);
      if (liveIds.has(w.id) || !keptPast(w, now)) continue;
      cand.push({ w, n: historySizeOf(x) });
    }
    historyDropped += Math.max(0, history.length - DEPLOY_HISTORY_MAX * 2);
    const c = capHistory(cand.sort((a, b) => historyRecency(b.w) - historyRecency(a.w)), { sizeOf: (p) => p.n });
    hist = c.list.map((p) => p.w); historyDropped += c.dropped; historyAt = now;
  } else {
    const p = prevOf();
    hist = p.history.filter((w) => !liveIds.has(w.id) && keptPast(w, now));
    historyAt = p.historyAt;
  }
  const data = { v: 1, at: now, sig: String(sig).slice(0, 64), items, dropped, history: hist.map(bareWin), historyDropped, historyAt };
  atomicWriteFileSync(DEPLOYED_FILE(), JSON.stringify(data), { mode: 0o600 });
  _dep = null;
  return { ok: true, n: items.length, dropped, history: hist.length, ...(historyDropped ? { historyDropped } : {}), ...(carried ? { carried } : {}) };
}
/**
 * 배포본 읽기 — 없으면 null · 손상이면 보존하고 null(억제하지 않는 쪽) + unreadable.
 *   받은 시각(at)이 지금보다 DEPLOY_FUTURE_SKEW_MS 넘게 미래면(엣지 시계가 앞서 있다가 바로잡힘 — 반증 F7) **지금으로 자르고 파일에도 남긴다**
 *   (시한은 그때부터 24시간 — 매번 지금으로 되돌려 영원히 신선해지지 않게 한 번만 · 원래 값은 atClampedFrom).
 */
export function loadDeployed(now = Date.now()) {
  let st = null;
  try { st = fs.statSync(DEPLOYED_FILE()); } catch { return null; }
  if (_dep && _dep.m === st.mtimeMs && _dep.s === st.size && !(_dep.data.at > now + DEPLOY_FUTURE_SKEW_MS)) return _dep.data;
  try {
    const o = JSON.parse(fs.readFileSync(DEPLOYED_FILE(), 'utf8'));
    if (!o || typeof o !== 'object' || !Array.isArray(o.items)) throw new Error('형식이 다릅니다');
    const items = o.items.map((x) => normalizeWindow(x)).filter(Boolean).map((w) => ({ ...w, origin: 'central' }));
    // history(3회차 D2) — 같은 정규화 · 지난 구간 전용 표지(history: true — judge.activeOccurrence 가 지금 판정에서 뺀다) · 상한 다시 · 없거나 형식 밖이면 [](옛 배포본)
    const ids = new Set(items.map((w) => w.id));
    // 읽을 때는 개수 상한 + 넉넉한 크기 상한(저장한 꼴은 정규화 뒤라 받은 원문보다 길다 — 저장 때 받은 것을 다시 버리지 않게: R3)
    const history = capHistory((Array.isArray(o.history) ? o.history.slice(0, DEPLOY_HISTORY_MAX) : []).map((x) => normalizeWindow(x)).filter((w) => w && !ids.has(w.id)), { maxBytes: DEPLOY_HISTORY_BYTES_MAX * 2 }).list
      .map((w) => ({ ...w, origin: 'central', history: true }));
    let at = Number(o.at) || 0; let clampedFrom = Number(o.atClampedFrom) || null;
    if (at > now + DEPLOY_FUTURE_SKEW_MS) {
      clampedFrom = at; at = now;
      try { atomicWriteFileSync(DEPLOYED_FILE(), JSON.stringify({ ...o, at, atClampedFrom: clampedFrom }), { mode: 0o600 }); } catch { /* 못 쓰면 이번 판단만 — 다음 읽기에서 다시 자른다 */ }
      console.warn('[bmusage] 정비 창 배포본의 받은 시각이 미래라 지금으로 잘랐습니다(엣지 시계 변경 — 24시간 시한은 지금부터)');
      try { st = fs.statSync(DEPLOYED_FILE()); } catch { /* */ }
    }
    const data = { at, sig: String(o.sig || '').slice(0, 64), items, dropped: Number(o.dropped) || 0, history, historyAt: Number(o.historyAt) || 0, ...(Number(o.historyDropped) ? { historyDropped: Number(o.historyDropped) } : {}),
      ...(clampedFrom ? { atClampedFrom: clampedFrom } : {}) };
    _dep = { m: st.mtimeMs, s: st.size, data };
    return data;
  } catch (e) {
    preserveCorrupt(DEPLOYED_FILE(), String(e?.message || e));
    _dep = null;
    return { at: 0, sig: '', items: [], history: [], unreadable: true };
  }
}
/** 배포본이 시한을 넘었나(판정 · 화면이 같은 함수). */
export const deployedStale = (dep, now = Date.now()) => !!dep && (now - Number(dep.at || 0) > DEPLOY_TTL_MS);

/**
 * 판정 입력 — 이 노드의 창(묘비 포함) + 신선한 배포본 + 배포 history(지난 구간 전용). 못 읽은 쪽은 넣지 않고 표지로 밝힌다.
 *   ⚠ 점검 반복 3회차 D2: 배포본 24시간 시한은 **지금 억제**(items)에만 건다. history(중앙의 끝남 · 지움 · 만료 창 — history: true)는 억제가 아니라 과거 사실이라
 *   시한이 지나도 마지막으로 받은 것을 넣는다 — 지금 판정(judge.activeOccurrence)은 history 를 빼고, 지난 구간(coverIntervals — ⑤ 분모 제외 · 음영)만 쓴다.
 *   예전에는 끝난 일회 창이 다음 배포본에서 빠져 엣지 서버의 용량 · 저활용 · 베이스라인 제외가 소급해 사라졌다(중앙은 남는다 — 같은 창이 두 노드에서 다른 과거).
 * @returns {{ windows:Array, localUnreadable:boolean, deployed:{at:number,sig:string,n:number,stale:boolean,unreadable?:boolean}|null }}
 */
export function windowsForJudge(now = Date.now()) {
  let local = []; let localUnreadable = false;
  // 묘비(지운 창)도 넣는다 — 지금 판정은 judge 가 빼고(activeOccurrence), 지난 구간(coverIntervals)은 지운 시각까지 쓴다.
  try { local = loadAll().items; } catch { localUnreadable = true; }
  const dep = loadDeployed(now);
  const stale = deployedStale(dep, now);
  const deployed = dep ? { at: dep.at, sig: dep.sig, n: dep.items.length, stale, ...(dep.unreadable ? { unreadable: true } : {}) } : null;
  return { windows: [...local, ...(dep && !stale ? dep.items : []), ...(dep?.history || [])], localUnreadable, deployed };
}
/**
 * 점검용 사실(캐시 없이 — 반증 F8): 파일 두 개를 지금 다시 읽어 창마다 지운 시각 · 지금 끝낸 시각 · 재확인 · 일정 꼴만 돌려준다(정규화 · 판정을 거치지 않는다).
 * @returns {{ ok:boolean, byId:Map<string,{deleted:number|null, endedAt:number|null, endedOccStart:number|null, confirmedAt:number|null, kind:string, deployedAt?:number}> }}
 */
export function windowFactsNoCache() {
  const byId = new Map(); let ok = true;
  const put = (x, extra = {}) => {
    if (!x || typeof x !== 'object' || !ID_RE.test(String(x.id || ''))) return;
    const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
    byId.set(String(x.id), { deleted: x.deleted && typeof x.deleted === 'object' ? num(x.deleted.at) : null, endedAt: num(x.endedAt), endedOccStart: num(x.endedOccStart),
      confirmedAt: num(x.confirmedAt ?? x.at), kind: String(x.schedule?.kind || ''), ...extra });
  };
  for (const [file, deployed] of [[FILE(), false], [DEPLOYED_FILE(), true]]) {
    let o = null;
    try { o = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e?.code !== 'ENOENT') ok = false; continue; }
    const items = Array.isArray(o?.items) ? o.items : [];
    for (const x of items) if (!(deployed && byId.has(String(x?.id)))) put(x, deployed ? { deployedAt: Number(o.at) || 0 } : {});
  }
  return { ok, byId };
}
export function _resetMaintStoreForTest() { _cache = null; _dep = null; _chain = Promise.resolve(); _err.ok(); _endMemo.clear(); }
