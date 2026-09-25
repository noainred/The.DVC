/**
 * 포탈 점검 › **아키텍처 점검**(v2.614) — 이 서버가 자기 라우트·게이트·카탈로그·엣지 로그 표·
 * BIG_JSON·DB 파일·설정 파일 분류·import 그래프의 정합을 스스로 본다.
 *
 * 화면 설계 의도(토큰 점검 v2.560 · 인벤토리 점검 v2.570 과 같은 틀):
 *  1. 배너가 '지금 보이는 것이 무엇인가' 를 **한 번만** 말한다.
 *  2. KPI 다섯 칸은 **겹치지 않는다** — 합계 = 정상 + 경고 + 결함 + 확인 불가.
 *     ⚠ 확인 불가는 회색이고 정상에 절대 넣지 않는다(카탈로그를 못 읽었으면 그 항목들이 여기다).
 *  3. 표는 항목 하나가 한 행 — 상태 배지 · 항목 · 개수 · 표본(3개 + '외 N', 펼치기) · 조치.
 *  4. 판정은 서버(`portalcheck/archScan.js`)가 소유하고 문구는 `archCheckText.js` 가 만든다.
 *     이 파일은 조립만 한다.
 *
 * ⚠ **폴링하지 않는다** — 마운트 1회 + 버튼(v2.508 V4 규약). GET 은 memoJson 캐시, POST run 은
 *   즉시 재판정. 둘 다 왕복 0(장비·엣지에 나가지 않는다)이지만 라우터 스택·파일 시스템을 훑는다.
 * ⚠ **늦게 온 이전 응답은 버린다**(v2.596 WS 규약) — `active` 플래그.
 * ⚠ 표는 `STable minWidth`(래퍼까지 함께 만든다 — v2.575 규약).
 * ⚠ 문구는 **BoldText** 로 렌더한다(`**강조**` 가 별표로 새는 사고 — v2.439·2.440·2.505·2.545).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { fetchJson, postJson } from '../../api.js';
import { agoText as ago } from './relTime.js';
import { Loading, ErrorBox, Kpi } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import {
  itemState, stateLabel, stateTone, itemTitle, kpiOf, kpiMismatchNote, catalogNote, bannerText,
  countText, samplesView, emptySamplesText, fixText, meaningText, sortItems, metaLine, runSummary,
} from './archCheckText.js';

const TONE = Object.freeze({
  green: 'var(--ok, #35c46a)', red: 'var(--bad, #ef5a5a)',
  amber: 'var(--warn, #e8b23a)', gray: 'var(--muted)',
});

function Badge({ text, tone }) {
  return <span style={{ color: TONE[tone] || TONE.gray, fontWeight: 600, whiteSpace: 'nowrap' }}>{text}</span>;
}

/** 표본 칸 — 3개까지 펼치고 '외 N' + 토글. 서버가 상한으로 뺀 것은 펼쳐도 없다(문구가 말한다). */
function SamplesCell({ item, expanded, onToggle }) {
  const v = samplesView(item, { max: 3, expanded });
  if (!v.shown.length && !v.omitted) {
    return <span style={{ color: 'var(--muted)' }}>{emptySamplesText(item)}</span>;
  }
  const canToggle = (Array.isArray(item?.samples) ? item.samples.length : 0) > 3;
  return (
    <div style={{ display: 'grid', gap: 2, fontFamily: 'monospace', fontSize: 11, whiteSpace: 'normal', wordBreak: 'break-all' }}>
      {v.shown.map((s, i) => <div key={`${s}-${i}`}>{s}</div>)}
      {(v.moreText || canToggle) && (
        <div style={{ fontFamily: 'inherit', fontSize: 11, color: 'var(--muted)', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {v.moreText && <span>{v.moreText}</span>}
          {canToggle && (
            <button type="button" className="btn" style={{ fontSize: 11, padding: '1px 6px' }} onClick={onToggle}>
              {expanded ? '접기' : '표본 전체 보기'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function ArchCheckView() {
  // ⚠ 훅은 전부 조기 return 위에(조기 반환 뒤 훅 추가는 React #310 크래시 — v2.202 실제 사고).
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [expanded, setExpanded] = useState(() => new Set());
  const [onlyBad, setOnlyBad] = useState(false);

  useEffect(() => {
    // 마운트 1회. 언마운트 뒤 도착한 응답은 버린다.
    let active = true;
    (async () => {
      try {
        const r = await fetchJson('/tools/portal-check/arch');
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
  }, []);

  const items = useMemo(() => {
    const all = sortItems(data?.items);
    return onlyBad ? all.filter((it) => itemState(it) !== 'ok') : all;
  }, [data, onlyBad]);

  const kpi = useMemo(() => kpiOf(data?.items), [data]);
  const kpiNote = useMemo(() => kpiMismatchNote(data?.kpi, data?.items), [data]);
  const banner = useMemo(() => bannerText(data), [data]);
  const catNote = useMemo(() => catalogNote(data?.catalog, data?.items), [data]);
  const meta = useMemo(() => metaLine(data, ago), [data]);

  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox error={error} />;

  const run = async () => {
    setBusy(true);
    try {
      const r = await postJson('/tools/portal-check/arch/run', {});
      setNote(runSummary(r));
      // 응답 모양은 GET 과 같다(spec) — 통째로 바꾼다. 이전 표본 펼침 상태는 초기화.
      if (r && Array.isArray(r.items)) { setData(r); setError(''); setExpanded(new Set()); }
    } catch (e) { setNote(`지금 점검 실패: ${e?.message || e}`); }
    finally { setBusy(false); }
  };

  const toggle = (code) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(code)) next.delete(code); else next.add(code);
    return next;
  });

  const total = Array.isArray(data?.items) ? data.items.length : 0;

  return (
    <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'minmax(0, 1fr)', minWidth: 0 }}>
      {error && <div className="banner">{error}</div>}

      {/* 배너 — 긴 설명은 여기 한 번만(v2.509) */}
      <div className="card" style={{ borderLeft: `3px solid ${TONE[banner.tone] || TONE.gray}` }}>
        <div style={{ fontSize: 12, lineHeight: 1.6 }}><BoldText text={banner.text} /></div>
        {meta && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{meta}</div>}
      </div>

      {/* 카탈로그 — 못 읽었으면 초록 금지(카탈로그 의존 항목이 확인 불가다) */}
      {catNote && (
        <div className="card" style={{ borderLeft: `3px solid ${TONE[catNote.tone] || TONE.gray}`, fontSize: 12, lineHeight: 1.6 }}>
          <BoldText text={catNote.text} />
        </div>
      )}

      {/* ⚠ 다섯 칸이 겹치지 않는다 — 합계 = 정상 + 경고 + 결함 + 확인 불가. 확인 불가는 정상이 아니다. */}
      <div className="kpis">
        <Kpi label="점검 항목" value={data ? kpi.total : '—'} />
        <Kpi label="정상" value={data ? kpi.ok : '—'} />
        <Kpi label="경고" value={data ? kpi.warn : '—'} />
        <Kpi label="결함" value={data ? kpi.fault : '—'} />
        <Kpi label="확인 불가" value={data ? kpi.unknown : '—'} meta={kpi.unknown > 0 ? '정상이 아니라 못 읽은 것' : undefined} />
      </div>
      {kpiNote && <div className="card" style={{ fontSize: 12 }}><BoldText text={kpiNote} /></div>}

      <div className="card" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="btn" onClick={run} disabled={busy}>{busy ? '점검 중…' : '지금 점검'}</button>
        <label style={{ fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' }}>
          <input type="checkbox" checked={onlyBad} onChange={(e) => setOnlyBad(e.target.checked)} /> 정상 아닌 것만
        </label>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>
          장비·엣지에 나가지 않습니다 — 이 서버의 라우트·카탈로그·파일만 봅니다. ‘지금 점검’ 은 캐시를 건너뛰고 다시 판정합니다.
        </span>
      </div>

      {note && <div className="card" style={{ fontSize: 12 }}><BoldText text={note} /></div>}

      {/* 항목 표 — 나쁜 것이 위 */}
      <div className="card" style={{ display: 'grid', gap: 6 }}>
        <div style={{ fontWeight: 600 }}>
          점검 항목 {items.length}개{items.length !== total ? ` (전체 ${total}개 중)` : ''}
        </div>
        <STable className="v3-table" minWidth={900}>
          <thead>
            <tr>
              <th>상태</th><th>항목</th><th className="right">개수</th><th data-nosort>표본</th><th data-nosort>조치</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => {
              const st = itemState(it);
              const code = String(it?.code ?? '');
              return (
                <tr key={code}>
                  <td data-sort={st}><Badge text={stateLabel(st)} tone={stateTone(st)} /></td>
                  <td style={{ whiteSpace: 'normal', minWidth: 200 }} title={meaningText(it)}>
                    <div>{itemTitle(it)}</div>
                    <div style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--muted)' }}>{code}</div>
                  </td>
                  <td className="right tabular" data-sort={st === 'unknown' ? -1 : (it?.count ?? -1)}>{countText(it)}</td>
                  <td style={{ whiteSpace: 'normal', minWidth: 220, maxWidth: 360 }}>
                    <SamplesCell item={it} expanded={expanded.has(code)} onToggle={() => toggle(code)} />
                  </td>
                  {/* ⚠ 조치는 문장이라 길다 — whiteSpace:'normal' 이 없으면 오른쪽에서 잘린다(v2.513). */}
                  <td style={{ whiteSpace: 'normal', fontSize: 12, lineHeight: 1.6, minWidth: 260 }}><BoldText text={fixText(it, data)} /></td>
                </tr>
              );
            })}
            {items.length === 0 && (
              <tr><td colSpan={5} style={{ color: 'var(--muted)', whiteSpace: 'normal' }}>
                {total === 0 ? '점검 항목이 없습니다 — 서버가 항목을 내려 주지 않았습니다.' : '정상 아닌 항목이 없습니다 — 필터를 지우면 전체가 보입니다.'}
              </td></tr>
            )}
          </tbody>
        </STable>
        <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.7 }}>
          <BoldText text="각 항목의 뜻은 항목 이름에 마우스를 올리면 보입니다. 표본은 서버가 상한까지만 싣고 뺀 개수를 함께 말합니다. **확인 불가**는 입력을 읽지 못해 판정하지 않은 것이라 정상에도 결함에도 세지 않습니다." />
        </div>
      </div>

      {/* 입력 오류 — 확인 불가의 근거 */}
      {Array.isArray(data?.inputs?.errors) && data.inputs.errors.length > 0 && (
        <div className="card" style={{ display: 'grid', gap: 6 }}>
          <div style={{ fontWeight: 600 }}>읽지 못한 입력 {data.inputs.errors.length}건</div>
          <STable className="v3-table" minWidth={520}>
            <thead><tr><th>항목</th><th data-nosort>사유</th></tr></thead>
            <tbody>
              {data.inputs.errors.map((e, i) => (
                <tr key={`${e?.code || ''}-${i}`}>
                  <td style={{ fontFamily: 'monospace', fontSize: 11 }}>{String(e?.code ?? '') || '—'}</td>
                  <td style={{ whiteSpace: 'normal', fontSize: 12 }}>{String(e?.message ?? '') || '(사유 없음)'}</td>
                </tr>
              ))}
            </tbody>
          </STable>
        </div>
      )}
    </div>
  );
}

export default ArchCheckView;
