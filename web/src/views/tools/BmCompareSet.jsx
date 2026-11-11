/**
 * BmCompareSet.jsx — 베어메탈 스토리지 › ‘비교 세트’ 탭(v2.962 — 사용자 요청 2026-11-10 "SAN A / SAN B · 가 법인의 SAN A / 가 법인의 베어메탈 AA …
 * 다양하게 각각의 스토리지의 성능을 비교" · 컨펌 '바로 구현 · IOPS · 응답 시간까지 · 표준').
 *
 *  · 대상 2~4개를 종류를 섞어 고른다(SAN 어레이 · 베어메탈 서버 · 베어메탈 그룹 · 법인 베어메탈 합계). 첫 대상(A)이 기준이고 나머지는 ‘A 대비’ 를 단다.
 *  · 데이터: 후보 = GET /tools/bm-storage/compare?types=all(마운트 1회) · 값 = GET /tools/bm-storage/compare-set(공용 usePolling — 실시간 1시간만 30초,
 *    그 밖은 1시간 간격 = 사실상 마운트 · 대상 변경 · 버튼 때만). 고른 대상은 주소(#/tools/bm-storage/set/<ids>)에 실려 북마크 · 공유된다.
 *  · 못 읽은 값은 '—' 와 사유(코드 → 문장은 compareSetText). 숫자(격자 · 주기)는 응답 값. 표는 STable(정렬 · 가로 스크롤).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { fetchJson, usePolling } from '../../api.js';
import { ErrorBox, Loading } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import { timeTick, tipTime } from './bmIoChartText.js';
import {
  MAX_TARGETS, SLOT_LABELS, SLOT_COLORS, SET_RANGES, METRICS, metricOf, kindLabel, kindBadge, sourceText, reasonText,
  idsFromHash, hashForIds, normalizeIds, candidatesFrom, presetsFrom, labelFor, matrixRows, chartRows, showDots, gridText, CANDIDATE_KINDS, wideSpread, LOG_HINT_RATIO,
} from './compareSetText.js';

const LS_KEY = 'bmCompareSet.ids';
// 법인 미지정(dcId '')을 고르기 값으로 쓰면 ‘전체’('')와 겹친다 — 따로 뗀 값으로.
const dcKey = (id) => (id === '' ? '__none__' : id);
const LIVE_MS = 30_000;
const tipStyle = { background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 10, fontSize: 12 };
const loadSaved = () => { try { const a = JSON.parse(localStorage.getItem(LS_KEY) || '[]'); return normalizeIds(a); } catch { return []; } };
const saveIds = (ids) => { try { localStorage.setItem(LS_KEY, JSON.stringify(ids)); } catch { /* 저장 불가 — 주소에는 실려 있다 */ } };

export default function BmCompareSet() {
  // 대상 — 주소가 먼저, 없으면 이 브라우저에 기억한 것, 그것도 없으면 후보를 받은 뒤 빠른 세트 첫 번째.
  const [ids, setIdsState] = useState(() => { const h = idsFromHash(window.location.hash); return h.length ? h : loadSaved(); });
  const [range, setRange] = useState('1h');
  const [pickOpen, setPickOpen] = useState(false);
  const [pickKind, setPickKind] = useState('san');
  const [pickDc, setPickDc] = useState('');
  const [pickQ, setPickQ] = useState('');
  const [cand, setCand] = useState(null);
  const [candErr, setCandErr] = useState(null);
  const [copied, setCopied] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [logY, setLogY] = useState(false); // 차트 세로축 — SAN(수만 IOPS) ↔ 서버(수백)처럼 크기가 크게 다르면 로그 축으로
  const [narrow, setNarrow] = useState(() => (typeof window !== 'undefined' ? window.innerWidth < 720 : false));

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 720);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  // 이 탭을 연 채로 다른 세트 링크를 열면(주소만 바뀜) 그 대상으로 바꾼다. 대상 없는 주소(#/…/set)는 지금 고른 것을 그대로 둔다.
  useEffect(() => {
    const onHash = () => {
      const h = idsFromHash(window.location.hash);
      if (h.length) { setIdsState((cur) => (cur.join(',') === h.join(',') ? cur : h)); saveIds(h); }
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const setIds = (next) => {
    const list = normalizeIds(next);
    setIdsState(list); saveIds(list);
    // 주소에 싣는다(뒤로가기 이력을 쌓지 않게 replaceState — hashchange 를 일으키지 않는다).
    try { window.history.replaceState(null, '', hashForIds(list)); } catch { /* 주소 갱신 실패 — 화면은 그대로 */ }
  };

  // 후보(마운트 1회) — 전 법인 · 블록 어레이 전 종류.
  useEffect(() => {
    let alive = true;
    fetchJson('/tools/bm-storage/compare', { hours: 1, types: 'all' }, undefined, { timeoutMs: 90_000, retries: 0 })
      .then((d) => { if (alive) { setCand(candidatesFrom(d)); setCandErr(null); } })
      .catch((e) => { if (alive) setCandErr(e); });
    return () => { alive = false; };
  }, []);
  // 처음 열었는데 고른 대상이 없으면 빠른 세트 첫 번째(만들 수 있는 것).
  useEffect(() => {
    if (!cand || ids.length) return;
    const p = presetsFrom(cand).find((x) => x.ok);
    if (p) setIds(p.ids);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cand]);

  const live = (SET_RANGES.find((r) => r.k === range) || SET_RANGES[0]).live;
  const params = useMemo(() => ({ ids: ids.join(','), range, r: refresh }), [ids, range, refresh]);
  const polled = usePolling(ids.length ? '/tools/bm-storage/compare-set' : null, params, live ? LIVE_MS : 3_600_000, { timeoutMs: 90_000, retries: 0 });
  const [data, setData] = useState(null);
  useEffect(() => { if (polled.data) setData(polled.data); }, [polled.data]);
  useEffect(() => { if (!ids.length) setData(null); }, [ids.length]);

  // 응답의 대상 순서를 고른 순서에 맞춘다(서버도 입력 순서지만 지운 대상이 늦게 온 응답에 남지 않게).
  const targets = useMemo(() => {
    const byId = new Map((data?.targets || []).map((t) => [t.id, t]));
    return ids.map((id) => byId.get(id)).filter(Boolean);
  }, [data, ids]);
  const rows = useMemo(() => matrixRows(targets), [targets]);
  const presets = useMemo(() => (cand ? presetsFrom(cand) : []), [cand]);
  const dcOptions = useMemo(() => {
    const m = new Map();
    for (const list of Object.values(cand || {})) for (const x of list || []) if (x.dcId != null && x.dcName) m.set(dcKey(x.dcId), x.dcName);
    return [...m.entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1]), 'ko'));
  }, [cand]);
  const pickList = useMemo(() => {
    const ql = pickQ.trim().toLowerCase();
    return (cand?.[pickKind] || []).filter((x) => (pickDc === '' || (x.dcId != null && dcKey(x.dcId) === pickDc) || (x.dcId == null && pickKind === 'bmg'))
      && (!ql || [x.name, x.sub, x.dcName].some((v) => String(v || '').toLowerCase().includes(ql))));
  }, [cand, pickKind, pickDc, pickQ]);

  const add = (id) => { if (ids.includes(id) || ids.length >= MAX_TARGETS) return; setIds([...ids, id]); };
  const remove = (id) => setIds(ids.filter((x) => x !== id));
  const makeBase = (id) => setIds([id, ...ids.filter((x) => x !== id)]);
  const copyLink = async () => {
    const url = `${window.location.origin}${window.location.pathname}${hashForIds(ids)}`;
    try { await navigator.clipboard.writeText(url); setCopied('링크를 복사했습니다'); } catch { setCopied(url); }
    setTimeout(() => setCopied(''), 4000);
  };

  if (candErr && !cand) return <ErrorBox error={candErr} />;
  const loading = ids.length > 0 && !data && !polled.error;
  return (
    <div className="cset">
      <div className="flex between wrap" style={{ alignItems: 'flex-start', gap: '10px 16px', marginBottom: 12 }}>
        <div style={{ flex: '1 1 520px', minWidth: 0 }}>
          <div className="muted" style={{ fontSize: 13.5, lineHeight: 1.6 }}>
            SAN 어레이 · 베어메탈 서버 · 베어메탈 그룹 · 법인 베어메탈 합계 중 <b style={{ color: 'var(--text)' }}>2~{MAX_TARGETS}개</b>를 골라 전송 속도 · IOPS · 응답 시간 · 바쁨 · 용량을 나란히 비교합니다.
            첫 대상(<b style={{ color: SLOT_COLORS[0] }}>A</b>)이 기준이고 나머지 칸에 ‘A 대비’ 를 붙입니다.
          </div>
          {data && (
            <div className="bm2-status">
              {gridText(data.bucketMs)} · 베어메탈 점 {Math.round((data.sampleMs?.bm || 0) / 60000)}분 · SAN 포트 점 {Math.round((data.sampleMs?.san || 0) / 60000)}분 · 어레이 측 점 {Math.round((data.sampleMs?.fe || 0) / 60000)}분
              {live ? ` · ${Math.round(LIVE_MS / 1000)}초마다 갱신` : ''}{polled.loading ? ' · 읽는 중' : ''}
            </div>
          )}
        </div>
        <div className="flex wrap" style={{ alignItems: 'center', gap: 8 }}>
          <span className="bmc-seg">{SET_RANGES.map((r) => <button key={r.k} type="button" className={range === r.k ? 'on' : ''} onClick={() => setRange(r.k)}>{r.label}</button>)}</span>
          <button className="logout-btn" style={{ padding: '8px 14px' }} disabled={!ids.length} onClick={() => setRefresh((x) => x + 1)}>새로 고침</button>
          <button className="logout-btn" style={{ padding: '8px 14px' }} disabled={!ids.length} onClick={copyLink} title="고른 대상이 담긴 주소를 복사합니다(북마크 · 공유)">링크 복사</button>
        </div>
      </div>
      {copied && <div className="muted" style={{ fontSize: 12, marginBottom: 8, color: '#93c5fd', overflowWrap: 'anywhere' }}>{copied}</div>}

      {/* 빠른 세트 */}
      <div className="flex wrap" style={{ alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span className="muted" style={{ fontSize: 12 }}>빠른 세트</span>
        {presets.map((p) => (
          <button key={p.k} type="button" className="bmc-pk" disabled={!p.ok} onClick={() => setIds(p.ids)}
            title={p.ok ? p.ids.map((id) => labelFor(id, cand, targets)).join(' ↔ ') : '만들 수 있는 대상이 없습니다'}>{p.label}</button>
        ))}
        {!cand && <span className="muted" style={{ fontSize: 12 }}>후보를 읽는 중…</span>}
      </div>

      {/* 대상 칸 A~D */}
      <div className="cset-slots">
        {ids.map((id, i) => {
          const t = targets.find((x) => x.id === id);
          const kind = id.split(':')[0];
          return (
            <div key={id} className="card cset-slot" style={{ borderTop: `3px solid ${SLOT_COLORS[i]}` }}>
              <div className="flex" style={{ alignItems: 'center', gap: 8, minWidth: 0 }}>
                <b className="cset-letter" style={{ color: SLOT_COLORS[i] }}>{SLOT_LABELS[i]}</b>
                <span className={`badge ${kindBadge(kind, t?.type)}`}>{kindLabel(kind, t?.type)}</span>
                <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 4 }}>
                  {i > 0 && <button type="button" className="bm2-icon" title="이 대상을 기준(A)으로" onClick={() => makeBase(id)}>A로</button>}
                  <button type="button" className="bm2-icon" aria-label={`${SLOT_LABELS[i]} 빼기`} title="빼기" onClick={() => remove(id)}>✕</button>
                </span>
              </div>
              <div className="cset-name" title={labelFor(id, cand, targets)}>{labelFor(id, cand, targets)}</div>
              <div className="muted" style={{ fontSize: 11.5, overflowWrap: 'anywhere' }}>
                {t ? (t.datacenterName || '—') : ''}
                {t?.members?.total != null && kind !== 'bm' && kind !== 'san' ? ` · 서버 ${t.members.total}대` : ''}
                {t?.kind === 'san' && t.serial ? ` · 시리얼 ${t.serial}` : ''}
                {t?.datacenterSource === 'edge' ? ' · 법인은 엣지로 추정' : ''}
              </div>
              {t?.missing && <div style={{ fontSize: 11.5, color: 'var(--amber)', marginTop: 4 }}>{reasonText(t.reason)}</div>}
            </div>
          );
        })}
        {ids.length < MAX_TARGETS && (
          <button type="button" className="card cset-slot cset-add" onClick={() => setPickOpen((v) => !v)} aria-expanded={pickOpen}>
            <b style={{ fontSize: 15 }}>+ 대상 추가</b>
            <span className="muted" style={{ fontSize: 11.5 }}>{SLOT_LABELS[ids.length]} 칸 · 남은 자리 {MAX_TARGETS - ids.length}</span>
          </button>
        )}
      </div>

      {/* 대상 고르기 — 종류 → 법인 → 장비 */}
      {pickOpen && ids.length < MAX_TARGETS && (
        <div className="card bm2-card cset-picker">
          <div className="flex wrap" style={{ alignItems: 'center', gap: '8px 12px', marginBottom: 10 }}>
            <span className="bmc-seg">{CANDIDATE_KINDS.map((k) => <button key={k.k} type="button" className={pickKind === k.k ? 'on' : ''} onClick={() => setPickKind(k.k)}>{k.label} {(cand?.[k.k] || []).length}</button>)}</span>
            <label className="muted" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}>법인
              <Select className="input" value={pickDc} onChange={(e) => setPickDc(e.target.value)} style={{ minWidth: 0, maxWidth: 200, padding: '4px 8px', fontSize: 12.5 }}>
                <option value="">전체</option>
                {dcOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </Select>
            </label>
            <input className="input" style={{ width: 200, minWidth: 0, padding: '5px 10px', fontSize: 12.5 }} placeholder="이름 · 법인 찾기" value={pickQ} onChange={(e) => setPickQ(e.target.value)} />
            <button type="button" className="tab" style={{ marginLeft: 'auto', padding: '4px 12px', fontSize: 12 }} onClick={() => setPickOpen(false)}>닫기</button>
          </div>
          {!cand ? <div className="muted" style={{ fontSize: 12.5 }}>후보를 읽는 중…</div>
            : pickList.length === 0 ? <div className="muted" style={{ fontSize: 12.5 }}>조건에 맞는 대상이 없습니다{pickDc !== '' ? ' — 법인을 ‘전체’ 로 바꿔 보세요' : ''}.</div>
              : (
                <div className="cset-cands">
                  {pickList.map((x) => {
                    const on = ids.includes(x.id);
                    return (
                      <button key={x.id} type="button" className={`cset-cand${on ? ' on' : ''}`} disabled={on || x.disabled} onClick={() => add(x.id)} title={x.disabled ? x.why : on ? '이미 골랐습니다' : `${SLOT_LABELS[ids.length]} 칸에 넣기`}>
                        <b>{x.name}</b><small>{x.disabled ? x.why : x.sub}</small>
                      </button>
                    );
                  })}
                </div>
              )}
        </div>
      )}

      {ids.length === 0 && <div className="bmc-empty">비교할 대상을 고르세요 — ‘+ 대상 추가’ 또는 빠른 세트. 대상은 주소에 실려 북마크 · 공유됩니다.</div>}
      {ids.length === 1 && <div className="bmc-empty">대상을 하나 더 고르면 A 대비 비교가 나옵니다.</div>}
      {polled.error && <div className="muted" style={{ fontSize: 12, marginBottom: 8, color: 'var(--amber)' }}>⚠ 조회 오류: {String(polled.error?.message || polled.error)}</div>}
      {loading && <Loading />}

      {/* 비교 표 — 행 = 지표, 열 = 대상(A 기준) */}
      {targets.length > 0 && (
        <div className="card bm2-card">
          <div className="flex between wrap" style={{ alignItems: 'baseline', gap: '6px 12px', marginBottom: 10 }}>
            <div className="bm2-label">▸ 비교 표 <span style={{ letterSpacing: 0 }}>· {(SET_RANGES.find((r) => r.k === range) || SET_RANGES[0]).label} · 평균 = 구간 평균의 평균 · 피크 = 2초 표본 · 구간 평균 중 최댓값(하한)</span></div>
            <span className="muted" style={{ fontSize: 11.5 }}>셀 아래 = A 대비(용량은 %p · 지표는 배율) · ‘—’ 에 마우스를 올리면 사유</span>
          </div>
          <STable minWidth={Math.max(560, 180 + targets.length * 190)}>
            <thead><tr><th>지표</th>{targets.map((t, i) => <th key={t.id} style={{ textAlign: 'right' }}><span style={{ color: SLOT_COLORS[i] }}>{SLOT_LABELS[i]}</span> {labelFor(t.id, cand, targets)}</th>)}</tr></thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={r.key}>
                  <td data-sort={r.label} style={{ whiteSpace: 'nowrap' }}><b>{r.label}</b></td>
                  {r.cells.map((c, i) => (
                    <td key={targets[i].id} data-sort={c.v ?? ''} style={{ textAlign: 'right', fontFamily: 'var(--mono)', whiteSpace: 'nowrap' }} title={c.reason ? reasonText(c.reason) : sourceText(c.source)}>
                      {c.text === '—' ? <span className="muted">—</span> : c.text}
                      {c.delta ? <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{c.delta}</div> : null}
                      {c.reason && c.text === '—' && rows[ri - 1]?.cells[i]?.reason !== c.reason ? <div style={{ fontSize: 10.5, color: 'var(--amber)', fontFamily: 'inherit', whiteSpace: 'normal', maxWidth: 200, marginLeft: 'auto' }}>{reasonText(c.reason)}</div> : null}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </STable>
          <div className="bm2-foot">
            출처 — {targets.map((t, i) => {
              const srcs = [...new Set(METRICS.map((m) => t.metrics?.[m.k]?.source).filter(Boolean))].map((s) => sourceText(s)).filter(Boolean);
              return <span key={t.id}><b style={{ color: SLOT_COLORS[i] }}>{SLOT_LABELS[i]}</b> {srcs.join(' · ') || '—'}{i < targets.length - 1 ? ' / ' : ''}</span>;
            })}. 서버와 어레이는 측정 위치가 달라(서버 = 디스크 장치 · 어레이 = 포트 · 디렉터) 같은 숫자라도 뜻이 다릅니다 — 비율은 참고치입니다.
          </div>
        </div>
      )}

      {/* 지표별 추이 — 2×2(좁으면 1열) · 실선 평균 · 점선 피크 · 색 = 슬롯 */}
      {targets.length > 0 && data && (
        <div className="flex wrap" style={{ alignItems: 'center', gap: '6px 10px', margin: '2px 0 10px' }}>
          <span className="muted" style={{ fontSize: 12 }}>차트 세로축</span>
          <span className="bmc-seg">
            <button type="button" className={logY ? '' : 'on'} onClick={() => setLogY(false)}>선형</button>
            <button type="button" className={logY ? 'on' : ''} onClick={() => setLogY(true)}>로그</button>
          </span>
          <span className="muted" style={{ fontSize: 11.5 }}>{logY ? '로그 축 — 0 인 점은 그리지 않습니다' : `대상끼리 ${LOG_HINT_RATIO}배 넘게 차이 나면 작은 쪽이 바닥에 붙습니다 — 그때는 ‘로그’`}</span>
        </div>
      )}
      {targets.length > 0 && data && (
        <div className="cset-charts">
          {METRICS.map((m) => {
            const cd = chartRows(data.buckets, targets, m.k, { log: logY });
            const spread = !logY && wideSpread(targets, m.k);
            const has = cd.some((row) => targets.some((_, j) => row[`${SLOT_LABELS[j]}|avg`] != null || row[`${SLOT_LABELS[j]}|peak`] != null));
            const dots = showDots(data.buckets);
            return (
              <div key={m.k} className="card bm2-card cset-chart">
                <div className="flex between wrap" style={{ alignItems: 'baseline', gap: '4px 8px', marginBottom: 6 }}>
                  <div className="bm2-label">▸ {m.label} <span style={{ letterSpacing: 0 }}>· 실선 평균 · 점선 피크</span></div>
                  <span className="muted" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{spread ? <button type="button" className="bm2-icon" title={`대상끼리 ${LOG_HINT_RATIO}배 넘게 차이 납니다`} onClick={() => setLogY(true)}>로그 축으로</button> : null} {gridText(data.bucketMs)}{logY ? ' · 로그' : ''}</span>
                </div>
                {has ? (
                  <ResponsiveContainer width="100%" height={narrow ? 200 : 230}>
                    <LineChart data={cd} margin={{ top: 12, right: 10, left: 4, bottom: 2 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#243049" />
                      <XAxis dataKey="t" stroke="#8b9bb4" fontSize={10.5} tickFormatter={(v) => timeTick(v, range)} minTickGap={narrow ? 40 : 30} />
                      <YAxis stroke="#8b9bb4" fontSize={10.5} width={70} tickFormatter={(v) => m.tick(v)}
                        {...(logY ? { scale: 'log', domain: ['auto', 'auto'], allowDataOverflow: true } : {})} />
                      <Tooltip contentStyle={tipStyle} labelFormatter={(v) => tipTime(v)} formatter={(v, name) => [metricOf(m.k).fmt(v), name]} isAnimationActive={false} />
                      {targets.map((t, j) => (
                        <React.Fragment key={t.id}>
                          <Line type="monotone" dataKey={`${SLOT_LABELS[j]}|peak`} name={`${SLOT_LABELS[j]} ${labelFor(t.id, cand, targets)} · 피크`} stroke={SLOT_COLORS[j]} strokeWidth={1.2} strokeDasharray="4 4" strokeOpacity={0.75} dot={false} connectNulls={false} isAnimationActive={false} />
                          <Line type="monotone" dataKey={`${SLOT_LABELS[j]}|avg`} name={`${SLOT_LABELS[j]} ${labelFor(t.id, cand, targets)} · 평균`} stroke={SLOT_COLORS[j]} strokeWidth={2.2} dot={dots ? { r: 2.5 } : false} connectNulls={false} isAnimationActive={false} />
                        </React.Fragment>
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                ) : <div className="muted" style={{ fontSize: 12.5, padding: '24px 4px' }}>이 구간에 {m.label} 값이 있는 대상이 없습니다.</div>}
                <div className="bmc-legend">
                  {targets.map((t, j) => {
                    const mm = t.metrics?.[m.k];
                    return (
                      <span key={t.id} title={mm?.reason ? reasonText(mm.reason) : sourceText(mm?.source)}>
                        <i style={{ borderColor: SLOT_COLORS[j] }} /><b style={{ color: SLOT_COLORS[j] }}>{SLOT_LABELS[j]}</b>
                        <span className="muted">{mm?.avgTotal != null ? ` 평균 ${m.fmt(mm.avgTotal)} · 피크 ${m.fmt(mm.peakTotal)}` : ` — ${reasonText(mm?.reason) || '값 없음'}`}</span>
                      </span>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {targets.length > 0 && (
        <div className="card bm2-card" style={{ padding: '14px 20px' }}>
          <div className="bm2-label">▸ 비교할 때 알아 둘 것</div>
          <ul className="bmc-note">
            <li><b>전송 속도</b> — 서버는 디스크 장치에서 잰 읽기+쓰기, SAN 어레이는 스위치 포트 트래픽입니다(포트에서 찾지 못하면 어레이가 보고한 호스트 처리량).</li>
            <li><b>IOPS · 응답 시간</b> — 서버는 /proc/diskstats 의 완료 횟수 · 소요 시간(응답 시간 = I/O 가중 평균), SAN 은 어레이가 보고한 5분 표본(REST 로 수집하는 PowerMax · VMAX · PowerStore · Unity 만 · 실장비 확인 전)입니다.</li>
            <li><b>피크</b> — 서버는 수집할 때 잰 2초 표본과 수집 사이 구간 평균 중 큰 값입니다. 2초 표본은 1시간에 몇 번뿐이라 실제 순간 최고치는 이보다 클 수 있습니다(하한).</li>
            <li><b>바쁨</b> — 서버는 가장 바쁜 디스크, 묶음은 가장 바쁜 서버, 어레이는 가장 바쁜 FA 디렉터(또는 노드 · SP CPU)입니다. 뜻이 달라 같은 % 라도 비교는 참고치입니다. 서버의 바쁨 평균은 v2.969 부터 쌓인 값만 보입니다(그 전 값은 모든 디스크를 더한 값이라 쓰지 않습니다).</li>
            <li><b>묶음(그룹 · 법인 합계)</b> — 측정된 서버 전부에 값이 있는 칸만 더합니다(부분 합 금지). 피크 합은 서버별 피크를 더한 값이라 같은 시각에 일어났다는 보장은 없습니다.</li>
          </ul>
        </div>
      )}
    </div>
  );
}
