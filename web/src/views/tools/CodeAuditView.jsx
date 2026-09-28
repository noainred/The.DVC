/**
 * 포탈 점검 › **코드 감사**(v2.636) — 전체 소스 감사 결과(아키텍처 리뷰·버그·개선·튜닝 각 10건)를 보여 주고,
 * 발견마다 **그 코드 조각(앵커)이 이 설치본의 소스에 아직 있는지** 를 서버가 확인한 결과를 함께 보인다.
 *
 * 화면 설계 의도(토큰 점검 v2.560 · 아키텍처 점검 v2.614 와 같은 틀):
 *  1. 배너가 '지금 보이는 것이 무엇인가'(감사일·기준 커밋·건수·**목록이지 수정이 아니다**)를 한 번만 말한다.
 *  2. KPI 는 분류 4칸 + 합계 — 합계 = 네 분류의 합(항등식).
 *  3. 분류 탭 · 심각도 필터 · 검색 · '미조치만'. 표는 한 발견이 한 행이고 근거·영향·재현·제안은 **펼쳐서** 본다
 *     (행마다 긴 문장을 두면 같은 문단이 화면을 덮는다 — v2.509). 상세는 표 아래 카드다 — STable 정렬이 tbody 행을 재배열하므로 펼침 행을 표 안에 두지 않는다.
 *  4. 판정(심각도·신뢰도·앵커 상태)은 서버·카탈로그가 소유하고 문구는 `codeAuditText.js` 가 만든다. 이 파일은 조립만 한다.
 *
 * ⚠ **폴링하지 않는다** — 마운트 1회 + 새로고침 버튼(v2.508 V4 규약). 왕복 0(장비·엣지에 나가지 않는다).
 * ⚠ 늦게 온 이전 응답은 버린다(`active`). 표는 `STable minWidth`(v2.575). 문구는 BoldText.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { fetchJson } from '../../api.js';
import { agoText as ago } from './relTime.js';
import { Loading, ErrorBox, Kpi, SearchBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import {
  CATEGORIES, CATEGORY_LABEL, SEVERITY_LABEL, categoryLabel, severityLabel, severityTone, confidenceLabel, confidenceTone,
  anchorState, anchorLabel, anchorTone, anchorNote, statusOf, statusLabel, locationText, kpiOf, kpiMismatchNote,
  bannerText, filterFindings, sortFindings, metaLine, tableFootnotes, emptyText,
} from './codeAuditText.js';

const TONE = Object.freeze({
  green: 'var(--ok, #35c46a)', red: 'var(--bad, #ef5a5a)',
  amber: 'var(--warn, #e8b23a)', gray: 'var(--muted)',
});

function Badge({ text, tone, title }) {
  return <span title={title} style={{ color: TONE[tone] || TONE.gray, fontWeight: 600, whiteSpace: 'nowrap' }}>{text}</span>;
}

/** 펼친 상세 — 근거·영향·재현·제안·참조. 재현은 <pre>(백틱·명령 그대로). */
function Detail({ f, source }) {
  const row = (label, body, pre = false) => (body ? (
    <div style={{ display: 'grid', gridTemplateColumns: '64px minmax(0, 1fr)', gap: 8, alignItems: 'start' }}>
      <div style={{ color: 'var(--muted)', fontSize: 11, paddingTop: 2 }}>{label}</div>
      {pre
        ? <pre style={{ margin: 0, fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 260, overflow: 'auto', background: 'rgba(0,0,0,0.18)', padding: 6, borderRadius: 4 }}>{body}</pre>
        : <div style={{ fontSize: 12, lineHeight: 1.6, whiteSpace: 'normal', overflowWrap: 'anywhere' }}><BoldText text={body} /></div>}
    </div>
  ) : null);
  return (
    <div style={{ display: 'grid', gap: 6, padding: '4px 0 6px' }}>
      {row('근거', f.evidence)}
      {row('영향', f.impact)}
      {row('재현', f.repro, true)}
      {row('제안', f.fix)}
      {row('참조', f.prior)}
      {Array.isArray(f.also) && f.also.length > 0 && row('함께', f.also.join(' · '))}
      {row('앵커', `${anchorLabel(f)} — ${anchorNote(f, source)} 조각: ‘${String(f.anchor || '')}’`)}
    </div>
  );
}

export function CodeAuditView() {
  // ⚠ 훅은 전부 조기 return 위에(조기 반환 뒤 훅 추가는 React #310 크래시 — v2.202 실제 사고).
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [category, setCategory] = useState('all');
  const [severity, setSeverity] = useState('all');
  const [q, setQ] = useState('');
  const [onlyOpen, setOnlyOpen] = useState(false);
  const [selected, setSelected] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    (async () => {
      try {
        const r = await fetchJson('/tools/portal-check/code-audit');
        if (!active) return;
        setData(r); setError('');
      } catch (e) {
        if (!active) return;
        setError(e?.message || String(e));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [reloadKey]);

  const all = useMemo(() => sortFindings(data?.findings), [data]);
  const rows = useMemo(() => filterFindings(all, { category, severity, q, onlyOpen }), [all, category, severity, q, onlyOpen]);
  const kpi = useMemo(() => kpiOf(all), [all]);
  const kpiNote = useMemo(() => kpiMismatchNote(data?.kpi, all), [data, all]);
  const banner = useMemo(() => bannerText(data), [data]);
  const meta = useMemo(() => metaLine(data, ago), [data]);
  const foot = useMemo(() => tableFootnotes(rows, data?.source), [rows, data]);

  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox error={error} />;

  const sel = selected ? all.find((f) => String(f?.id ?? '') === selected) : null;
  const catBtn = (k, label) => (
    <button key={k} className="btn" onClick={() => setCategory(k)}
      style={category === k ? { background: 'var(--accent, #2b6cb0)', color: '#fff' } : undefined}>
      {label}{k !== 'all' ? ` ${kpi.byCategory[k] ?? 0}` : ` ${kpi.total}`}
    </button>
  );

  return (
    <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'minmax(0, 1fr)', minWidth: 0 }}>
      {error && <div className="banner">{error}</div>}

      {/* 배너 — 긴 설명은 여기 한 번만(v2.509) */}
      <div className="card" style={{ borderLeft: `3px solid ${TONE[banner.tone] || TONE.gray}` }}>
        <div style={{ fontSize: 12, lineHeight: 1.6 }}><BoldText text={banner.text} /></div>
        {meta && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{meta}</div>}
      </div>

      {/* ⚠ 합계 = 네 분류의 합 — 항등식 */}
      <div className="kpis">
        <Kpi label="발견 합계" value={data ? kpi.total : '—'} meta={data ? `미조치 ${kpi.open} · 고침 ${kpi.fixed}` : undefined} />
        {CATEGORIES.map((c) => <Kpi key={c} label={CATEGORY_LABEL[c]} value={data ? kpi.byCategory[c] : '—'} />)}
        <Kpi label="심각도 높음" value={data ? kpi.bySeverity.high : '—'} meta={data ? `중간 ${kpi.bySeverity.medium} · 낮음 ${kpi.bySeverity.low}` : undefined} />
      </div>
      {kpiNote && <div className="card" style={{ fontSize: 12 }}><BoldText text={kpiNote} /></div>}

      <div className="card" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {catBtn('all', '전체')}
        {CATEGORIES.map((c) => catBtn(c, CATEGORY_LABEL[c]))}
        <select className="input" value={severity} onChange={(e) => setSeverity(e.target.value)} style={{ padding: '3px 6px', fontSize: 12 }}>
          <option value="all">심각도 전체</option>
          {Object.keys(SEVERITY_LABEL).map((s) => <option key={s} value={s}>{SEVERITY_LABEL[s]}</option>)}
        </select>
        <label style={{ fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' }}>
          <input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} /> 미조치만
        </label>
        <SearchBox value={q} onChange={setQ} placeholder="id · 제목 · 파일 · 근거 검색" />
        <button className="btn" onClick={() => setReloadKey((k) => k + 1)} disabled={loading}>{loading ? '확인 중…' : '앵커 다시 확인'}</button>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>장비·엣지에 나가지 않습니다 — 이 서버의 소스 파일만 읽습니다.</span>
      </div>

      <div className="card" style={{ display: 'grid', gap: 6 }}>
        <div style={{ fontWeight: 600 }}>
          발견 {rows.length}건{rows.length !== all.length ? ` (전체 ${all.length}건 중)` : ''}
        </div>
        <STable className="v3-table" minWidth={960}>
          <thead>
            <tr>
              <th>분류</th><th className="right">순위</th><th>심각도</th><th>신뢰도</th><th>제목</th><th>위치</th><th>앵커</th><th>상태</th><th data-nosort>상세</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((f) => {
              const id = String(f?.id ?? '');
              const isSel = id === selected;
              return (
                <tr key={id} style={isSel ? { outline: '1px solid var(--accent, #2b6cb0)' } : undefined}>
                  <td data-sort={CATEGORIES.indexOf(f.category)}>{categoryLabel(f.category)}</td>
                  <td className="right tabular">{f.rank ?? '—'}</td>
                  <td data-sort={f.severity}><Badge text={severityLabel(f.severity)} tone={severityTone(f.severity)} /></td>
                  <td data-sort={f.confidence}><Badge text={confidenceLabel(f.confidence)} tone={confidenceTone(f.confidence)} title={f.repro ? '재현 명령·출력은 상세에 있습니다' : undefined} /></td>
                  <td style={{ whiteSpace: 'normal', minWidth: 220 }}>
                    <div>{f.title}</div>
                    <div style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--muted)' }}>{id}</div>
                  </td>
                  <td style={{ fontFamily: 'monospace', fontSize: 11, whiteSpace: 'normal', wordBreak: 'break-all', minWidth: 180 }}>{locationText(f)}</td>
                  <td data-sort={anchorState(f)}><Badge text={anchorLabel(f)} tone={anchorTone(f)} title={anchorNote(f, data?.source)} /></td>
                  <td data-sort={statusOf(f)}>{statusLabel(f)}</td>
                  <td>
                    <button type="button" className="btn" style={{ fontSize: 11, padding: '1px 6px' }} onClick={() => setSelected(isSel ? '' : id)}>{isSel ? '닫기' : '상세'}</button>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr><td colSpan={9} style={{ color: 'var(--muted)', whiteSpace: 'normal' }}>{emptyText({ total: all.length, shown: rows.length })}</td></tr>
            )}
          </tbody>
        </STable>
        {foot.length > 0 && (
          <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.7, display: 'grid', gap: 2 }}>
            {foot.map((s, i) => <div key={i}><BoldText text={s} /></div>)}
          </div>
        )}
      </div>

      {/* 상세 — 표 행이 아니라 아래 카드(표 정렬이 행을 재배열하므로 펼침 행을 표 안에 두지 않는다) */}
      {sel && (
        <div className="card" style={{ display: 'grid', gap: 6, borderLeft: `3px solid ${TONE[severityTone(sel.severity)] || TONE.gray}` }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <b style={{ fontSize: 13, overflowWrap: 'anywhere' }}>{sel.id} — {sel.title}</b>
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>{categoryLabel(sel.category)} · 순위 {sel.rank ?? '—'} · </span>
            <Badge text={severityLabel(sel.severity)} tone={severityTone(sel.severity)} />
            <Badge text={confidenceLabel(sel.confidence)} tone={confidenceTone(sel.confidence)} />
            <span style={{ fontSize: 11 }}>{statusLabel(sel)}</span>
            <button type="button" className="btn" style={{ fontSize: 11, padding: '1px 6px', marginLeft: 'auto' }} onClick={() => setSelected('')}>닫기</button>
          </div>
          <div style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--muted)', overflowWrap: 'anywhere' }}>{locationText(sel)}</div>
          <Detail f={sel} source={data?.source} />
        </div>
      )}
    </div>
  );
}

export default CodeAuditView;
