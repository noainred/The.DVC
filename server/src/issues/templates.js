/**
 * issues/templates.js — 이슈 템플릿(v2.906 · 기능 추천 5 · 사용자 '모두 적용' — 기존 화면 틀대로). 파일 `issue-templates.json`.
 *
 *  · 내장 3개(장애 보고 · 작업 · 요청)에 관리자 추가 템플릿(30개)이 붙는다. 새 이슈 화면에서 고르면 유형 · 우선순위 · 라벨 · 컴포넌트 · 설명을 채운다
 *    (채우기만 — 저장은 보통 이슈 만들기와 같은 판정). id 는 서버가 만든다('t' + 10자 hex — 내장 id 와 겹치지 않는다).
 *  · 상한은 거부다: 30개 · 이름 40자 · 설명 10,000자(이슈 본문 상한과 같다) · 라벨 10개. 손상은 보존하고 빈 목록으로 읽는다(loadError 로 화면이 말한다).
 *  · 쓰기는 라우트가 관리자 + 전체 범위(조회 · 쓰기)로 막는다(전 법인 공용 — 위키 관리자 템플릿과 같은 판정).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt, safeLoadText } from '../util/atomicWrite.js';
import { capStr } from '../util/capStr.js';

export const ISSUE_TEMPLATE_LIMITS = Object.freeze({ max: 30, name: 40, body: 10_000, labels: 10, label: 30, component: 60 });
const ID_RE = /^t[a-f0-9]{10}$/;
const TYPES = Object.freeze(['task', 'incident', 'request', 'improve']);
const PRIOS = Object.freeze(['p0', 'p1', 'p2', 'p3']);
export const issueTemplatesFile = () => path.join(config.configDir, 'issue-templates.json');

/** 내장 — 고칠 수 없다(관리자 템플릿으로 같은 이름을 만들면 둘 다 보인다). */
export const BUILTIN_ISSUE_TEMPLATES = Object.freeze([
  Object.freeze({ id: 'incident', builtin: true, name: '장애 보고', type: 'incident', priority: 'p1', labels: [], component: '',
    body: '## 영향\n- 법인 · 서비스:\n- 시작 시각:\n\n## 증상\n\n## 재현 · 확인한 것\n- [ ] \n\n## 조치\n- [ ] 임시 조치\n- [ ] 원인 확인\n- [ ] 재발 방지\n' }),
  Object.freeze({ id: 'task', builtin: true, name: '작업(체크리스트)', type: 'task', priority: 'p2', labels: [], component: '',
    body: '## 목적\n\n## 할 일\n- [ ] \n- [ ] \n\n## 끝났다고 보는 기준\n' }),
  Object.freeze({ id: 'request', builtin: true, name: '요청', type: 'request', priority: 'p2', labels: [], component: '',
    body: '## 요청 내용\n\n## 필요한 날짜 · 이유\n\n## 대상(법인 · 장비 · VM)\n' }),
]);

let cache = null;
let loadError = null;
function fieldError(field, msg) { const e = new Error(`${field}: ${msg}`); e.status = 400; e.field = field; return e; }
// eslint-disable-next-line no-control-regex
const clean = (v) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
function text(v, max, field, { required = false, oneLine = false } = {}) {
  if (v != null && typeof v !== 'string') throw fieldError(field, '문자열이어야 합니다');
  let s = clean(v);
  if (oneLine) s = s.replace(/[\r\n\t]+/g, ' ').trim(); else s = s.replace(/\r\n?/g, '\n');
  if (required && !s.trim()) throw fieldError(field, '비어 있습니다');
  if (s.length > max) throw fieldError(field, `${max}자를 넘습니다(${s.length}자)`);
  return capStr(s, max);
}
const enumOf = (v, list, field, def) => { if (v == null || v === '') return def; if (!list.includes(v)) throw fieldError(field, `${list.join(' · ')} 중 하나여야 합니다`); return v; };
function labelsOf(v) {
  if (v == null || v === '') return [];
  const arr = Array.isArray(v) ? v : String(v).split(',');
  const out = [];
  for (const x of arr) { const s = text(x, ISSUE_TEMPLATE_LIMITS.label, 'labels', { oneLine: true }).toLowerCase().replace(/\s+/g, '-'); if (s && !out.includes(s)) out.push(s); }
  if (out.length > ISSUE_TEMPLATE_LIMITS.labels) throw fieldError('labels', `라벨은 ${ISSUE_TEMPLATE_LIMITS.labels}개까지입니다`);
  return out;
}

export function listCustomIssueTemplates() {
  if (cache) return cache;
  const f = issueTemplatesFile();
  loadError = null;
  let items = [];
  try {
    if (fs.existsSync(f)) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (!j || !Array.isArray(j.items)) throw new Error('items 배열이 없습니다');
      items = j.items.filter((t) => t && ID_RE.test(t.id) && typeof t.name === 'string' && typeof t.body === 'string').slice(0, ISSUE_TEMPLATE_LIMITS.max);
    }
  } catch (e) {
    preserveCorrupt(f, e.message);
    loadError = safeLoadText(e) || '사유 미상';
    console.warn(`[issues] issue-templates.json 을 읽지 못해 관리자 템플릿 없이 시작합니다: ${loadError}`);
    items = [];
  }
  cache = items;
  return cache;
}
export const issueTemplatesLoadError = () => { listCustomIssueTemplates(); return loadError; };
/** 화면이 고르는 목록 — 내장 먼저. */
export const allIssueTemplates = () => [...BUILTIN_ISSUE_TEMPLATES, ...listCustomIssueTemplates()];
const persist = (items) => { atomicWriteFileSync(issueTemplatesFile(), JSON.stringify({ v: 1, items }), { mode: 0o600 }); cache = items; loadError = null; };

/** 만들기 · 고치기(id 가 있으면 고치기 — 내장은 고칠 수 없다). */
export function saveIssueTemplate(body, user, { now = Date.now() } = {}) {
  const b = body || {};
  const items = [...listCustomIssueTemplates()];
  const t = {
    name: text(b.name, ISSUE_TEMPLATE_LIMITS.name, 'name', { required: true, oneLine: true }),
    type: enumOf(b.type, TYPES, 'type', 'task'),
    priority: enumOf(b.priority, PRIOS, 'priority', 'p2'),
    labels: labelsOf(b.labels),
    component: text(b.component, ISSUE_TEMPLATE_LIMITS.component, 'component', { oneLine: true }),
    body: text(b.body, ISSUE_TEMPLATE_LIMITS.body, 'body', { required: true }),
  };
  if (b.id != null && b.id !== '') {
    if (BUILTIN_ISSUE_TEMPLATES.some((x) => x.id === b.id)) throw fieldError('id', '내장 템플릿은 고칠 수 없습니다 — 같은 내용으로 새 템플릿을 만드세요');
    const i = items.findIndex((x) => x.id === b.id);
    if (i < 0) { const e = new Error('없는 템플릿입니다'); e.status = 404; throw e; }
    items[i] = { ...items[i], ...t, updatedAt: now, updatedBy: user };
    persist(items);
    return items[i];
  }
  if (items.length >= ISSUE_TEMPLATE_LIMITS.max) { const e = new Error(`관리자 템플릿은 ${ISSUE_TEMPLATE_LIMITS.max}개까지입니다`); e.status = 409; throw e; }
  const x = { id: `t${crypto.randomBytes(5).toString('hex')}`, ...t, createdAt: now, createdBy: user, updatedAt: now, updatedBy: user };
  persist([...items, x]);
  return x;
}
export function deleteIssueTemplate(id) {
  const items = listCustomIssueTemplates();
  if (!items.some((x) => x.id === id)) { const e = new Error('없는 템플릿입니다'); e.status = 404; throw e; }
  persist(items.filter((x) => x.id !== id));
  return { id };
}
export function _resetIssueTemplates() { cache = null; loadError = null; }
