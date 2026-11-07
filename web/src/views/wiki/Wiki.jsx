/**
 * Wiki — 상단 메뉴 '위키'(v2.881 · 시안 docs/design/wiki-issues ①~⑤ · ⑫).
 * 주소: #/wiki/<스페이스>[/search|/new|/settings | /<W번호>[/edit|/history]]. 스페이스 = 공용 + 법인(vCenter)마다 하나.
 *  · 읽기는 로그인 사용자 전부(범위 계정은 자기 법인 스페이스만 — 서버가 거른다). 쓰기는 운영자 · 관리자, 댓글 · 지켜보기는 요청 권한 계정도.
 *  · 저장은 편집을 시작한 판(baseVersion)을 싣는다 — 다른 사람이 먼저 저장했으면 서버가 409 로 막고 화면은 비교를 보여 준다(남의 저장을 덮지 않는다).
 *  · 초안은 이 브라우저에만 자동 저장한다(서버에 가지 않는다).
 * 폴링하지 않는다(들어올 때 1회 + 동작 뒤 다시 읽기 + 새로고침 버튼). 늦게 온 이전 응답은 버린다(makeLatest).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, postJson, putJson, delJson } from '../../api.js';
import { STable } from '../../components/STable.jsx';
import { Loading, ErrorBox } from '../../components/primitives.jsx';
import Select from '../../components/Select.jsx';
import { makeLatest, persistNote, parseLabels, statusText as issueStatusText } from '../issues/issueText.js';
import { MdView, MdToc } from './MdView.jsx';
import { makeRenderMacro } from './WikiMacros.jsx';
import AttachBox from '../attach/AttachBox.jsx';
import MentionBox from '../../components/MentionBox.jsx';
import { mentionsInText } from '../../components/mentionText.js';
import { selectionQuote, findQuote, exportMarkdownName, printDocument } from './wikiExport.js';
import {
  STATUS_ORDER, statusText, parseWikiHash, wikiHash, buildTree, flattenTree, parentOptions, breadcrumb, fillTemplate, wikiSaveFailText, isConflict,
  draftKey, loadDraft, saveDraft, clearDraft, countTiles, numText, noticeUntilText, quickHref, quickLinksToText, textToQuickLinks, versionLine,
  diffSummary, DIFF_MARK, WHERE_TEXT, searchSummary, spaceName, dateText, timeText, STALE_DAYS, slashQuery, filterSlash, applySlash, oncallToText, textToOncall, oncallRange,
} from './wikiText.js';

function useLatest() {
  const ref = useRef(null);
  if (!ref.current) ref.current = makeLatest();
  useEffect(() => () => { ref.current.invalidate(); }, []);
  return ref.current;
}
function useWikiRoute() {
  const [route, setRoute] = useState(() => parseWikiHash(window.location.hash));
  useEffect(() => {
    const on = () => { if (/^#\/?wiki(\/|$|\?)/.test(window.location.hash)) setRoute(parseWikiHash(window.location.hash)); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}
const go = (r) => { const h = wikiHash(r); if (window.location.hash !== h) window.location.hash = h; };
const StatusChip = ({ s }) => <span className={`wiki-chip s-${s}`}>{statusText(s)}</span>;

export default function Wiki() {
  const route = useWikiRoute();
  const [meta, setMeta] = useState(null);
  const [err, setErr] = useState(null);
  const [pages, setPages] = useState(null); // { spaceId, pages }
  const [treeErr, setTreeErr] = useState(null);
  const [note, setNote] = useState('');
  const [treeOpen, setTreeOpen] = useState(false);
  const [q, setQ] = useState(route.params?.q || '');
  const latestMeta = useLatest();
  const latestTree = useLatest();

  const loadMeta = useCallback(() => {
    const k = latestMeta.next();
    fetchJson('/wiki/meta').then((m) => { if (latestMeta.isLatest(k)) { setMeta(m); setErr(null); } }).catch((e) => { if (latestMeta.isLatest(k)) setErr(e); });
  }, [latestMeta]);
  useEffect(() => { loadMeta(); }, [loadMeta]);
  // v2.908 포탈 알림함 — 안 읽은 수(마운트 1회 + 새로고침 · 폴링 없음). 못 읽으면 버튼에 수를 붙이지 않는다.
  const [unread, setUnread] = useState(null);
  const loadUnread = useCallback(() => { fetchJson('/issues/inbox', { limit: 1 }, undefined, { retries: 0 }).then((r) => setUnread(r.demo ? null : (r.unread || 0))).catch(() => setUnread(null)); }, []);
  useEffect(() => { loadUnread(); }, [loadUnread]);

  const spaces = meta?.spaces || [];
  const space = route.space && spaces.some((s) => s.id === route.space) ? route.space : (route.space || spaces[0]?.id || '');
  // 주소에 스페이스가 없으면 기본 스페이스로 채운다(기록을 남기지 않게 replaceState)
  useEffect(() => {
    if (meta && !route.space && space) window.history.replaceState(null, '', wikiHash({ space }));
  }, [meta, route.space, space]);

  const loadTree = useCallback(() => {
    if (!space) return;
    const k = latestTree.next();
    fetchJson('/wiki/tree', { space }).then((r) => { if (latestTree.isLatest(k)) { setPages({ spaceId: r.spaceId, pages: r.pages || [] }); setTreeErr(null); } })
      .catch((e) => { if (latestTree.isLatest(k)) setTreeErr(e); });
  }, [space, latestTree]);
  useEffect(() => { loadTree(); }, [loadTree]);
  useEffect(() => { setTreeOpen(false); }, [route.view, route.id]);
  useEffect(() => { if (route.view === 'search') setQ(route.params?.q || ''); }, [route.view, route.params?.q]);

  const onWritten = useCallback((r) => { setNote(persistNote(r?.persist)); loadTree(); loadMeta(); }, [loadTree, loadMeta]);

  if (err && !meta) return <ErrorBox error={err} />;
  if (!meta) return <Loading label="위키" />;
  if (!spaces.length) return <div className="card muted">볼 수 있는 위키 스페이스가 없습니다 — 범위가 지정된 계정은 자기 법인(vCenter) 스페이스만 봅니다.</div>;

  const spaceInfo = spaces.find((s) => s.id === space) || null;
  const list = pages && pages.spaceId === space ? pages.pages : null;
  const canWriteHere = !!meta.canWrite && !!spaceInfo?.writable && !spaceInfo?.readOnly;
  const submitSearch = (e) => { e.preventDefault(); go({ space, view: 'search', params: { q: q.trim() } }); };

  return (
    <div className="wiki-page">
      <div className="wiki-head">
        <Select className="input wiki-space" value={space} onChange={(e) => go({ space: e.target.value })} aria-label="스페이스" sort={false}>
          {spaces.map((s) => <option key={s.id} value={s.id}>{s.name}{s.readOnly ? ' (읽기 전용)' : ''} · {s.pages}</option>)}
        </Select>
        <form className="wiki-search" onSubmit={submitSearch} role="search">
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="제목 · 본문 · 댓글 · ISS-번호" aria-label="위키 찾기" maxLength={100} />
          <button className="btn" type="submit">찾기</button>
        </form>
        <span className="wiki-grow" />
        <button className="btn wiki-tree-toggle" onClick={() => setTreeOpen((v) => !v)} aria-expanded={treeOpen}>문서 목록</button>
        <button className={`btn${route.view === 'home' ? ' primary' : ''}`} onClick={() => go({ space })}>대문</button>
        <button className="btn" onClick={() => { loadMeta(); loadTree(); loadUnread(); }}>새로고침</button>
        {unread != null && <a className="btn" href="#/issues/inbox" title="언급 · 할당 · 위키 알림(이슈 › 알림함)">알림함{unread ? <span className="iss-tab-n">{unread > 99 ? '99+' : unread}</span> : null}</a>}
        {meta.canWrite && <button className={`btn${route.view === 'tidy' ? ' primary' : ''}`} onClick={() => go({ space, view: 'tidy' })} title="휴지통 · 깨진 링크">정리</button>}
        {canWriteHere && <button className="btn primary" onClick={() => go({ space, view: 'new' })}>+ 새 문서</button>}
      </div>
      {meta.scoped && <div className="muted wiki-hint">범위가 지정된 계정이라 내 법인(vCenter) 스페이스만 보입니다 — 공용 스페이스는 보이지 않습니다.</div>}
      {!meta.canWrite && <div className="muted wiki-hint">문서 쓰기는 운영자 · 관리자만 할 수 있습니다{meta.canComment ? ' — 댓글 · 지켜보기는 할 수 있습니다' : ''}.</div>}
      {spaceInfo?.readOnly && <div className="banner">이 스페이스는 읽기 전용입니다(관리자가 스페이스 설정에서 바꿀 수 있습니다).</div>}
      {note && <div className="banner warn">{note}</div>}
      <PersistWarn persist={meta.persist} />
      {treeErr && <div className="banner">문서 목록을 읽지 못했습니다 — {String(treeErr.message || treeErr)}</div>}
      <div className={`wiki-layout${treeOpen ? ' tree-open' : ''}`}>
        <aside className="wiki-side" aria-label="문서 목록">
          <WikiTree pages={list} space={space} current={route.id} />
        </aside>
        <main className="wiki-main">
          {route.view === 'home' && <HomeView key={space} space={space} meta={meta} spaceInfo={spaceInfo} pages={list} canWriteHere={canWriteHere} />}
          {route.view === 'search' && <SearchView key={`${space}|${route.params?.q || ''}|${route.params?.label || ''}`} space={space} params={route.params || {}} meta={meta} />}
          {route.view === 'new' && (canWriteHere
            ? <NewPage key={`${space}|${route.params?.parent || ''}`} space={space} meta={meta} pages={list || []} parent={route.params?.parent || ''} onWritten={onWritten} />
            : <div className="card muted">이 스페이스에는 문서를 만들 수 없습니다(쓰기 권한 · 쓰기 범위 · 읽기 전용).</div>)}
          {route.view === 'settings' && <SpaceSettings key={space} space={space} meta={meta} spaceInfo={spaceInfo} onWritten={onWritten} />}
          {route.view === 'templates' && <TemplatesAdmin space={space} meta={meta} onWritten={() => loadMeta()} />}
          {route.view === 'tidy' && <TidyView key={space} space={space} meta={meta} onWritten={onWritten} />}
          {route.view === 'page' && <PageView key={route.id} id={route.id} space={space} meta={meta} pages={list || []} onWritten={onWritten} />}
          {route.view === 'edit' && <EditPage key={route.id} id={route.id} space={space} meta={meta} pages={list || []} onWritten={onWritten} />}
          {route.view === 'history' && <HistoryView key={route.id} id={route.id} space={space} meta={meta} onWritten={onWritten} />}
        </main>
      </div>
    </div>
  );
}

function PersistWarn({ persist }) {
  if (!persist || persist.state === 'saved' || persist.state === 'pending') return null;
  return (
    <div className="banner bad" style={{ whiteSpace: 'normal' }}>
      <b>위키 저장 실패 — 최근 변경이 서버 디스크에 저장되지 않았습니다.</b>
      <div style={{ fontSize: 12.5 }}>화면에는 보이지만 포탈이 다시 시작되면 사라질 수 있습니다. {persist.retrying ? '자동으로 다시 저장합니다.' : '다음 변경 때 다시 저장합니다.'}
        {persist.lastWriteError ? ` 원인: ${persist.lastWriteError.message}(${persist.lastWriteError.code})` : ''}</div>
    </div>
  );
}

/* ───── 문서 나무(왼쪽 칸 · 400px 에서는 '문서 목록' 버튼으로 연다) ───── */
function WikiTree({ pages, space, current }) {
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [showArchived, setShowArchived] = useState(false);
  if (!pages) return <div className="muted wiki-tree-empty">불러오는 중…</div>;
  const shown = showArchived ? pages : pages.filter((p) => p.status !== 'archived');
  const rows = flattenTree(buildTree(shown), collapsed);
  const archived = pages.length - pages.filter((p) => p.status !== 'archived').length;
  const toggle = (id) => setCollapsed((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <div className="wiki-tree">
      <div className="wiki-tree-title">문서 {pages.length - archived}{archived ? ` · 보관 ${archived}` : ''}</div>
      {!rows.length && <div className="muted wiki-tree-empty">문서가 없습니다.</div>}
      {rows.map(({ page, depth, hasChildren }) => (
        <div key={page.id} className={`wiki-tree-row${page.id === current ? ' on' : ''}${page.status === 'archived' ? ' archived' : ''}`} style={{ paddingLeft: 4 + (depth - 1) * 14 }}>
          {hasChildren
            ? <button type="button" className="wiki-tree-fold" onClick={() => toggle(page.id)} aria-label={collapsed.has(page.id) ? '펼치기' : '접기'}>{collapsed.has(page.id) ? '▸' : '▾'}</button>
            : <span className="wiki-tree-fold" />}
          <a href={wikiHash({ space, id: page.id })} title={page.title}>{page.title}</a>
          {page.status !== 'approved' && <span className={`wiki-dot s-${page.status}`} title={statusText(page.status)} />}
        </div>
      ))}
      {archived > 0 && <label className="wiki-check"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> 보관 문서도 보기</label>}
    </div>
  );
}

/* ───── ① 대문 ───── */
function HomeView({ space, meta, spaceInfo, pages, canWriteHere }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const latest = useLatest();
  useEffect(() => {
    const k = latest.next();
    fetchJson('/wiki/home', { space }).then((r) => { if (latest.isLatest(k)) { setData(r); setErr(null); } }).catch((e) => { if (latest.isLatest(k)) setErr(e); });
  }, [space, latest, pages]);
  if (err && !data) return <ErrorBox error={err} />;
  if (!data) return <Loading label="대문" />;
  const s = data.space || {};
  const tiles = countTiles(data.counts, { me: meta.me });
  const isPub = space === 'pub';
  const canDecorate = meta.isAdmin && !!spaceInfo?.writable;
  const LinkList = ({ rows, empty, extra }) => (rows?.length
    ? <ul className="wiki-list">{rows.map((p) => (
      <li key={p.id}><a href={wikiHash({ space: p.spaceId, id: p.id })}>{p.title}</a>{p.status !== 'approved' && <> <StatusChip s={p.status} /></>}
        <span className="muted wiki-list-meta"> · {extra ? extra(p) : `${p.updatedBy || '—'} · ${dateText(p.updatedAt)}`}</span></li>
    ))}</ul>
    : <div className="muted wiki-empty">{empty}</div>);
  return (
    <div className="wiki-home">
      {s.notice && (
        <div className="wiki-notice" role="status">
          <div className="wiki-notice-head"><b>공지</b><span className="muted"> · {s.notice.by || '—'} · {noticeUntilText(s.notice.until)}</span></div>
          <MdView md={s.notice.md} compact idPrefix="notice" pages={pages || []} spaceId={space} />
        </div>
      )}
      <div className="wiki-home-top">
        <section className="card wiki-intro">
          <div className="wiki-sec-head"><h3>{spaceName(meta.spaces, space)}</h3>{canDecorate && <button className="btn" onClick={() => go({ space, view: 'settings' })}>대문 꾸미기</button>}</div>
          {s.homeMd
            ? <MdView md={s.homeMd} idPrefix="home" pages={pages || []} spaceId={space} />
            : <div className="muted">소개 글이 없습니다 — 이 스페이스의 목적 · 범위 · 담당 · 연락 채널을 한 문단으로 적어 두면 처음 온 사람이 길을 찾습니다{canDecorate ? '(대문 꾸미기)' : '(관리자가 씁니다)'}.</div>}
          {s.updatedAt && <div className="muted wiki-small">대문 글 · {s.updatedBy || '—'} · {timeText(s.updatedAt)}</div>}
        </section>
        <section className="card wiki-quick">
          <div className="wiki-sec-head"><h3>바로 가기</h3></div>
          {(s.quickLinks || []).length
            ? <div className="wiki-quick-grid">{s.quickLinks.map((l, i) => {
              const h = quickHref(l.href);
              return h
                ? <a key={i} className="wiki-quick-item" href={h.href} {...(h.ext ? { target: '_blank', rel: 'noopener noreferrer' } : {})}><b>{l.title}</b>{l.desc && <span className="muted">{l.desc}</span>}</a>
                : <span key={i} className="wiki-quick-item muted">{l.title}</span>;
            })}</div>
            : <div className="muted wiki-empty">바로 가기가 없습니다{canDecorate ? ' — 대문 꾸미기에서 자주 찾는 문서 · 화면을 고르세요' : ''}.</div>}
          {((s.owners || []).length > 0 || (data.oncallNow || []).length > 0 || (data.oncallNext || []).length > 0) && (
            <div className="wiki-oncall">
              {(s.owners || []).length > 0 && <div><span className="muted">담당</span> <b>{s.owners.join(' · ')}</b></div>}
              <div><span className="muted">오늘 당번</span> {(data.oncallNow || []).length ? data.oncallNow.map((o, k) => <span key={k}><b>{o.who}</b>{o.note ? ` (${o.note})` : ''} <span className="muted">{oncallRange(o)}</span>{k < data.oncallNow.length - 1 ? ' · ' : ''}</span>) : <span className="muted">당번 표에 오늘이 없습니다</span>}</div>
              {(data.oncallNext || []).length > 0 && <div><span className="muted">다음</span> {data.oncallNext[0].who} <span className="muted">{oncallRange(data.oncallNext[0])}</span></div>}
            </div>
          )}
          {canWriteHere && <button className="btn primary wiki-quick-new" onClick={() => go({ space, view: 'new' })}>+ 템플릿에서 새 문서</button>}
        </section>
      </div>
      <div className="wiki-tiles">
        {tiles.map((t) => (
          <div key={t.k} className="wiki-tile" title={t.hint}>
            <div className="wiki-tile-n">{numText(t.value)}</div>
            <div className="wiki-tile-l">{t.label}</div>
          </div>
        ))}
      </div>
      {/* v2.888 C-2 — 즐겨찾기 · 최근 본 문서(모든 스페이스 · 서버가 지금 범위로 다시 거른다) · 많이 본 문서(이 스페이스 · 30일 · 사람 · 날마다 1회) */}
      <div className="wiki-home-grid three">
        <section className="card">
          <div className="wiki-sec-head"><h3>즐겨찾기</h3><span className="muted wiki-small">모든 스페이스</span></div>
          <LinkList rows={data.mine?.fav} empty="문서 제목 옆 ☆ 를 누르면 여기에 모입니다." extra={(p) => `${spaceName(meta.spaces, p.spaceId)} · ${dateText(p.updatedAt)}`} />
        </section>
        <section className="card">
          <div className="wiki-sec-head"><h3>최근 본 문서</h3></div>
          <LinkList rows={(data.mine?.recent || []).slice(0, 8)} empty="아직 연 문서가 없습니다." extra={(p) => `${spaceName(meta.spaces, p.spaceId)} · 본 시각 ${timeText(p.viewedAt)}`} />
        </section>
        <section className="card">
          <div className="wiki-sec-head"><h3>많이 본 문서</h3><span className="muted wiki-small">최근 30일 · 한 사람 하루 1회</span></div>
          {data.popular == null
            ? <div className="muted wiki-empty">조회 수를 읽지 못했습니다.</div>
            : <LinkList rows={data.popular} empty="아직 조회 기록이 없습니다." extra={(p) => `조회 ${numText(p.views)} · ${dateText(p.updatedAt)}`} />}
        </section>
      </div>
      <div className="wiki-home-grid">
        <section className="card">
          <div className="wiki-sec-head"><h3>최근 수정</h3><button className="btn" onClick={() => go({ space, view: 'search' })}>전체 보기</button></div>
          <LinkList rows={data.recent} empty="아직 문서가 없습니다." extra={(p) => `v${p.version} · ${p.updatedBy || '—'} · ${dateText(p.updatedAt)}${p.note ? ` · ${p.note}` : ''}`} />
        </section>
        <section className="card">
          <div className="wiki-sec-head"><h3>검토 중</h3></div>
          <LinkList rows={data.review} empty="검토를 기다리는 문서가 없습니다." />
          {meta.me && <>
            <div className="wiki-sec-head sub"><h4>내 초안</h4></div>
            <LinkList rows={data.myDrafts} empty="내가 만든 초안이 없습니다." />
          </>}
        </section>
        <section className="card">
          <div className="wiki-sec-head"><h3>자주 묻는 질문</h3></div>
          <LinkList rows={data.faq} empty="라벨 ‘faq’ 를 단 문서가 여기에 모입니다." extra={(p) => dateText(p.updatedAt)} />
        </section>
        {meta.canWrite && (
          <section className="card">
            <div className="wiki-sec-head"><h3>정리 필요</h3><span className="muted wiki-small">{STALE_DAYS}일 넘게 안 고친 문서</span></div>
            <LinkList rows={data.stale} empty="오래된 문서가 없습니다." extra={(p) => `마지막 ${dateText(p.updatedAt)} · ${p.updatedBy || '—'}`} />
          </section>
        )}
      </div>
      <div className="wiki-home-grid two">
        <section className="card">
          <div className="wiki-sec-head"><h3>전체 목차</h3><span className="muted wiki-small">보관 {numText(data.counts?.archived)}건은 접어 둡니다</span></div>
          <TocTree pages={(data.tree || []).filter((p) => p.status !== 'archived')} space={space} />
        </section>
        <section className="card">
          <div className="wiki-sec-head"><h3>라벨</h3></div>
          {(data.labels || []).length
            ? <div className="wiki-labels">{data.labels.map((l) => <a key={l.name} className="wiki-label" href={wikiHash({ space, view: 'search', params: { label: l.name } })}>{l.name} <span className="muted">{l.n}</span></a>)}</div>
            : <div className="muted wiki-empty">라벨을 단 문서가 없습니다.</div>}
          {isPub && meta.spaces.length > 1 && <>
            <div className="wiki-sec-head sub"><h4>법인별 스페이스</h4></div>
            <ul className="wiki-list">{meta.spaces.filter((x) => x.id !== 'pub').map((x) => <li key={x.id}><a href={wikiHash({ space: x.id })}>{x.name}</a><span className="muted wiki-list-meta"> · 문서 {x.pages}</span></li>)}</ul>
          </>}
        </section>
      </div>
    </div>
  );
}
function TocTree({ pages, space }) {
  const rows = flattenTree(buildTree(pages));
  if (!rows.length) return <div className="muted wiki-empty">문서가 없습니다.</div>;
  return (
    <div className="wiki-toc-tree">
      {rows.map(({ page, depth }) => (
        <div key={page.id} style={{ paddingLeft: (depth - 1) * 16 }}>
          {depth > 1 ? '└ ' : ''}<a href={wikiHash({ space, id: page.id })}>{page.title}</a>{page.status !== 'approved' && <span className="muted wiki-small"> · {statusText(page.status)}</span>}
        </div>
      ))}
    </div>
  );
}

/* ───── ② 문서 보기 ───── */
function usePage(id) {
  const [page, setPage] = useState(null);
  const [info, setInfo] = useState(null);
  const [err, setErr] = useState(null);
  const latest = useLatest();
  const load = useCallback(() => {
    const k = latest.next();
    fetchJson(`/wiki/pages/${id}`).then((r) => { if (latest.isLatest(k)) { setPage(r.page); setInfo(r); setErr(null); } }).catch((e) => { if (latest.isLatest(k)) setErr(e); });
  }, [id, latest]);
  useEffect(() => { load(); }, [load]);
  return { page, info, err, load };
}

/* ───── v2.907 정리 — 휴지통(기능 추천 2) · 깨진 링크(3) ───── */
const FLASH_KEY = 'wiki.flash';
export function setWikiFlash(text) { try { window.sessionStorage.setItem(FLASH_KEY, text); } catch { /* 저장 못 하는 브라우저 */ } }
function takeWikiFlash() { try { const t = window.sessionStorage.getItem(FLASH_KEY) || ''; window.sessionStorage.removeItem(FLASH_KEY); return t; } catch { return ''; } }
/** 제목 바꾼 뒤 링크 갱신 결과(서버 linkFix). 고친 것이 없으면 ''. */
export function linkFixText(f) {
  if (!f || (!f.fixed && !f.skipped && !f.crossSpace)) return '';
  // v2.931(점검 B1-02) crossSpace — 다른 법인 스페이스의 문서는 그 문서를 읽는 사람이 새 제목을 볼 수 없을 수 있어 고치지 않는다(서버가 센다)
  return `제목이 바뀌어 다른 문서 ${f.fixed}개의 링크를 새 제목으로 고쳤습니다(각 문서에 새 판 · 메모 ‘링크 갱신’)${f.skipped ? ` · 쓰기 범위 밖이거나 읽기 전용이라 못 고친 문서 ${f.skipped}개` : ''}${f.crossSpace ? ` · 다른 법인 스페이스의 문서라 고치지 않은 문서 ${f.crossSpace}개(그 문서의 독자가 이 문서를 볼 수 없을 수 있습니다 — 정리 › 깨진 링크에서 확인)` : ''}.`;
}
function TidyView({ space, meta, onWritten }) {
  const [trash, setTrash] = useState(null);
  const [broken, setBroken] = useState(null);
  const [err, setErr] = useState(null);
  const [allSpaces, setAllSpaces] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const latest = useMemo(() => makeLatest(), []);
  const load = useCallback(() => {
    const k = latest.next();
    const sp = allSpaces ? '' : space;
    Promise.all([fetchJson('/wiki/trash', { space: sp }), fetchJson('/wiki/broken-links', { space: sp })])
      .then(([t, b]) => { if (latest.isLatest(k)) { setTrash(t); setBroken(b); setErr(null); } })
      .catch((e) => { if (latest.isLatest(k)) setErr(e); });
  }, [space, allSpaces, latest]);
  useEffect(() => { load(); }, [load]);
  const act = async (fn, okText) => {
    setBusy(true); setMsg('');
    try { const r = await fn(); setMsg(r?.ok === false ? wikiSaveFailText(r) : okText); onWritten?.(r); load(); } catch (e) { setMsg(String(e?.message || e)); } finally { setBusy(false); }
  };
  if (err && !trash) return <ErrorBox error={err} />;
  if (!trash || !broken) return <Loading label="정리" />;
  const days = trash.days || 30;
  return (
    <div className="wiki-settings">
      <div className="wiki-editor-head"><h2 className="wiki-title">정리 — 휴지통 · 깨진 링크</h2>
        <label className="wiki-check"><input type="checkbox" checked={allSpaces} onChange={(e) => setAllSpaces(e.target.checked)} /> 모든 스페이스</label></div>
      {err && <div className="banner warn" style={{ whiteSpace: 'normal' }}>새로 읽지 못했습니다 — 아래는 직전에 읽은 목록입니다({err.message || String(err)}).</div>}
      {msg && <div className="banner" role="status" style={{ whiteSpace: 'normal' }}>{msg}</div>}
      <section className="card">
        <h3 className="wiki-h3">휴지통 {trash.items.length}</h3>
        <div className="muted wiki-small">지운 문서는 {days}일 동안 여기 남습니다(판 · 댓글 · 첨부 그대로). 기한이 지나면 첨부와 함께 영구히 지워집니다.</div>
        {trash.items.length === 0 ? <div className="muted">비어 있습니다.</div> : (
          <div className="table-wrap"><STable className="tbl">
            <thead><tr><th>문서</th><th>스페이스</th><th>지운 사람</th><th>지운 때</th><th>영구 삭제 예정</th><th data-nosort>동작</th></tr></thead>
            <tbody>{trash.items.map((t) => (
              <tr key={t.id}>
                <td><span className="mono">{t.id}</span> {t.title}</td><td>{spaceName(meta.spaces, t.spaceId)}</td><td>{t.deletedBy || '—'}</td>
                <td data-sort={t.deletedAt}>{timeText(t.deletedAt)}</td><td data-sort={t.purgeAt}>{dateText(t.purgeAt)}</td>
                <td><div className="wiki-actions">
                  <button type="button" className="btn btn-sm" disabled={busy} onClick={() => act(() => postJson(`/wiki/trash/${t.id}/restore`, {}), `${t.id} ‘${t.title}’ 를 되살렸습니다.`)}>되살리기</button>
                  {(trash.isMod || t.deletedBy === trash.me || t.createdBy === trash.me) && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => { if (window.confirm(`‘${t.title}’ 를 영구히 지울까요? 첨부도 함께 지워지고 되살릴 수 없습니다.`)) act(() => delJson(`/wiki/trash/${t.id}`), `${t.id} 를 영구히 지웠습니다.`); }}>영구 삭제</button>}
                </div></td>
              </tr>
            ))}</tbody>
          </STable></div>
        )}
      </section>
      <section className="card">
        <h3 className="wiki-h3">깨진 링크 {broken.total}</h3>
        <div className="muted wiki-small">‘[[제목]]’ · ‘[[W번호]]’ 가 가리키는 문서가 없습니다(지웠거나 · 제목이 바뀌었거나 · 볼 수 없는 스페이스). 제목을 바꾸면 이 문서로 풀리던 링크는 저절로 고쳐집니다.</div>
        {broken.rows.length === 0 ? <div className="muted">없습니다.</div> : (
          <div className="table-wrap"><STable className="tbl">
            <thead><tr><th>문서</th><th>스페이스</th><th>깨진 링크</th></tr></thead>
            <tbody>{broken.rows.map((r, i) => (
              <tr key={`${r.id}-${i}`}><td><a href={wikiHash({ space: r.spaceId, id: r.id })}>{r.title}</a></td><td>{spaceName(meta.spaces, r.spaceId)}</td><td className="mono">[[{r.ref}]]</td></tr>
            ))}</tbody>
          </STable></div>
        )}
        {broken.total > broken.rows.length && <div className="muted wiki-small">{broken.total}개 중 {broken.rows.length}개만 보입니다.</div>}
      </section>
    </div>
  );
}

/* ───── v2.907 댓글 @멘션 → 이슈 등록(시안 docs/design/wiki-mention ②⑥ · 추천안: 체크 기본 켬 · 요청 권한은 '요청' 으로 · 계정/이름 글자 그대로) ───── */
const ISSUE_OPT_KEY = 'wiki.commentIssue.on';
const COMMENT_ISSUE_TYPES = [['task', '작업'], ['incident', '장애'], ['request', '요청']];
function loadIssueOn() { try { const v = window.localStorage.getItem(ISSUE_OPT_KEY); return v == null ? true : v === '1'; } catch { return true; } }
function saveIssueOn(on) { try { window.localStorage.setItem(ISSUE_OPT_KEY, on ? '1' : '0'); } catch { /* 저장 못 하는 브라우저 — 이번 화면에서만 */ } }
/** 등록 결과 한 줄(서버 응답 issue · issueError). */
export function commentIssueText(r) {
  if (!r) return '';
  if (r.issueError) return `댓글은 달았지만 이슈는 만들지 못했습니다 — ${r.issueError}. 댓글의 ‘이슈로 등록’ 으로 다시 할 수 있습니다.`;
  const i = r.issue;
  if (!i) return '';
  if (i.existing) return `이 댓글로 만든 열린 이슈 ${i.key} 가 이미 있습니다.`;
  const who = i.requestOnly ? '요청으로 등록' : `담당자 ${i.assignee}${i.watchers?.length ? ` · 관찰자 ${i.watchers.join(', ')}` : ''}`;
  // v2.931(점검 B1-06): 뺀 사람 이름은 전체 범위 쓰기 계정에게만 온다 — 그 밖은 수(skippedN)만
  const skip = i.skipped?.length ? ` · 이 법인을 볼 수 없어 뺀 사람 ${i.skipped.join(', ')}` : i.skippedN ? ` · 이 법인을 볼 수 없어 뺀 사람 ${i.skippedN}명` : '';
  const mail = i.notifyOn === false ? ' · 이슈 알림이 꺼져 있어 메일은 가지 않습니다' : i.noEmail?.length ? ` · 메일 주소가 없는 사람 ${i.noEmail.join(', ')}(이슈는 포탈 ‘내 작업’ 에서 보입니다)` : i.notifyOn ? ' · 메일은 1분 안에 한 통씩 갑니다' : '';
  return `이슈 ${i.key} 를 만들었습니다 — ${who}${i.relatedTo ? ` · 예전 이슈 ${i.relatedTo} 와 ‘관련’ 으로 이음` : ''}${skip}${mail}.`;
}

function CommentIssuePane({ mentions, picked, mmeta, canIssue, value, onChange, spaceLabel }) {
  const set = (k) => (e) => onChange({ ...value, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const users = mentions.map((m) => m.user);
  const assignee = users.includes(value.assignee) ? value.assignee : users[0] || '';
  const info = (u) => picked[u] || null;
  if (!canIssue) {
    return (
      <div className="wiki-issue-pane" aria-label="이슈로 등록">
        <label className="wiki-check"><input type="checkbox" checked={!!value.request} onChange={set('request')} /> 요청으로 등록 <span className="muted">— 담당자를 지정하는 이슈는 운영자 · 관리자만 만듭니다. 요청은 담당자 없이(자동 할당 규칙이 있으면 그것이 정함) · 언급 메일은 그대로</span></label>
      </div>
    );
  }
  return (
    <div className="wiki-issue-pane" aria-label="이슈로 등록">
      <label className="wiki-check wiki-issue-on"><input type="checkbox" checked={!!value.on} onChange={(e) => { saveIssueOn(e.target.checked); onChange({ ...value, on: e.target.checked }); }} /> <b>언급한 사람에게 이슈로 등록</b> <span className="muted">— 댓글 1개 → 이슈 1건 · 마지막 선택을 이 브라우저가 기억</span></label>
      {value.on && (
        <>
          <div className="wiki-issue-grid">
            <label>담당자(언급한 사람 중)<Select className="input" value={assignee} onChange={set('assignee')} sort={false}>
              {mentions.map((m) => <option key={m.user} value={m.user}>{m.user}{(info(m.user)?.name || m.name) ? ` / ${info(m.user)?.name || m.name}` : ''}{info(m.user)?.canSee === false ? ' — 이 법인을 볼 수 없음' : ''}</option>)}
            </Select></label>
            <label>유형<Select className="input" value={value.type || 'task'} onChange={set('type')} sort={false}>{COMMENT_ISSUE_TYPES.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</Select></label>
            <label>우선순위<Select className="input" value={value.priority || 'p2'} onChange={set('priority')} sort={false}>{['p0', 'p1', 'p2', 'p3'].map((p) => <option key={p} value={p}>{p.toUpperCase()}</option>)}</Select></label>
            <div className="wiki-issue-fixed"><span className="muted">법인</span><span>{spaceLabel} <span className="muted wiki-small">— 문서의 스페이스</span></span></div>
          </div>
          <label className="wiki-issue-title">제목<input className="input" value={value.title || ''} onChange={set('title')} maxLength={200} placeholder="비우면 ‘[위키] 문서 제목 — 댓글 앞부분’" /></label>
          <div className="wiki-issue-meta muted wiki-small">
            {users.length > 1 && <span>관찰자: {users.filter((u) => u !== assignee).join(', ')}</span>}
            {mmeta?.notifyOn === false && <span className="wiki-warn">이슈 알림이 꺼져 있어 메일은 가지 않습니다(이슈는 만듭니다)</span>}
            {mmeta?.full && mentions.map((m) => info(m.user)?.email === false && <span key={m.user} className="wiki-warn">{m.user} 메일 주소 없음</span>)}
            {info(assignee)?.canSee === false && <span className="wiki-warn">{assignee} 는 이 법인 이슈를 볼 수 없어 담당자로 지정할 수 없습니다</span>}
          </div>
        </>
      )}
    </div>
  );
}

function PageView({ id, space, meta, pages, onWritten }) {
  const { page, info, err, load } = usePage(id);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [comment, setComment] = useState('');
  const [quote, setQuote] = useState(''); // v2.889 인라인 댓글 — 본문에서 고른 글
  const [issueOpt, setIssueOpt] = useState(() => ({ on: loadIssueOn(), assignee: '', type: 'task', priority: 'p2', title: '', request: false })); // v2.907
  const [picked, setPicked] = useState({}); // v2.907 자동완성으로 고른 사람(메일 · 범위 표시)
  const [mmeta, setMmeta] = useState(null);
  const [cmsg, setCmsg] = useState(''); // v2.907 댓글 · 이슈 등록 결과(댓글 상자 옆에 — 위 배너는 화면 밖일 수 있다)
  const [moveTo, setMoveTo] = useState(null); // v2.907 다른 스페이스로(null = 닫힘)
  const [editing, setEditing] = useState(null); // v2.907 댓글 고치기 { id, body }
  const [backs, setBacks] = useState(null); // v2.907 역링크
  useEffect(() => { const f = takeWikiFlash(); if (f) setMsg(f); }, []);
  useEffect(() => {
    let alive = true;
    setBacks(null);
    fetchJson(`/wiki/pages/${id}/backlinks`).then((r) => { if (alive) setBacks(r.items || []); }).catch(() => { if (alive) setBacks(false); });
    return () => { alive = false; };
  }, [id]);
  const [pick, setPick] = useState(null); // { text, x, y } — 본문에서 글을 고르면 뜨는 '댓글' 단추
  const [showResolved, setShowResolved] = useState(false);
  const mainRef = useRef(null);
  const formRef = useRef(null);
  const renderMacro = useMemo(() => makeRenderMacro({ pages, spaceId: space }), [pages, space]);
  // 다른 스페이스 문서로 들어온 링크([[W12]] 등) — 주소를 문서의 스페이스로 맞춘다(기록을 남기지 않게)
  useEffect(() => {
    if (page && page.spaceId !== space) {
      window.history.replaceState(null, '', wikiHash({ space: page.spaceId, id: page.id }));
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    }
  }, [page, space]);
  // v2.883 체크리스트 체크 — 판을 만들지 않는다(서버가 지금 판 본문을 같이 고친다). 문서가 바뀌었으면 다시 읽고 사유를 보인다.
  const toggleTask = async (line, checked) => {
    setBusy(true); setMsg('');
    try {
      const r = await postJson(`/wiki/pages/${page.id}/check`, { baseVersion: page.version, line, checked });
      if (r?.ok === false) setMsg(r.reason || '체크하지 못했습니다');
      else setMsg(persistNote(r?.persist));
      load();
    } catch (e) { setMsg(String(e?.message || e)); } finally { setBusy(false); }
  };
  const act = async (fn, after) => {
    setBusy(true); setMsg('');
    try {
      const r = await fn();
      if (r?.ok === false) { setMsg(wikiSaveFailText(r)); return false; }
      onWritten?.(r); if (after) after(r); else load();
      return true;
    } catch (e) { setMsg(String(e?.message || e)); return false; } finally { setBusy(false); }
  };
  if (err && !page) return <ErrorBox error={err} />;
  if (!page) return <Loading label="문서" />;
  const crumbs = breadcrumb(pages, page.id);
  const children = pages.filter((p) => p.parentId === page.id).sort((a, b) => (a.order - b.order) || a.title.localeCompare(b.title));
  const writable = !!info?.canWrite && page.writable;
  const canDelete = writable && (info?.isMod || page.createdBy === info?.me);
  const canComment = !!info?.canComment && page.commentable !== false;
  const movable = (meta.spaces || []).filter((sp) => sp.writable && !sp.readOnly && sp.id !== page.spaceId);
  return (
    <article className="wiki-doc">
      <div className="wiki-crumbs">
        <a href={wikiHash({ space })}>{spaceName(meta.spaces, space)}</a>
        {crumbs.slice(0, -1).map((c) => <React.Fragment key={c.id}> › <a href={wikiHash({ space, id: c.id })}>{c.title}</a></React.Fragment>)}
      </div>
      <div className="wiki-doc-head">
        <div className="wiki-title-row">
          <h2 className="wiki-title">{page.title}</h2>
          {canComment && (
            <button type="button" className={`wiki-star${page.fav ? ' on' : ''}`} disabled={busy} aria-pressed={!!page.fav}
              title={page.fav ? '즐겨찾기에서 빼기' : '즐겨찾기(대문 ‘즐겨찾기’ 에 모입니다)'}
              onClick={() => act(() => postJson(`/wiki/pages/${page.id}/fav`, { on: !page.fav }))}>{page.fav ? '★' : '☆'}<span className="wiki-star-t">{page.fav ? '즐겨찾기 중' : '즐겨찾기'}</span></button>
          )}
        </div>
        <div className="wiki-doc-meta">
          <StatusChip s={page.status} />
          {page.labels.map((l) => <a key={l} className="wiki-label" href={wikiHash({ space, view: 'search', params: { label: l } })}>{l}</a>)}
          <span className="muted">v{page.version} · {page.updatedBy || '—'} · {timeText(page.updatedAt)} · 만든 사람 {page.createdBy || '—'}</span>
        </div>
        <div className="wiki-actions">
          {writable && <button className="btn primary" onClick={() => go({ space, id: page.id, view: 'edit' })}>편집</button>}
          <button className="btn" onClick={() => go({ space, id: page.id, view: 'history' })}>이력 ({page.versions.length})</button>
          <button className="btn" title="본문(마크다운)을 파일로 받습니다 — 매크로는 글자 그대로" onClick={() => { const b = new Blob([`# ${page.title}\n\n${page.body}`], { type: 'text/markdown;charset=utf-8' }); const u = URL.createObjectURL(b); const a = document.createElement('a'); a.href = u; a.download = exportMarkdownName(page); document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 1000); }}>.md 받기</button>
          <button className="btn" title="지금 보이는 문서(매크로 값 포함 — 이 시각 기준)를 인쇄 · PDF 로 저장합니다" onClick={() => printDocument(mainRef.current, page.title, `${spaceName(meta.spaces, space)} · v${page.version} · ${timeText(Date.now())} 기준`)}>인쇄 · PDF</button>
          {canComment && <button className="btn" disabled={busy} onClick={() => act(() => postJson(`/wiki/pages/${page.id}/watch`, { on: !page.watching }))}>{page.watching ? '지켜보기 끄기' : '지켜보기'} · {page.watchers.length}</button>}
          {writable && <button className="btn" onClick={() => go({ space, view: 'new', params: { parent: page.id } })}>+ 하위 문서</button>}
          {canDelete && <button className="btn" disabled={busy} onClick={() => {
            if (children.length) { setMsg('하위 문서가 있어 지울 수 없습니다 — 먼저 옮기거나 지우세요. 숨기려면 상태를 ‘보관’ 으로 바꾸세요.'); return; }
            if (window.confirm(`‘${page.title}’ 문서를 휴지통으로 옮길까요? 30일 안에는 ‘정리 › 휴지통’ 에서 판 · 댓글 · 첨부와 함께 되살릴 수 있습니다.`)) act(() => delJson(`/wiki/pages/${page.id}`), () => { setWikiFlash(`‘${page.title}’ 를 휴지통으로 옮겼습니다 — 30일 안에 ‘정리’ 에서 되살릴 수 있습니다.`); go({ space }); });
          }}>지우기</button>}
          {writable && movable.length > 0 && (moveTo == null
            ? <button className="btn" disabled={busy} onClick={() => setMoveTo('')} title="이 문서와 하위 문서를 다른 스페이스(법인)로 옮깁니다">다른 스페이스로</button>
            : <span className="wiki-move">
                <Select className="input" value={moveTo} onChange={(e) => setMoveTo(e.target.value)} sort={false} aria-label="옮길 스페이스">
                  <option value="">옮길 스페이스…</option>
                  {movable.map((sp) => <option key={sp.id} value={sp.id}>{sp.name}</option>)}
                </Select>
                <button className="btn" disabled={busy || !moveTo} onClick={() => {
                  if (!window.confirm(`‘${page.title}’ 와 하위 문서 ${children.length ? `${children.length}개 이상` : '없음'}을(를) ‘${spaceName(meta.spaces, moveTo)}’ 로 옮길까요? 그 스페이스를 볼 수 있는 사람만 보게 됩니다.`)) return;
                  act(() => postJson(`/wiki/pages/${page.id}/move`, { spaceId: moveTo }), (r) => { setMoveTo(null); setWikiFlash(`문서 ${r.moved}개를 ‘${spaceName(meta.spaces, r.spaceId)}’ 로 옮겼습니다.`); go({ space: r.spaceId, id: page.id }); });
                }}>옮기기</button>
                <button className="btn" onClick={() => setMoveTo(null)}>취소</button>
              </span>)}
        </div>
      </div>
      {msg && <div className="banner warn">{msg}</div>}
      {!page.writable && meta.canWrite && <div className="muted wiki-hint">이 문서의 스페이스는 쓰기 범위 밖이거나 읽기 전용이라 조회만 할 수 있습니다.</div>}
      <div className="wiki-doc-body">
        <div className="wiki-doc-main" ref={mainRef}
          onMouseUp={canComment ? () => { const q = selectionQuote(window.getSelection(), mainRef.current, meta.limits?.quote || 200); if (!q) { setPick(null); return; } const r = q.rect; const box = mainRef.current.getBoundingClientRect(); setPick({ text: q.text, x: Math.max(0, Math.min(r.left - box.left, box.width - 150)), y: r.bottom - box.top + 6 }); } : undefined}>
          {page.body.trim()
            ? <MdView md={page.body} idPrefix={`p${page.id}`} pages={pages} spaceId={space} dropTitle={page.title} busy={busy} renderMacro={renderMacro}
                onToggleTask={writable ? (line, checked) => toggleTask(line, checked) : null} />
            : <div className="muted">본문이 비어 있습니다.</div>}
          {pick && (
            <button type="button" className="btn btn-sm wiki-pick" style={{ left: pick.x, top: pick.y }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { setQuote(pick.text); setPick(null); window.getSelection()?.removeAllRanges(); requestAnimationFrame(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })); }}>💬 이 부분에 댓글</button>
          )}
          <AttachBox kind="wiki" owner={page.id} />
        </div>
        <aside className="wiki-doc-aside">
          <MdToc md={page.body} idPrefix={`p${page.id}`} dropTitle={page.title} />
          <div className="wiki-aside-box">
            <div className="wiki-aside-title">관련 이슈</div>
            {page.issueKeys.length
              ? <div className="wiki-keys">{page.issueKeys.map((k) => <a key={k} className="md-iss" href={`#/issues/list/${k}`}>{k}</a>)}</div>
              : <div className="muted wiki-small">본문 · 댓글에 ISS-번호를 적으면 여기와 그 이슈의 ‘관련 문서’ 에 서로 이어집니다.</div>}
            {page.issueKeysDropped > 0 && <div className="muted wiki-small">외 {page.issueKeysDropped}개는 색인 상한({page.issueKeys.length}개)을 넘어 그 이슈의 ‘관련 문서’ 에 나오지 않습니다.</div>}
          </div>
          <div className="wiki-aside-box">
            <div className="wiki-aside-title">이 문서를 가리키는 문서{Array.isArray(backs) ? ` · ${backs.length}` : ''}</div>
            {backs === null ? <div className="muted wiki-small">읽는 중…</div>
              : backs === false ? <div className="muted wiki-small">역링크를 읽지 못했습니다.</div>
              : backs.length ? <ul className="wiki-list">{backs.map((b) => <li key={b.id}><a href={wikiHash({ space: b.spaceId, id: b.id })}>{b.title}</a></li>)}</ul>
              : <div className="muted wiki-small">다른 문서의 ‘[[{page.title}]]’ 링크가 여기 모입니다.</div>}
          </div>
          {(page.checkLog || []).length > 0 && (
            <div className="wiki-aside-box">
              <div className="wiki-aside-title">최근 체크</div>
              <ul className="wiki-list">{page.checkLog.slice(0, 5).map((c, k) => <li key={k} className="wiki-small"><span className="muted">{c.by} · {dateText(c.at)}</span> {c.checked ? '☑' : '☐'} {c.text}</li>)}</ul>
            </div>
          )}
          {children.length > 0 && (
            <div className="wiki-aside-box">
              <div className="wiki-aside-title">하위 문서</div>
              <ul className="wiki-list">{children.map((c) => <li key={c.id}><a href={wikiHash({ space, id: c.id })}>{c.title}</a></li>)}</ul>
            </div>
          )}
        </aside>
      </div>
      <section className="wiki-comments">
        <div className="wiki-comments-head">
          <h3>댓글 {page.comments.length}</h3>
          {page.comments.some((c) => c.resolved) && <label className="wiki-check"><input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> 해결한 인라인 댓글 {page.comments.filter((c) => c.resolved).length}개도 보기</label>}
        </div>
        {page.comments.filter((c) => showResolved || !c.resolved).map((c) => (
          <div key={c.id} className={`wiki-comment${c.resolved ? ' resolved' : ''}`}>
            <div className="wiki-comment-head"><b>{c.author}</b><span className="muted"> · {timeText(c.at)} · v{c.v}</span>{c.editedAt && <span className="muted" title={`${timeText(c.editedAt)} 고침 · ${c.edits || 1}번`}> · 고침</span>}
              {canComment && c.author === info?.me && editing?.id !== c.id && <button type="button" className="wiki-mini-act" disabled={busy} onClick={() => setEditing({ id: c.id, body: c.body })}>고치기</button>}
              {c.quote && canComment && <button type="button" className="wiki-mini-act" disabled={busy} title={c.resolved ? `${c.resolvedBy || ''} 가 해결로 표시함` : '해결로 표시하면 목록에서 접힙니다'} onClick={() => act(() => postJson(`/wiki/pages/${page.id}/comments/${c.id}/resolve`, { on: !c.resolved }))}>{c.resolved ? '다시 열기' : '해결'}</button>}
              {(info?.isMod || c.author === info?.me) && canComment && <button type="button" className="wiki-mini-act" disabled={busy} onClick={() => { if (window.confirm('이 댓글을 지울까요?')) act(() => delJson(`/wiki/pages/${page.id}/comments/${c.id}`)); }}>지우기</button>}
            </div>
            {c.quote && (
              <button type="button" className="wiki-quote" title="본문에서 이 글을 찾아 표시합니다" onClick={() => { if (!findQuote(mainRef.current, c.quote)) setMsg('본문에서 이 글을 찾지 못했습니다 — 그 뒤에 문서가 바뀌었을 수 있습니다.'); }}>
                “{c.quote}”
              </button>
            )}
            {editing?.id === c.id
              ? (
                <div className="wiki-comment-edit">
                  <MentionBox value={editing.body} onChange={(v) => setEditing((e0) => ({ ...e0, body: v }))} path={`/wiki/pages/${page.id}/mentionables`} rows={3} maxLength={meta.limits?.comment || 2000} ariaLabel="댓글 고치기" />
                  <div className="wiki-actions">
                    <button type="button" className="btn primary btn-sm" disabled={busy || !editing.body.trim()} onClick={async () => {
                      setBusy(true); setCmsg('');
                      try { const r = await putJson(`/wiki/pages/${page.id}/comments/${c.id}`, { body: editing.body }); if (r?.ok === false) setCmsg(wikiSaveFailText(r)); else { setEditing(null); setCmsg('댓글을 고쳤습니다 — 새로 언급한 사람에게만 알림이 갑니다.'); load(); } } catch (e) { setCmsg(String(e?.message || e)); } finally { setBusy(false); }
                    }}>저장</button>
                    <button type="button" className="btn btn-sm" onClick={() => setEditing(null)}>취소</button>
                  </div>
                </div>
              )
              : <MdView md={c.body} compact idPrefix={`c${c.id}`} pages={pages} spaceId={space} />}
            {c.issueKey
              ? <div className="wiki-comment-issue">이슈로 등록됨 <a className="md-iss" href={`#/issues/list/${c.issueKey}`}>{c.issueKey}</a></div>
              : canComment && (info?.canWrite || c.author === info?.me) && mentionsInText(c.body).length > 0 && (
                <div className="wiki-comment-issue"><button type="button" className="wiki-mini-act" disabled={busy} title="이 댓글에서 언급한 사람에게 이슈를 만듭니다(첫 언급 = 담당자)"
                  onClick={async () => { setBusy(true); setCmsg(''); try { const r = await postJson(`/wiki/pages/${page.id}/comments/${c.id}/issue`, info?.canWrite ? {} : { request: true }); setCmsg(r?.ok === false ? wikiSaveFailText(r) : commentIssueText({ issue: r.issue })); load(); } catch (e) { setCmsg(String(e?.message || e)); } finally { setBusy(false); } }}>이슈로 등록</button></div>
              )}
          </div>
        ))}
        {canComment
          ? (
            <form ref={formRef} className="wiki-comment-form" onSubmit={async (e) => {
              e.preventDefault();
              if (!comment.trim()) return;
              const ms = mentionsInText(comment);
              const users = ms.map((m) => m.user);
              const wantIssue = ms.length > 0 && (info?.canWrite ? issueOpt.on : issueOpt.request);
              const issue = !wantIssue ? undefined : info?.canWrite
                ? { assignee: users.includes(issueOpt.assignee) ? issueOpt.assignee : users[0], type: issueOpt.type, priority: issueOpt.priority, title: issueOpt.title.trim() }
                : { request: true };
              setBusy(true); setCmsg('');
              try {
                const r = await postJson(`/wiki/pages/${page.id}/comments`, { body: comment, quote, ...(issue ? { issue } : {}) });
                if (r?.ok === false) { setCmsg(wikiSaveFailText(r)); return; } // 400 이면 댓글도 저장되지 않았다 — 글은 그대로 둔다
                setComment(''); setQuote(''); setPicked({}); setIssueOpt((o) => ({ ...o, assignee: '', title: '' }));
                setCmsg(issue ? commentIssueText(r) : persistNote(r?.persist));
                onWritten?.(r); load();
              } catch (err2) { setCmsg(String(err2?.message || err2)); } finally { setBusy(false); }
            }}>
              {quote && <div className="wiki-quote-pick">“{quote}” 에 댓글 <button type="button" className="wiki-mini-act" onClick={() => setQuote('')}>인용 빼기</button></div>}
              <MentionBox value={comment} onChange={setComment} path={`/wiki/pages/${page.id}/mentionables`} rows={3} maxLength={meta.limits?.comment || 2000}
                placeholder="댓글 — @ 뒤에 계정이나 이름을 치면 사람을 찾습니다 · ISS-번호로 이슈를 잇습니다"
                onPick={(cnd) => setPicked((m) => ({ ...m, [cnd.username]: cnd }))} onMeta={setMmeta} />
              {(() => {
                const ms = mentionsInText(comment);
                if (!ms.length) return null;
                return (
                  <>
                    <div className="wiki-mention-chips"><span className="muted wiki-small">언급 {ms.length}:</span>{ms.map((m) => <span key={m.user} className="md-mention"><span className="md-mention-u">@{m.user}</span>{(picked[m.user]?.name || m.name) && <><span className="md-mention-s">/</span><span className="md-mention-n">{picked[m.user]?.name || m.name}</span></>}</span>)}</div>
                    <CommentIssuePane mentions={ms} picked={picked} mmeta={mmeta} canIssue={!!info?.canWrite} value={issueOpt} onChange={setIssueOpt} spaceLabel={spaceName(meta.spaces, space)} />
                  </>
                );
              })()}
              <button className="btn primary" type="submit" disabled={busy || !comment.trim()}>{mentionsInText(comment).length && (info?.canWrite ? issueOpt.on : issueOpt.request) ? '댓글 달기 + 이슈 등록' : '댓글 달기'}</button>
              {cmsg && <div className="banner" role="status" style={{ whiteSpace: 'normal' }}>{cmsg}</div>}
            </form>
          )
          : <div className="muted wiki-small">댓글은 운영자 · 관리자와 요청 권한이 있는 계정이 쓸 수 있습니다.</div>}
      </section>
    </article>
  );
}

/* ───── ③ 편집 · ⑤ 새 문서 ───── */
const SNIPPETS = Object.freeze([
  ['제목', '\n## 제목\n'], ['굵게', '**굵게**'], ['목록', '\n- 항목\n- 항목\n'], ['체크', '\n- [ ] 할 일\n'], ['표', '\n| 열 | 열 |\n|---|---|\n|  |  |\n'],
  ['코드', '\n```bash\n\n```\n'], ['콜아웃', '\n:::warn 주의\n내용\n:::\n'], ['접기', '\n:::fold 더 보기\n내용\n:::\n'], ['목차', '\n[[toc]]\n'], ['문서 링크', '[[문서 제목]]'],
]);

function NewPage({ space, meta, pages, parent, onWritten }) {
  const [, bump] = useState(0);
  const [start, setStart] = useState(null); // { title, body, parentId, template }
  const [title, setTitle] = useState('');
  const [parentId, setParentId] = useState(pages.some((p) => p.id === parent) ? parent : '');
  const [issue, setIssue] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const draft = loadDraft(draftKey(space, 'new'));
  if (start) return <Editor space={space} meta={meta} pages={pages} initial={start} onWritten={onWritten} />;
  const begin = async (id) => {
    setBusy(true); setErr('');
    try {
      const r = await fetchJson(`/wiki/templates/${id}`);
      setStart({ title: title.trim(), body: fillTemplate(r.template.body, issue), parentId, template: id, status: 'draft', labels: [] });
    } catch (e) { setErr(String(e?.message || e)); } finally { setBusy(false); }
  };
  return (
    <div className="wiki-new">
      <h2 className="wiki-title">새 문서 — {spaceName(meta.spaces, space)}</h2>
      {draft && (
        <div className="banner">
          이 브라우저에 저장하지 않은 새 문서 초안이 있습니다({timeText(draft.savedAt)} · {draft.title || '제목 없음'}).
          <button className="btn" onClick={() => setStart({ title: draft.title || '', body: draft.body, parentId: draft.parentId || '', template: draft.template || '', status: draft.status || 'draft', labels: draft.labels || [] })}>이어 쓰기</button>
          <button className="btn" onClick={() => { clearDraft(draftKey(space, 'new')); bump((n) => n + 1); }}>버리기</button>
        </div>
      )}
      <div className="wiki-form-grid">
        <label>제목<input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={meta.limits?.title || 200} placeholder="나중에 편집 화면에서도 바꿀 수 있습니다" /></label>
        <label>상위 문서<Select className="input" value={parentId} onChange={(e) => setParentId(e.target.value)} sort={false}>
          {parentOptions(pages).map((o) => <option key={o.value || 'top'} value={o.value}>{o.label}</option>)}
        </Select></label>
        <label>관련 이슈(선택)<input className="input" value={issue} onChange={(e) => setIssue(e.target.value.toUpperCase())} placeholder="ISS-123 — 템플릿의 관련 이슈 자리에 들어갑니다" maxLength={14} /></label>
      </div>
      {err && <div className="banner warn">{err}</div>}
      <div className="wiki-tpl-grid">
        {(meta.templates || []).map((t) => (
          <button key={t.id} type="button" className="wiki-tpl" disabled={busy} onClick={() => begin(t.id)}>
            <b>{t.name}</b><span className="muted">{t.tag}{t.custom ? ' · 관리자 템플릿' : ''}</span>
          </button>
        ))}
      </div>
      <div className="muted wiki-small">템플릿을 고르면 편집 화면이 열립니다 — 저장하기 전에는 문서가 만들어지지 않습니다.{meta.canTemplates && <> <button type="button" className="md-linkbtn" onClick={() => go({ space, view: 'templates' })}>관리자 템플릿 관리 →</button></>}</div>
    </div>
  );
}

function EditPage({ id, space, meta, pages, onWritten }) {
  const { page, info, err } = usePage(id);
  if (err && !page) return <ErrorBox error={err} />;
  if (!page) return <Loading label="문서" />;
  if (!info?.canWrite || !page.writable) return <div className="card muted">이 문서는 고칠 수 없습니다(쓰기 권한 · 쓰기 범위 · 읽기 전용). <a href={wikiHash({ space, id })}>문서로 돌아가기</a></div>;
  return <Editor space={space} meta={meta} pages={pages} page={page} onWritten={onWritten} />;
}

function Editor({ space, meta, pages, page = null, initial = null, onWritten }) {
  const src = page || initial || {};
  const key = draftKey(space, page ? page.id : 'new');
  const [title, setTitle] = useState(src.title || '');
  const [body, setBody] = useState(src.body || '');
  const [status, setStatus] = useState(src.status || 'draft');
  const [labels, setLabels] = useState((src.labels || []).join(', '));
  const [parentId, setParentId] = useState(src.parentId || '');
  const [noteText, setNoteText] = useState('');
  const [base, setBase] = useState(page ? page.version : null);
  const [baseCheck, setBaseCheck] = useState(page ? (page.checkRev ?? 0) : null); // v2.904 점검 S-1 — 편집 시작 뒤의 체크 토글도 충돌로
  const [mode, setMode] = useState('split');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [conflict, setConflict] = useState(null); // { current, diff, diffErr }
  const [draft, setDraft] = useState(() => {
    if (!page) return null;
    const d = loadDraft(key);
    return d && d.baseVersion === page.version && (d.body !== page.body || d.title !== page.title) ? d : null;
  });
  const ta = useRef(null);
  // v2.888 슬래시 명령 — 줄 머리에서 '/' 를 치면 블록 고르기(↑↓ · Enter/Tab · Esc). 메뉴는 본문 칸 아래에 붙인다(커서 좌표를 재지 않는다).
  const [slash, setSlash] = useState(null); // { q, items, i }
  const syncSlash = (text, caret) => {
    const q = slashQuery(text, caret);
    const items = q ? filterSlash(q.q).slice(0, 8) : [];
    setSlash(q && items.length ? { q: q.q, items, i: 0 } : null);
  };
  const pickSlash = (cmd) => {
    const el = ta.current;
    const caret = el?.selectionStart ?? body.length;
    const r = applySlash(body, caret, cmd);
    setSlash(null);
    if (!r) return;
    setBody(r.body);
    requestAnimationFrame(() => { try { el.focus(); el.setSelectionRange(r.caret, r.caret); } catch { /* 선택 범위를 못 옮기는 브라우저 */ } });
  };
  const onSlashKey = (e) => {
    if (!slash) return;
    if (e.nativeEvent?.isComposing || e.keyCode === 229) return; // v2.904 점검 W-6: 한글 조합 중 Enter(조합 확정)를 메뉴 선택으로 먹지 않는다
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const d = e.key === 'ArrowDown' ? 1 : -1; setSlash((s0) => ({ ...s0, i: (s0.i + d + s0.items.length) % s0.items.length })); }
    else if (e.key === 'Enter' || e.key === 'Tab') {
      // v2.904 점검 W-5: 메뉴가 뜬 뒤 커서를 다른 자리로 옮겼으면 메뉴는 낡은 것 — 닫고 키는 그대로 둔다(Enter 한 번이 사라졌다)
      const caret = ta.current?.selectionStart ?? body.length;
      if (!slashQuery(body, caret)) { setSlash(null); return; }
      e.preventDefault(); pickSlash(slash.items[slash.i]);
    }
    else if (e.key === 'Escape') { e.preventDefault(); setSlash(null); }
  };
  const dirty = title !== (src.title || '') || body !== (src.body || '') || status !== (src.status || 'draft') || labels !== (src.labels || []).join(', ') || parentId !== (src.parentId || '');
  // 초안 자동 저장(1.5초 멈추면) — 이 브라우저에만
  useEffect(() => {
    if (!dirty) return undefined;
    const t = setTimeout(() => saveDraft(key, { title, body, status, labels: parseLabels(labels), parentId, baseVersion: base, template: src.template || '' }), 1500);
    return () => clearTimeout(t);
  }, [dirty, key, title, body, status, labels, parentId, base, src.template]);

  const insert = (snip) => {
    const el = ta.current;
    if (!el) { setBody((b) => b + snip); return; }
    const a = el.selectionStart ?? body.length; const b = el.selectionEnd ?? body.length;
    const next = body.slice(0, a) + snip + body.slice(b);
    setBody(next);
    requestAnimationFrame(() => { try { el.focus(); el.setSelectionRange(a + snip.length, a + snip.length); } catch { /* 선택 범위를 못 옮기는 브라우저 */ } });
  };
  const save = async (overrideBase = null, overrideCheck = null) => {
    setBusy(true); setMsg('');
    const payload = { title: title.trim(), body, status, labels: parseLabels(labels), parentId, note: noteText.trim() };
    try {
      const r = page
        ? await putJson(`/wiki/pages/${page.id}`, { ...payload, baseVersion: overrideBase ?? base, baseCheckRev: overrideCheck ?? baseCheck })
        : await postJson('/wiki/pages', { ...payload, spaceId: space, template: src.template || '', note: noteText.trim() || '처음 만듦' });
      if (isConflict(r)) {
        setMsg(wikiSaveFailText(r));
        let diff = null; let diffErr = '';
        const from = overrideBase ?? base; // v2.904 점검 W-11: 두 번째 충돌의 비교도 방금 실은 판에서
        if (r.kind === 'check' && r.current.version === from) diff = { checkOnly: true }; // 판은 그대로 — 체크만 바뀌었다(비교할 본문 차이 없음)
        else { try { diff = await fetchJson(`/wiki/pages/${page.id}/diff`, { from, to: r.current.version }); } catch (e) { diffErr = String(e?.message || e); } }
        setConflict({ current: r.current, kind: r.kind || '', diff, diffErr });
        return;
      }
      if (r?.ok === false) { setMsg(wikiSaveFailText(r)); return; }
      clearDraft(key);
      onWritten?.(r);
      if (linkFixText(r.linkFix)) setWikiFlash(linkFixText(r.linkFix)); // v2.907 제목을 바꿔 다른 문서의 링크를 고쳤으면 문서 화면에서 알린다
      go({ space, id: r.page.id });
    } catch (e) { setMsg(String(e?.message || e)); } finally { setBusy(false); }
  };
  const cancel = () => {
    if (dirty && !window.confirm('저장하지 않은 내용이 있습니다 — 이 브라우저의 초안은 남겨 둡니다. 나갈까요?')) return;
    go(page ? { space, id: page.id } : { space });
  };
  return (
    <div className="wiki-editor">
      <div className="wiki-editor-head">
        <h2 className="wiki-title">{page ? `편집 — ${page.title}` : '새 문서'}</h2>
        <span className="muted">{page ? `편집 시작 판 v${base}` : spaceName(meta.spaces, space)}</span>
      </div>
      {draft && (
        <div className="banner">
          이 브라우저에 저장하지 않은 초안이 있습니다({timeText(draft.savedAt)}).
          <button className="btn" onClick={() => { setTitle(draft.title || ''); setBody(draft.body); setStatus(draft.status || status); setLabels((draft.labels || []).join(', ')); setParentId(draft.parentId || ''); setDraft(null); }}>불러오기</button>
          <button className="btn" onClick={() => { clearDraft(key); setDraft(null); }}>버리기</button>
        </div>
      )}
      <div className="wiki-form-grid">
        <label className="span2">제목<input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={meta.limits?.title || 200} /></label>
        <label>상태<Select className="input" value={status} onChange={(e) => setStatus(e.target.value)} sort={false}>
          {STATUS_ORDER.map((s) => <option key={s} value={s}>{statusText(s)}</option>)}
        </Select></label>
        <label>상위 문서<Select className="input" value={parentId} onChange={(e) => setParentId(e.target.value)} sort={false}>
          {parentOptions(pages, page?.id || '').map((o) => <option key={o.value || 'top'} value={o.value}>{o.label}</option>)}
        </Select></label>
        <label>라벨<input className="input" value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="쉼표로 — faq 를 달면 대문 ‘자주 묻는 질문’ 에 모입니다" /></label>
        <label>판 메모<input className="input" value={noteText} onChange={(e) => setNoteText(e.target.value)} maxLength={meta.limits?.note || 200} placeholder="무엇을 바꿨는지 한 줄 — 이력에 남습니다" /></label>
      </div>
      <div className="wiki-toolbar">
        {SNIPPETS.map(([label, snip]) => <button key={label} type="button" className="btn" onClick={() => insert(snip)}>{label}</button>)}
        <IssuePicker onPick={(key) => insert(key)} />
        <span className="wiki-grow" />
        {[['split', '나란히'], ['edit', '편집만'], ['preview', '미리보기']].map(([k, l]) => <button key={k} type="button" className={`btn${mode === k ? ' primary' : ''}`} onClick={() => setMode(k)}>{l}</button>)}
      </div>
      <div className={`wiki-editor-panes m-${mode}`}>
        {mode !== 'preview' && (
          <div className="wiki-textarea-wrap">
            <textarea ref={ta} className="input wiki-textarea" value={body} spellCheck={false} aria-label="본문(마크다운) — 줄 머리에서 / 로 블록 넣기" maxLength={meta.limits?.body || 65536}
              onChange={(e) => { setBody(e.target.value); syncSlash(e.target.value, e.target.selectionStart); }}
              onKeyDown={onSlashKey} onBlur={() => setTimeout(() => setSlash(null), 150)}
              aria-expanded={!!slash} aria-controls={slash ? 'wiki-slash-menu' : undefined} />
            {slash && (
              <div id="wiki-slash-menu" className="wiki-slash" role="listbox" aria-label="블록 넣기">
                <div className="wiki-slash-head muted">/{slash.q} — ↑↓ 고르기 · Enter 넣기 · Esc 닫기</div>
                {slash.items.map((c, i) => (
                  <button key={c.k} type="button" role="option" aria-selected={i === slash.i} className={`wiki-slash-item${i === slash.i ? ' on' : ''}`}
                    onMouseDown={(e) => { e.preventDefault(); pickSlash(c); }}>{c.label}<span className="muted">{c.keys[0]}</span></button>
                ))}
              </div>
            )}
          </div>
        )}
        {mode !== 'edit' && (
          <div className="wiki-preview" aria-label="미리보기">
            {body.trim() ? <MdView md={body} idPrefix="pv" pages={pages} spaceId={space} /> : <div className="muted">미리보기 — 본문을 쓰면 여기에 보입니다.</div>}
          </div>
        )}
      </div>
      <div className="muted wiki-small">{body.length.toLocaleString()} / {(meta.limits?.body || 65536).toLocaleString()}자 · 마크다운 — HTML 은 글자 그대로 보입니다 · 줄 머리에서 / 를 치면 블록을 고릅니다 · 초안은 이 브라우저에 자동 저장합니다.</div>
      {page ? <AttachBox kind="wiki" owner={page.id} onInsert={(md) => insert(md)} compact /> : <div className="muted wiki-small">첨부는 문서를 만든 뒤 편집 화면에서 올릴 수 있습니다.</div>}
      {msg && <div className="banner warn" style={{ whiteSpace: 'normal' }}>{msg}</div>}
      {conflict && (
        <div className="card wiki-conflict">
          {conflict.diff?.checkOnly
            ? <><b>편집을 시작한 뒤 체크리스트가 바뀌었습니다({conflict.current.by || '다른 사람'} · {timeText(conflict.current.at)})</b>
              <div className="muted wiki-small">본문의 판은 그대로이고 체크 상태만 달라졌습니다. 내 글로 저장하면 그 체크가 내 글의 체크 상태로 돌아갑니다 — 지금 판을 새 창으로 열어 확인하세요.</div></>
            : <><b>v{base} → v{conflict.current.version} 사이에 바뀐 것(다른 사람의 저장)</b>
              {conflict.diff ? <DiffBlock d={conflict.diff} /> : <div className="muted">{conflict.diffErr ? `비교를 읽지 못했습니다 — ${conflict.diffErr}` : '비교를 읽는 중…'}</div>}</>}
          <div className="wiki-actions">
            {/* v2.901(점검 W4): 비교를 못 읽었으면 '확인하고' 저장을 열지 않는다(상대가 고친 내용을 보지 못한 채 덮어쓰게 된다) — 비교를 다시 읽을 수 있다 */}
            <button className="btn primary" disabled={busy || !conflict.diff} title={conflict.diff ? undefined : '바뀐 내용을 먼저 확인해야 저장할 수 있습니다'} onClick={() => { const v = conflict.current.version; const cr = conflict.current.checkRev ?? baseCheck; setBase(v); setBaseCheck(cr); setConflict(null); save(v, cr); }}>확인하고 내 글로 저장</button>
            {!conflict.diff && conflict.diffErr && <button className="btn" disabled={busy} onClick={async () => {
              const cur = conflict; let diff = null; let diffErr = '';
              try { diff = await fetchJson(`/wiki/pages/${page.id}/diff`, { from: base, to: cur.current.version }); } catch (e) { diffErr = String(e?.message || e); }
              setConflict((c) => (c && c.current.version === cur.current.version ? { ...c, diff, diffErr } : c));
            }}>비교 다시 읽기</button>}
            <a className="btn" href={wikiHash({ space, id: page.id })} target="_blank" rel="noopener noreferrer">지금 판 새 창으로 보기</a>
          </div>
        </div>
      )}
      <div className="wiki-actions wiki-editor-foot">
        <button className="btn primary" disabled={busy || !title.trim()} onClick={() => save()}>{page ? '저장(새 판)' : '만들기'}</button>
        <button className="btn" disabled={busy} onClick={cancel}>취소</button>
      </div>
    </div>
  );
}

/**
 * 이슈 찾기(v2.883 · 시안 ③ '이슈 링크 찾기') — 키 · 제목으로 찾아 본문에 'ISS-번호' 를 넣는다(저장하면 자동 링크 + 역참조).
 * 내가 볼 수 있는 이슈만(서버 /issues 의 범위). 입력이 멈추면 한 번 찾는다(300ms).
 */
function IssuePicker({ onPick }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const latest = useLatest();
  useEffect(() => {
    if (!open) return undefined;
    const t = setTimeout(() => {
      const k = latest.next();
      fetchJson('/issues', { q: q.trim(), done: 'all', limit: 12 }).then((r) => { if (latest.isLatest(k)) { setRows(r.rows || []); setErr(''); } })
        .catch((e) => { if (latest.isLatest(k)) { setRows([]); setErr(String(e?.message || e)); } });
    }, 300);
    return () => clearTimeout(t);
  }, [open, q, latest]);
  if (!open) return <button type="button" className="btn" onClick={() => setOpen(true)}>이슈 찾기</button>;
  return (
    <div className="wiki-issue-pick" role="dialog" aria-label="이슈 찾기">
      <input className="input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="키 · 제목 · 담당자" maxLength={100} aria-label="이슈 찾기" />
      <button type="button" className="btn" onClick={() => { setOpen(false); setQ(''); setRows(null); }}>닫기</button>
      <div className="wiki-issue-pick-list">
        {err && <div className="muted wiki-small">{err}</div>}
        {rows == null && <div className="muted wiki-small">찾는 중…</div>}
        {rows && rows.length === 0 && !err && <div className="muted wiki-small">찾은 이슈가 없습니다(내가 볼 수 있는 이슈만).</div>}
        {(rows || []).map((r) => (
          <button key={r.key} type="button" className="wiki-issue-pick-item" onClick={() => { onPick(r.key); setOpen(false); setQ(''); setRows(null); }}>
            <span className="md-iss">{r.key}</span> <span className="wiki-issue-pick-title">{r.title}</span> <span className="muted wiki-small">{issueStatusText(r.status)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ───── ④ 이력 · 비교 · 되돌리기 ───── */
function DiffBlock({ d }) {
  return (
    <div className="wiki-diff">
      <div className="muted wiki-small">{diffSummary(d)}</div>
      <pre className="wiki-diff-pre">
        {(d.ops || []).map((o, k) => (o.op === 'gap'
          ? <div key={k} className="wd gap">{DIFF_MARK.gap} 같은 줄 {o.skipped}개</div>
          : <div key={k} className={`wd ${o.op}`}><span className="wd-n">{o.a ?? ''}</span><span className="wd-n">{o.b ?? ''}</span><span className="wd-m">{DIFF_MARK[o.op]}</span><span className="wd-t">{o.text || ' '}</span></div>))}
      </pre>
    </div>
  );
}

function HistoryView({ id, space, meta, onWritten }) {
  const { page, info, err, load } = usePage(id);
  const [from, setFrom] = useState(null);
  const [to, setTo] = useState(null);
  const [diff, setDiff] = useState(null);
  const [side, setSide] = useState(null); // { a, b } 렌더 나란히
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const latest = useLatest();
  useEffect(() => {
    if (!page || from != null) return;
    const vs = page.versions.filter((v) => v.hasBody);
    if (vs.length >= 2) { setTo(vs[0].v); setFrom(vs[1].v); }
  }, [page, from]);
  if (err && !page) return <ErrorBox error={err} />;
  if (!page) return <Loading label="이력" />;
  const writable = !!info?.canWrite && page.writable;
  const compare = async (sideBySide = false) => {
    if (from == null || to == null || from === to) { setMsg('서로 다른 두 판을 고르세요.'); return; }
    const k = latest.next(); setMsg(''); setDiff(null); setSide(null);
    try {
      if (sideBySide) {
        const [a, b] = await Promise.all([fetchJson(`/wiki/pages/${id}/versions/${from}`), fetchJson(`/wiki/pages/${id}/versions/${to}`)]);
        if (latest.isLatest(k)) setSide({ a: a.version, b: b.version });
      } else {
        const r = await fetchJson(`/wiki/pages/${id}/diff`, { from, to });
        if (latest.isLatest(k)) setDiff(r);
      }
    } catch (e) { if (latest.isLatest(k)) setMsg(String(e?.message || e)); }
  };
  const revert = async (v) => {
    if (!window.confirm(`v${v} 의 본문으로 되돌릴까요? 지금 판은 지워지지 않고, v${v} 본문으로 새 판(v${page.version + 1})을 만듭니다.`)) return;
    setBusy(true); setMsg('');
    try {
      const r = await postJson(`/wiki/pages/${id}/revert`, { v });
      if (r?.ok === false) setMsg(wikiSaveFailText(r)); else { onWritten?.(r); load(); }
    } catch (e) { setMsg(String(e?.message || e)); } finally { setBusy(false); }
  };
  return (
    <div className="wiki-history">
      <div className="wiki-editor-head">
        <h2 className="wiki-title">이력 — <a href={wikiHash({ space, id })}>{page.title}</a></h2>
        <span className="muted">판 {page.versions.length}개{page.versionsDropped ? ` · 오래된 판 ${page.versionsDropped}개는 접었습니다` : ''} · 본문은 최근 {meta.limits?.versionsBody ?? '—'}판만 보관</span>
      </div>
      {msg && <div className="banner warn">{msg}</div>}
      <STable className="tbl" minWidth={720}>
        <thead><tr><th>판</th><th>시각</th><th>쓴 사람</th><th>메모</th><th>상태</th><th>길이</th><th data-nosort>비교(이전 · 이후)</th><th data-nosort>되돌리기</th></tr></thead>
        <tbody>
          {page.versions.map((v) => (
            <tr key={v.v}>
              <td data-sort={v.v}>v{v.v}{v.v === page.version ? ' (지금)' : ''}</td>
              <td data-sort={v.at}>{timeText(v.at)}</td>
              <td>{v.by || '—'}</td>
              <td>{v.note || '—'}</td>
              <td>{v.status ? statusText(v.status) : '—'}</td>
              <td data-sort={v.len != null ? v.len : undefined}>{v.len != null ? `${v.len.toLocaleString()}자` : '—'}</td>
              <td>{v.hasBody
                ? <span className="wiki-radio"><label><input type="radio" name="from" checked={from === v.v} onChange={() => setFrom(v.v)} /> 이전</label> <label><input type="radio" name="to" checked={to === v.v} onChange={() => setTo(v.v)} /> 이후</label></span>
                : <span className="muted wiki-small">본문 없음</span>}</td>
              <td>{writable && v.hasBody && v.v !== page.version ? <button className="btn" disabled={busy} onClick={() => revert(v.v)}>이 판으로</button> : <span className="muted">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </STable>
      <div className="wiki-actions">
        <button className="btn primary" onClick={() => compare(false)}>줄 단위 비교</button>
        <button className="btn" onClick={() => compare(true)}>렌더 나란히</button>
      </div>
      {diff && <DiffBlock d={diff} />}
      {side && (
        <div className="wiki-side-by-side">
          {[side.a, side.b].map((v) => (
            <div key={v.v} className="card">
              <div className="muted wiki-small">{versionLine(v)}{v.note ? ` · ${v.note}` : ''}</div>
              <MdView md={v.body || ''} idPrefix={`sv${v.v}`} spaceId={space} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ───── ⑤ 찾기 ───── */
function SearchView({ space, params, meta }) {
  const [allSpaces, setAllSpaces] = useState(false);
  const [status, setStatus] = useState(params.status || '');
  const [archived, setArchived] = useState(false);
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const latest = useLatest();
  const q = params.q || '';
  const label = params.label || '';
  useEffect(() => {
    const k = latest.next();
    setData(null); setErr(null); // v2.904 점검 W-12: 옛 오류가 새 검색 동안 남아 Loading 을 가렸다
    fetchJson('/wiki/search', { q, label, space: allSpaces ? '' : space, status, archived: archived ? '1' : '', limit: 50 })
      .then((r) => { if (latest.isLatest(k)) { setData(r); setErr(null); } }).catch((e) => { if (latest.isLatest(k)) setErr(e); });
  }, [q, label, space, allSpaces, status, archived, latest]);
  return (
    <div className="wiki-search-view">
      <div className="wiki-editor-head">
        <h2 className="wiki-title">찾기{label ? ` — 라벨 ‘${label}’` : ''}</h2>
        <span className="muted">{data ? searchSummary(data, q) : ''}</span>
      </div>
      <div className="wiki-filters">
        <label className="wiki-check"><input type="checkbox" checked={allSpaces} onChange={(e) => setAllSpaces(e.target.checked)} /> 모든 스페이스(볼 수 있는 것)</label>
        <Select className="input" value={status} onChange={(e) => setStatus(e.target.value)} sort={false} aria-label="상태">
          <option value="">상태 전체(보관 제외)</option>
          {STATUS_ORDER.map((s) => <option key={s} value={s}>{statusText(s)}</option>)}
        </Select>
        {!status && <label className="wiki-check"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> 보관 포함</label>}
        {label && <a className="btn" href={wikiHash({ space, view: 'search', params: { q } })}>라벨 풀기</a>}
      </div>
      {err && <ErrorBox error={err} />}
      {!data && !err && <Loading label="찾기" />}
      {data && (data.rows.length
        ? (
          <div className="wiki-results">
            {data.rows.map((r) => (
              <a key={r.id} className="wiki-result" href={wikiHash({ space: r.spaceId, id: r.id })}>
                <div className="wiki-result-head"><b>{r.title}</b> <StatusChip s={r.status} />
                  <span className="muted wiki-small"> · {spaceName(meta.spaces, r.spaceId)} · v{r.version} · {r.updatedBy || '—'} · {dateText(r.updatedAt)}{r.where ? ` · ${WHERE_TEXT[r.where]}에서` : ''}</span></div>
                {r.snippet && <div className="wiki-snippet muted">{r.snippet}</div>}
              </a>
            ))}
          </div>
        )
        : <div className="card muted">찾은 문서가 없습니다{q ? ` — ‘${q}’` : ''}.</div>)}
    </div>
  );
}

/* ───── 스페이스 설정(대문 꾸미기) — 관리자 ───── */
function toLocalInput(ms) {
  if (!ms) return '';
  const d = new Date(ms); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
/** v2.889 관리자 템플릿 — 전 법인 공용(모든 스페이스의 '새 문서'). 관리자 + 전체 범위(서버가 같은 기준으로 막는다). */
function TemplatesAdmin({ space, meta, onWritten }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [form, setForm] = useState(null); // { id, name, tag, body }
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const load = useCallback(() => { fetchJson('/wiki/templates').then((r) => { setData(r); setErr(null); }).catch(setErr); }, []);
  useEffect(() => { if (meta.canTemplates) load(); }, [load, meta.canTemplates]);
  if (!meta.canTemplates) return <div className="card muted">관리자 템플릿은 전체 범위(vCenter 제한 없는) 관리자만 바꿉니다.</div>;
  if (err && !data) return <ErrorBox error={err} />;
  if (!data) return <Loading label="관리자 템플릿" />;
  const lim = data.limits || {};
  const saveTpl = async () => {
    setBusy(true); setMsg('');
    try {
      const body = { name: form.name, tag: form.tag, body: form.body };
      const r = form.id ? await putJson(`/wiki/templates/${form.id}`, body) : await postJson('/wiki/templates', body);
      if (r?.ok === false) { setMsg(wikiSaveFailText(r)); return; }
      setForm(null); setMsg('저장했습니다 — 모든 스페이스의 ‘새 문서’ 에 보입니다.'); load(); onWritten?.();
    } catch (e) { setMsg(String(e?.message || e)); } finally { setBusy(false); }
  };
  const del = async (t) => {
    if (!window.confirm(`템플릿 ‘${t.name}’ 를 지울까요? 이미 만든 문서는 그대로입니다.`)) return;
    setBusy(true); setMsg('');
    try { const r = await delJson(`/wiki/templates/${t.id}`); setMsg(r?.ok === false ? wikiSaveFailText(r) : '지웠습니다.'); load(); onWritten?.(); } catch (e) { setMsg(String(e?.message || e)); } finally { setBusy(false); }
  };
  return (
    <div className="wiki-settings">
      <div className="wiki-editor-head"><h2 className="wiki-title">관리자 템플릿</h2><span className="muted">내장 템플릿 뒤에 붙습니다 · {lim.max ?? 30}개까지 · 전 법인 공용</span></div>
      {err && <div className="banner warn" style={{ whiteSpace: 'normal' }}>템플릿 목록을 새로 읽지 못했습니다 — 아래는 직전에 읽은 목록입니다({err.message || String(err)}).</div>}{/* v2.904 점검 W-9 */}
      {data.loadError && <div className="banner bad" style={{ whiteSpace: 'normal' }}>템플릿 파일(wiki-templates.json)을 읽지 못해 빈 목록으로 보입니다 — 손상본은 옆에 보존했습니다. 원인: {data.loadError}</div>}
      {msg && <div className="banner">{msg}</div>}
      {(data.items || []).length === 0 && !form && <div className="muted">아직 관리자 템플릿이 없습니다.</div>}
      <ul className="wiki-list">
        {(data.items || []).map((t) => (
          <li key={t.id}><b>{t.name}</b> <span className="muted">{t.tag || '—'} · {t.updatedBy || '—'} · {dateText(t.updatedAt)}</span>
            <button type="button" className="wiki-mini-act" disabled={busy} onClick={() => setForm({ id: t.id, name: t.name, tag: t.tag || '', body: t.body })}>고치기</button>
            <button type="button" className="wiki-mini-act" disabled={busy} onClick={() => del(t)}>지우기</button></li>
        ))}
      </ul>
      {form ? (
        <div className="card wiki-tpl-form">
          <div className="wiki-form-grid">
            <label>이름<input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={lim.name || 40} /></label>
            <label>꼬리표<input className="input" value={form.tag} onChange={(e) => setForm({ ...form, tag: e.target.value })} maxLength={lim.tag || 20} placeholder="예: 점검" /></label>
          </div>
          <label className="wiki-block">본문(마크다운 — {'{{issue}}'} 는 새 문서 화면의 ‘관련 이슈’ 로 채워집니다)
            <textarea className="input wiki-textarea short" value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} maxLength={lim.body || 20000} spellCheck={false} />
          </label>
          <div className="wiki-actions">
            <button className="btn primary" disabled={busy || !form.name.trim() || !form.body.trim()} onClick={() => saveTpl()}>{form.id ? '저장' : '만들기'}</button>
            <button className="btn" disabled={busy} onClick={() => setForm(null)}>취소</button>
          </div>
        </div>
      ) : <div className="wiki-actions"><button className="btn primary" disabled={busy || (data.items || []).length >= (lim.max || 30)} onClick={() => setForm({ id: '', name: '', tag: '', body: '# 제목\n\n' })}>+ 템플릿</button><button className="btn" onClick={() => go({ space, view: 'new' })}>새 문서 화면으로</button></div>}
    </div>
  );
}

function SpaceSettings({ space, meta, spaceInfo, onWritten }) {
  const [s, setS] = useState(null);
  const [err, setErr] = useState(null);
  const [homeMd, setHomeMd] = useState('');
  const [notice, setNotice] = useState('');
  const [until, setUntil] = useState('');
  const [links, setLinks] = useState('');
  const [readOnly, setReadOnly] = useState(false);
  const [owners, setOwners] = useState(''); // v2.889 대문 담당(쉼표)
  const [oncall, setOncall] = useState(''); // v2.889 당번 표(한 줄에 '사람 | 시작 | 끝 | 메모')
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    fetchJson(`/wiki/spaces/${encodeURIComponent(space)}`).then((r) => {
      const v = r.space; setS(v); setHomeMd(v.homeMd || ''); setNotice(v.notice?.md || ''); setUntil(toLocalInput(v.notice?.until)); setLinks(quickLinksToText(v.quickLinks)); setReadOnly(!!v.readOnly);
      setOwners((v.owners || []).join(', ')); setOncall(oncallToText(v.oncall));
    }).catch(setErr);
  }, [space]);
  const parsedLinks = useMemo(() => textToQuickLinks(links), [links]);
  const parsedOncall = useMemo(() => textToOncall(oncall), [oncall]);
  if (!meta.isAdmin || !spaceInfo?.writable) return <div className="card muted">대문 꾸미기(스페이스 설정)는 그 스페이스의 쓰기 범위가 있는 관리자만 할 수 있습니다.</div>;
  if (err && !s) return <ErrorBox error={err} />;
  if (!s) return <Loading label="스페이스 설정" />;
  const bad = parsedLinks.filter((l) => !l.title || !quickHref(l.href));
  const saveSpace = async () => {
    setBusy(true); setMsg('');
    try {
      const u = until ? new Date(until).getTime() : null;
      if (parsedOncall.bad.length) { setMsg(`당번 표 ${parsedOncall.bad.join(', ')}번째 줄을 읽지 못했습니다 — ‘사람 | YYYY-MM-DD | YYYY-MM-DD | 메모’(끝은 시작과 같거나 뒤)`); return; }
      const r = await putJson(`/wiki/spaces/${encodeURIComponent(space)}`, { homeMd, notice: notice.trim() ? { md: notice, until: Number.isFinite(u) ? u : null } : null, quickLinks: parsedLinks, readOnly, owners: owners.split(',').map((x) => x.trim()).filter(Boolean), oncall: parsedOncall.rows });
      if (r?.ok === false) { setMsg(wikiSaveFailText(r)); return; }
      onWritten?.(r); go({ space });
    } catch (e) { setMsg(String(e?.message || e)); } finally { setBusy(false); }
  };
  return (
    <div className="wiki-settings">
      <div className="wiki-editor-head"><h2 className="wiki-title">대문 꾸미기 — {spaceName(meta.spaces, space)}</h2>
        <span className="muted">{s.updatedAt ? `마지막 ${s.updatedBy || '—'} · ${timeText(s.updatedAt)}` : '아직 꾸미지 않았습니다'}</span></div>
      <div className="muted wiki-small">대문의 숫자 · 최근 수정 · 검토 중 · 목차 · 라벨은 자동으로 모입니다 — 손으로 적는 것은 아래 셋뿐입니다(손으로 적은 대문이 낡는 것을 막으려고).</div>
      <label className="wiki-block">소개 글(목적 · 범위 · 담당 · 연락 채널 — 마크다운)
        <textarea className="input wiki-textarea short" value={homeMd} onChange={(e) => setHomeMd(e.target.value)} maxLength={meta.limits?.homeMd || 10000} />
      </label>
      <div className="wiki-form-grid">
        <label className="span2">공지(비우면 내림 — 마크다운)<textarea className="input" rows={3} value={notice} onChange={(e) => setNotice(e.target.value)} maxLength={meta.limits?.notice || 1000} /></label>
        <label>공지 기한(선택)<input className="input" type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} /></label>
      </div>
      <label className="wiki-block">바로 가기(한 줄에 ‘제목 | 주소 | 설명’ — 주소는 #/… 포탈 주소나 https://… · {meta.limits?.quickLinks ?? 12}개까지)
        <textarea className="input" rows={6} value={links} onChange={(e) => setLinks(e.target.value)} placeholder={'장애 대응 절차 | #/wiki/pub/W1 | 처음 볼 것\n이슈 보드 | #/issues/board'} />
      </label>
      {bad.length > 0 && <div className="banner warn">바로 가기 {bad.length}줄의 제목이나 주소를 읽지 못했습니다 — 저장하면 서버가 거절합니다: {bad.map((l) => l.title || '(제목 없음)').join(', ')}</div>}
      <div className="wiki-form-grid">
        <label>담당(계정 · 쉼표 — 대문에 보입니다 · {meta.limits?.owners ?? 10}명까지)<input className="input" value={owners} onChange={(e) => setOwners(e.target.value)} placeholder="kim, lee" /></label>
        <label className="span2">당번 표(한 줄에 ‘사람 | 시작 | 끝 | 메모’ — 날짜는 포탈 날짜 YYYY-MM-DD · 끝을 비우면 하루 · {meta.limits?.oncall ?? 30}줄까지)
          <textarea className="input" rows={4} value={oncall} onChange={(e) => setOncall(e.target.value)} placeholder={'kim | 2026-11-03 | 2026-11-09 | 야간 대응\nlee | 2026-11-10 | 2026-11-16'} />
        </label>
      </div>
      {parsedOncall.bad.length > 0 && <div className="banner warn">당번 표 {parsedOncall.bad.join(', ')}번째 줄을 읽지 못했습니다 — 저장하면 거절합니다.</div>}
      <label className="wiki-check"><input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} /> 읽기 전용(새 문서 · 편집을 막습니다 — 댓글은 그대로)</label>
      {msg && <div className="banner warn">{msg}</div>}
      <div className="wiki-actions">
        <button className="btn primary" disabled={busy} onClick={() => saveSpace()}>저장</button>
        <button className="btn" disabled={busy} onClick={() => go({ space })}>취소</button>
      </div>
    </div>
  );
}
