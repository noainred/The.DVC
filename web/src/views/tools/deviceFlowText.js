/**
 * deviceFlowText.js — '3단 지도(장비 → 엣지 → 메인)' 의 문구·색(v2.588, 순수).
 *
 * 판정은 서버(`server/src/devflow/build.js`)가 코드(`tone`·`state`·채널 상태)로 주고, 이 모듈은 **문장만** 만든다
 * (v2.553 규약). 키 집합은 서버 테스트(`devFlow2588.test.js`)가 대조한다 — 한쪽만 늘면 화면이 코드를 그대로 보여준다.
 * ⚠ 문구에 백틱 금지(BoldText 는 **강조** 만 해석한다).
 */
import { ageText, spanText, bytesText, STATE_LABEL as EDGE_STATE_LABEL, STATE_COLOR as EDGE_STATE_COLOR, REASON_TEXT } from './commMapText.js';
import { unauthNote, sharedUrlNote, sharedMark } from './dataFlowText.js';
export { sharedMark };

export { ageText, spanText, bytesText, EDGE_STATE_LABEL, EDGE_STATE_COLOR, REASON_TEXT };

export const DEV_KIND_LABEL = Object.freeze({ vcenter: 'vCenter', idrac: 'iDRAC 서버', storage: '스토리지', sanswitch: 'SAN 스위치', pdu: 'PDU' });
export const DEV_KIND_SHORT = Object.freeze({ vcenter: 'vCenter', idrac: 'iDRAC', storage: '스토리지', sanswitch: 'SAN', pdu: 'PDU' });

/** 엣지 ↔ 메인 채널 넷(서버 CHANNELS 와 1:1). 데이터 흐름 지도의 방향 여섯을 넷으로 접은 것이다. */
export const CHANNEL_LABEL = Object.freeze({
  up: '엣지 → 메인 · 자료 올림(push·작업 회신)',
  down: '엣지 ← 메인 · 설정·작업 가져감(pull)',
  cpull: '메인 → 엣지 · 메인이 가져옴',
  cpush: '메인 → 엣지 · 메인이 보냄(명령·번들)',
});
export const CHANNEL_ICON = Object.freeze({ up: '↑', down: '↓', cpull: '⇠', cpush: '⇢' });
/** 엣지 카드에 붙는 짧은 낱말(카드 폭 260px 안에 넷이 들어가야 한다). */
export const CHANNEL_WORD = Object.freeze({ up: '올림', down: '가져감', cpull: '당김', cpush: '보냄' });

export const CH_STATE_LABEL = Object.freeze({ fail: '실패·거부', stale: '낡음', ok: '정상', none: '기록 없음' });
export const CH_STATE_COLOR = Object.freeze({ fail: '#e5484d', stale: '#e0a43a', ok: '#3fb6a8', none: '#4a5163' });

/** 장비 상태(서버 ITEM_STATES 와 1:1). */
export const ITEM_STATE_LABEL = Object.freeze({
  fail: '수집 실패', stale: '낡음', pending: '첫 수집 대기', ok: '정상',
  maintenance: '점검 중', registered: '등록됨(판정 안 함)', disabled: '비활성',
});
export const ITEM_STATE_COLOR = Object.freeze({
  fail: '#e5484d', stale: '#e0a43a', pending: '#e0a43a', ok: '#3fb6a8',
  maintenance: '#7c8aa8', registered: '#6b7384', disabled: '#3a4150',
});

/** 묶음 색조(서버 GROUP_TONES 와 1:1). neutral = 등록만 알고 판정하지 않은 묶음 — 초록이 아니다. */
export const TONE_LABEL = Object.freeze({ fail: '실패 있음', warn: '주의', ok: '정상', neutral: '등록만 확인(판정 안 함)' });
export const TONE_COLOR = Object.freeze({ fail: '#e5484d', warn: '#e0a43a', ok: '#3fb6a8', neutral: '#5b6272' });

export const UNASSIGNED_REASON = Object.freeze({
  'agent-unknown': '담당 엣지 이름이 수집 서버 등록부에 없습니다',
  'agent-empty': '담당 엣지가 비어 있습니다',
});

const TONE_RANK = { fail: 0, warn: 1, ok: 2, neutral: 3 };
/** 묶음 여럿 중 가장 나쁜 색조(선 색). 묶음이 없으면 null. */
export function worstTone(groups = []) {
  let best = null;
  for (const g of groups) if (best == null || TONE_RANK[g.tone] < TONE_RANK[best]) best = g.tone;
  return best;
}

/** 묶음 한 줄 제목. */
export function groupTitle(g = {}) {
  return `${DEV_KIND_LABEL[g.kind] || g.kind} ${g.total}대`;
}

/** 상태 개수 한 줄(0 인 상태는 뺀다). */
export function countsText(g = {}) {
  const c = g.counts || {};
  const parts = Object.keys(ITEM_STATE_LABEL).filter((s) => c[s] > 0).map((s) => `${ITEM_STATE_LABEL[s]} ${c[s]}`);
  return parts.join(' · ') || '없음';
}

/**
 * 묶음 상세 머리말 — 이 숫자가 어디서 왔는지와 **판정하지 않는 것**을 말한다.
 * @param where 'edge' | 'main' | 'unassigned'
 */
export function groupNote(g = {}, where = 'edge', now = Date.now()) {
  const out = [];
  if (where === 'main') out.push('메인(중앙)이 **직접** 수집하는 장비입니다 — 엣지를 거치지 않습니다.');
  else if (where === 'unassigned') out.push('어느 엣지에도 붙일 수 없는 장비입니다 — 지어낸 노드에 붙이지 않고 따로 모았습니다.');
  else if (g.reportBasis === 'pull') out.push(g.reportAt ? `iDRAC 목록은 메인이 엣지에서 가져온 것입니다 — 마지막 정상 pull ${ageText(g.reportAt, now)}.` : 'iDRAC 목록은 메인이 엣지에서 가져온 것인데 정상 pull 기록이 없습니다 — 목록이 오래됐을 수 있습니다.');
  else out.push(g.reportAt ? `이 종류의 마지막 엣지 보고 ${ageText(g.reportAt, now)}.` : '이 종류의 엣지 보고 시각을 모릅니다(중앙 재시작 뒤 아직 받지 못했을 수 있습니다).');
  if (g.tone === 'neutral') out.push('이 화면은 이 종류의 **장비별 수집 성패를 판정하지 않습니다** — 등록된 사실만 압니다. 상세 상태는 각 도구 화면에서 보세요.');
  if (g.omitted > 0) out.push(`목록은 심각한 것부터 ${g.items?.length || 0}대까지만 보여 줍니다 — **${g.omitted}대는 생략**했습니다(개수 집계는 전량 기준).`);
  return out.join(' ');
}

/** 장비 한 행의 부가 정보. */
export function itemExtra(it = {}) {
  if (it.kind === 'vcenter') {
    const bits = [];
    if (it.hosts != null) bits.push(`호스트 ${it.hosts}`);
    if (it.vms != null) bits.push(`VM ${it.vms}`);
    if (it.error) bits.push(String(it.error).slice(0, 120));
    return bits.join(' · ');
  }
  if (it.kind === 'idrac') {
    const bits = [it.serviceTag, it.model].filter(Boolean);
    if (it.hasInventory === false) bits.push('인벤토리 미수신');
    return bits.join(' · ');
  }
  return it.type || '';
}

/** 엣지 사유 코드 → 한 줄(제목 + 조치). 통신 지도 문구를 그대로 쓴다(REASON_TEXT 값은 {title, fix} 객체다). */
export function reasonText(code) {
  if (code === 'not-registered') return '수집 서버 등록부에 없는 이름입니다 — 통신 기록에만 나타났습니다. 이름이 비어 있으면 요청이 이름을 싣지 않은 것입니다(검증되지 않은 값).';
  const r = REASON_TEXT[code];
  return r ? `${r.title} ${r.fix}`.trim() : String(code || '');
}

/** 채널 한 줄 설명. */
export function channelText(c = {}, now = Date.now()) {
  if (!c || c.state === 'none' || !c.routes) return '기록 없음 — 중앙이 시작된 뒤 이 방향 통신이 없었습니다(정상이라는 뜻이 아닙니다).';
  const bits = [`${CH_STATE_LABEL[c.state]} · 경로 ${c.routes}개`];
  if (c.failRoutes) bits.push(`실패 ${c.failRoutes}`);
  if (c.staleRoutes) bits.push(`낡음 ${c.staleRoutes}`);
  bits.push(`마지막 성공 ${c.lastOkAt ? ageText(c.lastOkAt, now) : '없음'}`);
  if (c.lastFailAt) bits.push(`마지막 실패 ${ageText(c.lastFailAt, now)}`);
  if (c.unverified) bits.push('이름 미검증');
  return bits.join(' · ');
}

/** 상단 머리말. */
export function headerNote(data = {}, now = Date.now()) {
  const tot = data.totals || {};
  const parts = [];
  parts.push(data.since ? `엣지 ↔ 메인 선은 중앙이 시작된 뒤(${ageText(data.since, now)})의 기록만으로 칠합니다 — 기록이 없으면 **회색 점선**이고 정상이라는 뜻이 아닙니다.` : '엣지 ↔ 메인 통신 기록이 아직 없습니다 — 선은 전부 **회색 점선**입니다(정상이라는 뜻이 아닙니다).');
  const unreg = (data.edges || []).filter((e) => !e.registered).length;
  if (unreg) parts.push(`등록부에 없는 이름 ${unreg}개가 통신 기록에 있어 노드로 함께 그렸습니다.`);
  if (tot.unassignedDevices) parts.push(`어느 엣지에도 붙일 수 없는 장비 **${tot.unassignedDevices}대**는 아래에 따로 모았습니다.`);
  if (Number(data.rejectsWithoutTime) > 0) parts.push(`시각을 모르는 거부 ${data.rejectsWithoutTime}건은 선에 넣지 않았습니다.`);
  const un = unauthNote(data, now);
  if (un) parts.push(un);
  const sh = sharedUrlNote(data); // v2.601 WEB2601-02
  if (sh) parts.push(sh);
  return parts.join(' ');
}

/**
 * 엣지가 0곳일 때 가운데 열의 안내(v2.599 WEB2599-06). ⚠ '문제' 라고 단정하지 않는다 — 모든 장비를 메인이
 * 직접 수집하는 구성이면 정상이다. 다만 엣지 담당으로 적힌 장비가 있으면 그 장비는 붙일 곳이 없다.
 */
export function noEdgesNote(data = {}) {
  const un = Number(data.totals?.unassignedDevices) || 0;
  const parts = ['**등록된 수집 서버(엣지)가 없습니다.** 엣지는 설정 › 수집 서버에서 등록합니다.'];
  parts.push(un
    ? `엣지 담당으로 적힌 장비 **${un}대**는 붙일 엣지가 없어 아래 '붙일 곳 없음' 에 모았습니다.`
    : '모든 장비를 메인이 직접 수집하는 구성이면 이 상태가 정상입니다.');
  return parts.join(' ');
}

export const LEGEND = Object.freeze([
  '왼쪽 **장비 묶음**은 종류별 개수입니다. 누르면 아래에 그 장비 목록이 펼쳐집니다. 회색 묶음은 등록만 확인한 것이지 정상이라는 뜻이 아닙니다.',
  '가운데 **엣지**와 오른쪽 **메인** 사이의 선 하나에는 방향 넷(↑ 올림 · ↓ 가져감 · ⇠ 메인이 가져옴 · ⇢ 메인이 보냄)이 접혀 있습니다. 선 색은 **기록이 있는 방향** 중 가장 나쁜 상태이고(기록 없는 방향은 선 색에 넣지 않습니다), 엣지 카드의 화살표 넷이 방향별 색입니다.',
  '엣지 카드 오른쪽 위 글자는 통신 지도의 **엣지 판정**(pull·push 수신 기준)이고, 선 색은 **경로별 기록** 기준입니다 — 축이 달라 서로 다를 수 있습니다(예: 수신은 오는데 일부 경로가 거부되는 엣지).',
  '맨 위 줄은 엣지를 거치지 않고 **메인이 직접** 수집하는 장비입니다.',
  '경로별 상세는 데이터 흐름 지도, 엣지 연결 사유는 통신 지도에서 봅니다 — 이 화면은 두 지도의 판정을 그대로 묶어 보여 줄 뿐 새로 판정하지 않습니다.',
]);
