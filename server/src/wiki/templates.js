/**
 * wiki/templates.js — 관리자가 더하는 위키 템플릿(v2.889 · 시안 ⑤ '관리자 추가 템플릿' · C-5). 파일 `wiki-templates.json`.
 *
 *  · 내장 템플릿(wiki/store.js TEMPLATES)은 그대로 두고 그 뒤에 붙는다. id 는 서버가 만든다('c' + 10자 hex — 내장 id 와 겹치지 않는다).
 *  · 상한은 거부다: 30개 · 이름 40자 · 꼬리표 20자 · 본문 20,000자. 손상은 보존하고 빈 목록으로 읽는다(loadError 로 화면이 말한다).
 *  · 쓰기는 라우트가 관리자 + 전체 범위로 막는다(전 법인 공용 — 모든 스페이스의 '새 문서' 에 보인다).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt, safeLoadText } from '../util/atomicWrite.js';
import { capStr } from '../util/capStr.js';

export const TEMPLATE_LIMITS = Object.freeze({ max: 30, name: 40, tag: 20, body: 20_000 });
const ID_RE = /^c[a-f0-9]{10}$/;
export const wikiTemplatesFile = () => path.join(config.configDir, 'wiki-templates.json');

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

export function listCustomTemplates() {
  if (cache) return cache;
  const f = wikiTemplatesFile();
  loadError = null;
  let items = [];
  try {
    if (fs.existsSync(f)) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (!j || !Array.isArray(j.items)) throw new Error('items 배열이 없습니다');
      items = j.items.filter((t) => t && ID_RE.test(t.id) && typeof t.name === 'string' && typeof t.body === 'string').slice(0, TEMPLATE_LIMITS.max);
    }
  } catch (e) {
    preserveCorrupt(f, e.message);
    loadError = safeLoadText(e) || '사유 미상';
    console.warn(`[wiki] wiki-templates.json 을 읽지 못해 관리자 템플릿 없이 시작합니다: ${loadError}`);
    items = [];
  }
  cache = items;
  return cache;
}
export const customTemplatesLoadError = () => { listCustomTemplates(); return loadError; };
const persist = (items) => { atomicWriteFileSync(wikiTemplatesFile(), JSON.stringify({ v: 1, items }), { mode: 0o600 }); cache = items; loadError = null; };
export const getCustomTemplate = (id) => listCustomTemplates().find((t) => t.id === id) || null;

/** 만들기 · 고치기(id 가 있으면 고치기). */
export function saveCustomTemplate(body, user, { now = Date.now() } = {}) {
  const b = body || {};
  const items = [...listCustomTemplates()];
  const t = {
    name: text(b.name, TEMPLATE_LIMITS.name, 'name', { required: true, oneLine: true }),
    tag: text(b.tag, TEMPLATE_LIMITS.tag, 'tag', { oneLine: true }),
    body: text(b.body, TEMPLATE_LIMITS.body, 'body', { required: true }),
  };
  if (b.id != null && b.id !== '') {
    const i = items.findIndex((x) => x.id === b.id);
    if (i < 0) { const e = new Error('없는 템플릿입니다'); e.status = 404; throw e; }
    items[i] = { ...items[i], ...t, updatedAt: now, updatedBy: user };
    persist(items);
    return items[i];
  }
  if (items.length >= TEMPLATE_LIMITS.max) { const e = new Error(`관리자 템플릿은 ${TEMPLATE_LIMITS.max}개까지입니다`); e.status = 409; throw e; }
  const x = { id: `c${crypto.randomBytes(5).toString('hex')}`, ...t, createdAt: now, createdBy: user, updatedAt: now, updatedBy: user };
  persist([...items, x]);
  return x;
}
export function deleteCustomTemplate(id) {
  const items = listCustomTemplates();
  if (!items.some((x) => x.id === id)) { const e = new Error('없는 템플릿입니다'); e.status = 404; throw e; }
  persist(items.filter((x) => x.id !== id));
  return { id };
}
export function _resetCustomTemplates() { cache = null; loadError = null; }
