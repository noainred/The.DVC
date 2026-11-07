/**
 * GpuAllocHistory — GPU 할당율 '추이'(v2.937 개선 7). 서버 /tools/gpu-alloc/history(gpu/allocHistory.js — 법인별 하루 한 점) 를 그린다.
 * 조회는 탭을 열 때 1회 + 기간 바꿀 때(무거운 API 15초 폴링 금지 규약 — 하루 한 점이라 자주 볼 이유도 없다). 늦게 온 이전 응답은 버린다(useLatest).
 * 합계 선은 그날 **모든 법인의 점이 있을 때만** 이어진다(서버가 부분 합을 null 로 준다 — 선이 끊긴다).
 * 소진 예상은 최근 30일 기울기(점 7개 이상 · 늘어날 때 · 결정계수 0.3 이상)일 때만 — 아니면 '—'(모름이지 '소진 안 함' 이 아니다).
 */
import React, { useEffect, useState } from 'react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts';
import { useLatest } from '../../hooks/useLatest.js';
import { fetchJson } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { numText, pctText, historyQuery, trendText } from './gpuAllocText.js';

const tip = { background: 'var(--panel, #0f172a)', border: '1px solid var(--border, #334155)', borderRadius: 8, fontSize: 12 };
const DAYS = [30, 90, 180, 365];

export function GpuAllocHistory({ vcSel, scope }) {
  const run = useLatest();
  const [days, setDays] = useState(90);
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const q = historyQuery({ days, vcSel, scope });
  useEffect(() => { setErr(null); run(fetchJson(`/tools/gpu-alloc/history${q}`), setData, setErr); }, [q, run]);
  if (err && !data) return <ErrorBox error={err} />;
  if (!data) return <Loading />;
  const pts = (data.total || []).map(([d, cap, alloc]) => ({ d, label: data.labels?.[d] || String(d), cap, alloc }));
  const tt = data.totalTrend ? trendText(data.totalTrend) : null;   // 지금 시각 기준(일 번호 today 를 넘기면 1970년 날짜가 된다 — 화면 판독에서 찾음)
  return (
    <div className="gpu-alloc-history" data-gpu-alloc-history="">
      <div className="card gpu-alloc-panel">
        <div className="flex gap wrap" style={{ alignItems: 'center' }}>
          <b style={{ fontSize: 14 }}>할당 추이</b>
          {DAYS.map((n) => <button key={n} type="button" className={`qn-btn${days === n ? ' on' : ''}`} aria-pressed={days === n} onClick={() => setDays(n)}>{n}일</button>)}
          {tt && <span className="muted" style={{ fontSize: 12, marginLeft: 'auto' }}>합계 — 30일 변화 {tt.change} · 하루 {tt.perDay} · 소진 예상 <b style={{ color: 'var(--text)' }}>{tt.left}</b></span>}
        </div>
        <div className="muted" style={{ fontSize: 12, lineHeight: 1.6, marginTop: 6 }}>
          법인마다 하루 한 점(그날 마지막 값)을 1시간마다 쌓습니다. 용량이나 할당을 모르는 값이 섞인 날, 수집하지 못한 날은 점을 쌓지 않습니다(부분 합을 추이에 넣지 않음).
          합계 선은 그날 모든 법인의 점이 있을 때만 이어집니다. 소진 예상은 최근 30일 할당 증가 기울기로 낸 추정입니다.
        </div>
      </div>
      {!data.available ? (
        <div className="card gpu-alloc-panel"><span className="muted">이력 저장소를 열지 못했습니다(이 서버의 Node 가 SQLite 를 지원하지 않거나 파일 권한 문제) — 추이를 쌓지 않습니다.</span></div>
      ) : pts.length < 2 ? (
        <div className="card gpu-alloc-panel"><span className="muted">아직 이력이 {pts.length ? '하루치뿐' : '없습니다'}입니다. 이 버전(v2.937)부터 하루 한 점씩 쌓이므로 이틀째부터 선이 보입니다. 아래 표는 쌓인 만큼 보여 줍니다.</span></div>
      ) : (
        <div className="card gpu-alloc-panel" style={{ height: 320 }}>
          <ResponsiveContainer>
            <LineChart data={pts} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
              <CartesianGrid stroke="rgba(148,163,184,.15)" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} minTickGap={28} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `${v}G`} width={64} />
              <Tooltip formatter={(v, name) => [v == null ? '—' : `${numText(v)} GB`, name]} contentStyle={tip} />
              <Legend />
              <Line type="monotone" dataKey="cap" name="전체 용량" stroke="#e2e8f0" strokeDasharray="5 4" dot={false} connectNulls={false} />
              <Line type="monotone" dataKey="alloc" name="할당(켜진 VM)" stroke="#3b82f6" strokeWidth={2} dot={false} connectNulls={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
      {data.available && (data.corps || []).length > 0 && (
        <STable className="gpu-alloc-table" minWidth={860}>
          <thead><tr><th>법인</th><th>마지막 날</th><th className="num">할당률</th><th className="num">30일 변화</th><th className="num">하루 증가</th><th className="num">소진 예상</th><th className="num">점</th></tr></thead>
          <tbody>
            {data.corps.map((c) => {
              const t = trendText(c.trend);
              return (
                <tr key={c.id}>
                  <td title={c.name}>{c.id}</td>
                  <td>{c.lastDay || '—'}</td>
                  <td className="num" data-sort={c.pct ?? ''}>{pctText(c.pct)}</td>
                  <td className="num" data-sort={c.trend?.change30 ?? ''}>{t.change}</td>
                  <td className="num" data-sort={c.trend?.gbPerDay ?? ''}>{t.perDay}</td>
                  <td className="num" data-sort={c.trend?.daysLeft ?? ''} title={t.why}>{t.left}</td>
                  <td className="num">{c.points.length}</td>
                </tr>
              );
            })}
          </tbody>
        </STable>
      )}
    </div>
  );
}

export default GpuAllocHistory;
