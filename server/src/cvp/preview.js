/**
 * cvp/preview.js — 관리자가 붙여넣은 CVP 응답 원문에 **우리 파서를 돌려 무엇을 읽는지** 미리 본다(순수, v2.640).
 *
 * 왜: `cvp/parse.js` 의 경로·필드는 전부 추정이다(실장비 CVP 응답을 본 적이 없다 — docs/CVP.md §6). 첫 실수집에서 '읽지
 *   못했다' 가 나오면 원인이 ① 경로가 다르다 ② 필드명이 다르다 ③ 형식(NDJSON·notifications)이 다르다 중 무엇인지
 *   장비를 다시 찌르지 않고 알아야 한다. 관리자가 브라우저·curl 로 받은 본문을 붙여넣으면 종류(kind)별 파서가
 *   `count`(읽은 개체 수)·`keys`(응답에 있던 필드 이름)·`format`·`items`(앞 50개)를 돌려준다 — **keys 는 못 읽어도 그대로**
 *   (어떤 필드가 있었는지가 곧 진단이다).
 *
 * 규약: 절대 던지지 않는다(잘못된 JSON 은 `badChunks` 로 센다) · 입력은 PREVIEW_TEXT_MAX 자에서 자르고 `truncatedInput` 으로
 *   밝힌다 · 모르는 kind 는 `{ ok:false, reason }` · 못 읽은 수치는 null(0 을 지어내지 않는다 — 읽은 개체 0 은 `count:0` 이고
 *   형식 자체를 못 읽은 것은 `count:null`).
 */
import * as P from './parse.js';
import { PART_KINDS } from './client.js';
import { capStr } from '../util/capStr.js';

export const PREVIEW_KINDS = Object.freeze(['inventory', 'cvpVersion', 'interfaces', 'counters', 'bgp', 'power', 'cooling', 'temperature', 'xcvr']);
/** 입력 상한(문자) — 붙여넣기용이다. 1MB 면 장비 1대의 인터페이스 전량(포트 수백 개)도 들어간다. */
export const PREVIEW_TEXT_MAX = 1_000_000;
export const PREVIEW_ITEMS_MAX = 50;

const NOTE_NONE = '인식한 필드가 없습니다 — 응답이 오류 본문이거나 필드명이 다릅니다';
const NOTE_EMPTY = '본문이 비어 있습니다';

/** 파서 keys 가 비면 entitiesOf 의 keys 로 보충(오류 본문이라도 어떤 필드가 있었는지 보여 준다). */
const keysOf = (a, b) => (Array.isArray(a) && a.length ? a : Array.isArray(b) ? b : []).slice(0, 40).map((k) => capStr(k, 64));
const items = (list) => (Array.isArray(list) ? list.slice(0, PREVIEW_ITEMS_MAX) : []);

/**
 * @param {string} kind PREVIEW_KINDS 중 하나
 * @param {string} text 응답 원문
 * @returns {object} { kind, ok, format, keys, entities, count, truncated, unrecognized|dropped, droppedFields, items, badChunks, truncatedInput, note }
 */
export function previewParse(kind, text) {
  const k = typeof kind === 'string' ? kind : '';
  if (!PREVIEW_KINDS.includes(k)) return { kind: capStr(k, 32), ok: false, reason: 'unknown-kind', note: `모르는 종류입니다 — ${PREVIEW_KINDS.join(' · ')} 중 하나여야 합니다` };
  let t = typeof text === 'string' ? text : '';
  const truncatedInput = t.length > PREVIEW_TEXT_MAX;
  if (truncatedInput) t = t.slice(0, PREVIEW_TEXT_MAX);
  try {
    const out = run(k, t);
    return { kind: k, truncatedInput, ...out };
  } catch (e) {
    // 파서는 던지지 않게 만들었지만, 여기서도 방어한다 — 붙여넣기 하나가 라우트를 매달게 두지 않는다(express 4 async — v2.548 S1).
    return { kind: k, ok: false, reason: 'parse-error', truncatedInput, keys: [], entities: null, count: null, items: [], note: `파서 오류: ${capStr(e?.message || String(e), 300)}` };
  }
}

function run(kind, t) {
  if (!t.trim()) return { ok: false, format: null, keys: [], entities: 0, count: null, truncated: 0, droppedFields: 0, items: [], badChunks: 0, note: NOTE_EMPTY };
  const { values, bad } = P.splitJsonStream(t);
  const badNote = bad ? ` · JSON 으로 읽지 못한 조각 ${bad}개` : '';
  if (kind === 'inventory') {
    const r = P.parseInventory(t);
    const ok = Array.isArray(r.devices);
    return {
      ok, format: values.length ? (values.length > 1 ? 'stream' : 'json') : null, keys: keysOf(r.keys, []), entities: values.length,
      count: ok ? r.devices.length : null, truncated: r.truncated || 0, dropped: r.dropped || 0, droppedFields: 0,
      items: items(r.devices), badChunks: bad,
      note: ok ? `장비 ${r.devices.length}대를 읽었습니다${r.dropped ? ` · 키(시리얼·MAC·호스트명) 없는 레코드 ${r.dropped}개 제외` : ''}${r.truncated ? ` · 상한으로 ${r.truncated}대 잘림` : ''}${badNote}` : NOTE_NONE + badNote,
    };
  }
  if (kind === 'cvpVersion') {
    const first = values.find((v) => v && typeof v === 'object' && !Array.isArray(v));
    const ver = first ? capStr(first.version || first.appVersion || '', 64) : '';
    const keys = first ? Object.keys(first).slice(0, 40).map((x) => capStr(x, 64)) : [];
    return {
      ok: !!ver, format: values.length ? 'json' : null, keys, entities: values.length, count: ver ? 1 : null, truncated: 0, droppedFields: 0,
      items: ver ? [{ version: ver }] : [], badChunks: bad,
      note: ver ? `버전 ‘${ver}’ 을 읽었습니다${badNote}` : `version·appVersion 필드가 없습니다${keys.length ? ` — 있던 필드: ${keys.join(', ')}` : ''}${badNote}`,
    };
  }
  const ent = P.entitiesOf(t);
  const base = { format: ent.format, entities: ent.entities.size, badChunks: bad };
  const finish = (list, keys, extra) => {
    const ok = Array.isArray(list);
    const count = ok ? list.length : null;
    const truncated = extra?.truncated || 0;
    const unrecognized = ok ? Math.max(0, ent.entities.size - count - truncated) : ent.entities.size;
    return {
      ok, ...base, keys: keysOf(keys, ent.keys), count, truncated, unrecognized, droppedFields: extra?.droppedFields || ent.droppedFields || 0,
      items: items(list),
      note: ok ? `${count}개를 읽었습니다${unrecognized ? ` · 필드를 못 알아본 개체 ${unrecognized}개 제외` : ''}${truncated ? ` · 상한으로 ${truncated}개 잘림` : ''}${badNote}` : NOTE_NONE + badNote,
    };
  };
  if (kind === 'interfaces') { const r = P.parseInterfaces(t); return finish(r.ports, r.keys, r); }
  if (kind === 'counters') {
    const r = P.parseCounters(t);
    const list = r.counters instanceof Map ? [...r.counters].map(([name, c]) => ({ name, ...c })) : null;
    return finish(list, r.keys, r);
  }
  if (kind === 'bgp') { const r = P.parseBgp(t); return { ...finish(r.peers, r.keys, r), summary: r.summary || null }; }
  const part = PART_KINDS[kind];
  const r = P.parseParts(t, part);
  return { ...finish(r.parts, r.keys, r), partKind: part, summary: P.partsSummary(r.parts) };
}
