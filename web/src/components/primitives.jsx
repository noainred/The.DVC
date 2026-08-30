// primitives.jsx — ui.jsx(구 633줄)에서 분리(v2.295 모듈화 감사 2차 확정 #2·#7). 본문은 원본
// 10~162·608~633행 그대로 이동(기능 변화 없음).
//
// 왜 별도 파일인가(감사 검증자 교정 반영): 프리미티브를 ui.jsx 셸에 남기면 EntityDetail.jsx 가
// 셸을 역참조해 ui.jsx↔EntityDetail.jsx 신규 순환이 생긴다 — SpecialTools 분할(v2.282)의
// shared.jsx 패턴대로 공유 표면을 독립 파일로 빼고 ui.jsx 는 순수 재수출 셸로 만든다.
// ⚠ components/ 아래 파일은 './ui.jsx'(셸)가 아니라 이 파일/Modal.jsx 를 직접 import 할 것 —
// 셸 역참조는 순환의 씨앗이다(views/ 는 셸 사용 유지: 86개 소비자 import 무변경).
import React, { useMemo, useState, useEffect, useRef } from 'react';
// 권한 거부(403) 안내 — AccessDenied 는 api.js 만 참조하므로 이 import 로 순환이 생기지 않는다
// (api.js 는 컴포넌트를 import 하지 않는다). 위 '순환의 씨앗' 주의사항과 배치되지 않음.
import { permissionInfoFor } from '../api.js';
import AccessDenied from './AccessDenied.jsx';

/** VM GPU 배지 — vGPU/패스쓰루/혼합. Vms.jsx 에 있던 것을 공용으로 옮겼다(상세 화면 단일화). */
const GPU_TYPE = { vgpu: ['vGPU', 'green'], passthrough: ['패스쓰루', 'amber'], mixed: ['혼합', 'purple'] };
export function GpuBadge({ gpu }) {
  if (!gpu) return <span className="muted">—</span>;
  const [label, cls] = GPU_TYPE[gpu.type] || ['GPU', 'gray'];
  return (
    <span className={`badge ${cls}`} title={gpu.profile || gpu.model || ''}>
      {label}{gpu.count > 1 ? ` ×${gpu.count}` : ''}{gpu.profile ? ` · ${gpu.profile}` : ''}
    </span>
  );
}

export function usageColor(pct) {
  if (pct >= 90) return 'var(--red)';
  if (pct >= 75) return 'var(--amber)';
  return 'var(--green)';
}

export function Kpi({ label, value, unit, meta, pct, accent, onClick }) {
  return (
    <div
      className={`card kpi${onClick ? ' kpi-click' : ''}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
      title={onClick ? '클릭하여 보기' : undefined}
      style={accent ? { '--kpi-accent': accent } : undefined}
    >
      <div className="label">{label}</div>
      <div className="value" style={accent ? { color: accent } : undefined}>
        {value}
        {unit && <small> {unit}</small>}
      </div>
      {typeof pct === 'number' && (
        <div className="usage-bar">
          <span style={{ width: `${Math.min(pct, 100)}%`, background: usageColor(pct) }} />
        </div>
      )}
      {meta && <div className="meta">{meta}</div>}
    </div>
  );
}

export function UsageCell({ pct }) {
  return (
    <span className="nowrap">
      <span className="mini-bar">
        <span style={{ width: `${Math.min(pct, 100)}%`, background: usageColor(pct) }} />
      </span>{' '}
      <span className="pct tabular">{pct}%</span>
    </span>
  );
}

export function StateBadge({ state }) {
  const map = {
    CONNECTED: ['green', '정상'],
    POWERED_ON: ['green', 'On'],
    MAINTENANCE: ['amber', '점검'],
    POWERED_OFF: ['gray', 'Off'],
    DISCONNECTED: ['red', '연결끊김'],
    SUSPENDED: ['amber', '일시중지'],
    connected: ['green', 'Connected'],
    unreachable: ['red', 'Unreachable'],
    maintenance: ['amber', '점검중'],
    disabled: ['gray', '비활성'],
    pending: ['blue', '대기'],
    RUNNING: ['green', 'Running'],
    OUTDATED: ['amber', 'Outdated'],
    NOT_RUNNING: ['gray', '미실행'],
  };
  const [cls, label] = map[state] || ['gray', state];
  return <span className={`badge ${cls}`}>{label}</span>;
}

export function SeverityBadge({ severity }) {
  const map = { critical: ['red', 'Critical'], warning: ['amber', 'Warning'], info: ['blue', 'Info'] };
  const [cls, label] = map[severity] || ['gray', severity];
  return <span className={`badge ${cls}`}>{label}</span>;
}

/** Sortable, client-side table. columns: [{key,label,render?,align?,sortValue?}] */
export function DataTable({ columns, rows, initialSort, emptyText = '데이터가 없습니다.' }) {
  const [sort, setSort] = useState(initialSort || { key: columns[0].key, dir: 'asc' });
  // 같은 위치의 DataTable이 뷰 전환으로 다른 columns를 받으면(initialSort는 최초 마운트만 반영)
  // 존재하지 않는 컬럼 키에 정렬이 고착돼 사실상 무정렬이 된다 → 키가 사라지면 리셋.
  useEffect(() => {
    if (!columns.some((c) => c.key === sort.key)) {
      // initialSort의 키도 새 columns에 없으면 첫 컬럼으로 — 그대로 쓰면 매 렌더 setSort가
      // 반복돼(columns는 항상 새 배열) 무한 렌더 루프로 뷰가 죽는다.
      const ok = initialSort && columns.some((c) => c.key === initialSort.key);
      setSort(ok ? initialSort : { key: columns[0].key, dir: 'asc' });
    }
    // eslint-disable-next-line
  }, [columns]);

  const sorted = useMemo(() => {
    const col = columns.find((c) => c.key === sort.key);
    const val = (r) => (col?.sortValue ? col.sortValue(r) : r[sort.key]);
    return [...rows].sort((a, b) => {
      const x = val(a), y = val(b);
      if (x == null) return 1;
      if (y == null) return -1;
      const cmp = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
      return sort.dir === 'asc' ? cmp : -cmp;
    });
  }, [rows, sort, columns]);

  const toggle = (key) =>
    setSort((s) => ({ key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' }));

  return (
    <div className="table-wrap" style={{ maxHeight: '64vh' }}>
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} onClick={() => toggle(c.key)} style={{ textAlign: c.align || 'left' }}>
                {c.label}{sort.key === c.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 && (
            <tr><td colSpan={columns.length} className="center muted" style={{ padding: 30 }}>{emptyText}</td></tr>
          )}
          {sorted.map((r, i) => (
            <tr key={r.id || i}>
              {columns.map((c) => (
                <td key={c.key} style={{ textAlign: c.align || 'left' }}>
                  {c.render ? c.render(r) : r[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Standard "총 N개 …" result count, with an indicator when a filter is active. */
export function ResultCount({ total = 0, shown, label, filtered }) {
  return (
    <div className="muted result-count" style={{ marginBottom: 10 }}>
      총 <b style={{ color: 'var(--text)' }}>{total.toLocaleString()}</b>개 {label}
      {shown != null && shown < total && <span> (상위 {shown.toLocaleString()}개 표시)</span>}
      {filtered && <span className="badge blue" style={{ marginLeft: 8 }}>필터 적용 중</span>}
    </div>
  );
}
/**
 * IME(한글) 안전 검색 입력. Controlled 입력이 매 키 입력마다 부모를 리렌더하면
 * 한글 조합이 끊기므로, 로컬 상태로 표시하고 조합 중에는 부모로 onChange를 보내지
 * 않는다(조합 종료/비조합 입력 시에만 전파). 외부 값 변경(탭 전환·초기화)은 조합 중이
 * 아닐 때만 로컬에 반영한다.
 */
export function SearchBox({ value = '', onChange, placeholder, className = 'input', style, onKeyDown }) {
  const [local, setLocal] = useState(value);
  const composing = useRef(false);
  useEffect(() => { if (!composing.current) setLocal(value); }, [value]);
  return (
    <input
      className={className}
      style={style}
      placeholder={placeholder}
      value={local}
      onChange={(e) => { setLocal(e.target.value); if (!composing.current) onChange(e.target.value); }}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={(e) => { composing.current = false; onChange(e.target.value); }}
      onKeyDown={onKeyDown}
    />
  );
}

export function Loading() { return <div className="loading">불러오는 중…</div>; }

/**
 * 공용 오류 표시. **권한 거부(403)는 '오류'가 아니라 접근 제어**이므로 안내 화면으로 바꿔 보여준다.
 *
 * 여기서 감지하는 이유: 이 컴포넌트가 오류 표시의 단일 지점(86개 파일·132곳)이라, 뷰를 하나하나
 * 고치지 않고 전 화면에 같은 안내를 적용할 수 있다. 403 여부는 api.js 가 남긴 사이드 채널
 * (permissionInfoFor)로 판정한다 — `message` 가 문자열이라는 기존 계약을 깨지 않기 위한 통로다.
 * `info` 를 직접 넘기면(권장) 사이드 채널 없이도 동작한다.
 */
export function ErrorBox({ message, info = null }) {
  const perm = info || permissionInfoFor(message);
  if (perm) return <AccessDenied info={perm} message={message} />;
  return <div className="error-box">오류: {message}</div>;
}
