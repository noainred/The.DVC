/**
 * 스토리지 시리얼 표시(v2.735.2, 사용자 요청 PowerScale·Unity·XtremIO 시리얼 표시) — 순수 문구 모듈.
 *
 * 서버는 시리얼을 읽으면 `snap.serial`(장비) · `nodes.list[].serial`(PowerScale 노드)을, 못 읽으면 사유를
 * `extra.serialProbe` · `extra.nodeSerialProbe` 로 싣는다. 화면은 값을 **지어내지 않고** 못 읽은 이유를 말한다.
 * 라벨은 출처의 뜻을 따른다 — OneFS REST 의 GUID 는 장비 시리얼이 아니고, XtremIO 의 PSNT 는 제품 시리얼 태그다.
 */

/** 서버 사유 코드 → 문구(서버 `isilonHw.js`·`unitySsh.js`·`xtremio*.js` 의 reason 과 1:1). */
export const SERIAL_REASON_TEXT = Object.freeze({
  budget: '이번 수집 세션이 길어 시리얼 조회를 시작하지 않았습니다 — 다음 주기에 다시 시도합니다',
  parse: '명령은 실행됐지만 출력에서 시리얼을 읽지 못했습니다',
  empty: '명령 출력이 비어 있습니다(계정 권한·셸 제한일 수 있습니다)',
  exec: '시리얼 조회 명령을 실행하지 못했습니다',
  'no-field': '장비 응답에 시리얼 필드가 없습니다',
  'no-match': '노드 번호와 맞는 시리얼 줄이 없습니다',
  'not-in-output': '버전 명령 출력에서 시리얼 줄을 찾지 못했습니다',
  'not-run': '시리얼을 담은 명령을 실행하지 못했습니다',
});

const t = (v) => (v == null ? '' : String(v).trim());

/** 장비 시리얼 라벨 — 출처 종류(serialKind)를 따른다. 구버전 수집기(종류 없음)는 예전 라벨 그대로. */
export function serialLabel(ex) {
  const k = t(ex?.serialKind);
  if (k === 'guid') return 'GUID';
  if (k === 'psnt') return '시리얼(PSNT)';
  if (k === 'serial') return '시리얼';
  return '시리얼/GUID';
}

/** 못 읽은 이유 한 줄(사유 + 근거). 없으면 ''. */
export function serialProbeText(probe) {
  if (!probe || typeof probe !== 'object') return '';
  const head = SERIAL_REASON_TEXT[probe.reason] || '시리얼을 읽지 못했습니다';
  const parts = [head];
  if (t(probe.detail) && t(probe.detail) !== head) parts.push(t(probe.detail));
  if (Array.isArray(probe.seenKeys) && probe.seenKeys.length) parts.push(`응답에 있던 비슷한 키: ${probe.seenKeys.slice(0, 12).join(', ')}`);
  else if (probe.keyCount) parts.push(`응답 키 ${probe.keyCount}개 중 시리얼로 보이는 키가 없습니다`);
  if (t(probe.source)) parts.push(`출처: ${t(probe.source)}`);
  return parts.join(' · ');
}

/**
 * 머리줄 항목 — { label, value, title } 또는 { label, missing:true, title } 또는 null(표시할 것이 없음).
 * 시리얼이 없어도 서버가 사유를 실었으면 '미확인' 으로 보인다(빈칸으로 두면 기능이 없는 것처럼 보인다).
 */
export function serialHeader(snap) {
  const ex = snap?.extra || {};
  const value = t(snap?.serial);
  if (value) {
    const src = t(ex.serialSource) || t(ex.serialKey);
    return { label: serialLabel(ex), value, title: src ? `출처: ${src}` : '' };
  }
  if (ex.serialProbe) return { label: '시리얼', missing: true, title: serialProbeText(ex.serialProbe) };
  return null;
}

/** 노드 표에 '시리얼' 열을 둘지 — 값이 하나라도 있거나 서버가 노드 시리얼을 시도했으면 둔다. */
export function showNodeSerialCol(nodeList, ex) {
  return (Array.isArray(nodeList) && nodeList.some((n) => t(n?.serial))) || !!ex?.nodeSerials || !!ex?.nodeSerialProbe;
}

/** 노드 시리얼 칸의 title — 섀시 시리얼·제품명(값이 있을 때만). */
export function nodeSerialTitle(n) {
  const parts = [];
  if (t(n?.chassisSerial)) parts.push(`섀시 시리얼 ${t(n.chassisSerial)}`);
  if (t(n?.model)) parts.push(`제품 ${t(n.model)}`);
  return parts.join(' · ');
}

/** 노드 표 아래 한 줄 — 몇 대 읽었는지·못 읽은 이유. 다 읽었으면 출처·시각만. */
export function nodeSerialNote(ex, shownCount) {
  const ns = ex?.nodeSerials;
  const probe = ex?.nodeSerialProbe;
  if (probe && (!ns || !ns.read)) return `노드 시리얼 — ${serialProbeText(probe)}`;
  if (!ns) return '';
  const total = Number.isFinite(ns.total) ? ns.total : shownCount;
  const at = ns.at ? ` · ${new Date(ns.at).toLocaleString('ko-KR')} 조회${ns.cached ? '(6시간마다 다시 읽음)' : ''}` : '';
  const miss = total - (ns.read || 0);
  return `노드 시리얼 ${ns.read || 0}/${total}대 읽음${miss > 0 ? ` — ${miss}대는 '—'(그 노드의 시리얼이 응답에 없음)` : ''}${ns.source ? ` · 출처 ${ns.source}` : ''}${at}`;
}
