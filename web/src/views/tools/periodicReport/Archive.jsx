/**
 * Archive — ① 보관함(설계 시안 ①): 주기별 다음 회차 · 최근 회차 요약 · 회차 표(제목 클릭 정렬). 범위 계정은 판정 수가 자기 범위 기준(서버가 다시 센다).
 *   v3.59(시안 §9): 최근 일일 회차의 백업 띠 · 표의 '백업 실패' 열(회차 행렬에서 서버가 범위로 다시 센 값 — 확정된 날이 없으면 '—').
 */
import React, { useState } from 'react';
import { STable } from '../../../components/STable.jsx';
import { KINDS, KIND_LABEL, numText, kstText, scheduleLine, nextText, statusText, backupCellText } from './periodicReportText.js';
import { StatusChip, useLoad } from './parts.jsx';

export default function Archive({ status, scoped, onOpen }) {
  const [kind, setKind] = useState('');
  const [days, setDays] = useState(90);
  const runs = useLoad(`/tools/periodic-report/runs?days=${days}&limit=200${kind ? `&kind=${kind}` : ''}`);
  const list = runs.data?.runs || [];
  const last = list[0] || null;
  const lastBk = list.find((r) => r.kind === 'daily' && r.backup) || null;   // 최근 일일 회차의 백업(목록 안에서 — 주기 필터가 일일이 아니면 없을 수 있다)
  return (
    <>
      <div className="prr-cards">
        {KINDS.map((k) => {
          const s = status?.kinds?.[k];
          return (
            <div key={k} className="prr-card">
              <div className="prr-card-h"><b>{KIND_LABEL[k]}</b><span className={`prr-pill${s?.enabled ? ' on' : ''}`}>{s?.enabled ? '켜짐' : '꺼짐'}</span></div>
              <div className="prr-mono prr-big">{nextText(s)}</div>
              <div className="prr-muted">{scheduleLine(k, s?.def)} · 항목 {numText(s?.items)}</div>
              <div className="prr-muted">마지막 {s?.last ? `${kstText(s.last.generatedAt)}${s.last.overall ? ` · ${statusText(s.last.overall)}` : ''}` : '없음'}</div>
            </div>
          );
        })}
      </div>
      {last && (
        <div className="prr-tiles">
          <div className="prr-tile"><span className="prr-lab">최근 회차</span><b className="prr-mono">{last.id}</b><span className="prr-muted">{KIND_LABEL[last.kind]} · {kstText(last.generatedAt)}</span></div>
          <div className="prr-tile"><span className="prr-lab">종합</span><StatusChip s={last.overall} big /></div>
          <div className="prr-tile"><span className="prr-lab">정상</span><b>{numText(last.counts?.ok)}</b></div>
          <div className="prr-tile"><span className="prr-lab">주의</span><b>{numText(last.counts?.warn)}</b></div>
          <div className="prr-tile"><span className="prr-lab">이상</span><b>{numText(last.counts?.crit)}</b></div>
          <div className="prr-tile"><span className="prr-lab">확인 불가</span><b>{numText(last.counts?.unknown)}</b><span className="prr-muted">정상으로 세지 않음</span></div>
        </div>
      )}
      {lastBk && (
        <div className="prr-banner">
          <b>백업 성공 · 실패</b> — 최근 일일 {lastBk.id}{Number(lastBk.backup.sealed) > 0
            ? ` · 끝난 백업 ${numText(lastBk.backup.ended)} · 실패 ${numText(lastBk.backup.fail)}${Number(lastBk.backup.unknown) > 0 ? ` · 확인 불가 ${numText(lastBk.backup.unknown)}(법인 · 백업 · 날)` : ''}`
            : ' · 확정된 날이 없습니다(적재 전)'}{scoped ? ' · 내 범위(법인) 기준' : ''}
          {' '}<button type="button" className="prr-rowbtn" onClick={() => onOpen(lastBk.id)}>보고서 열기</button>
        </div>
      )}
      <div className="prr-bar">
        <div className="prr-seg" role="group" aria-label="주기">
          <button type="button" className={kind === '' ? 'on' : ''} aria-pressed={kind === ''} onClick={() => setKind('')}>전체</button>
          {KINDS.map((k) => <button key={k} type="button" className={kind === k ? 'on' : ''} aria-pressed={kind === k} onClick={() => setKind(k)}>{KIND_LABEL[k]}</button>)}
        </div>
        <div className="prr-seg" role="group" aria-label="기간">
          {[[30, '30일'], [90, '90일'], [365, '1년'], [1825, '5년']].map(([d, l]) => <button key={d} type="button" className={days === d ? 'on' : ''} aria-pressed={days === d} onClick={() => setDays(d)}>{l}</button>)}
        </div>
        <span className="prr-grow" />
        <span className="prr-muted">{runs.data ? `${numText(runs.data.total)}개 중 ${numText(list.length)}개` : ''}{scoped ? ' · 판정 수는 내 범위(법인) 기준' : ''}</span>
      </div>
      {runs.err && <div className="prr-banner amber">보관함을 불러오지 못했습니다: {String(runs.err?.message || runs.err)}</div>}
      {runs.busy && !runs.data && <div className="prr-muted">불러오는 중…</div>}
      {runs.data && !list.length && <div className="prr-banner">이 조건에 맞는 회차가 아직 없습니다 — 정한 시각이 되면 만들어지고, ‘일정 · 전달’ 에서 지금 만들 수도 있습니다.</div>}
      {list.length > 0 && (
        <div className="prr-tablewrap">
          <STable minWidth={1060}>
            <thead><tr>
              <th>생성</th><th>회차</th><th>주기</th><th>종합</th><th style={{ textAlign: 'right' }}>정상</th><th style={{ textAlign: 'right' }}>주의</th><th style={{ textAlign: 'right' }}>이상</th>
              <th style={{ textAlign: 'right' }}>확인 불가</th><th style={{ textAlign: 'right' }}>정보</th><th style={{ textAlign: 'right' }}>백업 실패</th><th style={{ textAlign: 'right' }}>법인</th><th>만든 이</th><th data-nosort="1">열기</th>
            </tr></thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id}>
                  <td className="prr-mono" data-sort={r.generatedAt}>{kstText(r.generatedAt, { withYear: true })}</td>
                  <td className="prr-mono">{r.id}</td>
                  <td>{KIND_LABEL[r.kind]}</td>
                  <td data-sort={['crit', 'warn', 'unknown', 'ok'].indexOf(r.overall)}><StatusChip s={r.overall} /></td>
                  <td className="prr-num">{numText(r.counts?.ok)}</td><td className="prr-num">{numText(r.counts?.warn)}</td><td className="prr-num">{numText(r.counts?.crit)}</td>
                  <td className="prr-num">{numText(r.counts?.unknown)}</td><td className="prr-num">{numText(r.counts?.info)}</td>
                  <td className="prr-num" data-sort={Number(r.backup?.sealed) > 0 ? r.backup.fail : null} title={r.backup ? (Number(r.backup.sealed) > 0 ? `끝난 백업 ${numText(r.backup.ended)} · 확정 ${numText(r.backup.sealed)} / ${numText(r.backup.days)}일${Number(r.backup.unknown) > 0 ? ` · ? = 확인 불가(법인 · 백업 · 날) ${numText(r.backup.unknown)}` : ''}` : '확정된 날이 없습니다(적재 전)') : '이 회차에는 백업 절이 없습니다'}>{backupCellText(r.backup)}</td>
                  <td className="prr-num">{r.corpsReported != null ? `${numText(r.corpsReported)}/${numText(r.corpsTotal)}` : numText(r.corpsTotal)}</td>
                  <td>{r.manual ? `수동 ${r.by || ''}` : '예약'}</td>
                  <td><button type="button" className="prr-rowbtn" onClick={() => onOpen(r.id)}>열기</button></td>
                </tr>
              ))}
            </tbody>
          </STable>
        </div>
      )}
    </>
  );
}
