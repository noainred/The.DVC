/**
 * 통신 점검 — 중앙 포탈 ↔ 엣지 포탈·vCenter 의 **모든 통신을 단계별로** 재서 기록한다(v2.552).
 *
 * 사용자 요청(2026-09-18): "main 포탈과 edge 포탈의 모든 통신이 정상인지 측정하는 프로그램을
 * 특수기능에 만들어줘, 현재 포탈에서 설정된 엣지와 vcenter 와 수집 서버가 통신하는 것을 파악해서
 * 점검하고 점검하는 로그를 최대한 많이 기록해서 이슈가 있을때 분석하는 자료로 사용하고 싶어".
 * 선택: **엣지↔엣지 포함** · 로그 **3단 구조** · 점검 **단계별 전체**.
 *
 * 화면 설계 의도:
 *  1. 맨 위는 '지금 보이는 것이 무엇인가' — 꺼짐·첫 주기·측정 없음을 **배너가 한 번만** 말한다.
 *  2. 링크 표는 '어디서 막혔는가'(단계 표지) + '언제부터'(연속 횟수·since).
 *  3. 아래는 **로그 뷰어** — 실패·상태변화만 상세가 있고(3단 구조) 클릭하면 원문 JSON 을 본다.
 *  4. 판정·문구는 `linkCheckText.js`(순수, vitest 고정)가 소유한다. 이 파일은 조립만 한다.
 *
 * ⚠ **폴링하지 않는다** — 점검은 폴러가 주기로 돌고, 화면은 마운트 1회 + 버튼이다(v2.508 V4 규약).
 * ⚠ 표는 **가로 스크롤 컨테이너**로 감싼다 — 열이 많아 감싸지 않으면 400px 에서 페이지를 밀어낸다.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { fetchJson, postJson, putJson } from '../../api.js';
import { useLatest } from '../../hooks/useLatest.js';
import { Loading, ErrorBox, SearchBox, Kpi } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import { linkFormFromSettings, linkSettingsPayload } from './linkCheckForm.js'; // v2.606 WEB2606-10: 빈 숫자 칸 = 이전 값
import {
  STATE_LABEL, stateTone, rowState, msText, ageText, certText, kpisOf, headerNote,
  runResultText, EVENT_LABEL, eventTone, tableFootnotes, pairNote, trailFromLatest,
} from './linkCheckText.js';
// v2.553: 설정 전수 점검(25종) + 해결책 — 같은 화면의 탭이다(도구를 하나 더 만들지 않는다).
const SettingsCheckPanel = React.lazy(() => import('./SettingsCheckPanel.jsx'));

const VIEWS = [['settings', '설정 전수 점검'], ['links', '중앙↔엣지 링크'], ['logs', '점검 로그']];

const HOURS = [[24, '24시간'], [24 * 7, '7일'], [24 * 30, '30일']];
/*
 * 로그 구분 필터 — 계속 실패하는 링크는 **주기마다** `실패 지속` 을 남기므로(사용자 요청
 * "로그를 최대한 많이 기록") 그것이 `실패 시작`·`복구` 를 덮는다. 이슈 분석에서 가장 자주 보는
 * 것은 '언제 시작했고 언제 돌아왔나' 이므로 골라 볼 수 있어야 한다.
 */
const EVENTS = [['', '전체'], ['fail-start', '실패 시작'], ['recovered', '복구'], ['fail', '실패 지속'], ['first', '첫 점검']];

/** 단계 표지의 뜻 — 기호만 두면 `–` 와 `○` 의 차이를 알 수 없다(툴팁으로 말한다). */
const STEP_MARK_TITLE = Object.freeze({
  ok: '정상', fail: '실패', skip: '해당 없음(이 링크에는 그 단계가 없습니다)', untried: '시도하지 않음',
});

function Badge({ text, tone }) {
  return <span style={{ color: tone, fontWeight: 600, whiteSpace: 'nowrap' }}>{text}</span>;
}

/** 단계 표지 — 행에는 **짧게**만(조치는 표 아래 각주 1회 · v2.509). */
function PhaseTrail({ latest, phases, label }) {
  const trail = trailFromLatest(latest, phases);
  return (
    <span style={{ whiteSpace: 'nowrap', fontSize: 11 }}>
      {trail.map((s, i) => (
        <span key={s.phase} title={`${label?.[s.phase] || s.phase}: ${STEP_MARK_TITLE[s.state] || s.state}${s.error ? ` — ${s.error}` : ''}`}>
          {i > 0 && <span style={{ color: 'var(--muted)' }}>›</span>}
          <span style={{ color: s.state === 'ok' ? 'var(--ok, #35c46a)' : s.state === 'fail' ? 'var(--bad, #ef5a5a)' : 'var(--muted)' }}>
            {/* ⚠ `skip`(해당 없음 — 예: http 링크의 TLS)과 `untried`(미시도)를 **다른 기호**로 */}
            {s.state === 'ok' ? '●' : s.state === 'fail' ? '✕' : s.state === 'skip' ? '–' : '○'}
          </span>
        </span>
      ))}
    </span>
  );
}

export function LinkCheck() {
  // ⚠ 훅은 전부 조기 return 위에(조기 반환 뒤 훅 추가는 React #310 크래시 — v2.202 실제 사고).
  const [view, setView] = useState('settings');   // v2.553 — 기본은 '설정 전수'(요청의 초점)
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [q, setQ] = useState('');
  const [kindFilter, setKindFilter] = useState('');
  const [onlyBad, setOnlyBad] = useState(false);
  const [events, setEvents] = useState(null);
  const [evHours, setEvHours] = useState(24 * 7);
  const [evLink, setEvLink] = useState('');
  const [evKind, setEvKind] = useState('');
  const [evLoading, setEvLoading] = useState(false);
  const [detail, setDetail] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [form, setForm] = useState(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    try { const d = await fetchJson('/tools/link-check'); setData(d); setForm(linkFormFromSettings(d.settings)); setError(''); }
    catch (e) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  /*
   * v2.599(감사 WEB2599-02): 기간·링크·구분을 빠르게 바꾸면 늦게 온 **이전 선택의 응답**이 새 선택의
   *   로그를 덮고 '불러오는 중' 도 먼저 풀렸다(v2.596 WS-1~4 와 같은 결함 — 이 화면만 남아 있었다).
   *   `useLatest` 세대 가드로 **마지막 요청의 응답만** 반영한다(성공·실패·로딩 해제 모두).
   */
  const latestEvents = useLatest();
  const loadEvents = React.useCallback((linkId = '', hours = 24 * 7, event = '') => {
    setEvLoading(true);
    const qs = new URLSearchParams({ hours: String(hours), limit: '300' });
    if (linkId) qs.set('linkId', linkId);
    if (event) qs.set('event', event);
    return latestEvents(
      fetchJson(`/tools/link-check/events?${qs}`),
      (d) => { setEvents(d); setEvLoading(false); },
      (e) => { setNote(`로그 조회 실패: ${e?.message || e}`); setEvLoading(false); },
    );
  }, [latestEvents]);
  useEffect(() => { loadEvents(evLink, evHours, evKind); }, [loadEvents, evLink, evHours, evKind]);

  /*
   * ⚠ v2.554 — `runningSinceTs`·`intervalMs` 를 함께 넘긴다. 없으면 `rowState` 가 엣지 미보고를
   *   영원히 '첫 보고 대기'(= 기다리면 된다)라고 말한다(사용자 실화면으로 확정한 v2.552 결함).
   */
  const opt = useMemo(() => ({
    enabled: !!data?.enabled,
    minEdgeVersion: data?.minEdgeVersion,
    runningSinceTs: data?.runningSinceTs ?? null,
    intervalMs: data?.poller?.intervalMs ?? data?.settings?.intervalMs ?? 0,
  }), [data?.enabled, data?.minEdgeVersion, data?.runningSinceTs, data?.poller?.intervalMs, data?.settings?.intervalMs]);
  const rows = useMemo(() => {
    const list = data?.links || [];
    const needle = q.trim().toLowerCase();
    return list.filter((r) => {
      if (kindFilter && r.kind !== kindFilter) return false;
      if (onlyBad && rowState(r, opt).state !== 'fail') return false;
      if (!needle) return true;
      return [r.from, r.to, r.host, r.kind, r.vcenterName, r.latest?.summary].some((v) => String(v || '').toLowerCase().includes(needle));
    });
  }, [data, q, kindFilter, onlyBad, opt]);

  const kpi = useMemo(() => kpisOf(data?.links || [], opt), [data, opt]);
  const banners = useMemo(() => headerNote(data || {}), [data]);
  const foots = useMemo(() => tableFootnotes(rows, opt), [rows, opt]);

  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox error={error} />;

  const runNow = async () => {
    setBusy(true);
    try { setNote(runResultText(await postJson('/tools/link-check/run', {}))); await load(); await loadEvents(evLink, evHours, evKind); }
    catch (e) { setNote(`점검 실패: ${e?.message || e}`); }
    finally { setBusy(false); }
  };
  const saveSettings = async () => {
    setBusy(true);
    try { const r = await putJson('/tools/link-check/settings', linkSettingsPayload(form)); setNote('설정을 저장했습니다.'); setData({ ...data, settings: r.settings, enabled: r.settings.enabled }); setForm(linkFormFromSettings(r.settings)); }
    catch (e) { setNote(`저장 실패: ${e?.message || e}`); }
    finally { setBusy(false); }
  };
  const openDetail = async (id) => {
    try { setDetail(await fetchJson(`/tools/link-check/event/${id}`)); }
    catch (e) { setNote(`상세 조회 실패: ${e?.message || e}`); }
  };

  const kinds = data?.kinds || {};
  const phaseLabel = data?.phaseLabel || {};

  return (
    <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'minmax(0, 1fr)', minWidth: 0 }}>
      {error && <div className="banner">{error}</div>}

      {/* 보기 전환 — 한 도구 안의 탭이다(셸을 더 만들지 않는다 — v2.508 규약) */}
      <div className="card" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {VIEWS.map(([k, label]) => (
          <button key={k} className="btn" onClick={() => setView(k)}
            style={view === k ? { background: 'var(--accent, #2b6cb0)', color: '#fff' } : undefined}>
            {label}
          </button>
        ))}
      </div>

      {view === 'settings' && (
        <React.Suspense fallback={<Loading />}><SettingsCheckPanel /></React.Suspense>
      )}

      {view !== 'settings' && (
      <>
      {/* 배너 — 긴 설명은 여기 한 번만(v2.509) */}
      {banners.length > 0 && (
        <div className="card" style={{ borderLeft: '3px solid var(--warn, #e8b23a)' }}>
          {banners.map((b, i) => <div key={i} style={{ fontSize: 12, lineHeight: 1.6 }}><BoldText text={b} /></div>)}
        </div>
      )}

      <div className="kpis">
        <Kpi label="점검 대상" value={kpi.total} />
        <Kpi label="정상" value={kpi.ok} />
        <Kpi label="실패" value={kpi.fail} />
        {/* ⚠ '측정 없음' 을 정상에 흡수하지 않는다 — 별도 칸이다(v2.523·v2.548 규약). */}
        <Kpi label="측정 없음" value={kpi.nodata} />
        <Kpi label="정상률(측정분)" value={kpi.okPct == null ? '—' : `${kpi.okPct}%`} />
      </div>

      <div className="card" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="btn" onClick={runNow} disabled={busy || !data?.enabled} title={!data?.enabled ? '통신 점검이 꺼져 있습니다 — 설정에서 켜세요.' : ''}>
          {busy ? '점검 중…' : '지금 점검'}
        </button>
        <button className="btn" onClick={load} disabled={busy}>새로고침</button>
        <button className="btn" onClick={() => setShowSettings((v) => !v)}>{showSettings ? '설정 닫기' : '설정'}</button>
        <SearchBox value={q} onChange={setQ} placeholder="엣지·vCenter·호스트 검색" />
        <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value)}>
          <option value="">모든 종류</option>
          {(data?.kindKeys || []).map((k) => <option key={k} value={k}>{kinds[k]?.label || k}</option>)}
        </select>
        <label style={{ fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' }}>
          <input type="checkbox" checked={onlyBad} onChange={(e) => setOnlyBad(e.target.checked)} /> 실패만
        </label>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>
          마지막 주기 {ageText(data?.poller?.last?.at)} · 주기 {msText(data?.poller?.intervalMs)}
        </span>
      </div>

      {note && <div className="card" style={{ fontSize: 12 }}><BoldText text={note} /></div>}

      {showSettings && form && (
        <div className="card" style={{ display: 'grid', gap: 8 }}>
          <div style={{ fontWeight: 600 }}>통신 점검 설정</div>
          <label style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={!!form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
            점검 켜기 (기본 꺼짐 — 켜면 주기마다 링크 수만큼 TCP/TLS/HTTP 가 나갑니다)
          </label>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 12 }}>
            <label style={{ display: 'grid', gap: 2, minWidth: 0 }}>주기(분)
              <input type="number" min="1" style={{ minWidth: 0, width: 90 }}
                value={form.intervalMin ?? ''}
                onChange={(e) => setForm({ ...form, intervalMin: e.target.value })} />
            </label>
            <label style={{ display: 'grid', gap: 2, minWidth: 0 }}>동시 점검 수
              <input type="number" min="1" max="32" style={{ minWidth: 0, width: 90 }}
                value={form.concurrency ?? ''} onChange={(e) => setForm({ ...form, concurrency: e.target.value })} />
            </label>
            <label style={{ display: 'grid', gap: 2, minWidth: 0 }}>표본 보존(일)
              <input type="number" min="7" style={{ minWidth: 0, width: 90 }}
                value={form.sampleRetentionDays ?? ''} onChange={(e) => setForm({ ...form, sampleRetentionDays: e.target.value })} />
            </label>
            <label style={{ display: 'grid', gap: 2, minWidth: 0 }}>로그 보존(일)
              <input type="number" min="3" style={{ minWidth: 0, width: 90 }}
                value={form.eventRetentionDays ?? ''} onChange={(e) => setForm({ ...form, eventRetentionDays: e.target.value })} />
            </label>
          </div>
          <div style={{ display: 'grid', gap: 4 }}>
            <div style={{ fontSize: 12, fontWeight: 600 }}>점검할 종류</div>
            {(data?.kindKeys || []).map((k) => (
              <label key={k} style={{ fontSize: 11, display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                <input type="checkbox" checked={form.kinds?.[k] !== false}
                  onChange={(e) => setForm({ ...form, kinds: { ...(form.kinds || {}), [k]: e.target.checked ? true : false } })} />
                <span><b>{kinds[k]?.label || k}</b> — {kinds[k]?.desc || ''}</span>
              </label>
            ))}
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>
            <BoldText text={pairNote(data?.agents || [], form.pairs || [])} />
          </div>
          <div style={{ fontSize: 11 }}>
            엣지↔엣지 짝(한 줄에 `보내는엣지 → 받는엣지`):
            <textarea rows={4} style={{ width: '100%', minWidth: 0, fontSize: 11 }}
              value={(form.pairs || []).map((p) => `${p.from} → ${p.to}`).join('\n')}
              onChange={(e) => setForm({
                ...form,
                pairs: e.target.value.split(/\r?\n/).map((ln) => {
                  const m = ln.split(/→|->|,/);
                  return { from: String(m[0] || '').trim(), to: String(m[1] || '').trim() };
                }).filter((p) => p.from && p.to),
              })} />
          </div>
          <div><button className="btn" onClick={saveSettings} disabled={busy}>설정 저장</button></div>
        </div>
      )}

      {(data?.problems || []).length > 0 && (
        <div className="card">
          <div style={{ fontWeight: 600, marginBottom: 6 }}>설정 문제 — 점검조차 하지 못하는 대상 {data.problems.length}건</div>
          <div style={{ overflowX: 'auto' }}>
            <STable className="v3-table">
              <thead><tr><th>종류</th><th>출발</th><th>대상</th><th>사유</th></tr></thead>
              <tbody>
                {data.problems.map((p, i) => (
                  <tr key={i}><td>{kinds[p.kind]?.label || p.kind}</td><td>{p.from}</td><td>{p.to}</td>
                    <td style={{ whiteSpace: 'normal' }}>{p.reason}</td></tr>
                ))}
              </tbody>
            </STable>
          </div>
        </div>
      )}

      <div className="card">
        <div style={{ fontWeight: 600, marginBottom: 6 }}>링크 {rows.length}개 {rows.length !== (data?.links || []).length ? `(전체 ${(data?.links || []).length})` : ''}</div>
        <div style={{ overflowX: 'auto' }}>
          <STable className="v3-table" minWidth={1100} wrap={false}>
            <thead>
              <tr>
                <th>종류</th><th>출발</th><th>대상</th><th>주소</th><th>상태</th>
                <th data-nosort>단계</th><th>응답</th><th>인증서</th><th>측정자</th><th>언제부터</th><th>사유</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const st = rowState(r, opt);
                const L = r.latest || null;
                const cert = certText(L?.certDaysLeft);
                return (
                  <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => { setEvLink(r.id); }}>
                    <td style={{ whiteSpace: 'nowrap' }}>{kinds[r.kind]?.label || r.kind}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{r.from || '—'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{r.vcenterName || r.to}</td>
                    <td style={{ maxWidth: 190, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.origin || ''}>
                      {r.host ? `${r.host}:${r.port}` : '—'}
                    </td>
                    <td data-sort={st.state}><Badge text={STATE_LABEL[st.state] || st.state} tone={stateTone(st.state)} /></td>
                    <td data-nosort><PhaseTrail latest={L} phases={data?.phases} label={phaseLabel} /></td>
                    <td className="right" data-sort={L?.totalMs ?? ''}>{msText(L?.totalMs)}</td>
                    <td data-sort={L?.certDaysLeft ?? ''}><span style={{ color: cert.tone, whiteSpace: 'nowrap' }}>{cert.text}</span></td>
                    <td style={{ whiteSpace: 'nowrap' }}>{L?.byNode || (r.by === 'edge' ? `${r.from}(엣지)` : '중앙')}</td>
                    <td style={{ whiteSpace: 'nowrap' }} data-sort={L?.sinceTs ?? ''}>
                      {L ? `${ageText(L.sinceTs)}${L.streak > 1 ? ` · ${L.streak}회` : ''}` : '—'}
                    </td>
                    {/* ⚠ 행에는 **짧은 표지**만 — 긴 설명·조치는 표 아래 각주 1회(v2.509 규약).
                        초판은 여기에 `why` 를 넣어 같은 문단이 6줄 반복됐다(스크린샷 판독으로 발견). */}
                    <td style={{ whiteSpace: 'normal', fontSize: 11, maxWidth: 260 }} title={st.why || ''}>
                      {st.whyShort || '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </STable>
        </div>
        {foots.length > 0 && (
          <div style={{ marginTop: 8, fontSize: 11, color: 'var(--muted)', display: 'grid', gap: 3 }}>
            {foots.map((f, i) => <div key={i}><BoldText text={f} /></div>)}
          </div>
        )}
      </div>

      {view === 'logs' && (
      <div className="card">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
          <div style={{ fontWeight: 600 }}>점검 로그</div>
          <select value={evHours} onChange={(e) => setEvHours(Number(e.target.value))}>
            {HOURS.map(([h, l]) => <option key={h} value={h}>{l}</option>)}
          </select>
          <select value={evKind} onChange={(e) => setEvKind(e.target.value)}>
            {EVENTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          {evLink && <button className="btn" onClick={() => setEvLink('')}>전체 링크 보기</button>}
          {evLink && <span style={{ fontSize: 11, color: 'var(--muted)' }}>필터: {evLink}</span>}
          {evLoading && <span style={{ fontSize: 11, color: 'var(--muted)' }}>불러오는 중…</span>}
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>
          <BoldText text={'상세 원문은 **실패이거나 상태가 바뀔 때만** 남습니다 — 정상이 이어지는 주기까지 원문을 남기면 저장소가 폭발합니다(요약 표본은 따로 매 주기 남습니다). 계속 실패하는 링크는 **주기마다 \'실패 지속\'** 이 쌓이므로, 시작·복구만 보려면 구분을 골라 주세요.'} />
        </div>
        {events?.truncated && <div style={{ fontSize: 11, color: 'var(--warn, #e8b23a)' }}>상한(300건)으로 잘렸습니다 — 기간을 좁히거나 링크를 고르세요.</div>}
        <div style={{ overflowX: 'auto' }}>
          <STable className="v3-table" minWidth={860} wrap={false}>
            <thead><tr><th>시각</th><th>구분</th><th>링크</th><th>단계</th><th>실패 종류</th><th>측정자</th><th>요약</th><th data-nosort>상세</th></tr></thead>
            <tbody>
              {(events?.rows || []).map((e) => (
                <tr key={e.id}>
                  <td style={{ whiteSpace: 'nowrap' }} data-sort={e.ts}>{new Date(e.ts).toLocaleString('ko-KR')}</td>
                  <td><Badge text={EVENT_LABEL[e.event] || e.event} tone={eventTone(e.event, !!e.ok)} /></td>
                  <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.link_id}>{e.link_id}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{phaseLabel[e.phase] || e.phase || '—'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{data?.failKinds?.[e.fail_kind]?.label || e.fail_kind || '—'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{e.by_node || '—'}</td>
                  <td style={{ whiteSpace: 'normal', fontSize: 11 }}>{e.summary || '—'}</td>
                  <td data-nosort>
                    {e.detail_bytes
                      ? <button className="btn" onClick={() => openDetail(e.id)}>{e.truncated ? '원문(잘림)' : '원문'}</button>
                      : <span style={{ color: 'var(--muted)', fontSize: 11 }}>없음</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </STable>
        </div>
        {(events?.rows || []).length === 0 && !evLoading && (
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
            <BoldText text={'이 기간에 기록이 없습니다 — **문제가 없었다는 뜻일 수도 있고**(실패·상태변화가 없으면 로그를 남기지 않습니다) 점검이 아직 돌지 않았다는 뜻일 수도 있습니다. 위의 마지막 주기 시각을 함께 보세요.'} />
          </div>
        )}
      </div>

      )}

      {detail && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontWeight: 600 }}>상세 원문 — {detail.row?.link_id}</div>
            <button className="btn" onClick={() => setDetail(null)}>닫기</button>
          </div>
          {detail.row?.truncated ? <div style={{ fontSize: 11, color: 'var(--warn, #e8b23a)' }}>저장 상한으로 <b>잘린</b> 기록입니다.</div> : null}
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11, lineHeight: 1.45, maxHeight: 420, overflow: 'auto' }}>
            {detail.detail ? JSON.stringify(detail.detail, null, 2) : (detail.detailRaw || '(원문 없음)')}
          </pre>
        </div>
      )}
      </>
      )}
    </div>
  );
}

export default LinkCheck;
