/**
 * Bareos 정책 · 보존(v2.860 — 시안 docs/design/bareos-ui-v2 ④) — 예전 '정책 · 일정'(v2.839 BareosPolicyTab)과 '보존 · 풀'(v2.840 BareosPoolsTab)을
 *   한 화면의 구획으로 합쳤다. 두 탭은 같은 하루 1회 수집본을 읽고 'Director 수집 상태' 표를 두 번 보여 줬다 — 수집 상태는 정책 쪽 표 하나만 남긴다.
 *   주소는 그대로다(#/tools/bareos-summary/policy · …/pools — pools 는 이 화면의 풀 구획으로 내려간다). 도구 키 bareos-summary(조회 전용).
 *   두 구획의 판정 · 문구 · 조회 경로는 각 탭 파일 그대로(bareosPolicyText.js) — 이 파일은 머리 · 바로가기 · 새로고침만.
 */
import React, { useEffect, useState } from 'react';
import VeeamHeader from './VeeamHeader.jsx';
import BareosTabs from './BareosTabs.jsx';
import BareosPolicyTab from './BareosPolicyTab.jsx';
import BareosPoolsTab from './BareosPoolsTab.jsx';
import { FilterChip } from './BareosBits.jsx';

const SECTIONS = [['bp-sched', '다음 7일 일정'], ['bp-defs', '스케줄 · JobDefs · FileSet'], ['bp-vms', 'VM 별 적용 정책'], ['bp-pools', '풀 · 볼륨 · 보존']];
const go = (id) => { const el = document.getElementById(id); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); };

export default function BareosPolicyPage({ focus = 'policy' }) {
  const [reloadKey, setReloadKey] = useState(0);
  // 옛 '보존 · 풀' 주소로 들어오면 풀 구획으로 내려간다(두 구획이 그려진 뒤 — 데이터가 늦게 오면 한 번 더)
  useEffect(() => {
    if (focus !== 'pools') return undefined;
    const t1 = setTimeout(() => go('bp-pools'), 400);
    const t2 = setTimeout(() => go('bp-pools'), 1500);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [focus]);
  return (
    <div data-bareos-policy-page="" style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
      <VeeamHeader active="bareos" desc="Bareos — Director 에서 하루 한 번 수집한 일정 · 정책 · 풀 · 보존을 봅니다(조회 전용 · 이 화면은 Director 에 접속하지 않습니다)." />
      <BareosTabs active="policy" right={(
        <div className="flex gap wrap" style={{ marginLeft: 'auto', alignItems: 'center', rowGap: 6 }}>
          <button type="button" className="tab" onClick={() => setReloadKey((k) => k + 1)} style={{ padding: '6px 14px' }}>새로고침</button>
        </div>
      )} />
      <div className="flex gap wrap" role="navigation" aria-label="구획 바로가기" style={{ rowGap: 6 }}>
        {SECTIONS.map(([id, label]) => <FilterChip key={id} on={false} onClick={() => go(id)}>{label}</FilterChip>)}
      </div>
      <BareosPolicyTab bare reloadKey={reloadKey} />
      <div id="bp-pools" style={{ scrollMarginTop: 80 }}>
        <BareosPoolsTab bare reloadKey={reloadKey} />
      </div>
    </div>
  );
}
