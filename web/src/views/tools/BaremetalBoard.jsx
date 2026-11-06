/**
 * BaremetalBoard.jsx — 서버 › 물리 서버 '상태 보드' 탭(v2.916).
 * 설계 레퍼런스: docs/design/baremetal/ (Claude Design 시안 A — Datadog Host Map · Infrastructure List 구성 참고).
 *
 *   ① KPI 띠(클릭 = 호스트 맵·표 필터)  ② 호스트 맵(서버 1대 = 타일 1개 · 법인별 묶음)
 *   ③ 주의 필요 서버 · 모델 분포 · 판정 못한 사유  ④ 서버 표(STable — 헤더 정렬)
 *
 * 규칙(회귀 방지):
 *  · 판정은 서버(serverPartsCell) — 이 화면은 baremetalBoardText.js 로 접고 세기만 한다. 확인 불가·판정 못함은 정상으로 세지 않는다.
 *  · 데이터는 /admin/idrac?parts=1 마운트 1회 + 새로고침 버튼(무거운 API 15초 폴링 금지). 늦게 온 이전 응답은 버린다.
 *  · 목록 API 에 없는 값(온도·BIOS·부품 이름)은 지어내지 않는다 — 상세(타일·행 클릭 → iDRAC 상세)에서 본다.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import ScopeOmitBanner from '../ScopeOmitBanner.jsx';
import { partsCell } from '../idrac/hwStatusText.js';
import {
  BOARD_STATE_TEXT, BOARD_STATE_TONE, buildBoard, matchBoardFilter, attentionDetail, tileTitle, ageText,
  scopeMatchServer, matchServerQuery, boardScopeText, nojudgeShortText,
} from './baremetalBoardText.js';

const DENSITY_KEY = 'bmBoard.density';
const readDensity = () => { try { return window.localStorage.getItem(DENSITY_KEY) === 'dense' ? 'dense' : 'comfortable'; } catch { return 'comfortable'; } };
const TABLE_LIMIT = 200;
const ATTN_MAX = 8;
const MODEL_MAX = 8;

const KPI_DEF = [
  { k: 'all', label: '등록 서버', dot: 'var(--accent)' },
  { k: 'fault', label: '장애', dot: 'var(--red)' },
  { k: 'warn', label: '경고', dot: 'var(--amber)' },
  { k: 'ok', label: '정상', dot: 'var(--green)' },
  { k: 'partial', label: '일부 확인 불가', dot: 'var(--bmb-partial)' },
  { k: 'nojudge', label: '판정 못함', dot: 'var(--bmb-nojudge)' },
  { k: 'stale', label: '오래됨', dot: 'var(--purple)' },
];
const KPI_META = {
  all: (c, b) => (b.omeSkipped ? `OME 콘솔 ${b.omeSkipped}개는 세지 않음` : '서버 1대 = 타일 1개'),
  fault: () => '장애 부품이 있는 서버',
  warn: () => '경고 부품이 있는 서버(장애 없음)',
  ok: () => '확인한 부품이 모두 정상',
  partial: () => '읽지 못한 부품이 있음 — 정상으로 세지 않음',
  nojudge: (c, b) => (b.reasons.length ? b.reasons.slice(0, 2).map((r) => `${nojudgeShortText(r.key)} ${r.n}`).join(' · ') : '정상도 장애도 아님'),
  stale: () => '인벤토리가 오래됨 — 판정은 유지하고 따로 셈',
};

export default function BaremetalBoard({ vc, onServer, bm = false, dcLabel = '' }) {
  const [d, setD] = useState(null);
  const [dcs, setDcs] = useState({ datacenters: [], assign: {}, err: null });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [corp, setCorp] = useState(''); // 법인 묶음 이름 클릭 → 표를 그 법인으로
  const [density, setDensity] = useState(readDensity);
  const [showAll, setShowAll] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const seq = useRef(0);
  const tableRef = useRef(null);

  const load = () => {
    const my = ++seq.current;
    setBusy(true);
    Promise.all([
      fetchJson('/admin/idrac?parts=1'),
      fetchJson('/admin/datacenters').then((r) => ({ datacenters: r.datacenters || [], assign: r.assign || {}, err: null })).catch((e) => ({ datacenters: [], assign: {}, err: e })),
    ]).then(([r, dc]) => {
      if (my !== seq.current) return; // 늦게 온 이전 응답은 버린다
      setD(r || {}); setDcs(dc); setErr(null); setNow(Date.now());
    }).catch((e) => { if (my === seq.current) setErr(e.message || String(e)); })
      .finally(() => { if (my === seq.current) setBusy(false); });
  };
  useEffect(() => { const box = seq; load(); return () => { box.current++; }; }, []); // 마운트 1회(무거운 API — 폴링 금지)

  const board = useMemo(() => {
    if (!d) return null;
    const assign = dcs.assign || {};
    const dcName = new Map((dcs.datacenters || []).map((x) => [x.id, x.name || x.id]));
    const servers = (Array.isArray(d.servers) ? d.servers : []).filter((s) => scopeMatchServer(s, vc, assign) && matchServerQuery(s, q));
    return buildBoard(servers, { dcName, assign, dcErr: !!dcs.err });
  }, [d, dcs, vc, q]);

  const toggleDensity = () => {
    const v = density === 'dense' ? 'comfortable' : 'dense';
    setDensity(v);
    try { window.localStorage.setItem(DENSITY_KEY, v); } catch { /* 저장 못 해도 화면은 동작 */ }
  };
  const pickFilter = (k) => { setFilter((cur) => (cur === k && k !== 'all' ? 'all' : k)); setShowAll(false); };
  const pickCorp = (id) => {
    setCorp((cur) => (cur === id ? '' : id)); setShowAll(false);
    window.requestAnimationFrame?.(() => tableRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }));
  };

  if (err) return <ErrorBox message={err} />;
  if (!board) return <Loading />;

  const { counts } = board;
  const scopeMeta = d?.scoped ? { scoped: true, omittedOutOfScope: d.omittedOutOfScope } : null;
  const filterText = filter === 'all' ? '전체' : `${filter === 'stale' ? '오래됨' : BOARD_STATE_TEXT[filter]}만 강조`;
  const tableRows = board.rows.filter((r) => matchBoardFilter(r, filter) && (!corp || r.dc === corp));
  const corpName = corp ? (board.groups.find((g) => g.id === corp)?.name || corp) : '';
  const modelTop = board.models[0]?.n || 1;

  return (
    <div className="bmb" data-density={density}>
      <ScopeOmitBanner data={scopeMeta} />

      {/* 머리 */}
      <div className="bmb-head">
        <div style={{ minWidth: 0 }}>
          <div className="bmb-title">상태 보드 <span className="muted">{boardScopeText({ bm, dcLabel })}</span></div>
          <div className="bmb-sub muted">
            <span>인벤토리 최신 수집 <b>{ageText(board.newestAt, now)}</b></span>
            <span>판정 기준 <b>iDRAC 부품 상태</b> — 못 읽은 장비·부품은 정상에도 장애에도 넣지 않고 따로 셉니다</span>
            {board.authStopped > 0 && <span className="badge amber" title="인증 실패로 주기 수집을 멈춘 서버 — 설정 › iDRAC 서버 등록에서 계정을 고치면 다시 수집합니다">인증 실패로 수집 정지 {board.authStopped}</span>}
          </div>
        </div>
        <div className="bmb-tools">
          <label className="bmb-search">
            <input className="input" type="search" placeholder="이름 · 서비스태그 · 주소 · 모델" value={q} onChange={(e) => setQ(e.target.value)} aria-label="서버 검색" />
          </label>
          <button type="button" className="tab bmb-btn" aria-pressed={density === 'dense'} onClick={toggleDensity} title="타일 크기 — 여유 / 촘촘히">
            {density === 'dense' ? '▦ 촘촘히' : '▢ 여유'}
          </button>
          <button type="button" className="logout-btn bmb-btn" onClick={load} disabled={busy}>{busy ? '불러오는 중…' : '↻ 새로고침'}</button>
        </div>
      </div>

      {/* KPI 띠 */}
      <div className="bmb-kpis" role="group" aria-label="상태별 서버 수 — 누르면 그 상태만 강조">
        {KPI_DEF.map((x) => (
          <button key={x.k} type="button" className="bmb-kpi" data-on={filter === x.k ? '1' : '0'} aria-pressed={filter === x.k} onClick={() => pickFilter(x.k)}>
            <span className="bmb-kpi-label"><i style={{ background: x.dot }} />{x.label}</span>
            <span className="bmb-kpi-value">{(counts[x.k] || 0).toLocaleString()}</span>
            <span className="bmb-kpi-meta">{KPI_META[x.k](counts, board)}</span>
          </button>
        ))}
      </div>

      {board.rows.length === 0 ? (
        <div className="card" style={{ padding: 16 }}>
          <span className="muted">{q ? '검색어와 맞는 서버가 없습니다.' : '이 범위에 등록된 서버가 없습니다. ‘설정 › iDRAC 서버 등록 › 법인별 iDRAC 장비 스캔’ 에서 등록하세요.'}</span>
        </div>
      ) : (
        <>
          <div className="bmb-main">
            {/* 호스트 맵 */}
            <section className="card bmb-map" aria-label="호스트 맵">
              <div className="bmb-sec-head">
                <div><h3>호스트 맵</h3><span className="muted">서버 1대 = 타일 1개 · 법인별 묶음 · {filterText}</span></div>
                <div className="bmb-legend" aria-hidden="true">
                  <span><i className="bmb-tile s-ok" />정상</span>
                  <span><i className="bmb-tile s-warn" />경고</span>
                  <span><i className="bmb-tile s-fault" />장애</span>
                  <span><i className="bmb-tile s-partial" />일부 확인 불가</span>
                  <span><i className="bmb-tile s-nojudge" />판정 못함</span>
                  <span><i className="bmb-tile s-ok stale" />오래됨</span>
                </div>
              </div>
              <div className="bmb-groups">
                {board.groups.map((g) => (
                  <div key={g.id} className="bmb-grp" data-on={corp === g.id ? '1' : '0'}>
                    <div className="bmb-grp-head">
                      <button type="button" className="bmb-link" onClick={() => pickCorp(g.id)} title={`${g.name} 서버만 아래 표에 보기`}>{g.id === '__unmapped__' ? '⚠ ' : ''}{g.name}</button>
                      <span className="muted">{g.count.toLocaleString()}대</span>
                    </div>
                    <div className="bmb-tiles">
                      {g.rows.map((r) => {
                        const dim = !matchBoardFilter(r, filter);
                        const t = tileTitle(r, now);
                        return (
                          <button key={String(r.s.id)} type="button" className={`bmb-tile s-${r.state}${r.stale ? ' stale' : ''}${dim ? ' dim' : ''}`}
                            title={t} aria-label={`${t} — 상세 보기`} onClick={() => onServer?.(r.s)} />
                        );
                      })}
                    </div>
                    <div className="bmb-grp-foot">
                      {g.fault > 0 && <span className="t-fault">장애 {g.fault}</span>}
                      {g.warn > 0 && <span className="t-warn">경고 {g.warn}</span>}
                      {g.partial > 0 && <span>확인 불가 {g.partial}</span>}
                      {g.nojudge > 0 && <span>판정 못함 {g.nojudge}</span>}
                      {g.fault + g.warn + g.partial + g.nojudge === 0 && <span className="t-ok">모두 정상</span>}
                      {g.topModel && <span className="muted bmb-ellip" title={`가장 많은 모델 — ${g.topModel.name} ${g.topModel.n}대`}>{g.topModel.name.replace(/^PowerEdge\s+/i, '')} {g.topModel.n}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {/* 우측 패널 */}
            <aside className="bmb-side">
              <section className="card bmb-panel" aria-label="주의 필요 서버">
                <div className="bmb-sec-head">
                  <div><h3>주의 필요 서버</h3><span className="muted">장애 {counts.fault} · 경고 {counts.warn} — 장애 먼저</span></div>
                </div>
                {board.attention.length === 0 ? (
                  <div className="muted" style={{ fontSize: 13 }}>장애·경고 부품이 있는 서버가 없습니다{counts.partial + counts.nojudge > 0 ? ` — 단, 확인 불가 ${counts.partial} · 판정 못함 ${counts.nojudge}대는 상태를 모릅니다` : ''}.</div>
                ) : (
                  <ul className="bmb-attn">
                    {board.attention.slice(0, ATTN_MAX).map((r) => (
                      <li key={String(r.s.id)}>
                        <i className={`bmb-dot s-${r.state}`} aria-hidden="true" />
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div className="bmb-attn-top">
                            <button type="button" className="bmb-link bmb-ellip" onClick={() => onServer?.(r.s)}>{r.s.name || r.s.host || r.s.id}</button>
                            <span className="muted bmb-ellip" style={{ fontSize: 11, flex: 'none', maxWidth: '45%' }}>{r.corp}</span>
                          </div>
                          <div className="muted bmb-ellip" style={{ fontSize: 12 }}>{attentionDetail(r)}{r.stale ? ' · 오래됨' : ''}</div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                {board.attention.length > ATTN_MAX && (
                  <button type="button" className="bmb-link" style={{ fontSize: 12, alignSelf: 'flex-start' }}
                    onClick={() => { setFilter(counts.fault ? 'fault' : 'warn'); setCorp(''); tableRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }); }}>
                    {board.attention.length}대 모두 표에서 보기
                  </button>
                )}
              </section>

              <section className="card bmb-panel" aria-label="모델 분포">
                <div className="bmb-sec-head">
                  <div><h3>모델 분포</h3><span className="muted">{board.models.length}종 · 대수 많은 순</span></div>
                </div>
                <div className="bmb-models">
                  {board.models.slice(0, MODEL_MAX).map((m) => (
                    <div key={m.name} className="bmb-model">
                      <span className="bmb-ellip" title={m.name}>{m.name}</span>
                      <span className="bmb-bar"><span style={{ width: `${Math.max(2, Math.round((m.n / modelTop) * 100))}%` }} /></span>
                      <span className="muted" style={{ textAlign: 'right' }}>{m.n.toLocaleString()}</span>
                    </div>
                  ))}
                  {board.models.length > MODEL_MAX && <div className="muted" style={{ fontSize: 12 }}>외 {board.models.length - MODEL_MAX}종 — 하드웨어 집계 탭에서 전체를 봅니다</div>}
                </div>
              </section>

              {counts.nojudge > 0 && (
                <section className="card bmb-panel" aria-label="판정 못한 사유">
                  <div className="bmb-sec-head"><div><h3>판정 못한 사유</h3><span className="muted">{counts.nojudge}대</span></div></div>
                  <div className="bmb-reasons">
                    {board.reasons.map((r) => (
                      <div key={r.key}><span className="muted">{r.text}</span><b>{r.n.toLocaleString()}</b></div>
                    ))}
                  </div>
                </section>
              )}
            </aside>
          </div>

          {/* 서버 표 */}
          <section className="card bmb-panel" ref={tableRef} aria-label="서버 목록">
            <div className="bmb-sec-head">
              <div>
                <h3>서버 목록</h3>
                <span className="muted">
                  {filterText}{corpName ? ` · ${corpName}` : ''} · {tableRows.length.toLocaleString()}대{!showAll && tableRows.length > TABLE_LIMIT ? `(정렬 뒤 앞 ${TABLE_LIMIT}대 표시)` : ''} · 제목 클릭 정렬 · 행 클릭 = 상세
                </span>
              </div>
              <div className="flex gap" style={{ flexWrap: 'wrap' }}>
                {corp && <button type="button" className="tab bmb-btn" onClick={() => setCorp('')}>법인 선택 해제</button>}
                {filter !== 'all' && <button type="button" className="tab bmb-btn" onClick={() => setFilter('all')}>상태 필터 해제</button>}
              </div>
            </div>
            <STable className="table" minWidth={980} limit={showAll ? 0 : TABLE_LIMIT}>
              <thead>
                <tr>
                  <th>상태</th>
                  <th>서버</th>
                  <th>서비스 태그</th>
                  <th>법인</th>
                  <th>모델</th>
                  <th>부품</th>
                  <th>인벤토리 수집</th>
                </tr>
              </thead>
              <tbody>
                {tableRows.map((r) => {
                  const pc = partsCell(r.s.parts, now);
                  const rank = { fault: 0, warn: 1, partial: 2, nojudge: 3, ok: 4 }[r.state];
                  return (
                    <tr key={String(r.s.id)} onClick={() => onServer?.(r.s)} style={{ cursor: 'pointer' }}>
                      <td data-sort={rank}><span className={`badge ${BOARD_STATE_TONE[r.state]}`}>{BOARD_STATE_TEXT[r.state]}</span>{r.stale && <span className="badge purple" style={{ marginLeft: 4 }} title="인벤토리가 오래됨 — 지금 상태와 다를 수 있습니다">오래됨</span>}</td>
                      <td data-sort={r.s.name || r.s.host || ''}>
                        <div style={{ fontWeight: 600 }}>{r.s.name || r.s.host || r.s.id}</div>
                        {r.s.host && r.s.host !== r.s.name && <div className="muted" style={{ fontSize: 11, fontFamily: 'var(--mono)' }}>{r.s.host}</div>}
                      </td>
                      <td style={{ fontSize: 12, fontFamily: 'var(--mono)' }}>{r.s.serviceTag || '—'}</td>
                      <td>{r.corp}</td>
                      <td>{r.model}</td>
                      <td data-sort={pc.sort} title={pc.title || (r.state === 'nojudge' ? tileTitle(r, now) : undefined)} style={{ whiteSpace: 'nowrap' }}>
                        {pc.badges.length ? pc.badges.map((b, i) => <span key={i} className={`badge ${b.cls}`} title={b.title} style={{ marginRight: 3 }}>{b.text}</span>) : <span className="muted">—</span>}
                      </td>
                      <td data-sort={r.collectedAt ?? ''} className={r.stale ? '' : 'muted'} style={r.stale ? { color: 'var(--purple)' } : undefined}>{ageText(r.collectedAt, now)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </STable>
            {!showAll && tableRows.length > TABLE_LIMIT && (
              <button type="button" className="tab bmb-btn" style={{ alignSelf: 'flex-start' }} onClick={() => setShowAll(true)}>나머지 {(tableRows.length - TABLE_LIMIT).toLocaleString()}대 더 보기</button>
            )}
          </section>
        </>
      )}
    </div>
  );
}
