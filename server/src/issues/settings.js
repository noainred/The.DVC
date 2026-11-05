/**
 * issues/settings.js — 이슈 트래커 설정(v2.871): 자동 할당 규칙 · 알림 · 사람별 메일 주소. 파일 `issue-settings.json`.
 *
 * 사용자 선택(2026-11-04 '프로그램 개선' — 이슈 알림(메일·Slack) · 이슈 자동 할당 규칙):
 *   · 자동 할당 — 담당자를 비우고 만든 이슈에 담당자를 정한다. 순서: ① 컴포넌트 기본 담당자(이름이 같은 컴포넌트, 대소문자 무시)
 *     ② 순번 후보(pool) 중 열린 이슈가 가장 적은 사람(같으면 이름순). 후보가 로컬 계정이고 범위가 지정돼 있으면 그 이슈의 법인을 볼 수
 *     있는 사람만 고른다(볼 수 없는 이슈를 맡기지 않는다). 꺼져 있으면 제안만 한다(새 이슈 창의 '제안').
 *   · 알림 — 이벤트(할당 · 상태 · 댓글/멘션 · 기한)를 사람별 메일(people 의 주소)과 팀 채팅(설정 › 알림의 Slack·웹훅·Teams)으로.
 *     발송은 issues/notify.js. 계정에는 메일 주소 칸이 없어서 이 설정이 사람 → 주소 표를 갖는다(관리자가 적는다 — 비밀 아님).
 *   · 손상 파일은 보존하고 기본값(전부 꺼짐)으로 읽는다 — 화면이 `loadError` 로 그 사실을 말한다(조용히 기본값이 되지 않게).
 *   · 상한은 거부다: 컴포넌트 규칙 100 · 후보 100 · 사람 500 · 이름 64자 · 메일 254자.
 * 저장은 라우트가 관리자 + 전체 범위로 막는다(전 법인 공용 설정).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt, safeLoadText } from '../util/atomicWrite.js';
import { capStr } from '../util/capStr.js';
import { makeLoadError } from '../util/registryCore.js';
import { defaultSla, normalizeSla } from './sla.js';

export const SETTINGS_LIMITS = Object.freeze({ components: 100, pool: 100, people: 500, name: 64, component: 60, email: 254 });
export const NOTIFY_EVENTS = Object.freeze(['assigned', 'status', 'progress', 'comment', 'due', 'wiki', 'sla']); // v2.888 sla — SLA 초과(이슈 · 단계마다 한 번)

const fileOf = () => path.join(config.configDir, 'issue-settings.json');

export function defaultIssueSettings() {
  return {
    autoAssign: { enabled: false, components: [], pool: [] },
    notify: { enabled: false, mail: true, chat: false, events: { assigned: true, status: true, progress: true, comment: true, due: true, wiki: true, sla: true }, people: [] },
    sla: defaultSla(), // v2.888 C-3 — 기본 꺼짐(issues/sla.js)
    automation: defaultAutomation(), // v2.908 기능 6 — 고정 규칙 4개, 기본 전부 꺼짐(issues/automation.js)
    inbox: { enabled: true }, // v2.908 기능 9 — 포탈 알림함(밖으로 나가는 것이 없어 기본 켬 — issues/inbox.js)
  };
}
/**
 * v2.908 자동화 규칙(시안 ⑪ '자동화 규칙' — 고정 목록 · 자유 스크립트 없음). 실행 기록은 이슈 이력에 '자동화: …' 메모로 남는다.
 *  · wikiCheck — 이슈가 완료되면 그 이슈 키(ISS-n)를 적은 위키 체크리스트 항목을 완료로(판을 만들지 않는 체크 — 보기에서 체크와 같은 경로).
 *  · stale — 진행 중인데 staleDays 일 동안 갱신이 없으면 담당자에게 알림(같은 멈춤에 staleDays 일마다 한 번) · 보드 · 목록에 '멈춤' 배지.
 *  · p0Chat — 유형 장애 · 우선순위 P0 이슈가 만들어지면 팀 채팅에 바로(1분 묶음을 기다리지 않는다). 채널은 설정 › 알림.
 *  · childrenReview — 하위 작업(에픽이면 그 이슈)이 모두 완료되면 상위 이슈를 '검토' 로(완료는 사람이).
 */
export const STALE_DAYS = Object.freeze([1, 90]);
export function defaultAutomation() { return { wikiCheck: false, stale: false, staleDays: 7, p0Chat: false, childrenReview: false }; }
export function normalizeAutomation(raw, { strict = true } = {}) {
  const d = defaultAutomation();
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  let staleDays = d.staleDays;
  if (r.staleDays != null && r.staleDays !== '') {
    const n = typeof r.staleDays === 'number' ? r.staleDays : (typeof r.staleDays === 'string' && /^\d{1,3}$/.test(r.staleDays.trim()) ? Number(r.staleDays) : NaN);
    if (Number.isInteger(n) && n >= STALE_DAYS[0] && n <= STALE_DAYS[1]) staleDays = n;
    else if (strict) throw fieldError('automation.staleDays', `${STALE_DAYS[0]}~${STALE_DAYS[1]} 일 정수여야 합니다`);
  }
  return { wikiCheck: r.wikiCheck === true, stale: r.stale === true, staleDays, p0Chat: r.p0Chat === true, childrenReview: r.childrenReview === true };
}

let cache = null;
// 감사 A2-04: 손상 표지는 등록부 공용 판정(makeLoadError.checkCorruptOnly) — 재기동 뒤 파일이 없고 보존본만 남아 있어도 '못 읽음' 을 말한다.
const loadErr = makeLoadError();

function fieldError(field, msg) { const e = new Error(`${field}: ${msg}`); e.status = 400; e.field = field; return e; }
// eslint-disable-next-line no-control-regex
const NAME_RE = /^[^\s\u0000-\u001f\u007f]{1,64}$/;
const EMAIL_RE = /^[^\s@<>()",;:\\[\]]{1,64}@[A-Za-z0-9.-]{1,189}\.[A-Za-z]{2,24}$/;
function nameOf(v, field) {
  if (typeof v !== 'string' || !NAME_RE.test(v.trim())) throw fieldError(field, '공백 없는 64자 이하의 계정명이어야 합니다');
  return capStr(v.trim(), SETTINGS_LIMITS.name);
}

/** 저장 본문(또는 파일)을 좁힌다. strict=false 면 형식 밖 항목을 버리고 센다(파일 읽기) · true 면 400(저장). */
export function normalizeIssueSettings(raw, { strict = true } = {}) {
  const d = defaultIssueSettings();
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  let dropped = 0;
  const tryOr = (fn) => { try { return fn(); } catch (e) { if (strict) throw e; dropped += 1; return undefined; } };

  const a = r.autoAssign && typeof r.autoAssign === 'object' ? r.autoAssign : {};
  const components = [];
  const seenComp = new Set();
  const compIn = Array.isArray(a.components) ? a.components : [];
  if (compIn.length > SETTINGS_LIMITS.components) { if (strict) throw fieldError('autoAssign.components', `컴포넌트 규칙은 ${SETTINGS_LIMITS.components}개까지입니다`); dropped += compIn.length - SETTINGS_LIMITS.components; }
  for (const c of compIn.slice(0, SETTINGS_LIMITS.components)) {
    const v = tryOr(() => {
      const name = typeof c?.name === 'string' ? c.name.trim() : '';
      if (!name || name.length > SETTINGS_LIMITS.component) throw fieldError('autoAssign.components', `컴포넌트 이름은 1~${SETTINGS_LIMITS.component}자입니다`);
      const k = name.toLowerCase();
      if (seenComp.has(k)) throw fieldError('autoAssign.components', `컴포넌트 ‘${name}’ 가 두 번 있습니다`);
      seenComp.add(k);
      return { name: capStr(name, SETTINGS_LIMITS.component), assignee: nameOf(c?.assignee, 'autoAssign.components.assignee') };
    });
    if (v) components.push(v);
  }
  const pool = [];
  const poolIn = Array.isArray(a.pool) ? a.pool : [];
  if (poolIn.length > SETTINGS_LIMITS.pool) { if (strict) throw fieldError('autoAssign.pool', `후보는 ${SETTINGS_LIMITS.pool}명까지입니다`); dropped += poolIn.length - SETTINGS_LIMITS.pool; }
  for (const n of poolIn.slice(0, SETTINGS_LIMITS.pool)) {
    const v = tryOr(() => nameOf(n, 'autoAssign.pool'));
    if (v && !pool.includes(v)) pool.push(v);
  }

  const n = r.notify && typeof r.notify === 'object' ? r.notify : {};
  const events = { ...d.notify.events };
  for (const k of NOTIFY_EVENTS) if (typeof n.events?.[k] === 'boolean') events[k] = n.events[k];
  const people = [];
  const seenP = new Set();
  const peopleIn = Array.isArray(n.people) ? n.people : [];
  if (peopleIn.length > SETTINGS_LIMITS.people) { if (strict) throw fieldError('notify.people', `사람은 ${SETTINGS_LIMITS.people}명까지입니다`); dropped += peopleIn.length - SETTINGS_LIMITS.people; }
  for (const p of peopleIn.slice(0, SETTINGS_LIMITS.people)) {
    const v = tryOr(() => {
      const username = nameOf(p?.username, 'notify.people.username');
      const email = typeof p?.email === 'string' ? p.email.trim() : '';
      if (!EMAIL_RE.test(email) || email.length > SETTINGS_LIMITS.email) throw fieldError('notify.people.email', `‘${username}’ 의 메일 주소 형식이 아닙니다`);
      if (seenP.has(username)) throw fieldError('notify.people.username', `‘${username}’ 가 두 번 있습니다`);
      seenP.add(username);
      return { username, email: capStr(email, SETTINGS_LIMITS.email) };
    });
    if (v) people.push(v);
  }
  return {
    value: {
      autoAssign: { enabled: a.enabled === true, components, pool },
      notify: { enabled: n.enabled === true, mail: n.mail !== false, chat: n.chat === true, events, people },
      sla: tryOr(() => normalizeSla(r.sla, { strict })) || normalizeSla(r.sla, { strict: false }),
      automation: tryOr(() => normalizeAutomation(r.automation, { strict })) || normalizeAutomation(r.automation, { strict: false }),
      inbox: { enabled: !(r.inbox && typeof r.inbox === 'object' && r.inbox.enabled === false) },
    },
    dropped,
  };
}

export function loadIssueSettings() {
  if (cache) return cache;
  const f = fileOf();
  loadErr.clear();
  try {
    if (fs.existsSync(f)) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      const { value, dropped } = normalizeIssueSettings(j, { strict: false });
      if (dropped) console.warn(`[issues] issue-settings.json 의 형식 밖 항목 ${dropped}개를 읽지 않았습니다`);
      cache = value;
      return cache;
    }
  } catch (e) {
    preserveCorrupt(f, e.message);
    loadErr.set(safeLoadText(e) || '사유 미상');
    console.warn(`[issues] issue-settings.json 을 읽지 못해 기본값(자동 할당·알림 꺼짐)으로 시작합니다: ${loadErr.get().reason}`);
  }
  loadErr.checkCorruptOnly(f);
  cache = defaultIssueSettings();
  return cache;
}
/** 설정 파일을 못 읽었는가(손상 — 보존본이 남는다). 화면이 말한다. */
export function issueSettingsLoadError() { loadIssueSettings(); return loadErr.get()?.reason || null; }

export function saveIssueSettings(body) {
  // v2.888: sla 칸이 없는 저장(옛 화면)은 지금 SLA 설정을 그대로 둔다 — 알림만 고쳤는데 SLA 가 기본값(꺼짐)으로 돌아가지 않게
  // v2.908: 자동화 · 알림함도 같은 규칙(옛 화면 · 부분 저장이 끄지 않게)
  let b = body;
  if (b && typeof b === 'object' && !Array.isArray(b)) {
    const cur = loadIssueSettings();
    for (const k of ['sla', 'automation', 'inbox']) if (!Object.hasOwn(b, k)) b = { ...b, [k]: cur[k] };
  }
  const { value } = normalizeIssueSettings(b, { strict: true });
  atomicWriteFileSync(fileOf(), JSON.stringify(value, null, 1), { mode: 0o600 });
  cache = value; loadErr.clear();
  return value;
}
/** 테스트 전용. */
export function _resetIssueSettingsCache() { cache = null; loadErr.clear(); }

/** 사람 → 메일 주소. */
export function emailOf(settings, username) {
  return (settings?.notify?.people || []).find((p) => p.username === username)?.email || '';
}

/**
 * 담당자 제안(순수) — 근거와 함께. 없으면 null.
 * @param {{ component?: string, vcenterId?: string }} issue
 * @param {object} settings  loadIssueSettings()
 * @param {{ assignee: string, open: number }[]} load  issueStats().byAssignee (전체 범위 — 사람의 실제 부하)
 * @param {(username: string, vcenterId: string) => boolean} [canSee]  후보가 그 법인을 볼 수 있는가(모르면 true)
 * @returns {{ assignee: string, reason: string, via: 'component'|'load' }|null}
 */
export function suggestAssignee(issue, settings, load = [], canSee = () => true) {
  const a = settings?.autoAssign || {};
  const vc = issue?.vcenterId || '';
  const comp = String(issue?.component || '').trim().toLowerCase();
  if (comp) {
    const rule = (a.components || []).find((x) => x.name.toLowerCase() === comp);
    if (rule && canSee(rule.assignee, vc)) return { assignee: rule.assignee, reason: `컴포넌트 ‘${rule.name}’ 기본 담당자`, via: 'component' };
  }
  const open = new Map((Array.isArray(load) ? load : []).map((x) => [x.assignee, Number(x.open) || 0]));
  const cands = (a.pool || []).filter((n) => canSee(n, vc));
  if (!cands.length) return null;
  const best = [...cands].sort((x, y) => (open.get(x) || 0) - (open.get(y) || 0) || x.localeCompare(y))[0];
  return { assignee: best, reason: `후보 중 열린 이슈가 가장 적음(${open.get(best) || 0}건)`, via: 'load' };
}
