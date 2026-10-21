import React, { useEffect, useMemo, useState } from 'react';
import { fetchJson, canCsv, downloadFile, hasRole } from '../../api.js';
import { Loading, ErrorBox, Kpi, SearchBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import BoldText from '../../components/boldText.jsx';
import { VmLink } from '../../components/EntityDetail.jsx';   // v2.749.1 '정보' — 공용 VM 상세 창
import {
  levelOf, gbText, pctText, growthText, etaText, osLabel, timeText, overviewParams, collectNote,
} from './guestPartText.js';

/**
 * 특수기능 › 게스트 파티션 사용률(v2.749 — 시안 ①②). 서버(GET /tools/guest-partition · /vcenter/:id)가 판정·범위를 정하고 여기는 그린다.
 * 폴링하지 않는다(무거운 조회 — 열 때 1회 + 새로고침·조건 변경). 조건을 바꾸면 이전 요청을 끊고, 늦게 온 이전 응답은 버린다(요청 키).
 */
const SEG = { flex: 'none', padding: '4px 12px' };
const ELL = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };

function Seg({ items, value, onPick, label }) {
  return (
    <div className="flex gap" style={{ flexWrap: 'wrap' }} role="group" aria-label={label}>
      {items.map(([k, t]) => <button key={k} type="button" className={value === k ? 'login-btn' : 'tab'} style={SEG} onClick={() => onPick(k)}>{t}</button>)}
    </div>
  );
}

function Bar({ pct, thr }) {
  const L = levelOf(pct, thr);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
      <div style={{ flex: 1, height: 8, background: 'rgba(148,163,184,.18)', borderRadius: 4, overflow: 'hidden', minWidth: 60 }}>
        <div style={{ width: `${Math.min(100, Number(pct) || 0)}%`, height: '100%', background: L.color, borderRadius: 4 }} />
      </div>
      <span style={{ color: L.color, fontWeight: 600, minWidth: 50, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{pctText(pct)}</span>
      {L.tag && <span style={{ fontSize: 11, color: L.color, border: `1px solid ${L.color}`, borderRadius: 999, padding: '0 6px' }}>{L.tag}</span>}
    </div>
  );
}

function useGet(path, params, deps) {
  const [st, setSt] = useState({ data: null, error: null, key: '' });
  const key = JSON.stringify([path, params]);
  useEffect(() => {
    const ac = new AbortController();
    fetchJson(path, params, ac.signal, { timeoutMs: 60_000, retries: 0 })
      .then((d) => { if (!ac.signal.aborted) setSt({ data: d, error: null, key }); })
      .catch((e) => { if (!ac.signal.aborted) setSt({ data: null, error: e.message, key }); });
    return () => ac.abort();
  }, [key, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data: st.key === key ? st.data : null, error: st.key === key ? st.error : null, stale: st.key !== key ? st.data : null };
}

const NOTES = [
  '사용률 = 사용 ÷ 할당. 값은 **VMware Tools** 가 보고한 게스트 파일시스템(Windows 드라이브·Linux 마운트 지점) 기준이라 데이터스토어의 VMDK 크기와 다를 수 있습니다.',
  'Tools 가 돌지 않거나 전원이 꺼진 게스트는 파티션을 보고하지 않습니다 — **확인 불가**로 따로 세고 초과·정상 어디에도 넣지 않습니다.',
  '7일 증가는 사용량이 정해진 크기(게스트 디스크 수집 설정의 변화 기준, 기본 1 GB) 이상 바뀔 때만 남긴 기록으로 계산합니다 — 그보다 작은 변화는 보이지 않고, 7일 전 기록이 없으면 표시하지 않습니다.',
  '가득 참 예상은 7일 증가 속도를 그대로 이어 간 **단순 추정**입니다. 무시 규칙(Windows 드라이브·Linux 마운트 지점 등)에 걸린 파티션은 경보에서 빠지지만 수집·저장은 됩니다.',
];

function Overview({ onOpenVc }) {
  const [thr, setThr] = useState(null);
  const [mode, setMode] = useState(null);
  const [os, setOs] = useState('all');
  const [q, setQ] = useState('');
  const [qApplied, setQApplied] = useState('');
  const [reload, setReload] = useState(0);
  const [csvMsg, setCsvMsg] = useState('');
  const [showN, setShowN] = useState(50);   // 표는 50행씩(정렬 뒤 자른다 — STable limit) · 더 보기
  useEffect(() => { const t = setTimeout(() => setQApplied(q), 350); return () => clearTimeout(t); }, [q]);
  const params = overviewParams({ thr, defaultThr: null, mode, os, q: qApplied });
  const { data, error, stale } = useGet('/tools/guest-partition', params, [reload]);
  const d = data || stale;
  const defThr = d?.settings?.threshold ?? 80;
  const curThr = thr ?? defThr;
  const curMode = mode ?? d?.mode ?? 'part';
  const csv = () => {
    setCsvMsg('내려받는 중…');
    downloadFile(`/tools/guest-partition/export.csv?${new URLSearchParams(params).toString()}`).then((n) => setCsvMsg(`저장: ${n}`)).catch((e) => setCsvMsg(`실패: ${e.message}`));
  };
  const note = collectNote(d?.collect);
  const maxOver = Math.max(1, ...(d?.vcenters || []).map((v) => v.overVms));
  return (
    <div style={{ minWidth: 0 }}>
      <div className="flex gap" style={{ flexWrap: 'wrap', alignItems: 'center', padding: 10, marginBottom: 10 }}>
        <label className="flex gap" style={{ alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13 }}>임계 사용률</span>
          <input type="range" min={d?.meta?.rangeThr?.min ?? 50} max={d?.meta?.rangeThr?.max ?? 99} value={curThr}
            onChange={(e) => setThr(Number(e.target.value))} aria-label="임계 사용률" style={{ width: 150 }} />
          <b style={{ fontSize: 18, color: '#fbbf24', minWidth: 46, fontVariantNumeric: 'tabular-nums' }}>{curThr}%</b>
        </label>
        <div className="flex gap" style={{ flexWrap: 'wrap' }}>
          {[70, 80, 90, 95].map((v) => (
            <button key={v} type="button" className={curThr === v ? 'login-btn' : 'tab'} style={SEG} onClick={() => setThr(v)}>{v}%</button>
          ))}
          {thr != null && <button type="button" className="tab" style={SEG} onClick={() => setThr(null)} title="설정의 기본 임계와 vCenter 별 임계를 씁니다.">기본({defThr}%)</button>}
        </div>
        <Seg label="판정 단위" items={[['part', '파티션 하나라도'], ['vm', 'VM 합계']]} value={curMode} onPick={setMode} />
        <Seg label="OS" items={[['all', '전체 OS'], ['win', 'Windows'], ['lnx', 'Linux']]} value={os} onPick={setOs} />
        <SearchBox className="input" style={{ flex: '1 1 200px', minWidth: 0, maxWidth: 320 }} value={q} onChange={setQ} placeholder="VM 이름·파티션 찾기" />
        <button type="button" className="tab" style={SEG} onClick={() => setReload((x) => x + 1)}>🔄 새로</button>
        {canCsv() && <button type="button" className="tab" style={SEG} onClick={csv} title="지금 조건의 초과 목록 전체를 CSV 로 받습니다(값 없는 칸은 빈 값).">⬇ CSV</button>}
        {hasRole('admin') && <a className="tab" style={{ ...SEG, textDecoration: 'none' }} href="#/settings/guest-partition">⚙ 설정·메일</a>}
        {csvMsg && <span className="muted" style={{ fontSize: 12 }}>{csvMsg}</span>}
      </div>
      {thr != null && <div className="muted" style={{ fontSize: 12, margin: '-4px 0 8px' }}>화면에서 고른 임계 {thr}% 를 모든 vCenter 에 씁니다(vCenter 별 임계는 이 화면에서 쓰지 않습니다). 메일은 설정의 임계를 씁니다.</div>}
      {error && <ErrorBox message={error} />}
      {!error && !d && <Loading />}
      {d && (
        <div style={{ opacity: data ? 1 : 0.55 }}>
          {note && <div className="card muted" style={{ fontSize: 13, padding: 10, marginBottom: 10, borderColor: 'var(--amber, #f59e0b)' }}>{note}</div>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 10 }}>
            <Kpi label="임계 초과 게스트" value={d.kpi.overVms.toLocaleString('ko-KR')} accent={d.kpi.overVms ? '#fbbf24' : undefined} meta={`파티션 보고 게스트 ${d.kpi.reported.toLocaleString('ko-KR')}대 중`} />
            <Kpi label={curMode === 'vm' ? '초과 VM 의 판정 파티션' : '초과 파티션'} value={d.kpi.overParts.toLocaleString('ko-KR')} meta={curMode === 'vm' ? 'VM 합계로 판정 — 큰 데이터 디스크가 작은 C: 를 가릴 수 있습니다' : '파티션 하나라도 넘으면 초과'} />
            <Kpi label={`${d.critPct}% 이상`} value={d.kpi.crit} accent={d.kpi.crit ? '#f87171' : undefined} meta={`30일 안에 가득 찰 추세 ${d.kpi.soon}개(목록 안)`} />
            <Kpi label="확인 불가" value={d.kpi.notReported.toLocaleString('ko-KR')} meta={`전원 꺼짐 ${d.kpi.offNotReported} · 나머지는 Tools 미실행·미보고`} />
          </div>
          {d.ignored.total > 0 && (
            <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>
              무시 규칙으로 뺀 파티션 <b>{d.ignored.total}</b>개(Windows {d.ignored.win} · Linux {d.ignored.lnx}) — {d.ignored.byReason.slice(0, 4).map((x) => `${x.text} ${x.count}`).join(' · ')}
              {hasRole('admin') && <> · <a href="#/settings/guest-partition">규칙 바꾸기</a></>}
            </div>
          )}
          <div className="flex gap" style={{ flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
            <b style={{ fontSize: 15 }}>vCenter 별 초과 게스트</b>
            <span className="muted" style={{ fontSize: 12 }}>타일을 누르면 그 vCenter 의 게스트별 전 파티션을 봅니다 · 많은 순</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 8, marginBottom: 14 }}>
            {d.vcenters.map((v) => {
              const L = levelOf(v.maxPct, v.thr ?? defThr);
              return (
                <button key={v.id} type="button" onClick={() => onOpenVc(v.id)} className="card"
                  style={{ textAlign: 'left', cursor: 'pointer', padding: 10, color: 'inherit', font: 'inherit', display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, borderColor: v.overVms ? 'rgba(251,191,36,.45)' : undefined }}
                  title={`${v.name}${v.corp ? ` · ${v.corp}` : ''}\n마지막 수집 ${timeText(v.lastTs, d.offsetMin)}${v.stale ? ' (오래됨)' : ''}${v.site ? '\n엣지 위임 — 엣지가 보낸 값' : ''}`}>
                  <div className="flex gap" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
                    <b style={{ fontSize: 12.5, ...ELL }}>{v.name}</b>
                    <span className="muted" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{v.region || v.corp}</span>
                  </div>
                  <div className="flex gap" style={{ alignItems: 'baseline', gap: 6 }}>
                    <span style={{ fontSize: 22, fontWeight: 700, color: v.overVms ? L.color : 'var(--muted, #94a3b8)', fontVariantNumeric: 'tabular-nums' }}>{v.overVms}</span>
                    <span className="muted" style={{ fontSize: 11.5 }}>대 초과 · 최고 {pctText(v.maxPct)}</span>
                  </div>
                  <div style={{ height: 6, background: 'rgba(148,163,184,.18)', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ width: `${(v.overVms / maxOver) * 100}%`, height: '100%', background: v.overVms ? L.color : 'transparent' }} />
                  </div>
                  <span className="muted" style={{ fontSize: 11 }}>게스트 {v.guests} · 확인 불가 {v.notReported}{v.stale ? ' · 값 오래됨' : ''}{v.thr != null ? ` · 임계 ${v.thr}%` : ''}</span>
                </button>
              );
            })}
            {!d.vcenters.length && <div className="muted" style={{ fontSize: 13 }}>보이는 vCenter 가 없습니다.</div>}
          </div>
          <div className="flex gap" style={{ flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
            <b style={{ fontSize: 15 }}>임계 이상 — {curMode === 'vm' ? 'VM 합계별' : '파티션별'}</b>
            <span className="muted" style={{ fontSize: 12 }}>{d.limited ? `사용률 높은 순 상위 ${d.rows.length}개 · 전체 ${d.total.toLocaleString('ko-KR')}개는 CSV 로 받으세요` : `전체 ${d.total}개`} · 제목을 누르면 정렬</span>
          </div>
          <STable minWidth={1040} limit={showN} style={{ width: '100%' }}>
            <thead>
              <tr><th>게스트(VM)</th><th>vCenter</th><th>OS</th><th>파티션</th><th>할당</th><th>사용</th><th>남은 용량</th><th>사용률</th><th>{d.growthDays}일 증가</th><th>가득 참 예상</th></tr>
            </thead>
            <tbody>
              {d.rows.map((r) => (
                <tr key={`${r.vmId}|${r.path ?? ''}`}>
                  <td style={{ fontWeight: 600, ...ELL, maxWidth: 220 }} title={r.vmName}>{r.vmName}</td>
                  <td className="muted" style={{ ...ELL, maxWidth: 180 }}><button type="button" className="link-btn" style={{ background: 'none', border: 0, padding: 0, color: 'inherit', cursor: 'pointer', textDecoration: 'underline dotted' }} onClick={() => onOpenVc(r.vcenterId)}>{r.vcenterName}</button></td>
                  <td className="muted">{osLabel(r.os)}</td>
                  <td style={{ fontFamily: 'var(--mono, monospace)', ...ELL, maxWidth: 220 }} title={r.path ?? ''}>{r.path ?? `파티션 ${r.partCount}개 합계`}</td>
                  <td data-sort={r.capGB ?? ''}>{gbText(r.capGB)}</td>
                  <td data-sort={r.usedGB ?? ''}>{gbText(r.usedGB)}</td>
                  <td data-sort={r.freeGB ?? ''}>{gbText(r.freeGB)}</td>
                  <td data-sort={r.pct ?? ''} style={{ minWidth: 200 }}><Bar pct={r.pct} thr={r.thr} /></td>
                  <td data-sort={r.growth7dGB ?? ''}>{growthText(r.growth7dGB)}</td>
                  <td data-sort={r.etaDays ?? ''} style={{ color: r.etaDays != null && r.etaDays < 30 ? '#f87171' : undefined, fontWeight: r.etaDays != null && r.etaDays < 30 ? 700 : 400 }}>{etaText(r.etaDays)}</td>
                </tr>
              ))}
              {!d.rows.length && <tr><td colSpan={10} className="muted" style={{ textAlign: 'center', padding: 20 }}>조건에 맞는 게스트가 없습니다 — 임계를 낮추거나 검색어를 지워 보세요.</td></tr>}
            </tbody>
          </STable>
          {d.rows.length > showN && (
            <div className="flex gap" style={{ alignItems: 'center', marginTop: 6 }}>
              <span className="muted" style={{ fontSize: 12 }}>{showN}행을 보여 줍니다(정렬한 뒤 자름) — 남은 {d.rows.length - showN}행</span>
              <button type="button" className="tab" style={SEG} onClick={() => setShowN((n) => n + 100)}>100행 더 보기</button>
              <button type="button" className="tab" style={SEG} onClick={() => setShowN(d.rows.length)}>모두 보기</button>
            </div>
          )}
          <ul className="muted" style={{ fontSize: 12, margin: '12px 0 0', paddingLeft: 18, lineHeight: 1.7 }}>
            {NOTES.map((n) => <li key={n}><BoldText text={n} /></li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

function VcDetail({ vcId, onBack, onPick }) {
  const [thr, setThr] = useState(null);
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState({});
  const [reload, setReload] = useState(0);
  const params = { ...(thr != null ? { thr: String(thr) } : {}), ...(all ? { all: '1' } : {}) };
  const { data, error, stale } = useGet(`/tools/guest-partition/vcenter/${encodeURIComponent(vcId)}`, params, [reload]);
  const list = useGet('/tools/guest-partition', {}, []);
  const d = data || stale;
  const eff = thr ?? d?.effectiveThr ?? 80;
  const vcs = list.data?.vcenters || list.stale?.vcenters || [];
  const maxH = Math.max(1, ...(d?.histogram || []).map((h) => h.count));
  return (
    <div style={{ minWidth: 0 }}>
      <div className="flex gap" style={{ flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        <button type="button" className="tab" style={SEG} onClick={onBack}>← 전체 vCenter</button>
        <label className="flex gap" style={{ alignItems: 'center', gap: 6 }}>
          <span className="muted" style={{ fontSize: 12 }}>vCenter</span>
          <Select sort={false} className="input" value={vcId} onChange={(e) => { setOpen({}); onPick(e.target.value); }} style={{ minWidth: 220 }} aria-label="vCenter 고르기">
            {!vcs.some((v) => v.id === vcId) && <option value={vcId}>{d?.vcenter?.name || vcId}</option>}
            {vcs.map((v) => <option key={v.id} value={v.id}>{v.name}{v.overVms ? ` — 초과 ${v.overVms}` : ''}</option>)}
          </Select>
        </label>
        <div className="flex gap" style={{ alignItems: 'center', gap: 6 }}>
          <span className="muted" style={{ fontSize: 12 }}>임계</span>
          <button type="button" className="tab" style={{ ...SEG, padding: '4px 10px' }} aria-label="임계 1% 낮추기" onClick={() => setThr(Math.max(50, eff - 1))}>−</button>
          <b style={{ color: '#fbbf24', minWidth: 42, textAlign: 'center' }}>{eff}%</b>
          <button type="button" className="tab" style={{ ...SEG, padding: '4px 10px' }} aria-label="임계 1% 올리기" onClick={() => setThr(Math.min(99, eff + 1))}>+</button>
          {thr != null && <button type="button" className="tab" style={SEG} onClick={() => setThr(null)}>기본</button>}
        </div>
        <Seg label="보기" items={[['over', '초과 게스트만'], ['all', '보고한 게스트 전체']]} value={all ? 'all' : 'over'} onPick={(k) => { setOpen({}); setAll(k === 'all'); }} />
        <button type="button" className="tab" style={SEG} onClick={() => setReload((x) => x + 1)}>🔄 새로</button>
      </div>
      {error && <ErrorBox message={error} />}
      {!error && !d && <Loading />}
      {d && (
        <div style={{ opacity: data ? 1 : 0.55 }}>
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>
            {d.vcenter.corp ? `${d.vcenter.corp} · ` : ''}{d.vcenter.site ? '엣지 위임 — 엣지가 보낸 값' : '중앙 직접 수집'} · 마지막 수집 {timeText(d.vcenter.lastTs, d.offsetMin)}
            {d.vcenter.stale && <b style={{ color: '#fb923c' }}> · 값이 오래됐습니다(수집 주기 × 3 초과)</b>}
            {d.vcenter.thr != null && ` · 이 vCenter 의 임계 ${d.vcenter.thr}%`}
          </div>
          {collectNote(d.collect) && <div className="card muted" style={{ fontSize: 13, padding: 10, marginBottom: 10 }}>{collectNote(d.collect)}</div>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginBottom: 10 }}>
            <Kpi label="게스트" value={d.kpi.guests} meta={`파티션 보고 ${d.kpi.reported}대`} />
            <Kpi label="임계 초과 게스트" value={d.kpi.overVms} accent={d.kpi.overVms ? '#fbbf24' : undefined} meta={`초과 파티션 ${d.kpi.overParts}개`} />
            <Kpi label="95% 이상 파티션" value={d.kpi.crit} accent={d.kpi.crit ? '#f87171' : undefined} meta={`남은 용량 합 ${gbText(d.kpi.critFreeGB)}`} />
            <Kpi label="확인 불가" value={d.kpi.notReported} meta={`전원 꺼짐 ${d.kpi.offNotReported} · 값 모름 파티션 ${d.kpi.unknownParts}`} />
          </div>
          <div className="flex gap" style={{ flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
            <div className="card" style={{ flex: '2 1 460px', minWidth: 0, padding: 12 }}>
              <div className="flex gap" style={{ justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap' }}><b style={{ fontSize: 14 }}>사용률 구간별 파티션 수</b><span className="muted" style={{ fontSize: 11.5 }}>무시·값 모름 제외 · 임계 {eff}% 이상 구간을 진하게</span></div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 8, alignItems: 'end', height: 150, marginTop: 8 }}>
                {d.histogram.map((h) => {
                  const hot = h.to > eff;
                  const c = h.from >= 95 ? '#f87171' : h.from >= 90 ? '#fb923c' : h.from >= 80 ? '#fbbf24' : '#38bdf8';
                  return (
                    <div key={h.from} style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center', gap: 3, height: '100%' }}>
                      <span style={{ fontSize: 11.5 }}>{h.count}</span>
                      <div style={{ width: '100%', height: Math.max(2, (h.count / maxH) * 110), background: c, opacity: hot ? 1 : 0.5, borderRadius: '5px 5px 0 0' }} />
                    </div>
                  );
                })}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 8, fontSize: 11, textAlign: 'center', marginTop: 4 }} className="muted">
                {d.histogram.map((h) => <span key={h.from}>{h.from}~{h.to}</span>)}
              </div>
            </div>
            <div className="card" style={{ flex: '1 1 260px', minWidth: 0, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <b style={{ fontSize: 14 }}>클러스터별 초과 게스트</b>
              {d.clusters.slice(0, 8).map((c) => (
                <div key={c.name}>
                  <div className="flex gap" style={{ justifyContent: 'space-between', fontSize: 12.5 }}><span style={ELL}>{c.name}</span><span className="muted">{c.over} / {c.total}대</span></div>
                  <div style={{ height: 6, background: 'rgba(148,163,184,.18)', borderRadius: 3, overflow: 'hidden' }}><div style={{ width: `${c.total ? (c.over / c.total) * 100 : 0}%`, height: '100%', background: '#fbbf24' }} /></div>
                </div>
              ))}
              {!d.clusters.length && <span className="muted" style={{ fontSize: 12 }}>클러스터 정보 없음</span>}
            </div>
          </div>
          <div className="flex gap" style={{ justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', marginBottom: 6 }}>
            <b style={{ fontSize: 15 }}>게스트별 파티션 상세</b>
            <span className="muted" style={{ fontSize: 12 }}>{all ? `보고한 게스트 ${d.total}대` : `초과 게스트 ${d.total}대`}{d.vms.length < d.total ? ` 중 ${d.vms.length}대` : ''} · 누르면 펼칩니다</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {d.vms.slice(0, 300).map((v) => {
              const isOpen = !!open[v.vmId];
              const L = levelOf(d.mode === 'vm' ? v.pct : v.maxPct, eff);
              return (
                <div key={v.vmId} className="card" style={{ padding: 0, minWidth: 0, borderColor: v.over ? 'rgba(251,191,36,.4)' : undefined }}>
                  {/* v2.749.1: 머리 줄은 버튼 안에 버튼을 둘 수 없어 '펼치기' 버튼(이름·파티션 칩)과 '정보'(VM 상세 창 — 공용 VmLink·EntityDetail)를 나란히 둔다. */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', padding: '10px 12px', minWidth: 0 }}>
                    <span style={{ display: 'flex', flexDirection: 'column', minWidth: 160, maxWidth: 320 }}>
                      <button type="button" aria-expanded={isOpen} aria-label={`${v.vmName} 파티션 ${isOpen ? '접기' : '펼치기'}`} onClick={() => setOpen((o) => ({ ...o, [v.vmId]: !o[v.vmId] }))}
                        style={{ all: 'unset', cursor: 'pointer', display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 }}>
                        <span className="muted" style={{ width: 12, flex: 'none' }}>{isOpen ? '▾' : '▸'}</span>
                        <b style={{ fontSize: 13.5, ...ELL }}>{v.vmName}</b>
                      </button>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, paddingLeft: 20 }}>
                        <span className="muted" style={{ fontSize: 11.5, ...ELL }} title={[v.guestOS, v.cluster, v.host].filter(Boolean).join(' · ')}>{[v.guestOS, v.cluster, v.host].filter(Boolean).join(' · ') || '—'}</span>
                        <VmLink vmId={v.vmId} name={v.vmName} vcenterId={vcId} label="정보" className="tab" title="VM 세부 정보(전원·IP·vCPU·RAM·디스크·구성 점검 등)"
                          style={{ flex: 'none', padding: '1px 8px', fontSize: 11.5 }} />
                      </span>
                    </span>
                    <button type="button" tabIndex={-1} aria-hidden="true" onClick={() => setOpen((o) => ({ ...o, [v.vmId]: !o[v.vmId] }))}
                      style={{ all: 'unset', cursor: 'pointer', display: 'flex', flexWrap: 'wrap', gap: 5, flex: '1 1 300px', minWidth: 0 }}>
                      {v.parts.slice(0, 8).map((p) => {
                        const pl = levelOf(p.pct, eff);
                        const hot = p.over && !p.ignored;
                        return <span key={p.path} title={p.ignored ? `무시: ${p.ignoredText}` : ''} style={{ fontSize: 11.5, padding: '1px 7px', borderRadius: 999, border: `1px solid ${hot ? pl.color : 'rgba(148,163,184,.35)'}`, color: p.ignored ? 'var(--muted, #94a3b8)' : hot ? pl.color : undefined, textDecoration: p.ignored ? 'line-through' : 'none' }}>
                          <span style={{ fontFamily: 'var(--mono, monospace)' }}>{p.path}</span> {p.pct == null ? '—' : `${Math.round(p.pct)}%`}
                        </span>;
                      })}
                      {v.parts.length > 8 && <span className="muted" style={{ fontSize: 11.5 }}>외 {v.parts.length - 8}개</span>}
                    </button>
                    <b style={{ color: L.color, minWidth: 90, textAlign: 'right', marginLeft: 'auto' }}>{d.mode === 'vm' ? `합계 ${pctText(v.pct)}` : `최고 ${pctText(v.maxPct)}`}</b>
                  </div>
                  {isOpen && (
                    <div style={{ padding: '0 12px 12px 36px', minWidth: 0 }}>
                      <STable minWidth={760} style={{ width: '100%' }}>
                        <thead><tr><th>파티션</th><th>OS</th><th>할당</th><th>사용</th><th>남은 용량</th><th>사용률</th><th>{d.growthDays}일 증가</th><th>가득 참 예상</th><th>비고</th></tr></thead>
                        <tbody>
                          {v.parts.map((p) => (
                            <tr key={p.path} style={{ opacity: p.ignored ? 0.6 : 1 }}>
                              <td style={{ fontFamily: 'var(--mono, monospace)' }}>{p.path}</td>
                              <td className="muted">{osLabel(p.os)}</td>
                              <td data-sort={p.capGB ?? ''}>{gbText(p.capGB)}</td>
                              <td data-sort={p.usedGB ?? ''}>{gbText(p.usedGB)}</td>
                              <td data-sort={p.freeGB ?? ''}>{gbText(p.freeGB)}</td>
                              <td data-sort={p.pct ?? ''} style={{ minWidth: 190 }}>{p.pct == null ? <span className="muted">여유 공간 미보고</span> : <Bar pct={p.pct} thr={eff} />}</td>
                              <td data-sort={p.growth7dGB ?? ''}>{p.over ? growthText(p.growth7dGB) : '—'}</td>
                              <td data-sort={p.etaDays ?? ''}>{p.over ? etaText(p.etaDays) : '—'}</td>
                              <td className="muted" style={{ fontSize: 12 }}>{p.ignored ? `무시 — ${p.ignoredText}` : ''}</td>
                            </tr>
                          ))}
                        </tbody>
                      </STable>
                    </div>
                  )}
                </div>
              );
            })}
            {!d.vms.length && <div className="card muted" style={{ fontSize: 13, padding: 14 }}>{all ? '파티션을 보고한 게스트가 없습니다.' : '임계를 넘은 게스트가 없습니다.'}</div>}
            {d.vms.length > 300 && <div className="muted" style={{ fontSize: 12 }}>화면에는 300대까지 보여 줍니다 — 나머지는 전체 화면의 CSV 로 받으세요.</div>}
          </div>
        </div>
      )}
    </div>
  );
}

export default function GuestPartTool() {
  const [vc, setVc] = useState(null);
  const head = useMemo(() => (vc ? '특정 vCenter — 게스트별 전 파티션' : '전체 vCenter'), [vc]);
  return (
    <div style={{ minWidth: 0 }}>
      {/* 제목·뒤로 가기는 SpecialTools 셸이 그린다(docs/rules/storage.md — 셸 제목을 다시 넣지 않는다). 범위 선택도 이 화면 안의 vCenter 이동이 맡는다. */}
      <div style={{ marginBottom: 8 }}>
        <div className="muted" style={{ fontSize: 12.5 }}>{head} · VMware Tools 가 보고한 게스트 파일시스템의 할당 대비 사용률 · 수집 주기는 설정 › 수집 서버 › 게스트 파티션 사용률</div>
      </div>
      {vc ? <VcDetail vcId={vc} onBack={() => setVc(null)} onPick={setVc} /> : <Overview onOpenVc={setVc} />}
    </div>
  );
}
