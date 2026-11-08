/**
 * 서버 상세 ‘장애 기록’ 탭(리눅스 성능 4단계 · 아트보드 ⑦ Faults.dc.html) — 요약 5칸 → 발생 1건 = 1행 표 → 시간순(부품 전이 · SEL/LC).
 * ⚠ **새 수집 없음** — 부품 장애 모듈(partfault)의 장애별 묶음을 서버 하나로 좁힌 것이다. 상태 · 종료 사유 · 보류 사유 문구는 기존 `partFaultText.js` 를 그대로 쓴다(복제 금지).
 * ⚠ part-faults 도구 접근이 없는 계정은 내용 없이 ‘권한 없음’(서버가 정한다).
 */
import React, { useMemo, useState } from 'react';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import { toneVar } from './toneVar.js';
import { OpsError, useOpsLoad } from './BmTuningTab.jsx';
import { perfPath } from './bmPerfUrl.js'; // 다음 점검 ①: 서버 = (법인, 키) 쌍 — 요청에 법인을 싣는다
import { incidentStateText, incidentStartText, incidentEndText, incidentStateRank, INCIDENT_END_TEXT } from './partFaultText.js';
import { faultKpiCards, FAULT_RULES_NOTE, faultTimeline, durationText, shortStamp, holdText } from './bmOpsText.js';
import './bmOps.css';

export const FAULT_PERIODS = Object.freeze([30, 90, 365, 0]);

export function IncidentTable({ rows = [], labels = {}, withServer = false, onServer = null }) {
  return (
    <STable minWidth={withServer ? 1000 : 940} className="bmo-t" style={{ fontSize: 12 }}>
      <thead>
        <tr>
          {withServer && [<th key="srv">서버</th>, <th key="corp">법인</th>]}
          <th>발생</th><th>종료</th><th>지속</th><th>부품 종류</th><th>부품</th><th>상태 · 원문</th><th>종료 사유</th><th>보류 사유</th><th className="right">반복</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((i) => {
          const st = incidentStateText(i, labels);
          const s0 = incidentStartText(i);
          const end = i.ongoing ? null : (INCIDENT_END_TEXT[i.endReason] || INCIDENT_END_TEXT.unknown);
          return (
            <tr key={`${i.key || ''}|${i.id}`}>
              {/* ⚠ 칸은 배열로(Fragment 로 감싸면 STable 정렬이 칸을 세지 못한다 — web.md v2.920 D1 · Chromium 1440 판독) */}
              {withServer && [
                <td key="srv" data-sort={i.server}>{onServer ? <span className="bmp-link" role="button" tabIndex={0} onClick={() => onServer(i.key, i.vcenterId || '')} onKeyDown={(e) => { if (e.key === 'Enter') onServer(i.key, i.vcenterId || ''); }}>{i.server}</span> : i.server}</td>,
                <td key="corp" data-sort={i.vcenterId || ''}>{i.vcenterId || '—'}</td>,
              ]}
              <td data-sort={i.openedAt ?? ''} title={s0.title || ''}>{s0.text}{s0.note && <div className="bmo-sub">{s0.note}</div>}</td>
              <td data-sort={i.closedAt ?? ''}>{incidentEndText(i)}</td>
              <td data-sort={i.durationMs ?? ''}>{durationText(i.durationMs, { ongoing: i.ongoing })}</td>
              <td data-sort={i.kind}>{labels.kind?.[i.kind] || i.kind}</td>
              <td data-sort={i.label} className="bmo-wrap">{i.label}</td>
              <td data-sort={incidentStateRank(i)} className="bmo-wrap"><span style={{ color: toneVar(st.tone) }} title={st.title}>{st.text}</span>{i.rawState && <div className="bmo-sub">‘{i.rawState}’</div>}</td>
              <td data-sort={i.endReason || ''} title={end?.title || ''}>{end ? end.label : '—'}</td>
              <td data-sort={i.holdReason || ''} className="bmo-wrap">{i.holdReason ? holdText(i.holdReason) : '—'}</td>
              <td className="right" data-sort={i.occurrences ?? 1}>{i.occurrences > 1 ? `${i.occurrences}회` : '—'}</td>
            </tr>
          );
        })}
      </tbody>
    </STable>
  );
}

export function FaultsView({ resp, days, onDays }) {
  const [kind, setKind] = useState('');
  const rows = useMemo(() => (resp?.incidents || []).filter((i) => !kind || i.kind === kind), [resp, kind]);
  const kinds = useMemo(() => [...new Set((resp?.incidents || []).map((i) => i.kind))], [resp]);
  if (resp && resp.partFaultsAccess === false) return <p className="bmo-note"><BoldText text={`**권한 없음** — 부품 장애 기록은 ‘파트 장애’ 도구 접근이 있어야 봅니다. ${resp.reason || ''}`} /></p>;
  if (resp && resp.available === false) return <p className="bmo-note">{resp.reason || '부품 장애 기록을 읽지 못했습니다.'}</p>;
  const labels = resp?.labels || {};
  const timeline = faultTimeline(resp?.incidents || [], resp?.sel || null, labels);
  return (
    <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
      <div className="bmo-kpis">
        {faultKpiCards(resp?.kpis || {}, { days }).map((c) => (
          <div key={c.key} className="bmo-kpi">
            <div className="bmo-k">{c.label}</div>
            <div className="bmo-kv" style={{ color: toneVar(c.tone) }}>{c.value}</div>
            {c.note && <div className="bmo-sub">{c.note}</div>}
          </div>
        ))}
      </div>
      <section className="bmo-card">
        <h5 className="bmo-h">장애 기록 — 발생 1건 = 1행(같은 부품의 발생 → 변화 → 해소를 한 건으로)</h5>
        <div className="bmo-bar">
          <div className="bmp-seg" role="tablist" aria-label="기간">
            {FAULT_PERIODS.map((d) => <button key={d} role="tab" aria-selected={days === d} className={days === d ? 'active' : ''} onClick={() => onDays?.(d)}>{d ? `${d}일` : '전체(보존 기간)'}</button>)}
          </div>
          <div className="bmp-chips">
            <button className={`btn btn-sm${!kind ? ' active' : ''}`} onClick={() => setKind('')}>부품 전체</button>
            {kinds.map((k) => <button key={k} className={`btn btn-sm${kind === k ? ' active' : ''}`} onClick={() => setKind(k)}>{labels.kind?.[k] || k}</button>)}
          </div>
        </div>
        {rows.length ? <IncidentTable rows={rows} labels={labels} /> : <p className="bmo-note">이 기간에 이 서버의 부품 장애 기록이 없습니다 — 부품 장애 수집이 꺼져 있거나(그 경우 ‘없음’ 이 아니라 ‘모름’) iDRAC 등록이 없는 서버일 수 있습니다.</p>}
        {resp?.omitted > 0 && <p className="bmo-note">상한으로 {resp.omitted}건은 싣지 않았습니다.</p>}
        <p className="bmo-note"><BoldText text={FAULT_RULES_NOTE} /></p>
        {resp?.scan?.truncated && <p className="bmo-note">이력이 많아 {shortStamp(resp.scan.coveredSince)} 이후만 읽었습니다.</p>}
      </section>
      <section className="bmo-card">
        <h5 className="bmo-h">시간순 — 부품 전이 · iDRAC SEL/LC(시각으로만 정렬 — 인과를 적지 않습니다)</h5>
        {timeline.length ? (
          <div className="bmo-tl">
            {timeline.map((x, i) => (
              <div key={i} className="bmo-tl-row">
                <span className="bmo-tl-at">{x.at != null ? shortStamp(x.at) : (x.raw || '—')}</span>
                <span className="bmp-chip">{x.src}</span>
                <span className="bmo-wrap">{x.text}</span>
              </div>
            ))}
          </div>
        ) : <p className="bmo-note">시간순으로 보일 기록이 없습니다.</p>}
        {resp?.selSource === 'none' && <p className="bmo-note">SEL/LC 목록은 이 노드가 iDRAC 인벤토리를 가진 서버만 보입니다(엣지 위임 서버는 중앙에 목록이 없습니다 — 개수만 하드웨어 탭). OS 커널 로그는 진단 스냅샷 탭에서 봅니다.</p>}
      </section>
    </div>
  );
}

/** 키 = ‘서버 키|기간’ — 기간을 바꾸면 키가 바뀌어 다시 읽는다(늦은 응답은 세대로 버림). */
export const faultsUrl = (k, vc = '') => { const i = String(k).lastIndexOf('|'); return perfPath(String(k).slice(0, i), vc, '/faults', `days=${String(k).slice(i + 1)}`); };

export default function BmFaultsTab({ itemKey, vc = '' }) {
  const [days, setDays] = useState(90);
  const { resp, err, loading, reload } = useOpsLoad(faultsUrl, `${itemKey}|${days}`, vc);
  return (
    <div style={{ minWidth: 0 }}>
      <div className="bmo-bar">
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>기존 파트 장애 모듈의 기록을 이 서버로 좁혀 봅니다(새 수집 없음)</span>
        <span style={{ flex: '1 1 auto' }} />
        <a className="btn btn-sm bmp-touch" href="#/tools/part-faults">파트 장애 도구에서 열기</a>
        <button className="btn btn-sm bmp-touch" onClick={reload} disabled={loading}>{loading ? '읽는 중…' : '다시 읽기'}</button>
      </div>
      <OpsError err={err} />
      {!resp && !err && <p className="bmo-note">장애 기록을 불러오는 중…</p>}
      {resp && <FaultsView resp={resp} days={days} onDays={setDays} />}
    </div>
  );
}
