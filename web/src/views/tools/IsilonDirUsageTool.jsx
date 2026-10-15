/**
 * 특수 기능 '아이실론 디렉터리 사용량'(v2.736) — 지정한 디렉터리 바로 아래 폴더(= 사용자)의 크기 Top N 과 추이.
 *
 * 사용자 요청(2026-10-14): "아이실론의 특정 디렉터리 하위의 모든 폴더의 크기를 조사해서 Top 10 … ssh admin@… 'du -A -h -d 1 "…"'
 *   … ssh password-less … 각 edge 가 속한 동일한 법인의 아이실론 … /ifs/data/workspace/users/aaa 는 사용자 aaa … DB 에 저장해서 주기적으로
 *   트래킹 … claude design 으로". 배치는 시안(Claude Design 'Isilon dir usage' — 메인·설정·좁은 화면 3장)을 따른다.
 *
 * 설계:
 *  · 판정은 서버(report.js — 7일·30일 비교·신규·사라짐·해상도 안의 흔들림)가 하고 화면은 문구·좌표만(isiduText.js) 만든다.
 *  · 목록은 30초 폴링(조사 중이면 8초). 보고서·추이·표는 '최신 성공 수집이 바뀔 때' 다시 읽는다(폴링하지 않는다 — 수천 행을 매번 비교하지 않게).
 *  · 조회는 DB·등록부만 읽어 장비 왕복이 0 이다. du 는 폴러가 주기로, 또는 '지금 수집' 으로만 돈다(수십 분 걸릴 수 있다 — 기다리지 않는다).
 *  · 폴링이 실패해도 직전 값을 지우지 않는다(v2.729 I-04). 다른 대상의 늦은 응답은 버린다(요청 키 대조).
 *  · 대상 선택은 주소 `#/tools/isilon-dirusage/t/<id>` — 새로고침·공유해도 같은 대상이 열린다.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, postJson, downloadFile, canCsv, CSV_DENIED_NOTE } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import { hashSegments } from '../../hooks/hashTab.js';
import { agoText } from './relTime.js';
import { collectDropNote } from './collectDropText.js';
import {
  FAIL_TEXT, failTitle, bytesText, deltaView, shareText, countText, nodeText, everyText, durationText, tailPath,
  sparkPath, trendModel, trendNotes, baseNote, scanNotes, kpiCards, targetStatus, keyStatus, keyRows, runResultText, nudgeLines,
  USER_FILTERS, PAGE_SIZE, usersFootNote, targetChip, corpOverview, overviewNote, resumeNote,
} from './isiduText.js';
import IsiduSettings from './IsiduSettings.jsx';
import './isidu.css';

const BASE = ['tools', 'isilon-dirusage'];
const TREND_DAYS = [7, 30, 90, 365];
const DAY_LABEL = { 7: '7일', 30: '30일', 90: '90일', 365: '1년' };

function useHashTarget() {
  const read = () => {
    const s = hashSegments(typeof window === 'undefined' ? '' : window.location.hash);
    return s[0] === BASE[0] && s[1] === BASE[1] && s[2] === 't' && s[3] ? decodeURIComponent(s[3]) : '';
  };
  const [id, setId] = useState(read);
  useEffect(() => {
    const on = () => setId(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const open = useCallback((tid) => { window.location.hash = `#/${BASE.join('/')}${tid ? `/t/${encodeURIComponent(tid)}` : ''}`; }, []);
  return [id, open];
}

/** 목록 폴링 — 조사 중이면 8초, 아니면 30초. 실패해도 직전 값을 지우지 않는다. */
function useMain() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [failedAt, setFailedAt] = useState(null);
  const busyRef = useRef(false);
  const genRef = useRef(0);
  const kickRef = useRef(() => {});
  useEffect(() => {
    let alive = true; let timer = null;
    const loop = async (gen) => {
      if (!alive || gen !== genRef.current) return;
      if (typeof document === 'undefined' || !document.hidden) {
        try {
          const d = await fetchJson('/tools/isilon-dirusage');
          if (!alive || gen !== genRef.current) return;
          setData(d); setError(null); setFailedAt(null);
          busyRef.current = (d?.targets || []).some((t) => t.running || t.request);
        } catch (e) {
          if (!alive || gen !== genRef.current) return;
          setError(e); setFailedAt((x) => x || Date.now());
        }
      }
      if (alive && gen === genRef.current) timer = setTimeout(() => loop(gen), busyRef.current ? 8_000 : 30_000);
    };
    kickRef.current = () => { if (timer) clearTimeout(timer); loop(++genRef.current); };
    loop(++genRef.current);
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, []);
  const reload = useCallback(() => kickRef.current(), []);
  return { data, error, failedAt, reload };
}

/** 키가 같을 때만 결과를 쓰는 조회(늦게 온 다른 대상의 응답을 버린다). */
function useKeyed(path, params, key) {
  const [st, setSt] = useState({ key: null, data: null, error: null, loading: false });
  useEffect(() => {
    if (!key) { setSt({ key: null, data: null, error: null, loading: false }); return undefined; }
    let alive = true;
    setSt((s) => ({ ...s, loading: true }));
    fetchJson(path, params).then(
      (d) => { if (alive) setSt({ key, data: d, error: null, loading: false }); },
      (e) => { if (alive) setSt((s) => ({ ...s, key, error: e, loading: false })); },
    );
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return st.key === key ? st : { key, data: null, error: st.error && st.key === key ? st.error : null, loading: true };
}

function Spark({ values }) {
  const { d, dots } = sparkPath(values, 100, 24);
  if (!d && !dots.length) return <span className="isd-note">—</span>;
  return (
    <svg viewBox="0 0 100 24" width="100" height="24" aria-hidden="true">
      {d ? <path d={d} fill="none" stroke="#2dd4bf" strokeWidth="1.6" /> : null}
      {dots.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r="1.8" fill="#2dd4bf" />)}
    </svg>
  );
}

function Delta({ d, isNew, removed, hasBase }) {
  const v = deltaView(d, { isNew, removed, hasBase });
  return <span className={`isd-delta t-${v.tone}`} title={v.title || undefined}>{v.text}</span>;
}

function TrendChart({ tr, sizeMode }) {
  const W = 460; const H = 180;
  const m = useMemo(() => trendModel(tr?.points, { w: W, h: H, padL: 52 }, { days: tr?.days || 30 }), [tr]);
  if (!m.hasData) return <div className="isd-note">이 기간에 성공한 수집이 없습니다.</div>;
  const desc = `${tr.name ? `${tr.name} 폴더` : '디렉터리 전체'} ${DAY_LABEL[tr.days] || ''} 크기 추이 — 마지막 ${bytesText(m.last?.bytes)}`;
  return (
    <div className="isd-trend">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={desc}>
        {m.yTicks.map((t, i) => (
          <g key={i}>
            <line x1="52" y1={t.y} x2={W - 10} y2={t.y} stroke="#1f2a40" strokeWidth="1" />
            <text x="46" y={t.y + 3.5} fill="#5d6b85" fontSize="10" textAnchor="end" fontFamily="JetBrains Mono, monospace">{t.label}</text>
          </g>
        ))}
        {m.area ? <path d={m.area} fill="#2dd4bf" fillOpacity="0.10" /> : null}
        {m.lines.map((d, i) => <path key={i} d={d} fill="none" stroke="#2dd4bf" strokeWidth="2.2" strokeLinejoin="round" />)}
        {m.solid.map((p, i) => <circle key={`s${i}`} cx={p.x} cy={p.y} r="3" fill="#2dd4bf" />)}
        {m.hollow.map((p, i) => <circle key={`h${i}`} cx={p.x} cy={p.y} r="3.5" fill="none" stroke="#fbbf24" strokeWidth="1.5"><title>권한 오류가 난 수집 — {bytesText(p.bytes)}</title></circle>)}
        {m.last ? <circle cx={m.last.x} cy={m.last.y} r="4" fill="#5eead4" /> : null}
        {m.xTicks.map((t, i) => <text key={i} x={t.x} y={H - 4} fill="#5d6b85" fontSize="10" textAnchor={t.anchor} fontFamily="JetBrains Mono, monospace">{t.label}</text>)}
      </svg>
      {trendNotes(tr, { sizeMode }).map((n, i) => <div key={i} className="isd-note">{n}</div>)}
      {m.breaks ? <div className="isd-note">수집이 비었던 구간 {m.breaks}곳은 선을 잇지 않았습니다.</div> : null}
    </div>
  );
}

/** 서버 정렬 머리글 — 버튼이라 키보드로도 누른다(정렬은 서버가 전체 목록에 대해 한다 — 보이는 쪽만 정렬하지 않는다). */
function SortTh({ label, by, sort, onSort, right = false, plain = false }) {
  const on = sort.by === by && !plain;
  return (
    <th style={right ? { textAlign: 'right' } : undefined} aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="isd-thbtn" onClick={() => onSort(by)}>{label}{on ? (sort.dir === 'desc' ? ' ▼' : ' ▲') : ''}</button>
    </th>
  );
}

/**
 * 첫 화면 '법인별 현황'(v2.737) — 대상을 법인으로 묶어 사용자 폴더 수·크기·상태를 보이고, 누르면 그 대상(사용자별 용량)을 연다.
 * 계산은 isiduText.js corpOverview(순수)가 한다. 합계는 성공한 수집이 있는 대상만이고 그 사실을 문구가 말한다.
 */
function CorpOverview({ targets, now, onOpen, missing }) {
  const ov = useMemo(() => corpOverview(targets, now), [targets, now]);
  const T = ov.totals;
  return (
    <section className="isd-card" aria-label="법인별 현황">
      <div className="isd-cardhead">
        <h3>법인별 현황</h3>
        <div className="isd-note">{overviewNote(T)}</div>
      </div>
      {missing ? <div className="isd-banner amber">주소의 대상 ‘{missing}’ 을 찾지 못했습니다 — 삭제됐거나 이 노드의 대상 목록에 없습니다. 아래에서 다시 고르세요.</div> : null}
      <div className="isd-ovkpis">
        <div className="isd-kpi"><div className="isd-kpi-label">법인</div><div className="isd-kpi-val">{countText(T.corps)}</div><div className="isd-kpi-sub">대상 {countText(T.targets)}개</div></div>
        <div className="isd-kpi"><div className="isd-kpi-label">사용자 폴더 합</div><div className="isd-kpi-val">{countText(T.users)}</div><div className="isd-kpi-sub">수집 결과가 있는 대상 {countText(T.measured)}개</div></div>
        <div className="isd-kpi"><div className="isd-kpi-label">디렉터리 크기 합</div><div className="isd-kpi-val">{bytesText(T.bytes)}</div><div className="isd-kpi-sub">{T.unmeasured ? `결과 없음 ${countText(T.unmeasured)}개 제외` : '모든 대상 포함'}</div></div>
      </div>
      {ov.groups.map((g) => (
        <div key={g.corp || '(none)'} className="isd-ovgroup">
          <div className="isd-ovhead">
            <span className={`isd-dot ${g.worst}`} aria-hidden="true" />
            <b>{g.label}</b>
            <span className="isd-note">대상 {countText(g.items.length)}개 · 사용자 폴더 {countText(g.users)} · {bytesText(g.bytes)}{g.unmeasured ? ` · 결과 없음 ${countText(g.unmeasured)}개` : ''}</span>
          </div>
          <div className="isd-ovgrid">
            {g.items.map(({ t, st, bytes, users }) => {
              const c = targetChip(t);
              return (
                <button key={t.id} type="button" className="isd-ovcard" onClick={() => onOpen(t.id)} title={st.detail || undefined}>
                  <span className="top"><span className={`isd-dot ${st.tone}`} aria-hidden="true" /><b>{t.label || c.device}</b><span className={`isd-tag ${st.tone}`}>{st.text}</span></span>
                  <span className="dev">{c.device} · <span className={`isd-node${t.agent ? ' edge' : ''}`}>{c.node}</span></span>
                  <span className="path isd-mono">{c.path}</span>
                  <span className="nums"><span><small>사용자 폴더</small>{countText(users)}</span><span><small>크기</small>{bytesText(bytes)}</span><span><small>마지막 성공</small>{agoText(t.okScan?.ts, now)}</span></span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
}

function StatusTag({ st }) {
  return <span className={`isd-tag ${st.tone}`} title={st.detail || undefined}>{st.text}</span>;
}

export default function IsilonDirUsageTool() {
  const { data, error, failedAt, reload } = useMain();
  const [hashId, openTarget] = useHashTarget();
  const [showSettings, setShowSettings] = useState(false);
  const [runMsg, setRunMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [trendName, setTrendName] = useState('');
  const [days, setDays] = useState(30);
  const [q, setQ] = useState('');
  const [qDeb, setQDeb] = useState('');
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState({ by: 'size', dir: 'desc' });
  const [offset, setOffset] = useState(0);
  const now = data?.now || Date.now();

  const targets = data?.targets || [];
  // v2.737: 주소에 대상이 없으면 첫 화면은 '법인별 현황' 이다(예전에는 첫 대상이 바로 열려 법인별로 돌아갈 화면이 없었다 — 사용자 요청).
  const target = targets.find((t) => t.id === hashId) || null;
  const missingTarget = !!hashId && !target && targets.length > 0;
  const tid = target?.id || '';
  const okId = target?.okScan?.id ?? '';
  const tryId = target?.lastTry?.id ?? '';

  // 대상이 바뀌면 고른 사용자·쪽·필터를 처음으로.
  useEffect(() => { setTrendName(''); setOffset(0); setFilter('all'); setQ(''); setQDeb(''); }, [tid]);
  useEffect(() => { const h = setTimeout(() => setQDeb(q.trim()), 300); return () => clearTimeout(h); }, [q]);
  useEffect(() => { setOffset(0); }, [qDeb, filter, sort.by, sort.dir]);

  const rep = useKeyed('/tools/isilon-dirusage/report', { target: tid }, tid ? `${tid}|${okId}|${tryId}` : null);
  const tr = useKeyed('/tools/isilon-dirusage/trend', { target: tid, name: trendName, days }, tid ? `${tid}|${okId}|${trendName}|${days}` : null);
  const users = useKeyed('/tools/isilon-dirusage/users',
    { target: tid, q: qDeb, filter, sort: sort.by, dir: sort.dir, offset, limit: PAGE_SIZE },
    tid ? `${tid}|${okId}|${qDeb}|${filter}|${sort.by}|${sort.dir}|${offset}` : null);

  const runNow = async (ids) => {
    setBusy(true); setRunMsg(null);
    try {
      const r = await postJson('/tools/isilon-dirusage/run', ids ? { ids } : {});
      const lines = r?.ok === false ? [] : nudgeLines(r);
      setRunMsg({ tone: r?.ok === false ? 'red' : (lines.some((x) => !x.ok) ? 'amber' : 'teal'), text: r?.ok === false ? (r.reason || '요청하지 못했습니다.') : runResultText(r), lines });
      reload();
    } catch (e) { setRunMsg({ tone: 'red', text: e?.message || String(e) }); } finally { setBusy(false); }
  };
  const exportCsv = async () => {
    try { await downloadFile(`/tools/isilon-dirusage/export.csv?target=${encodeURIComponent(tid)}`); } catch (e) { setRunMsg({ tone: 'red', text: `CSV 내보내기 실패: ${e?.message || e}` }); }
  };
  const sortBy = (by) => setSort((s) => (s.by === by ? { by, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { by, dir: by === 'name' ? 'asc' : 'desc' }));

  if (!data && error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;

  const R = rep.data && rep.data.state ? rep.data : null;
  const st = target ? targetStatus(target, now) : null;
  const drops = collectDropNote(data.drops, (id) => targets.find((t) => t.id === id)?.label || id, now);
  const keys = keyRows(targets, data.key, data.edges);
  const topMax = R?.top?.[0]?.bytes || 0;
  const trendTitle = trendName ? `${trendName} 추이` : '디렉터리 전체 추이';
  const trendCur = tr.data?.points?.length ? tr.data.points[tr.data.points.length - 1] : null;

  return (
    <div className="isd">
      <div className="isd-head">
        <div className="isd-title">
          <h2>아이실론 디렉터리 사용량</h2>
          <div className="isd-sub">지정한 디렉터리 바로 아래 폴더 하나 = 사용자 하나 · <span className="isd-mono">du -A -h -d 1</span> · SSH 키 인증(비밀번호 없음) · 결과는 DB 에 쌓여 추이를 봅니다</div>
        </div>
        <div className="isd-actions">
          {canCsv() ? <button type="button" className="isd-btn" onClick={exportCsv} disabled={!R || R.state !== 'ok'} title={!R || R.state !== 'ok' ? '성공한 수집이 있어야 내보낼 수 있습니다' : '전체 사용자 CSV'}>CSV 내보내기</button> : null}
          <button type="button" className="isd-btn" onClick={() => setShowSettings(true)}>수집 대상 설정</button>
          <button type="button" className="isd-btn primary" onClick={() => runNow(tid ? [tid] : null)} disabled={busy || !tid} title={tid ? undefined : '법인(대상)을 고른 뒤 누르세요 — 전 대상을 한꺼번에 돌리지 않습니다(아래 수집 상태 표의 ‘수집’ 으로도 돌릴 수 있습니다)'}>{busy ? '요청 중…' : '지금 수집'}</button>
        </div>
      </div>

      {error ? <div className="isd-banner amber">목록을 새로 읽지 못했습니다({agoText(failedAt, Date.now())}부터) — 아래는 직전에 받은 값입니다. {String(error?.message || error)}</div> : null}
      {data.settingsLoadError ? <div className="isd-banner red">설정 파일을 읽지 못했습니다 — 저장하면 기존 대상이 사라질 수 있어 저장을 막았습니다. 설정 › 서비스 점검에서 기본값으로 확정하거나 손상 보존본을 복구하세요. ({String(data.settingsLoadError)})</div> : null}
      {data.storageRegistryError ? <div className="isd-banner red">스토리지 등록부를 읽지 못해 장비 주소·담당 노드를 알 수 없습니다 — 설정 › 스토리지를 확인하세요.</div> : null}
      {runMsg ? (
        <div className={`isd-banner ${runMsg.tone}`} role="status">
          <div>{runMsg.text}</div>
          {runMsg.lines?.length ? <ul className="isd-nudge">{runMsg.lines.map((x) => <li key={x.agent} className={x.ok ? 'ok' : 'bad'}>{x.text}</li>)}</ul> : null}
        </div>
      ) : null}
      {drops ? <div className="isd-banner amber"><BoldText text={drops} /></div> : null}
      {!canCsv() ? <div className="isd-note">{CSV_DENIED_NOTE}</div> : null}

      {!targets.length ? (
        <div className="isd-card">
          <h3>수집 대상이 없습니다</h3>
          <div className="isd-note">‘수집 대상 설정’ 에서 아이실론(스토리지 등록부)과 조사할 디렉터리(예: /ifs/data/workspace/users)를 고르세요. 엣지 법인의 아이실론은 그 엣지가 SSH 로 접속해 조사하고 결과를 메인으로 올립니다.</div>
          <div><button type="button" className="isd-btn primary" onClick={() => setShowSettings(true)}>수집 대상 설정</button></div>
        </div>
      ) : target ? (
        <>
          <div className="isd-backrow">
            <button type="button" className="isd-btn small" onClick={() => openTarget('')}>← 법인별 현황</button>
            <span className="isd-note">{targetChip(target).corp ? `${targetChip(target).corp} · ` : ''}{target.label || targetChip(target).label}</span>
          </div>
          <div className="isd-targets" role="tablist" aria-label="수집 대상">
            {targets.map((t) => {
              const c = targetChip(t); const s = targetStatus(t, now);
              return (
                <button key={t.id} type="button" role="tab" aria-selected={t.id === tid} className={`isd-chip${t.id === tid ? ' on' : ''}`} onClick={() => openTarget(t.id)} title={s.detail || undefined}>
                  <span className={`isd-dot ${s.tone}`} aria-hidden="true" />
                  <span className="corp">{t.label || c.corp || c.device}</span>
                  <span className="dev">{c.device}{c.corp && t.label ? ` · ${c.corp}` : ''}</span>
                  <span className="path">{c.path}</span>
                  <span className={`isd-node${t.agent ? ' edge' : ''}`}>{c.node}</span>
                </button>
              );
            })}
          </div>
        </>
      ) : (
        <CorpOverview targets={targets} now={now} onOpen={openTarget} missing={missingTarget ? hashId : ''} />
      )}

      {target ? (
        <>
          {st && st.tone !== 'ok' ? <div className={`isd-banner ${st.tone === 'bad' ? 'red' : st.tone === 'warn' ? 'amber' : st.tone === 'run' ? 'teal' : ''}`}><b>{st.text}</b>{st.detail ? ` — ${st.detail}` : ''}</div> : null}
          {resumeNote(target.lastResume, now) ? <div className="isd-banner amber">{resumeNote(target.lastResume, now)}</div> : null}

          {rep.error && !R ? <ErrorBox error={rep.error} /> : null}
          {!R && !rep.error ? <Loading /> : null}
          {R && R.state === 'db-unavailable' ? <div className="isd-banner red">이 노드에서 디렉터리 사용량 DB 를 쓸 수 없습니다(Node 의 SQLite 지원·디스크를 확인하세요).</div> : null}
          {R && (R.state === 'no-data' || R.state === 'failed-only') ? (
            <div className="isd-card">
              <h3>{R.state === 'failed-only' ? '아직 성공한 수집이 없습니다' : '아직 수집 결과가 없습니다'}</h3>
              {R.state === 'failed-only' && R.lastTry ? (
                <div className="isd-banner red">마지막 시도({agoText(R.lastTry.ts, now)} · {nodeText(R.lastTry.node)}): <b>{failTitle(R.lastTry.kind)}</b>{R.lastTry.error ? ` — ${String(R.lastTry.error).slice(0, 300)}` : ''}<br />{FAIL_TEXT[R.lastTry.kind]?.fix || ''}</div>
              ) : <div className="isd-note">‘지금 수집’ 을 누르거나 다음 주기({everyText(target.intervalHours)})를 기다리세요. 디렉터리가 크면 du 가 수십 분 걸릴 수 있습니다.</div>}
            </div>
          ) : null}

          {R && R.state === 'ok' ? (
            <>
              <div className="isd-kpis">
                {kpiCards(R, target, now).map((k) => (
                  <div key={k.key} className="isd-kpi">
                    <div className="isd-kpi-label">{k.label}</div>
                    <div className="isd-kpi-val">{k.value}</div>
                    {k.bar != null ? <div className="isd-kpi-bar" aria-hidden="true"><div style={{ width: `${Math.max(0, Math.min(100, k.bar * 100))}%` }} /></div> : null}
                    <div className="isd-kpi-sub">{k.sub}</div>
                  </div>
                ))}
              </div>
              {[...scanNotes(R, now), ...(baseNote(R) ? [{ tone: '', text: baseNote(R) }] : [])].map((n, i) => (
                <div key={i} className={`isd-banner ${n.tone}`}><BoldText text={n.text} /></div>
              ))}

              <div className="isd-body">
                <section className="isd-card" aria-label={`사용량 Top ${R.kpi?.topN || 10}`}>
                  <div className="isd-cardhead">
                    <h3>사용량 Top {R.kpi?.topN || 10}</h3>
                    <div className="isd-note">막대 = 1위 대비 · 변화 = 7일 전 수집 대비 · 누르면 오른쪽에 추이</div>
                  </div>
                  {R.top.map((u, i) => (
                    <button key={u.name} type="button" className={`isd-toprow${trendName === u.name ? ' on' : ''}`} onClick={() => setTrendName(u.name)} title={`${u.name} · ${bytesText(u.bytes)} · 비중 ${shareText(u.share)}`}>
                      <span className={`isd-rank${i < 3 ? ' hi' : ''}`}>{u.rank}</span>
                      <span className="isd-who"><b>{u.name}</b><span>{tailPath(R.scan?.path, u.name)}</span></span>
                      <span className="isd-bar" aria-hidden="true"><div className={i < 3 ? 'hi' : ''} style={{ width: `${topMax > 0 ? Math.max(1, Math.round((u.bytes / topMax) * 100)) : 0}%` }} /></span>
                      <span className="isd-size">{bytesText(u.bytes)}</span>
                      <Delta d={u.d7} isNew={u.new7} hasBase={!!R.base7} />
                    </button>
                  ))}
                  <div className="isd-rest">
                    <span>나머지 {countText(Math.max(0, (R.kpi?.users || 0) - R.top.length))}명</span>
                    <span className="isd-mono">{bytesText((R.kpi?.denomBytes || 0) - (R.kpi?.topBytes || 0))} · {shareText(R.kpi?.topShare == null ? null : 1 - R.kpi.topShare)}</span>
                  </div>
                  <div className="isd-note">비중의 분모는 du 가 보고한 디렉터리 합계(루트 바로 아래 파일 포함)입니다. 크기는 1024 단위(du 와 같은 단위 — 1 TB = 1024⁴ 바이트)입니다.</div>
                </section>

                <section className="isd-card" aria-label="추이">
                  <div className="isd-cardhead">
                    <h3>{trendTitle}</h3>
                    <div className="isd-seg" role="group" aria-label="기간">
                      {TREND_DAYS.map((d) => <button key={d} type="button" className={days === d ? 'on' : ''} aria-pressed={days === d} onClick={() => setDays(d)}>{DAY_LABEL[d]}</button>)}
                    </div>
                  </div>
                  <div className="isd-trendsel">
                    {trendName ? <button type="button" className="isd-btn small" onClick={() => setTrendName('')}>← 디렉터리 전체 보기</button> : <span className="isd-note">Top 10·표의 사용자를 누르면 그 폴더의 추이를 봅니다.</span>}
                  </div>
                  <div className="isd-trendval">
                    {bytesText(trendCur?.bytes)}
                    {!trendName && R.kpi?.totalDelta30 ? <small className={`t-${deltaView(R.kpi.totalDelta30).tone}`}>30일 {deltaView(R.kpi.totalDelta30).text}</small> : null}
                  </div>
                  {tr.error && !tr.data ? <ErrorBox error={tr.error} /> : null}
                  {!tr.data && !tr.error ? <Loading /> : null}
                  {tr.data && tr.data.state === 'ok' ? <TrendChart tr={tr.data} sizeMode={R.scan?.sizeMode} /> : null}
                  {tr.data && tr.data.state === 'db-unavailable' ? <div className="isd-banner red">추이를 읽지 못했습니다(DB 를 쓸 수 없습니다).</div> : null}

                  <div className="isd-cardhead" style={{ marginTop: 6 }}><h3>7일 증가 상위</h3></div>
                  {!R.base7 ? <div className="isd-note">7일 전 수집이 없어 계산하지 않았습니다.</div>
                    : R.growth.length ? R.growth.map((g) => (
                      <button key={g.name} type="button" className="isd-growrow" onClick={() => setTrendName(g.name)}>
                        <span className="nm">{g.name}</span>
                        <span className="vals"><span>{bytesText(g.bytes)}</span><Delta d={g.d7} /></span>
                      </button>
                    )) : <div className="isd-note">표기 오차보다 크게 늘어난 폴더가 없습니다.</div>}
                  {R.newTop?.length ? <div className="isd-note">신규(7일): {R.newTop.map((n) => `${n.name} ${bytesText(n.bytes)}`).join(' · ')}</div> : null}
                  {R.removedTop?.length ? <div className="isd-note">사라짐(7일): {R.removedTop.map((n) => n.name).join(' · ')} — 폴더가 지워졌거나 이름이 바뀌었습니다.</div> : null}
                </section>
              </div>

              <section className="isd-card" aria-label="전체 사용자">
                <div className="isd-cardhead">
                  <h3>전체 사용자 <span className="isd-note">{countText(R.kpi?.users)}명</span></h3>
                  <div className="isd-tools">
                    <label className="isd-search">
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
                      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="사용자 이름 검색" aria-label="사용자 이름 검색" maxLength={100} />
                    </label>
                    {USER_FILTERS.map(([k, label]) => (
                      <button key={k} type="button" className={`isd-fchip${filter === k ? ' on' : ''}`} aria-pressed={filter === k} onClick={() => setFilter(k)}
                        disabled={k !== 'all' && !R.base7} title={k !== 'all' && !R.base7 ? '7일 전 수집이 있어야 판정합니다' : undefined}>{label}</button>
                    ))}
                  </div>
                </div>
                {users.error && !users.data ? <ErrorBox error={users.error} /> : null}
                {!users.data && !users.error ? <Loading /> : null}
                {users.data && users.data.state === 'ok' ? (
                  <>
                    <STable className="v3-table" minWidth={860}>
                      <thead>
                        <tr>
                          <SortTh label="순위" by="size" sort={sort} onSort={sortBy} plain />
                          <SortTh label="사용자" by="name" sort={sort} onSort={sortBy} />
                          <SortTh label="크기" by="size" sort={sort} onSort={sortBy} right />
                          <th style={{ textAlign: 'right' }}>비중</th>
                          <SortTh label="7일 변화" by="d7" sort={sort} onSort={sortBy} right />
                          <SortTh label="30일 변화" by="d30" sort={sort} onSort={sortBy} right />
                          <th>30일 흐름</th>
                          <th>상태</th>
                        </tr>
                      </thead>
                      <tbody>
                        {users.data.rows.map((r) => (
                          <tr key={r.name}>
                            <td className="isd-mono">{r.rank ?? '—'}</td>
                            <td>{r.removed ? <span>{r.name}</span> : <button type="button" className="isd-namebtn" onClick={() => setTrendName(r.name)}>{r.name}</button>}</td>
                            <td className="isd-mono" style={{ textAlign: 'right' }}>{bytesText(r.bytes)}</td>
                            <td className="isd-mono" style={{ textAlign: 'right' }}>{r.removed ? '—' : shareText(r.share)}</td>
                            <td style={{ textAlign: 'right' }}><Delta d={r.d7} isNew={r.new7} removed={r.removed} hasBase={users.data.hasBase7} /></td>
                            <td style={{ textAlign: 'right' }}><Delta d={r.d30} isNew={r.new30} removed={r.removed} hasBase={users.data.hasBase30} /></td>
                            <td>{r.removed ? <span className="isd-note">—</span> : <Spark values={r.spark} />}</td>
                            <td>{r.removed ? <span className="isd-tag gone">사라짐</span> : r.new7 === true ? <span className="isd-tag new">신규</span> : null}</td>
                          </tr>
                        ))}
                      </tbody>
                    </STable>
                    <div className="isd-pager">
                      <span className="isd-note">{usersFootNote(users.data, users.data.rows.length)}{filter === 'removed' ? ' 사라진 폴더의 크기는 7일 전 값입니다.' : ''}</span>
                      <span className="isd-actions">
                        <button type="button" className="isd-btn small" disabled={offset <= 0} onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}>이전 {PAGE_SIZE}</button>
                        <button type="button" className="isd-btn small" disabled={offset + users.data.rows.length >= users.data.total} onClick={() => setOffset((o) => o + PAGE_SIZE)}>다음 {PAGE_SIZE}</button>
                      </span>
                    </div>
                  </>
                ) : null}
              </section>
            </>
          ) : null}
        </>
      ) : null}

      <section className="isd-card" aria-label="SSH 키">
        <div className="isd-cardhead">
          <h3>SSH 키 — 아이실론에 등록할 공개키</h3>
          <div className="isd-note">키 인증 대상은 조사하는 노드(메인 또는 그 법인 엣지)의 서비스 계정 키로 접속합니다. 아래 공개키를 그 아이실론 계정의 authorized_keys 에 넣어 두세요. 비밀키는 화면에 나오지 않습니다.</div>
        </div>
        <STable className="v3-table" minWidth={760}>
          <thead><tr><th>노드</th><th>키</th><th>공개키</th><th>대상</th></tr></thead>
          <tbody>
            {keys.map((k) => {
              const ks = k.agent && !k.key ? { text: k.reportedAt ? '키 정보 없음' : '엣지 보고 없음', tone: 'muted' } : keyStatus(k.key);
              return (
                <tr key={k.node}>
                  <td><span className={`isd-node${k.agent ? ' edge' : ''}`}>{k.node}</span></td>
                  <td><span className={`isd-tag ${ks.tone}`}>{ks.text}</span>{k.key?.fingerprint ? <div className="isd-note isd-mono">{k.key.type} · {k.key.fingerprint}</div> : null}{k.key?.error ? <div className="isd-note">{String(k.key.error)}</div> : null}</td>
                  <td style={{ maxWidth: 420 }}>{k.key?.publicKey ? <div className="isd-key">{k.key.publicKey}</div> : <span className="isd-note">{k.agent ? '엣지가 대상을 받고 키를 만든 뒤 다음 push(최대 10분)에 올라옵니다.' : '설정 창에서 ‘키 만들기’ 를 누르세요.'}</span>}</td>
                  <td className="isd-note">{k.targets.length ? k.targets.join(', ') : '키 인증 대상 없음'}</td>
                </tr>
              );
            })}
          </tbody>
        </STable>
      </section>

      {targets.length ? (
        <section className="isd-card" aria-label="수집 상태">
          <div className="isd-cardhead">
            <h3>수집 상태</h3>
            <div className="isd-note">각 노드가 자기 법인 아이실론에 SSH 로 접속해 du 를 돌리고, 엣지 결과는 메인으로 올라옵니다(엣지 push 10분마다).</div>
          </div>
          <STable className="v3-table" minWidth={980}>
            <thead><tr><th>대상</th><th>조사 노드</th><th>아이실론</th><th>경로</th><th>주기</th><th>마지막 성공</th><th>소요</th><th>결과</th><th data-nosort>지금</th></tr></thead>
            <tbody>
              {targets.map((t) => {
                const s = targetStatus(t, now);
                return (
                  <tr key={t.id}>
                    <td><button type="button" className="isd-namebtn" onClick={() => openTarget(t.id)}>{t.label || t.id}</button></td>
                    <td><span className={`isd-node${t.agent ? ' edge' : ''}`} title={t.agentSource === 'override' ? `실행 노드 지정(장비 담당: ${nodeText(t.deviceAgent || '')})` : undefined}>{nodeText(t.agent)}{t.agentSource === 'override' ? ' · 지정' : ''}</span></td>
                    <td>{t.deviceName || t.host || '—'}{t.corp ? <div className="isd-note">{t.corp}</div> : null}</td>
                    <td className="isd-mono" style={{ overflowWrap: 'anywhere' }}>{t.path}</td>
                    <td>{everyText(t.intervalHours)}</td>
                    <td data-sort={t.okScan?.ts ?? ''}>{agoText(t.okScan?.ts, now)}</td>
                    <td>{durationText(t.okScan?.durationMs)}</td>
                    <td><StatusTag st={s} />{s.detail && s.tone !== 'ok' ? <div className="isd-note" style={{ maxWidth: 360, minWidth: 220, whiteSpace: 'normal' }}>{s.detail}</div> : null}</td>
                    <td><button type="button" className="isd-btn small" disabled={busy || !!t.issue} onClick={() => runNow([t.id])}>수집</button></td>
                  </tr>
                );
              })}
            </tbody>
          </STable>
        </section>
      ) : null}

      {showSettings ? (
        <IsiduSettings onClose={() => setShowSettings(false)} onSaved={() => { reload(); }} edges={data.edges} mainKey={data.key} focusId={tid} />
      ) : null}
    </div>
  );
}
