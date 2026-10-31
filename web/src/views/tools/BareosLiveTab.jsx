/**
 * Bareos 관리 도구의 '진행 현황' 탭(v2.833 · 사용자 요청 '진행 중인 백업 현황판 — 전체 법인 · 단일 법인 · 백업 속도 상태', Claude Design 시안 Bgr8WLF8UdNA1KtWpY5aQX).
 *   보기 셋: 전체 법인(합계 + 법인 카드) · 단일 법인(실행 중 잡의 진행량·속도 · 대기) · 속도 상태(법인별 지금 처리량 · 30분 흐름 · 느린 잡 · 오늘 평균).
 *   값은 GET /api/tools/bareos-backup/live — 이 화면이 열린 동안만 서버가 Director 에 상태를 묻는다(bareos/liveStatus.js — 닫으면 멈춘다).
 *   판정·문구는 bareosLiveText.js. 못 읽은 값은 '모름'(0 이 아니다) · 진척(읽은 양 / VM 용량)은 추정이라 화면이 밝힌다.
 * ⚠ 훅은 조기 return 위 · 400px 에서 가로 넘침 없게 그리드 칸은 minmax(0, 1fr) · 표는 STable(자기 가로 스크롤).
 */
import React, { useMemo, useState } from 'react';
import { usePolling } from '../../api.js';
import { useHashTab } from '../../hooks/useHashTab.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import { shortTs } from './bareosViewText.js';
import {
  rateText, sizeText, elapsedText, progressPct, liveCodeText, corpBadge, CORP_FILTERS, corpMatches, corpFilterCounts, sortCorps,
  sparkSegments, totalHist, slowRows, levelWord, triggerText, STATE_TEXT,
} from './bareosLiveText.js';

const CORP_KEY = 'bareos-live-corp';
const load = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, v); } catch { /* 저장 못 해도 동작 */ } };
const ROW = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 };
const TONE = { ok: '#86efac', warn: '#fcd34d', bad: '#fca5a5', run: '#93c5fd', muted: 'var(--text-dim)' };
const TONE_BG = { ok: 'rgba(34,197,94,.14)', warn: 'rgba(245,158,11,.16)', bad: 'rgba(239,68,68,.14)', run: 'rgba(59,130,246,.16)', muted: 'rgba(148,163,184,.12)' };
const CYAN = '#22d3ee';
const GRID1 = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 12 };
const VIEWS = [['all', '전체 법인'], ['corp', '단일 법인'], ['speed', '속도 상태']];

function Badge({ tone = 'muted', children }) {
  return <span style={{ display: 'inline-block', padding: '2px 9px', borderRadius: 999, fontSize: 11.5, fontWeight: 700, whiteSpace: 'nowrap', color: TONE[tone], background: TONE_BG[tone] }}>{children}</span>;
}
function Kpi({ label, main, sub, color, children }) {
  return (
    <div className="card" style={{ padding: '12px 14px', minWidth: 0 }}>
      <div className="muted" style={{ fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 800, color, fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' }}>{main}</div>
      {children}
      {sub && <div className="muted" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{sub}</div>}
    </div>
  );
}
function Spark({ hist, w = 150, h = 40, label }) {
  const segs = sparkSegments(hist, w, h);
  if (!segs.length) return <span className="muted" style={{ fontSize: 11.5 }}>흐름 모으는 중</span>;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label} style={{ maxWidth: '100%', flex: 'none' }}>
      {segs.map((p, i) => <polyline key={i} points={p} fill="none" stroke={CYAN} strokeWidth="2" strokeLinejoin="round" />)}
    </svg>
  );
}
function Bar({ pct, color = '#3b82f6', label }) {
  return (
    <div role="img" aria-label={label} style={{ height: 6, borderRadius: 3, background: 'var(--border)', overflow: 'hidden' }}>
      <div style={{ height: 6, width: `${pct ?? 0}%`, background: color }} />
    </div>
  );
}

export default function BareosLiveTab() {
  const { data, error } = usePolling('/tools/bareos-backup/live', {}, 15_000);
  // 보기는 주소에(#/tools/bareos-backup/live/<보기> — 새로고침·북마크·뒤로가기에서 유지 · CATALOG2613-06 스윕)
  const [view, setView] = useHashTab({ base: ['tools', 'bareos-backup', 'live'], valid: VIEWS.map(([k]) => k), fallback: 'all' });
  const [corpId, setCorpS] = useState(() => load(CORP_KEY, ''));
  const [filter, setFilter] = useState('active');
  const [q, setQ] = useState('');
  const setCorp = (v) => { setCorpS(v); save(CORP_KEY, v); };
  const corps = useMemo(() => sortCorps(data?.corps || []), [data]);
  const counts = useMemo(() => corpFilterCounts(corps), [corps]);
  const corp = corps.find((c) => c.vcenterId === corpId) || corps.find((c) => c.running > 0) || corps[0] || null;

  if (error && !data) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const open = (c) => { setCorp(c.vcenterId); setView('corp'); };

  return (
    <div style={GRID1}>
      <div style={ROW}>
        <div role="group" aria-label="보기" style={{ display: 'flex', gap: 4, padding: 3, border: '1px solid var(--border)', borderRadius: 10, background: 'var(--panel-deep)' }}>
          {VIEWS.map(([k, l]) => (
            <button key={k} type="button" aria-pressed={view === k} onClick={() => setView(k)}
              style={{ padding: '7px 14px', borderRadius: 8, border: 0, background: view === k ? CYAN : 'transparent', color: view === k ? '#07202a' : 'var(--text-dim)', font: 'inherit', fontWeight: 800, cursor: 'pointer' }}>{l}</button>
          ))}
        </div>
        <span className="muted" style={{ fontSize: 12, marginLeft: 'auto', minWidth: 0 }}>
          이 화면을 연 동안만 {Math.round((data.liveMs || 0) / 1000)}초마다 Director 에 상태를 묻습니다(닫으면 멈춤){data.demo ? ' · 데모 Director' : ''}
        </span>
      </div>
      {error && <div className="banner warn">새로 읽지 못했습니다({error?.body?.reason || error.message}) — 아래는 마지막으로 읽은 값입니다.</div>}
      {data.registryLoadError && <div className="banner bad">백업 대상 원장을 읽지 못했습니다(손상본 보존) — 진행 현황이 비어 보일 수 있습니다.</div>}
      {!corps.length && <div className="card" style={{ padding: 14, fontSize: 13 }}>볼 수 있는 법인이 없습니다 — 설정 탭에서 법인별 Director 를 묶으세요(범위 계정은 자기 법인만 보입니다).</div>}

      {corps.length > 0 && view === 'all' && <AllView data={data} corps={corps} counts={counts} filter={filter} setFilter={setFilter} q={q} setQ={setQ} onOpen={open} />}
      {corps.length > 0 && view === 'corp' && corp && <CorpView corps={corps} c={corp} onPick={setCorp} />}
      {corps.length > 0 && view === 'speed' && <SpeedView corps={corps} onOpen={open} />}
    </div>
  );
}

/* ───────── ① 전체 법인 ───────── */
function AllView({ data, corps, counts, filter, setFilter, q, setQ, onOpen }) {
  const t = data.totals || {};
  const needle = q.trim().toLowerCase();
  const shown = corps.filter((c) => corpMatches(c, filter) && (!needle || `${c.vcName} ${c.director?.name || ''}`.toLowerCase().includes(needle)));
  return (
    <>
      <section aria-label="전체 합계" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))', gap: 12 }}>
        <Kpi label="실행 중" main={t.running ?? 0} color={TONE.run} sub={`법인 ${t.active ?? 0}곳`} />
        <Kpi label="대기" main={t.waiting ?? 0} sub="스토리지·차례 대기" />
        <Kpi label="지금 처리 속도(합계)" main={t.running ? rateText(t.rateNow) : '—'} color={CYAN} sub={t.rateUnknownCorps ? `모름 ${t.rateUnknownCorps}곳 제외` : '실행 중 잡의 최근 속도 합'} />
        <Kpi label="오늘 끝난 백업" main={<><span style={{ color: TONE.ok }}>{(t.today?.ok ?? 0) + (t.today?.warn ?? 0)}</span> <span className="muted" style={{ fontSize: 15 }}>/ 실패</span> <span style={{ color: t.today?.fail ? TONE.bad : undefined }}>{t.today?.fail ?? 0}</span></>} sub={`경고 ${t.today?.warn ?? 0} · 취소 ${t.today?.canceled ?? 0}`} />
        <Kpi label="오늘 저장한 양" main={sizeText(t.today?.bytes)} sub={t.today?.bytesUnknown ? `모름 ${t.today.bytesUnknown}건 제외 · VM 별 마지막 실행 기준` : 'VM 별 마지막 실행 기준'} />
      </section>
      <div style={ROW}>
        <b style={{ fontSize: 15 }}>법인 {corps.length}곳</b>
        <div role="group" aria-label="법인 거르기" style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {CORP_FILTERS.map(([k, l]) => (
            <button key={k} type="button" className={`tab${filter === k ? ' active' : ''}`} aria-pressed={filter === k} onClick={() => setFilter(k)} style={{ padding: '4px 12px', fontSize: 12 }}>{l} {counts[k]}</button>
          ))}
        </div>
        <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="법인 · Director 검색" aria-label="법인 검색" style={{ marginLeft: 'auto', flex: '1 1 160px', minWidth: 0, maxWidth: 260 }} />
      </div>
      {shown.length === 0
        ? <div className="muted" style={{ fontSize: 13 }}>{filter === 'active' ? '지금 백업이 도는 법인이 없습니다 — 전체를 눌러 모든 법인을 보세요.' : '조건에 맞는 법인이 없습니다.'}</div>
        : (
          <section aria-label="법인별 진행" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 320px), 1fr))', gap: 12 }}>
            {shown.map((c) => <CorpCard key={c.vcenterId} c={c} onOpen={() => onOpen(c)} />)}
          </section>
        )}
      <p className="muted" style={{ margin: 0, fontSize: 12, lineHeight: 1.6 }}>
        지금 속도 = 실행 중 잡의 최근 처리 속도 합(FD 상태 · Director 가 대신 묻는다) · 조회 실패 법인은 합계에서 빼고 ‘모름’ 으로 둡니다(0 아님) · 엣지 대행 법인은 엣지가 대신 물어 몇 분 늦을 수 있습니다.
      </p>
    </>
  );
}

function CorpCard({ c, onOpen }) {
  const b = corpBadge(c);
  const border = b.tone === 'warn' ? 'rgba(245,158,11,.45)' : b.tone === 'bad' ? 'rgba(239,68,68,.45)' : undefined;
  return (
    <button type="button" onClick={onOpen} className="card"
      style={{ textAlign: 'left', padding: 14, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 10, cursor: 'pointer', color: 'var(--text)', font: 'inherit', minWidth: 0, ...(border ? { borderColor: border } : {}) }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, minWidth: 0 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 800, overflowWrap: 'anywhere' }}>{c.vcName}</div>
          <div className="muted" style={{ fontSize: 11.5, overflowWrap: 'anywhere' }}>Director {c.director?.name || '—'}{c.director?.via === 'edge' ? ' · 엣지 대행' : ''}</div>
        </div>
        <Badge tone={b.tone}>{b.text}</Badge>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, minWidth: 0 }}>
        <div style={{ minWidth: 0 }}>
          <div className="muted" style={{ fontSize: 11.5 }}>지금 속도</div>
          <div style={{ fontSize: 21, fontWeight: 800, color: CYAN, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{c.running ? rateText(c.rateNow) : '—'}</div>
        </div>
        <div style={{ marginLeft: 'auto', minWidth: 0 }}><Spark hist={c.hist} label={`${c.vcName} 최근 처리 속도 흐름`} /></div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8, fontSize: 12 }}>
        <div><div className="muted">실행</div><b style={{ fontSize: 15, color: TONE.run }}>{c.running}</b></div>
        <div><div className="muted">대기</div><b style={{ fontSize: 15 }}>{c.waiting}</b></div>
        <div><div className="muted">오늘 성공/실패</div><b style={{ fontSize: 15 }}>{c.today.ok + c.today.warn}</b> <span style={{ color: TONE.bad, fontWeight: 700 }}>{c.today.fail || ''}</span></div>
      </div>
      {c.live && !c.live.ok && <div style={{ fontSize: 11.5, color: TONE.bad }}>{liveCodeText(c.live.code)} · {shortTs(c.live.at)}</div>}
      {c.live?.ok && <div className="muted" style={{ fontSize: 11.5 }}>상태 조회 {shortTs(c.live.at)}{c.rateUnknown ? ` · 속도 모름 ${c.rateUnknown}건` : ''}</div>}
    </button>
  );
}

/* ───────── ② 단일 법인 ───────── */
function CorpView({ corps, c, onPick }) {
  const b = corpBadge(c);
  const act = c.rows.filter((r) => r.state === 'running');
  const wait = c.rows.filter((r) => r.state !== 'running');
  return (
    <>
      <div style={ROW}>
        <label htmlFor="bareos-live-corp" className="muted" style={{ fontSize: 12 }}>법인</label>
        <Select id="bareos-live-corp" className="input" value={c.vcenterId} onChange={(e) => onPick(e.target.value)} style={{ minWidth: 0, flex: '1 1 240px', maxWidth: 420 }} aria-label="법인">
          {corps.map((x) => <option key={x.vcenterId} value={x.vcenterId}>{x.vcName} — Director {x.director?.name || '—'}{x.running ? ` · 실행 ${x.running}` : ''}</option>)}
        </Select>
        <Badge tone={b.tone}>{b.text}</Badge>
        <span className="muted" style={{ fontSize: 12 }}>{c.live ? `상태 조회 ${shortTs(c.live.at)}${c.live.ok ? '' : ` — ${liveCodeText(c.live.code)}`}` : (c.running || c.waiting ? '상태 조회 전(곧 묻습니다)' : '실행 중인 잡이 없어 묻지 않습니다')}</span>
      </div>
      <section aria-label="법인 요약" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))', gap: 12 }}>
        <Kpi label="실행 중" main={c.running} color={TONE.run} sub={c.slow ? `느림 ${c.slow}` : '—'} />
        <Kpi label="지금 속도" main={c.running ? rateText(c.rateNow) : '—'} color={CYAN} sub={c.rateUnknown ? `모름 ${c.rateUnknown}건 제외` : undefined}>
          <Spark hist={c.hist} w={200} h={34} label={`${c.vcName} 최근 처리 속도 흐름`} />
        </Kpi>
        <Kpi label="대기" main={c.waiting} sub="스토리지·차례 대기" />
        <Kpi label="오늘 성공 / 실패" main={<><span style={{ color: TONE.ok }}>{c.today.ok + c.today.warn}</span> <span className="muted" style={{ fontSize: 15 }}>/</span> <span style={{ color: c.today.fail ? TONE.bad : undefined }}>{c.today.fail}</span></>} sub={`경고 ${c.today.warn} · 저장 ${sizeText(c.today.bytes)}`} />
        <Kpi label="최근 24시간 평균 속도" main={c.rateSamples ? rateText(c.rateMedian) : '—'} sub={c.rateSamples ? `끝난 성공 ${c.rateSamples}건 · VM 별 평균의 중앙값` : '끝난 성공 기록 없음'} />
      </section>

      <section className="card" aria-label="실행 중" style={{ padding: 0, overflow: 'hidden', minWidth: 0 }}>
        <div style={{ ...ROW, padding: '10px 14px', borderBottom: '1px solid var(--border-soft)' }}>
          <b>실행 중 {act.length}</b>
          <span className="muted" style={{ fontSize: 12 }}>읽은 양 / VM 용량은 추정 진척 — Incremental 은 바뀐 블록만 읽어 용량보다 훨씬 작게 끝납니다</span>
        </div>
        {act.length === 0 ? <div className="muted" style={{ padding: 14, fontSize: 13 }}>지금 이 법인에서 도는 백업이 없습니다.</div> : (
          <STable minWidth={980} limit={300}>
            <thead><tr><th>VM</th><th>그룹 · 실행</th><th>레벨</th><th>시작 · 경과</th><th data-nosort style={{ minWidth: 220 }}>읽은 양 / VM 용량</th><th className="right">지금 속도</th><th className="right">평균 속도</th><th className="right">지난 평균</th><th>상태</th></tr></thead>
            <tbody>
              {act.map((r) => {
                const pct = progressPct(r.bytes, r.sizeGb);
                return (
                  <tr key={r.jobid}>
                    <td style={{ whiteSpace: 'nowrap' }}><b>{r.vmName}</b><div className="muted" style={{ fontSize: 11.5, fontFamily: 'var(--mono)' }}>jobid {r.jobid}</div></td>
                    <td style={{ whiteSpace: 'nowrap', fontSize: 12.5 }}>{r.group || '—'}<div className="muted" style={{ fontSize: 11.5 }}>{triggerText(r)}{r.by ? ` · ${r.by}` : ''}</div></td>
                    <td>{levelWord(r.level)}</td>
                    <td data-sort={r.since ?? ''} style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{r.since ? shortTs(r.since) : '—'}<div className="muted">{elapsedText(r.elapsed)}</div></td>
                    <td>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12 }}><span>{sizeText(r.bytes)}</span><span className="muted">{r.sizeGb ? sizeText(r.sizeGb * 1024 ** 3) : '용량 모름'}</span></div>
                      {pct !== null && <div style={{ marginTop: 4 }}><Bar pct={pct} color={r.slow ? '#f59e0b' : '#3b82f6'} label={`추정 진척 ${pct}%`} /></div>}
                    </td>
                    <td className="right" data-sort={r.rateNow ?? ''} style={{ fontWeight: 800, color: r.slow ? TONE.warn : CYAN, fontVariantNumeric: 'tabular-nums' }}>{rateText(r.rateNow)}</td>
                    <td className="right" data-sort={r.rateAvg ?? ''} style={{ fontVariantNumeric: 'tabular-nums' }}>{rateText(r.rateAvg)}</td>
                    <td className="right" data-sort={r.baseline ?? ''} style={{ fontVariantNumeric: 'tabular-nums' }}>{r.baseline ? rateText(r.baseline) : '—'}</td>
                    <td>{r.slow ? <Badge tone="warn">느림</Badge> : r.rateNow === null ? <Badge tone="muted">속도 모름</Badge> : <Badge tone="ok">정상</Badge>}</td>
                  </tr>
                );
              })}
            </tbody>
          </STable>
        )}
      </section>

      <section className="card" aria-label="대기 중" style={{ padding: 0, overflow: 'hidden', minWidth: 0 }}>
        <div style={{ ...ROW, padding: '10px 14px', borderBottom: '1px solid var(--border-soft)' }}><b>대기 {wait.length}</b><span className="muted" style={{ fontSize: 12 }}>Director 가 받았지만 아직 시작하지 않은 실행(스토리지·차례 대기)</span></div>
        {wait.length === 0 ? <div className="muted" style={{ padding: 14, fontSize: 13 }}>대기 중인 실행이 없습니다.</div> : (
          <STable minWidth={600} limit={300}>
            <thead><tr><th>VM</th><th>그룹 · 실행</th><th>레벨</th><th>보낸 시각 · 대기</th><th>상태</th></tr></thead>
            <tbody>
              {wait.map((r) => (
                <tr key={r.jobid}>
                  <td><b>{r.vmName}</b><div className="muted" style={{ fontSize: 11.5, fontFamily: 'var(--mono)' }}>jobid {r.jobid}</div></td>
                  <td style={{ fontSize: 12.5 }}>{r.group || '—'}<div className="muted" style={{ fontSize: 11.5 }}>{triggerText(r)}</div></td>
                  <td>{levelWord(r.level)}</td>
                  <td data-sort={r.since ?? ''} style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{r.since ? shortTs(r.since) : '—'}<div className="muted">{elapsedText(r.elapsed)}</div></td>
                  <td><Badge tone="run">{STATE_TEXT[r.state] || r.state}</Badge></td>
                </tr>
              ))}
            </tbody>
          </STable>
        )}
      </section>
    </>
  );
}

/* ───────── ③ 속도 상태 ───────── */
function SpeedView({ corps, onOpen }) {
  const act = corps.filter((c) => c.running > 0);
  const max = Math.max(1, ...act.map((c) => (typeof c.rateNow === 'number' ? c.rateNow : 0)));
  const total = totalHist(corps);
  const last = total.length ? total[total.length - 1] : null;
  const slow = slowRows(corps);
  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'stretch' }}>
        <section className="card" aria-label="법인별 지금 처리량" style={{ flex: '7 1 520px', minWidth: 0, padding: 14, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 10, alignContent: 'start' }}>
          <div style={ROW}><b>법인별 지금 처리량</b><span className="muted" style={{ fontSize: 12 }}>실행 중 잡의 속도 합 · 오른쪽 = 최근 24시간 평균(중앙값)</span></div>
          {act.length === 0 && <div className="muted" style={{ fontSize: 13 }}>지금 백업이 도는 법인이 없습니다.</div>}
          {act.map((c) => {
            const known = typeof c.rateNow === 'number';
            const w = known ? Math.max(2, Math.round((c.rateNow / max) * 100)) : 0;
            const color = !known ? 'var(--text-dim)' : c.slow ? '#f59e0b' : CYAN;
            return (
              <button key={c.vcenterId} type="button" onClick={() => onOpen(c)} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 150px) minmax(0, 1fr) minmax(0, 230px)', alignItems: 'center', gap: 10, background: 'none', border: 0, padding: 0, color: 'var(--text)', font: 'inherit', cursor: 'pointer', textAlign: 'left' }}>
                <span style={{ fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.vcName}</span>
                <span role="img" aria-label={`${c.vcName} 지금 ${rateText(c.rateNow)}`} style={{ height: 14, borderRadius: 4, background: 'var(--border)', overflow: 'hidden' }}><span style={{ display: 'block', height: 14, width: `${w}%`, background: color }} /></span>
                <span style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}><b style={{ color }}>{rateText(c.rateNow)}</b> <span className="muted" style={{ fontSize: 12 }}>· 평균 {c.rateSamples ? rateText(c.rateMedian) : '—'}</span></span>
              </button>
            );
          })}
        </section>
        <section className="card" aria-label="최근 전체 처리 속도" style={{ flex: '5 1 360px', minWidth: 0, padding: 14, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 8, alignContent: 'start' }}>
          <div style={ROW}><b>최근 전체 처리 속도</b><span className="muted" style={{ fontSize: 12 }}>이 화면을 연 동안 모은 점(서버 메모리 · 재시작하면 비어 있음)</span></div>
          <Spark hist={total.map((p) => [p.at, p.rate])} w={460} h={180} label="최근 전체 처리 속도 흐름" />
          <div className="muted" style={{ fontSize: 12 }}>지금 {last ? (last.rate === null ? (last.partial ? '부분 합(모르는 법인 있음)' : '모름') : rateText(last.rate)) : '—'} · 모르는 법인이 낀 칸은 선을 끊습니다(부분 합을 전체처럼 그리지 않음)</div>
        </section>
      </div>

      <section className="card" aria-label="느린 잡" style={{ padding: 0, overflow: 'hidden', minWidth: 0, ...(slow.length ? { borderColor: 'rgba(245,158,11,.45)' } : {}) }}>
        <div style={{ ...ROW, padding: '10px 14px', borderBottom: '1px solid var(--border-soft)' }}>
          <b style={{ color: slow.length ? TONE.warn : undefined }}>느린 잡 {slow.length}</b>
          <span className="muted" style={{ fontSize: 12 }}>같은 VM 의 지난 성공 평균보다 지금 속도가 절반 이하 · 시작하고 5분이 지난 잡만(지난 기록이 없으면 판정하지 않음)</span>
        </div>
        {slow.length === 0 ? <div className="muted" style={{ padding: 14, fontSize: 13 }}>느린 잡이 없습니다.</div> : (
          <STable minWidth={820} limit={200}>
            <thead><tr><th>법인</th><th>VM</th><th>레벨</th><th>경과</th><th className="right">지금 속도</th><th className="right">지난 평균</th><th className="right">비율</th></tr></thead>
            <tbody>
              {slow.map((r) => (
                <tr key={`${r.corp}-${r.jobid}`}>
                  <td>{r.corp}</td><td><b>{r.vmName}</b></td><td>{levelWord(r.level)}</td>
                  <td data-sort={r.elapsed ?? ''}>{elapsedText(r.elapsed)}</td>
                  <td className="right" data-sort={r.rateNow ?? ''} style={{ color: TONE.warn, fontWeight: 800 }}>{rateText(r.rateNow)}</td>
                  <td className="right" data-sort={r.baseline ?? ''}>{rateText(r.baseline)}</td>
                  <td className="right" data-sort={r.ratio ?? ''}>{r.ratio === null ? '—' : `${Math.round(r.ratio * 100)}%`}</td>
                </tr>
              ))}
            </tbody>
          </STable>
        )}
      </section>

      <section className="card" aria-label="법인별 오늘" style={{ padding: 0, overflow: 'hidden', minWidth: 0 }}>
        <div style={{ ...ROW, padding: '10px 14px', borderBottom: '1px solid var(--border-soft)' }}><b>법인별 오늘 · 평균 속도</b><span className="muted" style={{ fontSize: 12 }}>평균 = 최근 24시간 끝난 성공의 VM 별 평균(바이트 ÷ 소요) 중앙값 · 열 제목으로 정렬</span></div>
        <STable minWidth={760} limit={300}>
          <thead><tr><th>법인</th><th className="right">실행 · 대기</th><th className="right">오늘 성공</th><th className="right">오늘 실패</th><th className="right">평균 속도</th><th className="right">오늘 저장</th><th>상태 조회</th></tr></thead>
          <tbody>
            {corps.map((c) => (
              <tr key={c.vcenterId}>
                <td><b>{c.vcName}</b></td>
                <td className="right" data-sort={c.running + c.waiting}>{c.running} · {c.waiting}</td>
                <td className="right" data-sort={c.today.ok + c.today.warn}>{c.today.ok + c.today.warn}</td>
                <td className="right" data-sort={c.today.fail} style={{ color: c.today.fail ? TONE.bad : undefined }}>{c.today.fail}</td>
                <td className="right" data-sort={c.rateMedian ?? ''}>{c.rateSamples ? rateText(c.rateMedian) : '—'}</td>
                <td className="right" data-sort={c.today.bytes}>{sizeText(c.today.bytes)}</td>
                <td style={{ fontSize: 12.5, color: c.live && !c.live.ok ? TONE.bad : 'var(--text-dim)' }}>{c.live ? (c.live.ok ? shortTs(c.live.at) : liveCodeText(c.live.code)) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </STable>
      </section>
    </>
  );
}
