/**
 * 백업 서머리 — 특수 기능 `backup-summary`(v2.779, 사용자 요청 '전체 28개 vcenter 의 백업 현황 · veeam 백업과 snapshot 둘다' + 시안).
 * 메뉴: 서버 › Veeam → 화면 위 Summary | Detail 탭(v2.787 — 예전 'Veeam 현황 › Summary' · 도구 키 그대로).
 * v2.787(사용자 요청 + 시안): 바로가기 바(vCenter 화면과 같은 모양 — 누르면 표의 그 줄로) · 법인별 표(커버리지 막대 · 우선순위 칸 · 정렬) · 우선순위 VM. 값은 서버(GET /api/tools/backup-summary — veeam/backupStatus.js)가 vCenter 카드·VM 화면과 같은 기준으로 낸다.
 * ⚠ 무거운 집계라 폴링하지 않는다(마운트 1회 + 새로고침 · 서버 60초 캐시) · 늦게 온 이전 응답은 버린다 · 훅은 조기 return 위.
 * ⚠ 못 읽은 값은 '—'(0 이 아니다) · 두 수는 같은 VM 을 다른 방법으로 센 것이라 더하지 않는다.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, downloadFile, canCsv } from '../../api.js';
import { Loading, ErrorBox, SearchBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { fmtNum, pctOf, veeamStateOf, snapReasonText, filterRows, attentionList, summaryKpis, runningCell, shortTs, isIrs, loadOpts, saveOpts, scopeQuery, scopeNote, CRIT, marksLine, marksNotice, quickTone, QUICK_DOT, coverageOf, SORTS, sortRows, matchSite, PRIO_TABS, priorityView, prioMatches, folderTail } from './backupViewText.js';
import VeeamHeader from './VeeamHeader.jsx';
import Select from '../../components/Select.jsx';
import { CritIcon, NeedIcon, NEED_COLOR, MethodBadge } from './BackupMarkIcons.jsx';
import BackupOptions from './BackupOptions.jsx';

export const DETAIL_VC_KEY = 'backup-detail-vc';   // 서머리에서 고른 vCenter 를 세부내용이 이어받는다(이 브라우저에만)

const TONE = { ok: '#86efac', bad: '#fca5a5', warn: '#fcd34d', info: '#93c5fd', muted: 'var(--text-dim)' };
// v2.787 우선순위 VM 이유 칩 색(배경 + 글자 — 색만으로 구분하지 않게 글자를 함께 쓴다)
const PRIO_TAG = {
  gap: { background: 'rgba(239,68,68,.16)', color: '#fca5a5' }, high: { background: 'rgba(248,113,113,.14)', color: '#fecaca' },
  need: { background: 'rgba(96,165,250,.16)', color: '#bfdbfe' }, fail: { background: 'rgba(239,68,68,.16)', color: '#fca5a5' },
  old: { background: 'rgba(251,146,60,.16)', color: '#fdba74' }, stale: { background: 'rgba(245,158,11,.16)', color: '#fcd34d' },
};

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
  // v2.787: 바로가기 찾기 · 표 처음 순서 · 표 전부 보기 · 우선순위 탭 · 우선순위 전부 보기
  const [q, setQ] = useState('');
  const [sortKey, setSortKey] = useState('attn');
  const [allRows, setAllRows] = useState(false);
  const [ptab, setPtab] = useState('all');
  const [pAll, setPAll] = useState(false);
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
  const prio = useMemo(() => priorityView(data?.priority?.items, { rpoDays: opts.rpoDays, now: data?.at || Date.now() }), [data, opts.rpoDays]);
  // 바로가기 — 표의 그 줄로 이동 + 반짝(vCenter 화면 gotoCard 와 같은 동작). 줄이 보기·찾기·12줄 상한으로 숨어 있으면 먼저 펼친다.
  const gotoRow = useCallback((id) => {
    const find = () => Array.from(document.querySelectorAll('[data-vc-row]')).find((el) => el.getAttribute('data-vc-row') === id);
    const flash = (el) => {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.remove('qn-flash'); void el.offsetWidth; el.classList.add('qn-flash');   // styles.css .qn-anchor.qn-flash(바로가기 대상 반짝)
      setTimeout(() => el.classList.remove('qn-flash'), 3200);
    };
    const el = find();
    if (el) { flash(el); return; }
    setFilter('all'); setQ(''); setAllRows(true);
    setTimeout(() => { const e2 = find(); if (e2) flash(e2); }, 80);
  }, []);

  if (!data && loading) return <Loading />;
  // v2.785(GV C-B4): 오류 객체를 그대로 — 403 을 문자열로 바꾸면 ErrorBox 가 권한 안내(AccessDenied)로 바꾸지 못했다
  if (!data && error) return <ErrorBox error={error} />;
  if (!data) return null;

  const rows = Array.isArray(data.rows) ? data.rows : [];
  const t = data.totals || {};
  const shown = sortRows(filterRows(rows, filter).filter((r) => matchSite(r, q)), sortKey);
  const chipRows = rows.filter((r) => matchSite(r, q));
  const prioShown = prio.items.filter((x) => prioMatches(x, ptab));
  const prioWithheld = data?.priority?.withheld === 'detail-tool';   // v2.787: Detail 이 거부된 계정 — 서버가 VM 목록을 싣지 않는다
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
      <VeeamHeader active="summary" desc={`vCenter ${fmtNum(t.vcenters)}개 — Veeam 서버가 아는 백업과 vCenter 스냅샷으로 본 백업 흔적을 나란히 봅니다.`}
        actions={<>
          <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>기준 {shortTs(data.at)}{error ? ' · 최근 새로고침 실패 — 이전 값' : ''}</span>
          {canCsv() && <button type="button" className="tab" onClick={csv} style={{ padding: '6px 14px' }}>CSV</button>}
          <button type="button" className="tab" disabled={loading} onClick={load} style={{ padding: '6px 14px' }}>{loading ? '읽는 중…' : '새로고침'}</button>
        </>} />
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
      {/* v2.787: 바로가기 — vCenter 화면(VCenters.jsx)과 같은 모양 · 점 = 백업 상태(quickTone) · 누르면 아래 표의 그 줄로 */}
      {rows.length > 0 && (
        <div className="vc-quicknav" data-backup-quicknav="" style={{ marginBottom: 0 }}>
          <span className="qn-label">⚡ 바로가기</span>
          {chipRows.map((r) => (
            <button key={r.id} type="button" className="qn-btn" title={`${r.name} — ${veeamStateOf(r.veeamState).text} · 표의 그 줄로`} onClick={() => gotoRow(r.id)}>
              <span className="qn-dot" style={{ background: QUICK_DOT[quickTone(r)] }} />{r.name}
            </button>
          ))}
          <SearchBox className="input" style={{ marginLeft: 'auto', maxWidth: 240, minWidth: 170 }} value={q} onChange={setQ} placeholder="vCenter 이름 찾기" />
        </div>
      )}
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

      {/* v2.787 법인별 현황 — 전체 폭(1440 에서 가로 스크롤 없게) · 커버리지 막대 = 둘 다·Veeam 만·스냅샷만(나머지 확인 안 됨) · 우선순위 칸 = 사람이 정한 표시 */}
      <div className="card" data-backup-sites="" style={{ minWidth: 0, padding: '12px 0 4px' }}>
        <div className="flex gap wrap" style={{ alignItems: 'center', padding: '0 14px 10px', rowGap: 6 }}>
          <div style={{ minWidth: 0 }}>
            <b style={{ fontSize: 15 }}>법인별 현황</b>
            <div className="muted" style={{ fontSize: 12 }}>VM 한 대는 한 번만 — 막대는 둘 다 · Veeam 만 · 스냅샷만 · 확인 안 됨 비율</div>
          </div>
          <div className="flex gap wrap" role="group" aria-label="보기" style={{ marginLeft: 'auto', rowGap: 6 }}>
            {chips.map(([k, label]) => <button key={k} type="button" className={`tab${filter === k ? ' active' : ''}`} aria-pressed={filter === k} onClick={() => setFilter(k)} style={{ padding: '4px 12px', fontSize: 12 }}>{label}</button>)}
          </div>
          <label className="flex" style={{ gap: 6, alignItems: 'center', fontSize: 12, whiteSpace: 'nowrap' }}>
            <span className="muted">정렬</span>
            <Select className="input" sort={false} value={sortKey} onChange={(e) => setSortKey(e.target.value)} style={{ fontSize: 12, padding: '3px 6px', minWidth: 0, width: 'auto' }}>
              {SORTS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </Select>
          </label>
        </div>
        <div className="flex gap wrap" style={{ fontSize: 12, rowGap: 6, padding: '0 14px 8px' }}>
          <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: '#16a34a', marginRight: 6 }} />둘 다</span>
          <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: '#4ade80', marginRight: 6 }} />Veeam 만</span>
          <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: '#a855f7', marginRight: 6 }} />스냅샷만</span>
          <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: '#263248', border: '1px solid var(--border)', marginRight: 6 }} />확인 안 됨</span>
        </div>
        <STable minWidth={1040} limit={allRows ? 0 : 12} style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', fontSize: 12 }}>
              <th style={{ padding: '6px 14px' }}>법인</th>
              <th style={{ padding: '6px 6px', textAlign: 'right' }}>VM</th>
              <th data-nosort="" style={{ padding: '6px 10px', width: 210 }}>커버리지</th>
              <th style={{ padding: '6px 6px', textAlign: 'right' }}>Veeam</th>
              <th style={{ padding: '6px 6px', textAlign: 'right' }}>스냅샷</th>
              <th style={{ padding: '6px 6px', textAlign: 'right' }} title="Veeam·스냅샷 어느 쪽에도 보이지 않는 VM(백업 안 됨이 아니라 확인되지 않음)">미확인</th>
              <th style={{ padding: '6px 6px', textAlign: 'right' }}>백업 중</th>
              <th style={{ padding: '6px 6px', textAlign: 'right' }} title="그 VM 마지막 결과 — 실패 · 경고">실패·경고</th>
              <th style={{ padding: '6px 6px', textAlign: 'right' }} title={`마지막 Veeam 백업이 ${opts.rpoDays}일을 넘은 VM`}>{opts.rpoDays}일+ 경과</th>
              <th style={{ padding: '6px 6px' }} title="Detail 에서 정한 표시 — 중요도 상 · 백업 필요 · 그중 Veeam 백업 안 보임">우선순위</th>
              <th style={{ padding: '6px 14px 6px 6px' }} title="마지막 백업 완료 시각">마지막 백업</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const vs = veeamStateOf(r.veeamState);
              const cv = coverageOf(r); const rc = runningCell(r);
              const vp = pctOf(r.veeam, r.vm); const spc = pctOf(r.snap, r.vm); const np = cv ? pctOf(r.split.none, r.vm) : null;
              const m = r.marks;
              return (
                <tr key={r.id} data-vc-row={r.id} className="qn-anchor" style={{ borderTop: '1px solid var(--border-soft)' }}>
                  <td data-sort={r.name} style={{ padding: '8px 14px', whiteSpace: 'nowrap' }}>
                    <span className="flex" style={{ alignItems: 'center', gap: 8 }}>
                      <span aria-hidden="true" style={{ width: 9, height: 9, borderRadius: '50%', flex: 'none', background: QUICK_DOT[quickTone(r)] }} />
                      <button type="button" onClick={() => openDetail(r.id)} title="Detail 로" style={{ background: 'none', border: 0, padding: 0, color: 'var(--text)', font: 'inherit', fontWeight: 700, cursor: 'pointer', textAlign: 'left' }}>{r.name}</button>
                    </span>
                    <div className="muted" style={{ fontSize: 11, paddingLeft: 17 }}>{isIrs(r.name) ? 'IRS' : '다빈치'}{r.demo ? ' · 데모' : ''} · <span style={{ color: TONE[vs.tone] }}>{vs.text}{r.veeamServers > 1 ? ` · ${r.veeamServers}대` : ''}</span></div>
                  </td>
                  <td data-sort={r.vm ?? ''} style={{ padding: '8px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtNum(r.vm)}</td>
                  <td style={{ padding: '8px 10px', minWidth: 0 }} title={r.snap == null ? snapReasonText(r.snapReason) : undefined}>
                    {cv ? (
                      <div role="img" aria-label={`둘 다 ${r.split.both} · Veeam 만 ${r.split.vOnly} · 스냅샷만 ${r.split.sOnly} · 확인 안 됨 ${r.split.none}`} style={{ display: 'flex', height: 9, borderRadius: 5, overflow: 'hidden', background: '#263248' }}>
                        <div style={{ width: `${cv.both}%`, background: '#16a34a' }} /><div style={{ width: `${cv.vOnly}%`, background: '#4ade80' }} /><div style={{ width: `${cv.sOnly}%`, background: '#a855f7' }} />
                      </div>
                    ) : <div style={{ height: 9, borderRadius: 5, border: '1px dashed var(--border)' }} />}
                    <div className="muted" style={{ fontSize: 11, marginTop: 3, whiteSpace: 'nowrap' }}>{vp != null ? `Veeam ${vp}%` : 'Veeam 모름'} · {spc != null ? `스냅샷 ${spc}%` : `스냅샷 ${snapReasonText(r.snapReason) || '모름'}`}{np != null ? ` · 미확인 ${np}%` : ''}</div>
                  </td>
                  <td data-sort={r.veeam ?? ''} style={{ padding: '8px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 700, color: r.veeam == null ? 'var(--text-dim)' : '#4ade80' }}>{fmtNum(r.veeam)}</td>
                  <td data-sort={r.snap ?? ''} style={{ padding: '8px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 700, color: r.snap == null ? 'var(--text-dim)' : '#c084fc' }}>{fmtNum(r.snap)}</td>
                  <td data-sort={r.split ? r.split.none : ''} style={{ padding: '8px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.split ? fmtNum(r.split.none) : '—'}</td>
                  <td data-sort={rc.sort ?? ''} title={rc.title} style={{ padding: '8px 6px', textAlign: 'right', whiteSpace: 'nowrap' }}>{rc.active ? <span style={{ padding: '1px 8px', borderRadius: 10, background: 'rgba(245,158,11,.16)', color: '#fbbf24', fontWeight: 700 }}>{rc.text}</span> : <span className="muted">{rc.text}</span>}</td>
                  <td data-sort={r.results ? r.results.failed + r.results.warning : ''} style={{ padding: '8px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{r.results ? (r.results.failed + r.results.warning ? <span><b style={{ color: TONE.bad }}>{r.results.failed}</b><span className="muted"> · </span><b style={{ color: TONE.warn }}>{r.results.warning}</b></span> : <span className="muted">0</span>) : <span className="muted">—</span>}</td>
                  <td data-sort={r.rpo ? r.rpo[rpoKey] : ''} style={{ padding: '8px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }} title={r.rpo?.unknown ? `마지막 백업 시각 모름 ${r.rpo.unknown}대` : undefined}>{r.rpo ? (r.rpo[rpoKey] ? <b style={{ color: '#fb923c' }}>{fmtNum(r.rpo[rpoKey])}</b> : <span className="muted">0</span>) : <span className="muted">—</span>}</td>
                  <td data-sort={m ? (m.needGap ?? 0) * 1000 + (m.high || 0) : ''} style={{ padding: '8px 6px', whiteSpace: 'nowrap', fontSize: 12 }}>
                    {m ? <span><span style={{ color: m.high ? '#fca5a5' : 'var(--text-dim)', fontWeight: m.high ? 700 : 400 }}>상 {fmtNum(m.high)}</span><span className="muted"> · </span><span style={{ color: m.need ? '#93c5fd' : 'var(--text-dim)' }}>필요 {fmtNum(m.need)}</span><span className="muted"> · </span><span style={{ color: m.needGap ? '#fca5a5' : 'var(--text-dim)', fontWeight: m.needGap ? 700 : 400 }}>미백업 {m.needGap == null ? '모름' : fmtNum(m.needGap)}</span></span> : <span className="muted">—</span>}
                  </td>
                  <td data-sort={r.lastBackup ?? ''} style={{ padding: '8px 14px 8px 6px', whiteSpace: 'nowrap', fontFamily: 'var(--mono)', fontSize: 12 }}>{shortTs(r.lastBackup)}</td>
                </tr>
              );
            })}
          </tbody>
        </STable>
        <div className="flex gap wrap" style={{ padding: '8px 14px', fontSize: 12, alignItems: 'center' }}>
          <span className="muted">{rows.length}개 중 {allRows ? shown.length : Math.min(shown.length, 12)}개 · 제목을 누르면 정렬 · 법인 이름을 누르면 Detail</span>
          {shown.length > 12 && <button type="button" className="tab" onClick={() => setAllRows((v) => !v)} style={{ marginLeft: 'auto', padding: '4px 12px', fontSize: 12 }}>{allRows ? '12개만 보기' : `${shown.length - 12}개 더 보기`}</button>}
        </div>
      </div>

      <div className="flex wrap" style={{ gap: 16, alignItems: 'flex-start' }}>
        {/* v2.787 우선순위 VM — 서버 priorityCandidates(같은 범위) → 화면이 기준 일수로 '오래된 백업' 판정 · 순서는 priorityView */}
        <div className="card" data-backup-priority="" style={{ flex: '999 1 620px', minWidth: 0, padding: '12px 0 4px' }}>
          <div className="flex gap wrap" style={{ alignItems: 'baseline', padding: '0 14px 8px', rowGap: 4 }}>
            <b style={{ fontSize: 15 }}>우선순위 VM — 먼저 볼 것</b>
            <span className="muted" style={{ fontSize: 12 }}>전 법인 · 중요도 상 → 백업 필요 → 나머지, 같은 단계에서 미백업 → 실패 → 스냅샷 잔존 → 오래된 백업</span>
          </div>
          {prioWithheld ? <div className="muted" data-prio-withheld="" style={{ padding: '6px 14px 14px', fontSize: 13 }}>이 계정은 Detail 화면이 허용되지 않아 VM 목록을 싣지 않습니다(관리자가 정한 도구별 접근).</div> : <>
          <div className="flex gap wrap" role="group" aria-label="우선순위 보기" style={{ padding: '0 14px 10px', rowGap: 6 }}>
            {PRIO_TABS.map(([k, label]) => <button key={k} type="button" className={`tab${ptab === k ? ' active' : ''}`} aria-pressed={ptab === k} onClick={() => setPtab(k)} style={{ padding: '4px 12px', fontSize: 12 }}>{label}{k === 'old' ? `(${opts.rpoDays}일)` : ''} <b>{fmtNum(prio.counts[k])}</b></button>)}
          </div>
          {prioShown.length === 0 ? <div className="muted" style={{ padding: '6px 14px 12px', fontSize: 13 }}>{data.priority ? '먼저 볼 VM 이 없습니다.' : '우선순위 VM 을 읽지 못했습니다.'}</div> : (
            <STable minWidth={640} limit={pAll ? 0 : 8} style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left', fontSize: 12 }}>
                  <th data-nosort="" style={{ padding: '6px 14px', width: 34 }}>#</th>
                  <th style={{ padding: '6px 6px' }}>VM</th>
                  <th style={{ padding: '6px 6px' }}>법인 · 폴더</th>
                  <th data-nosort="" style={{ padding: '6px 6px' }}>왜</th>
                  <th style={{ padding: '6px 6px' }}>마지막 백업</th>
                  <th data-nosort="" style={{ padding: '6px 14px 6px 6px' }}><span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>열기</span></th>
                </tr>
              </thead>
              <tbody>
                {prioShown.map((x, i) => (
                  <tr key={x.id} style={{ borderTop: '1px solid var(--border-soft)' }}>
                    <td style={{ padding: '8px 14px', color: 'var(--text-dim)', fontVariantNumeric: 'tabular-nums' }}>{i + 1}</td>
                    <td data-sort={x.name} style={{ padding: '8px 6px', whiteSpace: 'nowrap' }}><span className="flex" style={{ alignItems: 'center', gap: 6 }}><CritIcon crit={x.crit} size={14} />{x.need && <NeedIcon size={14} />}<b>{x.name}</b><MethodBadge method={x.method} small /></span></td>
                    <td data-sort={`${x.vcName} ${x.folder}`} style={{ padding: '8px 6px', whiteSpace: 'nowrap', color: 'var(--text-dim)' }}>{x.vcName} <span aria-hidden="true">›</span> {folderTail(x.folder)}</td>
                    <td style={{ padding: '8px 6px' }}><span className="flex wrap" style={{ gap: 4 }}>{x.tags.map(([k, text]) => <span key={k} style={{ padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap', ...PRIO_TAG[k] }}>{text}</span>)}</span></td>
                    <td data-sort={x.lb ?? ''} style={{ padding: '8px 6px', whiteSpace: 'nowrap', fontFamily: 'var(--mono)', fontSize: 12, color: x.lb ? undefined : TONE.bad }}>{shortTs(x.lb)}</td>
                    <td style={{ padding: '8px 14px 8px 6px', textAlign: 'right' }}><button type="button" className="tab" onClick={() => openDetail(x.vcenterId)} title={`${x.vcName} Detail 로`} style={{ padding: '2px 10px', fontSize: 12, whiteSpace: 'nowrap' }}>Detail ›</button></td>
                  </tr>
                ))}
              </tbody>
            </STable>
          )}
          <div className="flex gap wrap" style={{ padding: '8px 14px', fontSize: 12, alignItems: 'center' }}>
            <span className="muted">{fmtNum(prioShown.length)}대{data.priority?.truncated ? ` · 서버가 앞 ${fmtNum(data.priority.items.length)}대만 보냈습니다(전체 후보 ${fmtNum(data.priority.total)}대)` : ''}{mkNote ? ' · 표시 파일을 못 읽어 미백업 판정이 빠졌습니다' : ''}</span>
            {prioShown.length > 8 && <button type="button" className="tab" onClick={() => setPAll((v) => !v)} style={{ marginLeft: 'auto', padding: '4px 12px', fontSize: 12 }}>{pAll ? '8대만 보기' : '전부 보기'}</button>}
          </div>
          </>}
        </div>

        <div style={{ flex: '1 1 260px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
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
