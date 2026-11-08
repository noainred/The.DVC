/**
 * bmKeyOverlapText.js — 다음 점검 ①(2차 · 사용자 결정) ‘식별 키가 겹치는 서버’ 표의 문구 · 거르기 · 쪽 나누기(순수 — 화면은 결과만 그린다).
 *   판정(겹침 · 결정 상태)은 서버(targets.js keyOverlaps · bmKeyOverlaps.js)가 정한 값 그대로 — 여기서 다시 판정하지 않는다.
 *   쪽 크기 규칙은 누락 점검(bmMissingView.js)의 것을 그대로 쓴다(clampPageSize — 기본 30 · 10~500).
 */
import { clampPageSize } from './bmMissingView.js';

const t = (v) => String(v ?? '').trim();
const low = (v) => t(v).toLowerCase();

export const OVERLAP_SOURCE_TEXT = Object.freeze({
  idrac: 'iDRAC 등록', ome: 'OME 발견', remote: '원격 수집기', edge: '엣지 보고', vcenter: 'vCenter 호스트(강제 베어메탈)', host: 'vCenter 호스트',
  'vcenter-host': 'vCenter 호스트(가상화)', bm: '베어메탈 대상',
});
export const OVERLAP_STATUS_TEXT = Object.freeze({
  pending: { label: '결정 전 — 수집 안 함', tone: 'warn' },
  add: { label: '수집에 추가함', tone: 'ok' },
  exclude: { label: '제외 유지', tone: 'idle' },
});
export const statusOf = (r) => (r?.decision?.decision === 'add' ? 'add' : r?.decision?.decision === 'exclude' ? 'exclude' : 'pending');
export const sourceText = (s) => OVERLAP_SOURCE_TEXT[s] || t(s) || '—';
/** 겹친 상대 한 줄 — 범위 밖 상대는 서버가 싣지 않는다(그때는 ‘범위 밖이거나 없음’ 으로만 — 개수도 말하지 않는다). */
export function peerText(r) {
  const p = r?.dupOf;
  if (!p) return '보이지 않음(범위 밖이거나 이미 사라짐)';
  return `${t(p.name) || t(p.key)} · ${t(p.vcenterId) || '귀속 없음'}${p.edge ? ' · 엣지 보고' : ''}${p.sameIdrac ? ' · 같은 iDRAC(같은 장비일 수 있음)' : ''}`;
}
export const KEY_OVERLAP_HONEST = '같은 식별 키(서비스태그 소문자 · 없으면 serverId)를 쓰는 서버가 이 노드에 둘 이상이면 분류는 **먼저 잡힌 한 대만** 수집 대상으로 둡니다 — 남은 서버를 여기 모았습니다. '
  + '공통 서비스태그(‘To Be Filled By O.E.M.’ 같은 화이트박스 기본값) · 숫자만인 태그와 내부 id · 대소문자만 다른 태그가 흔한 원인입니다. '
  + '**수집에 추가**하면 겹치지 않는 별도 키(법인:serverId)로 다음 주기부터 수집하고, **제외 유지**는 수집하지 않은 채 확인했다는 기록입니다. 되돌리면 처음 상태(수집 안 함)로 돌아가며 이미 쌓인 값은 지우지 않습니다. '
  + '같은 장비가 두 경로로 잡힌 것일 수도 있으니 주소 · 서비스태그 · 겹친 상대를 보고 정하세요. 엣지가 맡는 법인의 서버는 그 엣지의 같은 화면에서 정합니다.';

/** 검색 · 법인 · 상태 거르기 + 쪽 자르기(순수). */
export function overlapView(rows = [], f = {}) {
  const list = Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : [];
  const terms = low(f.q).slice(0, 200).split(/\s+/).filter(Boolean).slice(0, 8);
  const hay = (r) => [r.name, r.serviceTag, r.serverId, r.fleetId, r.key, r.idracHost, r.osHost, r.vcenterId, r.vcName, r.dupOf?.name].map(low).filter(Boolean).join(' ');
  const matched = list.filter((r) => (!f.corp || t(r.vcenterId) === f.corp) && (!f.status || statusOf(r) === f.status) && terms.every((w) => hay(r).includes(w)));
  const pageSize = clampPageSize(f.pageSize);
  const pages = Math.max(1, Math.ceil(matched.length / pageSize));
  const page = Math.min(pages, Math.max(1, Math.floor(Number(f.page) || 1)));
  const from = (page - 1) * pageSize;
  return { total: list.length, matched: matched.length, rows: matched.slice(from, from + pageSize), page, pages, pageSize, from: matched.length ? from + 1 : 0, to: Math.min(matched.length, from + pageSize) };
}
/** 법인 고르기 목록(값 · 개수). */
export function overlapCorps(rows = []) {
  const m = new Map();
  for (const r of rows || []) { const k = t(r?.vcenterId); m.set(k, (m.get(k) || 0) + 1); }
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ko', { numeric: true })).map(([value, n]) => ({ value, n }));
}
/** 주 화면 안내(겹쳐서 결정 전인 서버가 있을 때만) — 보이는 법인 것만 센 서버 값. */
export function keyOverlapNote(o) {
  const pending = Number(o?.pending) || 0;
  if (!pending) return '';
  return `**식별 키가 다른 서버와 겹쳐 수집하지 않는 서버 ${pending}대**가 있습니다 — 설정 › 식별 키가 겹치는 서버에서 주소 · 서비스태그 · 겹친 상대를 보고 **수집에 추가** 또는 **제외 유지**를 고르세요.`;
}
