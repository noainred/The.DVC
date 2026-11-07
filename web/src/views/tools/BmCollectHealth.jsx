/**
 * 리눅스 성능 6단계 — **수집 건강 보드**(메타 모니터링 · 설계 PROFILES §16 C · 아트보드 Collect).
 *
 * KPI → 법인별 표(대상 · 주기 소요/예산 · 성공률 · 실패 사유 · 동시성 · SSH · DB · 상태) → 주기 소요 추이 → 실패 사유 · 조치 → 저장 카드.
 * ⚠ 조립만 — 사유 분류 · 기준 대조는 수집 노드, 노드 상태는 라우트, 문구는 bmCollectText.js. 관리자 · 운영자만(서버 403 과 같은 판단).
 * ⚠ 조회는 마운트 1회 + ‘다시 읽기’(폴링 없음) · 403 은 ErrorBox.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { fetchJson, canCsv } from '../../api.js';
import { ErrorBox, Kpi } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import { toneVar } from './toneVar.js';
import { rttLine } from './bmOnboardText.js'; // 7b: 중앙 직접 수집 법인 RTT(서버 rttHigh 그대로)
import {
  nodeStateView, FLAG_TEXT, REASON_TEXT, REASON_STATE_TEXT, INFO_TEXT, PATH_TEXT, msText, pctText1, gbText, cycleText, concText, sshText, reasonsLine, daysSince,
  trendPaths, trendRangeText, COLLECT_HONEST, collectCsv, collectCsvName, unknownText, peakReasonText, NODE_ERROR_TEXT, famLine,
  maintRowText, maintLeakCell,
} from './bmCollectText.js';
import { numOrNull } from '../../numOrNull.js';
import './bmStage6.css';

const n0 = (v) => { const x = numOrNull(v); return x != null && x > 0; };

export function CollectHealthView({ resp, now = Date.now() }) {
  const [nodeSel, setNodeSel] = useState('');
  const nodes = resp?.nodes || [];
  const withNode = nodes.filter((x) => x.node);
  const cur = withNode.find((x) => x.agent === nodeSel) || withNode[0] || null;
  const tp = useMemo(() => trendPaths(cur?.trend || []), [cur]);
  const k = resp?.kpi || {};
  return (
    <>
      <div className="kpis">
        <Kpi label="법인 · 대상" value={k.corps ?? 0} unit={`법인 / ${k.servers ?? 0}대`} meta={`${nodes.length ? `노드 ${nodes.length}곳` : '노드 없음'}${unknownText(k.corpsUnknown, '법인')}`} />
        <Kpi label="마지막 주기 성공률" value={pctText1(k.successPct)} meta={`${k.servers ? `${k.okN ?? 0}/${k.servers}` : '대상 없음'}${unknownText(k.corpsUnknown, '법인')}`} accent={k.successPct != null && withNode.some((x) => x.flags?.includes('success')) ? toneVar('bad') : undefined} />
        <Kpi label="주기 소요(최대 노드)" value={k.worstCycle ? msText(k.worstCycle.cycleMs) : '—'} meta={k.worstCycle ? `예산 ${msText(k.worstCycle.budgetMs)} · ${pctText1(k.worstCycle.cyclePct)} · ${k.worstCycle.agent}` : '노드 값 없음'} />
        <Kpi label="수집 DB 크기(합 · 실측)" value={gbText(k.dbBytes)} meta={`파일 크기 실측(추정 아님)${unknownText(k.dbUnknown, '노드')}`} />
        <Kpi label="집중 모니터링" value={k.focusRunning ?? '—'} unit={k.focusRunning == null ? '' : '진행'} meta={`${k.focusQueued == null ? '—' : `대기 ${k.focusQueued}`}${unknownText(k.focusUnknown, '노드')}`} />
      </div>
      <section className="card" style={{ minWidth: 0 }}>
        <h5 className="bmo-h">법인별 수집 — 주기 소요 · 성공률 · 동시성 사용 · SSH · DB</h5>
        {/* 1440(사이드바 포함 본문 약 1,080px)에서 열마다 오른쪽 끝이 영역 안이게 — 최소 폭 960 · 노드 칸은 줄바꿈(6단계부터 1100 이라 ‘상태’ 열이 잘렸다 — 8a 반증 확인) · 400 은 표 안 가로 스크롤 */}
        <STable minWidth={960} className="bmo-t" style={{ fontSize: 12 }}>
          <thead><tr><th>법인</th><th>노드</th><th className="right">대상</th><th className="right">주기 소요 / 예산</th><th className="right">성공률</th><th>실패 사유</th><th className="right">동시성 사용</th><th className="right">SSH 중앙값 / p95</th><th className="right">DB · 파일</th><th>상태</th></tr></thead>
          <tbody>
            {(resp?.rows || []).map((r) => {
              const sv = nodeStateView(r.nodeState, { minEdgeVersion: resp.minEdgeVersion });
              const nd = nodes.find((x) => x.agent === r.agent && x.via === r.via);
              return (
                <tr key={`${r.agent}|${r.vcenterId}`}>
                  <td data-sort={r.vcenterId}>{r.vcenterId || '귀속 없음'}</td>
                  <td data-sort={r.agent} className="bmo-wrap" style={{ maxWidth: 200 }}>{r.agent || '—'}<div className="bmo-sub">{r.via === 'edge' ? '엣지' : '이 노드'}</div>
                    {(() => { const rl = rttLine(r); return rl ? <div className="bmo-sub" style={{ color: toneVar(rl.tone) }}>{rl.text}</div> : null; })()}</td>
                  <td className="right" data-sort={r.servers ?? ''}>{r.servers ?? '—'}</td>
                  <td className="right" data-sort={r.cyclePct ?? ''}>{r.nodeHidden ? <span className="bmo-sub">노드 값 숨김</span> : cycleText(r.cycleMs, r.budgetMs)}</td>
                  <td className="right" data-sort={r.successPct ?? ''}>{pctText1(r.successPct)}{maintRowText(r) && <div className="bmo-sub">{maintRowText(r)}</div>}</td>
                  <td data-sort={r.reasons?.[0]?.n ?? ''}>{reasonsLine(r.reasons)}</td>
                  <td className="right" data-sort={r.conc?.max ?? ''}>{r.nodeHidden ? '—' : concText(r.conc)}</td>
                  <td className="right" data-sort={r.ssh?.p95Ms ?? ''}>{r.nodeHidden ? '—' : sshText(r.ssh)}</td>
                  <td className="right" data-sort={r.dbBytes ?? ''}>{r.nodeHidden ? '—' : `${gbText(r.dbBytes)}${r.dbFiles != null ? ` · ${r.dbFiles}` : ''}`}</td>
                  <td data-sort={sv.label}><span style={{ color: toneVar(sv.tone) }}>{sv.label}</span>{(r.flags || nd?.flags || []).map((f) => <div key={f} className="bmo-sub" style={{ color: toneVar('warn') }}>{FLAG_TEXT[f] || f}</div>)}</td>
                </tr>
              );
            })}
          </tbody>
        </STable>
        {!(resp?.rows || []).length && <p className="bmo-note">보이는 법인이 없습니다{resp?.nodesOmitted ? `(범위 밖 노드 ${resp.nodesOmitted}곳은 싣지 않았습니다)` : ''}.</p>}
        {/* 8a단계 — 노드마다 ‘창 끝 뒤 억제’ 점검(정비 창 억제가 시한 뒤에 남지 않는가 — 0 이어야 정상) */}
        {withNode.map((x) => { const c = maintLeakCell(x.node); return (
          <p key={`mleak|${x.via}|${x.agent}`} className="bmo-note" title={c.title} style={{ color: toneVar(c.tone) }}>{x.agent || '이 노드'} — 정비 창 끝 뒤 억제 {c.text}{n0(x.node?.maint?.skipped) || n0(x.node?.maint?.failInWindow) ? ` · 정비 중 건너뜀 ${x.node.maint.skipped ?? 0} · 창 안 실패 ${x.node.maint.failInWindow ?? 0}(성공률 분모 밖)` : ''}</p>); })}
        {nodes.filter((x) => x.node?.error && NODE_ERROR_TEXT[x.node.error]).map((x) => (
          <p key={`err|${x.via}|${x.agent}`} className="bmo-note" style={{ color: toneVar(x.node.error === 'no-targets' ? 'idle' : 'bad') }}>{x.agent || '이 노드'} — {NODE_ERROR_TEXT[x.node.error]}</p>
        ))}
        {resp?.corpsDropped ? <p className="bmo-note">엣지가 보낸 법인별 값 중 그 엣지의 대상 · 설정 법인이 아닌 것 {resp.corpsDropped}건은 싣지 않았습니다.</p> : null}
        <p className="bmo-note"><BoldText text={'‘주기 소요’ 는 그 노드 폴러가 한 주기에 전 서버를 도는 데 걸린 벽시계 시간입니다. 예산(주기)에 가까우면 **재진입 가드**가 다음 주기를 건너뛰어 실제 간격이 늘어납니다 — 이 보드가 그 전에 알려 줍니다(기준은 설정 › 알림 규칙의 ‘수집 건강 기준’).'} /></p>
      </section>
      <section className="card" style={{ minWidth: 0 }}>
        <div className="bmcmp-ctl" style={{ marginTop: 0 }}>
          <h5 className="bmo-h" style={{ margin: 0 }}>주기 소요 추이(1시간 칸 · 최대)</h5>
          {withNode.map((x) => <button key={`${x.via}|${x.agent}`} type="button" className={`btn btn-sm bmp-touch${cur?.agent === x.agent ? ' btn-primary' : ''}`} aria-pressed={cur?.agent === x.agent} onClick={() => setNodeSel(x.agent)}>{x.agent || '이 노드'}</button>)}
        </div>
        {cur && tp.ms ? (
          <>
            <svg className="bmcmp-ovsvg" style={{ height: 140 }} viewBox="0 0 1000 140" preserveAspectRatio="none" role="img" aria-label="주기 소요 추이">
              {tp.budget && <path d={tp.budget} fill="none" stroke="var(--amber)" strokeDasharray="6 4" strokeWidth="1.2" strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
              <path d={tp.ms} fill="none" stroke="var(--accent-2)" strokeWidth="2.5" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              {tp.budgetDots && <path d={tp.budgetDots} fill="none" stroke="var(--amber)" strokeWidth="5" strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
              {tp.msDots && <path d={tp.msDots} fill="none" stroke="var(--accent-2)" strokeWidth="8" strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
            </svg>
            <div className="bmcmp-axis"><span>{trendRangeText(tp)}</span><span>최대 {msText(tp.yMax)}</span></div>
            {tp.n === 1 && <p className="bmo-note" style={{ margin: 0 }}>기록이 아직 한 시간 칸뿐입니다 — 다음 시간부터 선으로 이어집니다.</p>}
            <p className="bmo-note">실선 = 그 시간의 가장 긴 주기 · 점선 = 예산(주기). 기록은 그 노드 DB 에 30일 남습니다.</p>
          </>
        ) : <p className="bmo-note">추이를 그릴 노드 값이 없습니다(아직 주기 없음 · 엣지 버전 · 범위로 숨김).</p>}
      </section>
      <section className="card" style={{ minWidth: 0 }}>
        <h5 className="bmo-h">실패 사유 · 조치 — ‘왜 없는지’ 를 서버 단위로(상태 9종과 같은 분류)</h5>
        <STable minWidth={760} className="bmo-t" style={{ fontSize: 12 }}>
          <thead><tr><th>사유</th><th>분류</th><th className="right">서버</th><th className="right">며칠째</th><th>조치</th></tr></thead>
          <tbody>
            {(resp?.reasons || []).map((x) => (
              <tr key={`${x.path}:${x.code}`}>
                <td data-sort={x.code}>{PATH_TEXT[x.path] || x.path} {REASON_TEXT[x.code]?.label || x.code}</td>
                <td data-sort={x.state || ''}>{REASON_STATE_TEXT[x.state] || '—'}</td>
                <td className="right" data-sort={x.n}>{x.n}</td>
                <td className="right" data-sort={x.since ?? ''}>{daysSince(x.since, now)}</td>
                <td className="bmo-wrap">{REASON_TEXT[x.code]?.action || '—'}</td>
              </tr>
            ))}
          </tbody>
        </STable>
        {!(resp?.reasons || []).length && <p className="bmo-note">마지막 주기에 실패한 서버가 없습니다(정상인 빈 칸 — 아래 노드별 정보 참고).</p>}
        {withNode.map((x) => {
          const info = x.node?.info || {};
          const parts = Object.entries(info).filter(([, v]) => v).map(([kk, v]) => `${INFO_TEXT[kk] || kk} ${v}`);
          return parts.length ? <p key={x.agent} className="bmo-note">{x.agent || '이 노드'} — {parts.join(' · ')}</p> : null;
        })}
      </section>
      <section className="card" style={{ minWidth: 0 }}>
        <h5 className="bmo-h">저장 · 피크 창 · 중앙 당김</h5>
        <div className="bmh-grid">
          {withNode.map((x) => {
            const db = x.node.db || {};
            return (
              <div key={`${x.via}|${x.agent}`} className="bmh-cell" style={{ borderLeftColor: toneVar(x.flags?.includes('db') ? 'warn' : 'ok') }}>
                <div className="bmh-head"><b>{x.agent || '이 노드'}</b><span className="bmo-sub">{x.via === 'edge' ? '엣지' : '이 노드'}</span></div>
                <div className="bmh-v">{gbText(db.bytes)}</div>
                {(db.error || db.unread) ? <div className="bmo-sub" style={{ color: toneVar('warn') }}>{db.error ? '데이터 폴더를 읽지 못해 크기를 모릅니다' : `파일 ${db.unread}개의 크기를 읽지 못해 합을 내지 않았습니다`}(0 으로 세지 않습니다)</div> : null}
                <div className="bmo-sub">{famLine(db)}</div>
                <div className="bmo-sub">상한 {x.node.capBytes ? gbText(x.node.capBytes) : '없음'}{x.node.dbPct != null ? ` · ${pctText1(x.node.dbPct)}` : ''}</div>
                <div className="bmo-sub">피크 창 {x.node.peakPlan?.windowS ?? '—'}초(상한 {x.node.peakPlan?.capS ?? '—'}){peakReasonText(x.node.peakPlan?.reason) ? ` · ${peakReasonText(x.node.peakPlan.reason)}` : ''}</div>
                {x.via === 'edge' && <div className="bmo-sub">중앙 보관분 {x.snapAt ? daysSince(x.snapAt, now) : '—'}{x.lastAttempt ? ` · 마지막 당김 ${x.lastAttempt.ok ? '성공' : `실패(${x.lastAttempt.kind || '—'})`} ${msText(x.lastAttempt.ms)}` : ''}</div>}
              </div>
            );
          })}
        </div>
        {!withNode.length && <p className="bmo-note">저장 값을 볼 노드가 없습니다.</p>}
      </section>
      <p className="bmo-note">{COLLECT_HONEST}</p>
    </>
  );
}

export default function BmCollectHealth() {
  const [st, setSt] = useState({ resp: null, err: null, loading: false });
  const load = React.useCallback(() => {
    setSt((x) => ({ ...x, loading: true, err: null }));
    fetchJson('/tools/bm-usage/collect-health').then((r) => setSt({ resp: r, err: null, loading: false })).catch((e) => setSt({ resp: null, err: e, loading: false }));
  }, []);
  useEffect(() => { load(); }, [load]);
  function exportCsv() {
    const blob = new Blob([`\uFEFF${collectCsv(st.resp)}`], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = collectCsvName(st.resp?.at); a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  return (
    <div className="card" style={{ minWidth: 0 }} data-capture="bm-collect-health">
      <div className="bmcmp-top">
        <h4 style={{ margin: 0 }}>수집 건강 보드</h4>
        <span className="bmo-note" style={{ margin: 0 }}>수집 자체가 병목인지 · 저장이 커지는지 — 법인(노드)별</span>
        <span style={{ flex: '1 1 auto' }} />
        {canCsv() && <button type="button" className="btn btn-sm bmp-touch" disabled={!st.resp} onClick={exportCsv}>CSV</button>}
        <button type="button" className="btn btn-sm bmp-touch" disabled={st.loading} onClick={load}>{st.loading ? '읽는 중…' : '다시 읽기'}</button>
      </div>
      {st.err && (st.err.status === 403 ? <ErrorBox error={st.err} /> : <p className="bmo-note" style={{ color: toneVar('bad') }}>읽지 못했습니다: {st.err.message || String(st.err)}</p>)}
      {!st.resp && !st.err && <p className="bmo-note">불러오는 중…</p>}
      {st.resp && <CollectHealthView resp={st.resp} />}
    </div>
  );
}
