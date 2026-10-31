/**
 * 백업 서머리 — 특수 기능 `backup-summary`(v2.779 · v2.787 · v2.836) → v2.837 시안 ① 에 맞춤(사용자 요청 '시안대로 다 맞춰줘').
 *   숫자 줄 6칸(보호 대상 · RPO 충족 · 보호 안 됨·확인 안 됨 · 지금 실행 중 · 최근 24시간 백업 · 백업된 용량) · Veeam/Bareos 카드 ·
 *   도구 줄(고른 VM 에 백업 정책 · 백업 등록 — 한 법인 안에서만) · 백업 안 된 VM 찾기(전체 법인) · 법인 › 폴더 › VM 트리 표 · 값 출처.
 *   값은 서버(GET /api/tools/backup-summary — 법인 집계 pa 는 veeam/backupSummaryAgg.js 가 Detail 과 같은 VM 행을 센 값)가 낸다. 도구 키는 그대로.
 *   용량과 일정 · 통합 에러 로그는 v2.838(시안 ① 아래 두 구획).
 * ⚠ 무거운 집계라 폴링하지 않는다(마운트 1회 + 새로고침 · 서버 60초 캐시) · 늦게 온 이전 응답은 버린다 · 훅은 조기 return 위.
 * ⚠ 못 읽은 값은 '—'(0 이 아니다) · 부분 합은 '*' · 자료가 없는 칸은 출처를 바꿔 채우고 밝힌다(사용자 결정 — 지어내지 않는다).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson, downloadFile, canCsv, hasRole, toolAllowed } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { fmtNum, shortTs, loadOpts, saveOpts, scopeQuery, scopeNote, veeamStateOf } from './backupViewText.js';
import { summaryPolicyKpis, bundlesOf, okPct, hhmm, rpoLabel } from './backupSummaryText.js';
import VeeamHeader, { visibleTabs } from './VeeamHeader.jsx';
import BackupOptions from './BackupOptions.jsx';
import BackupSummaryBar from './BackupSummaryBar.jsx';
import BackupSummaryStale from './BackupSummaryStale.jsx';
import BackupSummaryTree from './BackupSummaryTree.jsx';
import BackupSummaryCapSched from './BackupSummaryCapSched.jsx';
import BackupSummaryErrors from './BackupSummaryErrors.jsx';

export const DETAIL_VC_KEY = 'backup-detail-vc';   // 서머리에서 고른 vCenter 를 세부내용이 이어받는다(이 브라우저에만)

const TONE = { ok: '#86efac', bad: '#fca5a5', warn: '#fcd34d', info: '#93c5fd', muted: 'var(--text-dim)' };
const CHIP = { bad: { color: '#fca5a5', background: 'rgba(239,68,68,.14)' }, warn: { color: '#fcd34d', background: 'rgba(245,158,11,.14)' }, info: { color: '#93c5fd', background: 'rgba(59,130,246,.14)' }, muted: { color: 'var(--text-dim)', background: 'var(--panel-deep)' } };

function Kpi({ label, value, sub, color, border, title, unit, small }) {
  return (
    <div className="card" title={title} style={{ padding: '12px 14px', minWidth: 0, border: `1px solid ${border || 'var(--border)'}` }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-dim)' }}>{label}</div>
      <div style={{ fontSize: small ? 21 : 26, fontWeight: 800, marginTop: 2, color: color || 'var(--text)', fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere', ...(small ? { whiteSpace: 'nowrap' } : {}) }}>{value}{unit}</div>
      {sub && <div className="muted" style={{ fontSize: 11.5, marginTop: 2, overflowWrap: 'anywhere', lineHeight: 1.45 }}>{sub}</div>}
    </div>
  );
}
function Stat({ label, value, extra, tone, title }) {
  return (
    <div title={title} style={{ minWidth: 0 }}>
      <div className="muted" style={{ fontSize: 11.5 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: tone ? TONE[tone] : undefined, overflowWrap: 'anywhere' }}>{value}{extra ? <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-dim)' }}> {extra}</span> : null}</div>
    </div>
  );
}
const Chip = ({ tone = 'muted', children, title }) => <span title={title} style={{ ...CHIP[tone], padding: '2px 9px', borderRadius: 999, fontSize: 11.5, fontWeight: 700, whiteSpace: 'nowrap' }}>{children}</span>;
const pctText = (x) => (x == null ? '—' : `${x}%`);

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
  // v2.837 선택 — 트리 표 · 찾기 결과가 함께 쓴다(시안 '선택은 한 법인 안에서만' — 다른 법인 칸은 화면이 막는다)
  const [sel, setSel] = useState(() => ({ vc: null, ids: new Set() }));
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
  // 선택 바꾸기 — vc 가 다르면 무시(화면이 막지만 한 번 더) · 다 풀리면 법인도 풀린다
  const pick = useCallback((vc, ids, on) => setSel((cur) => {
    if (cur.vc && cur.vc !== vc && cur.ids.size) return cur;
    const s = new Set(cur.vc === vc ? cur.ids : []);
    for (const id of ids) { if (on) s.add(id); else s.delete(id); }
    return { vc: s.size ? vc : null, ids: s };
  }), []);
  const clearSel = useCallback(() => setSel({ vc: null, ids: new Set() }), []);

  if (!data && loading) return <Loading />;
  // v2.785(GV C-B4): 오류 객체를 그대로 — 403 을 문자열로 바꾸면 ErrorBox 가 권한 안내(AccessDenied)로 바꾸지 못했다
  if (!data && error) return <ErrorBox error={error} />;
  if (!data) return null;

  const rows = Array.isArray(data.rows) ? data.rows : [];
  const t = data.totals || {};
  const pa = t.pa || null;
  const em = data.em || null;
  const kp = summaryPolicyKpis(t, { rpoDays: opts.rpoDays, rows, em });
  const note = scopeNote(data.scope, t);
  const b = bundlesOf(pa);
  const sum = (k) => rows.reduce((s, r) => s + (Number.isFinite(r[k]) ? r[k] : 0), 0);
  const linked = rows.filter((r) => r.veeamState !== 'unlinked').length;
  const veeamAuth = sum('veeamAuth');
  const bareosAllUnknown = rows.length > 0 && rows.every((r) => r.bareosUnknown);
  const bareosHref = (visibleTabs({ admin: hasRole('admin'), bareosOk: toolAllowed('bareos-backup'), bareosViewOk: toolAllowed('bareos-summary') }).find(([k]) => k === 'bareos') || [])[2];
  const g = data.bareosGroups;
  const dirs = data.directors;
  const scope = { power: opts.power, excl: opts.excl };
  const link = { marginLeft: 'auto', fontSize: 12, fontWeight: 700, color: '#93c5fd', textDecoration: 'none', whiteSpace: 'nowrap' };
  const partial = rows.filter((r) => r.veeamState && r.veeamState !== 'ok' && r.veeamState !== 'unlinked');

  return (
    <div data-backup-summary="" style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
      <VeeamHeader active="summary" desc={`${fmtNum(t.vcenters)}개 법인 · Veeam + Bareos 를 한 기준으로 — 보호 대상 · RPO 충족 · 용량 · 일정 · 에러`}
        actions={<>
          <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>기준 {shortTs(data.at)}{error ? ' · 최근 새로고침 실패 — 이전 값' : ''}</span>
          <button type="button" className="tab" disabled={loading} onClick={load} style={{ padding: '6px 14px' }}>{loading ? '읽는 중…' : '새로고침'}</button>
          {canCsv() && <button type="button" className="tab" onClick={csv} style={{ padding: '6px 14px' }}>CSV</button>}
        </>} />
      <div className="flex gap wrap" style={{ alignItems: 'center', rowGap: 6 }}>
        <BackupOptions opts={opts} onChange={changeOpts} disabled={loading} />
        {note && <span className="muted" style={{ fontSize: 12, overflowWrap: 'anywhere', minWidth: 0 }}>{note}</span>}
      </div>
      {csvErr && <div className="card" style={{ padding: '8px 12px', color: TONE.bad, fontSize: 12 }}>CSV 내보내기 실패 — {csvErr?.status === 403 ? 'CSV 권한이 없습니다.' : String(csvErr.message || csvErr)}</div>}
      {data.registryUnreadable && <div className="card" style={{ padding: '8px 12px', color: TONE.bad, fontSize: 12 }}>Veeam 서버 등록부를 읽지 못해 Veeam 기준은 모두 확인 불가입니다 — 설정 › Veeam 백업 서버를 확인하세요.</div>}
      {data.marksUnreadable && <div className="card" style={{ padding: '8px 12px', color: TONE.bad, fontSize: 12 }}>백업 정책 표시 파일을 읽지 못해 정책 수는 모름입니다 — Detail 의 안내를 확인하세요.</div>}

      {/* 숫자 줄 6칸(시안 ① — 1440 = 한 줄 · 400 = 2열) */}
      <div data-backup-kpis="" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(170px, calc(50% - 5px)), 1fr))', gap: 10 }}>
        <Kpi label="보호 대상 VM" value={kp.prot.value} sub={kp.prot.sub} />
        <Kpi label={`RPO 충족(${rpoLabel(opts.rpoDays)})`} value={kp.rpo.value} color={TONE.ok} sub={kp.rpo.sub} title="기준 안에 성공한 백업(Veeam · Bareos)이 있는 VM 비율 — 백업 안함 정책 제외 · 결과를 모르는 VM 은 따로" />
        <Kpi label="보호 안 됨 · 확인 안 됨" value={kp.unprot.value} color={TONE.bad} border="rgba(239,68,68,.45)" sub={kp.unprot.sub} title={kp.unprot.title} />
        <Kpi label="지금 실행 중" value={kp.run.value} color={TONE.info} sub={kp.run.sub} title={kp.run.title} />
        <Kpi label="최근 24시간 백업(성공 / 경고 / 실패)" value={kp.r24.value} color={TONE.ok} sub={kp.r24.sub} title={kp.r24.title} small />
        <Kpi label="백업된 용량(전체)" value={kp.bytes.value} sub={kp.bytes.sub} title={kp.bytes.title} />
      </div>

      {/* 두 솔루션 카드(시안 ①) — EM 값은 전체 범위 계정만(범위 계정은 '—') · 자료가 없는 칸은 출처를 밝힌다 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(420px, 100%), 1fr))', gap: 12 }}>
        <section className="card" aria-label="Veeam" data-backup-sol="veeam" style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
          <div className="flex wrap" style={{ alignItems: 'center', gap: 8 }}>
            <span style={{ padding: '2px 10px', borderRadius: 999, fontSize: 12, fontWeight: 800, color: '#93c5fd', background: 'rgba(59,130,246,.18)' }}>Veeam</span>
            <b style={{ fontSize: 13 }}>B&amp;R 서버 {fmtNum(sum('veeamServers'))} · EM {em ? fmtNum(em.ems) : '—'} · 잡 {em?.jobs != null ? fmtNum(em.jobs) : '—'}</b>
            <span className="muted" style={{ fontSize: 11.5 }}>연동 법인 {fmtNum(linked)}/{fmtNum(rows.length)}</span>
            <a href="#/tools/backup-em" style={link}>Veeam 메뉴 →</a>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 8 }}>
            <Stat label="보호 VM" value={fmtNum(pa?.act?.v)} />
            <Stat label="7일 성공률" value={pctText(okPct(pa?.v7))} tone="ok" title="최근 7일에 끝난 VM 마지막 결과 중 성공·경고 비율(B&R 결과 기준 — 잡 세션 수가 아니다)" />
            <Stat label="저장소 사용" value={em?.repo ? `${em.repo.usedPct}%` : '—'} extra={em?.repo?.overN ? `${em.repo.overN}곳 90% 넘음` : ''} title={em ? 'EM 이 읽은 저장소 용량 합' : 'EM 자료는 전체 범위 계정만 봅니다'} />
            <Stat label="다음 창" value={pa?.vnx ? hhmm(pa.vnx) : '—'} extra={pa?.vnx ? `VM ${fmtNum(pa.vnxN)}` : ''} title="Veeam 잡의 다음 실행 중 가장 이른 시각 · 그 뒤 1시간 안에 도는 VM 수" />
          </div>
          <div className="flex wrap" style={{ gap: 6 }}>
            {(veeamAuth > 0 || em?.auth?.length > 0) && <Chip tone="bad" title="인증 실패로 주기 수집을 멈춘 서버(자동 재시도 없음 — 설정에서 계정을 고치세요)">인증 실패 {fmtNum(veeamAuth + (em?.auth?.length || 0))}{em?.auth?.length ? ` (${em.auth.slice(0, 2).join(' · ')})` : ''}</Chip>}
            {em?.lic && <Chip tone={em.lic.pct >= 90 ? 'warn' : 'muted'}>라이선스 {em.lic.pct}% 사용</Chip>}
            {sum('veeamFailed') > 0 && <Chip tone="bad">읽기 실패 서버 {fmtNum(sum('veeamFailed'))}</Chip>}
            {partial.length > 0 && <Chip tone="warn" title={partial.map((r) => `${r.name}(${veeamStateOf(r.veeamState).text})`).join(' · ')}>일부만 읽은 법인 {partial.length}</Chip>}
          </div>
        </section>
        <section className="card" aria-label="Bareos" data-backup-sol="bareos" style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
          <div className="flex wrap" style={{ alignItems: 'center', gap: 8 }}>
            <span style={{ padding: '2px 10px', borderRadius: 999, fontSize: 12, fontWeight: 800, color: '#5eead4', background: 'rgba(20,184,166,.18)' }}>Bareos</span>
            <b style={{ fontSize: 13 }}>Director {dirs ? fmtNum(dirs.n) : '—'} · 잡 {bareosAllUnknown ? '—' : fmtNum(pa?.act?.b)} · 그룹 {g ? fmtNum(g.n) : '—'}</b>
            {bareosHref && <a href={bareosHref} style={link}>Bareos 메뉴 →</a>}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 8 }}>
            <Stat label="보호 VM" value={bareosAllUnknown ? '—' : `${fmtNum(pa?.act?.b)}${t.bareosUnknownSites ? '*' : ''}`} />
            <Stat label="7일 성공률" value={pctText(okPct(pa?.b7))} tone="ok" title="최근 7일에 끝난 VM 마지막 실행 중 성공·경고 비율(포탈 원장 기준)" />
            <Stat label="풀 사용(볼륨)" value="—" extra="2차 수집 뒤" title="Director 풀 · 볼륨 수집은 백업 메뉴 개편 2차에서 합니다" />
            <Stat label="다음 회차" value={g?.next ? hhmm(g.next) : '—'} extra={g?.next ? `그룹 ${fmtNum(g.nextN)} · 스케줄 —(2차)` : ''} title="포탈 그룹 예약의 다음 회차 · 그 뒤 1시간 안에 도는 그룹 수 · Director 스케줄은 2차 수집 뒤" />
          </div>
          <div className="flex wrap" style={{ gap: 6 }}>
            {t.stuck == null ? <Chip tone="muted" title="Bareos › 진행 현황 화면이 열려 최근 조회한 값이 있을 때만 셉니다">멈춤 의심 —</Chip> : <Chip tone={t.stuck ? 'warn' : 'muted'}>멈춤 의심 {fmtNum(t.stuck)}</Chip>}
            <Chip tone={pa?.mmBy?.bareos || pa?.bmis ? 'warn' : 'muted'} title="미등록 = 정책 Bareos 인데 잡 없음 · 방식 불일치 = Bareos 잡이 있는데 정책이 Bareos 가 아님">미등록 {fmtNum(pa?.mmBy?.bareos)} · 방식 불일치 {fmtNum(pa?.bmis)}</Chip>
            {dirs && <Chip tone={dirs.failed ? 'bad' : 'muted'}>Director 조회 실패 {fmtNum(dirs.failed)}</Chip>}
            {t.bareosUnknownSites > 0 && <Chip tone="bad">원장 못 읽은 법인 {fmtNum(t.bareosUnknownSites)}</Chip>}
          </div>
        </section>
      </div>

      <BackupSummaryBar sel={sel} rows={rows} onClear={clearSel} onSaved={load} />
      <BackupSummaryStale scope={scope} rows={rows} sel={sel} onPick={pick} onOpenDetail={openDetail} />
      <BackupSummaryTree rows={rows} opts={opts} reloadKey={data.at} onOpenDetail={openDetail} sel={sel} onPick={pick} />
      <BackupSummaryCapSched rows={rows} em={em} reloadKey={data.at} />
      <BackupSummaryErrors reloadKey={data.at} onOpenDetail={openDetail} />

      <div className="card" data-backup-source="" style={{ padding: '10px 14px', fontSize: 11.5, lineHeight: 1.6, color: 'var(--text-dim)' }}>
        <b style={{ color: 'var(--text)' }}>값 출처</b> — 보호 대상 · 정책 · RPO: 백업 정책(Detail 에서 정한 값)과 실제 백업(Veeam 대조 · Bareos 원장)을 VM 마다 같은 판정으로 센 값 ·
        BackedUp {b ? fmtNum(b.backed) : '—'} = 정책 Veeam · Bareos · SSH 합 · 실행 중: Veeam 결과 + Bareos 원장 · 용량: Veeam 복원 지점 크기 + Bareos 마지막 실행 크기(카탈로그 전체 합이 아니다) ·
        Veeam 저장소 · 라이선스 · 잡 수 · 30일 추이: EM(전체 범위 계정만) · 다음 회차 · 스케줄: Veeam 잡 다음 실행(B&amp;R 결과 — 다음 1회만) + 포탈 그룹 예약(Director 스케줄 · 풀은 2차 수집 뒤) ·
        에러: Veeam VM 마지막 결과 · EM 세션 + Bareos 원장 · 진행 현황 + 포탈 수집 오류 · 한쪽을 못 읽은 법인은 ‘모름’·‘*’ 로 따로 셉니다(0 이 아닙니다).
      </div>
    </div>
  );
}
