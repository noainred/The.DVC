/**
 * 특수 기능 '포탈 서비스 상태 모니터링'(도구 키 svc-status — 바꾸지 않는다).
 *
 * 사용자 요청(2026-11-26): "지금 포탈에 등록된 vcenter, edge 상태를 자동으로 등록하고 모니터링 하는 기능을 특수기능에 포탈 서비스 상태 모니터링 …
 * 포탈에 등록된 cvp, 스토리지, vcenter 를 모니터링 … 포탈에 등록된 ip/port 형식으로 모니터링". 시안 docs/design/portal-svc-status(아트보드 4장 —
 * Main · Detail · Settings · Narrow) · 컨펌 '좋아 기본값대로 구현해줘'.
 *
 * 설계:
 *  · 판정(상태 · 사유 · 시한 자동 증가 · 평소)은 서버(server/src/svcstatus/judge.js)가 한다. 화면은 서버 state 로 색 · 문구만 고른다(svcStatusText.js).
 *  · 보기 셋을 주소에 싣는다 — '#/tools/svc-status'(메인) · '…/target/<id>'(대상 상세) · '…/settings'(자동 등록 · 설정). 새로 고침 · 공유해도 같은 보기.
 *  · 메인은 DB 최신표만 읽는 가벼운 조회라 30초 폴링(측정 중에는 5초). 상세(추이) · 설정은 마운트 1회 + 새로 고침 단추.
 *    늦게 온 이전 응답은 버린다(메인 세대 번호 · 상세 · 설정 useLatest). 403 · 404 는 다음 폴링을 걸지 않는다.
 *  · 데이터가 있는 상태의 일시 오류는 배너만(직전 값 유지) — 처음부터 실패면 ErrorBox(403 은 권한 안내).
 *  · 400px 은 표 대신 카드(시안 Narrow) · 표는 STable(정렬 · 1440 에서 열이 스크롤 뒤로 가지 않게 측정하는 곳을 접속처 칸 아래로 접었다).
 *  · 설정 파일을 못 읽었으면(loadError.readError) 저장을 잠근다(settingsUnread.js 규약) · 저장 응답은 requireChanged.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, postJson, putJson } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { useNarrowScreen } from '../../components/useNarrowScreen.js';
import { useLatest } from '../../hooks/useLatest.js';
import { isUnderBase } from '../../hooks/hashTab.js';
import { requireChanged } from '../changeResult.js';
import { unreadMarkOf, unreadKind, saveLockedByUnread, shouldReseed } from '../settingsUnread.js';
import { SettingsUnreadBanner } from '../SettingsUnreadBanner.jsx';
import { numOrNull } from '../../numOrNull.js';
import { agoText } from './relTime.js';
import { addressHiddenNote } from './addressHiddenText.js';
import BoldText from '../../components/boldText.jsx';
import {
  BASE, routeOf, hashOf, shouldStopPolling, stateInfo, stateSort, reasonShort, reasonLong, reasonNotes, failText,
  msText, pctText, ratioText, spanText, clockText, sinceText, subText, byText, addrText, corpLabel, whyText,
  countsOf, tilesOf, sideText, legendOf, measureText, lastRunText, edgeNotes, filterRows, kindTabs, matrixOf,
  stripCells, stripHourly, stripSummary, stripHead, eventView, seriesTally, tallyText, sameHostRows, chartModel, hoverAt,
  RANGES, runResultText, SETTING_FIELDS, rangeText, formFromSettings, bodyFromForm, changedLabels, NO_CHANGE_TEXT,
} from './svcStatusText.js';
import './svcStatus.css';

const NARROW_Q = '(max-width: 720px)';

/** 주소(해시) → 보기. 이 도구 밖으로 나가는 해시 변화는 무시한다(언마운트 직전에 메인으로 한 번 튀지 않게). */
function useRoute() {
  const read = () => routeOf(typeof window === 'undefined' ? '' : window.location.hash);
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => { if (isUnderBase(window.location.hash, BASE)) setRoute(read()); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

/**
 * 메인 응답 폴링 — 30초(측정 중 5초). 실패해도 직전 값을 지우지 않는다.
 * 세대 번호: '새로 고침' 이 진행 중인 조회 위에 새 루프를 열어도 지금 세대의 응답만 반영하고 지금 세대만 타이머를 다시 건다.
 */
function useMainData(onData) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [failedAt, setFailedAt] = useState(null);
  const genRef = useRef(0);
  const runningRef = useRef(false);
  const stopRef = useRef(false);
  const tickRef = useRef(null);
  const onDataRef = useRef(onData);
  onDataRef.current = onData;
  const load = useCallback(async (gen) => {
    try {
      const d = await fetchJson('/tools/svc-status');
      if (gen !== genRef.current) return;
      setData(d); setError(null); setFailedAt(null);
      runningRef.current = !!d?.poller?.running;
      stopRef.current = false;
      onDataRef.current?.(d);
    } catch (e) {
      if (gen !== genRef.current) return;
      setError(e); setFailedAt((x) => x || Date.now());
      stopRef.current = shouldStopPolling(e);
    }
  }, []);
  useEffect(() => {
    let alive = true; let timer = null;
    const loop = async (gen) => {
      if (!alive || gen !== genRef.current) return;
      if (typeof document === 'undefined' || !document.hidden) await load(gen);
      if (alive && gen === genRef.current && !stopRef.current) timer = setTimeout(() => loop(gen), runningRef.current ? 5_000 : 30_000);
    };
    tickRef.current = () => { if (timer) clearTimeout(timer); loop(++genRef.current); };
    loop(++genRef.current);
    return () => { alive = false; genRef.current += 1; if (timer) clearTimeout(timer); };
  }, [load]);
  const refresh = useCallback(() => tickRef.current?.(), []);
  return { data, error, failedAt, refresh };
}

/** 상세가 쓰는 규칙 값(주기 · 시한 · 칸 길이 · 최소 엣지 버전) — 메인에서 받아 둔 값이 있으면 그것, 없으면(딥링크) 메인을 한 번 읽는다. */
function useMainOnce(cache) {
  const [main, setMain] = useState(() => cache.current);
  const [mainErr, setMainErr] = useState(null);
  const run = useLatest();
  useEffect(() => {
    if (cache.current) return;
    run(fetchJson('/tools/svc-status'), (x) => { cache.current = x; setMain(x); }, (e) => setMainErr(e));
  }, [cache, run]);
  return { main, mainErr };
}

function Badge({ state }) {
  const s = stateInfo(state);
  return <span className={`badge ${s.tone} ss-badge`}><span aria-hidden="true">{s.mark}</span> {s.label}</span>;
}

const msTone = (state) => (state === 'slow' ? ' ss-t-amber' : state === 'down' ? ' ss-t-red' : '');

/** 24시간 띠 — 칸 값은 서버가 준 그대로(0 정상 · 1 지연 · 2 일시 실패 · 3 끊김 · null 측정 없음). hourly = 두 칸을 하나로(좁은 화면). */
function Strip({ strip, bucketMs, name = '', hourly = false, full = false }) {
  const arr = Array.isArray(strip) ? strip : [];
  if (!arr.length) return <span className="ss-dim">—</span>;
  const b = numOrNull(bucketMs);
  const cells = hourly ? stripCells(stripHourly(arr), b != null ? b * 2 : null) : stripCells(arr, b);
  return (
    <div className={`ss-strip${full ? ' full' : ''}${hourly ? ' hourly' : ''}`} role="img" aria-label={stripSummary(arr, name)}>
      {cells.map((c, i) => <span key={i} className={`ss-sc ${c.cls}`} title={c.title} />)}
    </div>
  );
}

function Banner({ tone = 'info', children }) {
  return <div className={`banner ss-banner${tone === 'warn' ? ' warn' : ''}`} role={tone === 'warn' ? 'alert' : 'status'}>{children}</div>;
}

// ── 메인 ───────────────────────────────────────────────────────────────────

function Main({ cache }) {
  const narrow = useNarrowScreen(NARROW_Q);
  const { data, error, failedAt, refresh } = useMainData((d) => { cache.current = d; });
  const [kind, setKind] = useState('all');
  const [st, setSt] = useState('all');
  const [corp, setCorp] = useState(null);
  const [q, setQ] = useState('');
  const [msg, setMsg] = useState(null);
  const [runBusy, setRunBusy] = useState(false);
  const rows = useMemo(() => (Array.isArray(data?.rows) ? data.rows : []), [data]);
  const tabs = useMemo(() => kindTabs(data?.kinds, rows), [data, rows]);
  const matrix = useMemo(() => matrixOf(rows, data?.kinds), [data, rows]);
  const shown = useMemo(() => filterRows(rows, { kind, state: st, corp, q }), [rows, kind, st, corp, q]);

  if (!data && error) return <ErrorBox message={error} />;
  if (!data) return <Loading label="포탈 서비스 상태" />;

  const now = numOrNull(data.generatedAt) ?? Date.now();
  const tz = { offsetMin: numOrNull(data.offsetMin) ?? undefined };
  const rules = data.rules || {};
  const counts = countsOf(data);
  const tiles = tilesOf(counts, rules, tabs.length);
  const hidden = data.addressHidden === true;
  const running = !!data.poller?.running;
  const lr = lastRunText(data.poller, data.intervalMs, now, tz);
  const ctx = { staleMs: data.staleMs, failThreshold: rules.failThreshold, minEdgeVersion: data.minEdgeVersion };
  const notes = reasonNotes(shown, ctx);
  const eNotes = edgeNotes(data.edges, now, tz);
  const kindLabel = (k) => tabs.find((x) => x.key === k)?.label || k || '—';
  const corpName = corp == null ? '' : (matrix.corps.find((c) => c.key === corp)?.label || corp || '—');
  const sourceErrors = Array.isArray(data.sourceErrors) ? data.sourceErrors : [];
  const mainLe = unreadMarkOf(data);
  const kindsSentence = tabs.length ? tabs.map((x) => x.label).join(' · ') : '엣지 포탈 · vCenter · CVP · 스토리지';

  const runNow = async () => {
    setRunBusy(true); setMsg(null);
    try {
      const r = await postJson('/tools/svc-status/run', {});
      if (r?.ok === false) { setMsg({ tone: 'warn', text: r.reason || r.note || '측정하지 못했습니다.' }); return; }
      setMsg({ tone: 'info', text: runResultText(r) });
      refresh();
    } catch (e) { setMsg({ tone: 'warn', text: e?.message || String(e) }); } finally { setRunBusy(false); }
  };
  const pickCell = (k, c) => {
    const same = kind === k && corp === c;
    setKind(same ? 'all' : k); setCorp(same ? null : c);
  };

  const tr = (r) => {
    const by = byText(r);
    const sub = subText(r);
    const why = whyText(r);
    const addr = addrText(r, hidden);
    const cells = [
      <td key="st" data-sort={stateSort(r.state)} className="ss-nowrap"><Badge state={r.state} /></td>,
      <td key="k" className="ss-nowrap">{r.kindLabel || kindLabel(r.kind)}</td>,
      <td key="c" className="ss-mono ss-nowrap">{corpLabel(r)}</td>,
      <td key="n" className="ss-namecell" data-sort={r.name || ''}>
        <a className="ss-link" href={hashOf('target', r.id)}>{r.name || '—'}</a>
        {r.demo ? <span className="badge purple ss-tag">데모</span> : null}
        {sub ? <div className="ss-sub">{sub}</div> : null}
      </td>,
      <td key="a" className="ss-addrcell" data-sort={addr}>
        <span className="ss-mono">{addr}</span>
        {r.nonDefaultPort && !hidden ? <span className="badge blue ss-tag" title={numOrNull(r.defaultPort) != null ? `이 종류의 기본 포트는 ${r.defaultPort} 입니다` : ''}>기본 포트 아님</span> : null}
        <div className={`ss-sub${by.edge ? ' ss-edge' : ''}`}>{by.text === '—' ? '측정하는 곳 —' : `${by.text} 측정`}</div>
      </td>,
      <td key="ms" className={`ss-r ss-mono ss-nowrap${msTone(r.state)}`} data-sort={numOrNull(r.ms) ?? ''}>{msText(r.ms)}</td>,
      <td key="b" className="ss-r ss-mono ss-nowrap ss-dim" data-sort={numOrNull(r.baseMs) ?? ''}>{msText(r.baseMs)}</td>,
      <td key="av" className="ss-r ss-mono ss-nowrap" data-sort={numOrNull(r.avail24) ?? ''}>{pctText(r.avail24)}</td>,
      <td key="sp"><Strip strip={r.strip} bucketMs={data.bucketMs} name={r.name} /></td>,
      <td key="si" className="ss-since" data-sort={numOrNull(r.since) ?? ''}>
        <span className="ss-nowrap">{sinceText(r.since, now, tz)}</span>
        {why ? <div className="ss-sub">{why}</div> : null}
      </td>,
    ];
    return <tr key={r.id} data-rowid={r.id} className={`ss-tr s-${r.state}`}>{cells}</tr>;
  };

  return (
    <div className="ss">
      <div className="ss-head">
        <div className="ss-title">
          <div className="ss-crumb">특수 기능 · 네트워크</div>
          <div className="ss-titlerow">
            <h2>포탈 서비스 상태 모니터링</h2>
            {data.demo ? <span className="badge purple">데모 데이터</span> : null}
          </div>
          <div className="ss-lead">포탈에 등록된 {kindsSentence} 를 자동으로 대상에 올리고, 등록된 주소:포트로 TCP 연결을 재서 상태를 봅니다. 장비 자체의 건강 상태가 아니라 ‘포탈이 그 포트에 닿는가’ 입니다.</div>
        </div>
        <div className="ss-actions">
          <span className="ss-last" title={lr.title || undefined}>{lr.text}</span>
          <button type="button" className="ss-btn" onClick={runNow} disabled={runBusy || running} title={running ? '측정이 진행 중입니다' : '중앙이 재는 대상을 지금 1회 잽니다(엣지가 재는 대상은 다음 엣지 보고를 기다립니다)'}>{runBusy || running ? '측정 중…' : '지금 측정'}</button>
          <a className="ss-btn" href={hashOf('settings')}>자동 등록 · 설정</a>
        </div>
      </div>

      {error ? <Banner tone="warn">조회가 {agoText(failedAt, Date.now())}부터 실패하고 있어 아래는 직전 값입니다 — {String(error?.message || error)}</Banner> : null}
      {msg ? <Banner tone={msg.tone}>{msg.text}</Banner> : null}
      {data.enabled === false ? <Banner tone="warn">자동 측정이 꺼져 있습니다 — 자동 등록 · 설정에서 켜면 주기마다 잽니다.</Banner> : null}
      {sourceErrors.map((e, i) => <Banner key={`se${i}`} tone="warn">{kindLabel(e?.kind)} 등록부 — {String(e?.reason || '읽지 못했습니다')}</Banner>)}
      {mainLe ? <Banner tone="warn">포탈 서비스 상태 설정 — {String(mainLe.reason || '설정 파일을 읽지 못했습니다')}{data.usingLastGood === true ? ' — 마지막으로 읽은 설정(제외 목록 · 알림 포함)으로 돕니다.' : ''}</Banner> : null}
      {data.dbOk === false || data.poller?.dbOk === false ? <Banner tone="warn">측정 기록 DB 상태가 정상이 아닙니다(서버 표지) — 측정 기록 · 추이가 남지 않을 수 있습니다.</Banner> : null}
      {hidden ? <Banner><BoldText text={addressHiddenNote(data)} /></Banner> : null}
      {numOrNull(data.demoMasked) > 0 ? <Banner>데모 계정 보기 — 실제로 등록된 대상 {data.demoMasked}개는 이 보기에 넣지 않았습니다.</Banner> : null}

      <div className={`ss-tiles${narrow ? ' narrow' : ''}`}>
        {tiles.filter((x) => !(narrow && x.key === 'all')).map((x) => {
          const on = x.key === 'all' ? st === 'all' : st === x.key;
          return (
            <button key={x.key} type="button" className={`ss-tile${on && x.key !== 'all' ? ' on' : ''}${x.tone ? ` tone-${x.tone}` : ''}`} aria-pressed={x.key === 'all' ? undefined : on}
              onClick={() => setSt(x.key === 'all' || on ? 'all' : x.key)} title={x.key === 'all' ? '상태 거르기를 풉니다' : `${x.label}만 보기(다시 누르면 풉니다)`}>
              <span className="ss-tile-label">{x.mark ? <span className="ss-mark" aria-hidden="true">{x.mark}</span> : null}{x.label}</span>
              <span className="ss-tile-n">{x.n}</span>
              {narrow ? null : <span className="ss-tile-sub">{x.sub}</span>}
            </button>
          );
        })}
      </div>
      <div className="ss-note">{sideText(counts)}</div>

      {!narrow ? (
        <section className="ss-card">
          <div className="ss-cardhead">
            <h3>법인 × 종류</h3>
            <span className="ss-note">칸 하나 = 그 법인의 그 종류 대상 중 가장 나쁜 상태 · 빈 칸은 등록된 대상 없음 · 칸을 누르면 아래 표를 그 칸으로 거릅니다</span>
          </div>
          {matrix.corps.length ? (
            <div className="ss-mwrap">
              <div className="ss-matrix" style={{ gridTemplateColumns: `112px repeat(${matrix.corps.length}, minmax(80px, 1fr))`, minWidth: 112 + matrix.corps.length * 86 }}>
                <div />
                {matrix.corps.map((c) => <div key={`h${c.key}`} className="ss-mcorp" title={c.label}>{c.label}</div>)}
                {matrix.lines.map((l) => (
                  <React.Fragment key={l.kind}>
                    <div className="ss-mkind">{l.label}</div>
                    {l.cells.map((c, i) => {
                      if (!c) return <div key={`${l.kind}${i}`} className="ss-mcell empty" title="등록된 대상 없음" />;
                      const s = stateInfo(c.state);
                      const on = kind === l.kind && corp === c.corp;
                      return (
                        <button key={`${l.kind}${i}`} type="button" className={`badge ${s.tone} ss-mcell${on ? ' on' : ''}`} title={c.title} aria-label={c.title} aria-pressed={on} onClick={() => pickCell(l.kind, c.corp)}>
                          <span aria-hidden="true">{s.mark}</span> {s.label}{c.n > 1 ? <span className="ss-mn">{c.n}</span> : null}
                        </button>
                      );
                    })}
                  </React.Fragment>
                ))}
              </div>
            </div>
          ) : <div className="ss-note">대상이 없습니다.</div>}
        </section>
      ) : null}

      <section className="ss-card flush">
        <div className="ss-toolbar">
          <div className="ss-tabs" role="group" aria-label="종류">
            <button type="button" className={`ss-tab${kind === 'all' ? ' on' : ''}`} aria-pressed={kind === 'all'} onClick={() => setKind('all')}>전체 <span className="ss-tabn">{rows.length}</span></button>
            {tabs.map((k) => (
              <button key={k.key} type="button" className={`ss-tab${kind === k.key ? ' on' : ''}`} aria-pressed={kind === k.key} onClick={() => setKind(k.key)}>{k.label} <span className="ss-tabn">{k.n}</span></button>
            ))}
          </div>
          <div className="ss-find">
            <label htmlFor="ss-q">찾기</label>
            <input id="ss-q" className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="법인 · 이름 · 주소" />
            <span className="ss-note">{shown.length}개 표시 · 나쁜 상태가 위</span>
          </div>
        </div>
        {st !== 'all' || corp != null ? (
          <div className="ss-chips">
            {st !== 'all' ? <button type="button" className="ss-chip" onClick={() => setSt('all')} aria-label={`상태 거르기 풀기 — ${stateInfo(st).label}`}>상태: {stateInfo(st).label} ✕</button> : null}
            {corp != null ? <button type="button" className="ss-chip" onClick={() => setCorp(null)} aria-label={`법인 거르기 풀기 — ${corpName}`}>법인: {corpName} ✕</button> : null}
          </div>
        ) : null}

        {!rows.length ? (
          <div className="ss-empty">{sourceErrors.length
            ? '등록부를 읽지 못한 종류가 있습니다(위 안내) — 목록이 비어 보여도 등록이 없는 것이 아닐 수 있습니다.'
            : '등록부에 대상이 없습니다 — 수집 서버 · vCenter · CVP · 스토리지를 등록하면 다음 측정 주기에 대상이 됩니다.'}</div>
        ) : !shown.length ? (
          <div className="ss-empty">조건에 맞는 대상이 없습니다.</div>
        ) : narrow ? (
          <div className="ss-cards">
            {shown.map((r) => {
              const by = byText(r);
              const why = whyText(r);
              return (
                <a key={r.id} className={`ss-rcard s-${r.state}`} href={hashOf('target', r.id)}>
                  <div className="ss-rc1"><Badge state={r.state} /><span className="ss-dim ss-ellip">{r.kindLabel || kindLabel(r.kind)} · <span className="ss-mono">{corpLabel(r)}</span></span></div>
                  <div className="ss-rc2"><span className="ss-rcname">{r.name || '—'}</span><span className={`ss-mono ss-nowrap${msTone(r.state)}`}>{msText(r.ms)}</span></div>
                  <div className="ss-rc3"><span className="ss-mono">{addrText(r, hidden)}</span> <span className={by.edge ? 'ss-edge' : 'ss-dim'}>· {by.text === '—' ? '측정하는 곳 —' : `${by.text} 측정`}</span></div>
                  <Strip strip={r.strip} bucketMs={data.bucketMs} name={r.name} hourly full />
                  <div className="ss-sub">{[sinceText(r.since, now, tz), why].filter((x) => x && x !== '—').join(' · ') || '—'}</div>
                </a>
              );
            })}
          </div>
        ) : (
          <STable minWidth={1060} className="ss-table">
            <thead>
              <tr>
                <th>상태</th>
                <th>종류</th>
                <th>법인</th>
                <th>이름</th>
                <th title="등록된 주소:포트 · 그 아래는 측정하는 곳(중앙 또는 엣지 이름)">접속처 · 측정하는 곳</th>
                <th className="ss-r">연결 시간</th>
                <th className="ss-r">평소</th>
                <th className="ss-r" style={{ whiteSpace: 'normal' }}>24시간 성공률</th>
                <th data-nosort>{stripHead(data.bucketMs, shown.find((r) => Array.isArray(r.strip))?.strip.length ?? null)}</th>
                <th>상태가 바뀐 때</th>
              </tr>
            </thead>
            <tbody>{shown.map(tr)}</tbody>
          </STable>
        )}

        <div className="ss-legend">
          {legendOf(rules).map((l) => {
            const s = stateInfo(l.state);
            return <span key={l.state}><span className={`ss-mark ss-t-${s.tone}`} aria-hidden="true">{s.mark}</span> {l.text}</span>;
          })}
          <span><span className="ss-sw c0" /><span className="ss-sw c1" /><span className="ss-sw c2" /><span className="ss-sw c3" /><span className="ss-sw cn" /> 띠 칸 색은 그 칸의 가장 나쁜 표본 — 정상 · 지연 · 일시 실패(끊김 판정 전 · 옅은 빨강) · 끊김 · 측정 없음{narrow && numOrNull(data.bucketMs) > 0 ? ` · 좁은 화면의 띠는 ${spanText(data.bucketMs * 2)} 칸` : ''}</span>
        </div>
        {notes.length ? (
          <ul className="ss-notes">
            {notes.map((n) => <li key={n.code}><b>{n.short}</b> — {n.long}</li>)}
          </ul>
        ) : null}
        {eNotes.length ? (
          <div className="ss-notes">
            <b>엣지 보고</b>
            <ul>{eNotes.map((x) => <li key={x}>{x}</li>)}</ul>
          </div>
        ) : null}
      </section>
    </div>
  );
}

// ── 상세 ───────────────────────────────────────────────────────────────────

function useWidth(ref) {
  const [w, setW] = useState(900);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((ents) => { const cw = ents[0]?.contentRect?.width; if (cw) setW(Math.max(280, Math.round(cw))); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

function Chart({ d, row, now, tz }) {
  const wrap = useRef(null);
  const w = useWidth(wrap);
  const [hx, setHx] = useState(null);
  const h = w < 600 ? 200 : 260;
  const m = chartModel(d?.series, { w, h, start: d?.start, end: d?.end, baseMs: row?.baseMs, slowAtMs: row?.slowAtMs, now, ...tz });
  const hv = m && hx != null ? hoverAt(m, hx, now, tz) : null;
  const onMove = (e) => {
    const r = e.currentTarget?.getBoundingClientRect?.();
    if (r && r.width) setHx(((e.clientX - r.left) / r.width) * w);
  };
  return (
    <div className="ss-chart" ref={wrap}>
      {!m ? <div className="ss-empty">추이 기간을 알 수 없습니다.</div> : !m.hasData ? <div className="ss-empty">이 기간에 성공한 측정이 없습니다{m.fails.length ? ' — 실패한 칸만 있습니다(위쪽 빨간 표지)' : ''}.</div> : null}
      {m ? (
        <svg viewBox={`0 0 ${m.w} ${m.h}`} role="img" aria-label={`연결 시간 추이 — 평소 ${msText(row?.baseMs)} · 지연 판정선 ${msText(row?.slowAtMs)}`} onPointerMove={onMove} onPointerLeave={() => setHx(null)}>
          {m.grid.map((g) => (
            <g key={g.y}>
              <line className="ss-ch-grid" x1={m.padL} x2={m.w - m.padR} y1={g.y} y2={g.y} />
              <text className="ss-ch-tick" x={m.padL - 6} y={g.y + 4} textAnchor="end">{g.label}</text>
            </g>
          ))}
          {m.xticks.map((x, i) => <text key={x.ts} className="ss-ch-tick" x={x.x} y={m.h - 8} textAnchor={i === 0 ? 'start' : i === m.xticks.length - 1 ? 'end' : 'middle'}>{x.label}</text>)}
          {m.band.map((b) => <path key={b.slice(0, 24)} className="ss-ch-band" d={b} />)}
          {m.baseY != null ? <><line className="ss-ch-base" x1={m.padL} x2={m.w - m.padR} y1={m.baseY} y2={m.baseY} /><text className="ss-ch-lbl" x={m.w - m.padR - 4} y={m.baseY - 5} textAnchor="end">평소 {msText(row?.baseMs)}</text></> : null}
          {m.slowY != null ? <><line className="ss-ch-slow" x1={m.padL} x2={m.w - m.padR} y1={m.slowY} y2={m.slowY} /><text className="ss-ch-lbl slow" x={m.padL + 6} y={m.slowY - 5}>지연 판정선 {msText(row?.slowAtMs)}</text></> : null}
          {m.line.map((p) => <path key={p.slice(0, 24)} className="ss-ch-line" d={p} />)}
          {m.singles.map((p) => <circle key={`s${p.x}`} className="ss-ch-dot" cx={p.x} cy={p.y} r="2.8" />)}
          {m.fails.map((f) => <rect key={`f${f.ts}`} className={`ss-ch-fail${f.down ? '' : ' soft'}`} x={f.x - 2} y={m.padT - 10} width="4" height="8" rx="1"><title>{`${clockText(f.ts, now, tz)} · 실패 ${f.n}회${f.down ? ' · 끊김' : ' · 일시 실패'}`}</title></rect>)}
          {hv ? (
            <g pointerEvents="none">
              <line className="ss-ch-hover" x1={hv.x} x2={hv.x} y1={m.padT} y2={m.h - m.padB} />
              {hv.y != null ? <circle className="ss-ch-dot" cx={hv.x} cy={hv.y} r="4" /> : null}
            </g>
          ) : null}
          <rect x={m.padL} y={m.padT} width={Math.max(0, m.w - m.padL - m.padR)} height={Math.max(0, m.h - m.padT - m.padB)} fill="transparent" />
        </svg>
      ) : null}
      {hv ? (
        <div className={`ss-tip${hv.x / (m?.w || 1) > 0.62 ? ' left' : ''}`} style={{ left: `${(hv.x / (m?.w || 1)) * 100}%` }} role="status">
          <b>{hv.head}</b>
          {hv.lines.map((l) => <span key={l}>{l}</span>)}
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, value, sub, valueClass = '' }) {
  return (
    <div className="ss-stat">
      <div className="ss-stat-label">{label}</div>
      <div className={`ss-stat-val${valueClass ? ` ${valueClass}` : ''}`}>{value}</div>
      {sub ? <div className="ss-stat-sub">{sub}</div> : null}
    </div>
  );
}

function Detail({ id, cache }) {
  const [range, setRange] = useState('24h');
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);
  const [exOpen, setExOpen] = useState(false);
  const [exReason, setExReason] = useState('');
  const runT = useLatest();
  const { main, mainErr } = useMainOnce(cache);
  const load = useCallback(() => {
    setLoading(true);
    runT(fetchJson('/tools/svc-status/target', { id, range }), (x) => { setD(x); setErr(null); setLoading(false); }, (e) => { setErr(e); setLoading(false); });
  }, [id, range, runT]);
  useEffect(() => { load(); }, [load]);

  const back = <a className="ss-link" href={hashOf('main')}>‹ 포탈 서비스 상태 모니터링</a>;
  if (!d && err) return <div className="ss">{back}<ErrorBox message={err} /></div>;
  if (!d) return <Loading label="대상 상세" />;

  const row = d.row || {};
  const now = numOrNull(d.end) ?? Date.now();
  const tz = { offsetMin: numOrNull(main?.offsetMin) ?? undefined };
  const hidden = d.addressHidden === true;
  const by = byText(row);
  const sub = subText(row);
  const ctx = { staleMs: main?.staleMs, failThreshold: main?.rules?.failThreshold, minEdgeVersion: main?.minEdgeVersion };
  const excluded = row.state === 'excluded';
  const tally = d.range === '24h' ? seriesTally(d.series) : null;
  const same = sameHostRows(row, d.sameHost);
  const events = Array.isArray(d.events) ? d.events : [];
  const stale = loading || d.range !== range;
  const sh = stripHead(main?.bucketMs, Array.isArray(row.strip) ? row.strip.length : null);
  const stripTitle = sh === '상태 띠' ? sh : `최근 ${sh} 상태 띠`;

  const nowSub = (() => {
    if (row.state === 'down') return [numOrNull(row.failStreak) > 0 ? `연속 ${row.failStreak}회 실패` : '', failText(row.failKind)].filter(Boolean).join(' · ') || '연결 실패';
    if (row.reason) return reasonShort(row.reason);
    const base = numOrNull(row.baseMs);
    const ratio = ratioText(row.ms, row.baseMs);
    return base == null ? '평소 —' : `평소 ${msText(base)}${ratio ? ` 의 ${ratio}` : ''}`;
  })();

  const runOne = async () => {
    setBusy('run'); setMsg(null);
    try {
      const r = await postJson('/tools/svc-status/run', { id: row.id || id });
      if (r?.ok === false) { setMsg({ tone: 'warn', text: r.reason || r.note || '측정하지 못했습니다.' }); return; }
      setMsg({ tone: 'info', text: runResultText(r) });
      cache.current = null;
      load();
    } catch (e) { setMsg({ tone: 'warn', text: e?.message || String(e) }); } finally { setBusy(''); }
  };
  const setExcluded = async (on) => {
    setBusy('exclude'); setMsg(null);
    try {
      const body = on ? { id: row.id || id, on: true, ...(exReason.trim() ? { reason: exReason.trim() } : {}) } : { id: row.id || id, on: false };
      const r = await postJson('/tools/svc-status/exclude', body);
      if (r?.ok === false) { setMsg({ tone: 'warn', text: r.reason || '바꾸지 못했습니다.' }); return; }
      setMsg({ tone: 'info', text: on ? '측정에서 제외했습니다 — 등록부에서는 지워지지 않습니다.' : '다시 측정 대상에 넣었습니다 — 다음 측정 주기부터 잽니다.' });
      setExOpen(false); setExReason('');
      cache.current = null;
      load();
    } catch (e) { setMsg({ tone: 'warn', text: e?.message || String(e) }); } finally { setBusy(''); }
  };
  const runTitle = row.byEdge ? '엣지가 재는 대상입니다 — 다음 엣지 보고를 기다리세요.' : '이 대상만 지금 1회 잽니다';

  return (
    <div className="ss">
      <div className="ss-head">
        <div className="ss-title">
          <div className="ss-crumb">{back} › {corpLabel(row)} › {row.kindLabel || row.kind || '—'}</div>
          <div className="ss-titlerow">
            <h2>{row.name || '—'}</h2>
            <Badge state={row.state} />
            <span className="ss-mono ss-addr">{addrText(row, hidden)}</span>
            {row.nonDefaultPort && !hidden ? <span className="badge blue ss-tag">기본 포트 아님</span> : null}
            {row.demo ? <span className="badge purple">데모 데이터</span> : null}
          </div>
        </div>
        <div className="ss-actions">
          <button type="button" className="ss-btn" onClick={load} disabled={loading}>{loading ? '불러오는 중…' : '새로 고침'}</button>
          <button type="button" className="ss-btn" onClick={runOne} disabled={!!busy || !!row.byEdge} title={runTitle}>{busy === 'run' ? '측정 중…' : '이 대상만 지금 측정'}</button>
          {excluded
            ? <button type="button" className="ss-btn" onClick={() => setExcluded(false)} disabled={!!busy}>{busy === 'exclude' ? '바꾸는 중…' : '다시 측정'}</button>
            : <button type="button" className="ss-btn" onClick={() => setExOpen((x) => !x)} disabled={!!busy} aria-expanded={exOpen}>측정에서 제외</button>}
        </div>
      </div>

      {err ? <Banner tone="warn">다시 읽지 못해 직전 값을 보여 줍니다 — {String(err?.message || err)}</Banner> : null}
      {msg ? <Banner tone={msg.tone}>{msg.text}</Banner> : null}
      {hidden ? <Banner><BoldText text={addressHiddenNote(d)} /></Banner> : null}
      {mainErr ? <div className="ss-note">주기 · 시한 값을 불러오지 못해 일부 문구에서 숫자를 뺐습니다 — {String(mainErr?.message || mainErr)}</div> : null}
      {exOpen && !excluded ? (
        <div className="ss-exform">
          <label htmlFor="ss-ex-reason">제외 사유(선택)</label>
          <input id="ss-ex-reason" className="input" value={exReason} onChange={(e) => setExReason(e.target.value)} placeholder="예: 이전 작업 중" maxLength={200} />
          <button type="button" className="ss-btn primary" onClick={() => setExcluded(true)} disabled={!!busy}>{busy === 'exclude' ? '바꾸는 중…' : '제외'}</button>
          <button type="button" className="ss-btn" onClick={() => setExOpen(false)} disabled={!!busy}>취소</button>
          <span className="ss-note">제외한 대상은 메인 화면 합계에 넣지 않고 개수만 밝힙니다 · 등록부에서는 지워지지 않습니다.</span>
        </div>
      ) : null}
      {row.reason ? <div className="ss-note">{reasonShort(row.reason)} — {reasonLong(row.reason, ctx) || reasonShort(row.reason)}</div> : null}
      {row.note ? <div className="ss-note">{row.note}</div> : null}

      <div className="ss-stats">
        <Stat label="지금 연결 시간" value={msText(row.ms)} valueClass={`ss-mono${msTone(row.state)}`} sub={[nowSub, numOrNull(row.lastTs) > 0 ? `마지막 측정 ${clockText(row.lastTs, now, { ...tz, sec: true })}` : ''].filter(Boolean).join(' · ')} />
        <Stat label="24시간 성공률" value={pctText(row.avail24)} valueClass="ss-mono" sub={tallyText(tally)} />
        <Stat label="등록 출처" value={`${row.kindLabel || row.kind || '—'} 등록부`} sub={[sub, '등록부의 주소:포트 그대로', row.nonDefaultPort && numOrNull(row.defaultPort) != null ? `기본 포트 ${row.defaultPort} 아님` : ''].filter(Boolean).join(' · ')} />
        <Stat label="측정하는 곳" value={by.text === '중앙' ? '중앙 포탈' : by.text} valueClass={by.edge ? 'ss-edge' : ''} sub={measureText({ intervalMs: main?.intervalMs ?? d.intervalMs, timeoutMs: main?.rules?.timeoutMs })} />
      </div>

      <section className="ss-card">
        <div className="ss-cardhead">
          <h3>연결 시간 추이 <span className="ss-note">TCP 연결이 맺어지기까지{numOrNull(d.stepMs) ? ` · ${spanText(d.stepMs)} 칸 평균` : ''} · 옅은 띠는 칸의 최저~최고</span></h3>
          <div className="ss-seg" role="group" aria-label="기간">
            {RANGES.map(([k, label]) => <button key={k} type="button" className={range === k ? 'on' : ''} aria-pressed={range === k} onClick={() => setRange(k)}>{label}</button>)}
          </div>
        </div>
        <div className={stale ? 'ss-dimmed' : ''}><Chart d={d} row={row} now={now} tz={tz} /></div>
        <div className="ss-note">{stripTitle}</div>
        <Strip strip={row.strip} bucketMs={main?.bucketMs} name={row.name} full />
      </section>

      <div className="ss-split">
        <section className="ss-card flush ss-split-a">
          <div className="ss-cardhead col">
            <h3>같은 주소의 다른 포트</h3>
            <span className="ss-note">{hidden || !row.host ? '같은 주소로 등록부에 올라 있는 대상 전부입니다.' : `등록부에 ${row.host} 로 올라 있는 대상 전부입니다.`} 같은 주소에서 한 포트만 나쁘면 회선보다 그 포트 뒤쪽을 먼저 볼 근거가 됩니다. 포탈은 포트 뒤에 무엇이 있는지 알지 못합니다.</span>
          </div>
          {same.length > 1 ? (
            <STable minWidth={520} className="ss-table">
              <thead><tr><th>상태</th><th>종류</th><th>이름</th><th className="ss-r">포트</th><th className="ss-r">연결 시간</th><th className="ss-r">평소</th></tr></thead>
              <tbody>
                {same.map((x) => (
                  <tr key={x.id || 'self'} data-rowid={x.id} className={x.self ? 'ss-self' : undefined}>
                    {[
                      <td key="s" data-sort={stateSort(x.state)}><Badge state={x.state} /></td>,
                      <td key="k" className="ss-nowrap">{x.kindLabel || x.kind || '—'}</td>,
                      <td key="n" data-sort={x.name || ''}>{x.self ? <>{x.name || '—'} <span className="ss-dim">(이 대상)</span></> : <a className="ss-link" href={hashOf('target', x.id)}>{x.name || '—'}</a>}</td>,
                      <td key="p" className="ss-r ss-mono" data-sort={numOrNull(x.port) ?? ''}>{numOrNull(x.port) ?? '—'}</td>,
                      <td key="m" className={`ss-r ss-mono ss-nowrap${msTone(x.state)}`} data-sort={numOrNull(x.ms) ?? ''}>{msText(x.ms)}</td>,
                      <td key="b" className="ss-r ss-mono ss-nowrap ss-dim" data-sort={numOrNull(x.baseMs) ?? ''}>{msText(x.baseMs)}</td>,
                    ]}
                  </tr>
                ))}
              </tbody>
            </STable>
          ) : <div className="ss-empty">같은 주소에 등록된 다른 대상이 없습니다.</div>}
        </section>
        <section className="ss-card flush ss-split-b">
          <div className="ss-cardhead"><h3>상태가 바뀐 기록</h3>{events.length ? <span className="ss-note">최근 {events.length}건</span> : null}</div>
          {events.length ? (
            <ol className="ss-events">
              {events.map((ev, i) => {
                const v = eventView(ev);
                return (
                  <li key={`${ev.ts}-${i}`}>
                    <span className="ss-mono ss-dim ss-nowrap">{clockText(ev.ts, now, tz)}</span>
                    <span className="ss-evbody">
                      {v.registered ? null : <>{v.from ? <><Badge state={v.from} /> → </> : null}<Badge state={v.to} /></>}
                      {v.text ? <span className="ss-evtext">{v.registered ? '' : ' · '}{v.text}</span> : null}
                    </span>
                  </li>
                );
              })}
            </ol>
          ) : <div className="ss-empty">기록된 상태 변화가 없습니다.</div>}
        </section>
      </div>
    </div>
  );
}

// ── 설정 ───────────────────────────────────────────────────────────────────

function Settings({ cache }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [exBusy, setExBusy] = useState('');
  const [msg, setMsg] = useState(null);
  const seedRef = useRef(null);   // 폼을 채운 조회의 상태(unreadKind) — null 이면 아직 안 채움
  const run = useLatest();
  const apply = useCallback((x, force) => {
    setD(x); setErr(null);
    const le = unreadMarkOf(x);
    // 못 읽은 값으로 채운 폼은 상태가 바뀐 조회로 다시 채운다(편집 중이어도 — 그 편집은 기본값 위의 것이다).
    if (force || seedRef.current == null || shouldReseed(seedRef.current, le)) {
      setForm(formFromSettings(x?.settings));
      seedRef.current = unreadKind(le);
    }
  }, []);
  const load = useCallback(() => {
    setLoading(true);
    run(fetchJson('/tools/svc-status/settings'), (x) => { apply(x, false); setLoading(false); }, (e) => { setErr(e); setLoading(false); });
  }, [run, apply]);
  useEffect(() => { load(); }, [load]);

  const back = <a className="ss-link" href={hashOf('main')}>‹ 포탈 서비스 상태 모니터링</a>;
  if (!d && err) return <div className="ss">{back}<ErrorBox message={err} /></div>;
  if (!d || !form) return <Loading label="자동 등록 · 설정" />;

  const s = d.settings || {};
  const limits = d.limits || {};
  const le = unreadMarkOf(d);
  const saveLocked = saveLockedByUnread(le);
  const sources = Array.isArray(d.sources) ? d.sources : [];
  const excluded = Array.isArray(s.excluded) ? s.excluded : [];
  const totalTargets = sources.reduce((a, x) => a + (numOrNull(x?.targets) ?? 0), 0);
  const kindLabel = (k) => sources.find((x) => x.kind === k)?.label || k || '—';
  const days = numOrNull(cache.current?.rules?.baselineDays);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const save = async () => {
    if (saveLocked) return;
    const { body, issues, kept } = bodyFromForm(form, s, limits);
    if (issues.length) { setMsg({ tone: 'warn', text: issues.map((x) => `${x.label}: ${x.reason}`).join(' · ') }); return; }
    const keptNote = kept.length ? ` 비었거나 0 이하라 현재 값을 유지한 칸: ${kept.join(' · ')}.` : '';
    if (!changedLabels(body, s).length) { setMsg({ tone: 'info', text: `${NO_CHANGE_TEXT}${keptNote}` }); return; }
    setBusy(true); setMsg(null);
    try {
      const x = requireChanged(await putJson('/tools/svc-status/settings', body));
      if (x?.settings) apply(x, true); else load();
      cache.current = null;
      setMsg({ tone: 'info', text: `저장했습니다.${keptNote}` });
    } catch (e) {
      setMsg({ tone: 'warn', text: e?.message || String(e) });
      if (e?.body?.code === 'settings-unreadable') load();   // 서버가 못 읽는 중이라 거절 — 표지를 다시 받아 저장을 잠근다
    } finally { setBusy(false); }
  };
  const unexclude = async (id) => {
    setExBusy(id); setMsg(null);
    try {
      const r = await postJson('/tools/svc-status/exclude', { id, on: false });
      if (r?.ok === false) { setMsg({ tone: 'warn', text: r.reason || '바꾸지 못했습니다.' }); return; }
      if (Array.isArray(r?.excluded)) setD((x) => ({ ...x, settings: { ...(x?.settings || {}), excluded: r.excluded } })); else load();
      cache.current = null;
      setMsg({ tone: 'info', text: '다시 측정 대상에 넣었습니다 — 다음 측정 주기부터 잽니다.' });
    } catch (e) { setMsg({ tone: 'warn', text: e?.message || String(e) }); } finally { setExBusy(''); }
  };

  return (
    <div className="ss">
      <div className="ss-head">
        <div className="ss-title">
          <div className="ss-crumb">{back} › 자동 등록 · 설정</div>
          <h2>자동 등록 · 측정 설정</h2>
          <div className="ss-lead">대상은 손으로 넣지 않습니다. 아래 등록부에서 계산하며, 등록부에 장비를 더하거나 주소 · 포트를 바꾸면 다음 측정 주기에 대상도 따라 바뀝니다. 관리자(전체 범위)만 볼 수 있는 화면입니다.</div>
        </div>
        <div className="ss-actions">
          <button type="button" className="ss-btn" onClick={load} disabled={loading}>{loading ? '불러오는 중…' : '새로 고침'}</button>
        </div>
      </div>

      <SettingsUnreadBanner le={le} what="포탈 서비스 상태 설정" save="저장" lastGood={d.usingLastGood === true} />
      {err ? <Banner tone="warn">다시 읽지 못해 직전 값을 보여 줍니다 — {String(err?.message || err)}</Banner> : null}

      <label className="ss-switch">
        <input type="checkbox" checked={!!form.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        <span><b>자동 측정 켜기</b><small>끄면 주기 측정을 멈춥니다 — 대상 목록과 마지막 기록은 그대로 남습니다.</small></span>
      </label>

      <section className="ss-card flush">
        <div className="ss-cardhead">
          <h3>대상을 가져오는 등록부</h3>
          <span className="ss-note">대상 {totalTargets}개</span>
        </div>
        <STable minWidth={900} className="ss-table">
          <thead>
            <tr><th>측정</th><th>종류</th><th>등록부(설정 화면)</th><th className="ss-r">등록</th><th className="ss-r">대상</th><th>접속처를 정하는 규칙</th><th>측정하는 곳</th></tr>
          </thead>
          <tbody>
            {sources.map((x) => {
              const on = form.kinds?.[x.kind] !== false;
              return (
                <tr key={x.kind}>
                  {[
                    <td key="on"><input type="checkbox" checked={on} onChange={(e) => set({ kinds: { ...form.kinds, [x.kind]: e.target.checked } })} aria-label={`${x.label || x.kind} 측정`} /></td>,
                    <td key="k" className="ss-nowrap">{x.label || x.kind}</td>,
                    <td key="r">{x.hash ? <a className="ss-link" href={x.hash}>{x.settings || x.hash}</a> : (x.settings || '—')}</td>,
                    <td key="n" className="ss-r ss-mono" data-sort={numOrNull(x.registered) ?? ''}>{numOrNull(x.registered) ?? '—'}</td>,
                    <td key="t" className="ss-r ss-mono" data-sort={numOrNull(x.targets) ?? ''}>{numOrNull(x.targets) ?? '—'}</td>,
                    <td key="rule" className="ss-wrap">{x.rule || '—'}</td>,
                    <td key="by" className="ss-wrap">{x.measuredBy || '—'}</td>,
                  ]}
                </tr>
              );
            })}
          </tbody>
        </STable>
        {!sources.length ? <div className="ss-empty">등록부 정보를 받지 못했습니다.</div> : null}
        <div className="ss-foot">‘사용 안 함’ 으로 등록된 장비는 대상에 올리되 측정하지 않고 ‘꺼짐’ 으로 따로 보입니다. 등록부 파일을 읽지 못하면 그 종류의 대상을 지우지 않고 마지막 목록을 유지하며 화면 위에 알립니다.</div>
      </section>

      <div className="ss-split">
        <section className="ss-card ss-split-a">
          <h3>측정</h3>
          <div className="ss-fields">
            {SETTING_FIELDS.map((fd) => (
              <div key={fd.key} className="ss-field">
                <label htmlFor={`ss-f-${fd.key}`}>{fd.label}</label>
                <input id={`ss-f-${fd.key}`} className="input" inputMode="decimal" value={form[fd.key] ?? ''} onChange={(e) => set({ [fd.key]: e.target.value })} />
                <small>{rangeText(fd, limits) ? `범위 ${rangeText(fd, limits)}` : ''}</small>
              </div>
            ))}
          </div>
          <div className="ss-note">‘평소’ 는 대상마다 {days != null ? `최근 ${days}일` : '최근'} 연결 시간의 중앙값입니다. 폴란드 · 미국 동부처럼 원래 연결이 오래 걸리는 대상이 늘 ‘지연’ 으로 뜨지 않게 고정 기준 대신 대상별 기준을 씁니다. 연결 시한은 평소가 큰 대상에서 서버가 자동으로 늘립니다. 빈 칸 · 0 이하는 현재 값을 유지합니다.</div>
        </section>
        <section className="ss-card ss-split-b">
          <h3>알림</h3>
          <label className="ss-check">
            <input type="checkbox" checked={!!form.alertDown} onChange={(e) => set({ alertDown: e.target.checked })} />
            <span>끊김으로 바뀔 때 · 복구될 때 메일을 보냅니다</span>
          </label>
          <label className="ss-check">
            <input type="checkbox" checked={!!form.alertSlow} onChange={(e) => set({ alertSlow: e.target.checked })} />
            <span>지연으로 바뀔 때도 보냅니다</span>
          </label>
          <div className="ss-check">
            <input id="ss-unk-on" type="checkbox" checked={!!form.unknownOn} onChange={(e) => set({ unknownOn: e.target.checked })} />
            <span>
              <label htmlFor="ss-unk-on">‘못 잼’ 이 이어지면 보냅니다 — </label>
              <input className="input ss-mininput" inputMode="numeric" value={form.unknownMin} onChange={(e) => set({ unknownMin: e.target.value })} disabled={!form.unknownOn} aria-label="‘못 잼’ 알림 — 이어진 시간(분)" />
              <label htmlFor="ss-unk-on"> 분 넘게</label>
              <small>엣지가 측정값을 올리지 않는 상태를 조용히 두지 않기 위한 것입니다.</small>
            </span>
          </div>
          <div className="ss-field">
            <label htmlFor="ss-to">받는 사람(쉼표로 여럿)</label>
            <input id="ss-to" className="input" value={form.to} onChange={(e) => set({ to: e.target.value })} placeholder="받는 사람 메일 주소" />
          </div>
          {d.mail ? (
            <div className="ss-note">메일 종류 ‘{d.mail.kindLabel || d.mail.kind || '—'}’{d.mail.configured === false ? ' — 메일 발송 설정이 없어 알림 메일이 나가지 않습니다.' : ''}</div>
          ) : null}
        </section>
      </div>

      <section className="ss-card flush">
        <div className="ss-cardhead">
          <h3>측정에서 제외한 대상</h3>
          <span className="ss-note">등록부에서는 지워지지 않습니다 · 제외한 대상은 메인 화면 합계에 넣지 않고 개수만 밝힙니다 · 제외는 대상 상세에서 합니다</span>
        </div>
        {excluded.length ? (
          <ul className="ss-exlist">
            {excluded.map((x) => (
              <li key={x.id}>
                <div className="ss-exinfo">
                  <span className="ss-dim">{x.kindLabel || kindLabel(x.kind)}</span>
                  {x.present === false ? <span>{x.name || x.id}</span> : <a className="ss-link" href={hashOf('target', x.id)}>{x.name || x.id}</a>}
                  {x.present === false ? <span className="badge gray ss-tag">지금 등록부에 없음</span> : null}
                  <span className="ss-mono ss-dim">{x.address || '—'}</span>
                  <span className="ss-note">제외 {clockText(x.at, Date.now(), { date: true })}{x.by ? ` · ${x.by}` : ''}{x.reason ? ` · 사유: ${x.reason}` : ''}</span>
                </div>
                <button type="button" className="ss-btn" onClick={() => unexclude(x.id)} disabled={!!exBusy}>{exBusy === x.id ? '바꾸는 중…' : '다시 측정'}</button>
              </li>
            ))}
          </ul>
        ) : <div className="ss-empty">제외한 대상이 없습니다.</div>}
      </section>

      {msg ? <Banner tone={msg.tone}>{msg.text}</Banner> : null}
      <div className="ss-savebar">
        <a className="ss-btn" href={hashOf('main')}>취소</a>
        <button type="button" className="ss-btn primary" onClick={save} disabled={busy || saveLocked} title={saveLocked ? '설정 파일을 읽지 못한 동안은 저장을 잠급니다' : undefined}>{busy ? '저장 중…' : '저장'}</button>
      </div>
    </div>
  );
}

export default function SvcStatusTool() {
  const route = useRoute();
  const cache = useRef(null);   // 마지막 메인 응답(규칙 값 · 종류 라벨) — 상세 · 설정이 숫자를 박지 않고 쓴다
  if (route.view === 'target') return <Detail key={route.id} id={route.id} cache={cache} />;
  if (route.view === 'settings') return <Settings cache={cache} />;
  return <Main cache={cache} />;
}
