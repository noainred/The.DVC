import React from 'react';
import { sortSelectChildren } from './selectSort.js';

/** 공용 자동완성 목록(v2.708) — 날 `<datalist>` 대신 이것을 쓴다. 제안 목록을 글자 순으로 정렬한다(selectSort.js 와 같은 규칙). */
export default function DataList({ sort = true, children, ...rest }) {
  return <datalist {...rest}>{sort ? sortSelectChildren(children) : children}</datalist>;
}
