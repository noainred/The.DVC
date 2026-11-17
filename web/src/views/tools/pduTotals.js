/**
 * PDU 목록·KPI 합계(순수 — vitest 고정, v2.606 감사 WEB2606-05).
 *
 * 서버는 데이지체인 유닛 탐지가 E1xx 아닌 실패로 멈추면 summary.unitsIncomplete(합계 전력이 부분 합),
 * 센서 탐지가 멈추면 summary.sensorsIncomplete 를 싣는다(pdu/types.js summarize). 예전 화면은 두 필드를
 * 한 곳도 읽지 않아 표의 전력 칸과 '총 전력' 카드가 유닛 1 만의 값을 전체처럼 보였고, 전력을 못 읽은
 * 장비는 개수 없이 합계에서 빠졌다. 합계는 그대로 내되 **무엇이 빠졌는지 개수로** 함께 낸다.
 */

import { unitText } from '../unitText.js'; // 79회차 반증(v3.18.9 verify): '—'대 는 0대처럼 읽힌다(BUG-20 규약)

/** 장비 목록 → { powerW, units, sensors, tempMaxC, powerPartial, powerMissing, sensorsPartial }. */
export function pduTotals(devices) {
  let powerW = null; let units = 0; let sensors = 0; const temps = [];
  let powerPartial = 0; let powerMissing = 0; let sensorsPartial = 0;
  for (const d of devices || []) {
    const s = d?.snapshot;
    if (!s) { powerMissing += 1; continue; }   // 수집된 적이 없는 장비도 '전력을 모르는' 장비다
    const sum = s.summary || {};
    units += sum.units || 0;
    sensors += sum.sensors || 0;
    if (sum.powerW != null) {
      powerW = (powerW ?? 0) + sum.powerW;
      if (sum.unitsIncomplete || sum.powerPartial) powerPartial += 1;   // 78회차 F4: 유닛 일부의 전력만 못 읽은 장비도 부분 합
    } else powerMissing += 1;
    if (sum.sensorsIncomplete) sensorsPartial += 1;
    if (sum.tempMaxC != null) temps.push(sum.tempMaxC);
  }
  return { powerW, units, sensors, tempMaxC: temps.length ? Math.max(...temps) : null, powerPartial, powerMissing, sensorsPartial };
}

/** '총 전력' 카드 아래 한 줄 — 빠진 것이 없으면 ''(말할 것이 없다). */
export function pduTotalNote(t) {
  if (!t) return '';
  const parts = [];
  if (t.powerPartial) parts.push(`부분 합 ${t.powerPartial}대 포함`);
  if (t.powerMissing) parts.push(`전력 미수집 ${t.powerMissing}대 제외`);
  return parts.join(' · ');
}

/** 표 전력 칸의 '부분 합' 표지 — 없으면 null. title 에 사유를 담는다. */
export function pduPowerMark(summary) {
  if (summary?.unitsIncomplete) {
    return {
      label: '부분 합',
      title: '데이지체인 유닛 일부의 전력을 읽지 못해 탐지를 멈췄습니다 — 이 값은 읽은 유닛만의 합입니다(상세의 안내 참고).',
    };
  }
  // 78회차 F4: 유닛은 다 찾았는데 그중 일부의 순시 전력 값을 못 읽었다(서버 summarize powerPartial).
  if (summary?.powerPartial) {
    const read = Number.isFinite(summary.powerUnitsRead) ? summary.powerUnitsRead : null;
    return {
      label: '부분 합',
      title: `유닛 ${unitText(summary.units, '대')} 중 ${read != null ? unitText(read, '대') : '일부'}의 전력만 읽었습니다 — 이 값은 읽은 유닛만의 합입니다(상세에서 값이 '—' 인 유닛).`,
    };
  }
  return null;
}
