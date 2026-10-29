/**
 * Veeam 백업 현황 › EM — 특수 기능 `backup-em`(v2.788, 사용자 요청 'Veeam EM 에 접속해 가져올 수 있는 모든 정보' + 시안).
 * 메뉴: 서버 › Veeam → 화면 위 Summary | Detail | EM 탭. 값은 서버(GET /api/tools/backup-em — veeam/em/view.js)가 만든다.
 *  · Enterprise Manager 수집 결과(항목별 성공·사유) · B&R 서버에서 읽은 라이선스(출처를 밝힌다) · 일 단위 이력(라이선스·저장소 90일).
 * ⚠ 폴링하지 않는다(마운트 1회 + 새로고침 · 서버 30초 캐시) · 늦게 온 이전 응답은 버린다 · 훅은 조기 return 위.
 * ⚠ 못 읽은 값은 '—'(0 이 아니다). 전체 범위 계정만 — 범위 계정은 서버가 403(사유) → ErrorBox 가 권한 안내로.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson } from '../../api.js';
import { Loading, ErrorBox, SearchBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import VeeamHeader from './VeeamHeader.jsx';
import {
  fmtNum, fmtBytes, fmtDur, shortTs, dateText, ago, JOB_FILTERS, JOB_LABEL, TONE, BADGE_BG, sectionChips, statusLine, ddayText, ddayTone,
  licenseCard, repoTone, filterJobs, runBar, sparkPoints, usedPctOf, canOpenDetail, emLinkRows, emLinkSummary,
} from './backupEmText.js';
import EmSessionDetail from './EmSessionDetail.jsx';

const BAR = { fail: '#ef4444', warn: '#f59e0b', ok: '#22c55e', run: '#22d3ee', none: '#64748b' };

/**
 * v2.817 EM 연결 현황 — 모든 EM 을 한 표로(사용자 신고 'EM 2대 이상인데 서버가 일부만 보인다' · 요청 'EM 마다 어떤 vCenter 와 연결돼 백업하는지').
 *  아래 상세(KPI·작업·저장소)는 선택한 EM 하나만이라, 다른 EM 의 서버·수집 실패가 여기서 먼저 보이게 한다. EM 이름을 누르면 아래 상세가 그 EM 으로 바뀐다.
 */
function EmLinks({ ems, now, sel, onPick }) {
  const rows = useMemo(() => emLinkRows(ems, now), [ems, now]);
  const sm = useMemo(() => emLinkSummary(ems), [ems]);
  if (!ems.length) return null;
  return (
    <div className="card" data-em-links="" style={{ padding: '14px 16px', minWidth: 0 }}>
      <div className="flex wrap" style={{ alignItems: 'baseline', gap: '6px 14px' }}>
        <b>EM 연결 현황</b>
        <span className="muted" style={{ fontSize: 12.5 }}>EM {fmtNum(sm.ems)}대{sm.failed ? <span style={{ color: TONE.fail }}> (수집 실패 {fmtNum(sm.failed)})</span> : null} · 백업 서버 {fmtNum(sm.servers)} · EM 이 본 vCenter {fmtNum(sm.vcSeen)}
          {sm.notInPortal ? <span style={{ color: TONE.warn }}> · 포탈에 없는 vCenter {fmtNum(sm.notInPortal)}</span> : null}
          {sm.diff ? <span style={{ color: TONE.fail }}> · 매핑과 다른 서버 {fmtNum(sm.diff)}</span> : null}
          {sm.unmapped ? <span> · 매핑 없는 서버 {fmtNum(sm.unmapped)}</span> : null}
          {sm.rootsUnknown ? <span> · 연결 호스트를 못 읽은 EM {fmtNum(sm.rootsUnknown)}</span> : null}</span>
      </div>
      <div style={{ overflowX: 'auto', marginTop: 8 }}>
        <STable minWidth={900} style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead><tr style={{ textAlign: 'left', fontSize: 12 }}>
            <th style={{ padding: '6px 6px 6px 0' }}>Enterprise Manager</th><th style={{ padding: '6px' }}>수집</th><th style={{ padding: '6px' }}>백업 서버</th>
            <th style={{ padding: '6px' }}>EM 이 본 vCenter·호스트</th><th style={{ padding: '6px' }}>포탈 매핑(법인)</th><th style={{ padding: '6px 0 6px 6px' }}>대조</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} style={{ borderTop: '1px solid var(--border-soft)', verticalAlign: 'top', background: r.emId === sel ? 'rgba(59,130,246,.07)' : undefined }}>
                <td style={{ padding: '6px 6px 6px 0', whiteSpace: 'nowrap' }} data-sort={r.emName}>
                  <button type="button" onClick={() => onPick(r.emId)} title="아래 상세를 이 EM 으로" style={{ background: 'none', border: 0, padding: 0, color: 'var(--accent, #60a5fa)', font: 'inherit', fontWeight: 700, cursor: 'pointer' }}>{r.emName}</button>
                </td>
                <td style={{ padding: '6px', maxWidth: 260, color: r.statusTone === 'bad' ? TONE.fail : r.statusTone === 'warn' ? TONE.warn : 'var(--text-dim)', fontSize: 12, overflowWrap: 'anywhere' }}>{r.statusText}</td>
                <td style={{ padding: '6px', fontWeight: 600, overflowWrap: 'anywhere' }} data-sort={r.server || ''}>{r.server || <span className="muted" style={{ fontWeight: 400 }}>—</span>}{r.note && <div style={{ fontSize: 12, fontWeight: 400, color: r.checkKey === 'orphan' ? TONE.warn : TONE.fail }}>{r.note}</div>}</td>
                <td style={{ padding: '6px', fontSize: 12.5 }} data-sort={r.roots?.[0]?.text || ''}>
                  {r.roots == null ? <span className="muted">모름(연결 호스트를 읽지 못함)</span> : r.roots.length ? r.roots.map((x, i) => <div key={i} style={{ color: x.tone === 'ok' ? undefined : x.tone === 'warn' ? TONE.warn : 'var(--text-dim)' }}>{x.text}</div>) : <span className="muted">—</span>}
                </td>
                <td style={{ padding: '6px', fontSize: 12.5 }} data-sort={r.portal?.text || ''}>{r.portal ? <>{r.portal.text} <span className="muted">· {r.portal.source}</span></> : <span className="muted">—</span>}</td>
                <td style={{ padding: '6px 0 6px 6px', whiteSpace: 'nowrap', fontWeight: 700, color: TONE[r.check.tone] || 'var(--text-dim)' }} data-sort={r.check.label}>{r.check.label}</td>
              </tr>
            ))}
          </tbody>
        </STable>
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>EM 이 본 vCenter = 각 백업 서버에 등록된 가상화 호스트(EM 연결 호스트) 중 포탈 vCenter 와 주소·이름이 정확히 같은 것 · 대조 = 그 목록과 포탈 매핑(설정 › Veeam 백업 서버 › EM 매핑 또는 짝지은 B&R)의 vCenter 가 같은지 · 아래 상세는 선택한 EM 하나만 보입니다.</div>
    </div>
  );
}

function Kpi({ label, value, sub, wide, children }) {
  return (
    <div className="card" style={{ padding: '14px 16px', minWidth: 0, gridColumn: wide ? 'span 2' : undefined, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-dim)' }}>{label}</div>
      {value != null && <div style={{ fontSize: 26, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{value}</div>}
      {children}
      {sub && <div className="muted" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{sub}</div>}
    </div>
  );
}
/** v2.788.1 실패·경고 배지를 누르면 그 세션의 VM 별 결과·사유가 펼쳐진다(사용자 요청). */
const DetailBtn = ({ k, on, onClick }) => (
  <button type="button" aria-expanded={on} onClick={onClick} title={k === 'fail' ? '세부 작업 내용(VM 별 결과·사유) 보기' : '왜 경고인지 보기'}
    style={{ padding: '2px 10px', borderRadius: 999, fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap', cursor: 'pointer', border: `1px solid ${on ? TONE[k] : 'transparent'}`, background: BADGE_BG[k], color: TONE[k], minHeight: 26 }}>
    {JOB_LABEL[k]} {on ? '▴' : '›'}
  </button>
);
const Badge = ({ k }) => <span style={{ padding: '2px 10px', borderRadius: 999, fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap', background: BADGE_BG[k], color: TONE[k] }}>{JOB_LABEL[k] || '—'}</span>;
function Meter({ pct, color }) {
  return <div aria-hidden="true" style={{ height: 8, borderRadius: 999, background: 'var(--panel-deep)', overflow: 'hidden', minWidth: 40 }}><div style={{ height: 8, width: `${Math.max(0, Math.min(100, pct || 0))}%`, background: color, borderRadius: 999 }} /></div>;
}
function Spark({ sp, color, label }) {
  if (!sp) return <span className="muted" style={{ fontSize: 11 }}>이력 부족</span>;
  return (
    <svg width="120" height="28" viewBox="0 0 120 28" role="img" aria-label={`${label} — 최근 ${sp.days}일`}>
      <polyline points={sp.points} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}

export default function BackupEmTool() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [emId, setEmId] = useState('');
  const [jf, setJf] = useState('all');
  const [q, setQ] = useState('');
  const [openKey, setOpenKey] = useState('');   // v2.788.1 펼친 상세('job|uid' · 'bad|uid')
  const [badAll, setBadAll] = useState(false);
  const toggle = useCallback((k) => setOpenKey((cur) => (cur === k ? '' : k)), []);
  // v2.790 Chromium 400px: 작업 표(가로 스크롤 · 최소 960px) 안 상세가 표 폭으로 열려 '닫기'·사유가 화면 밖이었다 —
  //   보이는 카드 폭을 재어 상세를 그 폭으로 두고 왼쪽에 고정한다(sticky). 상세 안 표는 자기 가로 스크롤.
  const jobsRef = useRef(null);
  const [jobsW, setJobsW] = useState(0);
  useEffect(() => {
    const el = jobsRef.current;
    if (!el) return undefined;
    setJobsW(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => setJobsW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [data, emId]);
  const gen = useRef(0);
  const load = useCallback(() => {
    const my = ++gen.current;
    setLoading(true); setError(null);
    fetchJson('/tools/backup-em')
      .then((r) => { if (my === gen.current) setData(r); })
      .catch((e) => { if (my === gen.current) setError(e); })
      .finally(() => { if (my === gen.current) setLoading(false); });
  }, []);
  useEffect(() => { load(); return () => { gen.current++; }; }, [load]);
  const ems = useMemo(() => (Array.isArray(data?.ems) ? data.ems : []), [data]);
  const em = ems.find((e) => e.id === emId) || ems[0] || null;
  const lic = useMemo(() => licenseCard(data?.licenses), [data]);

  if (!data && loading) return <Loading />;
  if (!data && error) return <ErrorBox error={error} />;
  if (!data) return null;

  const now = data.at || Date.now();
  const d = em?.data || null;
  const st = statusLine(em?.status, now);
  const chips = sectionChips(em?.status);
  const jobs = d?.jobs || null;
  const shownJobs = jobs ? filterJobs(jobs.items, jf, q) : [];
  const s24 = d?.sessions?.counts24 || null;
  const bar = runBar(s24);
  const ov = d?.overview || {};
  const vmTot = [ov.vmOk, ov.vmWarn, ov.vmFail].every((x) => typeof x === 'number') ? ov.vmOk + ov.vmWarn + ov.vmFail : null;
  const licHist = data.history?.license || null;
  const repoHist = data.history?.repo || null;
  const tone = { ok: TONE.ok, warn: TONE.warn, bad: TONE.fail, muted: 'var(--text-dim)' }[st.tone];

  return (
    <div data-backup-em="" style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
      <VeeamHeader active="em"
        desc="Veeam Backup Enterprise Manager 가 아는 전 백업 서버의 작업 결과 · 저장소 · 세션, 그리고 B&R 서버에서 읽은 라이선스를 한곳에서 봅니다."
        actions={<>
          {ems.length > 1 && (
            <label className="muted" style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>Enterprise Manager
              <Select className="input" value={em?.id || ''} onChange={(e) => setEmId(e.target.value)} style={{ minWidth: 200, fontWeight: 700 }}>
                {ems.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </Select>
            </label>
          )}
          <button type="button" className="tab" disabled={loading} onClick={load} style={{ padding: '6px 14px' }}>{loading ? '읽는 중…' : '새로고침'}</button>
        </>} />
      {error && <ErrorBox error={error} />}
      {data.demo && <div className="banner info">데모 값입니다 — 실제 Enterprise Manager 를 등록하면 그 값으로 바뀝니다.</div>}
      <EmLinks ems={ems} now={now} sel={em?.id || ''} onPick={setEmId} />

      {!em ? (
        <div className="card" style={{ padding: '16px 18px' }}>
          <b>등록된 Enterprise Manager 가 없습니다.</b>
          <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>관리자가 설정 › Veeam 백업 서버 › Enterprise Manager 에서 주소·계정을 등록하면 다음 수집부터 이 화면이 채워집니다. 아래 라이선스는 B&R 서버에서 읽은 값입니다.</div>
        </div>
      ) : (
        <div className="card" data-em-status="" style={{ padding: '12px 16px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 16px', fontSize: 13 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <span aria-hidden="true" style={{ width: 9, height: 9, borderRadius: '50%', background: tone, flex: 'none' }} />
            <b>{em.name}</b>{em.host && <span className="muted">{em.host}:{em.port}</span>}
          </span>
          <span style={{ color: tone, minWidth: 0, overflowWrap: 'anywhere' }}>{st.text}</span>
          {chips.length > 0 && (
            <span style={{ marginLeft: 'auto', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {chips.map((c) => <span key={c.k} title={c.reason || undefined} style={{ padding: '3px 9px', borderRadius: 999, fontSize: 12, background: c.ok ? BADGE_BG.ok : BADGE_BG.fail, color: c.ok ? TONE.ok : TONE.fail }}>{c.label} {c.ok ? '✓' : '못 읽음'}</span>)}
            </span>
          )}
        </div>
      )}

      {d && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
          <Kpi label="백업 서버" value={fmtNum(ov.backupServers)} sub={`프록시 ${fmtNum(ov.proxyServers)} · 저장소 서버 ${fmtNum(ov.repositoryServers)}`} />
          <Kpi label="작업" value={fmtNum(jobs?.counts?.all ?? ov.scheduledJobs)} sub={`예약 ${fmtNum(ov.scheduledJobs)} · 지금 실행 ${fmtNum(ov.runningJobs ?? s24?.running)}`} />
          <Kpi label="작업 실행 결과 — 최근 24시간" wide value={bar ? fmtNum(bar.total) : '—'} sub={s24 ? undefined : '세션을 읽지 못했습니다'}>
            {s24 && <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 13 }}><span style={{ color: TONE.ok }}>정상 {fmtNum(s24.ok)}</span><span style={{ color: TONE.warn }}>경고 {fmtNum(s24.warn)}</span><span style={{ color: TONE.fail }}>실패 {fmtNum(s24.fail)}</span></div>}
            {bar && <div aria-hidden="true" style={{ display: 'flex', height: 10, borderRadius: 999, overflow: 'hidden', background: 'var(--panel-deep)' }}><span style={{ width: `${bar.ok}%`, background: BAR.ok }} /><span style={{ width: `${bar.warn}%`, background: BAR.warn }} /><span style={{ width: `${bar.fail}%`, background: BAR.fail }} /></div>}
          </Kpi>
          <Kpi label="보호된 VM" value={fmtNum(d.vms?.protected)} sub={`백업 ${fmtNum(d.vms?.backedUp)} · 복제 ${fmtNum(d.vms?.replicated)}`} />
          <Kpi label="복원 지점" value={fmtNum(d.vms?.restorePoints)} sub={`전체 ${fmtBytes(d.vms?.fullSize)} · 증분 ${fmtBytes(d.vms?.incSize)}`} />
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'stretch' }}>
        <section className="card" data-em-license="" aria-label="라이선스" style={{ flex: '999 1 560px', minWidth: 0, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 10 }}>
            <b style={{ fontSize: 16 }}>라이선스 사용</b>
            <span className="muted" style={{ fontSize: 12 }}>B&R 서버(REST 9419)에서 읽은 값 · 서버 {fmtNum(lic.items.length)}대{lic.unknown ? ` · 수량 모름 ${lic.unknown}대(합계에서 뺌)` : ''}</span>
            {lic.earliestSupport && <span style={{ marginLeft: 'auto', padding: '3px 10px', borderRadius: 999, fontSize: 12, fontWeight: 700, background: BADGE_BG[ddayTone(lic.earliestSupport.daysLeft)], color: TONE[ddayTone(lic.earliestSupport.daysLeft)] }}>지원 만료 {ddayText(lic.earliestSupport.daysLeft)} · {lic.earliestSupport.server}</span>}
          </div>
          {!lic.items.length ? (
            <div className="muted" style={{ fontSize: 13 }}>라이선스를 읽은 B&R 서버가 없습니다{data.licenses?.brServers ? '(이 판의 B&R REST 가 라이선스를 주지 않거나 계정 권한이 부족할 수 있습니다 — 추정)' : '(설정 › Veeam 백업 서버에 B&R 서버를 등록하세요)'}.</div>
          ) : (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 22 }}>
                <div role="img" aria-label={lic.pct != null ? `인스턴스 사용률 ${lic.pct}%` : '인스턴스 사용률 모름'} style={{ width: 120, height: 120, borderRadius: '50%', flex: 'none', background: lic.pct != null ? `conic-gradient(#22d3ee 0 ${lic.pct}%, var(--panel-deep) ${lic.pct}% 100%)` : 'var(--panel-deep)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <div style={{ width: 92, height: 92, borderRadius: '50%', background: 'var(--panel)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                    <b style={{ fontSize: 22 }}>{lic.pct != null ? `${lic.pct}%` : '—'}</b><span className="muted" style={{ fontSize: 11 }}>인스턴스</span>
                  </div>
                </div>
                <div style={{ flex: '1 1 240px', minWidth: 0, display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '10px 20px', fontSize: 13 }}>
                  <div><div className="muted" style={{ fontSize: 12 }}>사용 / 전체</div><b style={{ fontSize: 18 }}>{fmtNum(lic.used)} / {fmtNum(lic.licensed)}</b></div>
                  <div><div className="muted" style={{ fontSize: 12 }}>남은 인스턴스</div><b style={{ fontSize: 18, color: lic.remain != null && lic.remain < 0 ? TONE.fail : undefined }}>{fmtNum(lic.remain)}</b></div>
                  <div><div className="muted" style={{ fontSize: 12 }}>가장 이른 라이선스 만료</div><b>{lic.earliest ? `${dateText(lic.earliest.ts)} · ${ddayText(lic.earliest.daysLeft)}` : '—'}</b></div>
                  <div><div className="muted" style={{ fontSize: 12 }}>가장 이른 지원 만료</div><b>{lic.earliestSupport ? `${dateText(lic.earliestSupport.ts)} · ${ddayText(lic.earliestSupport.daysLeft)}` : '—'}</b></div>
                </div>
              </div>
              <STable minWidth={560} style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead><tr style={{ textAlign: 'left', fontSize: 12 }}>
                  <th style={{ padding: '6px 6px 6px 0' }}>B&R 서버</th><th style={{ padding: '6px' }}>사용 / 전체</th><th data-nosort="" style={{ padding: '6px', width: '30%' }}>사용률</th>
                  <th style={{ padding: '6px' }}>지원 만료</th><th data-nosort="" style={{ padding: '6px 0 6px 6px' }}>최근 90일</th>
                </tr></thead>
                <tbody>
                  {lic.items.map((x) => (
                    <tr key={x.id} style={{ borderTop: '1px solid var(--border-soft)' }}>
                      <td style={{ padding: '8px 6px 8px 0' }}><b>{x.name}</b><div className="muted" style={{ fontSize: 11 }}>{[x.edition, x.type].filter(Boolean).join(' · ') || '—'}</div></td>
                      <td data-sort={x.used ?? ''} style={{ padding: '8px 6px', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{fmtNum(x.used)} / {fmtNum(x.licensed)}</td>
                      <td style={{ padding: '8px 6px' }}><div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><div style={{ flex: 1 }}><Meter pct={x.pct} color={x.pct != null && x.pct >= 95 ? BAR.fail : '#22d3ee'} /></div><span style={{ width: 46, textAlign: 'right' }}>{x.pct != null ? `${x.pct}%` : '—'}</span></div></td>
                      <td data-sort={x.supportExpires ?? ''} style={{ padding: '8px 6px', whiteSpace: 'nowrap', color: TONE[ddayTone(x.supportExpires != null ? Math.floor((x.supportExpires - now) / 86_400_000) : null)] }}>{x.supportExpires != null ? ddayText(Math.floor((x.supportExpires - now) / 86_400_000)) : '—'}</td>
                      <td style={{ padding: '8px 0 8px 6px' }}>{licHist == null ? <span className="muted" style={{ fontSize: 11 }}>이력 없음</span> : <Spark sp={sparkPoints(licHist[`vbr:${x.id}`], (u) => u)} color="#22d3ee" label={`${x.name} 인스턴스 사용`} />}</td>
                    </tr>
                  ))}
                </tbody>
              </STable>
            </>
          )}
        </section>

        {d && (
          <section className="card" aria-label="VM 마지막 백업 상태" style={{ flex: '1 1 300px', minWidth: 0, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <b style={{ fontSize: 16 }}>VM 마지막 백업 상태</b>
            {[['ok', '정상', ov.vmOk], ['warn', '경고', ov.vmWarn], ['fail', '실패', ov.vmFail]].map(([k, label, v]) => (
              <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
                <span style={{ width: 40, color: TONE[k] }}>{label}</span>
                <div style={{ flex: 1 }}><Meter pct={vmTot && typeof v === 'number' ? (v / vmTot) * 100 : 0} color={BAR[k]} /></div>
                <b style={{ width: 64, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtNum(v)}</b>
              </div>
            ))}
            <div style={{ borderTop: '1px solid var(--border-soft)', paddingTop: 10, display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10, fontSize: 13 }}>
              <div><div className="muted" style={{ fontSize: 12 }}>가장 긴 백업 작업</div><b>{d.jobStats?.maxBackupName || '—'}</b> <span className="muted">{fmtDur(d.jobStats?.maxBackupDurSec)}</span></div>
              <div><div className="muted" style={{ fontSize: 12 }}>가장 긴 복제 작업</div><b>{d.jobStats?.maxReplicaName || '—'}</b> <span className="muted">{fmtDur(d.jobStats?.maxReplicaDurSec)}</span></div>
              <div><div className="muted" style={{ fontSize: 12 }}>백업 성공률(EM)</div><b>{d.vms?.successPct != null ? `${d.vms.successPct}%` : '—'}</b></div>
              <div><div className="muted" style={{ fontSize: 12 }}>원본 VM 크기</div><b>{fmtBytes(d.vms?.sourceSize)}</b></div>
            </div>
          </section>
        )}
      </div>

      {d && (
        <section ref={jobsRef} className="card" data-em-jobs="" aria-label="작업 수행 상태" style={{ padding: '14px 0 6px', display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
          <div style={{ padding: '0 18px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
            <b style={{ fontSize: 16 }}>작업(백업 정책) 수행 상태</b>
            <span className="muted" style={{ fontSize: 12 }}>마지막으로 끝난 세션 기준(최근 7일) · 실패 → 경고 → 실행 중 → 정상 순</span>
            <div role="group" aria-label="결과 보기" style={{ marginLeft: 'auto', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {JOB_FILTERS.map(([k, label]) => <button key={k} type="button" className={`tab${jf === k ? ' active' : ''}`} aria-pressed={jf === k} onClick={() => setJf(k)} style={{ padding: '4px 12px', fontSize: 12 }}>{label} <b>{fmtNum(jobs?.counts?.[k])}</b></button>)}
            </div>
            <SearchBox className="input" style={{ maxWidth: 260, minWidth: 170 }} value={q} onChange={setQ} placeholder="작업 · 백업 서버 찾기" />
          </div>
          {!jobs ? <div className="muted" style={{ padding: '4px 18px 12px', fontSize: 13 }}>작업 목록을 읽지 못했습니다{chips.find((c) => c.k === 'jobs' && !c.ok)?.reason ? ` — ${chips.find((c) => c.k === 'jobs').reason}` : ''}.</div> : (
            <STable minWidth={960} limit={200} style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead><tr style={{ textAlign: 'left', fontSize: 12 }}>
                <th style={{ padding: '6px 18px' }}>작업</th><th style={{ padding: '6px' }}>백업 서버 · 법인</th><th style={{ padding: '6px' }}>유형</th><th style={{ padding: '6px' }}>마지막 결과</th>
                <th style={{ padding: '6px' }}>마지막 끝남</th><th style={{ padding: '6px' }}>소요</th><th style={{ padding: '6px' }}>다음 실행</th><th style={{ padding: '6px 18px 6px 6px', textAlign: 'right' }}>24시간 실패·경고</th>
              </tr></thead>
              <tbody>
                {shownJobs.map((j) => (
                  <React.Fragment key={`${j.server}|${j.uid || j.name}`}>
                  <tr style={{ borderTop: '1px solid var(--border-soft)' }}>
                    <td style={{ padding: '8px 18px' }}><b>{j.name}</b></td>
                    <td data-sort={`${j.server || ''} ${(j.vcNames || []).join(' ')}`} style={{ padding: '8px 6px', color: 'var(--text-dim)' }}>{j.server || '—'}{j.vcNames?.length ? <div style={{ fontSize: 11, color: 'var(--text)', overflowWrap: 'anywhere' }}>{j.vcNames.join(', ')}</div> : null}</td>
                    <td style={{ padding: '8px 6px', color: 'var(--text-dim)' }}>{j.type || '—'}</td>
                    <td data-sort={j.state} style={{ padding: '8px 6px' }}>{canOpenDetail(j.state, j.last?.uid) ? <DetailBtn k={j.state} on={openKey === `job|${j.last.uid}`} onClick={() => toggle(`job|${j.last.uid}`)} /> : <Badge k={j.state} />}</td>
                    <td data-sort={j.last?.end ?? ''} style={{ padding: '8px 6px', fontFamily: 'var(--mono)', fontSize: 12, whiteSpace: 'nowrap' }}>{shortTs(j.last?.end)}</td>
                    <td data-sort={j.last?.durSec ?? ''} style={{ padding: '8px 6px', whiteSpace: 'nowrap' }}>{j.running ? `${ago(j.running.start, now).replace(' 전', '')}째` : fmtDur(j.last?.durSec)}</td>
                    <td data-sort={j.nextRun ?? ''} style={{ padding: '8px 6px', fontFamily: 'var(--mono)', fontSize: 12, whiteSpace: 'nowrap', color: 'var(--text-dim)' }}>{shortTs(j.nextRun)}</td>
                    <td data-sort={(j.runs24?.fail || 0) * 1000 + (j.runs24?.warn || 0)} style={{ padding: '8px 18px 8px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}><span style={{ color: j.runs24?.fail ? TONE.fail : undefined }}>{fmtNum(j.runs24?.fail)}</span> · <span style={{ color: j.runs24?.warn ? TONE.warn : undefined }}>{fmtNum(j.runs24?.warn)}</span></td>
                  </tr>
                  {openKey === `job|${j.last?.uid}` && j.last?.uid && <tr><td colSpan={8} style={{ padding: '4px 0 12px' }}><div style={{ position: 'sticky', left: 18, width: jobsW > 60 ? jobsW - 36 : undefined, maxWidth: '100%' }}><EmSessionDetail emId={em.id} uid={j.last.uid} onClose={() => setOpenKey('')} /></div></td></tr>}
                  </React.Fragment>
                ))}
              </tbody>
            </STable>
          )}
          {jobs && <div className="muted" style={{ padding: '2px 18px 8px', fontSize: 12 }}>{fmtNum(shownJobs.length)}개 표시 · 전체 {fmtNum(jobs.counts.all)}개{jobs.truncated ? ' · 서버가 앞 1,000개만 보냈습니다' : ''} · 최근 7일 안에 끝난 세션이 없는 작업은 '기록 없음'(정상이라 단정하지 않습니다)</div>}
        </section>
      )}

      {d && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'stretch' }}>
          <section className="card" data-em-repos="" aria-label="백업 저장소" style={{ flex: '1 1 520px', minWidth: 0, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 10 }}><b style={{ fontSize: 16 }}>백업 저장소</b><span className="muted" style={{ fontSize: 12 }}>{d.repositories ? `${fmtNum(d.repositories.length)}곳 · 사용률 높은 순` : '읽지 못했습니다'}</span></div>
            {(d.repositories || []).slice(0, 12).map((r) => {
              const k = repoTone(r.usedPct);
              const hist = repoHist ? (repoHist[`em:${em.id}#${r.server || ''}|${r.name}`] || repoHist[`em:${em.id}#|${r.name}`] || null) : null;   // 키 = 폴러 recordHistory(백업 서버|이름 · 보고서는 |이름)
              return (
                // v2.788 Chromium 400px: 4열 격자는 nowrap 칸이 폭을 가져가 이름이 한 글자씩 꺾였다 — 줄바꿈되는 flex(이름·막대 한 줄, 수치·추이는 좁으면 아래로)
                <div key={`${r.server}|${r.name}`} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 14px', fontSize: 13 }}>
                  <span style={{ flex: '1 1 150px', minWidth: 0 }}><b style={{ overflowWrap: 'anywhere' }}>{r.name}</b><div className="muted" style={{ fontSize: 11 }}>{[r.server, r.kind].filter(Boolean).join(' · ') || '—'}</div></span>
                  <div style={{ flex: '2 1 120px', minWidth: 80 }}><Meter pct={r.usedPct} color={BAR[k]} /></div>
                  <span style={{ textAlign: 'right', whiteSpace: 'nowrap' }}><b style={{ color: TONE[k] }}>{r.usedPct != null ? `${r.usedPct}%` : '—'}</b> <span className="muted" style={{ fontSize: 12 }}>{r.usedPct != null ? `여유 ${fmtBytes(r.free)} / ${fmtBytes(r.capacity)}` : '용량 모름'}</span></span>
                  {repoHist == null ? <span className="muted" style={{ fontSize: 11 }}>이력 없음</span> : <Spark sp={sparkPoints(hist, usedPctOf)} color={BAR[k]} label={`${r.name} 사용률`} />}
                </div>
              );
            })}
          </section>

          <section className="card" data-em-bad="" aria-label="최근 실패·경고 세션" style={{ flex: '1 1 400px', minWidth: 0, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 10 }}><b style={{ fontSize: 16 }}>최근 실패·경고 세션</b><span className="muted" style={{ fontSize: 12 }}>24시간{d.sessions ? ` · ${fmtNum(d.sessions.recentBadTotal)}건` : ''}</span></div>
            {!d.sessions ? <div className="muted" style={{ fontSize: 13 }}>세션을 읽지 못했습니다.</div> : !d.sessions.recentBad.length ? <div className="muted" style={{ fontSize: 13 }}>최근 24시간에 실패·경고 세션이 없습니다.</div> : d.sessions.recentBad.slice(0, badAll ? 200 : 10).map((x, i) => (
              <div key={`${x.job}|${x.end}|${i}`} style={{ borderTop: '1px solid var(--border-soft)', padding: '8px 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '84px minmax(0, 1fr) auto', gap: 10, fontSize: 13 }}>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-dim)' }}>{shortTs(x.end)}</span>
                  <span style={{ minWidth: 0 }}><b style={{ overflowWrap: 'anywhere' }}>{x.job}</b><div className="muted" style={{ fontSize: 12 }}>{x.server || '—'}{x.vcNames?.length ? ` · ${x.vcNames.join(', ')}` : ''}</div></span>
                  {canOpenDetail(x.result, x.uid) ? <DetailBtn k={x.result} on={openKey === `bad|${x.uid}`} onClick={() => toggle(`bad|${x.uid}`)} /> : <Badge k={x.result} />}
                </div>
                {openKey === `bad|${x.uid}` && x.uid && <EmSessionDetail emId={em.id} uid={x.uid} onClose={() => setOpenKey('')} />}
              </div>
            ))}
            {d.sessions?.recentBad?.length > 10 && <button type="button" className="tab" onClick={() => setBadAll((v) => !v)} style={{ alignSelf: 'flex-start', padding: '4px 12px', fontSize: 12 }}>{badAll ? '10건만 보기' : `전부 보기(${fmtNum(Math.min(200, d.sessions.recentBad.length))}건)`}</button>}
          </section>
        </div>
      )}

      {d?.backupServers && (
        <section className="card" aria-label="EM 에 연결된 백업 서버" style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 10 }}><b style={{ fontSize: 16 }}>EM 에 연결된 백업 서버</b><span className="muted" style={{ fontSize: 12 }}>{fmtNum(d.backupServers.length)}대 · 포탈 B&R 짝과 법인은 설정 › Veeam 백업 서버 › Enterprise Manager › 백업 서버 매핑에서 정합니다(정하지 않으면 이름으로 자동)</span></div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10, fontSize: 13 }}>
            {d.backupServers.map((s) => (
              <div key={s.uid || s.name} style={{ padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 10, display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                <b style={{ overflowWrap: 'anywhere' }}>{s.name}</b>
                <span className="muted" style={{ fontSize: 12 }}>{s.version || '판 모름'}</span>
                <span style={{ fontSize: 12, color: s.registered ? TONE.ok : s.brSource === 'none' ? 'var(--text-dim)' : TONE.warn }}>{s.registered ? `포탈 등록됨${s.brName && s.brName !== s.name ? ` · ${s.brName}` : ''}` : s.brSource === 'none' ? '포탈에 없음(확정)' : '포탈 미등록(VM 별 표시 없음)'}</span>
                <span style={{ fontSize: 12, color: s.vcSource ? 'var(--text)' : 'var(--text-dim)', overflowWrap: 'anywhere' }}>{s.vcSource ? `법인 ${(s.vcNames || []).join(', ')}` : '법인 정하지 않음'}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {em?.status?.notes?.length > 0 && (
        <div className="muted" style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {em.status.notes.map((n, i) => <span key={i}>· {n}</span>)}
        </div>
      )}
    </div>
  );
}
