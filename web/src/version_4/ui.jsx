// version_4 공용 조각(v2.490) — 패널·KPI·막대·배지·빈 상태·폴링 래퍼. 스타일은 v4.css 의 v3-* 클래스.
import React from 'react';
import { ErrorBox } from '../components/ui.jsx';
import { LEVEL_LABEL, fmtPct, barColor, levelText } from './data.js';
import { loadText } from './loadState.js';

export function Panel({ title, sub, right, children, bodyPad = true, style }) {
  return (
    <div className="v3-panel" style={style}>
      {(title || right) && (
        <div className="v3-panel-h">
          {title && <b>{title}</b>}
          {sub && <span className="v3-sub">{sub}</span>}
          {right && <div className="v3-right">{right}</div>}
        </div>
      )}
      {bodyPad ? <div className="v3-panel-b">{children}</div> : children}
    </div>
  );
}

export function Kpi({ label, value, meta, accent }) {
  return (
    <div className="v3-kpi" style={accent ? { '--kpi': accent } : undefined}>
      <div className="v3-kpi-label">{label}</div>
      <div className="v3-kpi-value">{value}</div>
      {meta && <div className="v3-kpi-meta">{meta}</div>}
    </div>
  );
}

/** 사용률 막대. pct 가 null 이면 빈 막대. marks = 임계 눈금(%). */
export function Bar({ pct, color, large = false, marks = null }) {
  const w = pct == null ? 0 : Math.max(0, Math.min(100, Number(pct)));
  return (
    <span className={`v3-bar${large ? ' lg' : ''}`}>
      <i style={{ width: `${w}%`, background: color || barColor(pct) }} />
      {(marks || []).map((m) => <span key={m} className="v3-mark" style={{ left: `${m}%` }} />)}
    </span>
  );
}

export function PctCell({ pct, color }) {
  return <span className="v3-pct"><Bar pct={pct} color={color} /><span className="v3-num">{fmtPct(pct)}</span></span>;
}

/** 레벨 배지(0 정상 / 1 주의 / 2 위험 / null 판정 불가). */
export function Badge({ level, label }) {
  const cls = level == null ? 'lvn' : `lv${level}`;
  return <span className={`v3-badge ${cls}`}>{label ?? (level == null ? '—' : LEVEL_LABEL[level])}</span>;
}
export { levelText };

export function Empty({ children }) { return <div className="v3-empty">{children}</div>; }

/**
 * 폴링 결과 래퍼 — 데이터가 없을 때만 오류/로딩을 보여준다(데이터 보유 중 일시 오류 1건으로 화면을 갈아치우지 않는다).
 * 403 은 ErrorBox 가 AccessDenied 안내로 바꾼다. path 가 null(권한상 호출 안 함)이면 skipped 문구.
 *
 * `phase`(v2.509, 셸이 loadState.loadPhase 로 계산해 내려준다)를 받으면 '불러오는 중…' 대신
 * **왜 비었는지**를 말한다 — 첫 수집 중(기다리면 됨) / 연결 실패(기다려도 안 됨) / 응답 지연 구분.
 * 문구는 **짧은 쪽(short)** 을 쓴다 — 긴 설명은 상단 배너가 한 번만 한다. 패널마다 같은 긴 문장을
 * 넣으면 화면이 같은 말로 뒤덮인다(실제로 그렇게 나와 스크린샷에서 발견했다).
 * phase 없이 호출하면 기존 동작 그대로다(화면을 한 번에 다 고치지 않아도 되게).
 * 타임아웃은 ErrorBox(화면 전체 오류)로 띄우지 않는다 — 재시도 중이지 장애가 아니다.
 */
export function PollState({ poll, skipped, phase, health, children }) {
  if (skipped) return <Empty>{skipped}</Empty>;
  if (!poll) return null;
  if (poll.error && !poll.data) {
    const t = phase ? loadText(phase, { health, pollError: poll.error }) : null;
    if (t && (phase === 'retrying' || phase === 'first-collect' || phase === 'unreachable')) return <Empty>{t.short}</Empty>;
    return <div style={{ padding: 12 }}><ErrorBox message={poll.error} info={poll.errorInfo} /></div>;
  }
  if (!poll.data) return <Empty>{phase ? loadText(phase, { health, pollError: poll.error }).short : '불러오는 중…'}</Empty>;
  return children;
}

/**
 * 작은 추이 차트(v2.508) — 의존성 없이 SVG 로 그린다(recharts 는 vendor-charts 496KB 를 끌어온다).
 * points = [{ x:number, y:number|null }]. y 가 null 인 구간은 **선을 잇지 않는다** —
 * '수집 없음'을 0 이나 직선 보간으로 그리면 있지도 않은 값을 지어내는 것이다.
 * 표본이 2개 미만이면 차트를 그리지 않고 호출자가 이유를 문장으로 쓴다.
 */
export function Spark({ points, height = 120, color = '#2563eb', fill = true, yZero = false }) {
  /*
   * ⚠ v2.575 BUG-10 — `Number(null) === 0` 이라 예전 형태는 **x 가 없는 점을 1970년(0)** 으로
   *   살려 두었다. 그러면 `x0 = 0` 이 되어 **실제 점이 전부 오른쪽 끝에 뭉친다**(실행 재현).
   *   y 축은 처음부터 `v != null` 로 옳게 걸렀는데 x 만 빠져 있었다.
   * ⚠ 호출부에서 `x: null` 을 증명하지는 못했다(도달 미확인) — 그래도 **형태가 틀렸다**.
   */
  const pts = (points || []).filter((p) => p && p.x != null && p.x !== ''
    && (typeof p.x === 'number' || typeof p.x === 'string') && Number.isFinite(Number(p.x)));
  const ys = pts.map((p) => p.y).filter((v) => v != null && Number.isFinite(Number(v))).map(Number);
  if (pts.length < 2 || ys.length < 2) return null;
  const W = 100, H = 100; // viewBox 비율 좌표 — 실제 크기는 CSS 가 정한다
  const xs = pts.map((p) => Number(p.x));
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const lo = yZero ? Math.min(0, ...ys) : Math.min(...ys);
  const hi = Math.max(...ys);
  const span = hi - lo || 1;
  const sx = (x) => (x1 === x0 ? 0 : ((x - x0) / (x1 - x0)) * W);
  const sy = (y) => H - ((y - lo) / span) * H;
  // null 을 만나면 선을 끊는다(M 으로 다시 시작).
  let d = '', open = false;
  pts.forEach((p) => {
    const y = p.y == null || !Number.isFinite(Number(p.y)) ? null : Number(p.y);
    if (y == null) { open = false; return; }
    d += `${open ? 'L' : 'M'}${sx(Number(p.x)).toFixed(2)},${sy(y).toFixed(2)} `;
    open = true;
  });
  // 면(fill)은 선이 한 번도 끊기지 않았을 때만 칠한다 — 끊긴 구간까지 칠하면 결측이 값처럼 보인다.
  const solid = !pts.some((p) => p.y == null || !Number.isFinite(Number(p.y)));
  return (
    <svg className="v4-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height }} role="img">
      {fill && solid && <path d={`${d}L${sx(x1).toFixed(2)},${H} L${sx(x0).toFixed(2)},${H} Z`} fill={color} opacity={0.1} />}
      <path d={d.trim()} fill="none" stroke={color} strokeWidth={1.6} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}
