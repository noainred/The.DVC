/**
 * components/boldText.jsx — 서버가 만든 안내 문구의 `**강조**` 를 안전하게 굵게 렌더한다(v2.440).
 *
 * 왜: 진단·조치 문구는 서버(순수 모듈)에서 만들고 화면은 그대로 뿌리는데, 강조를 마크다운으로 쓰면
 * React 가 해석하지 않아 **별표가 그대로 화면에 보인다**(v2.439 중계 경로 판정문에서 실제 발생,
 * v2.440 스캔 조치 카드에서도 재발). dangerouslySetInnerHTML 없이 React 요소 배열로만 만들어
 * 서버 문구가 HTML 을 주입할 수 없게 한다.
 */
import React from 'react';

/** '**a** b' → [{b:true,t:'a'},{b:false,t:' b'}] (순수). 짝이 안 맞는 `**` 는 그대로 글자로 남긴다. */
export function boldParts(text) {
  const s = String(text ?? '');
  const out = [];
  let i = 0;
  for (;;) {
    const open = s.indexOf('**', i);
    if (open < 0) break;
    const close = s.indexOf('**', open + 2);
    if (close < 0) break;                       // 닫는 표시가 없으면 강조로 보지 않는다
    if (close === open + 2) { i = open + 2; continue; }   // '****' 빈 강조는 무시
    if (open > i) out.push({ b: false, t: s.slice(i, open) });
    out.push({ b: true, t: s.slice(open + 2, close) });
    i = close + 2;
  }
  if (i < s.length) out.push({ b: false, t: s.slice(i) });
  return out.length ? out : [{ b: false, t: s }];
}

/** 서버 안내 문구 렌더 — `**강조**` 만 처리하고 나머지는 평문 그대로. */
export default function BoldText({ text }) {
  return <>{boldParts(text).map((p, i) => (p.b ? <b key={i}>{p.t}</b> : <React.Fragment key={i}>{p.t}</React.Fragment>))}</>;
}
