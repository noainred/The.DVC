/**
 * STable — `<table>` 대체 컴포넌트(v2.422, 사용자 요구 '데이터 조회 화면의 모든 표는 제목 클릭 정렬, 기억해줘').
 *
 * 쓰는 법: `<table …>` 을 `<STable …>` 으로 바꾸기만 하면 된다(props 그대로 전달). 헤더(thead 마지막 tr 의 th)를
 * 클릭하면 tbody 의 행을 그 열의 **셀 내용**으로 정렬한다(asc → desc → 해제). 정렬 로직은 components/sortableText.js.
 *
 * 자동 비활성(기존 동작 보존):
 *  - th 에 이미 onClick 이 있거나 th 가 컴포넌트(<SortTh>/<Th>)인 표 → 그 표는 자체 정렬을 쓰므로 손대지 않는다.
 *  - th 가 입력/버튼을 품거나 colSpan>1 이거나 `data-nosort` 면 그 열만 제외. `sortable={false}` 로 표 전체 제외.
 *  - thead 가 없거나 tbody 가 없으면 그대로 렌더.
 * ⚠⚠ `limit`(v2.575 BUG-19): 행을 **정렬한 뒤** 자른다. 호출부에서 `rows.slice(0, N)` 으로 먼저
 *   자르면 표는 '전체를 정렬한 상위 N' 이 아니라 **'앞 N 을 정렬한 것'** 이 된다 — 사용자가 열을
 *   눌러 '크기 상위' 를 보려 해도 원래 순서의 앞 N 안에서만 정렬되므로 **오류 없이 틀린 표**다
 *   (v2.556 이 `DataTable` 에 같은 이유로 `limit` 을 넣으며 "정렬 뒤 자른다" 를 못 박았는데
 *   `STable` 에는 그 수단이 없어 호출부 6곳이 먼저 자르고 있었다). 상한으로 뺀 개수는 호출부가
 *   **말해야 한다**(조용한 상한 금지) — 그래서 컴포넌트가 문구를 만들지 않는다.
 * ⚠⚠ `minWidth`(v2.575 BUG-23/IMP-12): 다열 표는 **가로 스크롤 컨테이너 + 표의 `minWidth`** 가
 *   **둘 다** 있어야 한다. 래퍼만 있으면 `table { width:100% }` 때문에 브라우저가 스크롤 대신
 *   **열을 짜부라뜨려** 400px 에서 셀이 한두 글자 폭이 되고 행이 세로로 길어진다 — **넘침은 0px
 *   이라 수치로는 안 잡히고 스크린샷을 읽어야 보인다**(v2.562 실측 6,054px → 3,471px).
 *   반대로 `minWidth` 만 있고 래퍼가 없으면 **페이지가 통째로 가로로 밀린다**. 이 짝을 손으로
 *   맞추다 한쪽을 빠뜨리는 것이 이 저장소의 반복 사고라, `minWidth` 를 주면 컴포넌트가
 *   **래퍼까지 함께** 만든다. 이미 스크롤 래퍼 안이면 `wrap={false}` 로 바깥 것을 쓴다.
 * 정렬은 화면(엘리먼트) 재배열이라 서버·상태를 건드리지 않고, 데이터가 갱신돼도 마지막 정렬이 유지된다.
 * 셀에 컴포넌트가 있으면 텍스트 자식 → value/pct/label 순으로 값을 찾고, 정확한 값을 원하면 td 에 `data-sort` 를 준다.
 */
import React, { useMemo, useState } from 'react';
import { headerSortable, sortChildren, nextSortState } from './sortableText.js';

const ARROW = { asc: '▲', desc: '▼' };

export function STable({ sortable = true, limit = 0, minWidth = 0, wrap, children, ...rest }) {
  const [sort, setSort] = useState(null); // { col, dir } | null
  // ⚠ Children.toArray 는 호출마다 새 엘리먼트(키 접두)를 만들므로 **한 번만** 호출해 그 배열 안에서 동일성 비교한다.
  const kids = React.Children.toArray(children);
  const thead = sortable ? kids.find((c) => React.isValidElement(c) && c.type === 'thead') : null;
  const tbody = sortable ? kids.find((c) => React.isValidElement(c) && c.type === 'tbody') : null;

  /**
   * v2.503 성능: 정렬이 켜져 있으면 **매 렌더** 전량 재정렬이었다. 이 화면들은 15초 폴링으로
   * 리렌더되므로 데이터가 그대로여도 틱마다 비용을 다시 냈다(1,100행 실측 — Collator 수정 전
   * 52.6ms, 수정 후 2.5ms. 그래도 공짜는 아니다). tbody 자식 참조가 그대로면 결과를 재사용한다.
   * 의존성이 참조 동일성이므로, 부모가 새 엘리먼트를 만들면(폴링으로 같은 값이 다시 와도) 재정렬한다
   * — 정확성을 캐시보다 앞에 둔다. 같은 렌더 안의 중복 계산과 정렬과 무관한 상태 변경에서의
   * 재정렬은 이것으로 사라진다.
   *
   * ⚠ **훅은 조기 return 위에 있어야 한다**(루트 CLAUDE.md 프론트 회귀 방지 — 아래 `if (!thead …)`
   * 세 개보다 반드시 앞. 뒤로 옮기면 렌더 간 훅 개수가 달라져 React #310 으로 화면 전체가 크래시한다).
   * 그래서 tbody 가 없을 수도 있는 시점이라 옵셔널 체이닝으로 읽는다. 자체 정렬 표(selfSorted)는
   * `setSort` 가 연결되지 않아 `sort` 가 영원히 null 이므로 여기서 계산이 일어나지 않는다.
   */
  const tbodyKids = tbody?.props?.children;
  const sortedKids = useMemo(
    () => (sort && tbodyKids !== undefined ? sortChildren(tbodyKids, sort.col, sort.dir) : null),
    [sort, tbodyKids],
  );

  // 상한은 정렬 결과에 적용한다. 정렬 전(초기 렌더)이면 원래 순서의 앞 N — 호출부가 먼저
  // 자르던 예전 동작과 같고, 열을 누른 순간부터 '전체를 정렬한 상위 N' 이 된다.
  const cap = Number(limit) > 0 ? Math.floor(Number(limit)) : 0;
  const capKids = (kids2) => (cap > 0 ? React.Children.toArray(kids2).slice(0, cap) : kids2);

  // minWidth 를 주면 표에 최소폭을 걸고 **가로 스크롤 래퍼까지 함께** 만든다(짝을 놓칠 수 없게).
  const mw = Number(minWidth) > 0 ? Number(minWidth) : 0;
  const doWrap = wrap === undefined ? mw > 0 : !!wrap;
  const tableProps = mw > 0 ? { ...rest, style: { minWidth: mw, ...(rest.style || {}) } } : rest;
  const render = (inner) => {
    const t = <table {...tableProps}>{inner}</table>;
    return doWrap ? <div style={{ overflowX: 'auto', maxWidth: '100%' }}>{t}</div> : t;
  };

  if (!thead || !tbody) return render(children);

  const headKids = React.Children.toArray(thead.props.children);
  const headRows = headKids.filter((r) => React.isValidElement(r) && r.type === 'tr');
  const lastRow = headRows[headRows.length - 1];
  if (!lastRow) return render(children);
  const ths = React.Children.toArray(lastRow.props.children);
  // 자체 정렬 표(컴포넌트 th 또는 onClick th)는 손대지 않는다.
  const selfSorted = ths.some((t) => React.isValidElement(t) && (typeof t.type !== 'string' || t.props?.onClick));
  if (selfSorted) return render(children);

  let col = 0;
  const newThs = ths.map((th, idx) => {
    if (!React.isValidElement(th)) return th;
    const myCol = col; col += Number(th.props?.colSpan) || 1;
    if (!headerSortable(th)) return th;
    const active = sort && sort.col === myCol;
    return React.cloneElement(th, {
      key: th.key ?? `h${idx}`,
      onClick: (e) => { th.props.onClick?.(e); setSort((c) => nextSortState(c, myCol)); },
      style: { cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap', ...(th.props.style || {}) },
      title: th.props.title || '클릭하면 이 열로 정렬합니다(오름차순 → 내림차순 → 해제).',
      'aria-sort': active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none',
    }, th.props.children, <span aria-hidden="true" style={{ opacity: active ? 1 : 0.28, marginLeft: 3, fontSize: '0.85em' }}>{active ? ARROW[sort.dir] : '↕'}</span>);
  });
  const newLast = React.cloneElement(lastRow, {}, newThs);
  const newThead = React.cloneElement(thead, {}, headKids.map((r) => (r === lastRow ? newLast : r)));
  const bodyKids = sort ? sortedKids : tbodyKids;
  const newTbody = (sort || cap > 0) ? React.cloneElement(tbody, {}, capKids(bodyKids)) : tbody;
  const out = kids.map((c) => (c === thead ? newThead : c === tbody ? newTbody : c));
  return render(out);
}

export default STable;
