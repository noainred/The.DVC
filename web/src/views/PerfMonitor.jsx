import React, { useEffect, useRef, useState } from 'react';
import { fetchJson, putJson, postJson, delJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';
import { STable } from '../components/STable.jsx';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine } from 'recharts';
import {
  ms as fmtMs, pct, when, ago, reasonLabel, loopBadge, loopNote, hangSummary, hangKindLabel,
  measureVerdict, slowRate, routeHint, ridMatches, ridLookupText,
} from './perfMonitorText.js';
import { unitText } from './unitText.js';

/**
 * 설정 › 서버 성능 측정(v2.498) — 사용자 요청: "'불러오는 중…' 이 3분 이상 지속될 때가 있다.
 * 설정에 서버 성능 측정 메뉴를 만들고, 이런 hang 현상이 발생할 때 로그를 찍어 나중에 튜닝할 때 쓰자."
 *
 * 보여주는 것:
 *  · 지금 상태 — 이벤트 루프 최근 창·진행 중 요청·활성 작업·메모리, '지금 측정'(setImmediate 왕복).
 *  · 라우트별 지연 — 건수·p50/p95/p99(버킷 근사)·최대·느린 건수·대기형/막힘형 힌트.
 *  · 느린 요청 — 사유를 **기다림(외부 응답)** 과 **막힘(동기 CPU)** 으로 구분해 표시.
 *  · hang 기록 — 루프 정체와 '화면이 오래 로딩' 보고를 같은 목록에서 본다(파일에 남아 재시작 후에도 조회).
 * 판정·문구는 순수 모듈(perfMonitorText.js)에 있고 테스트로 고정한다.
 */
const POLL_MS = 15_000;
const KEEP_PRESETS = [100, 500, 1000];

function Badge({ label, color }) {
  return <span className={`badge ${color || 'gray'}`}>{label}</span>;
}
function Card({ label, value, sub, color }) {
  return (
    <div className="card" style={{ padding: '10px 14px', minWidth: 150, flex: '1 1 150px' }}>
      <div className="muted" style={{ fontSize: 11.5 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: color || 'inherit' }}>{value}</div>
      {sub && <div className="muted" style={{ fontSize: 11, overflowWrap: 'anywhere' }}>{sub}</div>}
    </div>
  );
}

export default function PerfMonitor() {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('now');      // now | routes | slow | hangs | settings
  const [form, setForm] = useState(null);     // 설정 편집 버퍼
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);
  const [measured, setMeasured] = useState(null);
  const [hangFile, setHangFile] = useState(null); // 파일에서 읽은 기록(재시작 전 포함)
  // v2.583: 요청 ID 찾기 — 로딩 화면에 보인 ID 로 느린 요청·hang·진행 중 목록을 거르고, 서버의 최근 완료 기록을 조회한다.
  const [ridQ, setRidQ] = useState('');
  const [ridHit, setRidHit] = useState(null);
  const inited = useRef(false);

  const load = async () => {
    try {
      const r = await fetchJson('/admin/perf');
      setD(r);
      if (!inited.current) { inited.current = true; setForm({ ...r.settings }); }
      setError('');
    } catch (e) { setError(e.message || String(e)); }
  };
  useEffect(() => { load(); const t = setInterval(load, POLL_MS); return () => clearInterval(t); }, []);

  if (error && !d) return <ErrorBox message={error} />;
  if (!d) return <Loading />;

  const st = d.settings || {};
  const lim = d.limits || {};
  const lb = loopBadge(d.loop?.last, st.hangLagMs);
  const note = loopNote({ monitorEnabled: d.loop?.monitorEnabled, windowCount: d.loop?.windowCount, windowMs: d.loop?.last?.windowMs || 30_000 });

  const NUMERIC = ['slowRequestMs', 'hangLagMs', 'clientStuckMs', 'clientDetailMs', 'keepSlow', 'keepHangs', 'retentionDays'];
  const save = async () => {
    setBusy('save'); setMsg(null);
    try {
      // 빈 칸은 **보내지 않는다** — 숫자 입력을 비운 상태로 저장하면 서버가 ''(→0)를 '범위 밖'
      // 으로 보고 최소값으로 승격시켜, 보존일이 1일로 바뀌고 같은 요청의 정리에서 hang 기록이
      // 즉시 지워진다(적대적 리뷰 지적). 서버도 빈 값을 무시하도록 함께 고쳤다.
      const body = { enabled: !!form.enabled };
      for (const k of NUMERIC) if (String(form[k] ?? '').trim() !== '') body[k] = form[k];
      const r = await putJson('/admin/perf/settings', body);
      setForm({ ...r.settings });
      setMsg({ ok: true, text: `저장됨 — 다음 요청·다음 창부터 적용${r.pruned?.trimmed ? ` (보존일 정리 ${r.pruned.trimmed}줄)` : ''}` });
      load();
    } catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(''); }
  };
  const measure = async () => {
    setBusy('measure'); setMsg(null); setMeasured(null);
    try { setMeasured(await postJson('/admin/perf/measure', {})); }
    catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(''); }
  };
  const loadFile = async () => {
    setBusy('file'); setMsg(null);
    try { setHangFile(await fetchJson('/admin/perf/hangs', { limit: 200 })); }
    catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(''); }
  };
  const clearFile = async () => {
    setBusy('clear'); setMsg(null);
    try { await delJson('/admin/perf/hangs'); setHangFile(null); setMsg({ ok: true, text: 'hang 로그 파일을 비웠습니다(메모리 기록은 프로세스 재시작까지 남습니다).' }); load(); }
    catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(''); }
  };

  const lookupRid = async () => {
    const q = ridQ.trim();
    if (!q) { setRidHit(null); return; }
    try {
      const r = await fetchJson('/perf/req-status', { ids: q }, undefined, { retries: 0 });
      setRidHit({ q, text: ridLookupText(q, r?.items?.[q]) || `${q} — 요청 ID 형식이 아닙니다(영숫자로 시작 · 4~40자).` });
    } catch (e) { setRidHit({ q, text: `조회 실패: ${e.message || e}` }); }
  };
  const slowRows = (d.slow || []).filter((r) => ridMatches(r, ridQ));
  const inflightRows = (d.inflight || []).filter((r) => ridMatches(r, ridQ));

  const mv = measured ? measureVerdict(measured) : null;
  const chart = (d.loop?.windows || []).map((w) => ({ ts: w.ts, maxMs: w.maxMs, p99Ms: w.p99Ms, eluPct: w.eluPct }));

  return (
    <div>
      {error && <div className="muted" style={{ fontSize: 12, color: 'var(--amber)', marginBottom: 8 }}>갱신 실패(직전 값 표시): {error}</div>}
      <div className="kpis" style={{ marginBottom: 12 }}>
        <Card label="이벤트 루프(최근 창)" value={fmtMs(d.loop?.last?.maxMs)} color={lb.color === 'red' ? 'var(--red)' : lb.color === 'amber' ? 'var(--amber)' : 'var(--green)'}
          sub={`p99 ${fmtMs(d.loop?.last?.p99Ms)} · 평균 ${fmtMs(d.loop?.last?.meanMs)}${d.loop?.last?.eluPct != null ? ` · 이용률 ${pct(d.loop.last.eluPct)}` : ''}`} />
        <Card label="진행 중 요청" value={d.totals?.inflightN ?? 0}
          sub={`${d.jobs?.length ? `작업: ${d.jobs.join(', ')}` : '계측된 작업 없음'}${d.totals?.reaped ? ` · 미완료 수확 ${d.totals.reaped}건` : ''}${d.totals?.untracked ? ` · 추적 포기 ${d.totals.untracked}건` : ''}`} />
        <Card label="느린 요청" value={d.totals?.slow ?? 0} sub={`전체 ${(d.totals?.requests ?? 0).toLocaleString()}건 중 · 임계 ${fmtMs(st.slowRequestMs)}`}
          color={d.totals?.slow ? 'var(--amber)' : undefined} />
        <Card label="hang 기록" value={d.totals?.hangs ?? 0} sub={`화면 로딩 보고 ${d.totals?.clientStalls ?? 0}건 · 임계 ${fmtMs(st.hangLagMs)}`} color={d.totals?.hangs ? 'var(--red)' : undefined} />
        <Card label="메모리(RSS)" value={unitText(d.mem?.rssMb, ' MB')} sub={`heap ${unitText(d.mem?.heapUsedMb)}/${unitText(d.mem?.heapTotalMb, ' MB')} · 가동 ${Math.floor((d.totals?.uptimeSec || 0) / 3600)}시간`} />
      </div>

      <div className="flex gap wrap" style={{ marginBottom: 10, alignItems: 'center' }}>
        {[['now', '지금 상태'], ['routes', `라우트별 지연 (${(d.routes || []).length})`], ['slow', `느린 요청 (${(d.slow || []).length})`],
          ['hangs', `hang 기록 (${(d.hangs || []).length})`], ['settings', '설정']].map(([k, l]) => (
          <button key={k} className={tab === k ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '7px 14px' }} onClick={() => setTab(k)}>{l}</button>
        ))}
        <span style={{ marginLeft: 'auto' }} className="muted">{st.enabled ? `계측 켜짐 · ${POLL_MS / 1000}초마다 갱신` : '⚠ 계측 꺼짐 — 설정 탭에서 켜세요'}</span>
      </div>
      {msg && <div style={{ marginBottom: 8, fontSize: 12.5, color: msg.ok ? 'var(--green)' : 'var(--red)', overflowWrap: 'anywhere' }}>{msg.text}</div>}
      <div className="flex gap wrap" style={{ marginBottom: 10, alignItems: 'center' }}>
        <input className="input" style={{ width: 220, maxWidth: '100%' }} placeholder="요청 ID 찾기(로딩 화면에 보인 값)"
          value={ridQ} onChange={(e) => { setRidQ(e.target.value); setRidHit(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter') lookupRid(); }} />
        <button className="tab" style={{ padding: '5px 12px' }} onClick={lookupRid} disabled={!ridQ.trim()}>서버 기록 조회</button>
        {ridQ.trim() && <span className="muted" style={{ fontSize: 11.5 }}>느린 요청·hang·진행 중 목록을 이 ID 로 거릅니다.</span>}
        {ridHit && <div style={{ flexBasis: '100%', fontSize: 12.5, overflowWrap: 'anywhere' }}>{ridHit.text}</div>}
      </div>

      {tab === 'now' && (<>
        <div className="card" style={{ padding: 14, marginBottom: 12 }}>
          <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 6 }}>
            <div style={{ fontWeight: 700 }}>이벤트 루프 지연 추이</div>
            <Badge label={lb.label} color={lb.color} />
            <button className="tab" style={{ marginLeft: 'auto', padding: '5px 12px' }} disabled={busy !== ''} onClick={measure}>
              {busy === 'measure' ? '측정 중…' : '⏱ 지금 측정'}
            </button>
          </div>
          {note && <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>{note}</div>}
          {chart.length > 1 ? (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={chart}>
                <CartesianGrid stroke="rgba(148,163,184,.15)" />
                <XAxis dataKey="ts" tick={{ fontSize: 11 }} tickFormatter={(t) => new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })} />
                <YAxis tick={{ fontSize: 11 }} unit="ms" />
                <Tooltip labelFormatter={(t) => when(t)} formatter={(v, n) => [n === 'eluPct' ? pct(v) : fmtMs(v), n === 'maxMs' ? '최대 지연' : n === 'p99Ms' ? 'p99' : '루프 이용률']}
                  contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, fontSize: 12 }} />
                <ReferenceLine y={st.hangLagMs} stroke="#dc2626" strokeDasharray="4 3" label={{ value: `hang 임계 ${fmtMs(st.hangLagMs)}`, fontSize: 10, fill: '#dc2626', position: 'insideTopRight' }} />
                <Line type="monotone" dataKey="maxMs" stroke="#f87171" dot={false} strokeWidth={1.5} />
                <Line type="monotone" dataKey="p99Ms" stroke="#60a5fa" dot={false} strokeWidth={1} />
              </LineChart>
            </ResponsiveContainer>
          ) : <div className="muted" style={{ fontSize: 12.5 }}>표시할 창이 아직 없습니다(창 1건 이하).</div>}
          <div className="muted" style={{ fontSize: 11.5, marginTop: 6, lineHeight: 1.6 }}>
            각 점은 30초 창의 <b>최대·p99 이벤트 루프 지연</b>입니다(<code>monitorEventLoopDelay</code>). 지연이 크다는 것은 그 구간에
            동기 작업(수집 SOAP 파싱·집계·대량 DB 쓰기)이 메인 루프를 붙잡았다는 뜻이고, 그때 들어온 모든 요청이 함께 늦어집니다.
            차트는 최대 240점으로 줄여 그리며 <b>구간 최댓값을 보존</b>합니다(피크를 평균으로 지우지 않습니다).
          </div>
        </div>
        {measured && (
          <div className="card" style={{ padding: 14, marginBottom: 12 }}>
            <div className="flex gap" style={{ alignItems: 'center', marginBottom: 6 }}>
              <div style={{ fontWeight: 700 }}>지금 측정 결과</div>
              <Badge label={mv.label} color={mv.color} />
            </div>
            <div style={{ fontSize: 13, marginBottom: 8 }}>{mv.text}</div>
            {measured.ok && (<>
              <div className="kpis">
                <Card label="setImmediate 왕복 p50/p95" value={`${fmtMs(measured.immediate?.p50Ms)} / ${fmtMs(measured.immediate?.p95Ms)}`} sub={`표본 ${measured.samples}회 · 최대 ${fmtMs(measured.immediate?.maxMs)}`} />
                <Card label="1초 히스토그램 최대" value={fmtMs(measured.histogram1s?.maxMs)} sub={`p99 ${fmtMs(measured.histogram1s?.p99Ms)} · 평균 ${fmtMs(measured.histogram1s?.meanMs)}`} />
                <Card label="메모리" value={`${measured.mem?.rssMb} MB`} sub={`heap ${measured.mem?.heapUsedMb}/${measured.mem?.heapTotalMb} · external ${measured.mem?.externalMb} MB`} />
                <Card label="그때 진행 중" value={`요청 ${measured.inflightN}건`} sub={measured.jobs?.length ? `작업: ${measured.jobs.join(', ')}` : '작업 없음'} />
              </div>
              <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
                판정 기준(20ms·100ms)은 관행적 값이며 문서화된 SLA 가 아닙니다 — 절대 수치보다 <b>평소와 다른지</b>를 보세요.
              </div>
            </>)}
          </div>
        )}
        <div className="card" style={{ padding: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>진행 중 요청 {inflightRows.length ? `(${inflightRows.length})` : ''}</div>
          {inflightRows.length ? (
            <STable className="table" minWidth={520}>
              <thead><tr><th>경과</th><th>요청 ID</th><th>메서드</th><th>경로</th></tr></thead>
              <tbody>{inflightRows.map((r) => (
                <tr key={r.id}>
                  <td data-sort={r.ageMs} style={{ color: r.ageMs > 5000 ? 'var(--amber)' : undefined }}>{fmtMs(r.ageMs)}</td>
                  <td style={{ fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 12 }}>{r.rid || '—'}</td>
                  <td>{r.method}</td><td style={{ overflowWrap: 'anywhere' }}>{r.path}</td>
                </tr>
              ))}</tbody>
            </STable>
          ) : <div className="muted" style={{ fontSize: 12.5 }}>지금 처리 중인 요청이 없습니다(이 조회 자체는 제외).</div>}
        </div>
      </>)}

      {tab === 'routes' && (<>
        <div className="muted" style={{ fontSize: 12, marginBottom: 8, lineHeight: 1.6 }}>
          라우트별 요청 지연. 백분위는 <b>12버킷 히스토그램의 선형 보간 근사</b>입니다(요청마다 표본을 쌓지 않아 상시 비용이 O(1)).
          정렬 기본은 '느린 건수' — 튜닝은 자주 느린 것부터 합니다. 프로세스 재시작 시 초기화됩니다.
          {d.routesTruncated && <> 라우트가 많아 상위 {(d.routes || []).length}개만 표시합니다.</>}
          {d.totals?.routesEvicted ? <> 키 상한({d.totals.routeKeys}개)에 닿아 가장 오래된 키 {d.totals.routesEvicted}개를 퇴출했습니다 — 라우터가 매칭하지 못한 요청(401·404)은 개별 키를 만들지 않고 <code>__unauthorized__</code>·<code>__unmatched__</code> 로 모입니다.</> : null}
        </div>
        <STable minWidth={1180} className="table">
          <thead><tr><th>라우트</th><th>건수</th><th>평균</th><th>p50</th><th>p95</th><th>p99</th><th>최대</th><th>느림</th><th>느림 비율</th><th>5xx</th><th>유형</th><th>마지막</th></tr></thead>
          <tbody>{(d.routes || []).map((r) => {
            const rate = slowRate(r);
            return (
              <tr key={r.route}>
                <td style={{ overflowWrap: 'anywhere' }}>{r.route}</td>
                <td data-sort={r.n}>{r.n.toLocaleString()}</td>
                <td data-sort={r.avgMs ?? -1}>{fmtMs(r.avgMs)}</td>
                <td data-sort={r.p50Ms ?? -1}>{fmtMs(r.p50Ms)}</td>
                <td data-sort={r.p95Ms ?? -1} style={{ color: (r.p95Ms || 0) >= st.slowRequestMs ? 'var(--amber)' : undefined }}>{fmtMs(r.p95Ms)}</td>
                <td data-sort={r.p99Ms ?? -1}>{fmtMs(r.p99Ms)}</td>
                <td data-sort={r.maxMs}>{fmtMs(r.maxMs)}</td>
                <td data-sort={r.slowN}>{r.slowN || '—'}</td>
                <td data-sort={rate ?? -1}>{rate == null ? '—' : `${rate}%`}</td>
                <td data-sort={r.errN}>{r.errN || '—'}</td>
                <td className="muted">{routeHint(r.route, d.slow) || '—'}</td>
                <td data-sort={r.lastTs ?? 0} className="muted">{ago(r.lastTs)}</td>
              </tr>
            );
          })}</tbody>
        </STable>
      </>)}

      {tab === 'slow' && (<>
        <div className="muted" style={{ fontSize: 12, marginBottom: 8, lineHeight: 1.6 }}>
          임계({fmtMs(st.slowRequestMs)}) 를 넘은 요청과, 짧아도 <b>루프 정체가 관측된 구간과 겹친</b> 요청입니다.
          사유 <b>오래 걸림</b>은 외부(vCenter·SSH·DB) 응답을 기다린 것이고 — 고RTT 사이트에서는 정상입니다 —
          <b>정체 겹침</b>은 동기 작업이 서버를 붙잡았을 가능성이 큰 쪽입니다. 다만 루프 정체는 <b>30초 창</b>
          단위로만 관측되므로 겹침이 '이 요청이 그만큼 막혔다' 는 증명은 아니며, 귀속 값은 요청 길이로 상한을 둡니다.
          롱폴·데이터스토어 탐색처럼 오래 걸리는 것이 정상인 라우트는 월타임 기준에서 제외합니다.
          최근 {st.keepSlow}건만 보관합니다(프로세스 재시작 시 초기화).
        </div>
        {slowRows.length ? (
          <STable minWidth={1240} className="table">
            <thead><tr><th>시각</th><th>요청 ID</th><th>사유</th><th>소요</th><th>정체 겹침</th><th>상태</th><th>메서드</th><th>경로</th><th>사용자</th><th>진행중</th><th>RSS</th><th>작업</th></tr></thead>
            <tbody>{slowRows.map((r, i) => {
              const rl = reasonLabel(r.reason);
              return (
                <tr key={`${r.ts}-${i}`}>
                  <td data-sort={r.ts}>{when(r.ts)}</td>
                  <td style={{ fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 12 }}>{r.rid || '—'}</td>
                  <td title={rl.help}><Badge label={rl.label} color={rl.color} /></td>
                  <td data-sort={r.ms}>{fmtMs(r.ms)}</td>
                  <td data-sort={r.stallMs}>{r.stallMs ? fmtMs(r.stallMs) : '—'}</td>
                  <td data-sort={r.status}>{r.status}</td>
                  <td>{r.method}</td>
                  <td style={{ overflowWrap: 'anywhere' }}>{r.path}</td>
                  <td className="muted">{r.user || '—'}</td>
                  <td data-sort={r.inflightN}>{r.inflightN}</td>
                  <td data-sort={r.rssMb}>{r.rssMb} MB</td>
                  <td className="muted" style={{ overflowWrap: 'anywhere' }}>{(r.jobs || []).join(', ') || '—'}</td>
                </tr>
              );
            })}</tbody>
          </STable>
        ) : <div className="muted" style={{ fontSize: 12.5 }}>{ridQ.trim() && (d.slow || []).length ? '이 요청 ID 에 해당하는 느린 요청이 없습니다 — 위 서버 기록 조회로 빠르게 끝난 요청인지 확인하세요.' : '임계를 넘은 요청이 아직 없습니다.'}</div>}
      </>)}

      {tab === 'hangs' && (<>
        <div className="muted" style={{ fontSize: 12, marginBottom: 8, lineHeight: 1.6 }}>
          <b>루프 정체</b>(이벤트 루프가 {fmtMs(st.hangLagMs)} 이상 멈춤)와 <b>화면 로딩</b>(브라우저가 {fmtMs(st.clientStuckMs)} 이상
          '불러오는 중' 이었다고 보고) 기록입니다. 두 종류를 같은 목록에서 보는 이유: 화면이 멈춘 순간 서버가 실제로 막혀
          있었는지(그때 진행 중이던 요청·작업)를 대조해야 원인을 귀속할 수 있습니다. 아래 목록은 이 프로세스의 메모리 기록이고,
          같은 내용이 파일(<code>perf-hangs.ndjson</code>)에도 남아 재시작 후에도 조회됩니다.
        </div>
        <div className="flex gap wrap" style={{ marginBottom: 8, alignItems: 'center' }}>
          <button className="tab" style={{ padding: '5px 12px' }} disabled={busy !== ''} onClick={loadFile}>
            {busy === 'file' ? '읽는 중…' : '📄 파일에서 읽기(재시작 이전 포함)'}
          </button>
          <button className="logout-btn" style={{ flex: 'none', padding: '5px 12px' }} disabled={busy !== ''} onClick={clearFile}>
            {busy === 'clear' ? '삭제 중…' : '로그 비우기'}
          </button>
          <span className="muted" style={{ fontSize: 11.5 }}>
            파일 {d.hangLog?.bytes == null ? '없음' : `${Math.round(d.hangLog.bytes / 1024)} KB / 상한 ${Math.round((d.hangLog?.maxBytes || 0) / 1048576)} MB`}
            {d.hangLog?.dropped ? ` · 분당 상한(${d.hangLog.maxPerMin})으로 버린 기록 ${d.hangLog.dropped}건` : ''}
            {d.hangLog?.lastError ? ` · 쓰기 오류: ${d.hangLog.lastError}` : ''}
            {' '}· 보존 {st.retentionDays}일
          </span>
        </div>
        {hangFile && (
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            파일에서 {hangFile.rows?.length ?? 0}건 읽음({hangFile.tailOnly ? '파일이 읽기 상한을 넘어 뒤쪽 일부만 읽었습니다 — ' : '총 '}{hangFile.total ?? 0}줄{hangFile.badLines ? ` · 파싱 실패 ${hangFile.badLines}줄` : ''}).
            {hangFile.error ? ` 읽기 오류: ${hangFile.error}` : ''}
          </div>
        )}
        {(() => {
          const rows = (hangFile?.rows?.length ? hangFile.rows : (d.hangs || [])).filter((ev) => ridMatches(ev, ridQ));
          if (!rows.length) return <div className="muted" style={{ fontSize: 12.5 }}>기록된 hang 이 없습니다 — 정체가 관측되지 않았거나 계측이 켜진 뒤 아직 발생하지 않았습니다.</div>;
          return (
            <STable className="table">
              <thead><tr><th>시각</th><th>종류</th><th>요약</th><th>사용자</th><th>RSS</th></tr></thead>
              <tbody>{rows.map((ev, i) => (
                <tr key={`${ev.at}-${i}`}>
                  <td data-sort={ev.at}>{when(ev.at)}<div className="muted" style={{ fontSize: 11 }}>{ago(ev.at)}</div></td>
                  <td><Badge label={hangKindLabel(ev.kind)} color={ev.kind === 'client' ? 'amber' : 'red'} /></td>
                  <td style={{ overflowWrap: 'anywhere' }}>{hangSummary(ev)}</td>
                  <td className="muted">{ev.user || '—'}</td>
                  <td data-sort={ev.rssMb ?? 0}>{ev.rssMb == null ? '—' : `${ev.rssMb} MB`}</td>
                </tr>
              ))}</tbody>
            </STable>
          );
        })()}
      </>)}

      {tab === 'settings' && form && (
        <div className="card" style={{ padding: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>계측 설정</div>
          <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.6, margin: '0 0 10px' }}>
            계측은 요청당 Map 등록·카운터 증가만 하고(상시 O(1)), <b>임계를 넘은 것만</b> 기록합니다.
            임계를 낮추면 기록이 늘어 메모리·로그 파일이 커집니다. 재시작 없이 다음 요청부터 적용됩니다.
          </p>
          <div className="flex gap wrap" style={{ alignItems: 'center', gap: 14 }}>
            <label className="flex gap" style={{ alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={!!form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> 계측 사용
            </label>
            <label className="flex gap" style={{ alignItems: 'center', gap: 6 }}>
              느린 요청 임계(ms)
              <input className="input" style={{ width: 110 }} type="number" min={lim.slowRequestMs?.min} max={lim.slowRequestMs?.max}
                value={form.slowRequestMs} onChange={(e) => setForm({ ...form, slowRequestMs: e.target.value })} />
            </label>
            <label className="flex gap" style={{ alignItems: 'center', gap: 6 }}>
              hang(루프 정체) 임계(ms)
              <input className="input" style={{ width: 110 }} type="number" min={lim.hangLagMs?.min} max={lim.hangLagMs?.max}
                value={form.hangLagMs} onChange={(e) => setForm({ ...form, hangLagMs: e.target.value })} />
            </label>
            <label className="flex gap" style={{ alignItems: 'center', gap: 6 }}>
              화면 로딩 보고 임계(ms)
              <input className="input" style={{ width: 120 }} type="number" min={lim.clientStuckMs?.min} max={lim.clientStuckMs?.max}
                value={form.clientStuckMs} onChange={(e) => setForm({ ...form, clientStuckMs: e.target.value })} />
            </label>
            {/* v2.501(사용자 요구): 대기가 이 시간을 넘으면 화면이 '무슨 작업을 기다리는지' 를 보여준다. */}
            <label className="flex gap" style={{ alignItems: 'center', gap: 6 }} title="이 시간을 넘게 기다리면 화면 로딩 표시와 우하단 진행 표시가 작업 이름·대기 시간을 보여줍니다.">
              진행상태 표시 임계(ms)
              <input className="input" style={{ width: 110 }} type="number" min={lim.clientDetailMs?.min} max={lim.clientDetailMs?.max}
                value={form.clientDetailMs} onChange={(e) => setForm({ ...form, clientDetailMs: e.target.value })} />
            </label>
          </div>
          <div className="flex gap wrap" style={{ alignItems: 'center', gap: 14, marginTop: 10 }}>
            <label className="flex gap" style={{ alignItems: 'center', gap: 6 }}>
              느린 요청 보관
              <select className="select" style={{ width: 100 }} value={form.keepSlow} onChange={(e) => setForm({ ...form, keepSlow: Number(e.target.value) })}>
                {KEEP_PRESETS.map((n) => <option key={n} value={n}>{n}건</option>)}
              </select>
            </label>
            <label className="flex gap" style={{ alignItems: 'center', gap: 6 }}>
              hang 보관
              <select className="select" style={{ width: 100 }} value={form.keepHangs} onChange={(e) => setForm({ ...form, keepHangs: Number(e.target.value) })}>
                {KEEP_PRESETS.map((n) => <option key={n} value={n}>{n}건</option>)}
              </select>
            </label>
            <label className="flex gap" style={{ alignItems: 'center', gap: 6 }}>
              로그 보존(일)
              <input className="input" style={{ width: 90 }} type="number" min={lim.retentionDays?.min} max={lim.retentionDays?.max}
                value={form.retentionDays} onChange={(e) => setForm({ ...form, retentionDays: e.target.value })} />
            </label>
            <button className="login-btn" disabled={busy !== ''} onClick={save}>{busy === 'save' ? '저장 중…' : '저장'}</button>
          </div>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 8, lineHeight: 1.6 }}>
            허용 범위 — 느린 요청 {lim.slowRequestMs?.min}~{lim.slowRequestMs?.max}ms · hang {lim.hangLagMs?.min}~{lim.hangLagMs?.max}ms ·
            화면 로딩 {lim.clientStuckMs?.min}~{lim.clientStuckMs?.max}ms · 진행상태 표시 {lim.clientDetailMs?.min}~{lim.clientDetailMs?.max}ms ·
            보존 {lim.retentionDays?.min}~{lim.retentionDays?.max}일.
            기본값은 각각 {fmtMs(d.defaults?.slowRequestMs)} · {fmtMs(d.defaults?.hangLagMs)} · {fmtMs(d.defaults?.clientStuckMs)} · {fmtMs(d.defaults?.clientDetailMs)} · {d.defaults?.retentionDays}일입니다.
            <br />이벤트 루프 창 주기·경고 임계는 서버 환경변수(<code>LOOP_LAG_INTERVAL_MS</code> · <code>LOOP_LAG_WARN_MS</code>)로 조정하며,
            <code>LOOP_LAG_MONITOR</code>=0 이면 루프 계측이 꺼집니다(요청 지연 집계는 계속 동작).
          </div>
        </div>
      )}
    </div>
  );
}
