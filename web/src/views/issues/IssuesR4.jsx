/**
 * IssuesR4.jsx — v2.908 기능 추천 7 · 9 · 10 화면(사용자 '모두 적용' — 기존 화면 틀대로: 카드 · STable · 활동 피드 모양).
 *  · InboxView — 포탈 알림함(내 것만 · 서버가 지금 범위로 다시 거른다). 줄을 누르면 읽음 + 이슈/문서로.
 *  · ReportView — 리포트(서버 집계 — 화면에서 다시 세지 않는다) + CSV.
 *  · AlertAutoSettings — 설정 › 자동 등록 › 다른 알람 · 백업 실패.
 * 마운트 1회 + 버튼으로만 읽는다(폴링 없음 — 무거운 API 15초 폴링 금지 규약).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson, postJson, putJson, downloadFile, canCsv } from '../../api.js';
import { STable } from '../../components/STable.jsx';
import { Loading, ErrorBox } from '../../components/primitives.jsx';
import Select from '../../components/Select.jsx';
import { makeLatest, timeText, dateText, saveFailText, inboxKindText, pctText, hoursText, PRIORITY_TEXT } from './issueText.js';
import { wikiHash } from '../wiki/wikiText.js';

function useLatest() {
  const ref = useRef(null);
  if (!ref.current) ref.current = makeLatest();
  useEffect(() => () => { ref.current.invalidate(); }, []);
  return ref.current;
}

/* ───── 알림함 ───── */
export function InboxView({ onOpen, onCount = null, canMark = true }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [msg, setMsg] = useState('');
  const latest = useLatest();
  const load = useCallback(() => {
    const k = latest.next();
    fetchJson('/issues/inbox', { limit: 100, unread: unreadOnly ? '1' : '' }).then((r) => { if (latest.isLatest(k)) { setD(r); setErr(null); onCount?.(r.unread || 0); } })
      .catch((e) => { if (latest.isLatest(k)) setErr(e); });
  }, [latest, unreadOnly, onCount]);
  useEffect(() => { load(); }, [load]);
  if (err && !d) return <ErrorBox error={err} />;
  if (!d) return <Loading label="알림함" />;
  const markRead = async (ids) => {
    setMsg('');
    try { const r = await postJson('/issues/inbox/read', ids ? { ids } : {}); if (r?.ok) load(); else setMsg(saveFailText(r)); } catch (e) { setMsg(saveFailText({ reason: e.message })); }
  };
  const go = (x) => {
    if (!x.read && canMark) markRead([x.id]);
    if (x.key) onOpen(x.key);
    else if (x.pageId) window.location.hash = wikiHash({ space: 'pub', id: x.pageId });
  };
  let lastDay = '';
  return (
    <div className="card iss-activity">
      <div className="iss-filters">
        <label className="iss-check"><input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} /> 안 읽은 것만</label>
        <button className="btn" onClick={load}>새로고침</button>
        {canMark && <button className="btn" disabled={!d.unread} onClick={() => markRead(null)}>모두 읽음</button>}
        <span className="muted" style={{ fontSize: 12 }}>
          안 읽음 {d.unread}건 · 언급 · 할당 · 상태 · 기한 · SLA · 멈춤 · 위키 알림을 메일과 따로 여기 모읍니다(사람마다 최근 {d.limits?.perUser || 100}건 · {d.limits?.keepDays || 30}일).
        </span>
      </div>
      {d.demo && <div className="muted" style={{ padding: 12 }}>데모 계정에는 알림함이 없습니다.</div>}
      {d.enabled === false && <div className="banner warn">포탈 알림함이 꺼져 있어 새 알림이 쌓이지 않습니다(이슈 › 설정 › 알림).</div>}
      {err && <div className="banner">새로 읽지 못했습니다 — 아래는 직전에 읽은 알림입니다.</div>}
      {msg && <div className="banner warn">{msg}</div>}
      {!d.demo && d.items.length === 0 && <div className="muted" style={{ padding: 12 }}>{unreadOnly ? '안 읽은 알림이 없습니다.' : '알림이 없습니다.'}</div>}
      <ol className="iss-feed">
        {d.items.map((x) => {
          const day = dateText(x.at);
          const head = day !== lastDay ? day : '';
          lastDay = day;
          return (
            <li key={x.id}>
              {head && <div className="iss-feed-day">{head}</div>}
              <div className={`iss-feed-row iss-inbox-row${x.read ? ' read' : ''}`}>
                <span className={`iss-chip iss-inbox-kind k-${x.kind}`}>{inboxKindText(x.kind)}</span>
                <div className="iss-feed-main">
                  <button type="button" className="iss-link" onClick={() => go(x)} disabled={!x.key && !x.pageId}>{x.text}</button>
                </div>
                {!x.read && canMark && <button type="button" className="iss-mini-act iss-inbox-read" onClick={() => markRead([x.id])}>읽음</button>}
                <span className="muted iss-feed-at" title={timeText(x.at)}>{timeText(x.at).slice(-5)}</span>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/* ───── 리포트 ───── */
const WEEK_CHOICES = [4, 8, 12, 26, 52];
export function ReportView({ meta }) {
  const [weeks, setWeeks] = useState(12);
  const [vc, setVc] = useState('');
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const latest = useLatest();
  const params = { weeks, vcenterId: vc };
  // 좁은 화면에서 주별 막대가 가로로 넘치면 이번 주(오른쪽 끝)가 먼저 보이게 — 읽을 때마다 한 번
  const trendRef = useRef(null);
  useEffect(() => { const el = trendRef.current; if (el) el.scrollLeft = el.scrollWidth; }, [d]);
  const load = useCallback(() => {
    const k = latest.next();
    fetchJson('/issues/report', { weeks, vcenterId: vc }).then((r) => { if (latest.isLatest(k)) { setD(r); setErr(null); } }).catch((e) => { if (latest.isLatest(k)) setErr(e); });
  }, [latest, weeks, vc]);
  useEffect(() => { load(); }, [load]);
  if (err && !d) return <ErrorBox error={err} />;
  if (!d) return <Loading label="리포트" />;
  const csv = async () => {
    setBusy(true); setMsg('');
    try { await downloadFile(`/issues/report.csv?${new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v !== ''))).toString()}`); }
    catch (e) { setMsg(`CSV 를 받지 못했습니다 — ${e?.message || e}`); } finally { setBusy(false); }
  };
  const s = d.summary || {};
  const max = Math.max(1, ...d.trend.map((t) => Math.max(t.created, t.closed)));
  return (
    <div className="iss-report">
      <div className="card iss-filters">
        <Select className="select" value={String(weeks)} onChange={(e) => setWeeks(Number(e.target.value))} aria-label="기간">
          {WEEK_CHOICES.map((w) => <option key={w} value={w}>최근 {w}주</option>)}
        </Select>
        <Select className="select" value={vc} onChange={(e) => setVc(e.target.value)} aria-label="법인">
          <option value="">법인: 전체</option>
          {!meta.scoped && <option value="-">공용(법인 없음)</option>}
          {(meta.vcenters || []).map((v) => <option key={v.id} value={v.id}>{v.name || v.id}</option>)}
        </Select>
        <button className="btn" onClick={load}>새로고침</button>
        {canCsv() && <button className="btn" disabled={busy} onClick={csv}>{busy ? 'CSV…' : 'CSV'}</button>}
        <span className="muted" style={{ fontSize: 12 }}>{d.fromText} ~ {d.toText} · 주는 월요일부터(포탈 날짜) · 이번 주는 진행 중{meta.scoped ? ' · 내 법인 이슈만' : ''}</span>
      </div>
      {err && <div className="banner">새로 읽지 못했습니다 — 아래는 직전에 읽은 리포트입니다.</div>}
      {msg && <div className="banner warn">{msg}</div>}
      <div className="kpis iss-report-kpis">
        <div className="kpi"><div className="label">생성</div><div className="value">{s.created}</div><div className="meta">최근 {d.weeks}주</div></div>
        <div className="kpi"><div className="label">완료</div><div className="value">{s.closed}</div><div className="meta">최근 {d.weeks}주</div></div>
        <div className="kpi"><div className="label">평균 해결</div><div className="value">{hoursText(s.avgResolveHours)}</div><div className="meta">완료 {s.resolvedCount}건 · 중앙값 {hoursText(s.medianResolveHours)} · 보류 제외</div></div>
        <div className="kpi"><div className="label">자동 등록 비율</div><div className="value">{pctText(s.autoPct)}</div><div className="meta">파트 장애 · 알람 · 백업 {s.auto}건</div></div>
        <div className="kpi"><div className="label">SLA 해결 준수</div><div className="value">{d.sla ? pctText(d.sla.resolvePct) : '—'}</div>
          <div className="meta">{d.sla ? `응답 ${pctText(d.sla.respondPct)} · 지금 초과 ${d.sla.breachedOpen}건${d.sla.business ? ' · 업무 시간' : ''}` : 'SLA 가 꺼져 있습니다(이슈 › 설정)'}</div></div>
      </div>
      <div className="card">
        <h3 className="iss-h3">주별 생성 · 완료</h3>
        <div className="iss-trend" ref={trendRef} role="img" aria-label={`최근 ${d.weeks}주 주별 생성 · 완료 수`}>
          {d.trend.map((t) => (
            <div key={t.week} className={`iss-trend-col${t.current ? ' cur' : ''}`} title={`${t.week} 주 — 생성 ${t.created} · 완료 ${t.closed}${t.current ? ' (진행 중)' : ''}`}>
              <div className="iss-trend-bars">
                <span className="iss-trend-bar c" style={{ height: `${(t.created / max) * 100}%` }} />
                <span className="iss-trend-bar d" style={{ height: `${(t.closed / max) * 100}%` }} />
              </div>
              <span className="iss-trend-lbl">{t.week.slice(5).replace('-', '/')}</span>
            </div>
          ))}
        </div>
        <div className="muted" style={{ fontSize: 12 }}><span className="iss-trend-key c" /> 생성 <span className="iss-trend-key d" /> 완료 — 평균 해결 시간은 완료된 이슈만(보류 시간 제외 · 달력 시간 · 에픽 제외)</div>
      </div>
      <div className="iss-report-grid">
        <div className="card" style={{ minWidth: 0 }}>
          <h3 className="iss-h3">법인별</h3>
          {d.byCorp.length ? (
            <STable className="table" wrap>
              <thead><tr><th>법인</th><th title="지금 열린 이슈">열림</th><th>생성</th><th>완료</th></tr></thead>
              <tbody>{d.byCorp.map((c) => <tr key={c.vcenterId || '-'}><td>{c.name}</td><td data-sort={c.open}>{c.open}</td><td data-sort={c.created}>{c.created}</td><td data-sort={c.closed}>{c.closed}</td></tr>)}</tbody>
            </STable>
          ) : <div className="muted">이슈가 없습니다.</div>}
        </div>
        <div className="card" style={{ minWidth: 0 }}>
          <h3 className="iss-h3">담당자별</h3>
          {d.byAssignee.length ? (
            <STable className="table" wrap>
              <thead><tr><th>사람</th><th title="지금 열린 이슈(담당)">열림</th><th>완료</th><th title="기간 안 작업 기록(기록한 사람 기준)">기록</th></tr></thead>
              <tbody>{d.byAssignee.map((p) => <tr key={p.user}><td>{p.user}</td><td data-sort={p.open}>{p.open}</td><td data-sort={p.closed}>{p.closed}</td><td data-sort={p.loggedMin}>{p.loggedMin ? hoursText(Math.round((p.loggedMin / 60) * 10) / 10) : '—'}</td></tr>)}</tbody>
            </STable>
          ) : <div className="muted">담당자가 있는 이슈 · 작업 기록이 없습니다.</div>}
          <div className="muted" style={{ fontSize: 12 }}>열림은 지금 수 · 완료는 기간 안(담당자 기준) · 기록은 기간 안 작업 기록(기록한 사람 기준 — 시간 추적).</div>
        </div>
        <div className="card" style={{ minWidth: 0 }}>
          <h3 className="iss-h3">유형별 생성</h3>
          {d.byType.length ? (
            <STable className="table" wrap>
              <thead><tr><th>유형</th><th>생성</th></tr></thead>
              <tbody>{d.byType.map((t) => <tr key={t.type}><td>{t.label}</td><td data-sort={t.created}>{t.created}</td></tr>)}</tbody>
            </STable>
          ) : <div className="muted">기간 안에 만든 이슈가 없습니다.</div>}
        </div>
      </div>
    </div>
  );
}

/* ───── 설정 › 다른 알람 자동 등록 ───── */
export function AlertAutoSettings() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const latest = useLatest();
  const load = useCallback(() => {
    const k = latest.next();
    fetchJson('/issues/autocreate/alerts').then((r) => {
      if (!latest.isLatest(k)) return;
      setD(r); setErr(null);
      const s = r.settings;
      setForm({ enabled: !!s.enabled, kinds: { ...s.kinds }, priority: { ...s.priority }, delayMin: String(s.delayMin), dailyMax: String(s.dailyMax), labels: (s.labels || []).join(', '), onResolve: s.onResolve });
    }).catch((e) => { if (latest.isLatest(k)) setErr(e); });
  }, [latest]);
  useEffect(() => { load(); }, [load]);
  if (err && !d) return <ErrorBox error={err} />;
  if (!d || !form) return <Loading label="다른 알람 자동 등록" />;
  const upd = (p) => setForm((f) => ({ ...f, ...p }));
  const save = async () => {
    setBusy(true); setMsg('');
    try {
      const r = await putJson('/issues/autocreate/alerts', { ...form, delayMin: Number(form.delayMin), dailyMax: Number(form.dailyMax), labels: form.labels.split(',').map((x) => x.trim()).filter(Boolean) });
      if (r?.ok) { setMsg('저장했습니다.'); load(); } else setMsg(saveFailText(r));
    } catch (e) { setMsg(saveFailText({ reason: e.message })); } finally { setBusy(false); }
  };
  const st = d.status || {};
  const lim = d.limits || {};
  return (
    <div className="card iss-editor">
      <h3 className="iss-h3">자동 등록 — 다른 알람 · 백업 실패</h3>
      {d.loadError && <div className="banner bad" style={{ whiteSpace: 'normal' }}>설정 파일(issue-alert-auto.json)을 읽지 못해 기본값(꺼짐)으로 동작 중입니다 — 손상본은 옆에 보존했습니다. 원인: {d.loadError}</div>}
      <label className="iss-check"><input type="checkbox" checked={form.enabled} onChange={(e) => upd({ enabled: e.target.checked })} /> 알람이 이어지면 이슈로 등록합니다</label>
      <div className="muted" style={{ fontSize: 12.5 }}>알람이 아래 분 넘게 이어질 때 장애 이슈를 만들고(같은 알람의 열린 이슈가 있으면 만들지 않음), 해소되면 댓글을 답니다. 해소 뒤 다시 나면 같은 이슈에 ‘다시 발생’ 댓글. 판정 보류(값을 못 읽음)는 해소로 보지 않습니다. 백업 실패는 잡마다 한 이슈 — 같은 잡이 또 실패하면 댓글, 성공해도 자동으로 닫지 않습니다. 인증서 만료는 알람 엔진에 판정이 없어 대상이 아닙니다.</div>
      <div className="iss-alert-kinds">
        {(d.kinds || []).map((k) => (
          <div key={k} className="iss-alert-kind">
            <label className="iss-check"><input type="checkbox" checked={!!form.kinds[k]} onChange={(e) => upd({ kinds: { ...form.kinds, [k]: e.target.checked } })} /> {d.kindLabels?.[k] || k}</label>
            <Select className="select" value={form.priority[k]} onChange={(e) => upd({ priority: { ...form.priority, [k]: e.target.value } })} aria-label={`${d.kindLabels?.[k] || k} 우선순위`}>
              {['p0', 'p1', 'p2', 'p3'].map((p) => <option key={p} value={p}>{PRIORITY_TEXT[p] || p}</option>)}
            </Select>
          </div>
        ))}
      </div>
      <div className="iss-checks">
        <label className="iss-inline">이어진 시간(분)<input className="input iss-num" type="number" min={lim.delayMin?.[0] ?? 0} max={lim.delayMin?.[1] ?? 1440} value={form.delayMin} onChange={(e) => upd({ delayMin: e.target.value })} /></label>
        <label className="iss-inline">하루 상한(건)<input className="input iss-num" type="number" min={lim.dailyMax?.[0] ?? 1} max={lim.dailyMax?.[1] ?? 500} value={form.dailyMax} onChange={(e) => upd({ dailyMax: e.target.value })} /></label>
        <label className="iss-inline">해소되면
          <Select className="select" value={form.onResolve} onChange={(e) => upd({ onResolve: e.target.value })} aria-label="해소되면">
            <option value="review">댓글 + 상태를 검토로</option><option value="keep">댓글만</option>
          </Select>
        </label>
      </div>
      <label className="iss-field">라벨(쉼표 구분)<input className="input" value={form.labels} onChange={(e) => upd({ labels: e.target.value })} /></label>
      <div className="muted" style={{ fontSize: 12.5 }}>
        실행 상태: 만든 이슈 {st.created || 0} · 댓글 {st.commented || 0} · 검토로 {st.review || 0}{st.capped ? ` · 상한으로 안 만든 것 ${st.capped}` : ''}{st.errors ? ` · 실패 ${st.errors}(${st.error || ''})` : ''}{st.ranAt ? ` · 마지막 ${timeText(st.ranAt)}` : ' · 아직 돌지 않았습니다'}
      </div>
      {msg && <div className="banner">{msg}</div>}
      <div className="flex" style={{ gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        <button className="btn" onClick={load} disabled={busy}>다시 읽기</button>
        <button className="btn primary" onClick={save} disabled={busy || !!err}>{busy ? '저장 중…' : '저장'}</button>
      </div>
    </div>
  );
}
