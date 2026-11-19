/**
 * wiki/templates.js — 관리자가 더하는 위키 템플릿(v2.889 · 시안 ⑤ '관리자 추가 템플릿' · C-5). 파일 `wiki-templates.json`.
 *
 *  · 내장 템플릿(wiki/store.js TEMPLATES)은 그대로 두고 그 뒤에 붙는다. id 는 서버가 만든다('c' + 10자 hex — 내장 id 와 겹치지 않는다).
 *  · 상한은 거부다: 30개 · 이름 40자 · 꼬리표 20자 · 본문 20,000자. 손상은 보존하고 빈 목록으로 읽는다(loadError 로 화면이 말한다).
 *  · 쓰기는 라우트가 관리자 + 전체 범위로 막는다(전 법인 공용 — 모든 스페이스의 '새 문서' 에 보인다).
 */
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt, safeLoadText } from '../util/atomicWrite.js';
import { makeJsonFileReader } from '../util/jsonFileRead.js';
import { capStr } from '../util/capStr.js';

export const TEMPLATE_LIMITS = Object.freeze({ max: 30, name: 40, tag: 20, body: 20_000 });
const ID_RE = /^c[a-f0-9]{10}$/;
export const wikiTemplatesFile = () => path.join(config.configDir, 'wiki-templates.json');

let cache = null;
let loadError = null;
const _reader = makeJsonFileReader(() => wikiTemplatesFile(), { parse: (t) => t, preserve: false, tag: 'wiki-templates' });   // 97회차 F8: 읽기 오류 ≠ 손상
let _readErr = null;   // 마지막 읽기가 읽기 오류였으면 그 코드
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
  // 97회차 F8: 읽기 단계는 공용 읽기(util/jsonFileRead.js) — 읽기 오류(EACCES · EIO · EISDIR)는 손상이 아니라 원본을 옮기지 않고 · 캐시하지 않고(30초 간격 재읽기) ·
  //   저장을 거절한다(409). 예전 catch 하나는 권한만 틀린 원본을 보존본으로 옮긴 뒤 빈 목록을 캐시했고, 다음 저장이 그 한 건만 든 파일을 썼다. parse 실패는 아래 catch(예전과 같다).
  const rr = _reader.read();
  if (rr.kind === 'read-error') {
    if (!_readErr) _readErr = String(rr.error?.code || 'read-error').slice(0, 32);
    loadError = `위키 템플릿 파일(wiki-templates.json)을 읽지 못했습니다(읽기 오류 ${_readErr} — 원본은 그대로 · 저장 거절 중)`;
    return [];   // 캐시하지 않는다
  }
  _readErr = null;
  try {
    if (rr.kind === 'ok') {
      const j = JSON.parse(rr.value);
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
const persist = (items) => { if (_readErr) throw Object.assign(new Error(`위키 템플릿 파일(wiki-templates.json)을 읽지 못한 상태라 저장하지 않았습니다 — 읽기 오류(${_readErr})이고 원본은 그대로 있습니다. 파일 권한 · 소유자 · 디스크를 확인하세요(30초마다 다시 읽습니다).`), { status: 409, code: 'settings-unreadable' }); atomicWriteFileSync(wikiTemplatesFile(), JSON.stringify({ v: 1, items }), { mode: 0o600 }); cache = items; loadError = null; };
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
export function _resetCustomTemplates() { cache = null; loadError = null; _readErr = null; _reader.reset(); }
