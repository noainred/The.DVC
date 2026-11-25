/**
 * InspectTop — ④ Top 10 노드 편중(설계 시안 ④). 서버 순위(/tools/ps-inspect/top-nodes) 그대로 + 클러스터 안 분포 점 그림.
 *  · 값이 없는 노드는 순위 · 점에 넣지 않는다(0 으로 그리지 않는다). 편중 기준은 서버 값(포탈 기준 — Dell 수치 아님).
 */
import React from 'react';
import { STable } from '../../../components/STable.jsx';
import { METRICS, RANGES, metricText, pctText, distLayout, kstText } from './psInspectText.js';

export default function InspectTop({ top, busy, err, metric, range, onMetric, onRange, onOpen }) {
  const dist = distLayout(top?.clusters || []);
  const sk = top?.skewFactor ?? 1.5;
  return (
    <>
      <div className="psi-bar">
        <span className="psi-lab">순위 기준</span>
        <div className="psi-seg" role="group" aria-label="순위 기준">{METRICS.map((m) => <button key={m.key} type="button" className={metric === m.key ? 'on' : ''} aria-pressed={metric === m.key} onClick={() => onMetric(m.key)}>{m.label}</button>)}</div>
        <span className="psi-lab">기간</span>
        <div className="psi-seg" role="group" aria-label="기간">{RANGES.map((r) => <button key={r.key} type="button" className={range === r.key ? 'on' : ''} aria-pressed={range === r.key} onClick={() => onRange(r.key)}>{r.label}</button>)}</div>
        {busy && <span className="psi-muted">불러오는 중…</span>}
      </div>
      {err && <div className="psi-banner amber">순위를 불러오지 못했습니다: {String(err?.message || err)}</div>}
      {top && (
        <div className="psi-body">
          <div className="psi-main">
            <div className="psi-note" style={{ marginBottom: 6 }}>{kstText(top.from)} ~ {kstText(top.to)} · 노드 {top.nodesTotal}개 중 상위 {top.rows.length}{top.topShare != null ? ` · 상위 노드의 몫 ${pctText(top.topShare)}` : ''} · 기록이 있는 장비 {top.devicesWithData} / {top.devices}</div>
            {top.rows.length ? (
              <div className="psi-tablewrap">
                <STable minWidth={860}>
                  <thead><tr><th style={{ textAlign: 'right' }}>#</th><th>법인 · 클러스터</th><th>노드</th><th style={{ textAlign: 'right' }}>{top.metricLabel}</th><th style={{ textAlign: 'right' }} title="자기 클러스터 노드 평균의 몇 배">평균 대비</th>
                    <th style={{ textAlign: 'right' }} title="그 클러스터 안 몫">비중</th><th style={{ textAlign: 'right' }}>CPU 평균 · 피크</th><th style={{ textAlign: 'right' }}>busy 평균 · 피크</th></tr></thead>
                  <tbody>{top.rows.map((r, k) => (
                    <tr key={`${r.deviceId}|${r.lnn}`} style={r.skewed ? { background: 'rgba(201,133,0,.07)' } : undefined}>
                      <td className="psi-num" data-sort={String(k + 1)}>{k + 1}</td>
                      <td><button type="button" className="psi-rowbtn" onClick={() => onOpen(r.deviceId)} title="이 장비의 점검 결과">{r.corpName} · {r.name}</button></td>
                      <td data-sort={String(r.lnn)}><b>노드 {r.lnn}</b></td>
                      <td className="psi-num" data-sort={String(r.value ?? '')}>{metricText(top.metric, r.value)}</td>
                      <td className="psi-num" data-sort={String(r.ratio ?? '')} style={{ color: r.skewed ? '#fcd34d' : undefined }}>{r.ratio != null ? `${r.ratio}×` : '—'}</td>
                      <td className="psi-num" data-sort={String(r.share ?? '')}>{pctText(r.share)}</td>
                      <td className="psi-num" data-sort={String(r.cpuAvg ?? '')}>{r.cpuAvg != null ? `${pctText(r.cpuAvg)} · ${pctText(r.cpuMax)}` : '—'}</td>
                      <td className="psi-num" data-sort={String(r.busyAvg ?? '')}>{r.busyAvg != null ? `${pctText(r.busyAvg)} · ${pctText(r.busyMax)}` : '—'}</td>
                    </tr>
                  ))}</tbody>
                </STable>
              </div>
            ) : <div className="psi-banner">이 기간에 노드 표본이 없습니다 — 아이실론 노드 부하 표본 수집(장비 편집 › 노드 부하 표본 수집)이 켜져 있어야 쌓입니다.</div>}
            <div className="psi-note" style={{ marginTop: 6 }}>순위에 올랐다고 편중은 아닙니다 — 같은 클러스터 노드들이 평균 근처면 고르게 바쁜 것입니다. 평균의 {sk}배 이상만 호박색으로 표시합니다(포탈 기준 — Dell 수치 아님). CPU · busy 는 기준 없이 값만 싣습니다. 값은 5분 표본의 평균이고 읽지 못한 표본은 평균에서 뺍니다.</div>
          </div>
          <div className="psi-side">
            <div className="psi-panel">
              <h3>클러스터 안 편중 <span className="psi-muted" style={{ fontWeight: 400 }}>· 점 하나 = 노드 하나 · 가로 = 평균 대비</span></h3>
              {dist.rows.length ? (
                <svg viewBox={`0 0 360 ${dist.height}`} width="100%" role="img" aria-label="클러스터마다 노드가 평균의 몇 배인지 — 1.5배 선 오른쪽 점은 편중" style={{ display: 'block', height: 'auto' }}>
                  {dist.ticks.map((t) => <line key={t.v} x1={t.x} x2={t.x} y1={14} y2={dist.height - 18} stroke={t.v === 1.5 ? '#c98500' : t.v === 1 ? '#8b9bb4' : '#243049'} strokeDasharray={t.v === 1.5 ? '4 3' : undefined} />)}
                  {dist.ticks.map((t) => <text key={`l${t.v}`} x={t.x} y={dist.height - 4} textAnchor="middle" fontSize="10.5" fill={t.v === 1.5 ? '#fcd34d' : '#a3b1c9'}>{t.v === 1 ? '평균' : t.v === 0 ? '0' : `${t.v}배`}</text>)}
                  {dist.rows.map((r) => (
                    <g key={r.name + r.y}>
                      <text x={0} y={r.y - 3} fontSize="12" fontWeight="600" fill={r.skewed ? '#fcd34d' : 'currentColor'}>{String(r.name).slice(0, 12)}</text>
                      <text x={0} y={r.y + 11} fontSize="10.5" fill="#a3b1c9">{r.sub}</text>
                      <line x1={96} x2={330} y1={r.y} y2={r.y} stroke="#1c2640" />
                      {r.dots.map((d) => <circle key={d.lnn} cx={d.x} cy={r.y} r={d.hot ? 6.5 : 5} fill={d.hot ? '#c98500' : '#5b9cf5'} fillOpacity={d.hot ? 1 : 0.75}><title>{`노드 ${d.lnn} — 평균의 ${d.ratio}배`}</title></circle>)}
                    </g>
                  ))}
                </svg>
              ) : <div className="psi-note">그릴 노드 표본이 없습니다.</div>}
            </div>
            <div className="psi-panel">
              <h3>왜 편중이 생기나</h3>
              <div className="psi-note">SmartConnect 기본 정책(라운드 로빈)은 연결 수만 나누고 연결마다의 작업량은 보지 않아 노드 사이 부하가 고르지 않을 수 있습니다 [14]. 한 점만 오른쪽으로 떨어지면 그 노드의 고정 클라이언트를 옮길 후보입니다(스토리지 현황 › 장비 › 노드 부하 › 연결 그래프에서 클라이언트를 봅니다).</div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
