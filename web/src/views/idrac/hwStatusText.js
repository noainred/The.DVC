/**
 * hwStatusText.js — iDRAC 하드웨어 화면의 부품 상태·링크·'부품 이상' 열 문구(순수, v2.728).
 *
 * ⚠ 판정은 서버가 한다(CLAUDE.md '판정 복제 금지'):
 *   · 부품 상태 `partState`(ok|warn|fault|unknown|absent) — 서버 idrac/invView.js 가 partfault/classify.js redfishPartState 로 붙인다.
 *   · 포트 링크 `linkState`(up|down|unknown) — 서버 idrac/nicPorts.js nicLinkState.
 *   · 부품 요약 `parts` — 서버 idrac/serverParts.js(partfault 추출기 그대로, 표시 전용).
 * 이 파일은 그 값에 **색·문구만** 붙인다. 값이 없으면(구버전 응답) 'unknown' 으로 다룬다 — 정상으로 칠하지 않는다.
 *
 * 규칙: 확인 불가(unknown)는 정상도 장애도 아니다(회색) · 빈 슬롯(absent)은 장애가 아니다(회색) · 판정 불가는 '—' + 사유.
 * 문구에 백틱을 쓰지 않는다(BoldText 는 **강조** 만 해석한다 — uiText.test.js 스윕).
 */

const str = (v) => (typeof v === 'string' ? v.trim() : '');

export const PART_TONE = Object.freeze({ ok: 'green', warn: 'amber', fault: 'red', unknown: 'gray', absent: 'gray' });
export const PART_STATE_TEXT = Object.freeze({ ok: '정상', warn: '주의', fault: '이상', unknown: '확인 불가', absent: '빈 슬롯' });
const stateOf = (v) => (Object.hasOwn(PART_TONE, v || '') ? v : 'unknown');

/**
 * 부품 한 개의 상태 배지 — 글자는 장비 보고(health → state 순), 없으면 '확인 불가'. 색은 서버 판정(partState).
 * @param {{partState?:string, health?:string, state?:string, predictiveFailure?:boolean|null}} el
 * @returns {{cls:string, text:string, title:string, state:string}}
 */
export function partStatusBadge(el) {
  const st = stateOf(el?.partState);
  const h = str(el?.health); const s = str(el?.state);
  const raw = [h, s].filter(Boolean).join(' / ');
  let text;
  if (st === 'absent') text = '빈 슬롯';
  else if (el?.predictiveFailure === true) text = '예측 실패';
  else text = h || s || '확인 불가';
  const title = st === 'absent'
    ? `빈 슬롯(장애 아님)${raw ? ` — 장비 보고: ${raw}` : ''}`
    : st === 'unknown'
      ? (raw ? `상태를 판정하지 못했습니다(정상도 장애도 아님) — 장비 보고: ${raw}` : '장비가 상태를 보고하지 않았거나 읽지 못했습니다(정상도 장애도 아님)')
      : `${PART_STATE_TEXT[st]} — 장비 보고: ${raw || '—'}${el?.predictiveFailure === true ? ' · SMART 예측 실패' : ''}`;
  return { cls: PART_TONE[st], text, title, state: st };
}

/**
 * 포트 링크 배지. ⚠ unknown 을 ⛔(다운)로 칠하지 않는다 — 예전 화면은 못 읽은 포트까지 '다운' 이라고 말했다(v2.728 신고).
 * @param {{linkState?:string, link?:string}} port
 * @returns {{cls:string, icon:string, title:string, state:string}}
 */
export function linkBadge(port) {
  const st = ['up', 'down', 'unknown'].includes(port?.linkState) ? port.linkState : 'unknown';
  const raw = str(port?.link);
  if (st === 'up') return { cls: 'green', icon: '🔗', title: `링크 업 — 장비 보고: ${raw}`, state: st };
  if (st === 'down') return { cls: 'gray', icon: '⛔', title: `링크 다운(케이블 미결선·비활성 포함 — 장애로 세지 않습니다) — 장비 보고: ${raw}`, state: st };
  return {
    cls: 'gray', icon: '?', state: st,
    title: raw ? `링크 상태를 판정하지 못했습니다(다운이라는 뜻이 아닙니다) — 장비 보고: ${raw}` : '링크 상태를 읽지 못했습니다(장비가 값을 주지 않았습니다 — 다운이라는 뜻이 아닙니다)',
  };
}

/** 포트 속도 글자 — 값이 없으면 빈 문자열(0 을 지어내지 않는다). */
export function portSpeedText(mbps) {
  const n = typeof mbps === 'number' && Number.isFinite(mbps) && mbps > 0 ? mbps : null;
  if (n == null) return '';
  return n >= 1000 ? `${Number.isInteger(n / 1000) ? n / 1000 : (n / 1000).toFixed(1)}G` : `${n}M`;
}

/** 판정 불가 사유 — 서버 idrac/serverParts.js PARTS_REASON 과 키가 1:1(테스트 대조). */
export const PARTS_REASON_TEXT = Object.freeze({
  'no-inventory': '인벤토리를 아직 받지 못했습니다',
  unreachable: '마지막 인벤토리 수집이 장비에 닿지 못했습니다',
  'system-failed': '시스템 정보 조회가 실패해 이번 인벤토리로는 판정하지 않습니다',
  'edge-old': '이 서버를 수집하는 엣지가 2.728 이전 버전이라 부품 상태를 보내지 않습니다',
});
export const partsReasonText = (r) => PARTS_REASON_TEXT[r] || '판정하지 못했습니다';

const ageMin = (at, now) => (at == null ? null : Math.max(0, Math.round((now - at) / 60_000)));

/**
 * 서버 목록 '부품 이상' 열.
 * @param {object|null|undefined} p  행의 parts(서버 serverPartsCell)
 * @returns {{badges:Array<{cls:string,text:string,title:string}>, sort:number|'', title:string}}
 */
export function partsCell(p, now = Date.now()) {
  if (!p || typeof p !== 'object') return { badges: [], sort: '', title: '부품 상태를 받지 못했습니다' };
  if (!p.judged) return { badges: [], sort: '', title: `판정 불가 — ${partsReasonText(p.reason)}` };
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const fault = n(p.fault); const warn = n(p.warn); const unknown = n(p.unknown); const absent = n(p.absent); const ok = n(p.ok);
  const failed = Array.isArray(p.failedKinds) ? p.failedKinds : [];
  const notes = [];
  if (failed.length) notes.push(`일부 종류 수집 실패(${failed.join(', ')}) — 그 종류는 판정하지 않았습니다`);
  if (absent) notes.push(`빈 슬롯 ${absent}(장애 아님)`);
  const m = ageMin(p.collectedAt, now);
  if (p.stale && m != null) notes.push(`인벤토리가 ${m}분 전 값입니다(오래됨)`);
  const tail = notes.length ? ` · ${notes.join(' · ')}` : '';
  const badges = [];
  if (fault) badges.push({ cls: 'red', text: `장애 ${fault}`, title: `장애(이상) 부품 ${fault}개${tail}` });
  if (warn) badges.push({ cls: 'amber', text: `경고 ${warn}`, title: `경고(주의) 부품 ${warn}개${tail}` });
  if (unknown) badges.push({ cls: 'gray', text: `확인 불가 ${unknown}`, title: `상태를 읽지 못한 부품 ${unknown}개 — 정상도 장애도 아닙니다${tail}` });
  if (!badges.length) {
    if (ok) badges.push({ cls: 'green', text: '이상 없음', title: `확인한 부품 ${ok}개 모두 정상${tail}` });
    else return { badges: [], sort: '', title: `판정할 부품이 없습니다(부품 목록 0개)${tail}` };
  }
  if (p.stale) badges.push({ cls: 'gray', text: '⏱', title: m != null ? `인벤토리가 ${m}분 전 값입니다 — 지금 상태와 다를 수 있습니다` : '인벤토리가 오래됐습니다' });
  // 정렬: 나쁜 것이 크다(장애 > 경고 > 확인 불가 > 정상). 판정 불가는 '' — STable 이 항상 뒤로 보낸다.
  return { badges, sort: fault * 1_000_000 + warn * 1_000 + Math.min(unknown, 999), title: '' };
}

/**
 * 상세 '부품 상태' 머리 한 줄.
 * @returns {{tone:string, text:string}}
 */
export function partsHeadline(p, now = Date.now()) {
  if (!p) return { tone: 'gray', text: '부품 상태를 받지 못했습니다.' };
  if (!p.judged) return { tone: 'gray', text: `판정 불가 — ${partsReasonText(p.reason)}.` };
  const bits = [];
  if (p.fault) bits.push(`장애 **${p.fault}**`);
  if (p.warn) bits.push(`경고 **${p.warn}**`);
  if (p.unknown) bits.push(`확인 불가 ${p.unknown}`);
  if (p.absent) bits.push(`빈 슬롯 ${p.absent}`);
  bits.push(`정상 ${p.ok || 0}`);
  const m = ageMin(p.collectedAt, now);
  const when = m != null ? ` · 인벤토리 ${m}분 전${p.stale ? '(오래됨 — 지금 상태와 다를 수 있습니다)' : ''}` : '';
  const tone = p.fault ? 'red' : p.warn ? 'amber' : p.unknown ? 'gray' : 'green';
  return { tone, text: `부품 ${p.total || 0}개 — ${bits.join(' · ')}${when}` };
}

/** 상세: 일부 종류 수집 실패 안내(없으면 빈 문자열). */
export function failedKindsNote(p) {
  const f = Array.isArray(p?.failedKinds) ? p.failedKinds : [];
  if (!p?.judged || !f.length) return '';
  return `이번 인벤토리에서 일부 종류를 읽지 못했습니다(${f.join(', ')}) — 그 종류는 판정하지 않았습니다(정상이라는 뜻이 아닙니다).`;
}

/** 엣지 축약 인벤토리에 상태 필드가 없을 때(2.728 이전 엣지) 표 위 한 줄. 판정은 서버 statusMissing. */
export function statusMissingNote(resp) {
  if (!resp?.remote || resp?.statusMissing !== true) return '';
  return '이 서버는 엣지 축약 인벤토리라 상태 값이 없습니다 — 엣지를 2.728 이상으로 올리면 보입니다.';
}

/**
 * 상세: 파트 장애 기능(기록·알림) 연결 안내.
 * @param {object} pf    응답 partFault
 * @param {{allowed:boolean}} o  특수 기능 '파트 장애' 도구 허용 여부(웹 toolAllowed)
 * @returns {null|{tone:string, text:string, link:string|null, linkText:string, hint:string}}
 */
export function partFaultNote(pf, { allowed = true } = {}) {
  if (!pf || typeof pf !== 'object') return null;
  const srcNote = pf.source === 'env' ? ' (portal.env 의 PARTFAULT_ENABLED 로 정해짐)'
    : pf.source === 'demo' ? ' (데모 모드 — 설정 파일과 무관하게 켜진 것처럼 동작)' : '';
  const canLink = allowed && !pf.scoped;
  const link = canLink ? '#/tools/part-faults' : null;
  const hint = !allowed ? '이 계정에는 특수 기능 › 파트 장애 도구가 허용되지 않았습니다.'
    : pf.scoped ? '특수 기능 › 파트 장애 화면은 전체 범위(vCenter 제한 없는) 계정만 열 수 있습니다.' : '';
  if (!pf.enabled) {
    return { tone: 'amber', link, linkText: '파트 장애 설정 열기', hint,
      text: `장애 기록·알림(특수 기능 › 파트 장애)은 **꺼져 있습니다**${srcNote} — 켜면 상태가 바뀔 때 기록·알림이 남습니다. 위 요약은 지금 인벤토리로 본 표시일 뿐 기록되지 않습니다.` };
  }
  if (pf.edgeEnabled === false) {
    return { tone: 'amber', link, linkText: '파트 장애 열기', hint,
      text: '중앙에서는 장애 기록·알림이 켜져 있지만 **이 서버를 수집하는 엣지에는 꺼져 있습니다**(엣지별 설정) — 이 서버의 장애는 기록되지 않습니다.' };
  }
  const open = Array.isArray(pf.open) ? pf.open.length + (pf.omitted || 0) : 0;
  const rec = pf.dbAvailable === false
    ? ' 아직 기록 DB 가 없습니다(첫 점검 전).'
    : open ? ` 이 서버의 열린 장애 기록 **${open}건**.` : ' 이 서버의 열린 장애 기록은 없습니다.';
  return { tone: open ? 'red' : 'green', link, linkText: '파트 장애 열기', hint,
    text: `장애 기록·알림(특수 기능 › 파트 장애)이 켜져 있습니다${srcNote} — 상태가 바뀔 때 기록·알림이 남습니다.${rec}` };
}
