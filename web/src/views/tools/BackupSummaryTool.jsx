/**
 * 백업 서머리 — 특수 기능 `backup-summary`(v2.779 · v2.787) → v2.836 백업 메뉴 개편 1-b(사용자 요청 '28개 법인 · Veeam + Bareos 통합 ·
 *   vCenter 폴더 구조의 전체 백업 현황' · '서머리에는 veeam/bareos/ssh 3개를 합쳐 BackedUp · 백업 안함 · 확인 필요' · '폴더를 클릭하면 VM list' ·
 *   '써머리/detail 화면에서 Clone/snapshot 관련 문구와 기능 제거' + 시안 ① Summary).
 *   숫자 줄 · 두 솔루션 카드 · 백업 안 된 VM 찾기(전체 법인) · 법인 › 폴더 › VM 트리 표. 값은 서버(GET /api/tools/backup-summary — 법인 집계 pa 는
 *   veeam/backupSummaryAgg.js 가 Detail 과 같은 VM 행을 센 값)가 낸다. 도구 키는 그대로.
 * ⚠ 무거운 집계라 폴링하지 않는다(마운트 1회 + 새로고침 · 서버 60초 캐시) · 늦게 온 이전 응답은 버린다 · 훅은 조기 return 위.
 * ⚠ 못 읽은 값은 '—'(0 이 아니다) · 부분 합은 '*'.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson, downloadFile, canCsv, hasRole, toolAllowed } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { fmtNum, summaryKpis, shortTs, loadOpts, saveOpts, scopeQuery, scopeNote, CRIT, marksLine, marksNotice, veeamStateOf } from './backupViewText.js';
import { summaryPolicyKpis, bundlesOf } from './backupSummaryText.js';
import VeeamHeader, { visibleTabs } from './VeeamHeader.jsx';
import { CritIcon, NeedIcon, NEED_COLOR } from './BackupMarkIcons.jsx';
import BackupOptions from './BackupOptions.jsx';
import BackupSummaryStale from './BackupSummaryStale.jsx';
import BackupSummaryTree from './BackupSummaryTree.jsx';

export const DETAIL_VC_KEY = 'backup-detail-vc';   // 서머리에서 고른 vCenter 를 세부내용이 이어받는다(이 브라우저에만)

const TONE = { ok: '#86efac', bad: '#fca5a5', warn: '#fcd34d', info: '#93c5fd', muted: 'var(--text-dim)' };

function Kpi({ label, value, sub, color, border, title }) {
  return (
    <div className="card" title={title} style={{ padding: '12px 14px', minWidth: 0, border: `1px solid ${border || 'var(--border)'}` }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: color || 'var(--text-dim)' }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 800, marginTop: 2, color: color || 'var(--text)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{value}</div>
      {sub && <div className="muted" style={{ fontSize: 11.5, marginTop: 2, overflowWrap: 'anywhere' }}>{sub}</div>}
    </div>
  );
}
function Stat({ label, value, tone, title }) {
  return (
    <div title={title} style={{ minWidth: 0 }}>
      <div className="muted" style={{ fontSize: 11.5 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: tone ? TONE[tone] : undefined, overflowWrap: 'anywhere' }}>{value}</div>
    </div>
  );
}

export function openDetail(vcId) {
  try { localStorage.setItem(DETAIL_VC_KEY, vcId); } catch { /* 저장 못 해도 세부내용은 첫 vCenter 로 열린다 */ }
  window.location.hash = '#/tools/backup-detail';
}

export default function BackupSummaryTool() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
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
  const pa = t.pa || null;
  const kp = summaryPolicyKpis(t, { rpoDays: opts.rpoDays });
  const kpi = summaryKpis(t, { rpoDays: opts.rpoDays });   // 지금 백업 중(Veeam) — 결과가 오래된 서버가 있으면 '*'
  const note = scopeNote(data.scope, t);
  const mk = marksLine(t.marks, data.marksUnreadable);
  const mkNote = marksNotice(data);
  const linked = rows.filter((r) => r.veeamState !== 'unlinked').length;
  const veeamBad = rows.filter((r) => r.veeamState === 'veeam-failed' || r.veeamState === 'registry-unreadable').length;
  const sum = (k) => rows.reduce((s, r) => s + (Number.isFinite(r[k]) ? r[k] : 0), 0);
  const b = bundlesOf(pa);
  const bareosAllUnknown = rows.length > 0 && rows.every((r) => r.bareosUnknown);
  const bareosHref = (visibleTabs({ admin: hasRole('admin'), bareosOk: toolAllowed('bareos-backup'), bareosViewOk: toolAllowed('bareos-summary') }).find(([k]) => k === 'bareos') || [])[2];
  const jobs = Array.isArray(data.runningJobs) ? data.runningJobs : null;
  const scope = { power: opts.power, excl: opts.excl };

  return (
    <div data-backup-summary="" style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
      <VeeamHeader active="summary" desc={`법인 ${fmtNum(t.vcenters)}곳 · Veeam + Bareos 를 한 기준으로 — 백업 정책(BackedUp · 백업 안함 · 확인 필요) · RPO · 실패 · vCenter 폴더 구조`}
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
      {mkNote && <div className="card" style={{ padding: '8px 12px', fontSize: 12, color: mkNote.tone === 'bad' ? TONE.bad : TONE.warn }}>{mkNote.text}</div>}

      {/* 숫자 줄 — 정책 세 묶음(BackedUp · 백업 안함 · 확인 필요 — 사용자 정의) · RPO · 정책≠실제 · 지금 백업 중 · 실패 */}
      {/* 1440 = 4열 × 2줄(한 장이 홀로 남지 않게) · 400 = 2열 */}
      <div data-backup-kpis="" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(250px, calc(50% - 5px)), 1fr))', gap: 10 }}>
        <Kpi label="대상 VM" value={kp.vm.value} sub={kp.vm.sub} />
        <Kpi label="BackedUp" value={kp.backed.value} color="#4ade80" border="#1d4d33" sub={kp.backed.sub} title="정책이 Veeam · Bareos · SSH 인 VM 합 — 세부 구분은 Detail" />
        <Kpi label="백업 안함" value={kp.none.value} color="#cbd5e1" sub={kp.none.sub} />
        <Kpi label="확인 필요" value={kp.check.value} color="#fbbf24" border="#5c4513" sub={kp.check.sub} />
        <Kpi label={`RPO 충족(${opts.rpoDays}일)`} value={kp.rpo.value} color="#86efac" sub={kp.rpo.sub} title="기준 안에 성공한 백업(Veeam · Bareos)이 있는 VM 비율 — 백업 안함 제외 · 결과를 모르는 VM 은 따로" />
        <Kpi label="정책≠실제" value={kp.mm.value} color="#fca5a5" border="rgba(239,68,68,.4)" sub={kp.mm.sub} title="정책 Veeam 인데 Veeam 대상에 없음 · 정책 Bareos 인데 잡 없음 · 백업 안함·확인 필요인데 실제 백업이 있음" />
        <Kpi label="지금 백업 중(Veeam)" value={kpi.running.value} color="#fbbf24" sub={kpi.running.sub} />
        <Kpi label="실패 · 경고 24h" value={kp.err.value} color="#fca5a5" sub={kp.err.sub} title="최근 24시간 Veeam 마지막 결과 · Bareos 마지막 실행이 실패·경고인 VM 수" />
      </div>

      {/* 두 솔루션 카드 — 지금 포탈이 읽는 값만(용량 · 잡 일정 · 저장소는 다음 단계) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12 }}>
        <section className="card" aria-label="Veeam" data-backup-sol="veeam" style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
          <div className="flex wrap" style={{ alignItems: 'center', gap: 8 }}>
            <span style={{ padding: '2px 10px', borderRadius: 999, fontSize: 12, fontWeight: 800, color: '#86efac', background: 'rgba(34,197,94,.14)' }}>Veeam</span>
            <span className="muted" style={{ fontSize: 12 }}>B&amp;R 서버 {fmtNum(sum('veeamServers'))} · 연동 법인 {fmtNum(linked)}/{fmtNum(rows.length)}</span>
            <a href="#/tools/backup-em" style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 700, color: '#93c5fd', textDecoration: 'none', whiteSpace: 'nowrap' }}>Veeam 메뉴 →</a>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 8 }}>
            <Stat label="실제 Veeam VM" value={fmtNum(pa?.act?.v)} tone="ok" />
            <Stat label="정책 Veeam" value={b ? fmtNum(b.parts.veeam) : '—'} />
            <Stat label="정책인데 대상 아님" value={fmtNum(pa?.mmBy?.veeam)} tone={pa?.mmBy?.veeam ? 'bad' : undefined} />
            <Stat label="읽기 실패 서버" value={fmtNum(sum('veeamFailed'))} tone={sum('veeamFailed') ? 'bad' : undefined} />
            <Stat label="결과 오래됨" value={fmtNum(sum('veeamStale'))} tone={sum('veeamStale') ? 'warn' : undefined} />
            <Stat label="읽기 실패 법인" value={fmtNum(veeamBad)} tone={veeamBad ? 'bad' : undefined} />
          </div>
          {jobs && (
            <div style={{ fontSize: 12, minWidth: 0 }}>
              <b style={{ fontSize: 12 }}>지금 도는 Veeam 작업</b>
              {jobs.length === 0 ? <span className="muted"> — 없습니다.</span> : jobs.slice(0, 5).map((j, i) => (
                <div key={`${j.vcenter}-${j.server}-${j.name}-${i}`} className="flex" style={{ justifyContent: 'space-between', gap: 8, minWidth: 0 }}>
                  <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{j.vcenter} › {j.name}</span><b style={{ color: '#fbbf24' }}>{Number.isFinite(j.pg) ? `${j.pg}%` : '—'}</b>
                </div>
              ))}
              {jobs.length > 5 && <div className="muted">외 {jobs.length - 5}개</div>}
              <div className="muted" style={{ fontSize: 11 }}>작업 전체 진행률 · 관리자에게만 보입니다</div>
            </div>
          )}
        </section>
        <section className="card" aria-label="Bareos" data-backup-sol="bareos" style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
          <div className="flex wrap" style={{ alignItems: 'center', gap: 8 }}>
            <span style={{ padding: '2px 10px', borderRadius: 999, fontSize: 12, fontWeight: 800, color: '#fdba74', background: 'rgba(249,115,22,.14)' }}>Bareos</span>
            <span className="muted" style={{ fontSize: 12 }}>백업 그룹 {data.bareosGroups ? `${fmtNum(data.bareosGroups.n)} · 예약 켬 ${fmtNum(data.bareosGroups.sched)}` : '모름'}</span>
            {bareosHref && <a href={bareosHref} style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 700, color: '#93c5fd', textDecoration: 'none', whiteSpace: 'nowrap' }}>Bareos 메뉴 →</a>}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 8 }}>
            <Stat label="실제 Bareos 잡 VM" value={bareosAllUnknown ? '—' : `${fmtNum(pa?.act?.b)}${t.bareosUnknownSites ? '*' : ''}`} tone="ok" />
            <Stat label="정책 Bareos" value={b ? fmtNum(b.parts.bareos) : '—'} />
            <Stat label="미등록" title="정책은 Bareos 인데 Bareos 잡이 없는 VM — Detail 의 Bareos 대상 등록으로" value={fmtNum(pa?.mmBy?.bareos)} tone={pa?.mmBy?.bareos ? 'bad' : undefined} />
            <Stat label="원장 못 읽은 법인" value={fmtNum(t.bareosUnknownSites ?? 0)} tone={t.bareosUnknownSites ? 'bad' : undefined} />
            <Stat label="정책 SSH" value={b ? fmtNum(b.parts.ssh) : '—'} tone="info" />
          </div>
          <div className="muted" style={{ fontSize: 11.5 }}>Bareos 수는 포탈 원장(등록한 잡) 기준입니다 · 진행 중인 백업 · Director 상태는 Bareos 메뉴의 진행 현황에서 봅니다 · SSH 는 정책 값만 있고 결과는 아직 읽지 않습니다.</div>
        </section>
      </div>

      {/* v2.784 사람이 정한 표시(업무 중요도 · 백업 필요)의 합 — Detail 에서 VM 마다 정한다 */}
      {mk && (
        <div className="card" data-backup-marks="" style={{ padding: '10px 16px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 22px', minWidth: 0, fontSize: 13 }}>
          <b style={{ fontSize: 13 }}>업무 중요도</b>
          {CRIT.map((c) => <span key={c.key} className="flex" style={{ gap: 6, alignItems: 'center', whiteSpace: 'nowrap' }}><CritIcon crit={c.key} withText /><b style={{ fontSize: 18, fontVariantNumeric: 'tabular-nums', color: mk[c.key] == null ? 'var(--text-dim)' : undefined }}>{fmtNum(mk[c.key])}</b></span>)}
          <span style={{ width: 1, alignSelf: 'stretch', background: 'var(--border)' }} aria-hidden="true" />
          <span className="flex" style={{ gap: 6, alignItems: 'center', whiteSpace: 'nowrap' }}><NeedIcon /><span style={{ color: NEED_COLOR }}>백업 필요</span><b style={{ fontSize: 18, fontVariantNumeric: 'tabular-nums', color: mk.need == null ? 'var(--text-dim)' : undefined }}>{fmtNum(mk.need)}</b></span>
          {mk.need > 0 && <span style={{ minWidth: 0, overflowWrap: 'anywhere', color: mk.needGap > 0 ? TONE.bad : 'var(--text-dim)' }}>그중 Veeam 백업 안 보임 <b>{fmtNum(mk.needGap)}</b>{mk.needGapUnknown ? <span className="muted"> (Veeam 확인 불가 {mk.needGapUnknown}곳 제외)</span> : null}</span>}
          <span className="muted" style={{ fontSize: 12, marginLeft: 'auto', minWidth: 0, overflowWrap: 'anywhere' }}>Detail 에서 VM 마다 정합니다</span>
        </div>
      )}

      <BackupSummaryStale scope={scope} onOpenDetail={openDetail} />
      <BackupSummaryTree rows={rows} opts={opts} reloadKey={data.at} onOpenDetail={openDetail} />
      {rows.some((r) => r.veeamState && r.veeamState !== 'ok' && r.veeamState !== 'unlinked') && (
        <div className="muted" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>
          Veeam 값을 일부만 읽은 법인: {rows.filter((r) => r.veeamState && r.veeamState !== 'ok' && r.veeamState !== 'unlinked').map((r) => `${r.name}(${veeamStateOf(r.veeamState).text})`).join(' · ')}
        </div>
      )}
    </div>
  );
}
