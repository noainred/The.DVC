/**
 * components/Palette.jsx — 헤더 ⌘K 찾기(v2.508 기능 · 탭 → v2.909 장비 · 기능 · 탭).
 *
 * v2.909(사용자 요청 · 시안 docs/design/inventory-search · 컨펌 2026-11-05): 등록된 모든 인벤토리의 장비(가상머신 · VM호스트 · 베어메탈 ·
 *   GPU 서버 · 스토리지 · SAN · 네트워크 스위치 · PDU · 데이터스토어 · vCenter · IP 대장)를 함께 찾는다.
 *   - 장비 결과는 서버(`GET /search/inventory`)가 범위 · 권한 · 주소 가림을 적용해 준다 — 여기서 다시 판정하지 않는다.
 *   - 기능 · 탭 찾기는 지금처럼 브라우저 안에서(palette.js) — 장비 색인을 못 읽어도 팔레트는 동작한다.
 *   - 150ms 디바운스 · 이전 요청 취소 · 순번으로 **늦게 온 이전 응답은 버린다**. 폴링 없음.
 *   - 잘라낸 개수는 화면에 밝힌다(조용히 자르면 "검색해도 안 나온다" 가 된다) — 묶음 머리의 ‘<화면>에서 모두 보기’ 는 그 화면의 필터로 넘긴다.
 *
 * 후보 계산 · 매칭(기능 · 탭)은 palette.js, 장비 쪽 표시 · 주소 · 최근 항목은 invSearchQuery.js(둘 다 순수 — 웹 테스트가 node 환경).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { can, toolAllowed, fetchJson } from '../api.js';
import { TOOLS } from '../views/specialToolsList.js';
import { visibleTools, lockReasonOf } from '../views/toolVisibility.js'; // v2.613 CATALOG2613-07: 잠금 사유도 같은 모듈
import { search, flatten, catsOfFrom } from './palette.js';
import { handoffMany, stashForNewTab } from '../hooks/searchHandoff.js'; // v2.616 검색어 인계 — 검색어 · IP · 시리얼을 URL 에 싣지 않는다(v2.911 여러 칸)
import { modKeyLabel } from '../views/headerText.js';
import {
  KIND_LABEL, KIND_SHORT, MODE_LABEL, splitPrefix, focusPlan, listPlan, canFilter, LIST_SCREEN, TO_LABEL,
  readRecent, pushRecent, clearRecent, recentKeyFor, recentIdsParam, VIA_LABEL, agoText, builtAgoText, highlightParts, metaParts,
} from './invSearchQuery.js';

const KIND_TAG = { tool: '기능', tab: '탭' };
const DEBOUNCE_MS = 150;
const MIN_TEXT = 2;
const MIN_FIELD = 3;

function Hl({ text, needle }) {
  const [a, b, c] = highlightParts(text, needle);
  return <>{a}{b && <mark className="inv-hl">{b}</mark>}{c}</>;
}

/*
 * v2.911(A4): 검색 결과로 돌아가기 — 결과를 골라 이동한 뒤 ⌘K 를 다시 열면 직전 검색어 · 종류 칩이 그대로 있다(입력 칸 글자는 선택돼 있어
 *   새로 치면 바로 바뀐다). 모듈 메모리(새로 고침하면 사라진다 — 검색어는 저장소에 남기지 않는다) · 10분이 지나면 버린다.
 */
const LAST_TTL_MS = 10 * 60_000;
let _lastSearch = null; // { q, kindSel, at }
function takeLast(now = Date.now()) {
  const l = _lastSearch;
  return l && now - l.at <= LAST_TTL_MS ? l : null;
}

export default function Palette({ onClose, onPick, isAdmin, username = '', toolsAllowed = null, tabs = [] }) {
  const [restored] = useState(() => takeLast());
  const [q, setQ] = useState(() => restored?.q || '');
  const [cur, setCur] = useState(0);
  const [catCfg, setCatCfg] = useState(null);
  const [kindSel, setKindSel] = useState(() => restored?.kindSel || null); // 칩으로 고른 종류(접두와 별개 — IP 대장 칩은 접두로 표현할 수 없다)
  const [inv, setInv] = useState(null);             // 마지막으로 받은 장비 응답(지금 입력의 것만)
  const [stats, setStats] = useState(null);         // 빈 입력 — 종류별 개수
  const [invErr, setInvErr] = useState(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);            // '다시 시도'
  const recentKey = useMemo(() => recentKeyFor(username), [username]); // 계정별(반증 L-4) — App 이 넘기는 로그인 계정
  const [recent, setRecent] = useState(() => readRecent(undefined, recentKey));
  // v2.927(B4): 최근 연 장비를 서버에 알려 같은 검색에서 앞으로(이미 보이는 행 안에서 순서만 — 서버가 범위 · 권한을 다시 건다).
  const recentParam = useMemo(() => recentIdsParam(recent), [recent]);
  const inputRef = useRef(null);
  const seqRef = useRef(0);

  // 분류명은 특수 기능 카드 그리드와 같은 설정을 읽는다. 못 읽으면 분류명 없이 찾는다(편의 기능 — 검색 자체는 동작해야 한다).
  useEffect(() => {
    let alive = true;
    fetchJson('/admin/tool-categories')
      .then((r) => { if (alive && r && r.settings && typeof r.settings === 'object') setCatCfg(r.settings); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  const catsOf = useMemo(() => catsOfFrom(catCfg), [catCfg]);
  // 관리자 전용 도구는 비관리자에게 제안하지 않는다(내비 트리와 같은 규칙 — 판정은 views/toolVisibility.js 하나).
  // ⚠ 의존성 키는 JSON — 빈 배열(전면 차단)과 null(재정의 없음)을 구분해야 한다.
  const allowKey = JSON.stringify(toolsAllowed ?? null);
  const tools = useMemo(
    () => visibleTools(TOOLS, { isAdmin, toolsAllowed: JSON.parse(allowKey), hideAdminOnly: true }),
    [isAdmin, allowKey],
  );
  const toolShown = useMemo(() => new Set(tools.map((t) => t.k)), [tools]);
  const pre = useMemo(() => splitPrefix(q), [q]);
  const text = pre.rest.trim();
  const needle = text.toLowerCase();
  const minLen = pre.mode === 'all' ? MIN_TEXT : MIN_FIELD;
  const devActive = text.length >= minLen;
  // 접두를 쓴 입력(vm: · ip: …)은 장비만 찾는 뜻이다 — 기능 · 탭은 섞지 않는다.
  const res = useMemo(() => search(pre.prefix ? '' : q, { tools, tabs, catsOf }), [q, pre.prefix, tools, tabs, catsOf]);
  const toolRows = useMemo(() => flatten(res, { catsOf }), [res, catsOf]);
  const byKey = useMemo(() => new Map(TOOLS.map((t) => [t.k, t])), []);
  const lockOf = useMemo(() => {
    const allow = JSON.parse(allowKey);
    return (k) => lockReasonOf(byKey.get(k), { isAdmin, toolsAllowed: allow, can, toolAllowed });
  }, [isAdmin, allowKey, byKey]);

  // 빈 입력의 '찾는 범위'(종류별 개수) — 열 때 한 번.
  useEffect(() => {
    let alive = true;
    fetchJson('/search/inventory', {}, undefined, { retries: 0 })
      .then((r) => { if (alive) setStats(r); })
      .catch((e) => { if (alive) setInvErr(e?.message || String(e)); });
    return () => { alive = false; };
  }, [nonce]);

  // 장비 검색 — 디바운스 · 이전 요청 취소 · 늦은 응답 버림.
  useEffect(() => {
    const seq = ++seqRef.current;
    if (!devActive) { setInv(null); setLoading(false); return undefined; }
    const ctl = new AbortController();
    setLoading(true);
    const t = setTimeout(() => {
      fetchJson('/search/inventory', { q: q.trim(), kinds: kindSel || undefined, recent: recentParam || undefined }, ctl.signal, { retries: 0 })
        .then((r) => { if (seq === seqRef.current) { setInv(r); setInvErr(null); setLoading(false); } })
        .catch((e) => {
          if (ctl.signal.aborted || seq !== seqRef.current) return;
          setInvErr(e?.message || String(e)); setInv(null); setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [q, kindSel, devActive, nonce, recentParam]);

  useEffect(() => { inputRef.current?.focus(); if (restored) inputRef.current?.select(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setCur(0); }, [q, kindSel, inv]);

  const groups = useMemo(() => (devActive && inv?.groups ? inv.groups : []), [devActive, inv]);
  const kindsMeta = useMemo(() => (inv || stats)?.kinds || [], [inv, stats]);
  const counts = useMemo(() => (devActive ? inv?.counts : stats?.counts) || {}, [devActive, inv, stats]);
  const errors = (inv || stats)?.errors || {};
  const lockedKinds = kindsMeta.filter((k) => k.locked);
  const errKinds = Object.keys(errors).filter((k) => KIND_LABEL[k]);

  // 커서가 도는 한 줄 목록 — 장비 행 → 기능 · 탭(시안 ①) · 빈 입력이면 최근 항목.
  const flat = useMemo(() => {
    if (!q.trim()) return recent.map((r) => ({ type: 'recent', key: `r:${r.plan.hash}|${r.at}`, plan: r.plan, item: r }));
    const dev = [];
    for (const g of groups) for (const row of g.rows) dev.push({ type: 'dev', key: `d:${row.kind}:${row.id}:${row.name}`, plan: focusPlan(row), row });
    return [...dev, ...toolRows.map((it) => ({ type: 'tool', key: `${it.kind}:${it.k || it.id}`, plan: { hash: it.hash, handoffs: [] }, it }))];
  }, [q, recent, groups, toolRows]);

  // 이동 = 주소 + (있으면) 검색어 인계. 인계를 먼저 남기고 주소를 바꾼다 — 이미 열린 화면은 구독으로, 새로 열리는 화면은 마운트 때 받는다.
  //   새 탭(⌘/Ctrl+Enter)은 다른 문서라 메모리 인계가 닿지 않는다 — 주소만 연다(검색어는 그 탭에서 다시).
  const go = (plan, newTab = false) => {
    if (!plan || !plan.hash) return;
    if (newTab) {
      // v2.927(A5): 넘길 것이 있으면 일회용 칸 + 창 이름으로(searchHandoff.stashForNewTab — 주소에는 싣지 않는다). 같은 출처라 opener 만 끊는다.
      try {
        const name = (plan.handoffs || []).length ? stashForNewTab(plan.handoffs) : '';
        const w = window.open(`${window.location.pathname}${window.location.search}${plan.hash}`, name || '_blank');
        if (w) { try { w.opener = null; } catch { /* 무시 */ } }
      } catch { /* 팝업 차단 */ }
      return;
    }
    if (q.trim()) _lastSearch = { q, kindSel, at: Date.now() };
    handoffMany(plan.handoffs || []);
    onPick(plan.hash);
  };
  const pick = (item, newTab = false) => {
    if (!item || !item.plan) return;
    if (item.type === 'dev') setRecent(pushRecent({ kind: item.row.kind, id: item.row.id, name: item.row.name, corp: item.row.corp, plan: item.plan }, undefined, Date.now(), recentKey));
    go(item.plan, newTab);
  };
  const goList = (kind) => go(listPlan(kind, text));

  // Tab 은 종류 칩을 돈다(시안 ⑤ⓘ) — 개수가 있는 종류만.
  const chipCycle = useMemo(() => [null, ...kindsMeta.filter((k) => !k.locked && (counts[k.key] || 0) > 0).map((k) => k.key)], [kindsMeta, counts]);
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (kindSel) { setKindSel(null); return; }
      if (pre.prefix) { setQ(pre.rest); return; }
      onClose(); return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setCur((i) => Math.min(flat.length - 1, i + 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setCur((i) => Math.max(0, i - 1)); return; }
    if (e.key === 'Enter' && flat[cur]) { e.preventDefault(); pick(flat[cur], e.metaKey || e.ctrlKey); return; }
    if (e.key === 'Tab' && devActive && chipCycle.length > 1) {
      e.preventDefault();
      const i = chipCycle.indexOf(kindSel);
      const n = chipCycle.length;
      setKindSel(chipCycle[((i < 0 ? 0 : i) + (e.shiftKey ? n - 1 : 1)) % n]);
    }
  };

  const omittedTools = res.toolsOmitted + res.tabsOmitted;
  const devShown = groups.reduce((n, g) => n + g.rows.length, 0);
  const devHidden = inv ? Math.max(0, (inv.matched || 0) - devShown) : 0;
  const builtAgo = builtAgoText((inv || stats)?.builtAt);
  const noDevice = devActive && inv && !loading && (inv.matched || 0) === 0;
  const nothing = q.trim() && !loading && toolRows.length === 0 && (!devActive || noDevice);
  const modeBadge = pre.prefix ? (pre.kind ? KIND_LABEL[pre.kind] : MODE_LABEL[pre.mode]) : '';
  let idx = -1;
  // v2.927(C2): 스크린리더 — 입력칸이 combobox, 목록이 listbox, 커서 줄이 aria-activedescendant(포커스는 입력칸에 둔 채).
  const optProps = (i) => ({ id: `inv-opt-${i}`, role: 'option', 'aria-selected': i === cur, tabIndex: -1 });
  const srStatus = loading ? '찾는 중'
    : !q.trim() ? ''
      : `${devActive && inv ? `장비 ${(inv.matched || 0).toLocaleString('ko-KR')}건${devHidden > 0 ? `(표시 ${devShown})` : ''} · ` : ''}기능 · 탭 ${toolRows.length}개`;

  return (
    <div className="v4-palette-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="v4-palette inv-pal" role="dialog" aria-label="장비 · 기능 찾기">
        <div className="v4-palette-in">
          <span className="v3-mono" aria-hidden="true">⌕</span>
          {modeBadge && (
            <button type="button" className="inv-pfx" title="접두 지우기" onClick={() => { setQ(pre.rest); inputRef.current?.focus(); }}>
              {modeBadge} <span aria-hidden="true">×</span>
            </button>
          )}
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} maxLength={256}
            aria-label="장비 · 기능 찾기" role="combobox" aria-autocomplete="list" aria-controls="inv-pal-list"
            aria-expanded={flat.length > 0} aria-activedescendant={flat[cur] ? `inv-opt-${cur}` : undefined}
            placeholder="장비 · 기능 찾기 — 이름 · 호스트명 · IP · 시리얼 · 모델 · 기능 이름" />
          {devActive && inv && <span className="v3-faint inv-count">{(inv.matched || 0).toLocaleString('ko-KR')}건</span>}
          {loading && <span className="v3-faint inv-count">찾는 중…</span>}
          <span className="v3-kbd">ESC</span>
          <span className="inv-sr" role="status" aria-live="polite">{srStatus}</span>
        </div>

        {devActive && kindsMeta.length > 0 && (inv?.matched || 0) > 0 && (
          <div className="inv-chips" role="group" aria-label="종류">
            <button type="button" className={`inv-chip${!kindSel && !pre.kind ? ' on' : ''}`} onClick={() => setKindSel(null)}>
              전체 <span className="n">{Object.values(counts).reduce((a, b) => a + (b || 0), 0).toLocaleString('ko-KR')}</span>
            </button>
            {kindsMeta.map((k) => (k.locked
              ? <span key={k.key} className="inv-chip lock" title={k.reason}>🔒 {k.label}</span>
              : (
                <button key={k.key} type="button" title={`접두 ${k.key === 'ip' ? '(칩으로만)' : `${k.prefix}:`}`}
                  className={`inv-chip${(kindSel || pre.kind) === k.key ? ' on' : ''}${(counts[k.key] || 0) === 0 ? ' zero' : ''}`}
                  onClick={() => setKindSel(kindSel === k.key ? null : k.key)}>
                  {k.label} <span className="n">{(counts[k.key] || 0).toLocaleString('ko-KR')}</span>
                </button>
              )))}
          </div>
        )}

        {invErr && (
          <div className="inv-band err" role="alert">
            <b>장비 색인을 읽지 못했습니다</b> — 기능 · 탭만 찾습니다. <span className="v3-faint">({invErr})</span>{' '}
            <button type="button" className="inv-link" onClick={() => { setInvErr(null); setNonce((n) => n + 1); }}>다시 시도</button>
          </div>
        )}
        {errKinds.length > 0 && (
          <div className="inv-band warn" role="status">
            <b>{errKinds.map((k) => KIND_LABEL[k]).join(' · ')}</b> 출처를 읽지 못했습니다 — 그 종류의 결과가 빠져 있을 수 있습니다.
          </div>
        )}
        {devActive && lockedKinds.length > 0 && (
          <div className="inv-band info">
            <b>{lockedKinds.map((k) => k.label).join(' · ')}</b> 는 {lockedKinds[0].reason}
          </div>
        )}
        {devActive && inv?.addressHidden && pre.mode === 'ip' && (
          <div className="inv-band info">관리 주소(스토리지 · SAN · PDU · 네트워크 스위치 · GPU 서버)는 <b>관리자에게만</b> 보입니다 — 그 장비는 이름 · 모델 · 시리얼로 찾으세요.</div>
        )}

        <div className="v4-palette-list" id="inv-pal-list" role="listbox" aria-label="찾은 장비 · 기능 · 탭">
          {restored && q === restored.q && q.trim() && (
            <div className="v3-note inv-restored">직전에 고른 검색입니다 — 새로 입력하면 바뀝니다.</div>
          )}
          {!q.trim() && (
            <>
              {stats?.kinds?.length > 0 && (
                <>
                  <div className="inv-sec">찾는 범위{builtAgo && <span className="v3-faint"> · 색인 {builtAgo}</span>}</div>
                  <div className="inv-grid">
                    {stats.kinds.map((k) => (
                      <div key={k.key} className={`inv-cell${k.locked ? ' lock' : ''}${errors[k.key] ? ' warn' : ''}`} title={k.reason || ''}>
                        <span className="l">{k.locked ? '🔒 ' : ''}{k.label}</span>
                        <span className="n v3-num">{k.locked ? '—' : (stats.counts?.[k.key] ?? 0).toLocaleString('ko-KR')}</span>
                        <span className="p v3-mono">{k.key === 'ip' ? 'ip:' : `${k.prefix}:`}</span>
                      </div>
                    ))}
                  </div>
                  <div className="v3-note">접두 없이 치면 모든 종류에서 <b>이름 · 호스트명 · IP · 시리얼 · 모델</b>을 봅니다(2자부터). <span className="v3-mono">ip:10.20.1.</span> 은 주소만,
                    <span className="v3-mono"> sn:7HX2K93</span> 은 시리얼만(대소문자 · : - 무시 · 3자부터). 기능 · 탭은 지금처럼 이름 · 키(gpu) · 분류 · 옛 이름으로도 찾습니다.</div>
                </>
              )}
              {!stats && !invErr && <div className="v3-empty">이름뿐 아니라 <b>키</b>(gpu · ipam · rma) · <b>분류명</b>(스토리지 · 운영 작업) · <b>옛 이름</b>으로도 찾습니다.</div>}
              {recent.length > 0 && (
                <>
                  <div className="inv-sec">최근 연 항목 <span className="v3-faint">· 이 브라우저에만</span>
                    <button type="button" className="inv-link" style={{ marginLeft: 'auto' }} onClick={() => setRecent(clearRecent(undefined, recentKey))}>지우기</button>
                  </div>
                  {recent.map((r) => {
                    idx += 1; const i = idx;
                    return (
                      <button key={`r:${r.plan.hash}|${r.at}`} type="button" className={`v4-palette-row${i === cur ? ' on' : ''}`} onMouseEnter={() => setCur(i)} onClick={() => pick(flat[i])}
                        {...optProps(i)}>
                        <span className={`v3-tag inv-k-${r.kind}`}>{KIND_SHORT[r.kind] || '장비'}</span>
                        <span className="v4-palette-name">{r.name}</span>
                        <span className="v3-faint inv-meta">{[r.corp, agoText(r.at)].filter(Boolean).join(' · ')}</span>
                      </button>
                    );
                  })}
                </>
              )}
            </>
          )}

          {q.trim() && !devActive && !pre.prefix && text.length > 0 && (
            <div className="v3-note">장비는 {MIN_TEXT}자부터 찾습니다 — <span className="v3-mono">ip:</span> · <span className="v3-mono">sn:</span> 뒤는 {MIN_FIELD}자부터.</div>
          )}
          {q.trim() && !devActive && pre.prefix && <div className="v3-note">{modeBadge} — {minLen}자 이상 입력하세요.</div>}

          {groups.map((g) => {
            const listTo = g.total > g.rows.length;
            return (
              <div key={g.kind} className="inv-group" role="group" aria-label={`${KIND_LABEL[g.kind]} ${g.total}건`}>
                <div className="inv-gh" aria-hidden={listTo ? undefined : 'true'}>
                  {KIND_LABEL[g.kind]} <span className="v3-faint">{g.total > g.rows.length ? `${g.total.toLocaleString('ko-KR')} 중 ${g.rows.length}` : g.total}</span>
                  {listTo && <button type="button" className="inv-link" onClick={() => goList(g.kind)}>{canFilter(g.kind) ? `${LIST_SCREEN[g.kind]}에서 모두 보기 ›` : `${LIST_SCREEN[g.kind]} 열기 ›`}</button>}
                </div>
                {g.rows.map((row) => {
                  idx += 1; const i = idx;
                  const nameNeedle = pre.mode === 'all' ? needle : '';
                  return (
                    <button key={`${row.kind}:${row.id}:${row.name}`} type="button" className={`v4-palette-row inv-row${i === cur ? ' on' : ''}`}
                      onMouseEnter={() => setCur(i)} onClick={(e) => pick(flat[i], e.metaKey || e.ctrlKey)} {...optProps(i)}>
                      <span className={`v3-tag inv-tag inv-k-${row.kind}`}>{KIND_SHORT[row.kind]}</span>
                      <span className={`v4-palette-name${row.kind === 'ip' ? ' v3-mono' : ''}`}><Hl text={row.name} needle={row.kind === 'ip' && pre.mode === 'ip' ? needle : nameNeedle} /></span>
                      {VIA_LABEL[row.via] && (
                        <span className={`inv-via via-${row.via}`} title={row.via === 'tag' && row.tags?.length ? row.tags.join(' · ') : undefined}>
                          {VIA_LABEL[row.via]}{row.via === 'tag' && row.tags?.[0] ? <> · <Hl text={row.tags[0]} needle={needle} /></> : null}
                        </span>
                      )}
                      <span className="inv-meta">
                        {metaParts(row, { mode: pre.mode, needle }).map((p, j) => (
                          <span key={j} className={`${p.mono ? 'v3-mono ' : ''}${p.tone === 'dim' ? 'v3-faint' : ''}`}>{j > 0 && <span className="inv-sep" aria-hidden="true">{'· '}</span>}{p.dot && <span className={`inv-dot tone-${p.dot}`} aria-hidden="true" />}<Hl text={p.t} needle={pre.mode === 'all' ? '' : needle} /></span>
                        ))}
                      </span>
                      <span className="v3-faint inv-to">{TO_LABEL[row.kind]}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}

          {devActive && inv?.mode === 'sn' && inv.partsMatched > 0 && (
            <div className="v3-note">부품(PSU · 디스크 · DIMM · NIC · SFP) 시리얼 {inv.partsMatched}건은 여기 없습니다 —{' '}
              <button type="button" className="inv-link" onClick={() => goList('parts')}>시리얼 조회에서 ‘{text}’ 보기 ›</button></div>
          )}

          {toolRows.length > 0 && <div className="inv-gh">기능 · 탭 <span className="v3-faint">{toolRows.length}</span></div>}
          {toolRows.map((it) => {
            idx += 1; const i = idx;
            const lock = it.kind === 'tool' ? lockOf(it.k) : null;
            return (
              <button key={`${it.kind}:${it.k || it.id}`} type="button" className={`v4-palette-row${i === cur ? ' on' : ''}`}
                title={lock || undefined} onMouseEnter={() => setCur(i)} onClick={() => pick(flat[i])} {...optProps(i)}>
                <span className="v3-tag inv-tag">{KIND_TAG[it.kind]}</span>
                <span className="v4-palette-name">{lock ? '🔒 ' : ''}{it.label}</span>
                <span className="v3-faint" style={{ fontSize: 11 }}>{it.group}</span>
                <span className="v3-num v3-faint inv-to">{it.hash}</span>
              </button>
            );
          })}
          {omittedTools > 0 && <div className="v3-note">기능 · 탭 일치 {omittedTools}개를 더 찾았지만 목록에 넣지 않았습니다 — 검색어를 좁히세요.</div>}

          {nothing && (
            <div className="v3-empty">‘{q.trim()}’ 에 해당하는 장비 · 기능 · 탭이 없습니다.
              <div className="v3-faint">이름 · 호스트명 · IP · 시리얼 · 모델을 봤습니다(내 범위 · 권한 안). 템플릿 VM 은 색인에 없습니다.</div>
              <div className="inv-sug">
                {toolShown.has('deepsearch') && <button type="button" className="inv-link" onClick={() => onPick('#/tools/deepsearch')}>심층 검색 열기</button>}
                {toolShown.has('vmfinder') && <button type="button" className="inv-link" onClick={() => onPick('#/tools/vmfinder')}>VM 정밀 검색</button>}
                {toolShown.has('serial-lookup') && <button type="button" className="inv-link" onClick={() => goList('parts')}>시리얼 조회에서 찾기</button>}
                {tabs.some((t) => t.id === 'ipam') && <button type="button" className="inv-link" onClick={() => goList('ip')}>IP관리에서 찾기</button>}
              </div>
            </div>
          )}
        </div>

        <div className="inv-foot">
          <span><span className="v3-kbd">↑</span> <span className="v3-kbd">↓</span> 이동</span>
          <span><span className="v3-kbd">Enter</span> 열기</span>
          <span className="inv-hide-narrow"><span className="v3-kbd">{modKeyLabel(typeof navigator !== 'undefined' ? navigator : null)}</span>+<span className="v3-kbd">Enter</span> 새 탭</span>
          <span className="inv-hide-narrow"><span className="v3-kbd">Tab</span> 종류</span>
          <span><span className="v3-kbd">Esc</span> {kindSel || pre.prefix ? '종류 · 접두 지우기' : '닫기'}</span>
          <span className="r">
            {devActive && inv && <span>표시 {devShown} · 숨김 {devHidden}{devHidden > 0 ? ' — ‘모두 보기’ 는 그 화면의 필터로' : ''}</span>}
            {builtAgo && <span className="v3-mono">색인 {builtAgo}</span>}
          </span>
        </div>
      </div>
    </div>
  );
}
