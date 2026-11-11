/**
 * InspectOverview — ① 법인별 현황(설계 시안 ①). 장비마다 20칸 띠 · 용량 · 지난번 대비 · 편중 + 이상/주의 목록 · 확인 불가 사유 · 점검 방식 안내.
 */
import React from 'react';
import { STable } from '../../../components/STable.jsx';
import { StatusBadge, Strip, CapBar, Refs, Legend } from './InspectParts.jsx';
import { sortDevices, issuesOf, unknownReasons, diffText, kstText, agoText, numText, METHOD_KO } from './psInspectText.js';

export default function InspectOverview({ data, onOpen }) {
  const devices = sortDevices(data?.devices || []);
  const t = data?.totals || {};
  const th = data?.thresholds || {};
  const iss = issuesOf(devices, 12);
  const unk = unknownReasons(devices);
  const never = devices.filter((d) => !d.run).length;
  return (
    <>
      <div className="psi-tiles">
        <div className="psi-tile"><span className="psi-lab">대상</span><b>{numText(t.devices)}</b><span className="psi-muted">{numText(t.corps)} 법인 · {numText(t.nodes)} 노드{t.nodesUnknown ? `(노드 수 모름 ${t.nodesUnknown}대)` : ''} · 점검한 장비 {numText(t.inspected)}</span></div>
        <div className="psi-tile"><span className="psi-lab">점검 항목</span><b>{numText(t.total)}</b><span className="psi-muted">장비 {numText(t.devices)} × 20항목</span></div>
        <div className="psi-tile"><span className="psi-lab">정상</span><b style={{ color: '#4fd1a5' }}>{numText(t.ok)}</b><span className="psi-muted">확인했고 기준 안</span></div>
        <div className="psi-tile"><span className="psi-lab">주의</span><b style={{ color: '#fcd34d' }}>{numText(t.warn)}</b><span className="psi-muted">조치 검토</span></div>
        <div className="psi-tile"><span className="psi-lab">이상</span><b style={{ color: '#ff9a9d' }}>{numText(t.bad)}</b><span className="psi-muted">바로 조치</span></div>
        <div className="psi-tile"><span className="psi-lab">확인 불가</span><b>{numText(t.unknown)}</b><span className="psi-muted">정상으로 세지 않음 · 해당 없음 {numText(t.na)}</span></div>
      </div>
      {never > 0 && <div className="psi-banner">아직 점검하지 않은 장비가 {never}대 있습니다 — 그 장비의 장비 항목은 확인 불가로 보입니다. ‘지금 점검’ 또는 다음 정기 점검에서 채워집니다.</div>}
      <div className="psi-body">
        <div className="psi-main">
          <div className="psi-tablewrap">
            <STable minWidth={980}>
              <thead><tr>
                <th>법인</th><th>클러스터</th><th>OneFS · 노드</th><th>용량</th><th data-nosort="1">항목 20칸(구성 요소 · 구성 · 용량 · 성능 · 보호)</th>
                <th>결과</th><th>지난번 대비</th><th style={{ textAlign: 'right' }} title="가장 바쁜 노드 ÷ 노드 평균(7일 · 포탈 기준 1.5배)">편중</th><th>점검</th>
              </tr></thead>
              <tbody>
                {devices.map((d) => {
                  const dt = diffText(d.diff);
                  const cap = (d.items || []).find((i) => i.id === 'capacity');
                  return (
                    <tr key={d.id}>
                      <td>{d.corpName}</td>
                      <td><button type="button" className="psi-rowbtn" onClick={() => onOpen(d.id)} title="이 장비의 점검 결과">{d.name}</button><div className="psi-muted" style={{ fontSize: 11 }}>{d.agent ? `엣지 ${d.agent}` : '중앙 직접'} · {METHOD_KO[d.method] || d.method}</div></td>
                      <td><span className="psi-mono">{d.version || '—'}</span><div className="psi-muted" style={{ fontSize: 11 }}>노드 {d.nodeCount ?? '—'}</div></td>
                      <td data-sort={String(d.capacityPct ?? '')}><CapBar pct={d.capacityPct} status={cap?.status} warn={th.capWarnPct} bad={th.capBadPct} /></td>
                      <td data-nosort="1"><Strip items={d.items} /></td>
                      <td data-sort={String({ bad: 0, warn: 1, unknown: 2, ok: 3, na: 4 }[d.summary?.overall] ?? 9)}>
                        <StatusBadge s={d.summary?.overall} />
                        <div className="psi-muted" style={{ fontSize: 11, marginTop: 2, whiteSpace: 'normal', maxWidth: 120 }}>정상 {d.summary?.ok} · 주의 {d.summary?.warn} · 이상 {d.summary?.bad} · 불가 {d.summary?.unknown}</div>
                      </td>
                      <td><span className={dt.tone === 'bad' ? 'psi-st bad' : dt.tone === 'ok' ? 'psi-st ok' : 'psi-muted'} style={dt.tone === 'muted' ? { fontSize: 11.5 } : undefined}>{dt.text}</span></td>
                      <td className="psi-num" data-sort={String(d.skew?.ratio ?? '')} style={{ color: d.skew?.ratio >= (th.skewFactor || 1.5) ? '#fcd34d' : undefined }}>{d.skew?.ratio != null ? `${d.skew.ratio}×` : '—'}</td>
                      <td data-sort={String(d.run?.at ?? '')}>{d.run ? <><span className="psi-mono" style={{ fontSize: 11.5 }}>{kstText(d.run.at)}</span><div className="psi-muted" style={{ fontSize: 11 }}>{agoText(d.run.at)}{d.run.partial ? ' · 일부만' : ''}{d.run.staleDays ? ' · 오래됨(판정 안 함)' : ''}</div></> : <span className="psi-muted">{d.request?.state === 'pending' || d.request?.state === 'taken' ? '엣지 점검 대기' : '점검 안 함'}</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </STable>
          </div>
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Legend />
            <div className="psi-note">줄의 이름을 누르면 그 장비의 20항목 결과. 용량 막대의 눈금은 {th.capWarnPct ?? 80}%(증설 발주 시점)와 {th.capBadPct ?? 90}%(유지 상한) — Dell 권고 수치 [1][10]. 편중 기준 {th.skewFactor ?? 1.5}배는 포탈 기준이며 Dell 수치가 아닙니다. 확인 불가는 정상에 넣지 않습니다.</div>
          </div>
        </div>
        <div className="psi-side">
          <div className="psi-panel">
            <h3>이상 · 주의 {iss.total}건 <span className="psi-muted" style={{ fontWeight: 400 }}>· 이상 먼저</span></h3>
            {iss.list.length ? iss.list.map(({ device, item }) => (
              <div key={`${device.id}|${item.id}`} className="psi-issue">
                <StatusBadge s={item.status} />
                <span><button type="button" className="psi-rowbtn" onClick={() => onOpen(device.id)}>{device.corpName} · {device.name}</button> — <b>{item.label}</b>: {item.value} <Refs refs={item.refs} /></span>
              </div>
            )) : <div className="psi-note">이상 · 주의 항목이 없습니다.</div>}
            {iss.more > 0 && <div className="psi-note">외 {iss.more}건은 장비별 점검 결과에서 봅니다.</div>}
          </div>
          <div className="psi-panel">
            <h3>확인 불가 — 왜 못 읽었나</h3>
            {unk.length ? unk.slice(0, 6).map((u) => (
              <div key={u.why} className="psi-note"><b style={{ color: 'var(--text)' }}>{u.items}건</b> · {u.why} <span className="psi-muted">({u.labels.slice(0, 3).join(' · ')}{u.labels.length > 3 ? ` 외 ${u.labels.length - 3}` : ''} — 장비 {u.devices.length}대)</span></div>
            )) : <div className="psi-note">없습니다.</div>}
            <div className="psi-note">확인 불가는 정상에 넣지 않고 보고서에도 따로 적습니다.</div>
          </div>
          <div className="psi-panel">
            <h3>점검이 도는 방식</h3>
            <div className="psi-note">정한 요일 · 시각에 중앙 직접 장비는 중앙이, 엣지 위임 장비는 그 법인 엣지가 로컬에서 읽기 전용 명령을 한 묶음으로 실행하고 판정할 값만 중앙으로 올립니다(장비당 시한 · 인증 실패 시 자동 재시도 없음). 노드별 I/O 는 이미 5분 표본으로 쌓고 있어 그 7일 기록으로 디스크 busy · 편중 · Top 10 을 냅니다. 포탈은 장비 설정을 바꾸지 않습니다.</div>
          </div>
        </div>
      </div>
    </>
  );
}
