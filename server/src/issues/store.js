/**
 * issues/store.js — 이슈 트래커 저장소(v2.864). 포탈 공용 이슈(장애·작업·요청·개선)를 등록하고 담당자에게 할당해 끝날 때까지 추적한다.
 *
 * 파일 하나 — `issues.json` `{ v:1, nextSeq, issues:[…] }`. 사용자가 손으로 쓴 값이라 bulletin/store.js(v2.722·v2.727) 와 같은 규칙:
 *   · 캐시(메모리)가 진실이고 파일 쓰기는 `WRITE_DELAY_MS` 안의 변경을 묶어 비동기로 쓴다(tmp 0600 → fsync → rename). 종료 때는
 *     `util/exitFlush.js` 에 등록한 동기 flush 가 대기분을 쓴다(자체 process.on 금지 — v2.582 규약).
 *   · 쓰기 실패는 **조용히 지나가지 않는다** — 상태(`issuesPersist()` state saved|pending|failed · 사유 코드 · 단계)와 콘솔에 남기고 제한된
 *     지수 backoff(5초 → … 최대 6회·상한 5분)로 다시 쓴다. 6회를 넘기면 멈추고 다음 변경·종료 flush 가 다시 쓴다(무한 루프 금지).
 *     오류 원문은 tmp 파일 절대 경로를 담으므로 코드·syscall 만 남긴다.
 *   · 손상본은 `preserveCorrupt` 로 옆에 보존하고 빈 목록으로 시작한다(손상본을 빈 목록으로 덮어쓰지 않는다).
 *   · 상한은 **거부**다(조용히 자르지 않는다): 이슈 2,000건 · 제목 200자 · 본문 10,000자 · 이슈당 댓글 200개 · 댓글 2,000자 · 라벨 10개(30자) ·
 *     관찰자 50명 · 이력 300건(넘치면 오래된 것부터 지우고 `historyDropped` 로 지운 수를 밝힌다) · 합계 `ISSUES_MAX_BYTES`(기본 16MB —
 *     이슈마다 직렬화 바이트를 따로 들고 합을 유지한다: 변경마다 전체를 다시 직렬화하지 않는다 — v2.727 B-01 과 같은 이유).
 *
 * 도메인 규칙(기획 v0.1 — docs/rules/web.md 게시판 항목과 같은 자리에 요약):
 *   · 키 `ISS-<n>` 은 파일의 `nextSeq` 로 매긴다 — 지운 번호는 다시 쓰지 않는다.
 *   · 상태 backlog → todo → progress → review → done. **progress 로 옮기려면 담당자가 있어야 한다**(400). done 은 `closedAt` 을 적고
 *     done 에서 나오면 지운다. 보류(`blocked`)는 상태와 별개의 표지이고 **사유가 있어야** 들어간다(400).
 *   · 담당자는 1명(책임 명확). 함께 보는 사람은 관찰자. 재할당은 이력에 남고 라우트가 감사 로그를 적는다.
 *   · 수정 권한은 라우트가 정한다(쓰기 계정 전부 — 협업 도구). 삭제는 보고자 본인 또는 관리자(라우트가 `isMod` 로 넘긴다).
 *   · 시각은 epoch ms 숫자 하나. 문자열 값은 `capStr` 로 평탄화한다(원문 SlicedString 을 붙잡지 않게).
 *
 * v2.871(사용자 선택 — 감사 A3-02 '법인(vCenter) 축 추가'):
 *   · 이슈마다 `vcenterId`(법인 — '' = 공용). 접근은 라우트가 만든 `access = { read, write }`(Set|null — null 은 제한 없음,
 *     auth/scope.js scopedVcenterIds · writeScopedVcenterIds)로 판정한다. 범위 계정은 자기 조회 범위의 법인 이슈만 보고
 *     **공용(법인 없음) 이슈는 보지 않는다**(서버 불변조건 '귀속 없는 데이터는 범위 계정에 노출하지 않는다'). 단건은 조회 밖 404 →
 *     쓰기 밖 403 순서(`findFor`). 범위 계정이 만드는 이슈는 쓰기 범위 안의 법인을 반드시 고른다(400 · 밖이면 403).
 *   · 이벤트 훅 `onIssueEvent` — 생성·할당·상태·댓글이 저장 뒤에 알린다(알림 모듈이 구독). 훅의 실패는 변경을 되돌리지 않는다(콘솔).
 *   · `createIssue(…, { auto })` — 담당자를 비운 생성에 자동 할당 결과를 싣는다(이력에 '자동 할당: 근거'). `{ requestOnly }` — viewer 의
 *     요청 등록(유형 '요청' · 백로그 · 관찰자·상태 지정 없음).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt, safeLoadText } from '../util/atomicWrite.js';
import { capStr } from '../util/capStr.js';
import { numOrNull } from '../util/numOrNull.js';
import { registerExitFlush } from '../util/exitFlush.js';
import { dayKey, dayIndex, dayLabel, dayStartMs, DAY_MS } from '../util/dayKey.js';
import { getSprint, listSprints, activeSprintIds, findSprintByName } from './sprints.js';
import { parseQuery, compileQuery, orderComparator } from './query.js';
import { slaOf, slaQueryState, slaTimes, usedMin } from './sla.js';
import { loadIssueSettings } from './settings.js';

export const KEY_PREFIX = 'ISS';
export const KEY_RE = /^ISS-\d{1,9}$/;
export const ID_RE = /^[a-f0-9]{16}$/;
/** 법인(vCenter) id 꼴 — 공백·제어 문자 없는 1~128자(vCenter id 에 콜론이 들어간다). */
export const VC_ID_RE = /^[^\s\u0000-\u001f\u007f]{1,128}$/;
/** 제한 없는 접근(전체 범위). 라우트는 사용자마다 access 를 만들어 넘긴다. */
export const FULL_ACCESS = Object.freeze({ read: null, write: null });

export const STATUSES = Object.freeze(['backlog', 'todo', 'progress', 'review', 'done']);
export const TYPES = Object.freeze(['incident', 'task', 'request', 'improve', 'epic']); // v2.882 에픽(계층의 맨 위)
export const PRIORITIES = Object.freeze(['p0', 'p1', 'p2', 'p3']);
export const LIMITS = Object.freeze({
  issueMax: 2000, title: 200, body: 10000, commentMax: 200, commentBody: 2000,
  // v2.927(점검 B1-03 — 재현): 자동 등록(알람 · 파트 장애)이 다는 댓글은 따로 센다 — 사람 몫(commentMax)을 쓰지 않는다
  autoCommentMax: 100,
  labelMax: 10, label: 30, component: 60, watcherMax: 50, historyMax: 300, name: 64, blockReason: 500, progressNote: 300, activityMax: 300,
  // v2.871 감사 A3-02: 요청 등록(viewer)은 전체 상한에서 운영자 몫(requestReserve)을 남기고, 한 사람이 열어 둔 요청은 requestOpenPerUser 건까지.
  requestReserve: 200, requestOpenPerUser: 20,
  bulkMax: 200,
  // v2.882 계층 — 한 상위의 자식 수 상한(하위 작업 · 에픽의 이슈)
  childMax: 200,
  // v2.883 연결 — 이슈마다 저장하는 연결 수(반대 방향은 읽을 때 계산하므로 세지 않는다)
  linkMax: 30,
  // v2.888 C-3 시간 추적 · 버전 — 예상은 90일(분) · 작업 기록은 이슈마다 200개 · 한 줄 1~1440분(하루) · 메모 200자 · 버전 40자
  estimateMaxMin: 60 * 24 * 90, worklogMax: 200, worklogMaxMin: 1440, worklogNote: 200, version: 40,
});
/** v2.888 버전 표기 — 포탈 버전(2.885.0) · 사내 표기(R24.11 · hotfix-3). 영숫자로 시작하고 영숫자 . _ - 만. */
export const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,39}$/;
/** v2.883 연결 종류 — 만든 쪽에만 저장하고 반대 방향(INVERSE)은 읽을 때 계산한다(상대 이슈의 쓰기 범위가 없어도 된다). */
export const LINK_TYPES = Object.freeze(['blocks', 'blockedBy', 'relates', 'duplicates', 'duplicatedBy']);
export const LINK_INVERSE = Object.freeze({ blocks: 'blockedBy', blockedBy: 'blocks', relates: 'relates', duplicates: 'duplicatedBy', duplicatedBy: 'duplicates' });
/** 최근 완료로 보여 주는 기간(ms) — 보드의 '완료' 열. */
export const RECENT_DONE_MS = 14 * 24 * 3600_000;
export const ISSUES_MAX_BYTES_DEFAULT = 16 * 1024 * 1024;
export const WRITE_DELAY_MS = 300;
export const PERSIST_WAIT_MS = 3000;
export const RETRY_DEFAULTS = Object.freeze({ max: 6, baseMs: 5000, capMs: 300000 });
let RETRY = { ...RETRY_DEFAULTS };

/** 쓰기 실패 사유 코드 → 짧은 문구(bulletin/store.js WRITE_ERROR_TEXT 와 같은 표). */
export const WRITE_ERROR_TEXT = Object.freeze({
  ENOSPC: '디스크 공간이 부족합니다', EDQUOT: '디스크 할당량(quota)을 넘었습니다', EACCES: '저장 폴더·파일에 쓰기 권한이 없습니다',
  EPERM: '저장 폴더·파일에 대한 작업이 허용되지 않습니다', EROFS: '읽기 전용 파일 시스템입니다', EISDIR: '저장 파일 자리에 폴더가 있습니다',
  ENOTDIR: '설정 폴더 경로의 일부가 폴더가 아닙니다', ENOENT: '설정 폴더를 찾지 못했습니다', EMFILE: '열린 파일이 너무 많습니다',
  ENFILE: '시스템 전체의 열린 파일이 너무 많습니다', EIO: '디스크 입출력 오류입니다', EBUSY: '파일이 사용 중입니다',
  EUNKNOWN: '파일을 쓰지 못했습니다(서버 로그에서 원인을 확인하세요)',
});

/** 합계 상한 — env ISSUES_MAX_BYTES(바이트). 빈 값·비수치·0 이하는 기본값(numOrNull — `KEY=` 한 줄이 상한을 0 으로 만들지 않게), 하한 64KB. */
export function issuesMaxBytes() {
  const n = numOrNull(process.env.ISSUES_MAX_BYTES);
  if (n == null || n <= 0) return ISSUES_MAX_BYTES_DEFAULT;
  return Math.max(65_536, Math.trunc(n));
}

export const issuesFile = () => path.join(config.configDir, 'issues.json');

/* ───── 연결(v2.883 · 시안 ⑩ — 차단함/차단됨/관련/중복) ───── */
/**
 * 연결 더하기 — 이 이슈(쓰기 범위)에 저장한다. 상대는 볼 수 있어야 한다(조회 범위 밖이면 '없는 이슈'). 반대 방향은 상대에 쓰지 않고 읽을 때 계산한다.
 * 같은 연결(어느 쪽에 저장됐든)이 이미 있으면 그대로 둔다.
 */
export function addLink(key, body, user, { access = FULL_ACCESS } = {}) {
  const c = load();
  const x = findFor(key, access, { write: true });
  const b = body || {};
  if (!LINK_TYPES.includes(b.type)) throw fieldError('type', `${LINK_TYPES.join(' · ')} 중 하나여야 합니다`);
  const target = typeof b.key === 'string' ? b.key.trim().toUpperCase() : '';
  if (!KEY_RE.test(target)) throw fieldError('key', '이슈 키(ISS-번호)여야 합니다');
  if (target === x.key) throw fieldError('key', '자기 자신과는 연결할 수 없습니다');
  const y = c.issues.find((q) => q.key === target);
  if (!y || !canSee(y, access)) throw fieldError('key', '없는 이슈입니다');
  const idx = treeIndex(c.issues);
  if (relationsOf(x, idx, null).some((l) => l.type === b.type && l.key === target)) return { ...viewIssue(x, user, access), writable: canEdit(x, access) };
  const mine = linksOf(x).filter((l) => idx.byKey.has(l.key)); // v2.904 점검 S-2: 이미 쌓인 죽은 연결은 세지 않고 이번 저장에서 걷어 낸다
  if (mine.length >= LIMITS.linkMax) throw limitError(`연결은 이슈마다 ${LIMITS.linkMax}개까지입니다`);
  const now = Date.now();
  const next = { ...x, links: [...mine, { type: b.type, key: target, at: now, by: user }] };
  const out = replace(c, next, [{ at: now, by: user, field: 'link', from: '', to: `${b.type} ${target}` }], user);
  return { ...viewIssue(out, user, access), writable: canEdit(out, access) };
}
/**
 * 연결 빼기 — 이 이슈에 저장된 것이면 이 이슈(쓰기 범위)에서, 상대가 만든 것(반대 방향)이면 **상대 이슈의 쓰기 범위**가 있어야 상대에서 지운다.
 */
export function removeLink(key, body, user, { access = FULL_ACCESS } = {}) {
  const c = load();
  const x = findFor(key, access);
  const b = body || {};
  if (!LINK_TYPES.includes(b.type)) throw fieldError('type', `${LINK_TYPES.join(' · ')} 중 하나여야 합니다`);
  const target = typeof b.key === 'string' ? b.key.trim().toUpperCase() : '';
  const now = Date.now();
  const mine = linksOf(x);
  if (mine.some((l) => l.type === b.type && l.key === target)) {
    if (!canEdit(x, access)) throw forbidden('이 이슈의 법인은 쓰기 범위 밖입니다 — 조회만 할 수 있습니다');
    const out = replace(c, { ...x, links: mine.filter((l) => !(l.type === b.type && l.key === target)) }, [{ at: now, by: user, field: 'link', from: `${b.type} ${target}`, to: '' }], user);
    return { ...viewIssue(out, user, access), writable: canEdit(out, access) };
  }
  // 반대 방향 — 상대가 저장한 (inverse, x.key)
  const inv = LINK_INVERSE[b.type];
  const y = KEY_RE.test(target) ? c.issues.find((q) => q.key === target) : null;
  if (!y || !canSee(y, access) || !linksOf(y).some((l) => l.type === inv && l.key === x.key)) throw notFound();
  if (!canEdit(y, access)) throw forbidden(`이 연결은 ${y.key} 쪽에서 만든 것이라 그 이슈의 쓰기 범위가 있어야 지울 수 있습니다`);
  replace(c, { ...y, links: linksOf(y).filter((l) => !(l.type === inv && l.key === x.key)) }, [{ at: now, by: user, field: 'link', from: `${inv} ${x.key}`, to: '' }], user);
  const fresh = load().issues.find((q) => q.id === x.id) || x;
  return { ...viewIssue(fresh, user, access), writable: canEdit(fresh, access) };
}

/* ───── 일괄 편집 · 스프린트(v2.882 · 시안 ⑦ ⑧) ───── */

/**
 * 일괄 편집 — set: { sprintId?, parentKey?, addLabels? }(담당자는 bulkAssign). 키마다 updateIssue 를 그대로 탄다(범위 · 계층 규칙 하나).
 * 결과는 키마다 밝힌다(조용히 건너뛰지 않는다).
 */
export function bulkEdit(keys, set, user, { access = FULL_ACCESS, known = null } = {}) {
  if (!Array.isArray(keys)) throw fieldError('keys', '배열이어야 합니다');
  if (keys.length > LIMITS.bulkMax) throw fieldError('keys', `한 번에 ${LIMITS.bulkMax}건까지입니다`);
  const st = set && typeof set === 'object' ? set : {};
  const body = {};
  if (Object.hasOwn(st, 'sprintId')) body.sprintId = st.sprintId;
  if (Object.hasOwn(st, 'parentKey')) body.parentKey = st.parentKey;
  const add = Object.hasOwn(st, 'addLabels') ? labelsField(st.addLabels) : [];
  if (!Object.keys(body).length && !add.length) throw fieldError('set', '바꿀 것(스프린트 · 에픽 · 라벨)이 없습니다');
  const results = [];
  for (const k of keys) {
    if (typeof k !== 'string' || !KEY_RE.test(k)) { results.push({ key: String(k).slice(0, 20), ok: false, reason: '키 형식이 아닙니다' }); continue; }
    try {
      const b = { ...body };
      if (add.length) {
        const cur = findFor(k, access);
        const labels = [...new Set([...(Array.isArray(cur.labels) ? cur.labels : []), ...add])];
        if (labels.length > LIMITS.labelMax) throw fieldError('labels', `라벨은 ${LIMITS.labelMax}개까지입니다`);
        b.labels = labels;
      }
      updateIssue(k, b, user, { access, known });
      results.push({ key: k, ok: true });
    } catch (e) { results.push({ key: k, ok: false, reason: e.message }); }
  }
  return { results, done: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
}

/**
 * 스프린트 끝내기의 '미완료 옮기기' — from 스프린트의 열린 이슈를 to('' = 백로그)로. 전 법인 동작이라 라우트가 전체 범위 계정으로 막는다.
 * 이슈마다 이력('스프린트 끝내기')이 남는다. 반환: { moved, done, keys }.
 */
export function moveSprintIssues(fromId, toId, user, { note = '스프린트 끝내기' } = {}) {
  const to = toId ? sprintField(toId) : '';
  if (to && to === fromId) throw fieldError('to', '같은 스프린트로는 옮길 수 없습니다');
  const c = load();
  const mine = c.issues.filter((x) => (x.sprintId || '') === fromId);
  const openOnes = mine.filter(isOpen);
  const now = Date.now();
  for (const x of openOnes) {
    const cur = load().issues.find((y) => y.id === x.id);
    replace(load(), { ...cur, sprintId: to }, [{ at: now, by: user, field: 'sprint', from: fromId, to, note: capStr(`${note}: ${sprintNameOf(fromId)} → ${sprintNameOf(to) || '백로그'}`, 120) }], user);
  }
  return { moved: openOnes.length, done: mine.length - openOnes.length, keys: openOnes.map((x) => x.key).slice(0, 200) };
}

/**
 * 이 이슈가 시각 t 에 그 스프린트에 들어 있었고 열려 있었는가 — 이력(sprint · status)을 되짚는다. 이력 상한으로 앞부분이 지워졌으면
 * 가장 이른 남은 기록의 'from' 을 처음 값으로 쓴다(근사 — 화면이 approximate 로 밝힌다).
 */
function timelineOf(x, sprintId) {
  const ev = historyOf(x).filter((h) => (h.field === 'sprint' || h.field === 'status') && Number.isFinite(h.at)).sort((a, b) => a.at - b.at);
  const firstSprint = ev.find((h) => h.field === 'sprint');
  const firstStatus = ev.find((h) => h.field === 'status');
  return {
    createdAt: x.createdAt || 0,
    member0: (firstSprint ? (firstSprint.from || '') : (x.sprintId || '')) === sprintId,
    status0: firstStatus ? firstStatus.from : x.status,
    ev,
  };
}

/**
 * 스프린트 보드(시안 ⑦) — 그 스프린트의 이슈(보이는 것만) · 상태별 수 · 사람별 열린 수 · 번다운(일별 남은 열린 이슈) · 백로그(스프린트 밖 열린 이슈).
 * 번다운은 따로 적재하지 않고 이슈 이력에서 계산한다(시안 §4.2). 하위 작업은 상위 이슈 안에서 센다(보드 카드에 n/m) — 번다운 · 수에서 뺀다.
 */
export function sprintBoard(sprintId, { access = FULL_ACCESS, now = Date.now(), backlogMax = 200 } = {}) {
  const sp = getSprint(sprintId);
  if (!sp) { const e = new Error('없는 스프린트입니다'); e.status = 404; throw e; }
  const issues = load().issues;
  const idx = treeIndex(issues);
  const visible = issues.filter((x) => canSee(x, access));
  const isSub = (x) => levelOf(x, idx) === 'sub';
  const inSprint = visible.filter((x) => (x.sprintId || '') === sprintId);
  const rows = inSprint.map((x) => ({ ...summary(x, idx, access), writable: canEdit(x, access), sub: isSub(x) }));
  const top = rows.filter((r) => !r.sub && r.type !== 'epic');
  const counts = Object.fromEntries(STATUSES.map((st) => [st, top.filter((r) => r.status === st).length]));
  const people = new Map();
  let unassigned = 0;
  for (const r of top) { if (r.status === 'done') continue; if (!r.assignee) { unassigned += 1; continue; } people.set(r.assignee, (people.get(r.assignee) || 0) + 1); }
  // 번다운 — 하위 작업 · 에픽 제외, 한 번이라도 이 스프린트에 들어왔던 이슈
  const sIdx = Math.floor(Date.UTC(Number(sp.startDay.slice(0, 4)), Number(sp.startDay.slice(5, 7)) - 1, Number(sp.startDay.slice(8, 10))) / DAY_MS);
  const eIdx = Math.floor(Date.UTC(Number(sp.endDay.slice(0, 4)), Number(sp.endDay.slice(5, 7)) - 1, Number(sp.endDay.slice(8, 10))) / DAY_MS);
  const today = dayIndex(now);
  const lastIdx = sp.state === 'closed' ? eIdx : Math.min(eIdx, today);
  const cands = visible.filter((x) => x.type !== 'epic' && !isSub(x) && ((x.sprintId || '') === sprintId || historyOf(x).some((h) => h.field === 'sprint' && (h.from === sprintId || h.to === sprintId))));
  let approximate = false;
  const days = [];
  const tls = cands.map((x) => { if (Number(x.historyDropped) > 0) approximate = true; return timelineOf(x, sprintId); });
  for (let d = sIdx; d <= eIdx; d += 1) {
    if (d > lastIdx) { days.push({ day: dayLabel(d), remaining: null }); continue; }
    const t = d === today ? now : dayStartMs(d + 1) - 1;
    let remaining = 0;
    for (const tl of tls) {
      if (tl.createdAt > t) continue;
      let member = tl.member0; let status = tl.status0;
      for (const h of tl.ev) {
        if (h.at > t) break;
        if (h.field === 'sprint') member = (h.to || '') === sprintId; else status = h.to;
      }
      if (member && status !== 'done') remaining += 1;
    }
    days.push({ day: dayLabel(d), remaining });
  }
  const backlog = visible.filter((x) => !x.sprintId && isOpen(x) && x.type !== 'epic' && !isSub(x))
    .sort((a, b) => (PRIO_RANK[a.priority] ?? 9) - (PRIO_RANK[b.priority] ?? 9) || (b.updatedAt || 0) - (a.updatedAt || 0));
  return {
    sprint: sp, rows, counts, total: top.length,
    people: [...people.entries()].map(([assignee, open]) => ({ assignee, open })).sort((a, b) => b.open - a.open || a.assignee.localeCompare(b.assignee)), unassigned,
    burndown: { days, approximate, today: dayLabel(today) },
    backlog: backlog.slice(0, backlogMax).map((x) => ({ ...summary(x, idx, access), writable: canEdit(x, access) })), backlogTotal: backlog.length,
  };
}
export { listSprints };

/* ───── 파일 입출력(테스트가 바꿔 끼운다 — 실패 주입) ───── */
const realIo = Object.freeze({
  mkdir: (dir) => fs.promises.mkdir(dir, { recursive: true }),
  writeTmp: async (tmp, body) => {
    const fh = await fs.promises.open(tmp, 'w', 0o600);
    try { await fh.writeFile(body, 'utf8'); await fh.sync(); } finally { await fh.close(); }
    await fs.promises.chmod(tmp, 0o600).catch(() => {});
  },
  rename: (from, to) => fs.promises.rename(from, to),
  unlink: (p) => fs.promises.unlink(p),
  syncDir: async (dir) => { const d = await fs.promises.open(dir, 'r'); try { await d.sync(); } finally { await d.close(); } },
  writeFileAtomicSync: (file, body) => atomicWriteFileSync(file, body, { mode: 0o600 }),
  unlinkSync: (p) => fs.unlinkSync(p),
});
let io = realIo;
/** 테스트 전용 — 파일 입출력 일부를 바꾸고(실패 주입) 재시도 상수를 줄인다. 인자 없이 부르면 원래대로. */
export function _setIssuesIoForTest(over = null, retry = null) {
  io = over ? { ...realIo, ...over } : realIo;
  RETRY = retry ? { ...RETRY_DEFAULTS, ...retry } : { ...RETRY_DEFAULTS };
}

/* ───── 캐시·쓰기 상태(파일 하나) ───── */
let cache = null; // { issues: [], nextSeq, sizes: Map(id → bytes), bytes }
let w = null;     // 쓰기 상태
function writer() {
  if (!w) {
    w = {
      timer: null, writing: false, dirty: false, gen: 0, writes: 0, lastWriteAt: null, lastWriteError: null,
      seq: 0, savedSeq: 0, attemptSeq: 0, lastFailSeq: 0, unsavedSince: null, nextUnsavedAt: null,
      failCount: 0, retryTimer: null, retryAt: null, expedite: false, tmp: null, waiters: [],
    };
  }
  return w;
}

const jsonBytes = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');

function load() {
  if (cache) return cache;
  writer();
  const file = issuesFile();
  let issues = []; let nextSeq = 1;
  try {
    if (fs.existsSync(file)) {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!j || typeof j !== 'object' || !Array.isArray(j.issues)) throw new Error('issues 배열이 없습니다');
      issues = j.issues.filter((x) => x && typeof x === 'object' && typeof x.id === 'string' && typeof x.key === 'string');
      const n = numOrNull(j.nextSeq);
      const maxNum = issues.reduce((m, x) => Math.max(m, Number(x.num) || 0), 0);
      nextSeq = Math.max(n != null && n >= 1 ? Math.trunc(n) : 1, maxNum + 1);
    }
  } catch (e) {
    preserveCorrupt(file, e.message);
    console.warn(`[issues] issues.json 을 읽지 못해 빈 목록으로 시작합니다: ${safeLoadText(e) || '사유 미상'}`);
    issues = []; nextSeq = 1;
  }
  const sizes = new Map(issues.map((x) => [x.id, jsonBytes(x)]));
  let bytes = 0; for (const b of sizes.values()) bytes += b;
  cache = { issues, nextSeq, sizes, bytes };
  return cache;
}

/** 캐시를 바꾸고 쓰기를 예약한다. changed = 바뀐 이슈(크기 재계산) · removedId = 지운 이슈 id. */
function commit(issues, { changed = null, removedId = null, nextSeq = null } = {}) {
  const c = load();
  c.issues = issues;
  if (nextSeq != null) c.nextSeq = nextSeq;
  if (removedId) { c.bytes -= c.sizes.get(removedId) || 0; c.sizes.delete(removedId); }
  if (changed) { const b = jsonBytes(changed); c.bytes += b - (c.sizes.get(changed.id) || 0); c.sizes.set(changed.id, b); }
  c.bytes = Math.max(0, c.bytes);
  const ww = writer();
  const now = Date.now();
  if (ww.seq === ww.savedSeq) ww.unsavedSince = now;
  if (ww.writing && ww.seq === ww.attemptSeq) ww.nextUnsavedAt = now;
  ww.seq += 1;
  scheduleWrite();
}

function scheduleWrite() {
  const ww = writer();
  ww.dirty = true;
  if (ww.timer) return;
  ww.timer = setTimeout(runWrite, WRITE_DELAY_MS);
  ww.timer.unref?.();
}
function clearRetry(ww) { if (ww.retryTimer) { clearTimeout(ww.retryTimer); ww.retryTimer = null; } ww.retryAt = null; }
const serialize = () => JSON.stringify({ v: 1, nextSeq: cache?.nextSeq ?? 1, issues: cache?.issues || [] });
const tmpPathOf = (file) => path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
function errCodeOf(e) { const c = typeof e?.code === 'string' ? e.code : ''; return /^E[A-Z0-9]{2,15}$/.test(c) ? c : 'EUNKNOWN'; }

function noteWriteFail(ww, e, phase, seq) {
  const code = errCodeOf(e);
  ww.lastWriteError = { at: Date.now(), code, phase, message: WRITE_ERROR_TEXT[code] || WRITE_ERROR_TEXT.EUNKNOWN };
  ww.lastFailSeq = Math.max(ww.lastFailSeq, seq);
  ww.dirty = true; ww.failCount += 1;
  clearRetry(ww);
  let next;
  if (ww.failCount <= RETRY.max) {
    const delay = Math.min(RETRY.capMs, RETRY.baseMs * 2 ** (ww.failCount - 1));
    ww.retryAt = Date.now() + delay;
    ww.retryTimer = setTimeout(() => {
      ww.retryTimer = null; ww.retryAt = null;
      if (w !== ww) return;
      if (ww.seq <= ww.savedSeq || ww.writing || ww.timer) return;
      runWrite();
    }, delay);
    ww.retryTimer.unref?.();
    next = `${Math.round(delay / 1000)}초 뒤 다시 씁니다(${ww.failCount}/${RETRY.max})`;
  } else next = `자동 재시도 ${RETRY.max}회를 다 써서 멈춥니다 — 다음 변경·종료 때 다시 씁니다`;
  const sys = typeof e?.syscall === 'string' ? ` ${e.syscall}` : '';
  console.warn(`[issues] issues.json 저장 실패(${code}${sys} · ${phase}) — 미저장 변경 ${Math.max(0, ww.seq - ww.savedSeq)}건 · ${next}`);
}
function noteWriteOk(ww, seq) {
  ww.savedSeq = Math.max(ww.savedSeq, seq);
  ww.writes += 1; ww.lastWriteAt = Date.now(); ww.lastWriteError = null; ww.failCount = 0;
  clearRetry(ww);
  ww.unsavedSince = ww.seq > ww.savedSeq ? (ww.nextUnsavedAt ?? Date.now()) : null;
}
function persistOfWriter(ww, seq) {
  const state = ww.savedSeq >= seq ? 'saved' : (ww.lastWriteError ? 'failed' : 'pending');
  return { state, seq, savedSeq: ww.savedSeq };
}
function settleWaiters(ww) {
  if (!ww.waiters.length) return;
  const keep = [];
  for (const x of ww.waiters) {
    if (ww.savedSeq >= x.seq || (ww.lastWriteError && ww.lastFailSeq >= x.seq)) { clearTimeout(x.t); x.resolve(persistOfWriter(ww, x.seq)); } else keep.push(x);
  }
  ww.waiters = keep;
}

function runWrite() {
  const ww = writer();
  if (ww.timer) { clearTimeout(ww.timer); ww.timer = null; }
  if (ww.writing) { scheduleWrite(); return; }
  clearRetry(ww);
  if (!cache) { ww.dirty = false; return; }
  const file = issuesFile();
  const body = serialize();
  const seq = ww.seq;
  const gen = ++ww.gen;
  ww.dirty = false; ww.writing = true; ww.attemptSeq = seq; ww.nextUnsavedAt = null;
  const tmp = tmpPathOf(file);
  ww.tmp = tmp;
  let failed = false;
  let phase = 'mkdir';
  (async () => {
    try {
      await io.mkdir(path.dirname(file));
      phase = 'write';
      await io.writeTmp(tmp, body);
      if (gen !== ww.gen) { await io.unlink(tmp).catch(() => {}); return; } // 그 사이 동기 flush 가 더 새 본문을 썼다
      phase = 'rename';
      await io.rename(tmp, file);
      try { await io.syncDir(path.dirname(file)); } catch { /* 디렉터리 fsync 미지원 */ }
      if (gen === ww.gen) noteWriteOk(ww, seq);
    } catch (e) {
      if (gen === ww.gen) { failed = true; noteWriteFail(ww, e, phase, seq); }
      await io.unlink(tmp).catch(() => {});
    } finally {
      ww.writing = false; ww.tmp = null;
      const urgent = ww.expedite; ww.expedite = false;
      settleWaiters(ww);
      if (ww.dirty && (urgent || !failed)) { if (urgent) runWrite(); else scheduleWrite(); }
    }
  })();
}

function expediteWrite() {
  const ww = writer();
  if (ww.seq <= ww.savedSeq) return;
  if (ww.writing) { ww.expedite = true; ww.dirty = true; return; }
  runWrite();
}

/** 대기·진행 중인 쓰기를 동기로 끝낸다(종료 훅·테스트). @returns 썼는가 */
export function flushIssuesNow() {
  const ww = writer();
  if (ww.timer) { clearTimeout(ww.timer); ww.timer = null; }
  if (!cache) { ww.dirty = false; return false; }
  if (!ww.dirty && !ww.writing && ww.seq <= ww.savedSeq) return false;
  const body = serialize();
  const seq = ww.seq;
  ww.gen += 1; // 진행 중인 비동기 쓰기를 무효화한다(옛 본문으로 덮지 않게)
  if (ww.writing && ww.tmp) { try { io.unlinkSync(ww.tmp); } catch { /* 이미 rename 됐거나 아직 없다 */ } }
  try {
    io.writeFileAtomicSync(issuesFile(), body);
    ww.dirty = false;
    noteWriteOk(ww, seq);
    settleWaiters(ww);
    return true;
  } catch (e) { noteWriteFail(ww, e, 'flush', seq); settleWaiters(ww); return false; }
}
registerExitFlush('issues/store', () => { flushIssuesNow(); });

/** 테스트 전용 — 예약·진행 중인 쓰기가 끝날 때까지(상한 안에서). */
export async function issuesIdle({ maxMs = 5_000 } = {}) {
  const t0 = Date.now();
  while (w && (w.writing || w.timer)) {
    if (Date.now() - t0 > maxMs) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
  return true;
}
/** 테스트 전용 — 대기분을 쓰고 캐시를 비운다(CONFIG_DIR 를 바꾼 뒤 다시 읽게). */
export function _resetIssuesCache() {
  flushIssuesNow();
  if (w) {
    clearRetry(w);
    if (w.timer) { clearTimeout(w.timer); w.timer = null; }
    for (const x of w.waiters) { clearTimeout(x.t); x.resolve(persistOfWriter(w, x.seq)); }
    w.waiters = [];
  }
  cache = null; w = null;
}

/** 지금까지 받은 마지막 변경 순번(라우트가 쓰기 직후 부른다 — 쓰기는 동기라 사이에 다른 변경이 끼지 않는다). */
export function issuesSeq() { return w?.seq ?? 0; }
/** 한 변경이 디스크에 닿을 때까지(또는 그 변경을 담은 쓰기가 실패할 때까지) 기다린다 — 상한 maxMs. 넘기면 그때의 상태(대개 pending). */
export function waitIssuesPersist(seq, { maxMs = PERSIST_WAIT_MS } = {}) {
  const ww = writer();
  if (ww.savedSeq >= seq) return Promise.resolve(persistOfWriter(ww, seq));
  expediteWrite();
  if (ww.savedSeq >= seq || (ww.lastWriteError && ww.lastFailSeq >= seq && !ww.writing)) return Promise.resolve(persistOfWriter(ww, seq));
  return new Promise((resolve) => {
    const x = { seq, resolve, t: null };
    x.t = setTimeout(() => { ww.waiters = ww.waiters.filter((y) => y !== x); resolve(persistOfWriter(ww, seq)); }, Math.max(0, Math.trunc(Number(maxMs) || 0)));
    x.t.unref?.();
    ww.waiters.push(x);
  });
}
/**
 * 저장소 건강 — 화면 배너가 쓴다. admin:false 면 상태·시각만(사유 코드·횟수는 관리자 상세). 경로·내용·계정명은 싣지 않는다.
 */
export function issuesPersist({ admin = false, now = Date.now() } = {}) {
  if (!w) return { state: 'saved', loaded: false, unsavedSince: null, retrying: false, retryExhausted: false };
  const p = persistOfWriter(w, w.seq);
  const retrying = !!w.retryTimer;
  const out = { state: p.state, loaded: true, unsavedSince: p.state === 'saved' ? null : w.unsavedSince, retrying, retryExhausted: p.state === 'failed' && !retrying && w.failCount > RETRY.max, writing: w.writing };
  if (!admin) return out;
  return {
    ...out, unsaved: Math.max(0, w.seq - w.savedSeq), lastSavedAt: w.lastWriteAt,
    lastWriteError: w.lastWriteError ? { ...w.lastWriteError } : null, failCount: w.failCount, writes: w.writes,
    nextRetryAt: retrying ? w.retryAt : null, retryMax: RETRY.max, unsavedForMs: out.unsavedSince ? Math.max(0, now - out.unsavedSince) : null,
    bytes: cache?.bytes ?? null, maxBytes: issuesMaxBytes(),
  };
}

/* ───── 이벤트(v2.871) ───── */
const listeners = new Set();
/** 이슈 변경 이벤트 구독 — 해제 함수를 돌려준다. 이벤트는 저장(메모리 반영) 뒤에 동기로 온다. */
export function onIssueEvent(fn) { if (typeof fn === 'function') listeners.add(fn); return () => listeners.delete(fn); }
function emit(ev) {
  for (const fn of listeners) {
    try { fn(ev); } catch (e) { console.warn(`[issues] 이벤트 처리 실패(${ev?.type}): ${String(e?.message || e).slice(0, 160)}`); }
  }
}
/** 이벤트에 싣는 이슈 요약(본문 제외 — 알림 문구에 필요한 것만). */
const evIssue = (x) => ({
  key: x.key, title: x.title, type: x.type, status: x.status, priority: x.priority, vcenterId: x.vcenterId || '',
  assignee: x.assignee || '', reporter: x.reporter || '', watchers: Array.isArray(x.watchers) ? [...x.watchers] : [], dueAt: x.dueAt ?? null,
});
/** 댓글의 @멘션 — 공백·@·쉼표가 아닌 1~64자, 10명까지(중복 제거). */
export function mentionsOf(body) {
  const out = [];
  for (const m of String(body || '').slice(0, LIMITS.commentBody).matchAll(/(?:^|[\s(])@([^\s@,()]{1,64})/g)) {
    if (!out.includes(m[1])) out.push(m[1]);
    if (out.length >= 10) break;
  }
  return out;
}

/* ───── 범위(v2.871) ───── */
const canSee = (x, a) => !a?.read || (!!x.vcenterId && a.read.has(x.vcenterId));
const canEdit = (x, a) => !a?.write || (!!x.vcenterId && a.write.has(x.vcenterId));
/** 이 사용자가 이 이슈를 고칠 수 있는가(화면 버튼 잠금용 — 판정은 findFor 와 같다). */
export function writableBy(x, access = FULL_ACCESS) { return canSee(x, access) && canEdit(x, access); }
/** 단건 — 조회 밖 404(존재 은닉) → 쓰기 밖 403. */
function findFor(key, access = FULL_ACCESS, { write = false } = {}) {
  const x = load().issues.find((i) => i.key === key);
  if (!x || !canSee(x, access)) throw notFound();
  if (write && !canEdit(x, access)) throw forbidden('이 이슈의 법인은 쓰기 범위 밖입니다 — 조회만 할 수 있습니다');
  return x;
}

/* ───── 자동 등록 출처(v2.880 — 파트 장애 → 이슈) ─────
 * 사람이 만든 이슈에는 없다. 서버 내부 경로(issues/autoCreate.js)만 붙이고 라우트 본문으로는 받지 않는다(위조 금지).
 * partKeys 는 한 이슈가 덮는 파트 키(`agent|partKey`) — 장비 단위로 묶은 이슈는 여럿이다. resolved 는 해소된 키.
 */
export const ORIGIN_KINDS = Object.freeze(['partfault', 'wiki-comment', 'alert', 'backup']); // v2.908 alert · backup — issues/alertIssues.js
const ORIGIN_KEYS_MAX = 64;
const WIKI_PAGE_RE = /^W\d{1,9}$/;
const WIKI_COMMENT_RE = /^[0-9a-f]{1,40}$/;
function originField(o) {
  const t = (v, n) => capStr(String(v ?? '').trim(), n);
  const keys = (a) => [...new Set((Array.isArray(a) ? a : []).map((k) => t(k, 300)).filter(Boolean))].slice(0, ORIGIN_KEYS_MAX);
  // v2.907 위키 댓글에서 만든 이슈(시안 docs/design/wiki-mention ②④) — 문서 · 댓글 id 만(같은 댓글로 두 번 만들지 않는 열쇠)
  if (o?.kind === 'wiki-comment') {
    return { kind: 'wiki-comment', pageId: WIKI_PAGE_RE.test(String(o.pageId || '')) ? o.pageId : '', commentId: WIKI_COMMENT_RE.test(String(o.commentId || '')) ? o.commentId : '', partKeys: [], resolved: [] };
  }
  // v2.908 다른 알람(알람 키 하나) · Bareos 백업 실패(잡 하나 — 실패한 jobid 를 partKeys 에 쌓는다)
  if (o?.kind === 'alert' || o?.kind === 'backup') {
    return {
      kind: o.kind, alertKey: t(o.alertKey, 300), alertKind: t(o.alertKind, 32), title: t(o.title, 200), deviceName: t(o.deviceName, 200),
      partKeys: keys(o.partKeys), resolved: [], reopen: Math.max(0, Math.min(9999, Math.trunc(Number(o.reopen) || 0))),
      resolvedAt: Number.isFinite(Number(o.resolvedAt)) && Number(o.resolvedAt) > 0 ? Number(o.resolvedAt) : null,
      // v2.927(점검 B1-03) 재발 · 해소 댓글 묶기 — 마지막 자동 댓글 시각 · 그 뒤 묶어 둔(댓글을 달지 않은) 재발 · 해소 수
      noteAt: Number.isFinite(Number(o.noteAt)) && Number(o.noteAt) > 0 ? Number(o.noteAt) : null,
      quietAgain: Math.max(0, Math.min(99_999, Math.trunc(Number(o.quietAgain) || 0))),
      quietResolve: Math.max(0, Math.min(99_999, Math.trunc(Number(o.quietResolve) || 0))),
    };
  }
  return {
    kind: ORIGIN_KINDS.includes(o?.kind) ? o.kind : 'partfault',
    agent: t(o?.agent, 64), scope: t(o?.scope, 32), deviceId: t(o?.deviceId, 200), deviceName: t(o?.deviceName, 200),
    partKeys: keys(o?.partKeys), resolved: keys(o?.resolved), reopen: Math.max(0, Math.min(9999, Math.trunc(Number(o?.reopen) || 0))),
    hold: t(o?.hold, 64),
  };
}
const originNote = (o) => (o?.kind === 'wiki-comment' ? `위키 댓글에서 등록: ${o.pageId || '?'}`
  : o?.kind === 'alert' ? `자동 등록: 알람 · ${capStr(String(o.title || o.alertKey || ''), 80)}`
    : o?.kind === 'backup' ? `자동 등록: 백업 실패 · ${capStr(String(o.deviceName || o.alertKey || ''), 80)}`
      : `자동 등록: 파트 장애${o?.deviceName || o?.deviceId ? ` · ${capStr(String(o.deviceName || o.deviceId), 80)}` : ''}`);
/** 화면에 싣는 출처(키 목록 대신 개수 — 목록 응답을 키우지 않는다). */
function originView(o) {
  if (o.kind === 'wiki-comment') return { kind: o.kind, pageId: o.pageId || '', commentId: o.commentId || '' };
  if (o.kind === 'alert' || o.kind === 'backup') return { kind: o.kind, alertKind: o.alertKind || '', title: o.title || '', deviceName: o.deviceName || '', parts: (o.partKeys || []).length, reopen: o.reopen || 0, resolvedAt: o.resolvedAt ?? null };
  return { kind: o.kind, agent: o.agent || '', scope: o.scope || '', deviceId: o.deviceId || '', deviceName: o.deviceName || '', parts: (o.partKeys || []).length, resolved: (o.resolved || []).length };
}
/** 출처로 이슈 찾기(서버 내부 — 범위 없음). pred(origin, issue) 가 참인 이슈의 사본. */
export function findByOrigin(pred, { openOnly = true } = {}) {
  const out = [];
  for (const x of load().issues) {
    if (!x.origin || (openOnly && !isOpen(x))) continue;
    try { if (pred(x.origin, x)) out.push({ key: x.key, status: x.status, createdAt: x.createdAt, closedAt: x.closedAt ?? null, origin: { ...x.origin, partKeys: [...(x.origin.partKeys || [])], resolved: [...(x.origin.resolved || [])] } }); } catch { /* 판정 오류는 건너뛴다 */ }
  }
  return out;
}
/** 출처 고치기(서버 내부) — 이력·갱신 시각을 바꾸지 않는다(사람이 한 변경이 아니다). */
export function patchOrigin(key, fn) {
  const c = load();
  const x = c.issues.find((i) => i.key === key);
  if (!x || !x.origin) throw notFound();
  const next = { ...x, origin: originField(fn({ ...x.origin, partKeys: [...(x.origin.partKeys || [])], resolved: [...(x.origin.resolved || [])] }) || x.origin) };
  return replace(c, next, [], 'system', { touch: false });
}
/** 오늘(포탈 날짜) 자동 등록으로 만든 이슈 수 — 하루 상한 판정(상태 파일 없이 이슈에서 센다). */
export function originCreatedSince(kind, sinceMs) {
  let n = 0;
  for (const x of load().issues) if (x.origin?.kind === kind && x.createdAt >= sinceMs) n += 1;
  return n;
}

/* ───── 검증 ───── */
const newId = () => crypto.randomBytes(8).toString('hex');
function fieldError(field, msg) { const e = new Error(`${field}: ${msg}`); e.status = 400; e.field = field; return e; }
function limitError(msg, extra) { const e = new Error(msg); e.status = 409; if (extra) e.extra = extra; return e; }
function notFound() { const e = new Error('없는 이슈입니다'); e.status = 404; return e; }
function forbidden(msg) { const e = new Error(msg); e.status = 403; return e; }

/** 문자열 칸: 제어 문자(줄바꿈·탭 제외) 제거 · 앞뒤 공백 제거 · 상한 초과는 오류. */
function text(v, max, field, { required = false } = {}) {
  if (v == null) v = '';
  if (typeof v !== 'string') throw fieldError(field, '문자열이어야 합니다');
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (required && !s) throw fieldError(field, '비어 있습니다');
  if (s.length > max) throw fieldError(field, `${max}자를 넘습니다(${s.length}자)`);
  return capStr(s, max);
}
/** 계정명(담당자·관찰자): 공백·제어 문자 없는 1~64자. 빈 값은 '' (미할당). AD 계정(DOMAIN\user)도 받는다. */
function nameField(v, field) {
  if (v == null || v === '') return '';
  if (typeof v !== 'string') throw fieldError(field, '문자열이어야 합니다');
  const s = v.trim();
  if (!s) return '';
  // eslint-disable-next-line no-control-regex
  if (s.length > LIMITS.name || /[\s\u0000-\u001f\u007f]/.test(s)) throw fieldError(field, `공백 없는 ${LIMITS.name}자 이하의 계정명이어야 합니다`);
  return capStr(s, LIMITS.name);
}
function enumField(v, list, field, def) {
  if (v == null || v === '') { if (def !== undefined) return def; throw fieldError(field, `${list.join('·')} 중 하나여야 합니다`); }
  if (!list.includes(v)) throw fieldError(field, `${list.join('·')} 중 하나여야 합니다`);
  return v;
}
/** 기한: 빈 값 = 없음(null). 숫자(epoch ms) 또는 날짜 문자열. 못 읽으면 오류. */
/** epoch ms 로 받는 가장 이른 값(2001-09-09) — 그보다 작은 수는 '20261105' 같은 날짜 숫자를 ms 로 잘못 읽은 것이다(v2.904 점검 S-7). */
const MIN_EPOCH_MS = 1e12;
function timeField(v, field) {
  if (v == null || v === '') return null;
  const str = typeof v === 'number' ? '' : String(v).trim();
  // v2.904(점검 S-7 — 재현): 숫자만 있는 문자열을 무조건 epoch ms 로 읽어 '20261105' 가 1970-01-01 기한(초과 알림 대상)이 됐다 —
  // 숫자는 13자리 이상(ms)만, 날짜 글자('2026-02-30')는 실제 있는 날짜인지 되돌려 맞춰 본다(Date.parse 는 3월 2일로 넘긴다).
  const n = typeof v === 'number' ? v : (/^\d+$/.test(str) ? Number(str) : Date.parse(str));
  if (!Number.isFinite(n) || n < MIN_EPOCH_MS) throw fieldError(field, '시각을 읽지 못했습니다 — 날짜는 2026-11-05 꼴로 보내세요');
  const d = /^(\d{4})-(\d{2})-(\d{2})/.exec(str);
  if (d) {
    const u = new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3])));
    if (u.getUTCFullYear() !== Number(d[1]) || u.getUTCMonth() + 1 !== Number(d[2]) || u.getUTCDate() !== Number(d[3])) throw fieldError(field, '없는 날짜입니다');
  }
  return Math.trunc(n);
}
/** v2.888 예상(분): 빈 값 = 없음(null) · 0~estimateMaxMin 정수. */
function estimateField(v) {
  if (v == null || (typeof v === 'string' && !v.trim())) return null; // 빈 · 공백만 = 없음
  // v2.904 점검 S-10: Number(' ')·Number([]) 는 0, Number(true) 는 1 — 수 · 숫자 글자만 받고 나머지는 거부(numOrNull 규칙)
  const n = typeof v === 'number' || typeof v === 'string' ? numOrNull(v) : null;
  if (n == null) throw fieldError('estimateMin', `0~${LIMITS.estimateMaxMin} 분 정수여야 합니다`);
  if (!Number.isInteger(n) || n < 0 || n > LIMITS.estimateMaxMin) throw fieldError('estimateMin', `0~${LIMITS.estimateMaxMin} 분 정수여야 합니다`);
  return n;
}
/** v2.888 수정/영향 버전: 빈 값 = 없음('') · VERSION_RE. */
function versionField(v, field) {
  if (v == null || v === '') return '';
  if (typeof v !== 'string' || !VERSION_RE.test(v.trim())) throw fieldError(field, '버전은 영숫자로 시작하는 40자 이하(영숫자 . _ - — 예: 2.885.0)여야 합니다');
  return capStr(v.trim(), LIMITS.version);
}
const worklogOf = (x) => (Array.isArray(x?.worklog) ? x.worklog.filter((w) => w && typeof w === 'object' && typeof w.id === 'string' && Number.isInteger(w.minutes)) : []);
export const spentOf = (x) => worklogOf(x).reduce((a, w) => a + w.minutes, 0);
/** 분 → '1h 30m'(이력 · 메일용 — 화면은 issueText.js minutesText 와 같은 모양). */
export function minutesText(m) {
  if (!Number.isFinite(m)) return '';
  const h = Math.floor(m / 60); const r = m % 60;
  return h && r ? `${h}h ${r}m` : h ? `${h}h` : `${r}m`;
}
function labelsField(v) {
  if (v == null) return [];
  if (typeof v === 'string') v = v.split(',');
  if (!Array.isArray(v)) throw fieldError('labels', '배열이어야 합니다');
  const out = [];
  for (const x of v) {
    const s = text(x, LIMITS.label, 'labels').toLowerCase().replace(/\s+/g, '-');
    if (s && !out.includes(s)) out.push(s);
  }
  if (out.length > LIMITS.labelMax) throw fieldError('labels', `라벨은 ${LIMITS.labelMax}개까지입니다`);
  return out;
}
function watchersField(v) {
  if (v == null) return [];
  if (!Array.isArray(v)) throw fieldError('watchers', '배열이어야 합니다');
  const out = [];
  for (const x of v) { const s = nameField(x, 'watchers'); if (s && !out.includes(s)) out.push(s); }
  if (out.length > LIMITS.watcherMax) throw fieldError('watchers', `관찰자는 ${LIMITS.watcherMax}명까지입니다`);
  return out;
}

/**
 * 법인 칸 — '' = 공용. known(Set|null)은 지금 등록된 vCenter id(null 이면 존재 검사를 건너뛴다 — 시험·스냅샷 없음).
 * 범위 계정(access.write 가 Set)은 공용을 고를 수 없고 쓰기 범위 안이어야 한다(밖이면 403 — 존재가 보이는 vCenter 다).
 */
function vcenterField(v, access, known) {
  const id = v == null ? '' : v;
  if (typeof id !== 'string') throw fieldError('vcenterId', '문자열이어야 합니다');
  const s = id.trim();
  if (!s) {
    if (access?.write) throw fieldError('vcenterId', '범위가 지정된 계정은 법인(vCenter)을 골라야 합니다');
    return '';
  }
  if (!VC_ID_RE.test(s)) throw fieldError('vcenterId', '법인(vCenter) id 형식이 아닙니다');
  if (known && !known.has(s)) throw fieldError('vcenterId', '등록되지 않은 법인(vCenter)입니다');
  if (access?.read && !access.read.has(s)) throw fieldError('vcenterId', '등록되지 않은 법인(vCenter)입니다'); // 조회 밖 — 존재를 흘리지 않는다
  if (access?.write && !access.write.has(s)) throw forbidden('그 법인은 쓰기 범위 밖입니다 — 조회만 할 수 있습니다');
  return capStr(s, 128);
}

/* ───── 조회 ───── */
const commentsOf = (x) => (Array.isArray(x?.comments) ? x.comments.filter((c) => c && typeof c === 'object' && typeof c.id === 'string') : []);
/** 응답에 싣는 댓글 칸(화이트리스트 — 고치기 전 원문 prev 는 싣지 않는다 · v2.927 점검 B1-01 에서 고치기 응답도 같은 모양으로). */
const commentOut = (c) => ({ id: c.id, author: c.author, body: c.body, createdAt: c.createdAt, ...(c.editedAt ? { editedAt: c.editedAt, edits: c.edits || 1 } : {}) });
/**
 * v2.927(점검 B1-03): 자동 댓글 판정 — 저장 때 단 표지(auto). 표지가 생기기 전(v2.908~v2.926)에 자동 등록이 단 댓글은 그 계정 이름으로 본다
 * (issues/alertIssues.js SYSTEM_USER 'alert-auto' · issues/autoCreate.js SYSTEM_USER 'partfault' — 순환 import 를 피해 이름만 둔다).
 * 이미 사람 몫 200개가 자동 댓글로 찬 이슈도 이 판정으로 사람이 다시 댓글을 달 수 있다. v2.927 부터 새 댓글은 auto 를 늘 적으므로(true/false)
 * 이름 판정은 표지 없는 옛 댓글에만 걸린다(같은 이름의 사람 계정이 새로 단 댓글은 사람 몫으로 센다).
 */
export const AUTO_COMMENT_AUTHORS = Object.freeze(['alert-auto', 'partfault']);
export const isAutoComment = (c) => c?.auto === true || (c?.auto === undefined && AUTO_COMMENT_AUTHORS.includes(c?.author));
const historyOf = (x) => (Array.isArray(x?.history) ? x.history.filter((h) => h && typeof h === 'object') : []);
const isOpen = (x) => x.status !== 'done';

/* ───── 계층(v2.882 — 에픽 › 이슈 › 하위 작업. 시안 ⑥) ─────
 * 두 단계만: 에픽(유형 epic)은 상위가 없고, 이슈는 에픽 아래(또는 맨 위), 하위 작업은 '에픽이 아닌 이슈' 아래 — 하위 작업 아래는 없다.
 * 같은 법인끼리만 묶는다(에픽이 공용이면 어느 법인 이슈든 담는다 — 범위 계정은 공용 에픽을 못 보므로 키를 지운다). 진행률은 자식이 있으면
 * 자식 완료 비율로 자동(직접 입력 잠김). */
function treeIndex(issues) {
  const byKey = new Map(); const kids = new Map(); const incoming = new Map();
  for (const y of issues) byKey.set(y.key, y);
  for (const y of issues) {
    for (const l of linksOf(y)) { const a = incoming.get(l.key); const e = { type: LINK_INVERSE[l.type], key: y.key }; if (a) a.push(e); else incoming.set(l.key, [e]); }
    if (!y.parentKey || !byKey.has(y.parentKey) || y.parentKey === y.key) continue;
    const a = kids.get(y.parentKey); if (a) a.push(y); else kids.set(y.parentKey, [y]);
  }
  return { byKey, kids, incoming };
}
const linksOf = (x) => (Array.isArray(x?.links) ? x.links.filter((l) => l && LINK_TYPES.includes(l.type) && typeof l.key === 'string') : []);
/**
 * 이 이슈의 연결 — 내가 만든 것(own) + 남이 나를 가리킨 것(반대 방향). 없는 이슈 · 볼 수 없는 이슈는 뺀다. 같은 (종류, 키)는 한 번.
 * access 가 null 이면 범위 없이(서버 내부 판정 — 완료 전 차단 검사).
 */
function relationsOf(x, idx, access = FULL_ACCESS) {
  const out = []; const seen = new Set();
  const add = (type, key, own) => {
    const y = idx.byKey.get(key);
    if (!y || key === x.key || (access && !canSee(y, access))) return;
    const k = `${type}|${key}`; if (seen.has(k)) return; seen.add(k);
    out.push({ type, key, own, title: y.title, status: y.status, open: isOpen(y) });
  };
  for (const l of linksOf(x)) add(l.type, l.key, true);
  for (const l of idx.incoming.get(x.key) || []) add(l.type, l.key, false);
  return out;
}
function epicKeyOf(x, idx) {
  if (x.type === 'epic' || !x.parentKey) return '';
  const p = idx.byKey.get(x.parentKey);
  if (!p) return '';
  if (p.type === 'epic') return p.key;
  const g = p.parentKey ? idx.byKey.get(p.parentKey) : null;
  return g && g.type === 'epic' ? g.key : '';
}
function rollupOf(x, idx) {
  const kids = idx.kids.get(x.key) || [];
  const done = kids.filter((k) => k.status === 'done').length;
  return { childCount: kids.length, childDone: done, auto: kids.length > 0, pct: kids.length ? Math.round((done / kids.length) * 100) : null };
}
const levelOf = (x, idx) => (x.type === 'epic' ? 'epic' : (() => { const p = x.parentKey ? idx.byKey.get(x.parentKey) : null; return p && p.type !== 'epic' ? 'sub' : 'issue'; })());

/**
 * 상위 지정 검사 — '' 는 맨 위. 반환: 저장할 parentKey. self 는 고치는 이슈(새 이슈면 { type, vcenterId, key:'' }).
 * 조회 범위 밖 상위는 '없는 이슈'(존재 은닉). 같은 법인(또는 공용 에픽)만 · 고리 · 층 규칙 · 자식 수 상한.
 */
function parentField(v, self, issues, access) {
  if (v == null || v === '') return '';
  if (typeof v !== 'string' || !KEY_RE.test(v.trim())) throw fieldError('parentKey', '이슈 키(ISS-번호)여야 합니다');
  const key = v.trim();
  if (key === self.key) throw fieldError('parentKey', '자기 자신을 상위로 둘 수 없습니다');
  const idx = treeIndex(issues);
  const p = idx.byKey.get(key);
  if (!p || !canSee(p, access)) throw fieldError('parentKey', '없는 이슈입니다');
  if (self.type === 'epic') throw fieldError('parentKey', '에픽은 상위를 둘 수 없습니다(계층의 맨 위)');
  const selfKids = self.key ? (idx.kids.get(self.key) || []) : [];
  if (p.type === 'epic') {
    if (p.vcenterId && p.vcenterId !== (self.vcenterId || '')) throw fieldError('parentKey', '에픽은 같은 법인(또는 공용 에픽)의 이슈만 담습니다');
  } else {
    // 하위 작업이 된다 — 상위는 하위 작업이 아니어야 하고, 나는 자식이 없어야 한다(두 단계만)
    if (levelOf(p, idx) === 'sub') throw fieldError('parentKey', '하위 작업 아래에는 하위 작업을 만들 수 없습니다(두 단계만)');
    if (selfKids.length) throw fieldError('parentKey', '하위 작업이 있는 이슈는 다른 이슈의 하위 작업이 될 수 없습니다(두 단계만)');
    if ((p.vcenterId || '') !== (self.vcenterId || '')) throw fieldError('parentKey', '하위 작업은 상위 이슈와 같은 법인이어야 합니다');
  }
  if ((idx.kids.get(key) || []).filter((k) => k.key !== self.key).length >= LIMITS.childMax) throw limitError(`한 상위에 ${LIMITS.childMax}건까지 담습니다`);
  return key;
}
/** 스프린트 지정 검사 — '' 는 백로그. 끝난 스프린트에는 넣지 않는다(회고 기록). */
function sprintField(v) {
  if (v == null || v === '') return '';
  if (typeof v !== 'string' || !/^S[a-f0-9]{10}$/.test(v)) throw fieldError('sprintId', '스프린트 id 형식이 아닙니다');
  const sp = getSprint(v);
  if (!sp) throw fieldError('sprintId', '없는 스프린트입니다');
  if (sp.state === 'closed') throw fieldError('sprintId', '끝난 스프린트에는 넣을 수 없습니다');
  return v;
}
const sprintNameOf = (id) => (id ? (getSprint(id)?.name || id) : '');

/** 목록용 요약(본문·댓글·이력 제외). */
export function summary(x, idx = null, access = FULL_ACCESS, now = Date.now()) {
  const ix = idx || treeIndex(load().issues);
  const r = rollupOf(x, ix);
  const vis = (k) => { if (!k) return ''; const y = ix.byKey.get(k); return y && canSee(y, access) ? k : ''; };
  return {
    id: x.id, key: x.key, num: x.num, type: x.type, title: x.title, status: x.status, priority: x.priority, vcenterId: x.vcenterId || '',
    blocked: x.blocked ? { reason: x.blocked.reason, at: x.blocked.at, by: x.blocked.by } : null,
    assignee: x.assignee || '', reporter: x.reporter || '', labels: Array.isArray(x.labels) ? x.labels : [], component: x.component || '',
    dueAt: x.dueAt ?? null, createdAt: x.createdAt, updatedAt: x.updatedAt || x.createdAt, closedAt: x.closedAt ?? null,
    comments: commentsOf(x).length, watchers: Array.isArray(x.watchers) ? x.watchers.length : 0,
    progress: r.auto ? r.pct : (Number.isInteger(x.progress) ? x.progress : null), progressNote: x.progressNote || '', progressAt: x.progressAt ?? null, progressBy: x.progressBy || '',
    ...(x.origin ? { origin: originView(x.origin) } : {}),
    // v2.882 계층 · 스프린트 — 볼 수 없는 상위(범위 밖 공용 에픽)의 키는 비운다
    parentKey: vis(x.parentKey || ''), epicKey: vis(epicKeyOf(x, ix)), sprintId: x.sprintId || '',
    progressAuto: r.auto, childCount: r.childCount, childDone: r.childDone,
    // v2.883 — 이 이슈를 막고 있는 열린 이슈 수(볼 수 있는 것만 — 카드의 '차단됨')
    blockedOpen: relationsOf(x, ix, access).filter((l) => l.type === 'blockedBy' && l.open).length,
    // v2.888 C-3 — 시간 추적 · 버전 · SLA(설정이 꺼져 있거나 대상이 아니면 null)
    estimateMin: Number.isInteger(x.estimateMin) ? x.estimateMin : null, spentMin: spentOf(x), worklogCount: worklogOf(x).length,
    fixVersion: x.fixVersion || '', affectsVersion: x.affectsVersion || '',
    sla: slaOf(x, loadIssueSettings().sla, now),
    stale: staleDaysOf(x, loadIssueSettings().automation, now), // v2.908 자동화 규칙 '멈춤' 배지(규칙이 꺼져 있으면 null)
  };
}
/**
 * v2.908 리포트 재료(기능 7 — issues/report.js 가 집계한다). 볼 수 있는 이슈마다 집계에 쓰는 칸만 — 이력 원문은 싣지 않는다.
 * resolveMin = 완료 이슈의 만든 → 완료(보류 시간 제외 · 달력 시간). auto = 자동 등록(파트 장애 · 다른 알람) — 위키 댓글에서 만든 것은 사람이 만든 것이다.
 */
export function reportSource({ access = FULL_ACCESS, now = Date.now() } = {}) {
  const sla = loadIssueSettings().sla;
  const out = [];
  for (const x of load().issues) {
    if (!canSee(x, access)) continue;
    const done = x.status === 'done' && Number.isFinite(Number(x.closedAt));
    let resolveMin = null;
    if (done && x.type !== 'epic') { const t = slaTimes(x, now); resolveMin = Math.round(usedMin(t.created, Number(x.closedAt), t.pauses)); }
    out.push({
      key: x.key, type: x.type, priority: x.priority, status: x.status, assignee: x.assignee || '', vcenterId: x.vcenterId || '',
      createdAt: Number(x.createdAt) || 0, closedAt: done ? Number(x.closedAt) : null, resolveMin,
      auto: !!x.origin && x.origin.kind !== 'wiki-comment', originKind: x.origin?.kind || '',
      sla: slaOf(x, sla, now), worklog: worklogOf(x).map((w) => ({ by: w.by || '', at: Number(w.at) || 0, minutes: w.minutes })),
    });
  }
  return out;
}
/** v2.908 진행 중인데 staleDays 일 넘게 갱신이 없으면 그 일 수 — 아니면 null(notify.js scanStale 과 같은 기준). */
export function staleDaysOf(x, automation, now = Date.now()) {
  if (!automation?.stale || x?.status !== 'progress') return null;
  const idle = Math.floor((now - (Number(x.updatedAt || x.createdAt) || 0)) / DAY_MS);
  return idle >= (Number(automation.staleDays) || 7) ? idle : null;
}
/** 상세 — 댓글·이력 포함. `me` 는 보는 사람(관찰 여부). */
/**
 * v2.904(점검 P-2 — 재현): 이력 **응답**에서 범위 밖 식별자를 가린다 — 범위 밖 법인 id 와 볼 수 없는 이슈 키(상위 · 연결 · 상위 완료 메모).
 * 같은 응답의 parentKey · epic · links 는 vis() 로 가리면서 이력만 원문이던 비대칭을 닫는다. 저장된 이력(감사 기록)은 바꾸지 않는다.
 * 조회 무제한이면 그대로(모든 이슈 · 법인을 본다). 사람이 쓴 글(본문 · 댓글 · 메모 글)은 본문과 같이 가리지 않는다.
 */
export const HIDDEN_ISSUE_TEXT = '(볼 수 없는 이슈)';
export const HIDDEN_VCENTER_TEXT = '(볼 수 없는 법인)';
const HIST_KEY_RE = new RegExp(`\\b${KEY_PREFIX}-\\d{1,9}\\b`, 'g');
function historyFor(list, idx, access) {
  if (!access?.read) return list;
  const maskKeys = (v) => String(v ?? '').replace(HIST_KEY_RE, (k) => { const y = idx.byKey.get(k); return y && canSee(y, access) ? k : HIDDEN_ISSUE_TEXT; });
  const maskVc = (v) => (!v || access.read.has(v) ? (v ?? '') : HIDDEN_VCENTER_TEXT);
  return list.map((h) => {
    if (h.field === 'vcenterId') return { ...h, from: maskVc(h.from), to: maskVc(h.to) };
    if (h.field === 'parent' || h.field === 'link' || h.field === 'status') return { ...h, from: maskKeys(h.from), to: maskKeys(h.to), ...(h.note ? { note: maskKeys(h.note) } : {}) };
    return h;
  });
}

export function viewIssue(x, me = '', access = FULL_ACCESS) {
  const idx = treeIndex(load().issues);
  const s = summary(x, idx, access);
  const brief = (y) => (y ? { key: y.key, title: y.title, type: y.type, status: y.status } : null);
  const parent = s.parentKey ? idx.byKey.get(s.parentKey) : null;
  const epic = s.epicKey ? idx.byKey.get(s.epicKey) : null;
  const children = (idx.kids.get(x.key) || []).filter((y) => canSee(y, access)).map((y) => ({ ...summary(y, idx, access), writable: canEdit(y, access) }))
    .sort((a, b) => a.num - b.num);
  const sp = x.sprintId ? getSprint(x.sprintId) : null;
  return {
    ...s, level: levelOf(x, idx), parent: brief(parent), epic: epic ? { ...brief(epic), progress: rollupOf(epic, idx).pct, childCount: rollupOf(epic, idx).childCount, childDone: rollupOf(epic, idx).childDone } : null,
    children, sprint: sp ? { id: sp.id, name: sp.name, state: sp.state, startDay: sp.startDay, endDay: sp.endDay, daysLeft: sp.daysLeft } : null,
    links: relationsOf(x, idx, access),
    body: x.body || '', watcherNames: Array.isArray(x.watchers) ? x.watchers : [], watching: !!me && Array.isArray(x.watchers) && x.watchers.includes(me),
    createdBy: x.createdBy || x.reporter || '', updatedBy: x.updatedBy || '',
    comments: commentsOf(x).map(commentOut),
    history: historyFor(historyOf(x), idx, access), historyDropped: Number(x.historyDropped) || 0,
    worklog: worklogOf(x).map((w) => ({ id: w.id, by: w.by, at: w.at, on: w.on || '', minutes: w.minutes, note: w.note || '' })).reverse(), // v2.888 최신 먼저
  };
}

const PRIO_RANK = { p0: 0, p1: 1, p2: 2, p3: 3 };
const needleOf = (q) => (typeof q === 'string' ? q.trim().toLowerCase().slice(0, 100) : '');

/**
 * 목록 — 필터는 서버가 건다. `done`: 'open'(기본 — 완료 제외) · 'recent'(최근 RECENT_DONE_MS 안의 완료 포함) · 'all'.
 * 정렬: 우선순위 → 기한(없는 것은 뒤) → 갱신 최신. 페이지 인자는 호출부가 pageArgs 로 좁혀 넘긴다.
 */
export function listIssues({ q = '', status = '', assignee = null, priority = '', type = '', label = '', vcenterId = null, sprintId = null, done = 'open', offset = 0, limit = 200, now = Date.now(), access = FULL_ACCESS, query = '', me = '', ctx = null } = {}) {
  const issues = load().issues;
  const idx = treeIndex(issues);
  const all = issues.filter((x) => canSee(x, access)); // 범위가 요청 필터보다 먼저(검색식도 이 뒤에 건다)
  if (typeof query === 'string' && query.trim()) return runQuery(all, idx, query, { offset, limit, now, access, me, ctx });
  const needle = needleOf(q);
  const hit = all.filter((x) => {
    if (status) { if (x.status !== status) return false; } else if (done === 'open') { if (!isOpen(x)) return false; } else if (done === 'recent') { if (!isOpen(x) && !(x.closedAt && now - x.closedAt <= RECENT_DONE_MS)) return false; }
    if (assignee != null && assignee !== '*' && (x.assignee || '') !== assignee) return false;
    if (priority && x.priority !== priority) return false;
    if (type && x.type !== type) return false;
    if (label && !(Array.isArray(x.labels) && x.labels.includes(label))) return false;
    if (vcenterId != null && (x.vcenterId || '') !== vcenterId) return false;
    if (sprintId != null && (x.sprintId || '') !== sprintId) return false;
    if (needle && !`${x.key}\n${x.title}\n${x.body || ''}\n${x.assignee || ''}\n${x.reporter || ''}\n${(x.labels || []).join(' ')}\n${x.component || ''}`.toLowerCase().includes(needle)) return false;
    return true;
  });
  // 감사 A1-02: 행마다 쓰기 가능 여부 — 화면이 '나에게 할당'·일괄 선택을 쓰기 범위 밖 행에서 잠근다(공용 이슈도 범위 계정에는 false).
  const rows = hit.map((x) => ({ ...summary(x, idx, access, now), writable: canEdit(x, access) })).sort((a, b) => (PRIO_RANK[a.priority] ?? 9) - (PRIO_RANK[b.priority] ?? 9)
    || ((a.dueAt ?? Infinity) - (b.dueAt ?? Infinity)) || (b.updatedAt - a.updatedAt));
  return { total: rows.length, all: all.length, offset, limit, rows: rows.slice(offset, offset + limit) };
}

export function getIssue(key, me = '', access = FULL_ACCESS) {
  const x = findFor(key, access);
  return { ...viewIssue(x, me, access), writable: canEdit(x, access) };
}

/* ───── 검색식(v2.882 · 시안 ⑧) — 파서는 issues/query.js 하나. 범위는 호출부(listIssues)가 먼저 걸었다 ───── */
export const QUERY_ROW_TEXT_MAX = 20_000;
/** 검색식 해석 맥락 — 스프린트 이름 · 활성 · 법인 이름 → id. ctx.vcenters = [{id,name}](라우트가 스냅샷에서). ctx.docs = 키 → 위키 제목 배열. */
export function queryContext({ me = '', now = Date.now(), vcenters = [], docs = null } = {}) {
  const vcByName = new Map();
  for (const v of vcenters || []) { if (v?.id) { vcByName.set(String(v.id).toLowerCase(), v.id); if (v.name) vcByName.set(String(v.name).toLowerCase(), v.id); } }
  return {
    me, today: dayIndex(now), now, sla: loadIssueSettings().sla, dayOf: (ms) => dayIndex(ms), activeSprints: activeSprintIds(),
    sprintId: (raw) => { const r = String(raw || '').trim(); if (/^S[a-f0-9]{10}$/.test(r)) return r; return findSprintByName(r)?.id || null; },
    sprintName: (id) => sprintNameOf(id),
    vcenterId: (raw) => vcByName.get(String(raw || '').trim().toLowerCase()) || String(raw || '').trim(),
    docs,
  };
}
function queryRow(x, idx, ctx, access = FULL_ACCESS) {
  // 볼 수 없는 상위(범위 밖 공용 에픽)의 키는 비운다 — summary 와 같은 판정(검색식으로 키를 바꿔 가며 물어 묶음을 알아내지 못하게)
  const vis = (k) => { if (!k) return ''; const y = idx.byKey.get(k); return y && canSee(y, access) ? k : ''; };
  const comments = commentsOf(x).map((c) => c.body || '').join('\n');
  return {
    key: x.key, num: x.num, title: x.title || '', text: `${x.title || ''}\n${x.body || ''}\n${comments}`.slice(0, QUERY_ROW_TEXT_MAX), type: x.type, status: x.status, priority: x.priority,
    assignee: x.assignee || '', reporter: x.reporter || '', watchers: Array.isArray(x.watchers) ? x.watchers : [], vcenterId: x.vcenterId || '',
    labels: Array.isArray(x.labels) ? x.labels : [], component: x.component || '', epicKey: vis(epicKeyOf(x, idx)), parentKey: vis(x.parentKey || ''), sprintId: x.sprintId || '',
    progress: (() => { const r = rollupOf(x, idx); return r.auto ? r.pct : (Number.isInteger(x.progress) ? x.progress : null); })(),
    dueAt: x.dueAt ?? null, createdAt: x.createdAt, updatedAt: x.updatedAt || x.createdAt, closedAt: x.closedAt ?? null,
    docs: ctx.docs ? (ctx.docs(x.key) || []) : [],
    fixVersion: x.fixVersion || '', affectsVersion: x.affectsVersion || '', sla: slaQueryState(slaOf(x, ctx.sla || loadIssueSettings().sla, ctx.now)), // v2.888
  };
}
function queryError(parsed) {
  const e = new Error(`검색식을 읽지 못했습니다 — ${parsed.errors[0]?.msg || '알 수 없는 오류'}`);
  e.status = 400; e.field = 'query'; e.extra = { code: 'query', errors: parsed.errors, clauses: parsed.clauses, orderStart: parsed.orderStart };
  return e;
}
function runQuery(all, idx, query, { offset, limit, now, access, me, ctx }) {
  const parsed = parseQuery(query);
  if (parsed.errors.length) throw queryError(parsed);
  const c = ctx || queryContext({ me, now });
  const pred = compileQuery(parsed.ast, c);
  const cmp = orderComparator(parsed.order, c);
  const hit = [];
  for (const x of all) { const r = queryRow(x, idx, c, access); if (pred(r)) hit.push({ x, r }); }
  if (cmp) hit.sort((a, b) => cmp(a.r, b.r) || (b.r.updatedAt - a.r.updatedAt));
  else hit.sort((a, b) => (PRIO_RANK[a.x.priority] ?? 9) - (PRIO_RANK[b.x.priority] ?? 9) || ((a.x.dueAt ?? Infinity) - (b.x.dueAt ?? Infinity)) || (b.r.updatedAt - a.r.updatedAt));
  const rows = hit.map(({ x }) => ({ ...summary(x, idx, access, now), writable: canEdit(x, access) }));
  return { total: rows.length, all: all.length, offset, limit, rows: rows.slice(offset, offset + limit), query: { clauses: parsed.clauses, order: parsed.order, orderStart: parsed.orderStart } };
}

/**
 * 통계 — 상태별·우선순위별 열린 건수, 미할당·기한 초과·오늘/내일 마감, 담당자별 부하(열린·진행·검토·초과), 최근 7일 완료.
 * 전부 '열린 이슈' 기준이다(완료는 세지 않는다).
 */
/**
 * 기한까지 남은 날(포탈 날짜 — util/dayKey 하나). 오늘이 기한이면 0, 지났으면 음수, 기한이 없거나 못 읽으면 null.
 * 감사 A4-03: '기한 초과' 를 시각(dueAt < now)으로 보던 서버와 날짜로 보던 화면(issueText.js dueInfo)이 기한 당일에 어긋났다 —
 * 기한은 날짜로 고르므로(화면은 그 날 09:00 로 저장) 날짜 기준 하나로 맞춘다. 화면과의 대조는 test/issuesAudit2871.test.js.
 */
export function dueDays(dueAt, now = Date.now()) {
  const t = numOrNull(dueAt);
  if (t == null) return null;
  const a = dayKey(t); const b = dayKey(now);
  if (!a || !b) return null;
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS);
}
/** 화면 dueInfo 의 '곧'(오늘·내일·모레)과 같은 날 수. */
export const DUE_SOON_DAYS = 2;

export function issueStats({ now = Date.now(), access = FULL_ACCESS } = {}) {
  const all = load().issues.filter((x) => canSee(x, access));
  const open = all.filter(isOpen);
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  const byPriority = Object.fromEntries(PRIORITIES.map((p) => [p, 0]));
  const byAssignee = new Map();
  let unassigned = 0; let overdue = 0; let dueSoon = 0; let blocked = 0;
  for (const x of open) {
    byStatus[x.status] = (byStatus[x.status] || 0) + 1;
    byPriority[x.priority] = (byPriority[x.priority] || 0) + 1;
    const dd = dueDays(x.dueAt, now);
    const late = dd != null && dd < 0;
    if (late) overdue += 1; else if (dd != null && dd <= DUE_SOON_DAYS) dueSoon += 1;
    if (x.blocked) blocked += 1;
    if (!x.assignee) { unassigned += 1; continue; }
    let a = byAssignee.get(x.assignee);
    if (!a) { a = { assignee: x.assignee, open: 0, progress: 0, review: 0, overdue: 0, p0: 0 }; byAssignee.set(x.assignee, a); }
    a.open += 1; if (x.status === 'progress') a.progress += 1; if (x.status === 'review') a.review += 1; if (late) a.overdue += 1; if (x.priority === 'p0') a.p0 += 1;
  }
  byStatus.done = all.filter((x) => !isOpen(x) && x.closedAt && now - x.closedAt <= 7 * 24 * 3600_000).length;
  return {
    open: open.length, total: all.length, byStatus, byPriority, unassigned, overdue, dueSoon, blocked,
    byAssignee: [...byAssignee.values()].sort((a, b) => b.open - a.open || a.assignee.localeCompare(b.assignee)),
    doneLast7d: byStatus.done,
  };
}

/** 담당자 후보에 더할 이름 — 이슈에 이미 보이는 담당자·보고자·관찰자(AD 계정처럼 목록에 없는 사람도 다시 고를 수 있게). */
export function knownNames(access = FULL_ACCESS) {
  const s = new Set();
  for (const x of load().issues) {
    if (!canSee(x, access)) continue;
    if (x.assignee) s.add(x.assignee); if (x.reporter) s.add(x.reporter);
    for (const n of Array.isArray(x.watchers) ? x.watchers : []) s.add(n);
  }
  return [...s].sort();
}

/* ───── 변경 ───── */
const HIST_VAL = 80;
const hv = (v) => (v == null || v === '' ? '' : capStr(typeof v === 'string' ? v : JSON.stringify(v), HIST_VAL));
/** 이력 한 줄을 더한다 — 상한을 넘으면 오래된 것부터 지우고 지운 수를 센다(조용히 사라지지 않게). */
function withHistory(x, entries) {
  if (!entries.length) return x;
  let history = [...historyOf(x), ...entries];
  let dropped = Number(x.historyDropped) || 0;
  if (history.length > LIMITS.historyMax) { dropped += history.length - LIMITS.historyMax; history = history.slice(history.length - LIMITS.historyMax); }
  return { ...x, history, ...(dropped ? { historyDropped: dropped } : {}) };
}
function assertRoom(c, nextIssue, prevId = null) {
  const max = issuesMaxBytes();
  const next = c.bytes - (prevId ? (c.sizes.get(prevId) || 0) : 0) + jsonBytes(nextIssue);
  if (next > max) throw limitError('issues-full', { bytes: c.bytes, max });
}
function replace(c, x, entries, user, { touch = true } = {}) {
  const i = c.issues.findIndex((y) => y.id === x.id);
  if (i < 0) throw notFound();
  const now = Date.now();
  const y = withHistory({ ...x, ...(touch ? { updatedAt: Math.max(now, (x.updatedAt || 0) + 1), updatedBy: user } : {}) }, entries);
  assertRoom(c, y, x.id);
  const issues = [...c.issues]; issues[i] = y;
  commit(issues, { changed: y });
  return y;
}

/**
 * @param {object} body
 * @param {string} user
 * @param {{ access?: object, known?: Set<string>|null, auto?: { assignee: string, reason: string }|null, requestOnly?: boolean }} [opts]
 */
export function createIssue(body, user, { access = FULL_ACCESS, known = null, auto = null, requestOnly = false, origin = null } = {}) {
  const c = load();
  if (c.issues.length >= LIMITS.issueMax) throw limitError(`이슈는 ${LIMITS.issueMax}건까지 보관합니다 — 관리자에게 지난 이슈 정리를 요청하세요`);
  if (requestOnly) {
    // 요청 등록이 상한을 채워 운영자가 장애 이슈를 못 만드는 일을 막는다(감사 A3-02 — 실서버에서 1~2분에 채울 수 있었다).
    if (c.issues.length >= LIMITS.issueMax - LIMITS.requestReserve) throw limitError(`요청 등록 몫이 찼습니다(전체 ${LIMITS.issueMax}건 중 ${LIMITS.requestReserve}건은 운영자 몫) — 관리자에게 지난 이슈 정리를 요청하세요`);
    const mine = c.issues.filter((x) => x.reporter === user && x.type === 'request' && isOpen(x)).length;
    if (mine >= LIMITS.requestOpenPerUser) throw limitError(`열린 요청은 한 사람당 ${LIMITS.requestOpenPerUser}건까지입니다 — 처리된 뒤 다시 등록하세요`);
  }
  const now = Date.now();
  const b = requestOnly
    ? { title: body?.title, body: body?.body, priority: body?.priority, dueAt: body?.dueAt, labels: body?.labels, component: body?.component, vcenterId: body?.vcenterId, type: 'request', status: 'backlog' }
    : (body || {});
  const vcenterId = vcenterField(b.vcenterId, access, known);
  const type0 = enumField(b.type, TYPES, 'type', 'task');
  // v2.882 계층 · 스프린트(요청 등록은 받지 않는다 — 위 b 에 없다)
  const parentKey = parentField(b.parentKey, { key: '', type: type0, vcenterId }, c.issues, access);
  const sprintId = sprintField(b.sprintId);
  let assignee = nameField(b.assignee, 'assignee');
  const autoAssignee = !assignee && auto?.assignee ? nameField(auto.assignee, 'assignee') : '';
  if (autoAssignee) assignee = autoAssignee;
  const status = enumField(b.status, STATUSES, 'status', 'backlog');
  if (status === 'progress' && !assignee) throw fieldError('status', '진행 중으로 두려면 담당자가 있어야 합니다');
  const num = c.nextSeq;
  const x = {
    id: newId(), key: `${KEY_PREFIX}-${num}`, num,
    type: type0,
    title: text(b.title, LIMITS.title, 'title', { required: true }),
    parentKey, sprintId,
    body: text(b.body, LIMITS.body, 'body'),
    status, blocked: null, vcenterId,
    priority: enumField(b.priority, PRIORITIES, 'priority', 'p2'),
    assignee, reporter: user,
    watchers: watchersField(b.watchers), labels: labelsField(b.labels), component: text(b.component, LIMITS.component, 'component'),
    dueAt: timeField(b.dueAt, 'dueAt'),
    // v2.888 C-3(요청 등록은 받지 않는다 — b 에 없다)
    ...(requestOnly ? {} : { estimateMin: estimateField(b.estimateMin), fixVersion: versionField(b.fixVersion, 'fixVersion'), affectsVersion: versionField(b.affectsVersion, 'affectsVersion') }),
    worklog: [],
    createdAt: now, createdBy: user, updatedAt: now, updatedBy: user, closedAt: status === 'done' ? now : null,
    comments: [],
    ...(origin ? { origin: originField(origin) } : {}),
    history: [
      { at: now, by: user, field: 'created', from: '', to: `${KEY_PREFIX}-${num}`, ...(requestOnly ? { note: '요청 등록' } : origin ? { note: originNote(origin) } : {}) },
      ...(assignee ? [{ at: now, by: user, field: 'assignee', from: '', to: assignee, ...(autoAssignee ? { note: `자동 할당: ${capStr(String(auto.reason || ''), 80)}` } : {}) }] : []),
      ...(parentKey ? [{ at: now, by: user, field: 'parent', from: '', to: parentKey }] : []),
      ...(sprintId ? [{ at: now, by: user, field: 'sprint', from: '', to: sprintId, note: capStr(sprintNameOf(sprintId), 60) }] : []),
    ],
  };
  assertRoom(c, x);
  commit([...c.issues, x], { changed: x, nextSeq: num + 1 });
  emit({ type: 'created', actor: user, issue: evIssue(x), auto: !!autoAssignee });
  return { ...viewIssue(x, user, access), writable: canEdit(x, access) };
}

/** 제목·본문·유형·우선순위·기한·라벨·컴포넌트·관찰자 — 보낸 칸만 바꾼다. 상태·담당자·보류는 전용 함수로. */
export function updateIssue(key, body, user, { access = FULL_ACCESS, known = null } = {}) {
  const c = load();
  const x = findFor(key, access, { write: true });
  const b = body || {};
  const has = (k) => Object.hasOwn(b, k);
  const entries = [];
  const now = Date.now();
  const next = { ...x };
  const set = (field, val, { hist = true } = {}) => {
    const before = x[field]; const same = JSON.stringify(before ?? null) === JSON.stringify(val ?? null);
    if (same) return;
    next[field] = val;
    if (hist) entries.push({ at: now, by: user, field, from: hv(before), to: hv(val) });
  };
  const idx = treeIndex(c.issues);
  const myKids = idx.kids.get(x.key) || [];
  if (has('title')) set('title', text(b.title, LIMITS.title, 'title', { required: true }));
  if (has('body')) set('body', text(b.body, LIMITS.body, 'body'), { hist: false });
  if (has('type')) {
    const t = enumField(b.type, TYPES, 'type');
    // v2.882: 에픽 ↔ 다른 유형 — 층이 바뀌므로 상위 · 자식이 있으면 막는다(묶음을 먼저 풀게)
    if (t !== x.type && (t === 'epic' || x.type === 'epic')) {
      if (t === 'epic' && (x.parentKey || myKids.length)) throw fieldError('type', '상위나 하위 작업이 있는 이슈는 에픽으로 바꿀 수 없습니다 — 먼저 묶음을 푸세요');
      if (x.type === 'epic' && myKids.length) throw fieldError('type', '이슈가 담긴 에픽은 다른 유형으로 바꿀 수 없습니다 — 먼저 이슈를 빼세요');
    }
    set('type', t);
  }
  if (has('priority')) set('priority', enumField(b.priority, PRIORITIES, 'priority'));
  if (has('dueAt')) set('dueAt', timeField(b.dueAt, 'dueAt'));
  if (has('labels')) set('labels', labelsField(b.labels));
  if (has('component')) set('component', text(b.component, LIMITS.component, 'component'));
  if (has('watchers')) set('watchers', watchersField(b.watchers));
  // v2.888 C-3 — 예상 · 수정/영향 버전
  if (has('estimateMin')) { const v = estimateField(b.estimateMin); if (v !== (Number.isInteger(x.estimateMin) ? x.estimateMin : null)) { next.estimateMin = v; entries.push({ at: now, by: user, field: 'estimate', from: x.estimateMin != null ? minutesText(x.estimateMin) : '', to: v != null ? minutesText(v) : '' }); } }
  if (has('fixVersion')) set('fixVersion', versionField(b.fixVersion, 'fixVersion'));
  if (has('affectsVersion')) set('affectsVersion', versionField(b.affectsVersion, 'affectsVersion'));
  // 감사 A1-05·A2-01: 값이 그대로면 다시 검사하지 않는다 — 등록에서 빠진 vCenter 의 이슈도 제목·본문 수정은 저장된다(법인을 바꿀 때만 검사).
  if (has('vcenterId') && !(typeof b.vcenterId === 'string' && b.vcenterId.trim() === (x.vcenterId || ''))) {
    const v = vcenterField(b.vcenterId, access, known);
    // v2.882: 법인이 바뀌면 묶음 규칙(같은 법인 · 공용 에픽)이 깨지지 않는지 본다
    const par = x.parentKey ? idx.byKey.get(x.parentKey) : null;
    if (par && (par.type !== 'epic' || par.vcenterId) && (par.vcenterId || '') !== v) throw fieldError('vcenterId', '상위와 법인이 달라집니다 — 먼저 상위에서 빼세요');
    if (myKids.some((k) => x.type === 'epic' ? (v && (k.vcenterId || '') !== v) : (k.vcenterId || '') !== v)) throw fieldError('vcenterId', '담긴 이슈 · 하위 작업과 법인이 달라집니다');
    set('vcenterId', v);
  }
  if (has('parentKey')) {
    const pk = parentField(b.parentKey, { key: x.key, type: next.type, vcenterId: next.vcenterId || '' }, c.issues, access);
    if (pk !== (x.parentKey || '')) { next.parentKey = pk; entries.push({ at: now, by: user, field: 'parent', from: x.parentKey || '', to: pk }); }
  }
  if (has('sprintId')) {
    const sp = sprintField(b.sprintId);
    if (sp !== (x.sprintId || '')) { next.sprintId = sp; entries.push({ at: now, by: user, field: 'sprint', from: x.sprintId || '', to: sp, note: capStr(`${sprintNameOf(x.sprintId) || '백로그'} → ${sprintNameOf(sp) || '백로그'}`, 120) }); }
  }
  if (has('body') && x.body !== next.body) entries.push({ at: now, by: user, field: 'body', from: '', to: '(본문 수정)' });
  const changed = entries.length > 0 || (has('body') && x.body !== next.body);
  if (!changed) return viewIssue(x, user, access);
  return viewIssue(replace(c, next, entries, user), user, access); // v2.888: 범위를 넘긴다(빠지면 연결 · 에픽이 범위 밖까지 보였다)
}

/* ───── v2.888 C-3 작업 기록(시간 추적) ───── */
const ON_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 작업 기록 더하기 — 쓰기 범위 · 분(1~1440 정수) · 한 날(YYYY-MM-DD, 빈 값 = 오늘 · 미래 불가) · 메모. 이슈마다 200개(넘으면 409). */
export function addWorklog(key, body, user, { access = FULL_ACCESS, now = Date.now() } = {}) {
  const c = load();
  const x = findFor(key, access, { write: true });
  const b = body || {};
  const minutes = Number(b.minutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > LIMITS.worklogMaxMin) throw fieldError('minutes', `1~${LIMITS.worklogMaxMin} 분 정수여야 합니다(한 줄은 하루까지)`);
  const today = dayKey(now);
  let on = typeof b.on === 'string' ? b.on.trim() : '';
  if (!on) on = today;
  if (!ON_RE.test(on) || !Number.isFinite(Date.parse(`${on}T00:00:00Z`)) || new Date(`${on}T00:00:00Z`).toISOString().slice(0, 10) !== on) throw fieldError('on', '날짜(YYYY-MM-DD)를 읽지 못했습니다');
  if (on > today) throw fieldError('on', '앞날의 작업은 기록할 수 없습니다');
  const list = worklogOf(x);
  if (list.length >= LIMITS.worklogMax) throw limitError(`작업 기록은 이슈마다 ${LIMITS.worklogMax}개까지입니다 — 하루 단위로 묶어 적어 주세요`);
  const w = { id: newId(), by: user, at: now, on, minutes, note: text(b.note, LIMITS.worklogNote, 'note') };
  const next = { ...x, worklog: [...list, w] };
  const y = replace(c, next, [{ at: now, by: user, field: 'worklog', from: '', to: `+${minutesText(minutes)}`, ...(w.note ? { note: capStr(w.note, 80) } : {}) }], user);
  return viewIssue(y, user, access);
}
/** 작업 기록 지우기 — 적은 사람 본인 또는 전체 범위 관리자(isMod). 쓰기 범위가 있어야 한다. */
export function removeWorklog(key, id, user, { access = FULL_ACCESS, isMod = false } = {}) {
  const c = load();
  const x = findFor(key, access, { write: true });
  const list = worklogOf(x);
  const w = list.find((v) => v.id === id);
  if (!w) { const e = new Error('없는 작업 기록입니다'); e.status = 404; throw e; }
  if (!isMod && w.by !== user) throw forbidden('작업 기록은 적은 사람이나 관리자만 지울 수 있습니다');
  const now = Date.now();
  const y = replace(c, { ...x, worklog: list.filter((v) => v.id !== id) }, [{ at: now, by: user, field: 'worklog', from: `${minutesText(w.minutes)}(${w.by})`, to: '' }], user);
  return viewIssue(y, user, access);
}

/** 상태 전이. progress 는 담당자 필수 · done 은 closedAt · done 에서 나오면 closedAt 해제. 같은 상태면 그대로. */
export function setStatus(key, status, user, { access = FULL_ACCESS, closeChildren = false, ignoreBlockers = false, note = '' } = {}) {
  const c = load();
  const x = findFor(key, access, { write: true });
  const s = enumField(status, STATUSES, 'status');
  if (s === x.status) return viewIssue(x, user, access);
  if (s === 'progress' && !x.assignee) throw fieldError('status', '진행 중으로 옮기려면 담당자가 있어야 합니다 — 먼저 할당하세요');
  // v2.882: 완료되지 않은 자식(하위 작업 · 에픽의 이슈)이 남아 있으면 묻는다 — closeChildren 이면 한꺼번에 완료(자식마다 쓰기 범위 검사)
  if (s === 'done' && !ignoreBlockers) {
    // v2.883: 이 이슈를 막고 있는 열린 이슈가 있으면 묻는다(범위 없이 센다 — 볼 수 없는 것은 수만 밝힌다)
    const blockers = relationsOf(x, treeIndex(c.issues), null).filter((l) => l.type === 'blockedBy' && l.open);
    if (blockers.length) {
      const visible = blockers.filter((l) => { const y = load().issues.find((q) => q.key === l.key); return y && canSee(y, access); });
      throw limitError(`이 이슈를 막고 있는 열린 이슈가 ${blockers.length}건 있습니다${blockers.length > visible.length ? `(볼 수 없는 ${blockers.length - visible.length}건 포함)` : ''} — 그래도 완료할지 확인하세요`,
        { code: 'open-blockers', blockers: visible.slice(0, 30).map((l) => ({ key: l.key, title: l.title, status: l.status })), hidden: blockers.length - visible.length });
    }
  }
  if (s === 'done') {
    const open = (treeIndex(c.issues).kids.get(x.key) || []).filter(isOpen);
    if (open.length && !closeChildren) {
      throw limitError(`완료되지 않은 ${x.type === 'epic' ? '이슈가' : '하위 작업이'} ${open.length}건 남아 있습니다 — 한꺼번에 완료하거나 취소하세요`,
        { code: 'open-children', children: open.filter((k) => canSee(k, access)).slice(0, 50).map((k) => ({ key: k.key, title: k.title, status: k.status })) });
    }
    if (open.length) {
      const denied = open.filter((k) => !canSee(k, access) || !canEdit(k, access));
      if (denied.length) throw forbidden(`쓰기 범위 밖 ${denied.length}건이 있어 한꺼번에 완료할 수 없습니다`);
      for (const k of open) {
        const at = Date.now();
        const cur = load().issues.find((y) => y.id === k.id);
        const yk = replace(load(), { ...cur, status: 'done', closedAt: at }, [{ at, by: user, field: 'status', from: cur.status, to: 'done', note: `상위 ${x.key} 완료와 함께` }], user);
        emit({ type: 'status', actor: user, issue: evIssue(yk), from: cur.status, to: 'done' });
      }
    }
  }
  const now = Date.now();
  const fresh = load().issues.find((y0) => y0.id === x.id) || x;
  const next = { ...fresh, status: s, closedAt: s === 'done' ? now : null };
  const y = replace(load(), next, [{ at: now, by: user, field: 'status', from: x.status, to: s, ...(note ? { note: capStr(String(note), 200) } : {}) }], user);
  emit({ type: 'status', actor: user, issue: evIssue(y), from: x.status, to: s });
  return viewIssue(y, user, access);
}

/**
 * v2.908 자동화 규칙 '하위 전부 완료 → 상위 검토' 의 판정(서버 내부 — 범위 없음). 이 이슈의 상위가 있고, 그 상위의 자식이 모두 완료이며,
 * 상위가 아직 검토 · 완료가 아니면 상위 키 — 아니면 ''.
 */
export function parentReadyForReview(childKey) {
  const c = load();
  const x = c.issues.find((i) => i.key === childKey);
  const pk = x?.parentKey || '';
  if (!pk) return '';
  const ix = treeIndex(c.issues);
  const parent = ix.byKey.get(pk);
  if (!parent || parent.status === 'review' || parent.status === 'done') return '';
  const kids = ix.kids.get(pk) || [];
  return kids.length && kids.every((k) => k.status === 'done') ? pk : '';
}

/** 담당자 변경('' = 할당 해제). 재할당 이력 + 선택 사유. 같은 담당자면 그대로. */
export function assignIssue(key, assignee, user, { reason = '', access = FULL_ACCESS } = {}) {
  const c = load();
  const x = findFor(key, access, { write: true });
  const a = nameField(assignee, 'assignee');
  if (a === (x.assignee || '')) return viewIssue(x, user, access);
  // v2.870 감사 A2-05: '진행 중 ⇒ 담당자' 불변조건(setStatus · createIssue 와 같은 규칙) — 할당 해제(일괄 포함)가 담당자 없는 진행 중 이슈를 만들지 않게
  if (!a && x.status === 'progress') throw fieldError('assignee', '진행 중 이슈의 담당자는 비울 수 없습니다 — 상태를 먼저 바꾸세요');
  const why = text(reason, LIMITS.blockReason, 'reason');
  const now = Date.now();
  const next = { ...x, assignee: a };
  const y = replace(c, next, [{ at: now, by: user, field: 'assignee', from: x.assignee || '', to: a, ...(why ? { note: why } : {}) }], user);
  emit({ type: 'assigned', actor: user, issue: evIssue(y), from: x.assignee || '', to: a });
  return viewIssue(y, user, access);
}

/** 여러 이슈에 같은 담당자 — 결과는 키마다 밝힌다(없는 키·오류는 건너뛰고 사유를 적는다 — 조용히 넘기지 않는다). */
export function bulkAssign(keys, assignee, user, { access = FULL_ACCESS } = {}) {
  if (!Array.isArray(keys)) throw fieldError('keys', '배열이어야 합니다');
  if (keys.length > LIMITS.bulkMax) throw fieldError('keys', `한 번에 ${LIMITS.bulkMax}건까지입니다`);
  const a = nameField(assignee, 'assignee');
  const results = [];
  for (const k of keys) {
    if (typeof k !== 'string' || !KEY_RE.test(k)) { results.push({ key: String(k).slice(0, 20), ok: false, reason: '키 형식이 아닙니다' }); continue; }
    try { assignIssue(k, a, user, { access }); results.push({ key: k, ok: true }); } catch (e) { results.push({ key: k, ok: false, reason: e.message }); }
  }
  return { assignee: a, results, done: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
}

/** 보류 표지 — on 이면 사유 필수. off 면 해제. */
export function setBlocked(key, on, user, { reason = '', access = FULL_ACCESS } = {}) {
  const c = load();
  const x = findFor(key, access, { write: true });
  if (typeof on !== 'boolean') throw fieldError('on', 'true 또는 false 여야 합니다');
  const now = Date.now();
  if (on) {
    const why = text(reason, LIMITS.blockReason, 'reason', { required: true });
    const next = { ...x, blocked: { reason: why, at: now, by: user } };
    return viewIssue(replace(c, next, [{ at: now, by: user, field: 'blocked', from: x.blocked ? x.blocked.reason : '', to: why }], user), user, access);
  }
  if (!x.blocked) return viewIssue(x, user, access);
  const next = { ...x, blocked: null };
  return viewIssue(replace(c, next, [{ at: now, by: user, field: 'blocked', from: x.blocked.reason, to: '' }], user), user, access);
}

/** 관찰 켜기/끄기(본인). 상태를 명시한다(재전송이 두 번 바꾸지 않게). 이력·갱신 시각은 건드리지 않는다. */
export function setWatch(key, user, on, { access = FULL_ACCESS } = {}) {
  if (!user) throw forbidden('로그인한 사용자만 관찰할 수 있습니다');
  if (typeof on !== 'boolean') throw fieldError('on', 'true 또는 false 여야 합니다');
  const c = load();
  const x = findFor(key, access); // 관찰은 본인 표지라 조회 범위면 된다
  const cur = Array.isArray(x.watchers) ? x.watchers : [];
  if (cur.includes(user) === on) return viewIssue(x, user, access);
  if (on && cur.length >= LIMITS.watcherMax) throw limitError(`관찰자는 ${LIMITS.watcherMax}명까지입니다`);
  const next = { ...x, watchers: on ? [...cur, user] : cur.filter((n) => n !== user) };
  return viewIssue(replace(c, next, [], user, { touch: false }), user, access);
}

/**
 * v2.907 댓글에서 언급한 사람을 관찰자로(시안 docs/design/wiki-mention ⑥-7 · 결정 5 — 이슈 댓글의 선택). 이슈 쓰기 범위가 필요하다(댓글과 같은 판정).
 * 그 법인을 볼 수 없는 사람(canSee) · 이미 관찰자인 사람은 건너뛰고, 상한(watcherMax)을 넘는 만큼은 빼고 센다 — 조용히 버리지 않는다.
 * @returns {{ added:string[], skipped:{name:string,why:string}[] }}
 */
export function addWatchers(key, names, user, { access = FULL_ACCESS, canSee = () => true } = {}) {
  const c = load();
  const x = findFor(key, access, { write: true });
  const cur = Array.isArray(x.watchers) ? [...x.watchers] : [];
  const added = []; const skipped = [];
  for (const n0 of Array.isArray(names) ? names.slice(0, 10) : []) {
    const n = String(n0 || '').trim();
    if (!n || cur.includes(n)) continue;
    if (!canSee(n, x.vcenterId || '')) { skipped.push({ name: n, why: 'out-of-scope' }); continue; }
    if (cur.length >= LIMITS.watcherMax) { skipped.push({ name: n, why: 'limit' }); continue; }
    cur.push(n); added.push(n);
  }
  if (added.length) replace(c, { ...x, watchers: cur }, [], user, { touch: false });
  return { added, skipped };
}

/**
 * 진행률·진행 메모(v2.871 — 사용자 요청 '진행상태를 다른 사람이 볼 수 있게'). pct 는 0~100 정수 · null 이면 '보고 없음' 으로 되돌린다.
 * 메모는 300자. 쓰기 범위가 필요하다(조회 밖 404 → 쓰기 밖 403). 이력·이벤트에 남는다. 값이 그대로면 아무것도 하지 않는다.
 */
export function setProgress(key, body, user, { access = FULL_ACCESS } = {}) {
  const c = load();
  const x = findFor(key, access, { write: true });
  const b = body || {};
  // v2.882: 자식이 있으면 진행률은 자식 완료 비율로 자동 — 직접 입력은 잠근다(메모는 그대로 쓸 수 있다)
  if (Object.hasOwn(b, 'progress') && (treeIndex(c.issues).kids.get(x.key) || []).length) {
    throw limitError('하위 작업이 있는 이슈의 진행률은 하위 작업 완료 비율로 자동 계산됩니다 — 직접 입력할 수 없습니다', { code: 'progress-auto' });
  }
  let pct = Number.isInteger(x.progress) ? x.progress : null;
  if (Object.hasOwn(b, 'progress')) {
    if (b.progress === null || b.progress === '') pct = null;
    else {
      const n = typeof b.progress === 'number' ? b.progress : (/^\d{1,3}$/.test(String(b.progress)) ? Number(b.progress) : NaN);
      if (!Number.isInteger(n) || n < 0 || n > 100) throw fieldError('progress', '0~100 의 정수여야 합니다');
      pct = n;
    }
  }
  const note = Object.hasOwn(b, 'note') ? text(b.note, LIMITS.progressNote, 'note') : (x.progressNote || '');
  const prevPct = Number.isInteger(x.progress) ? x.progress : null;
  if (pct === prevPct && note === (x.progressNote || '')) return viewIssue(x, user, access);
  const now = Date.now();
  const next = { ...x, progress: pct, progressNote: note, progressAt: now, progressBy: user };
  const y = replace(c, next, [{ at: now, by: user, field: 'progress', from: prevPct == null ? '' : String(prevPct), to: pct == null ? '' : String(pct), ...(note ? { note: capStr(note, 120) } : {}) }], user);
  emit({ type: 'progress', actor: user, issue: evIssue(y), from: prevPct, to: pct, note: capStr(note, 160) });
  return { ...viewIssue(y, user, access), writable: canEdit(y, access) };
}

/**
 * 팀 활동 피드(v2.871) — 이 사용자가 볼 수 있는 이슈의 최근 변경(할당·상태·진행·보류·생성)과 댓글을 최신순으로.
 * 비용을 묶으려고 이슈마다 최근 이력 20건 · 댓글 5건만 훑는다(이슈 2,000건이면 5만 항목). 본문·댓글 전문은 싣지 않는다(120자 발췌).
 * @returns {{ items: object[], truncated: boolean }}
 */
export function activityFeed({ access = FULL_ACCESS, limit = 100, since = 0 } = {}) {
  const lim = Math.max(1, Math.min(LIMITS.activityMax, Math.trunc(Number(limit)) || 100));
  const out = [];
  const FIELDS = new Set(['created', 'assignee', 'status', 'progress', 'blocked', 'priority', 'dueAt', 'parent', 'sprint']);
  const all = load().issues;
  const idx = access?.read ? treeIndex(all) : null;
  for (const x of all) {
    if (!canSee(x, access)) continue;
    const base = { key: x.key, title: capStr(x.title || '', 120), vcenterId: x.vcenterId || '' };
    const hist = historyOf(x).slice(-20);
    for (const h of (idx ? historyFor(hist, idx, access) : hist)) { // v2.904 점검 P-2
      if (!FIELDS.has(h.field) || !(h.at > since)) continue;
      out.push({ ...base, at: h.at, by: h.by || '', field: h.field, from: h.from ?? '', to: h.to ?? '', note: h.note ? capStr(String(h.note), 120) : '' });
    }
    for (const cm of commentsOf(x).slice(-5)) {
      if (!(cm.createdAt > since)) continue;
      out.push({ ...base, at: cm.createdAt, by: cm.author || '', field: 'comment', from: '', to: capStr(String(cm.body || ''), 120), note: '' });
    }
  }
  out.sort((a, b) => b.at - a.at);
  return { items: out.slice(0, lim), truncated: out.length > lim, limit: lim };
}

/**
 * 댓글 달기. auto=true 는 서버 내부 자동 등록(알람 · 파트 장애)만 — 자동 댓글은 autoCommentMax 로 따로 세고 사람 몫(commentMax)은 사람 댓글만 센다
 * (v2.927 점검 B1-03 — 깜빡이는 알람의 '다시 발생' · '해소' 댓글이 200개를 채워 담당자가 409 로 댓글을 못 달았다).
 */
export function addComment(key, body, user, { access = FULL_ACCESS, auto = false } = {}) {
  const c = load();
  const x = findFor(key, access, { write: true });
  const comments = commentsOf(x);
  const autoN = comments.filter(isAutoComment).length;
  if (auto && autoN >= LIMITS.autoCommentMax) throw limitError(`자동 댓글은 이슈마다 ${LIMITS.autoCommentMax}개까지입니다(사람 댓글과 따로 셉니다)`, { code: 'auto-comments-full' });
  if (!auto && comments.length - autoN >= LIMITS.commentMax) throw limitError(`댓글은 이슈마다 ${LIMITS.commentMax}개까지입니다`);
  const cm = { id: newId(), author: user, body: text(body?.body, LIMITS.commentBody, 'body', { required: true }), createdAt: Date.now(), auto: !!auto }; // auto:false 도 적는다 — 이름 판정(옛 자동 댓글)이 새 사람 댓글에 걸리지 않게
  const next = { ...x, comments: [...comments, cm] };
  const y = replace(c, next, [], user);
  emit({ type: 'comment', actor: user, issue: evIssue(y), commentId: cm.id, excerpt: capStr(cm.body, 200), mentions: mentionsOf(cm.body) });
  return cm;
}

/**
 * v2.907 댓글 고치기(기능 추천 1) — 쓴 사람만 · 이슈 쓰기 범위(댓글과 같은 판정). 옛 본문은 최근 5개까지(editedAt · edits · prev).
 * 이력에 남기지 않는다(본문 이력과 같다) · 알림은 새로 언급한 사람에게만(ev.edit — 담당 · 보고 · 관찰자에게 다시 가지 않는다).
 */
export function editComment(key, commentId, body, user, { access = FULL_ACCESS } = {}) {
  const c = load();
  const x = findFor(key, access, { write: true });
  const comments = commentsOf(x);
  const cm = comments.find((q) => q.id === commentId);
  if (!cm) throw notFound();
  if (cm.author !== user) throw forbidden('댓글은 쓴 사람만 고칠 수 있습니다');
  const nextBody = text(body?.body, LIMITS.commentBody, 'body', { required: true });
  if (nextBody === cm.body) return commentOut(cm);
  const edited = { ...cm, body: nextBody, editedAt: Date.now(), edits: (Number(cm.edits) || 0) + 1, prev: [...(Array.isArray(cm.prev) ? cm.prev : []), { at: cm.editedAt || cm.createdAt, body: cm.body }].slice(-5) };
  const y = replace(c, { ...x, comments: comments.map((q) => (q.id === commentId ? edited : q)) }, [], user);
  const before = new Set(mentionsOf(cm.body));
  const fresh = mentionsOf(nextBody).filter((m) => !before.has(m));
  if (fresh.length) emit({ type: 'comment', edit: true, actor: user, issue: evIssue(y), commentId, excerpt: capStr(nextBody, 200), mentions: fresh });
  return commentOut(edited); // v2.927(점검 B1-01): 작성자 응답에도 prev 를 싣지 않는다(viewIssue 와 같은 모양)
}

/** 댓글 삭제 — 작성자 본인 또는 관리자(isMod). */
export function deleteComment(key, commentId, user, { isMod = false, access = FULL_ACCESS } = {}) {
  const c = load();
  const x = findFor(key, access, { write: true });
  const comments = commentsOf(x);
  const cm = comments.find((y) => y.id === commentId);
  if (!cm) throw notFound();
  if (!isMod && cm.author !== user) throw forbidden('작성자 본인이나 관리자만 지울 수 있습니다');
  replace(c, { ...x, comments: comments.filter((y) => y.id !== commentId) }, [], user, { touch: false });
  return cm;
}

/** 이슈 삭제 — 보고자 본인 또는 관리자(isMod). 댓글·이력이 함께 사라진다. */
export function deleteIssue(key, user, { isMod = false, access = FULL_ACCESS } = {}) {
  const c = load();
  const x = findFor(key, access, { write: true });
  if (!isMod && x.reporter !== user) throw forbidden('보고자 본인이나 관리자만 지울 수 있습니다');
  if ((treeIndex(c.issues).kids.get(x.key) || []).length) throw fieldError('key', `${x.type === 'epic' ? '담긴 이슈가' : '하위 작업이'} 있어 지울 수 없습니다 — 먼저 빼거나 지우세요`);
  commit(c.issues.filter((y) => y.id !== x.id), { removedId: x.id });
  // v2.904(점검 S-2 — 재현): 지운 이슈를 가리키는 남의 연결도 정리한다 — 화면에는 안 보이면서 연결 상한(30)을 차지하고 지울 수도 없었다
  for (const y of load().issues) {
    const dead = linksOf(y).filter((l) => l.key === x.key);
    if (!dead.length) continue;
    const at = Date.now();
    replace(load(), { ...y, links: linksOf(y).filter((l) => l.key !== x.key) }, dead.map((l) => ({ at, by: user, field: 'link', from: `${l.type} ${x.key}`, to: '', note: '상대 이슈를 지움' })), user, { touch: false });
  }
  return summary(x, null, access);
}
