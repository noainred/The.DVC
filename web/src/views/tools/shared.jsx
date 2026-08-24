// shared.jsx — SpecialTools.jsx(구 5,070줄)에서 분리(v2.282 대형 파일 분할). 본문은 원본 그대로 이동.
import React, { useEffect, useState } from 'react';
import { fetchJson } from '../../api.js';



export const tb = (gb) => (gb >= 1024 ? `${(gb / 1024).toFixed(1)} TB` : `${gb} GB`);

/**
 * 목록 응답 언랩(v2.349) — 인벤토리 엔드포인트는 두 형태가 섞여 있다:
 *   { total, items }  : /hosts /vms /datastores /networks /alarms
 *   [ ... ] (배열)     : /vcenters
 * 뷰가 이를 혼동해 객체에 .filter 를 호출하면 'filter is not a function' 으로 화면 전체가
 * ErrorBox 로 떨어진다(vCenter별 스토리지 화면에서 실제 발생 — 이 헬퍼로 재발 방지).
 * 로딩 전(null)·오류(undefined)·예상 밖 형태도 항상 빈 배열로 흘려 렌더가 죽지 않게 한다.
 */
export function itemsOf(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.items)) return data.items;
  return [];
}

// 응답을 파일로 저장. 서버가 Content-Disposition으로 준 파일명을 우선 사용(>1MB면 .zip).
export async function saveResponseAsFile(res, fallbackName) {
  const cd = res.headers.get('content-disposition') || '';
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
  const name = m ? decodeURIComponent(m[1]) : fallbackName;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
}

export function useTool(path, params) {
  const [state, setState] = useState({ loading: true });
  const key = JSON.stringify(params);
  useEffect(() => {
    let active = true; setState({ loading: true });
    fetchJson(path, params).then((d) => active && setState({ loading: false, data: d })).catch((e) => active && setState({ loading: false, error: e.message }));
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, key]);
  return state;
}

export function tempColor(c) { return c == null ? 'var(--text-faint)' : c >= 40 ? 'var(--red)' : c >= 32 ? 'var(--amber)' : 'var(--green)'; }

// 집계 단위(bucketMs)에 맞춰 X축 라벨: 분/시간이면 시각, 일 이상이면 날짜.
function fmtTempTick(ts, bucketMs) {
  const d = new Date(ts);
  if (bucketMs && bucketMs <= 3_600_000) return d.toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('ko-KR', { year: '2-digit', month: '2-digit', day: '2-digit' });
}

// 추이 차트 x축: 선택 범위(일수)에 맞춰 단위 라벨 — 1일=시간, 1주=요일, 1달=일, 1년=달, 5년=년/월.
export function fmtTrendTick(ts, days) {
  const d = new Date(ts);
  if (days <= 1) return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });          // 시간
  if (days <= 7) return d.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short' }); // 요일
  if (days <= 31) return d.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });             // 일
  if (days <= 366) return d.toLocaleDateString('ko-KR', { year: '2-digit', month: 'short' });             // 달
  return d.toLocaleDateString('ko-KR', { year: '2-digit', month: '2-digit' });                             // 년/월
}

export function Card({ label, value, meta, accent, onClick, active }) {
  return (
    <div className="card kpi" onClick={onClick}
      style={{ ...(onClick ? { cursor: 'pointer' } : {}), ...(active ? { border: '1px solid var(--accent,#2563eb)', boxShadow: '0 0 0 1px var(--accent,#2563eb)' } : {}) }}
      title={onClick ? '클릭하여 필터' : undefined}>
      <div className="label">{label}</div>
      <div className="value" style={{ fontSize: 24, ...(accent ? { color: accent } : {}) }}>{value}</div>
      {meta && <div className="meta">{meta}</div>}
    </div>
  );
}

// 전력 단위: 1,000 넘으면 상위 단위(kW→MW→GW).
const pdec1 = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 });
export function fmtWatts(w) {
  if (w == null || !Number.isFinite(Number(w))) return '—';
  const a = Math.abs(w);
  if (a >= 1e9) return `${pdec1(w / 1e9)} GW`;
  if (a >= 1e6) return `${pdec1(w / 1e6)} MW`;
  if (a >= 1e3) return `${pdec1(w / 1e3)} kW`;
  return `${Math.round(w).toLocaleString()} W`;
}
export function fmtKwh(kwh) {
  if (kwh == null || !Number.isFinite(Number(kwh))) return '—';
  const a = Math.abs(kwh);
  if (a >= 1e6) return `${pdec1(kwh / 1e6)} GWh`;
  if (a >= 1e3) return `${pdec1(kwh / 1e3)} MWh`;
  return `${pdec1(kwh)} kWh`;
}
