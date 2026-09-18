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
import { permissionInfoFor, httpInfoFor, reportLoadingStall, ensurePerfClientConfig } from '../api.js';
// v2.498: '불러오는 중' 이 길어지면 몇 초째인지·무엇을 기다리는지 정직하게 보이고 서버에 1회 보고한다.
import { inflightSnapshot, stuckThresholdMs, detailThresholdMs } from '../perfClient.js';
import { loadingText } from '../perfClientLogic.js';
import { secText } from './taskLabel.js';
import AccessDenied from './AccessDenied.jsx';
import ServiceDown from './ServiceDown.jsx';
import { serviceDownKind } from './serviceDownText.js';

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

/**
 * Sortable, client-side table. columns: [{key,label,render?,align?,sortValue?}]
 *
 * v2.556 에 **선택 인자 5개**를 더했다(모두 기본값 = 예전 동작 그대로 — 181개 표의 회귀 0):
 *   · `rowStyle(r)`  — 행 배경 등. '서버 온도' 는 40℃↑ 행을 붉게, 32℃↑ 행을 노랗게 칠한다.
 *                      ⚠ hover 가 위로 와야 하므로 색은 인라인이 아니라 CSS 가 이긴다 —
 *                      호출부는 `background` 만 주고 hover 는 스타일시트가 덮는다.
 *   · `className`    — 표에 클래스를 붙여 **시각 규격은 CSS 가 갖게** 한다(인라인 스타일을
 *                      수십 개 prop 으로 넘기지 않기 위해. `.dc-table` 참조).
 *   · `bare`         — `.table-wrap`(테두리·반경)을 그리지 않는다. 카드가 테두리를 그릴 때.
 *   · `maxHeight`    — 스크롤 상한(기본 64vh 유지).
 *   · `onVisible(rows)` — **지금 화면에 그린 행**을 알려 준다. 정렬을 이 컴포넌트가 소유하므로
 *                      호출부는 그것 없이 '보이는 행' 을 알 수 없다. '서버 온도' 는 이 목록으로
 *                      24시간 추이를 배치 조회한다 — 밖에서 따로 정렬하면 **정렬을 두 곳이
 *                      구현**하게 되고, 열을 바꿔 정렬한 순간 엉뚱한 행의 차트를 불러온다.
 *   · `limit`+`footer` — **정렬한 뒤** 앞 N 행만 그린다. 순서가 중요하다 — 호출부에서 먼저
 *                      잘라서 넘기면 '전체를 정렬한 상위 N' 이 아니라 '앞 N 을 정렬한 것' 이
 *                      되어 표가 거짓이 된다(그래서 limit 을 이 컴포넌트가 받는다).
 *                      `footer` 는 표 아래에 그대로 그릴 노드(행 수·더 보기 버튼).
 */
export function DataTable({
  columns, rows, initialSort, emptyText = '데이터가 없습니다.',
  rowStyle, className = '', bare = false, maxHeight = '64vh', limit = 0, footer = null, onVisible,
}) {
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

  // ⚠ 자르는 것은 **정렬 뒤**다(위 주석). limit 0/미지정은 전부 그린다.
  const shown = limit > 0 ? sorted.slice(0, limit) : sorted;
  // 보이는 행을 호출부에 알린다(키 목록이 바뀔 때만 — 매 렌더 호출하면 부모가 무한 갱신된다).
  const shownKey = shown.map((r) => r.key ?? r.id ?? '').join(',');
  useEffect(() => { if (onVisible) onVisible(shown); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [shownKey]);

  return (
    <div className={bare ? '' : 'table-wrap'} style={{ overflow: 'auto', maxHeight }}>
      <table className={className}>
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
          {shown.length === 0 && (
            <tr><td colSpan={columns.length} className="center muted" style={{ padding: 30 }}>{emptyText}</td></tr>
          )}
          {shown.map((r, i) => (
            <tr key={r.id || r.key || i} style={rowStyle ? rowStyle(r) : undefined}>
              {columns.map((c) => (
                <td key={c.key} style={{ textAlign: c.align || 'left' }}>
                  {c.render ? c.render(r) : r[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {footer}
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

/**
 * 공용 로딩 표시(호출처 179곳 무변경 — 이 컴포넌트 하나만 바꾼다).
 *
 * 사용자 요구(v2.501): "**대기가 3초 이상이면 구체적으로 어떤 작업을 하는지** 진행상태를 보여줄 것."
 * v2.498 까지는 15초까지 아무 정보가 없고 30초가 지나야 경로 하나를 보여줬다 — 그 사이 사용자는
 * 멈춘 것인지 일하는 중인지 알 수 없었다. 이제:
 *  · 3초 미만 — '불러오는 중…' 만(짧은 대기에 잡음을 더하지 않는다).
 *  · **3초 이상** — 경과 초 + 진행 중 작업을 **줄 단위로**: 작업 이름(경로 대신 사람 말), 각 대기
 *    시간, 같은 작업이 겹치면 건수. 설계상 오래 걸리는 작업(고RTT vCenter 라이브 조회·엑셀 생성·
 *    롱폴)은 '오래 걸리는 것이 정상' 이라고 밝힌다.
 *  · 3초 이상인데 대기 요청이 없으면 — '서버 응답은 모두 받았고 화면을 그리는 중' 이라고만 말한다.
 *    이 시점에 새로고침을 권하지 않는다(정상 렌더와 구분할 수 없다).
 *  · stuck 임계(서버 설정, 기본 60초)를 넘고도 대기 요청이 없으면 그때 자백하고 새로고침 버튼을 준다.
 *    동시에 서버에 1회 보고 → 설정 › 서버 성능 측정의 hang 기록.
 *
 * 문턱 3초와 60초는 **서버 설정값**(`clientDetailMs`·`clientStuckMs`)이다 — 뷰에 하드코딩하지 않는다.
 * 훅은 조기 return 이 없는 leaf 컴포넌트에서만 쓰므로 React #310 위험이 없다. tick 은 500ms 로
 * 3초 문턱을 늦지 않게 넘기고, 언마운트 시 해제한다.
 *
 * @param label 이 화면이 무엇을 불러오는지(선택) — 주면 '불러오는 중' 대신 그 이름을 쓴다.
 */
export function Loading({ label = '' } = {}) {
  const [sec, setSec] = useState(0);
  const reported = useRef(false);
  useEffect(() => {
    const t0 = Date.now();
    ensurePerfClientConfig();   // 임계값을 서버에서 1회 받아온다(하드코딩 금지)
    const id = setInterval(() => {
      const ms = Date.now() - t0;
      setSec(ms / 1000);
      if (!reported.current && ms >= stuckThresholdMs()) {
        reported.current = true;
        const rows = inflightSnapshot(10);
        try {
          reportLoadingStall({
            view: typeof window !== 'undefined' ? window.location.hash : '',
            path: rows[0]?.path || '', ms,
          });
        } catch { /* 보고 실패는 화면에 영향 없음 */ }
      }
    }, 500);
    return () => clearInterval(id);
  }, []);
  const detailSec = detailThresholdMs() / 1000;
  // 문턱을 넘은 뒤에만 스냅샷을 뜬다(짧은 대기에서는 아무 일도 하지 않는다).
  const rows = sec >= detailSec ? inflightSnapshot(10) : [];
  const t = loadingText({
    elapsedSec: sec, inflight: rows, label,
    detailSec, stuckSec: stuckThresholdMs() / 1000,
  });
  return (
    <div className="loading">
      {t.text}
      {t.tasks?.length > 0 && (
        <ul style={{ listStyle: 'none', margin: '6px 0 0', padding: 0, fontWeight: 400 }}>
          {t.tasks.map((x) => (
            <li key={x.label} className="muted" style={{ fontSize: 12, marginTop: 2, overflowWrap: 'anywhere' }}>
              {x.label}
              {x.count > 1 ? ` ×${x.count}` : ''}
              {' · '}
              {secText(x.ms)} 대기
              {x.slow && <span style={{ marginLeft: 6 }}>(오래 걸리는 것이 정상인 작업)</span>}
            </li>
          ))}
        </ul>
      )}
      {t.detail && t.tasks?.length === 0 && (
        <div className="muted" style={{ fontSize: 12, marginTop: 6, fontWeight: 400, overflowWrap: 'anywhere' }}>{t.detail}</div>
      )}
      {t.suggestReload && (
        <div style={{ marginTop: 8 }}>
          <button className="tab" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => window.location.reload()}>새로고침</button>
        </div>
      )}
    </div>
  );
}

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
  // v2.459: 5xx·네트워크 실패는 '오류'가 아니라 **일시적 미가용**(업그레이드 중 재시작 포함)이다.
  // 빨간 "오류: Failed to fetch" 로 두면 사용자가 데이터 손실·자기 잘못으로 오해해 새로고침을
  // 반복한다. 403 → AccessDenied 와 같은 단일 지점 처리.
  const http = httpInfoFor(message);
  const kind = serviceDownKind(message, http);
  if (kind) return <ServiceDown kind={kind} message={message} http={http} />;
  return <div className="error-box">오류: {message}</div>;
}
