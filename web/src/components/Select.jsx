import React, { forwardRef } from 'react';
import { sortSelectChildren } from './selectSort.js';

/**
 * 공용 드롭다운(v2.708) — 날 `<select>` 대신 이것을 쓴다(테스트가 날 select 를 금지한다).
 * 기본으로 선택지를 보이는 글자 순으로 정렬하고 '전체·선택…' 같은 고정 선택지는 맨 위에 둔다(selectSort.js).
 * 기간·심각도·권장 먼저처럼 **순서가 곧 뜻인 목록**은 `sort={false}` 로 원래 순서를 지킨다.
 */
const Select = forwardRef(function Select({ sort = true, children, ...rest }, ref) {
  return <select ref={ref} {...rest}>{sort ? sortSelectChildren(children) : children}</select>;
});

export default Select;
