/**
 * insight-tools/ToolParts.jsx — 특수 기능 요약 패널의 작은 내부 부품(v3.21.0).
 *   패널 머리(받은 시각 · 다시 받기) · 받는 중 / 못 받음 / 다시 받기 실패 표시 · 큰 숫자 · 작은 타일 3개 · 조각 막대 · 범례 · ‘모두 보기 →’ · 상위 목록 표(STable).
 * 큰 숫자 · 작은 타일 · 조각 막대(수) · 순서 막대는 공용 views/insight/InsightParts.jsx 를 쓴다. 여기 SegBar 는 조각 위에 수가 아닌 글(‘사용 52%’)을
 *   적어야 하는 ‘과할당’ 의 두 조각 막대용이다 — 공용 StackBar 가 조각 글을 받게 되면 합칠 것.
 */
import React from 'react';
import { ErrorBox } from '../../../components/ui.jsx';
import { STable } from '../../../components/STable.jsx';
import { errorBoxInput } from '../../../components/accessDeniedText.js';
import { receivedText, segsOf, toolHref, emptyViewText } from './toolSumText.js';

/** 패널 머리 — 제목 · 설명 · 오른쪽(기준 글 · 받은 시각 · 다시 받기). */
export function PanelHead({ title, hint, rule, q, onReload }) {
  const rt = receivedText(q?.at);
  return (
    <div className="vit-ph">
      <h2>{title}</h2>
      {hint && <span className="vit-hint">{hint}</span>}
      <span className="vit-rt">
        {rule && <span>{rule}</span>}
        {q?.loading ? <span>받는 중…</span> : rt && <span>{rt}</span>}
        {onReload && (
          <button type="button" className="vit-btn" disabled={!!q?.loading} aria-busy={q?.loading || undefined} onClick={onReload}
            title="이 패널의 요약만 다시 받습니다(다른 패널은 그대로)">{q?.loading ? '받는 중…' : '↻ 다시 받기'}</button>
        )}
      </span>
    </div>
  );
}

/**
 * 받는 중 · 못 받음 · 다시 받기 실패 — 값이 없으면 이것만 그린다(children 을 그리지 않는다).
 *   403 은 ErrorBox 가 권한 안내로 바꾼다(오류로 보이지 않게). 값이 있는데 다시 받기가 실패하면 값 + 한 줄 안내.
 */
export function PanelState({ q, waitText = '요약을 받는 중입니다…', view = null, children }) {
  if (!q?.data) {
    if (q?.error) return <ErrorBox message={q.error} />;
    return <div className="vit-wait">{waitText}</div>;
  }
  // view.empty(고른 법인의 줄이 응답에 하나도 없음)면 수 칸 대신 그 사실만(dbg3221 2회차 — 예전: ‘—대 —개’ 칸이 그대로 그려졌다).
  const none = emptyViewText(view);
  return (
    <>
      {q.error && !errorBoxInput(q.error).perm && (
        <div className="vit-note warn">다시 받기에 실패했습니다 — 아래는 {receivedText(q.at) || '이전에 받은'} 값입니다.</div>
      )}
      {none ? <div className="vit-empty">{none}</div> : children}
    </>
  );
}

/** 조각 막대 — 0 인 조각은 그리지 않는다. tall 이면 조각 위에 수를 적는다. */
export function SegBar({ segs, tall = false, label }) {
  const xs = segsOf(segs);
  if (!xs.length) return null;
  return (
    <div className={`vit-stack${tall ? ' tall' : ''}`} role="img" aria-label={label || xs.map((s) => `${s.label} ${s.text ?? s.n}`).join(' · ')}>
      {xs.map((s) => (
        <span key={s.key} style={{ flex: `${s.n} 1 0`, background: s.bg, color: s.ink || '#fff' }} title={s.title || `${s.label} ${s.text ?? s.n}`}>{tall ? (s.text ?? s.n) : ''}</span>
      ))}
    </div>
  );
}

export function Legend({ segs }) {
  const xs = (segs || []).filter((s) => s && s.label);
  if (!xs.length) return null;
  return (
    <div className="vit-lgd">
      {xs.map((s) => <span key={s.key}><i style={{ background: s.bg }} />{s.label} <b>{s.text ?? s.n}</b>{s.extra ? ` · ${s.extra}` : ''}</span>)}
    </div>
  );
}

/**
 * ‘모두 보기 →’ — 도구 주소로. 리뷰 정정: 고른 법인 1곳을 메모리 인계(handoffSearch 'tools:vcenter')로 남기던 것을 걷어냈다 —
 *   받는 쪽(SpecialTools)이 없어 도구는 늘 전체 범위로 열렸고, 인계를 남길 때마다 다른 대기 인계(⌘K 검색어 등)를 지웠다(handoffMany 가 통째로 바꾼다).
 *   범위를 들고 가려면 받는 쪽을 먼저 만든 뒤 다시 붙인다(v2.959 — 받는 쪽 없는 인계는 두지 않는다). vcIds 는 그때를 위해 받아 둔다.
 */
export function ToolLink({ toolKey, sub = '', vcIds, children, secondary = false }) {
  return <a className={secondary ? 'vit-lnk2' : 'vit-lnk'} href={toolHref(toolKey, sub)}>{children}</a>;
}

/** 사용률 · 크기 막대 한 칸 — w(%) · 색 · 기준 세로줄(mark %). */
export function Gauge({ w, bg, mark = null, note }) {
  return (
    <>
      <span className="vit-gt" aria-hidden="true">
        <i style={{ width: `${Math.max(0, Math.min(100, Number(w) || 0))}%`, background: bg }} />
        {mark != null && <em style={{ left: `${Math.max(0, Math.min(100, mark))}%` }} />}
      </span>
      {note && <span className="vit-fr">{note}</span>}
    </>
  );
}

/**
 * 상위 목록 표 — STable(제목 클릭 정렬). rows 는 이미 고른 상위 N(도구 순서)이다 — 표는 그 안에서만 다시 정렬한다.
 * @param {{label:string, cls?:string, width?:string}[]} cols
 * @param {{key:string, cells:{node:any, sort?:any, cls?:string, title?:string}[]}[]} rows
 */
export function TopTable({ cols, rows, empty = '이 범위에는 없습니다.', label }) {
  if (!rows || !rows.length) return <div className="vit-empty">{empty}</div>;
  return (
    <STable className="vit-tbl" aria-label={label}>
      <colgroup>{cols.map((c, i) => <col key={i} style={c.width ? { width: c.width } : undefined} />)}</colgroup>
      <thead><tr>{cols.map((c, i) => <th key={i} className={c.cls || undefined}>{c.label}</th>)}</tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            {r.cells.map((c, i) => (
              <td key={i} className={c.cls || undefined} data-sort={c.sort == null ? undefined : c.sort} title={c.title || undefined}>{c.node}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </STable>
  );
}

/** 이름 + 아래 한 줄(법인 · OS 등). */
export function NameCell({ name, sub }) {
  return <><span className="vit-nm" title={name}>{name || '—'}</span>{sub && <span className="vit-sb" title={sub}>{sub}</span>}</>;
}
