/**
 * InspectReport — ③ 주간 보고서(설계 시안 ③). 서버 보고서 모델(/tools/ps-inspect/report — 메일과 같은 주소 가림 판본)을 흰 종이로 그린다.
 *  · PDF 는 브라우저 인쇄(이 종이만 찍힌다 — @media print) · HTML 받기는 서버가 만든 자급형 HTML(메일 첨부와 같은 파일) · CSV 는 data.csv 권한.
 *  · 판정을 다시 하지 않는다 — 모델의 issues · unknowns · counts 를 그대로 그린다.
 */
import React from 'react';
import Select from '../../../components/Select.jsx';
import { STable } from '../../../components/STable.jsx';
import { statusText, kstText, numText, pctText } from './psInspectText.js';

const S = ({ s }) => <span className={`s ${s}`}>{statusText(s)}</span>;

export default function InspectReport({ rep, busy, err, corps, corp, onCorp, isAdmin, csvOk, onPrint, onHtml, onCsv, onSend, sending, sendResult }) {
  const m = rep?.model;
  const c = m?.counts || {};
  return (
    <>
      <div className="psi-bar">
        <span className="psi-lab">판본</span>
        <Select className="select select-sm" value={corp} onChange={(e) => onCorp(e.target.value)} aria-label="보고서 판본">
          <option value="">전 법인</option>
          {(corps || []).map((x) => <option key={x.key || '-'} value={x.key}>{x.name} 판</option>)}
        </Select>
        {busy && <span className="psi-muted">만드는 중…</span>}
        <span className="psi-grow" />
        <button type="button" className="psi-btn" onClick={onPrint} disabled={!m}>PDF 저장(인쇄)</button>
        <button type="button" className="psi-btn" onClick={onHtml} disabled={!m}>HTML 받기</button>
        {csvOk && <button type="button" className="psi-btn" onClick={onCsv}>CSV</button>}
        {isAdmin && <button type="button" className="psi-btn primary" onClick={onSend} disabled={sending}>{sending ? '보내는 중…' : '지금 메일 보내기'}</button>}
      </div>
      {sendResult && <div className={`psi-banner${sendResult.ok ? '' : ' amber'}`}>{sendResult.text}</div>}
      {err && <div className="psi-banner amber">보고서를 만들지 못했습니다: {String(err?.message || err)}</div>}
      {m && (
        <div className="psi-paper">
          <h1>PowerScale 주간 점검 보고서{m.corpName ? ` — ${m.corpName}` : ''}</h1>
          <div className="sub">{m.week} · 마지막 점검 {kstText(m.lastRun, { withYear: true })} KST · 만든 시각 {kstText(m.generatedAt, { withYear: true })} KST · 대상 {m.corps} 법인 · {m.devices.length} 클러스터 · {m.nodes} 노드{m.nodesUnknown ? `(노드 수 모름 ${m.nodesUnknown}대 제외)` : ''}</div>
          <h2>1. 요약</h2>
          <div className="kp">
            <div><span>정상</span><b>{c.ok}</b></div><div><span>주의</span><b style={{ color: '#7a5200' }}>{c.warn}</b></div><div><span>이상</span><b style={{ color: '#a5161b' }}>{c.bad}</b></div>
            <div><span>확인 불가</span><b>{c.unknown}</b></div><div><span>해당 없음</span><b>{c.na}</b></div>
          </div>
          <div>항목 {m.total}개 중 이상 {c.bad} · 주의 {c.warn}. 확인하지 못한 {c.unknown}건은 정상에 넣지 않았습니다.</div>
          <h2>2. 법인별 결과</h2>
          <div className="tablewrap"><STable>
            <thead><tr><th>법인</th><th>클러스터</th><th>OneFS</th><th>노드</th><th>용량</th><th>정상</th><th>주의</th><th>이상</th><th>불가</th><th>편중</th><th>점검 · 지난번 대비</th></tr></thead>
            <tbody>{m.devices.map((d) => (
              <tr key={`${d.corpName}|${d.name}`}><td>{d.corpName}</td><td>{d.name}</td><td>{d.version || '—'}</td><td className="n">{d.nodeCount ?? '—'}</td><td className="n">{pctText(d.capacityPct)}</td>
                <td className="n">{d.summary?.ok}</td><td className="n">{d.summary?.warn}</td><td className="n">{d.summary?.bad}</td><td className="n">{d.summary?.unknown}</td><td className="n">{d.skewRatio != null ? `${d.skewRatio}×` : '—'}</td>
                <td>{d.runAt ? kstText(d.runAt) : '점검 안 함'}{d.staleDays ? ` (${d.staleDays}일 전 — 판정 안 함)` : ''}{d.worse ? ` · 나빠짐 ${d.worse}` : ''}{d.better ? ` · 풀림 ${d.better}` : ''}</td></tr>
            ))}</tbody>
          </STable></div>
          <h2>3. 이상 · 주의 항목과 조치({m.issues.length})</h2>
          {m.issues.length ? <div className="tablewrap"><STable>
            <thead><tr><th /><th>법인 · 장비 · 항목</th><th>본 값</th><th>기준</th><th>조치 · 근거</th></tr></thead>
            <tbody>{m.issues.map((x) => <tr key={`${x.deviceId}|${x.id}`}><td data-sort={x.status === 'bad' ? '0' : '1'}><S s={x.status} /></td><td>{x.corp} · {x.device} · <b>{x.label}</b></td><td>{x.value}</td><td>{x.basis}</td><td>{x.action}</td></tr>)}</tbody>
          </STable></div> : <div>이상 · 주의 항목이 없습니다.</div>}
          <h2>4. 확인하지 못한 항목({m.unknowns.length})</h2>
          {m.unknowns.length ? <div className="tablewrap"><STable>
            <thead><tr><th>법인 · 장비</th><th>항목</th><th>사유</th></tr></thead>
            <tbody>{m.unknowns.slice(0, 60).map((u, k) => <tr key={k}><td>{u.corp} · {u.device}</td><td>{u.label}</td><td>{u.why}</td></tr>)}</tbody>
          </STable></div> : <div>없습니다.</div>}
          {m.unknowns.length > 60 && <div className="sub">외 {m.unknowns.length - 60}건은 점검 결과 보기에서 봅니다.</div>}
          <h2>5. 성능 — 가장 바쁜 노드 10개와 편중</h2>
          <div className="sub">지난 7일 평균 {m.top.metricLabel}({kstText(m.top.from)} ~ {kstText(m.top.to)}). 평균 대비 = 자기 클러스터 노드 평균의 몇 배 · 비중 = 그 클러스터 안 몫. {m.top.skewFactor}배 이상(포탈 기준 — Dell 수치 아님): {m.top.skewed.length ? m.top.skewed.map((x) => `${x.corpName} · ${x.name} 노드 ${x.maxLnn} ${x.maxRatio}×`).join(' · ') : '없음'}.</div>
          {m.top.rows.length ? <div className="tablewrap"><STable>
            <thead><tr><th>#</th><th>법인 · 클러스터 · 노드</th><th>{m.top.metricLabel}</th><th>평균 대비</th><th>비중</th><th>CPU 평균 · 피크</th><th>busy 평균 · 피크</th></tr></thead>
            <tbody>{m.top.rows.map((r, k) => <tr key={`${r.deviceId}|${r.lnn}`}><td className="n">{k + 1}</td><td>{r.corpName} · {r.name} · 노드 {r.lnn}</td><td className="n">{numText(r.value)}</td>
              <td className="n" style={{ color: r.skewed ? '#7a5200' : undefined, fontWeight: r.skewed ? 700 : 400 }}>{r.ratio != null ? `${r.ratio}×` : '—'}</td><td className="n">{pctText(r.share)}</td>
              <td className="n">{r.cpuAvg != null ? `${pctText(r.cpuAvg)} · ${pctText(r.cpuMax)}` : '—'}</td><td className="n">{r.busyAvg != null ? `${pctText(r.busyAvg)} · ${pctText(r.busyMax)}` : '—'}</td></tr>)}</tbody>
          </STable></div> : <div>7일 안에 노드 표본이 없습니다(표본 수집이 꺼졌거나 아직 쌓이지 않았습니다).</div>}
          <h2>6. 데이터 보호</h2>
          <div className="tablewrap"><STable>
            <thead><tr><th>클러스터</th><th>SyncIQ</th><th>스냅샷</th><th>잡 엔진</th><th>재보호</th></tr></thead>
            <tbody>{m.protection.map((p) => <tr key={p.name}><td>{p.name}</td>
              {['synciq', 'snapshots', 'jobs'].map((k) => <td key={k}>{p[k] ? <><S s={p[k].status} /> {p[k].value}</> : '—'}</td>)}<td>{p.reprotect?.value || '—'}</td></tr>)}</tbody>
          </STable></div>
          <h2>7. 다음 주까지 확인할 것</h2>
          {m.todo.length ? <ul style={{ margin: '2px 0 0 18px', padding: 0 }}>{m.todo.map((x, k) => <li key={k}>{x}</li>)}</ul> : <div>없습니다.</div>}
          <h2>8. 근거 자료</h2>
          <div className="sub">{m.refs.map((r) => <div key={r.n}>[{r.n}] {r.title} — {r.kind}</div>)}참고 자료는 검색 도구가 인용한 구절 수준이며(원문 전체 열람 0건) 명령 · REST 경로는 실장비 출력으로 아직 확인하지 못했습니다. 편중 기준 {m.top.skewFactor}배는 포탈 기준입니다.</div>
        </div>
      )}
      <div className="psi-note">메일로 보낼 때는 이 내용이 본문이 되고, 같은 내용의 HTML 파일이 첨부됩니다(브라우저에서 열어 인쇄 › PDF 로 저장). 서버에서 PDF 를 만들지 않습니다 — 이 저장소에 PDF 라이브러리가 없습니다.</div>
    </>
  );
}
