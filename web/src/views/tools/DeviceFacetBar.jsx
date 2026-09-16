import React from 'react';
import { SearchBox } from '../../components/ui.jsx';

/**
 * 법인·장비 종류 필터 바(공용 · v2.532).
 *
 * 사용자 요청(스토리지 증가량): "장비 종류별로 볼 수 있도록 해줘, 이건 **다른 화면에서 사용했던
 * 메뉴와 동일하게** 만들어줘" — '동일하게' 를 지키는 방법은 **같은 컴포넌트를 쓰는 것**이다.
 * v2.407 에 `StorageMonTool` 이 갖고 있던 마크업을 여기로 옮겼고 두 화면이 공유한다.
 * 판정(칩 목록·개수·필터)은 `deviceFacets.js` 가 갖는다 — 여기는 그리기만 한다.
 *
 * ⚠ **표시 조건은 '필터 결과' 가 아니라 '전체 장비 수' 로 판단할 것**(호출부 책임):
 *   검색 결과가 0건일 때 바가 통째로 사라지면 그 안의 검색창까지 없어져 사용자가 자기가 친
 *   글자를 지울 수 없다(무결과 = 영구 빈 화면). StorageMonTool 이 실제로 그 상태를 만들었다.
 * ⚠ 검색창·해제 버튼은 **2줄 끝**에 모은다 — 1줄(법인 칩) 끝에 두면 칩이 많을 때 auto 마진이
 *   검색창을 혼자 다음 줄로 밀어내 떠 보인다(v2.407 실측).
 *
 * @param {object}   p
 * @param {object[]} p.dcChips     `[{dc, list, count}]` (deviceFacets.facetState)
 * @param {object[]} p.typeChips   `[{type, list, count}]`
 * @param {Set}      p.dcSel · p.typeSel
 * @param {Function} p.onToggleDc · p.onToggleType · p.onClear
 * @param {string}   p.query · {Function} p.onQuery
 * @param {Function} p.typeLabel
 * @param {Function} [p.dcMeta]    법인 칩의 부가 표시 `(list) => {dot?, title?, bad?}` — 화면마다
 *                                 다르다(모니터링은 수집 실패·경보, 증가량은 사용률). 없으면 생략.
 */
export default function DeviceFacetBar({
  dcChips = [], typeChips = [], dcSel, typeSel,
  onToggleDc, onToggleType, onClear, query = '', onQuery, typeLabel = (t) => t, dcMeta = null,
}) {
  const facetOn = (dcSel?.size || 0) > 0 || (typeSel?.size || 0) > 0;
  return (
    <div className="vc-quicknav" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
      <div className="flex gap wrap" style={{ alignItems: 'center', gap: 8 }}>
        <span className="qn-label" style={{ minWidth: 74 }}>🏢 법인</span>
        {dcChips.map(({ dc, list, count }) => {
          const on = !!dcSel?.has(dc);
          const meta = dcMeta ? dcMeta(list) : null;
          return (
            <button key={dc} className={`qn-btn${on ? ' on' : ''}${meta?.bad ? ' down' : ''}`}
              aria-pressed={on} onClick={() => onToggleDc?.(dc)}
              title={`${meta?.title || `${dc} — 장비 ${list.length}대`}\n${on ? '클릭하면 선택 해제' : '클릭하면 이 법인만 표시(여러 개 선택 가능)'}`}>
              {meta?.dot ? <span className="qn-dot" style={{ background: meta.dot }} /> : null}{dc}
              <span className="muted" style={{ fontWeight: 400, fontSize: 11 }}>{count}</span>
            </button>
          );
        })}
      </div>
      <div className="flex gap wrap" style={{ alignItems: 'center', gap: 8 }}>
        <span className="qn-label" style={{ minWidth: 74 }}>🗄 장비 종류</span>
        {typeChips.map(({ type, count }) => {
          const on = !!typeSel?.has(type);
          return (
            <button key={type} className={`qn-btn${on ? ' on' : ''}${count === 0 ? ' down' : ''}`}
              aria-pressed={on} onClick={() => onToggleType?.(type)}
              title={`${typeLabel(type)} — 선택된 법인 기준 ${count}대\n${on ? '클릭하면 선택 해제' : '클릭하면 이 종류만 표시(여러 개 선택 가능)'}`}>
              {typeLabel(type)}
              <span className="muted" style={{ fontWeight: 400, fontSize: 11 }}>{count}</span>
            </button>
          );
        })}
        <span className="flex gap" style={{ marginLeft: 'auto', alignItems: 'center', gap: 8 }}>
          <SearchBox className="input" style={{ maxWidth: 250, minWidth: 180 }}
            value={query} onChange={onQuery} placeholder="법인·장비 찾기 (목록 필터)"
            title="입력한 글자가 포함된 법인·장비만 아래 목록에 표시합니다(법인명·장비명·host·타입에서 검색)." />
          {facetOn && (
            <button className="qn-btn" onClick={onClear}
              title="법인·장비 종류 선택을 모두 해제하고 전체를 봅니다.">✕ 필터 해제</button>
          )}
        </span>
      </div>
    </div>
  );
}
