/**
 * ReportView — ④ 보고서 열람(설계 시안 ④): 1 종합 · 2 조치 필요 · 3 법인별 현황 · 4~6 축별 항목(법인 행 펼치기) · 7 확인하지 못한 것 · 8 전달 기록.
 * id 로 서버에서 받거나(보관된 회차), run 을 직접 받는다(미리보기 — 보관 · 전달 안 함). 서버가 이미 범위로 자른 문서다.
 */
import React, { useState } from 'react';
import { STable } from '../../../components/STable.jsx';
import { postJson, downloadFile, canCsv } from '../../../api.js';
import { ErrorBox } from '../../../components/primitives.jsx';
import { StatusChip, useLoad } from './parts.jsx';
import { AXES, AXIS_LABEL, KIND_LABEL, CHANNEL_LABEL, DELIVERY_STATE, numText, kstText, countsLine, itemsByAxis, axisWorst, corpLabel } from './periodicReportText.js';

/** 항목 하나의 법인 행(표 아래 펼침 칸 — 정렬 표 안에 하위 행을 끼우지 않는다). */
function ItemDetail({ it, corpName, onClose }) {
  const rows = it.rows || [];
  return (
    <div className="prr-panel">
      <div className="prr-card-h"><b>{it.label}</b><StatusChip s={it.status} /><span className="prr-grow" /><button type="button" className="prr-rowbtn" onClick={onClose}>접기</button></div>
      <div className="prr-tablewrap">
        <STable minWidth={640}>
          <thead><tr><th>법인</th><th>판정</th><th>근거</th><th>직전</th></tr></thead>
          <tbody>{rows.map((r, i) => (
            <tr key={`${r.vc || 'x'}-${i}`}><td>{corpName(r.vc)}</td><td data-sort={['crit', 'warn', 'unknown', 'ok', 'info'].indexOf(r.status)}><StatusChip s={r.status} /></td><td className="prr-wrap">{r.text || '—'}</td><td>{r.prev ? <StatusChip s={r.prev} /> : '—'}</td></tr>
          ))}</tbody>
        </STable>
      </div>
      {(it.detail || []).length > 0 && <div className="prr-note">{it.detail.join(' · ')}</div>}
      <div className="prr-note">판정 기준: {it.rule}</div>
    </div>
  );
}

export default function ReportView({ id = '', run: given = null, previewId = null, isAdmin, scoped = false, onBack, onClose, onKept }) {
  const ld = useLoad(id ? `/tools/periodic-report/runs/${encodeURIComponent(id)}` : '', !!id && !given);
  const [act, setAct] = useState({ busy: false, msg: null });
  const [openKey, setOpenKey] = useState('');
  const [allActs, setAllActs] = useState(false);
  const run = given || ld.data?.run || null;
  const deliveries = ld.data?.deliveries || [];
  if (!given && ld.err) return <ErrorBox error={ld.err} />;
  if (!run) return <div className="prr-muted">{ld.busy ? '보고서를 불러오는 중…' : '보고서를 찾지 못했습니다.'}</div>;
  const corpName = (vc) => { const c = (run.corps || []).find((x) => x.vc === vc); return vc == null ? '법인 미지정' : corpLabel(c) || vc; };
  const byAxis = itemsByAxis(run.items);
  const keep = async () => {
    setAct({ busy: true, msg: null });
    try { const r = await postJson(`/tools/periodic-report/preview/${encodeURIComponent(previewId)}/keep`, {}); if (r?.ok) onKept?.(r.id); else setAct({ busy: false, msg: { ok: false, text: r?.reason || '보관하지 못했습니다' } }); }
    catch (e) { setAct({ busy: false, msg: { ok: false, text: String(e?.message || e) } }); }
  };
  const redeliver = async () => {
    setAct({ busy: true, msg: null });
    try {
      const r = await postJson(`/tools/periodic-report/runs/${encodeURIComponent(run.id)}/deliver`, {});
      setAct({ busy: false, msg: { ok: !!r?.ok, text: r?.ok ? '다시 보냈습니다' : `결과 — ${(r?.results || []).map((x) => `${CHANNEL_LABEL[x.channel] || x.channel} ${DELIVERY_STATE[x.state] || x.state}`).join(' · ') || r?.reason || '보낼 실패 경로가 없습니다'}` } });
      ld.reload();
    } catch (e) { setAct({ busy: false, msg: { ok: false, text: String(e?.message || e) } }); }
  };
  return (
    <div className="prr-report">
      <div className="prr-bar">
        {onBack && <button type="button" className="prr-btn" onClick={onBack}>← 보관함</button>}
        {onClose && <button type="button" className="prr-btn" onClick={onClose}>닫기</button>}
        <span className="prr-title">{KIND_LABEL[run.kind]} 점검 보고서 — {run.periodLabel}</span>
        <StatusChip s={run.overall} big />
        <span className="prr-grow" />
        {previewId && isAdmin && <button type="button" className="prr-btn primary" onClick={keep} disabled={act.busy}>이대로 보관하고 보내기</button>}
        {!previewId && <button type="button" className="prr-btn" onClick={() => downloadFile(`/tools/periodic-report/runs/${encodeURIComponent(run.id)}/report.html`).catch(() => {})}>HTML 보고서(PDF 저장용)</button>}
        {!previewId && canCsv() && <button type="button" className="prr-btn" onClick={() => downloadFile(`/tools/periodic-report/runs/${encodeURIComponent(run.id)}/export.xlsx`).catch(() => {})}>XLSX</button>}
        {!previewId && isAdmin && !scoped && <button type="button" className="prr-btn" onClick={redeliver} disabled={act.busy}>실패한 전달 다시 보내기</button>}
      </div>
      <div className="prr-muted">회차 {previewId ? '미리보기(보관 · 전달 안 함)' : run.id} · 기간 {kstText(run.periodFrom, { withYear: true })} ~ {kstText(run.periodTo, { withYear: true })} · 생성 {kstText(run.generatedAt, { withYear: true })}{run.manual ? ` (수동)` : ' (예약)'} · 법인 {numText(run.corpsReported)} / {numText(run.corpsTotal)} 보고 · 항목 {numText((run.items || []).length)}{run.scoped ? ' · 내 범위(법인)만' : ''}</div>
      {previewId && <div className="prr-banner amber">미리보기입니다 — 보관하지 않았고 보내지 않았습니다(잠시 뒤 서버에서 사라집니다 — 남기려면 ‘이대로 보관하고 보내기’).</div>}
      {run.mock && <div className="prr-banner amber">데모(목) 데이터로 만든 보고서입니다 — 메일 · 공지로 보내지 않습니다.</div>}
      {act.msg && <div className={`prr-banner${act.msg.ok ? '' : ' amber'}`}>{act.msg.text}</div>}

      <h3 className="prr-h">1. 종합</h3>
      <div className="prr-muted">{countsLine(run.counts)} — 확인 불가는 정상에 넣지 않고 따로 셉니다 · 정보 항목은 판정 수에 넣지 않습니다.</div>
      <div className="prr-axes">
        {AXES.map((a) => {
          const its = byAxis[a] || [];
          const c = (s) => its.filter((x) => x.status === s).length;
          const w = axisWorst(its);
          return (
            <div key={a} className="prr-axis">
              <div className="prr-card-h"><b>{AXIS_LABEL[a]}</b><span className="prr-muted">{its.length}항목</span>{w ? <StatusChip s={w} /> : null}</div>
              <div className="prr-muted">정상 {c('ok')} · 주의 {c('warn')} · 이상 {c('crit')} · 확인 불가 {c('unknown')} · 정보 {c('info')}</div>
            </div>
          );
        })}
      </div>

      <h3 className="prr-h">2. 조치 필요 <span className="prr-muted">{numText((run.actions || []).length)}건 · 이상 → 주의 순</span></h3>
      {(run.actions || []).length ? (
        <div className="prr-tablewrap">
          <STable minWidth={820} limit={allActs ? 0 : 30}>
            <thead><tr><th>판정</th><th>법인</th><th>축</th><th>항목</th><th>근거</th></tr></thead>
            <tbody>{run.actions.map((x, i) => (
              <tr key={`${x.item}-${x.vc || ''}-${i}`}><td data-sort={['crit', 'warn'].indexOf(x.status)}><StatusChip s={x.status} /></td><td>{x.corp}</td><td>{AXIS_LABEL[x.axis] || x.axis}</td><td>{x.label}</td><td className="prr-wrap">{x.basis}</td></tr>
            ))}</tbody>
          </STable>
        </div>
      ) : <div className="prr-muted">조치가 필요한 항목이 없습니다.</div>}
      {(run.actions || []).length > 30 && (
        <div className="prr-bar"><button type="button" className="prr-rowbtn" onClick={() => setAllActs((x) => !x)} aria-expanded={allActs}>{allActs ? '처음 30건만 보기' : `전부 보기(${numText(run.actions.length)}건)`}</button><span className="prr-muted">제목을 누르면 정렬한 뒤 자릅니다.</span></div>
      )}

      <h3 className="prr-h">3. 법인별 현황 <span className="prr-muted">칸은 그 축에서 가장 나쁜 판정</span></h3>
      <div className="prr-tablewrap">
        <STable minWidth={860}>
          <thead><tr><th>법인</th><th>vCenter</th>{AXES.map((a) => <th key={a}>{AXIS_LABEL[a]}</th>)}<th style={{ textAlign: 'right' }}>확인 불가</th><th style={{ textAlign: 'right' }}>조치</th><th>데이터 기준</th><th>수집</th></tr></thead>
          <tbody>{(run.corpTable || []).map((c) => (
            <tr key={c.vc}>
              <td>{corpLabel(c)}</td><td>{c.name}</td>
              {AXES.map((a) => <td key={a} data-sort={c.axes?.[a] ? ['crit', 'warn', 'unknown', 'ok'].indexOf(c.axes[a]) : null}>{c.axes?.[a] ? <StatusChip s={c.axes[a]} /> : '—'}</td>)}
              <td className="prr-num">{numText(c.unknown)}</td><td className="prr-num">{numText(c.actions)}</td>
              <td className="prr-mono" data-sort={c.asOf}>{kstText(c.asOf)}{c.reported ? '' : ' (보고 없음)'}</td><td>{c.mode === 'edge' ? '엣지' : '중앙'}</td>
            </tr>
          ))}</tbody>
        </STable>
      </div>

      {AXES.map((a, i) => {
        const its = byAxis[a] || [];
        const opened = its.find((x) => x.key === openKey) || null;
        return (
          <React.Fragment key={a}>
            <h3 className="prr-h">{4 + i}. {AXIS_LABEL[a]} <span className="prr-muted">{its.length}항목</span></h3>
            <div className="prr-tablewrap">
              <STable minWidth={820}>
                <thead><tr><th>항목</th><th>판정</th><th>근거</th><th>직전 회차</th><th data-nosort="1">법인 행</th></tr></thead>
                <tbody>{its.map((it) => (
                  <tr key={it.key}>
                    <td>{it.label}{it.na ? <span className="prr-muted"> · 해당 없음</span> : null}</td>
                    <td data-sort={['crit', 'warn', 'unknown', 'ok', 'info'].indexOf(it.status)}><StatusChip s={it.status} /></td>
                    <td className="prr-wrap">{it.basis || it.value || (it.unknownReason ? '' : '—')}{it.unknownReason ? <div className="prr-muted">확인 불가: {it.unknownReason}</div> : null}</td>
                    <td data-sort={it.prev?.status || ''}>{it.prev ? <StatusChip s={it.prev.status} /> : '—'}</td>
                    <td>{(it.rows || []).length ? <button type="button" className="prr-rowbtn" onClick={() => setOpenKey(openKey === it.key ? '' : it.key)} aria-expanded={openKey === it.key}>{openKey === it.key ? '접기' : `법인 ${it.rows.length}`}</button> : '—'}</td>
                  </tr>
                ))}</tbody>
              </STable>
            </div>
            {opened && <ItemDetail it={opened} corpName={corpName} onClose={() => setOpenKey('')} />}
          </React.Fragment>
        );
      })}

      <h3 className="prr-h">7. 확인하지 못한 것 <span className="prr-muted">{numText((run.unknowns || []).length)}건 — 정상으로도 이상으로도 세지 않았습니다</span></h3>
      {(run.unknowns || []).length ? (
        <div className="prr-tablewrap">
          <STable minWidth={760}>
            <thead><tr><th>항목</th><th>범위</th><th>사유</th><th>확인하려면</th></tr></thead>
            <tbody>{run.unknowns.map((u, i) => <tr key={`${u.item}-${i}`}><td>{u.label}</td><td className="prr-wrap">{u.where}</td><td className="prr-wrap">{u.reason}</td><td className="prr-wrap">{u.fix || '—'}</td></tr>)}</tbody>
          </STable>
        </div>
      ) : <div className="prr-muted">없습니다.</div>}

      {!previewId && !scoped && (
        <>
          <h3 className="prr-h">8. 전달 기록</h3>
          {deliveries.length ? (
            <div className="prr-tablewrap">
              <STable minWidth={720}>
                <thead><tr><th>경로</th><th>대상</th><th>결과</th><th>시각</th><th style={{ textAlign: 'right' }}>시도</th><th>사유</th></tr></thead>
                <tbody>{deliveries.map((d) => (
                  <tr key={d.id}><td>{CHANNEL_LABEL[d.channel] || d.channel}</td><td>{d.target === 'overall' ? '전체판' : d.target || '—'}</td><td>{DELIVERY_STATE[d.state] || d.state}{d.state === 'retry' && d.nextAt ? ` · 다음 ${kstText(d.nextAt)}` : ''}</td>
                    <td className="prr-mono" data-sort={d.at}>{kstText(d.at)}</td><td className="prr-num">{numText(d.attempt)}</td><td className="prr-wrap">{d.reason || '—'}</td></tr>
                ))}</tbody>
              </STable>
            </div>
          ) : <div className="prr-muted">전달 기록이 없습니다(전달이 꺼져 있었거나 수동 회차).</div>}
        </>
      )}
    </div>
  );
}
