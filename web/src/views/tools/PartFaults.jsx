/**
 * 파트 장애(물리 부품 장애) — 서버·스토리지·SAN 스위치의 PSU·디스크·메모리·팬·컨트롤러·포트 등
 * **부품 단위** 장애를 기록하고 알리는 화면(v2.548).
 *
 * 사용자 요청(2026-09-17): "서버 스토리지 등의 모든 장비에 있는 물리 파트 장애가 발생하면
 * 노티를 발생하고 체계적으로 파트 장애를 기록하는 DB 와 화면을 만들고 싶어" +
 * "엣지에서 수집해서 로컬에서 처리하고 장애만 중앙으로 보내게 해줘" → v2.548 재설계.
 *
 * 화면 설계 의도:
 *  1. **맨 위는 '이 목록을 믿어도 되는가'** 다 — 점검이 돌았는지, 못 본 장비가 몇 대인지, 엣지가
 *     구버전인지·보고가 없는지·오래됐는지. 빈 목록을 '정상' 으로 읽게 두는 것이 이 기능이 만들 수
 *     있는 가장 위험한 거짓이다(v2.519 월간 점검과 같은 판단).
 *  2. 엣지 노드에서는 **push 상태**가 주인공이다(토큰 없음 / 꺼짐 / 403 / 413 / 첫 push 대기 — 조치가 다르다).
 *  3. 열린 장애 표와 **전이 이력**(열림/변화/해소)을 나눠 둔다.
 *  4. 판정·문구는 `partFaultText.js`(순수, vitest 고정)가 소유한다. 이 파일은 조립만 한다.
 *
 * ⚠ 폴링하지 않는다 — 점검 자체가 주기적이고 이 화면은 그 결과(DB)를 읽을 뿐이다. 마운트 1회 + 버튼.
 *
 * v2.734 — 탭 넷: 열린 장애 · **장애별**(장애 1건 = 1행, 열림→해소를 한 행으로) · **종류별**(디스크·CPU·메모리·NIC·GPU …
 * 종류마다 발생·진행 중·영향 장비·평균 지속) · 이력(전이 사건 순). 묶기·집계는 서버(`partfault/incidents.js`),
 * 문구는 `partFaultText.js` 가 소유한다. 종류 칩을 누르면 장애별 목록이 그 종류로 좁혀진다.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { fetchJson, postJson, putJson } from '../../api.js';
import { useHashTab } from '../../hooks/useHashTab.js'; // v2.613 CATALOG2613-06: 서브탭을 URL 에 싣는다
import { Loading, ErrorBox, SearchBox, Kpi, DataTable } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import {
  emptyDiag, scanNote, edgeScanTotals, edgeNote, keyKindNote, deviceKeyNote, keyKindMark, deviceKeyMark, tableFootnotes, holdText, holdNote, eventText,
  notifyNote, lastRunText, ageText, intervalText, toneVar, resetNote, pushNote,
  historyEmptyText, kpiValue, kpiAccent,
  EDGE_KIND_LABEL, EDGE_KIND_TONE,
  retentionText,
  INCIDENT_PERIODS, periodLabel, durationText, incidentStateText, incidentStartText, incidentEndText, incidentStateRank,
  incidentSummaryText, incidentScanNote, KINDS_NOTE, kindChips, openKindCounts, filterIncidents, incidentRespFor,
  shortStamp, fullStamp,
} from './partFaultText.js';
import Select from '../../components/Select.jsx';

const stateColor = toneVar;

export function PartFaults() {
  // ⚠ 훅은 전부 조기 return 위에(루트 CLAUDE.md — 조기 반환 뒤 훅 추가는 React #310 크래시).
  const [data, setData] = useState(null);
  const [events, setEvents] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [q, setQ] = useState('');
  // v2.613(CATALOG2613-06): 열린 장애/이력 탭을 해시(#/tools/part-faults/<tab>)에 싣는다(v2.438 규약).
  const [tab, setTab] = useHashTab({ base: ['tools', 'part-faults'], valid: ['open', 'incidents', 'kinds', 'events'], fallback: 'open' });
  const [days, setDays] = useState(30);
  // v2.734 장애별·종류별 — 고른 종류(''=전체)·응답(요청 키와 함께)·펼친 장애·반복 부품만
  const [kindSel, setKindSel] = useState('');
  const [inc, setInc] = useState(null);
  const [incOpen, setIncOpen] = useState(null);
  const [repeatOnly, setRepeatOnly] = useState(false);
  const [incQ, setIncQ] = useState('');
  const [showEdges, setShowEdges] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = React.useCallback(() => {
    setLoading(true);
    return fetchJson('/tools/part-faults')
      .then((d) => { setData(d); setError(''); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (tab !== 'events') return undefined;
    // v2.605(감사 WEB2605-08): 기간을 빠르게 바꾸면 늦게 온 이전 기간 응답이 새 기간 선택을 덮었다 — 이 효과가 정리되면 버린다.
    let active = true;
    fetchJson('/tools/part-faults/events', { days })
      .then((r) => { if (active) setEvents(r); })
      .catch((e) => { if (active) setEvents({ error: e.message }); });
    return () => { active = false; };
  }, [tab, days]);

  // v2.734: 장애별·종류별 — 종류 필터는 서버가 목록에만 건다(종류별 집계는 언제나 기간 전체). 늦게 온 이전 선택 응답은 그리지 않는다.
  const incKind = tab === 'incidents' ? kindSel : '';
  useEffect(() => {
    if (tab !== 'incidents' && tab !== 'kinds') return undefined;
    let active = true;
    setIncOpen(null);
    fetchJson('/tools/part-faults/incidents', { days, ...(incKind ? { kind: incKind } : {}) })
      .then((r) => { if (active) setInc(r); })
      .catch((e) => { if (active) setInc({ error: e.message, days, kind: incKind }); });
    return () => { active = false; };
  }, [tab, days, incKind]);
  const incResp = incidentRespFor(inc, { days, kind: incKind });

  // v2.734: 매 렌더 새 객체가 되지 않게 묶는다(아래 useMemo 들의 의존성 — 칩·필터가 렌더마다 다시 계산되지 않게).
  const labels = useMemo(() => data?.labels || {}, [data]);
  const open = useMemo(() => data?.open || [], [data]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const terms = needle ? needle.split(/\s+/) : [];
    return open.filter((p) => {
      if (kindSel && (p.kind || 'other') !== kindSel) return false;
      if (!terms.length) return true;
      const hay = `${p.deviceName} ${p.deviceId} ${p.deviceKey} ${p.label} ${p.detail} ${p.rawState} ${p.agent}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [open, q, kindSel]);
  const openChips = useMemo(() => kindChips(openKindCounts(open), labels), [open, labels]);
  const incRows = useMemo(() => filterIncidents(incResp?.incidents, incQ, { repeatOnly }), [incResp, incQ, repeatOnly]);
  const incChips = useMemo(() => kindChips(incResp?.kinds || [], incResp?.labels || labels), [incResp, labels]);
  // 표 아래 각주 — 표시된 행에 해당하는 식별 안내만 1회씩(행마다 반복하면 400px 에서 셀이 세로로 길어진다)
  const footnotes = useMemo(() => tableFootnotes(rows, labels), [rows, labels]);

  const isEdge = data?.role === 'edge';
  const diag = useMemo(() => emptyDiag({ open, poller: data?.poller, db: data?.db, edges: data?.edges, role: data?.role }), [open, data]);
  const sn = useMemo(() => scanNote(isEdge ? data?.push?.last?.scanned : data?.poller?.last?.local), [data, isEdge]);
  // v2.548 H2 — 엣지가 보고한 unknown/absent 를 KPI 에 더한다(신선한 보고만 · 요약 없는 엣지는 개수로 밝힌다)
  const et = useMemo(() => edgeScanTotals(isEdge ? [] : data?.poller?.last?.edgeAgents), [data, isEdge]);
  const kpiCount = (k) => ((sn || et.agents) ? (sn ? sn[k] : 0) + et[k] : '—');
  const kpiMeta = (base) => `${base}${et.agents ? ` · 엣지 ${et.agents}곳 포함` : ''}${et.noSummary ? ` · 요약 없는 엣지 ${et.noSummary}곳` : ''}${et.skipped ? ` · 오래됨/구버전 ${et.skipped}곳 제외` : ''}`;
  const en = useMemo(() => (isEdge ? null : edgeNote(data?.edges)), [data, isEdge]);
  const pn = useMemo(() => (isEdge ? pushNote(data?.push) : null), [data, isEdge]);
  const rn = resetNote(data?.reset);

  async function runScan() {
    setBusy(true); setMsg('');
    try {
      const r = await postJson('/tools/part-faults/scan', {});
      if (r.ok && r.stats) setMsg(`점검 완료 — 신규 ${r.stats.opened ?? 0} · 해소 ${r.stats.closed ?? 0} · 변화 ${r.stats.changed ?? 0}`);
      else if (r.ok) setMsg(`push 완료 — 장비 ${r.devices ?? 0}대 · 열린 장애 ${r.open ?? 0}건${r.omitted ? ` · 상한으로 ${r.omitted}대 제외` : ''}`);
      else setMsg(`실행하지 못했습니다 — ${r.reason || '알 수 없는 사유'}`);
      await load();
    } catch (e) { setMsg(`실행 실패 — ${e.message}`); }
    finally { setBusy(false); }
  }

  /** 관리자 수동 닫기(v2.548 C5). 사유는 감사 로그·이벤트(close/manual)에 남는다. */
  async function closeRow(p) {
    const reason = window.prompt(`'${p.deviceName} · ${p.label}' 을(를) 수동으로 닫습니다 — 장비가 고쳐졌다는 뜻이 아니라 "다시 관측되지 않을" 장애를 정리하는 것입니다. 사유(재배정·등록 삭제 등)를 적어 주세요.`, '');
    if (reason == null) return;
    setBusy(true); setMsg('');
    try {
      const r = await postJson('/tools/part-faults/close', { agent: p.agent || '', partKey: p.partKey, reason });
      setMsg(r.ok ? '수동으로 닫았습니다 — 이력에 close/manual 로 남습니다.' : `닫지 못했습니다 — ${r.reason || ''}`);
      await load();
    } catch (e) { setMsg(`닫기 실패 — ${e.message}`); }
    finally { setBusy(false); }
  }

  // v2.613 PERSIST2613-06: 이력 보존일(30~3650, 빈 칸 = 유지). env PARTFAULT_RETENTION_DAYS 가 있으면 서버가 그것을 쓴다(0 = 전부 보관).
  const [retentionInput, setRetentionInput] = useState('');
  async function saveRetention() {
    const v = retentionInput.trim();
    if (v === '') { setMsg('보존일이 비어 있습니다 — 값을 넣어야 저장됩니다(빈 칸은 유지).'); return; }
    setSaving(true); setMsg('');
    try {
      const r = await putJson('/tools/part-faults/settings', { retentionDays: Number(v) });
      setMsg(r.ok ? `보존일 저장 — ${r.settings?.retentionDays ?? v}일(다음 정리 주기부터 적용)` : `저장 실패 — ${r.reason || ''}`);
      setRetentionInput('');
      await load();
    } catch (e) { setMsg(`저장 실패 — ${e.message}`); }
    finally { setSaving(false); }
  }

  async function toggleEnabled(next) {
    setSaving(true); setMsg('');
    try {
      const r = await putJson('/tools/part-faults/settings', { enabled: next });
      setMsg(r.ok ? `스위치 저장 — 중앙 ${r.effective?.enabled ? '켜짐' : '꺼짐'}(${r.effective?.source}). 엣지는 다음 설정 pull 뒤에 적용됩니다.` : `저장 실패 — ${r.reason || ''}`);
      await load();
    } catch (e) { setMsg(`저장 실패 — ${e.message}`); }
    finally { setSaving(false); }
  }

  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox message={error} />;

  const poller = data?.poller;
  const db = data?.db;
  const settings = data?.settings;   // admin 에게만 온다

  return (
    <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
      {error && <div className="banner warn">갱신 실패 — {error}</div>}

      {/* ① 이 목록을 믿어도 되는가 — 가장 위. */}
      <div className="card" style={{ padding: 12, borderLeft: `3px solid ${stateColor(isEdge ? (pn?.tone || 'muted') : diag.tone)}` }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
          <b>파트 장애 {isEdge ? '— 이 노드는 엣지(판정 후 중앙으로 push)' : '점검'}</b>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {!isEdge && <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>{lastRunText(poller)}</span>}
            {settings && !isEdge && (
              <label style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' }} title="켜면 중앙 점검이 다음 주기부터 돕니다. 엣지는 설정 pull 뒤에 따라옵니다.">
                <input type="checkbox" checked={!!settings.enabled} disabled={saving} onChange={(e) => toggleEnabled(e.target.checked)} /> 기능 켜기
              </label>
            )}
            <button className="btn" onClick={runScan} disabled={busy}>{busy ? '실행 중…' : (isEdge ? '지금 push' : '지금 점검')}</button>
          </div>
        </div>
        {isEdge && pn?.text && <div style={{ marginTop: 8, color: stateColor(pn.tone) }}><BoldText text={pn.text} /></div>}
        {!isEdge && diag.text && <div style={{ marginTop: 8, color: stateColor(diag.tone) }}><BoldText text={diag.text} /></div>}
        {sn && <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-faint)' }}><BoldText text={sn.text} /></div>}
        {en && (
          <div style={{ marginTop: 4, fontSize: 12, color: stateColor(en.tone) }}>
            <BoldText text={en.text} />
            {en.total > 0 && (
              <button className="btn" style={{ marginLeft: 8, padding: '0 6px', fontSize: 11 }} onClick={() => setShowEdges((v) => !v)}>
                {showEdges ? '엣지 표 접기' : '엣지별 보기'}
              </button>
            )}
          </div>
        )}
        {holdNote(open) && <div style={{ marginTop: 4, fontSize: 12, color: 'var(--amber)' }}><BoldText text={holdNote(open)} /></div>}
        {rn && <div style={{ marginTop: 4, fontSize: 12, color: 'var(--amber)' }}><BoldText text={rn} /></div>}
        {notifyNote(poller?.last) && <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text-faint)' }}><BoldText text={notifyNote(poller.last)} /></div>}
        {poller && !isEdge && (
          <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text-faint)' }}>
            자동 점검 {poller.enabled ? `켜짐(${poller.source}) · 주기 ${intervalText(poller.intervalMs)}` : `꺼짐(${poller.source})`}
            {' · 탐지 지연 상한은 iDRAC 인벤토리 주기(갱신 직후 즉시 판정)'}
            {db && db.available === false ? ' · DB 사용 불가' : retentionText(db)}
          </div>
        )}
        {settings && !isEdge && db && db.available !== false && (
          <div style={{ marginTop: 4, fontSize: 12, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <label htmlFor="pf-retention" style={{ color: 'var(--text-faint)' }}>이력 보존일(30~3650)</label>
            <input id="pf-retention" type="number" min={30} max={3650} value={retentionInput} placeholder={String(settings.retentionDays ?? '')}
              disabled={saving || db.retentionSource === 'env'} onChange={(e) => setRetentionInput(e.target.value)} style={{ width: 90, minWidth: 0 }} />
            <button className="btn" style={{ padding: '0 8px', fontSize: 11 }} disabled={saving || db.retentionSource === 'env' || retentionInput.trim() === ''} onClick={saveRetention}>저장</button>
            {db.retentionSource === 'env' && <span style={{ color: 'var(--text-faint)' }}>env PARTFAULT_RETENTION_DAYS 가 우선이라 화면에서 바꿀 수 없습니다.</span>}
          </div>
        )}
        {isEdge && data?.push && (
          <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text-faint)' }}>
            push 주기 {intervalText(data.push.intervalMs)} · 인벤토리 갱신 직후 즉시 push · 이 엣지 v{data.push.version} · agent {data.push.agent}
          </div>
        )}
        {msg && <div style={{ marginTop: 6 }}><BoldText text={msg} /></div>}
      </div>

      {/* 엣지별 표(중앙) — 구버전/무보고/오래됨을 이름 단위로. */}
      {!isEdge && showEdges && data?.edges?.rows?.length > 0 && (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <STable>
            <thead><tr><th>엣지</th><th>상태</th><th>버전</th><th>마지막 보고</th><th>장비(실패)</th><th>열린 장애</th><th>버린 장비</th></tr></thead>
            <tbody>
              {data.edges.rows.map((r) => (
                <tr key={r.agent}>
                  <td style={{ whiteSpace: 'nowrap' }}>{r.agent}{r.unregistered ? <span style={{ color: 'var(--amber)', marginLeft: 6 }}>(등록부에 없음)</span> : ''}{r.enabled === false ? <span style={{ color: 'var(--text-faint)', marginLeft: 6 }}>(비활성)</span> : ''}</td>
                  <td><span style={{ color: stateColor(EDGE_KIND_TONE[r.kind]), fontWeight: 600, whiteSpace: 'nowrap' }}>{EDGE_KIND_LABEL[r.kind] || r.kind}</span></td>
                  <td data-sort={r.version || ''} style={{ whiteSpace: 'nowrap' }}>{r.version ? `v${r.version}` : '—'}{r.protocol ? ` · p${r.protocol}` : ''}</td>
                  <td data-sort={r.at || 0} style={{ whiteSpace: 'nowrap' }}>{r.at ? ageText(r.ageMs) : '—'}</td>
                  <td data-sort={r.devices ?? ''}>{r.devices == null ? '—' : `${r.devices}${r.devicesFailed ? ` (${r.devicesFailed})` : ''}`}</td>
                  <td data-sort={r.open ?? ''}>{r.open == null ? '—' : r.open}</td>
                  <td data-sort={(r.rejected || 0) + (r.partsOmitted || 0)} style={{ color: (r.rejected || r.partsOmitted) ? 'var(--amber)' : undefined, whiteSpace: 'nowrap' }}>{r.rejected || 0}{r.partsOmitted ? ` · 파트 ${r.partsOmitted} 잘림` : ''}</td>
                </tr>
              ))}
            </tbody>
          </STable>
        </div>
      )}

      {/* ② 수치 — unknown/absent 를 정상에도 장애에도 넣지 않는다(각각 표시). */}
      {!isEdge && (
        <div className="kpis">
          {/* v2.598 WEBUI-2598-06: 0 은 경고색으로 칠하지 않고, 요약이 없으면 0 이 아니라 '—' 다. */}
          <Kpi label="이상 부품" value={kpiValue(data?.summary, 'fault')} accent={kpiAccent(kpiValue(data?.summary, 'fault'), 'var(--red)')} meta="즉시 조치" />
          <Kpi label="주의 부품" value={kpiValue(data?.summary, 'warn')} accent={kpiAccent(kpiValue(data?.summary, 'warn'), 'var(--amber)')} meta="예고·성능저하 포함" />
          <Kpi label="영향 장비" value={kpiValue(data?.summary, 'devices')} meta="이상·주의가 열려 있는 장비 수" />
          <Kpi label="상태 미확인 부품" value={kpiCount('unknown')} meta={kpiMeta('정상이라는 뜻이 아닙니다')} />
          <Kpi label="빈 슬롯" value={kpiCount('absent')} meta={kpiMeta('고장이 아닙니다')} />
        </div>
      )}

      {!isEdge && (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button className={`btn${tab === 'open' ? ' active' : ''}`} onClick={() => setTab('open')}>열린 장애 {open.length}</button>
            <button className={`btn${tab === 'incidents' ? ' active' : ''}`} onClick={() => setTab('incidents')} title="같은 부품의 발생→해소를 한 행으로 묶어 봅니다">장애별</button>
            <button className={`btn${tab === 'kinds' ? ' active' : ''}`} onClick={() => setTab('kinds')} title="디스크·CPU·메모리·NIC·GPU 등 부품 종류별로 봅니다">종류별</button>
            <button className={`btn${tab === 'events' ? ' active' : ''}`} onClick={() => setTab('events')} title="상태가 바뀐 순간(발생·변화·해소)을 시간 순으로 봅니다">이력</button>
            {tab === 'open' && <SearchBox value={q} onChange={setQ} placeholder="장비·부품·원문 상태·법인 검색" />}
            {tab === 'incidents' && <SearchBox value={incQ} onChange={setIncQ} placeholder="장비·부품·원문 상태·법인 검색" />}
            {tab !== 'open' && (
              <Select sort={false} className="input" value={days} onChange={(e) => setDays(Number(e.target.value))}>
                {INCIDENT_PERIODS.map((d) => <option key={d} value={d}>{periodLabel(d)}</option>)}
              </Select>
            )}
            {tab === 'incidents' && (
              <label style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center', whiteSpace: 'nowrap' }} title="기간 중 같은 부품에서 2번 이상 난 장애만 봅니다(흔들리는 부품 찾기)">
                <input type="checkbox" checked={repeatOnly} onChange={(e) => setRepeatOnly(e.target.checked)} /> 반복 부품만
              </label>
            )}
          </div>

          {/* v2.734 종류 칩 — 열린 장애는 열린 목록 기준, 장애별은 기간 전체 기준(필터와 무관하게 세어 다른 종류로 돌아갈 수 있게). */}
          {(tab === 'open' || tab === 'incidents') && (tab === 'open' ? openChips : incChips).length > 1 && (
            <div className="pf-chips" role="group" aria-label="부품 종류">
              {(tab === 'open' ? openChips : incChips).map((c) => (
                <button key={c.kind || 'all'} type="button" className={`pf-chip${kindSel === c.kind ? ' on' : ''}`} aria-pressed={kindSel === c.kind}
                  onClick={() => setKindSel(c.kind)}>
                  {c.label} <b>{c.n}</b>
                </button>
              ))}
              {kindSel && !(tab === 'open' ? openChips : incChips).some((c) => c.kind === kindSel) && (
                <button type="button" className="pf-chip on" onClick={() => setKindSel('')} title="고른 종류가 이 목록에 없습니다 — 누르면 전체로 돌아갑니다">
                  {labels.kind?.[kindSel] || kindSel} <b>0</b> ✕
                </button>
              )}
            </div>
          )}

          {tab === 'open' && (
            <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
              <STable minWidth={820} wrap={false}>
                <thead><tr>
                  <th>상태</th><th>장비</th><th>부품</th><th>장비 보고 원문</th><th>처음 감지</th><th>최근 확인</th><th>수집</th>
                </tr></thead>
                <tbody>
                  {rows.length === 0 && <tr><td colSpan={7} style={{ padding: 16, color: 'var(--text-faint)' }}>
                    {open.length ? '검색 조건에 맞는 항목이 없습니다.' : '열린 장애가 없습니다 — 위 안내를 함께 읽어 주세요.'}
                  </td></tr>}
                  {rows.map((p) => {
                    const kk = keyKindNote(p.keyKind, labels.keyKindNote);
                    const dk = deviceKeyNote(p.deviceKeyKind, labels.deviceKeyKindNote);
                    const hold = holdText(p.holdReason);
                    return (
                      <tr key={`${p.agent}|${p.partKey}`}>
                        <td data-sort={p.state === 'fault' ? '0' : '1'}>
                          <span style={{ color: stateColor(labels.tone?.[p.state]), fontWeight: 700, whiteSpace: 'nowrap' }}>{labels.state?.[p.state] || p.state}</span>
                        </td>
                        <td style={{ maxWidth: 200, whiteSpace: 'normal' }}>
                          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }} title={`${p.deviceId} · 키 ${p.deviceKey || p.deviceId}(${labels.deviceKeyKind?.[p.deviceKeyKind] || p.deviceKeyKind || ''})`}>{p.deviceName}</div>
                          <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{labels.scope?.[p.scope] || p.scope}</div>
                          {/* 긴 안내는 표 아래 각주 1회(tableFootnotes) — 행에는 짧은 표지만(400px 셀 세로 늘어남 방지) */}
                          {dk && <div style={{ fontSize: 11, color: 'var(--amber)', whiteSpace: 'nowrap' }}>{deviceKeyMark(p.deviceKeyKind, labels.deviceKeyKind)}</div>}
                        </td>
                        <td style={{ maxWidth: 220, whiteSpace: 'normal' }}>
                          <div>{p.label}</div>
                          <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{labels.kind?.[p.kind] || p.kind}{p.detail ? ` · ${p.detail}` : ''}</div>
                          {kk && <div style={{ fontSize: 11, color: 'var(--amber)', whiteSpace: 'nowrap' }}>{keyKindMark(p.keyKind, labels.keyKind)}</div>}
                        </td>
                        <td style={{ maxWidth: 200, whiteSpace: 'normal' }}>
                          <code style={{ fontSize: 11 }}>{p.rawState || '—'}</code>
                          {hold && <div style={{ fontSize: 11, color: 'var(--amber)', marginTop: 2 }}><BoldText text={hold} /></div>}
                        </td>
                        <td data-sort={p.firstSeenAt || 0} style={{ whiteSpace: 'nowrap' }}>{p.firstSeenAt ? new Date(p.firstSeenAt).toLocaleString('ko-KR') : '—'}</td>
                        <td data-sort={p.lastSeenAt || 0} style={{ whiteSpace: 'nowrap' }}>{ageText(Date.now() - (p.lastSeenAt || 0))}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          {p.agent || '중앙'}
                          {/* v2.548 C5 — 재배정·등록 삭제로 다시는 관측되지 않을 장애를 관리자가 사유를 적어 닫는다(자동으로는 닫지 않는다) */}
                          {settings && <button className="btn btn-sm" style={{ marginLeft: 6 }} disabled={busy} title="관리자 수동 닫기 — 장비가 고쳐졌다는 뜻이 아닙니다. 사유를 남깁니다." onClick={() => closeRow(p)}>닫기</button>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </STable>
              {footnotes.length > 0 && (
                <div style={{ padding: '8px 12px', borderTop: '1px solid var(--border)', fontSize: 11, color: 'var(--amber)', display: 'grid', gap: 4 }}>
                  {footnotes.map((t) => <div key={t}><BoldText text={t} /></div>)}
                </div>
              )}
            </div>
          )}

          {tab === 'incidents' && (
            <div className="card" style={{ padding: 0, minWidth: 0 }}>
              {!incResp && <Loading />}
              {incResp?.error && <ErrorBox error={incResp.error} />}
              {incResp && !incResp.error && incResp.available === false && (
                <div style={{ padding: 12, color: 'var(--amber)' }}>장애 이력 DB 를 열 수 없습니다 — {incResp.reason || '사유 미상'}</div>
              )}
              {incResp?.available && (
                <>
                  <div style={{ padding: '8px 12px', fontSize: 12, display: 'grid', gap: 4 }}>
                    <div><BoldText text={incidentSummaryText(incResp)} /></div>
                    {incidentScanNote(incResp.scan) && <div style={{ color: 'var(--amber)' }}><BoldText text={incidentScanNote(incResp.scan)} /></div>}
                    {(incQ || repeatOnly) && <div style={{ color: 'var(--text-faint)' }}>검색·반복 부품 조건으로 {incRows.length}건 표시</div>}
                  </div>
                  <DataTable className="pf-inc-table" maxHeight="70vh" limit={500}
                    initialSort={{ key: 'state', dir: 'asc' }}
                    emptyText={incResp.total ? '검색 조건에 맞는 장애가 없습니다.' : `${periodLabel(days)} 동안 기록된 장애가 없습니다 — 이력은 상태가 바뀐 순간만 남깁니다(위 점검 안내를 함께 읽어 주세요).`}
                    footer={incRows.length > 500 ? <div style={{ padding: 8, fontSize: 12, color: 'var(--amber)' }}>정렬한 뒤 앞 500건만 그렸습니다 — {incRows.length - 500}건은 검색·종류로 좁혀 보세요.</div> : null}
                    expandedKey={incOpen}
                    renderExpanded={(i) => <IncidentTimeline inc={i} labels={incResp.labels || labels} />}
                    rows={incRows}
                    columns={[
                      { key: 'state', label: '상태', sortValue: (i) => incidentStateRank(i) * 1e13 - (i.latestAt || 0), render: (i) => {
                        const st = incidentStateText(i, incResp.labels || labels);
                        return <span title={st.title} style={{ color: stateColor(st.tone), fontWeight: 700, whiteSpace: 'nowrap' }}>{st.text}</span>;
                      } },
                      { key: 'deviceName', label: '장비', sortValue: (i) => i.deviceName || i.deviceId, render: (i) => (
                        <div style={{ maxWidth: 200, whiteSpace: 'normal' }}>
                          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }} title={i.deviceId}>{i.deviceName || i.deviceId}</div>
                          <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{labels.scope?.[i.scope] || i.scope}</div>
                        </div>
                      ) },
                      { key: 'label', label: '부품', sortValue: (i) => `${i.kind}|${i.label}`, render: (i) => (
                        <div style={{ maxWidth: 220, whiteSpace: 'normal' }}>
                          <div>{i.label || '—'}</div>
                          <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{labels.kind?.[i.kind] || i.kind}</div>
                        </div>
                      ) },
                      { key: 'openedAt', label: '시작', sortValue: (i) => i.openedAt, render: (i) => {
                        const st = incidentStartText(i);
                        return <div style={{ whiteSpace: 'nowrap' }} title={st.title || st.note}>{st.text}{st.note && <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{st.note}</div>}</div>;
                      } },
                      { key: 'closedAt', label: '종료', sortValue: (i) => (i.ongoing ? Number.MAX_SAFE_INTEGER : i.closedAt), render: (i) => <span style={{ whiteSpace: 'nowrap' }} title={i.closedAt ? fullStamp(i.closedAt) : undefined}>{incidentEndText(i)}</span> },
                      { key: 'durationMs', label: '지속', align: 'right', render: (i) => <span style={{ whiteSpace: 'nowrap' }} title={i.ongoing ? '지금까지 이어진 길이' : ''}>{durationText(i.durationMs, { ongoing: i.ongoing })}</span> },
                      { key: 'peak', label: '최악 상태', sortValue: (i) => (i.peak === 'fault' ? 0 : i.peak === 'warn' ? 1 : 2), render: (i) => (
                        <span style={{ color: stateColor(labels.tone?.[i.peak]), whiteSpace: 'nowrap' }}>{labels.state?.[i.peak] || '—'}</span>
                      ) },
                      { key: 'occurrences', label: '반복', align: 'right', render: (i) => (
                        <span style={{ color: i.occurrences >= 2 ? 'var(--amber)' : undefined, whiteSpace: 'nowrap' }} title="기간 중 같은 부품에서 난 장애 수">{i.occurrences}회</span>
                      ) },
                      { key: 'agent', label: '수집', sortValue: (i) => i.agent || '', render: (i) => <span style={{ whiteSpace: 'nowrap' }}>{i.agent || '중앙'}</span> },
                      { key: '_x', label: '', sortValue: () => 0, render: (i) => (
                        <button className="btn btn-sm" aria-expanded={incOpen === i.id} onClick={() => setIncOpen((v) => (v === i.id ? null : i.id))}>
                          {incOpen === i.id ? '접기' : `타임라인 ${i.events.length + (i.eventsOmitted || 0)}`}
                        </button>
                      ) },
                    ]}
                  />
                </>
              )}
            </div>
          )}

          {tab === 'kinds' && (
            <div className="card" style={{ padding: 0, minWidth: 0 }}>
              {!incResp && <Loading />}
              {incResp?.error && <ErrorBox error={incResp.error} />}
              {incResp && !incResp.error && incResp.available === false && (
                <div style={{ padding: 12, color: 'var(--amber)' }}>장애 이력 DB 를 열 수 없습니다 — {incResp.reason || '사유 미상'}</div>
              )}
              {incResp?.available && (
                <>
                  <div style={{ padding: '8px 12px', fontSize: 12, display: 'grid', gap: 4 }}>
                    <div><BoldText text={incidentSummaryText(incResp)} /></div>
                    {incidentScanNote(incResp.scan) && <div style={{ color: 'var(--amber)' }}><BoldText text={incidentScanNote(incResp.scan)} /></div>}
                  </div>
                  <KindsTable resp={incResp} labels={incResp.labels || labels} onPick={(k) => { setKindSel(k); setTab('incidents'); }} />
                  <div style={{ padding: '8px 12px', borderTop: '1px solid var(--border)', fontSize: 11, color: 'var(--text-faint)' }}><BoldText text={KINDS_NOTE} /></div>
                </>
              )}
            </div>
          )}

          {tab === 'events' && (
            <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
              {!events && <Loading />}
              {events?.error && <ErrorBox message={events.error} />}
              {events?.events && (
                <>
                  {events.truncated && <div style={{ padding: 8, color: 'var(--amber)', fontSize: 12 }}>상한({events.limit}건)으로 잘렸습니다 — 더 이전 이력은 기간을 좁혀 보세요.</div>}
                  <STable minWidth={760} wrap={false}>
                    <thead><tr><th>시각</th><th>장비</th><th>부품</th><th>사건</th><th>장비 보고 원문</th><th>수집</th></tr></thead>
                    <tbody>
                      {events.events.length === 0 && <tr><td colSpan={6} style={{ padding: 16, color: 'var(--text-faint)' }}>
                        {/* v2.598 WEBUI-2598-03: '변화 없음' 은 점검이 돌았을 때만 참이다 */}
                        <BoldText text={historyEmptyText({ poller: data?.poller, db: events.db || data?.db, days }).text} />
                      </td></tr>}
                      {events.events.map((ev, i) => (
                        <tr key={`${ev.agent}|${ev.partKey}:${ev.at}:${i}`}>
                          <td data-sort={ev.at} style={{ whiteSpace: 'nowrap' }}>{new Date(ev.at).toLocaleString('ko-KR')}</td>
                          <td style={{ maxWidth: 180, whiteSpace: 'normal' }}>{ev.deviceName || ev.deviceId}</td>
                          <td style={{ maxWidth: 200, whiteSpace: 'normal' }}>{ev.label}<div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{events.labels?.kind?.[ev.kind] || ev.kind}</div></td>
                          <td style={{ maxWidth: 220, whiteSpace: 'normal' }}><BoldText text={eventText(ev, events.labels)} /></td>
                          <td style={{ maxWidth: 180, whiteSpace: 'normal' }}><code style={{ fontSize: 11 }}>{ev.rawState || '—'}</code></td>
                          <td style={{ whiteSpace: 'nowrap' }}>{ev.agent || '중앙'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </STable>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** 장애 한 건의 타임라인(펼침). 원문 상태·보류 사유·식별 키 변경·잘린 개수를 함께 말한다. */
function IncidentTimeline({ inc, labels }) {
  const hold = inc.ongoing ? holdText(inc.holdReason) : '';
  return (
    // 좁은 화면에서 표가 가로로 스크롤돼도 타임라인은 보이는 자리에 남는다(sticky) — 400px 에서 펼친 칸이 빈 것처럼 보였다.
    <div style={{ padding: '8px 16px 12px', display: 'grid', gap: 4, fontSize: 12, whiteSpace: 'normal', position: 'sticky', left: 0, maxWidth: 'min(900px, calc(100vw - 64px))' }}>
      {inc.migratedFrom && <div style={{ color: 'var(--text-faint)' }}>식별 키 변경으로 이어진 장애입니다(옛 키 {inc.migratedFrom}) — 한 건으로 합쳐 보입니다.</div>}
      {inc.openedAt == null && <div style={{ color: 'var(--amber)' }}>시작 기록을 찾지 못했습니다 — 보존 기간 밖이거나 조회 상한에 걸렸습니다. 아래는 기간 안에서 본 사건만입니다.</div>}
      {inc.events.length === 0 && <div style={{ color: 'var(--text-faint)' }}>이 기간에는 상태 변화가 없었습니다 — 기간 이전에 열려 지금까지 같은 상태입니다.</div>}
      {inc.events.map((e, n) => (
        <div key={`${e.at}:${n}`} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
          <span style={{ color: 'var(--text-faint)', whiteSpace: 'nowrap' }} title={fullStamp(e.at)}>{shortStamp(e.at)}</span>
          <span><BoldText text={eventText(e, labels)} /></span>
          {e.rawState && <code style={{ fontSize: 11 }}>{e.rawState}</code>}
        </div>
      ))}
      {inc.eventsOmitted > 0 && <div style={{ color: 'var(--amber)' }}>사건이 많아 앞 {inc.events.length}건만 실었습니다 — {inc.eventsOmitted}건은 '이력' 탭에서 보세요.</div>}
      {inc.ongoing && inc.rawState && <div>지금 장비 보고 원문: <code style={{ fontSize: 11 }}>{inc.rawState}</code></div>}
      {hold && <div style={{ color: 'var(--amber)' }}><BoldText text={hold} /></div>}
    </div>
  );
}

/** 종류별 표 — 행을 누르면 장애별 목록이 그 종류로 좁혀진다. 막대는 기간 장애 수의 상대 크기다. */
function KindsTable({ resp, labels, onPick }) {
  const kinds = resp.kinds || [];
  const max = Math.max(1, ...kinds.map((k) => k.incidents || 0));
  if (!kinds.length) {
    return <div style={{ padding: 16, color: 'var(--text-faint)' }}>{periodLabel(resp.days)} 동안 기록된 장애가 없습니다 — 이력은 상태가 바뀐 순간만 남깁니다.</div>;
  }
  return (
    <STable minWidth={900}>
      <thead><tr>
        <th>종류</th><th>장애 수</th><th title="기간 안에 새로 시작한 장애 · 괄호는 기간 이전부터 이어진 장애">새로 발생</th><th>지금 열림</th>
        <th title="가장 나빴던 상태가 '이상' 이었던 장애 수">최악이 이상</th><th>영향 장비</th><th title="기간 중 같은 부품에서 2번 이상 난 부품 수">반복 부품</th>
        <th title="정상 복귀·부품 제거로 끝난 장애만">평균 지속</th><th>마지막 발생</th><th data-nosort></th>
      </tr></thead>
      <tbody>
        {kinds.map((k) => (
          <tr key={k.kind}>
            <td style={{ whiteSpace: 'nowrap' }}><b>{labels.kind?.[k.kind] || k.kind}</b></td>
            <td data-sort={k.incidents} style={{ minWidth: 120 }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ minWidth: 28, textAlign: 'right' }}>{k.incidents}</span>
                <span className="pf-kind-bar" aria-hidden="true"><span style={{ width: `${Math.round((k.incidents / max) * 100)}%` }} /></span>
              </div>
            </td>
            <td data-sort={k.started} style={{ whiteSpace: 'nowrap' }}>{k.started}{k.carried ? <span style={{ fontSize: 11, color: 'var(--text-faint)' }} title="기간 이전부터 이어진 장애"> (+이어짐 {k.carried})</span> : ''}</td>
            <td data-sort={k.ongoing} style={{ whiteSpace: 'nowrap' }}>
              {k.ongoing ? <span>{k.ongoing}{k.ongoingFault ? <span style={{ color: 'var(--red)' }}> · 이상 {k.ongoingFault}</span> : ''}{k.ongoingWarn ? <span style={{ color: 'var(--amber)' }}> · 주의 {k.ongoingWarn}</span> : ''}</span> : '—'}
            </td>
            <td data-sort={k.peakFault}>{k.peakFault || '—'}</td>
            <td data-sort={k.devices}>{k.devices}</td>
            <td data-sort={k.repeatParts} style={{ color: k.repeatParts ? 'var(--amber)' : undefined }}>{k.repeatParts || '—'}</td>
            <td data-sort={k.avgDurationMs ?? ''} style={{ whiteSpace: 'nowrap' }} title={k.durationSamples ? `해소된 장애 ${k.durationSamples}건 기준` : '정상 복귀·부품 제거로 끝난 장애가 없습니다'}>
              {durationText(k.avgDurationMs)}{k.durationSamples ? <span style={{ fontSize: 11, color: 'var(--text-faint)' }}> ({k.durationSamples}건)</span> : ''}
            </td>
            <td data-sort={k.lastStartedAt ?? ''} style={{ whiteSpace: 'nowrap' }} title={k.lastStartedAt ? fullStamp(k.lastStartedAt) : '기간 안에 새로 시작한 장애가 없습니다'}>{shortStamp(k.lastStartedAt)}</td>
            <td><button className="btn btn-sm" onClick={() => onPick(k.kind)}>장애 보기</button></td>
          </tr>
        ))}
      </tbody>
    </STable>
  );
}

export default PartFaults;
