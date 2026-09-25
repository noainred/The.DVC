/**
 * views/tools/storageFaultText.js — 스토리지 '장애 장비' 판정·문구(v2.615, 순수 모듈 — React import 없음).
 *
 * 사용자 요청: "'미해결 정보' 를 '장애 장비' 로 변경하고, 장애가 발생한 장비의 숫자를 표시하고, 장애 숫자를
 * 클릭하면 장애 발생한 장비들만 모아서 보여주는 화면을 만들어줘".
 *
 * ── 왜 '미해결 경보' 를 뺐나 ────────────────────────────────────────────────────
 * 그 카드는 `snap.alerts.unresolved` 의 **전 장비 합**이었다(이 현장 수천 건). 정보성 이벤트가 섞여
 * 숫자가 커도 조치로 이어지지 않았고, **장비 몇 대가 문제인가** 에는 답하지 못했다.
 *
 * ── ⚠⚠ v2.567 → v2.568 철회의 교훈 — 판정 신호는 하나뿐이다 ────────────────────
 * v2.567 은 같은 카드를 만들면서 장비가 보고한 **헬스 문자열**(`extra.healthState`·`extra.clusterHealth`)을
 * 배지 색 함수(`healthBadge`)에 넣어 빨강이면 장애로 셌다. Isilon 의 `ATTN` 은 **클러스터 레벨 플래그**라
 * 경미한 이벤트에도 켜지므로 실제 3대가 **27대**로 보고됐고 v2.568 에 철회됐다(CLAUDE.md).
 * 그래서 이 모듈의 장애 판정은 **노드 표의 ⚠ 표지와 글자 그대로 같은 조건** 하나다 —
 * `snap.nodes.unhealthy`(수집기가 노드 단위로 센 비정상 대수) > 0.
 *   · 헬스 문자열·경보 개수·`extra.inventory.hardware` 는 **판정에 넣지 않는다**(표시용이다).
 *   · 표지와 이 함수가 다른 조건을 쓰면 '카드는 3대, 표에서 ⚠ 는 5대' 같은 모순이 생긴다 —
 *     그래서 표지도 이 모듈의 `hasNodeFault` 를 쓴다(StorageMonTool.jsx — 소스 스윕 테스트가 고정).
 *
 * ── 세 칸 · 항등식 ─────────────────────────────────────────────────────────────
 * `합계 = 장애 + 정상 + 판정 불가`. **판정 불가를 정상에도 장애에도 넣지 않는다**(v2.519·v2.523·v2.526 규약).
 *   · 정상은 '노드 상태를 실제로 읽었고 비정상이 0' 일 때만이다 — 노드 목록이 있고 그중 상태를 못 읽은
 *     노드가 하나도 없어야 한다. 개수만 주는 수집기(PowerStore 목록의 health 'unknown')·노드 수를 모르는
 *     수집기(Unity SSH 의 count null)·노드 개념이 없는 타입(VMAX)·수집 실패·수집 전은 전부 판정 불가다.
 *   · ⚠ 목록이 상한(64)으로 잘린 것만으로는 판정 불가가 아니다 — 서버 요약 `unhealthy` 는 **전 노드**를
 *     센 값이다(Isilon 66대 중 64대 목록). 판정 불가로 만들면 대형 클러스터가 영원히 '정상' 이 될 수 없다.
 *   · 목록에는 '이상' 노드가 있는데 요약이 0 이면 **정상이라 말하지 않는다**(판정 불가) — 두 값이 어긋난
 *     것이고, 장애로 세면 ⚠ 표지(요약 기준)와 어긋난다.
 * ⚠ 수집 실패는 장애가 아니다 — 옆 KPI '수집 실패/대기' 가 센다. 회선 장애가 장비 장애로 둔갑하지 않게.
 *
 * ⚠ 문구 규칙: 백틱 금지(BoldText 는 `**강조**` 만 해석한다 — 값 인용은 ‘ ’). 숫자는 지어내지 않는다.
 */
import { numOrNull } from '../../numOrNull.js';
import { nodeRows, nodeFaultSummary } from './storageNodeText.js';

/**
 * ⚠ 표지(⚠N 버튼)와 **글자 그대로 같은 조건**. 문자열 수치('2')도 받고, 빈 값·null·'0' 은 장애가 아니다.
 * @param {object|null} snap 장비 스냅샷
 */
export function hasNodeFault(snap) {
  const n = numOrNull(snap?.nodes?.unhealthy);
  return n != null && n > 0;
}

/**
 * 한 장비의 판정.
 * @param {object} row 목록 행 `{ id, snap, ... }`
 * @returns {'fault'|'ok'|'unknown'}
 */
export function deviceFaultKind(row) {
  const s = row?.snap || null;
  if (hasNodeFault(s)) return 'fault';
  // 여기부터는 '정상' 을 말할 근거가 있는지 본다 — 하나라도 없으면 판정 불가.
  if (!s || s.ok === false) return 'unknown';
  const count = numOrNull(s.nodes?.count);
  const unhealthy = numOrNull(s.nodes?.unhealthy);
  if (count == null || count <= 0) return 'unknown';
  if (unhealthy !== 0) return 'unknown';
  const list = nodeRows(s);
  if (!list.length) return 'unknown';                        // 개수만 알고 노드별 상태를 모른다
  if (list.some((r) => r.kind === 'unknown')) return 'unknown'; // 상태를 못 읽은 노드가 있다
  if (list.some((r) => r.kind === 'bad')) return 'unknown';     // 목록은 이상이라는데 요약은 0 — 어긋남
  return 'ok';
}

/** 장애로 판정된 장비만(목록 순서 유지). */
export function faultRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).filter((r) => deviceFaultKind(r) === 'fault');
}

/**
 * KPI 값. ⚠ **항등식 `total = fault + ok + unknown`** 을 테스트가 고정한다.
 * @returns {{total:number, fault:number, ok:number, unknown:number}}
 */
export function faultKpi(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  let fault = 0; let ok = 0; let unknown = 0;
  for (const r of list) {
    const k = deviceFaultKind(r);
    if (k === 'fault') fault += 1;
    else if (k === 'ok') ok += 1;
    else unknown += 1;
  }
  return { total: list.length, fault, ok, unknown };
}

/** 카드 숫자 아래 한 줄 — '경보 미확인 N대 제외' 와 같은 모양. 판정 불가가 있으면 그것이 먼저다. */
export function faultKpiMeta(k) {
  if (!k || !k.total) return '등록된 장비 없음';
  if (k.unknown > 0) return `노드 상태 판정 불가 ${k.unknown}대 제외`;
  if (k.fault > 0) return '클릭하면 장애 장비만 봅니다';
  return `${k.total}대 모두 노드 정상`;
}

/**
 * 카드 색. 장애가 있으면 빨강, **전부 판정했고** 장애 0 이면 초록, 그 밖은 중립(undefined).
 * ⚠ 판정 불가가 섞였는데 초록으로 칠하면 '전부 정상' 이라는 거짓이다. 0 을 경고색으로 칠하지도 않는다.
 */
export function faultKpiAccent(k) {
  if (!k) return undefined;
  if (k.fault > 0) return 'var(--red)';
  if (k.fault === 0 && k.unknown === 0 && k.total > 0) return 'var(--green)';
  return undefined;
}

/** 카드 접근성 문구(title — 평문. BoldText 를 거치지 않으므로 별표를 쓰지 않는다). */
export function faultKpiTitle(k) {
  if (!k || !k.total) return '등록된 스토리지 장비가 없습니다.';
  const bits = [
    `장애 장비 = 노드 열에 ⚠ 표지가 붙은 장비(노드 상태가 비정상인 장비)입니다. 장비 ${k.total}대 중 장애 ${k.fault} · 정상 ${k.ok} · 판정 불가 ${k.unknown}.`,
  ];
  if (k.unknown > 0) {
    bits.push('판정 불가는 수집 실패·수집 전이거나, 노드 개수만 주는 수집기이거나, 노드 정보가 없는 장비입니다 — 정상이라는 뜻이 아닙니다.');
  }
  bits.push('장비가 보고한 헬스 문구와 미해결 경보 개수는 판정에 쓰지 않습니다. 수집 실패는 옆의 ‘수집 실패/대기’ 카드가 셉니다.');
  if (k.fault > 0) bits.push('클릭하면 장애 장비만 봅니다.');
  return bits.join(' ');
}

/**
 * 장애 장비 화면 머리말(BoldText 로 렌더 — `**강조**` 허용, 백틱 금지).
 * @param {{total,fault,ok,unknown}} k 전체 장비 기준 KPI
 * @param {number} shownFaultCount 법인·종류 필터·찾기를 적용한 뒤 보이는 장애 장비 수
 */
export function faultViewNote(k, shownFaultCount) {
  if (!k || !k.total) return '등록된 장비가 없습니다.';
  const unknownText = k.unknown > 0
    ? ` 노드 상태를 판정하지 못한 장비 ${k.unknown}대는 여기에 넣지 않았습니다(정상이라는 뜻이 아닙니다).`
    : '';
  if (!k.fault) {
    return k.unknown > 0
      ? `장애로 판정된 장비가 없습니다 — 다만 **노드 상태 판정 불가 ${k.unknown}대**가 있어 ‘장애 없음’ 이라고 단정할 수 없습니다.`
      : '장애로 판정된 장비가 없습니다 — 모든 장비의 노드 상태가 정상입니다.';
  }
  const shown = Math.max(0, Math.min(k.fault, Number(shownFaultCount) || 0));
  const hidden = k.fault - shown;
  let s = `**장애 장비 ${k.fault}대** — 노드 ⚠ 표지가 붙은 장비(노드 상태가 비정상인 장비)만 모았습니다.`;
  if (hidden > 0) s += ` 법인·종류 필터나 찾기 때문에 **${hidden}대가 가려져 있습니다**(보이는 것 ${shown}대).`;
  s += unknownText;
  s += ' 장비가 보고한 헬스 문구(ATTN 등)와 미해결 경보 개수는 판정에 쓰지 않습니다.';
  return s;
}

/**
 * 장애 장비의 **비정상 노드** 행(두 번째 표). 노드 이름을 지어내지 않는다.
 *  · 목록에서 이상으로 보이는 노드 → 노드 하나당 한 행.
 *  · 요약 대수가 목록의 이상 노드보다 많으면(목록 없음·개수만 주는 수집기·64 상한·수집 시점 차이)
 *    **장비당 한 행**으로 '어느 노드인지 알 수 없음 N대' 를 적는다.
 * @returns {Array<{key,deviceId,deviceName,datacenterId,type,label,ip,health,kind:'bad'|'unidentified',count:number,reason:string}>}
 */
export function faultNodeRows(rows = []) {
  const out = [];
  for (const r of faultRows(rows)) {
    const s = r.snap || null;
    const sum = nodeFaultSummary(s);
    const deviceName = String(s?.name || r.name || r.host || r.id || '');
    const base = { deviceId: r.id, deviceName, datacenterId: r.datacenterId, type: r.type };
    for (const b of sum.badRows) {
      out.push({ ...base, key: `${r.id}:${b.key}`, label: b.label, ip: b.ip, health: b.health, kind: 'bad', count: 1, reason: '' });
    }
    const rest = sum.unhealthy - sum.badRows.length;
    if (rest > 0) {
      let reason;
      if (!sum.listed) reason = '이 수집기는 노드 개수만 알려 주고 노드별 상태 목록을 주지 않습니다.';
      else if (sum.missing > 0) reason = `노드 목록이 전체 ${sum.count}대 중 ${sum.listed}대만 올라왔습니다(목록 상한).`;
      else reason = '요약 대수와 목록이 어긋납니다 — 수집 시점 차이일 수 있습니다.';
      out.push({
        ...base, key: `${r.id}:unidentified`, label: `어느 노드인지 알 수 없음 ${rest}대`,
        ip: '', health: '', kind: 'unidentified', count: rest, reason,
      });
    }
  }
  return out;
}
