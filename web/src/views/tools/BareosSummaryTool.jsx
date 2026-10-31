/**
 * Bareos 통합 현황 — 특수 기능 `bareos-summary`(v2.828, 사용자 요청 'Bareos 백업 전용 화면 · 28개 법인을 통합할 수 있는 화면' + 시안 ③ · 권장안 A 조회 전용 키).
 *   메뉴: 서버 › Backup → 화면 위 'Bareos' 탭 → 하위 탭 '통합 현황'(BareosTabs). 값은 서버 GET /api/tools/bareos-summary(routes/api/bareosViews.js —
 *   원장·백업 표시·폴러 상태만, Director 에 접속하지 않는다). 판정·문구는 bareosViewText.js 하나.
 * ⚠ 못 읽은 값은 '—'(0 이 아니다) · 부분 합에는 '*' · 훅은 조기 return 위 · 늦게 온 이전 응답은 버린다 · 마운트 1회 + 새로고침 + 60초.
 */
import React, { useCallback, useRef, useState } from 'react';
import { usePolling, downloadFile, canCsv } from '../../api.js';
import { Loading, ErrorBox, SearchBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import VeeamHeader from './VeeamHeader.jsx';
import BareosTabs from './BareosTabs.jsx';
import BareosPolicyTab from './BareosPolicyTab.jsx';
import { useHashTab } from '../../hooks/useHashTab.js';
import { CritIcon } from './BackupMarkIcons.jsx';
import {
  directorStateOf, numText, resultBar, shortTs, fmtGb, PRIORITY_TEXT, PRIORITY_TONE, BAREOS_RPO_DAYS, BAREOS_DETAIL_VC_KEY, stText,
} from './bareosViewText.js';

const TONE = { ok: '#86efac', warn: '#fcd34d', bad: '#fca5a5', run: '#93c5fd', muted: 'var(--text-dim)', bareos: '#fdba74' };
const TAG = {
  bad: { background: 'rgba(239,68,68,.16)', color: '#fca5a5' }, warn: { background: 'rgba(245,158,11,.16)', color: '#fcd34d' },
  muted: { background: 'rgba(148,163,184,.12)', color: 'var(--text-dim)' },
};
const RPO_KEY = 'bareos-summary-rpo';
const loadRpo = () => { try { const v = Number(localStorage.getItem(RPO_KEY)); return BAREOS_RPO_DAYS.includes(v) ? v : 1; } catch { return 1; } };

export function openBareosDetail(vcId) {
  try { localStorage.setItem(BAREOS_DETAIL_VC_KEY, vcId); } catch { /* 저장 못 해도 법인별 현황은 첫 법인으로 열린다 */ }
  window.location.hash = '#/tools/bareos-detail';
}

function Kpi({ label, value, sub, color, border }) {
  return (
    <div className="card" style={{ padding: '12px 14px', minWidth: 0, border: `1px solid ${border || 'var(--border)'}` }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: color || 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 800, marginTop: 4, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
      {sub && <div className="muted" style={{ fontSize: 11.5, marginTop: 2, overflowWrap: 'anywhere' }}>{sub}</div>}
    </div>
  );
}
/** 합계 칸 — 일부 법인이 모름이면 '*'(부분 합). */
const totText = (t, k) => (t ? `${numText(t[k])}${t.partial?.[k] ? '*' : ''}` : '—');

function ResultBar({ c }) {
  const b = resultBar(c);
  if (!b) return <span className="muted" style={{ fontSize: 12 }}>{c?.jobs > 0 ? '모름' : '잡 없음'}</span>;
  return (
    <div role="img" aria-label={`성공 ${c.ok} · 경고 ${c.warn} · 실패 ${c.fail} · 진행 ${c.run} / 잡 ${c.jobs}`} style={{ display: 'flex', height: 7, width: 150, borderRadius: 4, overflow: 'hidden', background: 'var(--panel-deep)' }}>
      <div style={{ width: `${b.ok}%`, background: '#22c55e' }} /><div style={{ width: `${b.warn}%`, background: '#f59e0b' }} />
      <div style={{ width: `${b.fail}%`, background: '#ef4444' }} /><div style={{ width: `${b.run}%`, background: '#3b82f6' }} />
    </div>
  );
}

/** v2.839 '정책 · 일정' 탭(#/tools/bareos-summary/policy) — 같은 조회 전용 키(bareos-summary) 아래 하위 탭. 통합 현황(overview)은 아래 화면 그대로. */
export default function BareosSummaryTool() {
  const [tab] = useHashTab({ base: ['tools', 'bareos-summary'], valid: ['overview', 'policy'], fallback: 'overview' });
  return tab === 'policy' ? <BareosPolicyTab /> : <BareosSummaryView />;
}

function BareosSummaryView() {
  const [tick, setTick] = useState(0);
  const [rpoDays, setRpoDays] = useState(loadRpo);
  const [q, setQ] = useState('');
  const [chip, setChip] = useState('all');
  const [pKind, setPKind] = useState('all');
  const [pAll, setPAll] = useState(false);
  const [csvErr, setCsvErr] = useState(null);
  // 공용 usePolling(60초 · 403 이면 멈춤 · 늦은 응답 버림 — WEB2613-09 '도구 화면의 수제 setInterval 금지'). 새로고침(_r)은 데이터를 비우므로
  //   직전 응답을 들고 있는다(BareosBackupTool 과 같은 이유 — 비면 필터·찾기가 다시 마운트돼 사라진다). 기준 일수를 바꾸면 새 값이 올 때까지 이전 값.
  const { data: polled, error, loading } = usePolling('/tools/bareos-summary', { rpoDays, _r: tick }, 60_000);
  const lastRef = useRef(null);
  if (polled) lastRef.current = polled;
  const data = polled || lastRef.current;
  const load = () => setTick((t) => t + 1);
  const changeRpo = (v) => { setRpoDays(v); try { localStorage.setItem(RPO_KEY, String(v)); } catch { /* 이 브라우저에만 — 못 쓰면 기본 1일 */ } };
  const csv = async () => {
    setCsvErr(null);
    try { await downloadFile(`/tools/bareos-summary.csv?rpoDays=${rpoDays}`); } catch (e) { setCsvErr(e); }
  };
  const gotoRow = useCallback((id) => {
    const find = () => Array.from(document.querySelectorAll('[data-bareos-row]')).find((el) => el.getAttribute('data-bareos-row') === id);
    const flash = (el) => { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.remove('qn-flash'); void el.offsetWidth; el.classList.add('qn-flash'); setTimeout(() => el.classList.remove('qn-flash'), 3200); };
    const el = find();
    if (el) { flash(el); return; }
    setChip('all'); setQ('');
    setTimeout(() => { const e2 = find(); if (e2) flash(e2); }, 80);
  }, []);

  const head = (
    <>
      <VeeamHeader active="bareos" desc="전 법인(vCenter)의 Bareos 백업을 한 표로 봅니다 — 포탈이 마지막으로 받아 둔 값이라 Director 에 접속하지 않습니다."
        actions={<>
          {data && <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>기준 {shortTs(data.at)}{error ? ' · 최근 새로고침 실패 — 이전 값' : ''}</span>}
          <label className="flex" style={{ gap: 6, alignItems: 'center', fontSize: 12, whiteSpace: 'nowrap' }}>
            <span className="muted">오래된 백업 기준</span>
            <Select className="input" sort={false} value={rpoDays} onChange={(e) => changeRpo(Number(e.target.value))} style={{ fontSize: 12, padding: '3px 6px', minWidth: 0, width: 'auto' }}>
              {BAREOS_RPO_DAYS.map((d) => <option key={d} value={d}>{d}일 초과</option>)}
            </Select>
          </label>
          {canCsv() && <button type="button" className="tab" onClick={csv} style={{ padding: '6px 14px' }}>CSV</button>}
          <button type="button" className="tab" disabled={loading} onClick={load} style={{ padding: '6px 14px' }}>{loading ? '읽는 중…' : '새로고침'}</button>
        </>} />
      <BareosTabs active="summary" />
    </>
  );
  const WRAP = { display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 };
  if (!data && error) return <div style={WRAP}>{head}<ErrorBox error={error} /></div>;
  if (!data) return <div style={WRAP}>{head}<Loading /></div>;

  const rows = Array.isArray(data.rows) ? data.rows : [];
  const t = data.totals || {};
  const ds = data.directorStates || {};
  const attn = (r) => r.director.state === 'auth' || r.director.state === 'error' || r.director.state === 'unset' || (r.counts.fail || 0) > 0 || (r.counts.missing || 0) > 0 || (r.counts.old || 0) > 0;
  const chips = [['all', `전체 ${rows.length}`], ['attn', `주의 ${rows.filter(attn).length}`], ['jobs', `잡 있는 법인 ${rows.filter((r) => (r.counts.jobs || 0) > 0).length}`]];
  const needle = q.trim().toLowerCase();
  const shown = rows.filter((r) => (chip === 'attn' ? attn(r) : chip === 'jobs' ? (r.counts.jobs || 0) > 0 : true) && (!needle || r.name.toLowerCase().includes(needle)));
  const prio = Array.isArray(data.priority) ? data.priority : [];
  const pShown = prio.filter((x) => pKind === 'all' || x.kind === pKind);
  const anyPartial = Object.keys(t.partial || {}).some((k) => ['ok', 'warn', 'fail', 'run', 'old', 'never', 'bareosMethod', 'missing', 'mismatch'].includes(k));

  return (
    <div data-bareos-summary="" style={WRAP}>
      {head}
      {data.demo && <div className="banner warn">데모 Director 입니다 — 실제 Bareos 에 접속하지 않은 합성 결과입니다(백업 방식 표시는 실제 파일).</div>}
      {data.marksUnreadable && <div className="banner bad">백업 표시 파일(backup-marks.json)을 읽지 못해 Bareos 방식 VM·미등록·방식 불일치 수를 모릅니다(—).</div>}
      {data.registryUnreadable && <div className="banner bad">Bareos 백업 대상 원장(bareos-jobs.json)을 읽지 못해 잡·결과 수를 모릅니다(—) — 손상본은 설정 폴더에 보존돼 있습니다.</div>}
      {csvErr && <div className="banner bad">CSV 내보내기 실패 — {csvErr?.status === 403 ? 'CSV 권한이 없습니다.' : String(csvErr.message || csvErr)}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(138px, 1fr))', gap: 10 }}>
        <Kpi label="법인 · Director" value={`${numText(rows.length)}`} sub={['ok', 'relay', 'pending', 'error', 'auth', 'unset'].filter((k) => ds[k]).map((k) => `${directorStateOf(k).text} ${ds[k]}`).join(' · ') || '—'} />
        <Kpi label="Bareos 방식 VM" value={totText(t, 'bareosMethod')} color={TONE.bareos} border="#6b3d17" sub={t.vm ? `전체 VM ${numText(t.vm)}(템플릿·vCLS 제외)` : undefined} />
        <Kpi label="잡 등록" value={totText(t, 'jobs')} sub={`켜짐 ${totText(t, 'on')} · 꺼짐 ${totText(t, 'off')}${t.gone ? ` · VM 없음 ${t.gone}` : ''}`} />
        <Kpi label="미등록 · 방식 불일치" value={`${totText(t, 'missing')} · ${totText(t, 'mismatch')}`} color={TONE.warn} border="#5c4513" sub="방식은 Bareos · 잡 없음 / 잡은 있는데 방식이 다름" />
        <Kpi label="마지막 결과" value={`${totText(t, 'ok')} · ${totText(t, 'warn')} · ${totText(t, 'fail')}`} sub={`성공 · 경고 · 실패${t.unknown ? ` · 모름 ${numText(t.unknown)}` : ''}`} />
        <Kpi label="지금 백업 중" value={totText(t, 'run')} color={TONE.run} border="#1e3a5f" />
        <Kpi label={`오래된 백업(${data.rpoDays}일 초과)`} value={totText(t, 'old')} color="#fb923c" border="#5c3413" sub={`백업 없음 ${totText(t, 'never')}`} />
      </div>
      {anyPartial && <div className="muted" style={{ fontSize: 12 }}>* 일부 법인을 모름(Director 인증 정지·조회 실패·미설정 또는 파일 손상) — 아는 법인만 더한 부분 합입니다.</div>}

      {rows.length > 0 && (
        <div className="vc-quicknav" data-bareos-quicknav="" style={{ marginBottom: 0 }}>
          <span className="qn-label">바로가기</span>
          {rows.filter((r) => !needle || r.name.toLowerCase().includes(needle)).map((r) => (
            <button key={r.id} type="button" className="qn-btn" title={`${r.name} — Director ${directorStateOf(r.director.state).text} · 표의 그 줄로`} onClick={() => gotoRow(r.id)}>
              <span className="qn-dot" style={{ background: directorStateOf(r.director.state).color }} />{r.name}
            </button>
          ))}
          <SearchBox className="input" style={{ marginLeft: 'auto', maxWidth: 240, minWidth: 170 }} value={q} onChange={setQ} placeholder="법인 이름 찾기" />
        </div>
      )}

      <div className="card" data-bareos-sites="" style={{ minWidth: 0, padding: '12px 0 4px' }}>
        <div className="flex gap wrap" style={{ alignItems: 'center', padding: '0 14px 10px', rowGap: 6 }}>
          <div style={{ minWidth: 0 }}>
            <b style={{ fontSize: 15 }}>법인별 현황</b>
            <div className="muted" style={{ fontSize: 12 }}>법인 이름을 누르면 법인별 현황 · 막대 = 잡의 마지막 결과(성공 · 경고 · 실패 · 진행) · 결과를 모르는 법인은 — · 제목을 누르면 정렬</div>
          </div>
          <div className="flex gap wrap" role="group" aria-label="보기" style={{ marginLeft: 'auto', rowGap: 6 }}>
            {chips.map(([k, label]) => <button key={k} type="button" className={`tab${chip === k ? ' active' : ''}`} aria-pressed={chip === k} onClick={() => setChip(k)} style={{ padding: '4px 12px', fontSize: 12 }}>{label}</button>)}
          </div>
        </div>
        <STable minWidth={1060} style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', fontSize: 12 }}>
              <th style={{ padding: '6px 14px' }}>법인</th>
              <th style={{ padding: '6px 6px' }}>Director</th>
              <th style={{ padding: '6px 6px', textAlign: 'right' }} title="백업 방식을 Bareos 로 정한 VM">Bareos 방식</th>
              <th data-nosort="" style={{ padding: '6px 10px' }}>마지막 결과</th>
              <th style={{ padding: '6px 6px', textAlign: 'right' }}>잡</th>
              <th style={{ padding: '6px 6px', textAlign: 'right' }}>성공</th>
              <th style={{ padding: '6px 6px', textAlign: 'right' }}>경고·실패</th>
              <th style={{ padding: '6px 6px', textAlign: 'right' }}>진행</th>
              <th style={{ padding: '6px 6px', textAlign: 'right' }} title="백업 방식은 Bareos 인데 잡이 없는 VM">미등록</th>
              <th style={{ padding: '6px 6px', textAlign: 'right' }}>{data.rpoDays}일+ 경과</th>
              <th style={{ padding: '6px 6px', textAlign: 'right' }} title="Bareos 관련 VM 디스크 사용(vCenter 인벤토리)">용량</th>
              <th style={{ padding: '6px 6px' }}>마지막 백업</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const c = r.counts; const st = directorStateOf(r.director.state);
              return (
                <tr key={r.id} data-bareos-row={r.id} className="qn-anchor" style={{ borderTop: '1px solid var(--border-soft)', background: r.director.state === 'auth' ? 'rgba(239,68,68,.05)' : undefined }}>
                  <td data-sort={r.name} style={{ padding: '6px 6px 6px 10px' }}>
                    {/* 법인 이름을 누르면 법인별 현황(1440 폭에서 '열기' 열이 잘려 이름을 버튼으로 — Chromium 판독) */}
                    <button type="button" onClick={() => openBareosDetail(r.id)} title="법인별 현황으로" style={{ background: 'none', border: 0, padding: '2px 4px', color: 'var(--text)', font: 'inherit', cursor: 'pointer', textAlign: 'left', whiteSpace: 'nowrap' }}>
                      <b style={{ textDecoration: 'underline', textDecorationColor: 'var(--border)', textUnderlineOffset: 3 }}>{r.name}</b> <span className="muted" style={{ fontSize: 12 }}>{numText(r.vm)} VM</span>
                    </button>
                  </td>
                  <td data-sort={st.text} style={{ padding: '8px 6px', fontSize: 12 }}>
                    <span className="flex" style={{ gap: 6, alignItems: 'center', whiteSpace: 'nowrap' }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: st.color, flex: 'none' }} aria-hidden="true" />{st.text}</span>
                    {r.director.name && <span className="muted" style={{ fontSize: 11.5 }}>{r.director.name} · {r.director.via === 'edge' ? '엣지 대행' : '중앙 직접'}</span>}
                  </td>
                  <td style={{ padding: '8px 6px', textAlign: 'right', color: TONE.bareos, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{numText(c.bareosMethod)}</td>
                  <td style={{ padding: '8px 10px' }}><ResultBar c={c} /></td>
                  <td style={{ padding: '8px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{numText(c.jobs)}</td>
                  <td style={{ padding: '8px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: c.ok ? TONE.ok : undefined }}>{numText(c.ok)}</td>
                  <td data-sort={c.warn == null ? '' : (c.warn || 0) + (c.fail || 0)} style={{ padding: '8px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                    {c.warn == null ? '—' : <><span style={{ color: c.warn ? TONE.warn : undefined }}>{c.warn}</span> · <span style={{ color: c.fail ? TONE.bad : undefined }}>{c.fail}</span></>}
                  </td>
                  <td style={{ padding: '8px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: c.run ? TONE.run : undefined }}>{numText(c.run)}</td>
                  <td style={{ padding: '8px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: c.missing ? TONE.warn : undefined }}>{numText(c.missing)}</td>
                  <td style={{ padding: '8px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: c.old ? '#fb923c' : undefined }}>{numText(c.old)}</td>
                  <td data-sort={c.gb} style={{ padding: '8px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{c.rows ? fmtGb(c.gb) : '—'}</td>
                  <td data-sort={r.lastAt || ''} style={{ padding: '8px 14px 8px 6px', fontFamily: 'var(--mono)', fontSize: 12, whiteSpace: 'nowrap' }}>{shortTs(r.lastAt)}</td>
                </tr>
              );
            })}
            {!shown.length && <tr><td colSpan={12} className="muted" style={{ padding: 16 }}>{rows.length ? '조건에 맞는 법인이 없습니다.' : '볼 수 있는 vCenter 가 없습니다.'}</td></tr>}
          </tbody>
        </STable>
      </div>

      <div className="card" data-bareos-priority="" style={{ minWidth: 0, padding: '12px 0 4px' }}>
        <div className="flex gap wrap" style={{ alignItems: 'center', padding: '0 14px 10px', rowGap: 6 }}>
          <div style={{ minWidth: 0 }}>
            <b style={{ fontSize: 15 }}>우선 확인</b>
            <div className="muted" style={{ fontSize: 12 }}>중요도 상 먼저 · 실패 → 미등록 → 오래된 백업 → 백업 없음 · 결과를 모르는 법인은 실패·오래됨 판정에서 뺐습니다{data.priorityTotal > prio.length ? ` · 상한으로 ${data.priorityTotal - prio.length}건 생략(CSV·법인별 화면에서 보세요)` : ''}</div>
          </div>
          <div className="flex gap wrap" role="group" aria-label="종류" style={{ marginLeft: 'auto', rowGap: 6 }}>
            {[['all', `전체 ${data.priorityTotal || 0}`], ...Object.keys(PRIORITY_TEXT).map((k) => [k, `${PRIORITY_TEXT[k]} ${data.priorityByKind?.[k] || 0}`])].map(([k, label]) => (
              <button key={k} type="button" className={`tab${pKind === k ? ' active' : ''}`} aria-pressed={pKind === k} onClick={() => setPKind(k)} style={{ padding: '4px 12px', fontSize: 12 }}>{label}</button>
            ))}
          </div>
        </div>
        <STable minWidth={860} limit={pAll ? 0 : 20} style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', fontSize: 12 }}>
              <th style={{ padding: '6px 14px' }}>VM</th>
              <th style={{ padding: '6px 6px' }}>법인 · 폴더</th>
              <th style={{ padding: '6px 6px' }}>왜</th>
              <th style={{ padding: '6px 6px' }}>중요도</th>
              <th style={{ padding: '6px 6px' }}>마지막 백업</th>
              <th data-nosort="" style={{ padding: '6px 14px 6px 6px' }}><span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>열기</span></th>
            </tr>
          </thead>
          <tbody>
            {pShown.map((x) => (
              <tr key={`${x.vcenterId}|${x.id}`} style={{ borderTop: '1px solid var(--border-soft)' }}>
                <td data-sort={x.name} style={{ padding: '7px 14px', fontWeight: 600, overflowWrap: 'anywhere' }}>{x.name}</td>
                <td style={{ padding: '7px 6px', fontSize: 12, overflowWrap: 'anywhere' }}>{x.vcName} · <span className="muted">{x.folder || '—'}</span></td>
                <td data-sort={PRIORITY_TEXT[x.kind]} style={{ padding: '7px 6px' }}>
                  <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap', ...(TAG[PRIORITY_TONE[x.kind]] || TAG.muted) }}>{PRIORITY_TEXT[x.kind] || x.kind}</span>
                  {x.kind === 'fail' && x.st && <span className="muted" style={{ fontSize: 12, marginLeft: 6 }}>{stText(x.st)} {shortTs(x.at)}</span>}
                </td>
                <td data-sort={x.crit === 'high' ? 3 : x.crit === 'mid' ? 2 : x.crit === 'low' ? 1 : ''} style={{ padding: '7px 6px' }}>{x.crit ? <CritIcon crit={x.crit} withText /> : <span className="muted">—</span>}</td>
                <td data-sort={x.ok || ''} style={{ padding: '7px 6px', fontFamily: 'var(--mono)', fontSize: 12, whiteSpace: 'nowrap' }}>{shortTs(x.ok)}</td>
                <td style={{ padding: '7px 14px 7px 6px' }}><button type="button" className="tab" onClick={() => openBareosDetail(x.vcenterId)} style={{ padding: '3px 10px', fontSize: 12 }}>법인별 →</button></td>
              </tr>
            ))}
            {!pShown.length && <tr><td colSpan={6} className="muted" style={{ padding: 16 }}>확인할 VM 이 없습니다.</td></tr>}
          </tbody>
        </STable>
        {pShown.length > 20 && <div style={{ padding: '6px 14px 10px' }}><button type="button" className="tab" onClick={() => setPAll((v) => !v)} style={{ padding: '4px 12px', fontSize: 12 }}>{pAll ? '20건만 보기' : `전부 보기(${pShown.length}건)`}</button></div>}
      </div>
      <div className="muted" style={{ fontSize: 12 }}>숫자는 Bareos 원장(포탈이 등록한 백업 대상)과 Backup › Detail 에서 사람이 정한 백업 방식을 합친 것입니다. 포탈이 등록하지 않은 Bareos 잡은 세지 않습니다.</div>
    </div>
  );
}
