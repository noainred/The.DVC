/**
 * 백업 서머리 — 특수 기능 `backup-summary`(v2.779, 사용자 요청 '전체 28개 vcenter 의 백업 현황 · veeam 백업과 snapshot 둘다' + 시안).
 * 메뉴: Veeam 현황 › Summary(v2.785 — 예전 '백업 › 백업 서머리' · 도구 키 그대로). 값은 서버(GET /api/tools/backup-summary — veeam/backupStatus.js)가 vCenter 카드·VM 화면과 같은 기준으로 낸다.
 * ⚠ 무거운 집계라 폴링하지 않는다(마운트 1회 + 새로고침 · 서버 60초 캐시) · 늦게 온 이전 응답은 버린다 · 훅은 조기 return 위.
 * ⚠ 못 읽은 값은 '—'(0 이 아니다) · 두 수는 같은 VM 을 다른 방법으로 센 것이라 더하지 않는다.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson, downloadFile, canCsv } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { fmtNum, pctOf, veeamStateOf, snapReasonText, filterRows, attentionList, summaryKpis, runningCell, shortTs, isIrs, loadOpts, saveOpts, scopeQuery, scopeNote, CRIT, marksLine, marksNotice } from './backupViewText.js';
import { CritIcon, NeedIcon, NEED_COLOR } from './BackupMarkIcons.jsx';
import BackupOptions from './BackupOptions.jsx';

export const DETAIL_VC_KEY = 'backup-detail-vc';   // 서머리에서 고른 vCenter 를 세부내용이 이어받는다(이 브라우저에만)

const TONE = { ok: '#86efac', bad: '#fca5a5', warn: '#fcd34d', info: '#93c5fd', muted: 'var(--text-dim)' };
const TONE_BG = { ok: 'rgba(34,197,94,.12)', bad: 'rgba(239,68,68,.14)', warn: 'rgba(245,158,11,.14)', info: 'rgba(59,130,246,.14)', muted: 'transparent' };

function Kpi({ label, value, sub, color, border, dashed }) {
  // v2.781(점검 G3): '수 · 비율%' 은 비율을 작게 · 두 조각 사이에서만 줄바꿈 — 28px 한 줄(nowrap)은 1440px 카드 폭(약 180px)에 '1,398 · 66%' 가 테두리에 닿았고
  //   부분 합 표지('1,398* · 66%')면 카드 밖으로 넘쳤다(세부내용 헤더와 같은 모양).
  const cut = typeof value === 'string' ? value.indexOf(' · ') : -1;
  return (
    <div className="card" style={{ padding: '14px 16px', minWidth: 0, border: `1px ${dashed ? 'dashed' : 'solid'} ${border || 'var(--border)'}` }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: color || 'var(--text-dim)' }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 800, marginTop: 4, color: color || 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>
        {cut < 0 ? <span style={{ whiteSpace: 'nowrap' }}>{value}</span> : <><span style={{ whiteSpace: 'nowrap' }}>{value.slice(0, cut)}</span> <span style={{ whiteSpace: 'nowrap', fontSize: 18 }}>{value.slice(cut + 1)}</span></>}
      </div>
      {sub && <div className="muted" style={{ fontSize: 12, marginTop: 2, overflowWrap: 'anywhere' }}>{sub}</div>}
    </div>
  );
}

function Bar({ pct, color }) {
  return <div style={{ height: 5, borderRadius: 3, background: 'var(--panel-deep)', marginTop: 4 }}><div style={{ height: 5, borderRadius: 3, background: color, width: `${pct || 0}%` }} /></div>;
}

export function openDetail(vcId) {
  try { localStorage.setItem(DETAIL_VC_KEY, vcId); } catch { /* 저장 못 해도 세부내용은 첫 vCenter 로 열린다 */ }
  window.location.hash = '#/tools/backup-detail';
}

export default function BackupSummaryTool() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('all');
  const [opts, setOpts] = useState(() => loadOpts());
  const [csvErr, setCsvErr] = useState(null);
  const gen = useRef(0);
  // 전원·제외는 서버가 센다(같은 backupRow — 세부내용과 같은 수) · 바꾸면 그 조건으로 다시 읽는다. RPO 기준은 같은 응답에서 고른다.
  const load = useCallback(() => {
    const my = ++gen.current;
    setLoading(true); setError(null);
    fetchJson('/tools/backup-summary', scopeQuery(opts))
      .then((r) => { if (my === gen.current) setData(r); })
      .catch((e) => { if (my === gen.current) setError(e); })
      .finally(() => { if (my === gen.current) setLoading(false); });
  }, [opts.power, opts.excl]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); return () => { gen.current++; }; }, [load]);
  const changeOpts = useCallback((o) => { setOpts(o); saveOpts(o); }, []);
  const csv = useCallback(async () => {
    setCsvErr(null);
    try { await downloadFile(`/tools/backup-summary.csv?${new URLSearchParams(scopeQuery(opts))}`); } catch (e) { setCsvErr(e); }
  }, [opts]);

  if (!data && loading) return <Loading />;
  // v2.785(GV C-B4): 오류 객체를 그대로 — 403 을 문자열로 바꾸면 ErrorBox 가 권한 안내(AccessDenied)로 바꾸지 못했다
  if (!data && error) return <ErrorBox error={error} />;
  if (!data) return null;

  const rows = Array.isArray(data.rows) ? data.rows : [];
  const t = data.totals || {};
  const shown = filterRows(rows, filter);
  const att = attentionList(rows);
  const kpi = summaryKpis(t, { rpoDays: opts.rpoDays });   // v2.781(점검 G3 C-B2): 아는 곳 0 이면 '—' · 분모는 그 기준을 아는 VM 합 · 부분 합 '*'
  const splitKnown = t.vcenters > 0 && t.splitUnknown < t.vcenters;
  const splitTotal = (t.both || 0) + (t.vOnly || 0) + (t.sOnly || 0) + (t.none || 0);
  const seg = (n) => (splitTotal ? `${(n / splitTotal) * 100}%` : '0%');
  const rpoKey = `d${opts.rpoDays}`;
  const note = scopeNote(data.scope, t);
  // v2.785(GR R-B2): 표시 파일을 못 읽었으면 수는 '—'(0 이 아니다) · 안내는 세부내용과 같은 문구
  const mk = marksLine(t.marks, data.marksUnreadable);
  const mkNote = marksNotice(data);
  const chips = [['all', `전체 ${rows.length}`], ['davinci', `다빈치 ${rows.filter((r) => !isIrs(r.name)).length}`], ['irs', `IRS ${rows.filter((r) => isIrs(r.name)).length}`], ['warn', '주의 필요']];

  return (
    <div data-backup-summary="" style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
      <div className="flex gap wrap" style={{ alignItems: 'flex-end', rowGap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div className="muted" style={{ fontSize: 13 }}>Veeam 현황</div>
          <div style={{ fontSize: 20, fontWeight: 800 }}>Summary</div>
          <div className="muted" style={{ fontSize: 13 }}>vCenter {fmtNum(t.vcenters)}개 — Veeam 서버가 아는 백업과 vCenter 스냅샷으로 본 백업 흔적을 나란히 봅니다.</div>
        </div>
        <div className="flex gap wrap" style={{ marginLeft: 'auto', alignItems: 'center' }}>
          <span className="muted" style={{ fontSize: 12 }}>기준 {shortTs(data.at)}{error ? ' · 최근 새로고침 실패 — 이전 값' : ''}</span>
          {canCsv() && <button type="button" className="tab" onClick={csv} style={{ padding: '6px 14px' }}>CSV</button>}
          <button type="button" className="tab" disabled={loading} onClick={load} style={{ padding: '6px 14px' }}>{loading ? '읽는 중…' : '새로고침'}</button>
        </div>
      </div>
      <div className="flex gap wrap" style={{ alignItems: 'center', rowGap: 6 }}>
        <BackupOptions opts={opts} onChange={changeOpts} disabled={loading} />
        {note && <span className="muted" style={{ fontSize: 12, overflowWrap: 'anywhere', minWidth: 0 }}>{note}</span>}
      </div>
      {csvErr && <div className="card" style={{ padding: '8px 12px', color: TONE.bad, fontSize: 12 }}>CSV 내보내기 실패 — {csvErr?.status === 403 ? 'CSV 권한이 없습니다.' : String(csvErr.message || csvErr)}</div>}
      {data.registryUnreadable && <div className="card" style={{ padding: '8px 12px', color: TONE.bad, fontSize: 12 }}>Veeam 서버 등록부를 읽지 못해 Veeam 기준은 모두 확인 불가입니다 — 설정 › Veeam 백업 서버를 확인하세요.</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
        <Kpi label="전체 VM" value={kpi.vm.value} sub={kpi.vm.sub} />
        <Kpi label="Veeam 백업 대상" value={kpi.veeam.value} color="#4ade80" border="#1d4d33" sub={kpi.veeam.sub} />
        <Kpi label="스냅샷으로 본 백업" value={kpi.snap.value} color="#c084fc" border="#6b3fa0" dashed sub={kpi.snap.sub} />
        <Kpi label="어느 쪽에도 안 보임" value={splitKnown ? fmtNum(t.none) : '—'} sub="백업 안 됨이 아니라 확인되지 않음" />
        <Kpi label="지금 백업 중" value={kpi.running.value} color="#fbbf24" border="#5c4513" sub={kpi.running.sub} />
        <Kpi label={`오래된 백업(${opts.rpoDays}일 초과)`} value={kpi.rpo.value} color="#fb923c" border="#5c3413" sub={kpi.rpo.sub} />
      </div>
      {/* v2.784: 백업 세부내용에서 사람이 정한 표시의 합(같은 범위 — 전원·제외) · 표에는 열을 더하지 않는다(1440 폭 유지) */}
      {mk && (
        <div className="card" data-backup-marks="" style={{ padding: '10px 16px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 22px', minWidth: 0, fontSize: 13 }}>
          <b style={{ fontSize: 13 }}>업무 중요도</b>
          {CRIT.map((c) => <span key={c.key} className="flex" style={{ gap: 6, alignItems: 'center', whiteSpace: 'nowrap' }}><CritIcon crit={c.key} withText /><b style={{ fontSize: 18, fontVariantNumeric: 'tabular-nums', color: mk[c.key] == null ? 'var(--text-dim)' : undefined }}>{fmtNum(mk[c.key])}</b></span>)}
          <span style={{ width: 1, alignSelf: 'stretch', background: 'var(--border)' }} aria-hidden="true" />
          <span className="flex" style={{ gap: 6, alignItems: 'center', whiteSpace: 'nowrap' }}><NeedIcon /><span style={{ color: NEED_COLOR }}>백업 필요</span><b style={{ fontSize: 18, fontVariantNumeric: 'tabular-nums', color: mk.need == null ? 'var(--text-dim)' : undefined }}>{fmtNum(mk.need)}</b></span>
          {mk.need > 0 && <span style={{ minWidth: 0, overflowWrap: 'anywhere', color: mk.needGap > 0 ? TONE.bad : 'var(--text-dim)' }}>그중 Veeam 백업 안 보임 <b>{fmtNum(mk.needGap)}</b>{mk.needGapUnknown ? <span className="muted"> (Veeam 확인 불가 {mk.needGapUnknown}곳 제외)</span> : null}</span>}
          {mkNote
            ? <span style={{ flexBasis: '100%', fontSize: 12, minWidth: 0, overflowWrap: 'anywhere', color: mkNote.tone === 'bad' ? TONE.bad : '#fcd34d' }}>{mkNote.text}</span>
            : <span className="muted" style={{ fontSize: 12, marginLeft: 'auto', minWidth: 0, overflowWrap: 'anywhere' }}>Detail 에서 VM 마다 정합니다</span>}
        </div>
      )}

      <div className="card" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
        <div className="flex gap wrap" style={{ alignItems: 'baseline', rowGap: 4 }}>
          <b style={{ fontSize: 14 }}>VM 백업이 보이는 비율</b>
          <span className="muted" style={{ fontSize: 12 }}>같은 VM 은 한 번만 — 두 쪽에 다 보이면 둘 다{t.splitUnknown ? ` · 한쪽을 못 읽은 vCenter ${t.splitUnknown}곳은 빠짐` : ''}</span>
        </div>
        {splitKnown && splitTotal > 0 ? (
          <div role="img" aria-label={`둘 다 ${t.both} · Veeam 만 ${t.vOnly} · 스냅샷만 ${t.sOnly} · 확인 안 됨 ${t.none}`} style={{ display: 'flex', height: 20, borderRadius: 8, overflow: 'hidden', background: 'var(--panel-deep)' }}>
            <div style={{ width: seg(t.both), background: '#16a34a' }} />
            <div style={{ width: seg(t.vOnly), background: '#4ade80' }} />
            <div style={{ width: seg(t.sOnly), background: '#a855f7' }} />
            <div style={{ width: seg(t.none), background: '#263248' }} />
          </div>
        ) : <div className="muted" style={{ fontSize: 12 }}>나눌 수 있는 vCenter 가 없습니다(두 기준 중 하나를 못 읽음).</div>}
        <div className="flex gap wrap" style={{ fontSize: 12, rowGap: 6 }}>
          <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: '#16a34a', marginRight: 6 }} />둘 다 {fmtNum(t.both)}</span>
          <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: '#4ade80', marginRight: 6 }} />Veeam 만 {fmtNum(t.vOnly)}</span>
          <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: '#a855f7', marginRight: 6 }} />스냅샷만 {fmtNum(t.sOnly)}</span>
          <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: '#263248', border: '1px solid var(--border)', marginRight: 6 }} />확인 안 됨 {fmtNum(t.none)}</span>
        </div>
      </div>

      <div className="flex wrap" style={{ gap: 16, alignItems: 'flex-start' }}>
        <div className="card" style={{ flex: '999 1 620px', minWidth: 0, padding: '12px 0 4px' }}>
          <div className="flex gap wrap" style={{ alignItems: 'center', padding: '0 14px 10px', rowGap: 6 }}>
            <b style={{ fontSize: 14 }}>vCenter 별 현황</b>
            <div className="flex gap wrap" role="group" aria-label="보기" style={{ marginLeft: 'auto', rowGap: 6 }}>
              {chips.map(([k, label]) => <button key={k} type="button" className={`tab${filter === k ? ' active' : ''}`} aria-pressed={filter === k} onClick={() => setFilter(k)} style={{ padding: '4px 12px', fontSize: 12 }}>{label}</button>)}
            </div>
          </div>
          <STable minWidth={840} style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', fontSize: 12 }}>
                <th style={{ padding: '6px 14px' }}>vCenter</th>
                <th style={{ padding: '6px 6px', textAlign: 'right' }}>VM</th>
                <th style={{ padding: '6px 6px' }}>Veeam 백업</th>
                <th style={{ padding: '6px 6px' }}>스냅샷 기준</th>
                <th style={{ padding: '6px 6px', textAlign: 'right' }} title="Veeam·스냅샷 어느 쪽에도 보이지 않는 VM(백업 안 됨이 아니라 확인되지 않음)">미확인</th>
                <th style={{ padding: '6px 6px', textAlign: 'right' }}>백업 중</th>
                <th style={{ padding: '6px 6px', textAlign: 'right' }} title={`마지막 Veeam 백업이 ${opts.rpoDays}일을 넘은 VM`}>{opts.rpoDays}일+ 경과</th>
                <th style={{ padding: '6px 6px', textAlign: 'right' }} title="그 VM 마지막 결과 — 실패 · 경고">실패·경고</th>
                <th style={{ padding: '6px 6px' }} title="마지막 백업 완료 시각">마지막 백업</th>
                <th style={{ padding: '6px 14px 6px 6px' }}>Veeam 서버</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const vs = veeamStateOf(r.veeamState);
                const vp = pctOf(r.veeam, r.vm); const spc = pctOf(r.snap, r.vm); const rc = runningCell(r);
                return (
                  <tr key={r.id} style={{ borderTop: '1px solid var(--border-soft)' }}>
                    <td data-sort={r.name} style={{ padding: '9px 14px', whiteSpace: 'nowrap' }}>
                      <button type="button" onClick={() => openDetail(r.id)} title="Detail 로" style={{ background: 'none', border: 0, padding: 0, color: 'var(--text)', font: 'inherit', fontWeight: 700, cursor: 'pointer', textAlign: 'left' }}>{r.name}</button>
                      <div className="muted" style={{ fontSize: 11 }}>{isIrs(r.name) ? 'IRS' : '다빈치'}{r.demo ? ' · 데모' : ''}</div>
                    </td>
                    <td data-sort={r.vm} style={{ padding: '9px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtNum(r.vm)}</td>
                    <td data-sort={r.veeam ?? ''} style={{ padding: '9px 6px', whiteSpace: 'nowrap' }}>
                      <span style={{ fontWeight: 700, color: r.veeam == null ? 'var(--text-dim)' : '#4ade80', fontVariantNumeric: 'tabular-nums' }}>{fmtNum(r.veeam)}</span>
                      {vp != null && <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>{vp}%</span>}
                      {r.veeam != null && <Bar pct={vp} color="#22c55e" />}
                    </td>
                    <td data-sort={r.snap ?? ''} style={{ padding: '9px 6px' }} title={r.snap == null ? snapReasonText(r.snapReason) : undefined}>
                      <span style={{ fontWeight: 700, color: r.snap == null ? 'var(--text-dim)' : '#c084fc', fontVariantNumeric: 'tabular-nums' }}>{fmtNum(r.snap)}</span>
                      {spc != null && <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>{spc}%</span>}
                      {r.snap == null && r.snapReason && <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>{snapReasonText(r.snapReason)}</span>}
                      {r.snap != null && <Bar pct={spc} color="#a855f7" />}
                    </td>
                    <td data-sort={r.split ? r.split.none : ''} style={{ padding: '9px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.split ? fmtNum(r.split.none) : '—'}</td>
                    <td data-sort={rc.sort ?? ''} title={rc.title} style={{ padding: '9px 6px', textAlign: 'right', whiteSpace: 'nowrap' }}>{rc.active ? <span style={{ padding: '1px 8px', borderRadius: 10, background: 'rgba(245,158,11,.16)', color: '#fbbf24', fontWeight: 700 }}>{rc.text}</span> : <span className="muted">{rc.text}</span>}</td>
                    <td data-sort={r.rpo ? r.rpo[rpoKey] : ''} style={{ padding: '9px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }} title={r.rpo?.unknown ? `마지막 백업 시각 모름 ${r.rpo.unknown}대` : undefined}>{r.rpo ? (r.rpo[rpoKey] ? <b style={{ color: '#fb923c' }}>{fmtNum(r.rpo[rpoKey])}</b> : <span className="muted">0</span>) : <span className="muted">—</span>}</td>
                    <td data-sort={r.results ? r.results.failed + r.results.warning : ''} style={{ padding: '9px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{r.results ? (r.results.failed + r.results.warning ? <span><b style={{ color: TONE.bad }}>{r.results.failed}</b><span className="muted"> · </span><b style={{ color: TONE.warn }}>{r.results.warning}</b></span> : <span className="muted">0</span>) : <span className="muted">—</span>}</td>
                    <td data-sort={r.lastBackup ?? ''} style={{ padding: '9px 6px', whiteSpace: 'nowrap', fontFamily: 'var(--mono)', fontSize: 12 }}>{shortTs(r.lastBackup)}</td>
                    <td data-sort={vs.text} style={{ padding: '9px 14px 9px 6px' }}><span style={{ display: 'inline-block', padding: '2px 9px', borderRadius: 10, fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap', color: TONE[vs.tone], background: TONE_BG[vs.tone] }}>{vs.text}{r.veeamServers > 1 ? ` · ${r.veeamServers}대` : ''}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </STable>
          <div className="muted" style={{ padding: '8px 14px', fontSize: 12 }}>{rows.length}개 중 {shown.length}개 · 제목을 누르면 정렬 · vCenter 이름을 누르면 Detail</div>
        </div>

        {/* v2.780.1: 옆 칸 240px — 1440px 에서 표 카드가 열 10개를 가로 스크롤 없이 담게(280px 이면 표가 약 35px 넘쳤다 · 실측) */}
        <div style={{ flex: '1 1 240px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="card" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <b style={{ fontSize: 14 }}>주의가 필요한 곳</b>
            {att.length === 0 ? <div className="muted" style={{ fontSize: 12 }}>없습니다.</div> : att.map((a) => (a.more ? (
              <button key={a.id} type="button" className="tab" onClick={() => setFilter('warn')} title={a.text} style={{ alignSelf: 'flex-start', padding: '4px 12px', fontSize: 12 }}>{a.title} — 표의 주의 필요 보기</button>
            ) : (
              <div key={a.id} className="flex gap" style={{ alignItems: 'flex-start' }}>
                <span style={{ flex: 'none', marginTop: 5, width: 8, height: 8, borderRadius: '50%', background: TONE[a.tone] }} />
                <div style={{ minWidth: 0 }}><div style={{ fontWeight: 700, fontSize: 13, overflowWrap: 'anywhere' }}>{a.title}</div><div className="muted" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{a.text}</div></div>
              </div>
            )))}
          </div>
          {Array.isArray(data.runningJobs) && (
            <div className="card" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <b style={{ fontSize: 14 }}>지금 도는 Veeam 작업</b>
              {data.runningJobs.length === 0 ? <div className="muted" style={{ fontSize: 12 }}>없습니다.</div> : data.runningJobs.map((j, i) => (
                <div key={`${j.vcenter}-${j.server}-${j.name}-${i}`} style={{ minWidth: 0 }}>
                  <div className="flex gap" style={{ justifyContent: 'space-between', fontSize: 13 }}><span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{j.vcenter} › {j.name}</span><b style={{ color: '#fbbf24' }}>{Number.isFinite(j.pg) ? `${j.pg}%` : '—'}</b></div>
                  {Number.isFinite(j.pg) && <Bar pct={j.pg} color="#f59e0b" />}
                </div>
              ))}
              <div className="muted" style={{ fontSize: 12 }}>작업 전체 진행률(Veeam 콘솔 작업 목록의 %) · 관리자에게만 보입니다</div>
            </div>
          )}
          <div className="card" style={{ padding: '12px 14px', fontSize: 12, lineHeight: 1.6 }}>
            <b style={{ display: 'block', marginBottom: 4 }}>두 기준</b>
            <div><b style={{ color: '#4ade80' }}>Veeam</b> — Veeam 서버가 작업에 넣었거나 복원 지점이 있는 VM</div>
            <div><b style={{ color: '#c084fc' }}>스냅샷</b> — vCenter 에서 Veeam 이 스냅샷을 만든 흔적이 보인 VM(성공 여부는 모름)</div>
            <div className="muted">두 수는 같은 VM 을 다른 방법으로 센 것이라 더하지 않습니다. — 는 확인되지 않음, * 는 일부만 읽은 vCenter 가 있어 실제와 다를 수 있음입니다. 비율은 그 기준을 확인한 vCenter 의 VM 으로 나눕니다.</div>
          </div>
        </div>
      </div>
    </div>
  );
}
