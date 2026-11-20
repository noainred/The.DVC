/**
 * 리눅스 베어메탈 통합 성능 — **함대 보드**(2단계 화면 · 설계 `docs/design/linux-bm-perf/README.md` §5 ①).
 *
 * 신뢰 띠 → KPI → USE 매트릭스(서버 × 자원 5 × U·S·E + 경로 · 판정 한 줄) → 병목 Top.
 * ⚠ 이 파일은 **조립만** 한다 — 칸 색 · 각주 · 상태 문구 · 수는 `bmPerfText.js`(순수 · vitest)가, 판정은 서버(`useJudge.js`)가 소유한다.
 * ⚠ 표는 `STable`(머리글 클릭 정렬 · ‘—’ 는 늘 뒤) + `minWidth`(가로 스크롤 박스를 컴포넌트가 함께 만든다).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { fetchJson } from '../../api.js';
import { capacityKpi } from './bmCapacityText.js'; // 8a단계 보드 KPI
import { Kpi } from '../../components/ui.jsx';
import { BoardOpsStrip } from './BmPerfOpsParts.jsx'; // v2.929(5단계): ‘집중 n 건 진행 중’ · ‘소모품 주의 n대’
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import { toneVar } from './toneVar.js';
import { refOf } from './bmPerfUrl.js'; // 다음 점검 ①: 서버 = (법인, 키) 쌍
import {
  RES_ORDER, RES_LABEL, USE_KEYS, HW_USE_LABEL, U_COL, cellView, cellFootnotes, codesUsed, verdictView, coverageView,
  rowStates, STATE_TEXT, cellCode, NO_ENTRY_CELL, NO_ENTRY_FOOTNOTE, trustCounts, trustBandParts, kpiCounts, byResText, topBottlenecks, severityOrder, crossBandText,
  thresholdText, mismatchText,
} from './bmPerfText.js';

const LIMIT = 50;

/**
 * 칸 하나 — 판정된 칸만 색, 나머지는 ‘—’ + 각주 기호. 항목이 없는 행(entry null)은 기호 없는 ‘—’(NO_ENTRY_CELL).
 * ⚠⚠(2단계 반증 D1) **컴포넌트가 아니라 `<td>` 를 돌려주는 함수**다 — STable 정렬(sortableText.cellText)은 행의 자식 중 td/th 만 셀로 센다.
 *   `<PerfCell/>` 컴포넌트로 넣으면 15칸이 셀에서 빠져 열 클릭이 엉뚱한 열(판정)로 정렬되거나 아무 일도 하지 않았다.
 */
export function perfCell({ key, code, value = null, unit = '', extra = '', noEntry = false }) {
  const v = noEntry ? NO_ENTRY_CELL : cellView(code, { value, unit });
  return (
    <td key={key} className="right bmp-cell" data-sort={v.sort} title={v.title + (extra ? ` · ${extra}` : '')}>
      <span style={{ color: v.judged ? toneVar(v.tone) : 'var(--text-faint)' }}>{v.text}</span>
      {v.mark && <sup className="bmp-mark">{v.mark}</sup>}
      {extra && <sup className="bmp-mark" style={{ color: toneVar('warn') }}>≠</sup>}
    </td>
  );
}

export function VerdictBadge({ verdict }) {
  const v = verdictView(verdict);
  return <span className="bmp-badge" style={{ color: toneVar(v.tone), borderColor: toneVar(v.tone) }}>{v.label}</span>;
}

/**
 * 매트릭스 행들(tr 배열) — 보드와 정렬 회귀 테스트가 같은 함수를 쓴다(테스트는 이 결과에 실제 sortChildren 을 건다).
 * 열 순서(마지막 머리글 줄): 0 서버 · 1 경로 · 2~16 자원 5 × U·S·E · 17 판정.
 */
export function matrixRows(items = [], { authStops = [], staleMs = null, now = Date.now(), th = null, selKey = '', open = () => {}, cmpKeys = null, onPickCmp = null } = {}) {
  const keyOpen = (key, vc) => (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(key, vc); } };
  return items.map((it) => {
    const ref = refOf(it.key, it.vcenterId);   // 다음 점검 ①: 서버 = (법인, 키) 쌍
    const e = it.entry;
    const cov = coverageView(e?.coverage);
    const states = rowStates(e, it.target, { authStops, snapAt: it.snapAt, staleMs, now, off: !!it.off });
    const mm = e?.mismatch?.cpu?.flag ? mismatchText(e.mismatch, it.th || th) : '';
    return (
      <tr key={`${it.agent}|${ref}`} data-key={it.key} style={{ background: selKey === ref ? 'rgba(103,232,249,0.06)' : undefined }}>
        <td data-sort={it.name}>
          {/* 6단계: 비교에 담기(체크 — 서버 칸 안에 둔다: 열을 늘리면 정렬 열 번호가 밀린다) */}
          {onPickCmp && <input type="checkbox" className="bmcmp-pick" aria-label={`${it.name} 비교에 담기`} checked={!!cmpKeys?.includes(ref)} onChange={() => onPickCmp(ref)} />}
          <span role="button" tabIndex={0} className="bmp-link" onClick={() => open(it.key, it.vcenterId)} onKeyDown={keyOpen(it.key, it.vcenterId)}>{it.name}</span>
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>{it.vcenterId || '귀속 없음'}{it.agent ? ` · 엣지 ${it.agent}` : ''}</div>
        </td>
        <td data-sort={e ? cov.short : ''}>
          <span style={{ fontSize: 12, color: e ? toneVar(cov.tone) : 'var(--muted)', whiteSpace: 'nowrap' }}>{e ? cov.short : '—'}</span>
          <StateChips states={states.filter((s) => !['osOnly', 'idracOnly', 'noneRead', 'noPath'].includes(s))} />
        </td>
        {RES_ORDER.flatMap((r) => USE_KEYS.map((u) => perfCell({
          key: `${r}${u}`, code: e ? cellCode(e, r, u) : 'missing', noEntry: !e,
          value: u === 'U' && U_COL[r] ? it.row?.[U_COL[r]] : null, unit: u === 'U' && U_COL[r] ? '%' : '',
          extra: r === 'cpu' && u === 'U' && mm ? mm : '',
        })))}
        <td className="bmp-line" data-sort={e ? verdictView(e.verdict).rank : ''}>
          {e && <><VerdictBadge verdict={e.verdict} />{' '}</>}
          {e?.line || <span style={{ color: 'var(--muted)' }}>판정 항목 없음 — 아직 표본이 없습니다</span>}
        </td>
      </tr>
    );
  });
}

export function StateChips({ states = [] }) {
  if (!states.length) return null;
  return (
    <span className="bmp-chips">
      {states.map((s) => {
        const st = STATE_TEXT[s];
        return st ? <span key={s} className="bmp-chip" style={{ color: toneVar(st.tone) }} title={st.title}>{st.short}</span> : null;
      })}
    </span>
  );
}

/** 8a단계 — 용량 예측 요약(보드를 열 때 1회 · 폴링 없음). 못 읽음 · 아직 계산 전은 ‘—’(0 이 아니다). */
function useCapacityKpi() {
  const [st, setSt] = useState({ value: '—', meta: '읽는 중…', soon: 0 });
  useEffect(() => {
    let live = true;
    fetchJson('/tools/bm-usage/capacity', {}, undefined, { timeoutMs: 60_000 })
      .then((r) => { if (live) setSt(capacityKpi(r)); })
      .catch(() => { if (live) setSt({ value: '—', meta: '용량 예측을 읽지 못했습니다', soon: 0 }); });
    return () => { live = false; };
  }, []);
  return st;
}
export default function BmPerfBoard({ items = [], th = null, intervalMs = null, authStops = [], staleMs = null, onOpen, selKey = '', perfError = '', corpOff = 0, now: nowProp = null, cmpKeys = null, onPickCmp = null, onCompare = null, cmpMsg = '' }) {
  const [all, setAll] = useState(false);
  const now = nowProp ?? Date.now();
  const ordered = useMemo(() => severityOrder(items), [items]);
  const tc = useMemo(() => trustCounts(items, { authStops, staleMs, now }), [items, authStops, staleMs, now]);
  const k = useMemo(() => kpiCounts(items), [items]);
  const cap = useCapacityKpi();
  const top = useMemo(() => topBottlenecks(items, 5), [items]);
  const foot = useMemo(() => cellFootnotes(codesUsed(items.map((it) => it.entry).filter(Boolean))), [items]);
  // 다음 점검 ①: 여는 서버 = (법인, 키) 쌍 — onOpen(키, 탭, 법인)
  const open = (key, vc = '') => onOpen && onOpen(key, '', vc);
  const open2 = (key, tab, vc = '') => onOpen && onOpen(key, tab, vc);   // v2.929: 함대 표에서 상세의 그 탭으로(집중 · 요약)
  const keyOpen = (key, vc = '') => (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(key, vc); } };
  const thLine = th ? [['사용률', 'cpu_pct'], ['런큐/코어', 'runq_per_core'], ['대기열', 'disk_aqu'], ['PSI full', 'psi_io_full10']]
    .map(([l, kk]) => { const s = thresholdText(kk, th); return s ? `${l} ${s}` : ''; }).filter(Boolean).join(' · ') : '';

  return (
    <>
      {/* ── 신뢰 띠 — ‘이 판정을 믿어도 되는가’ ── */}
      <div className="card bmp-band" style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, lineHeight: 1.7, display: 'flex', flexWrap: 'wrap', columnGap: 14, rowGap: 2 }}>
          {trustBandParts(tc, { intervalMs, corpOff }).map((p, i) => <span key={i} style={{ minWidth: 0 }}><BoldText text={p} /></span>)}
        </div>
        {/* 꺼짐(상태 9종 ①) — 보이는 서버 중 수집이 꺼진 노드의 것이 있으면 한 번 말한다(행에는 ‘꺼짐’ 칩). */}
        {tc.off > 0 && (
          <div className="bmp-state" style={{ borderLeftColor: toneVar(STATE_TEXT.off.tone), marginTop: 6 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{STATE_TEXT.off.title}</div>
            <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--text-dim)' }}><BoldText text={STATE_TEXT.off.body} /></div>
          </div>
        )}
        {perfError && <p style={{ margin: '6px 0 0', fontSize: 12, color: toneVar('bad'), lineHeight: 1.6 }}>성능 판정을 만들지 못했습니다: {perfError}</p>}
      </div>

      <div className="kpis">
        <Kpi label="두 경로 다 읽힘" value={k.both} unit={`/ ${k.total}`} meta="교차 판정 가능" />
        <Kpi label="병목 의심" value={k.bottleneck} meta="한 자원 두 칸 이상 초과" accent={k.bottleneck ? toneVar('bad') : undefined} />
        <Kpi label="포화" value={k.saturated} meta={byResText(k.satByRes) ? `S 초과 칸 ${byResText(k.satByRes)}` : 'S 초과 칸 없음'} title="포화 = 판정이 ‘포화’ 인 서버 수(병목 서버는 병목에서 셉니다) · 아래 줄은 S 칸이 초과인 자원별 서버 수(병목 서버 포함)" accent={k.saturated ? toneVar('bad') : undefined} />
        <Kpi label="오류" value={k.errors} meta={byResText(k.errByRes) ? `E 초과 칸 ${byResText(k.errByRes)}` : 'E 초과 칸 없음'} accent={k.errors ? toneVar('bad') : undefined} />
        <Kpi label="정상" value={k.ok} meta={`주의 ${k.warn}`} />
        <Kpi label="판정 보류" value={k.held} meta="못 읽음 · 오래됨 등" title="판정 보류 — 판정 불가 · 오래됨 · 대부분 못 읽음 · 표본 없음" />
        {/* 8a단계: 보드 KPI ‘30일 안 소진 n대’(용량 예측 — 수집 노드의 하루 계산 결과 · 보드를 열 때 1회) */}
        <Kpi label="30일 안 소진(참고)" value={cap.value} unit={cap.value === '—' ? '' : '대'} meta={cap.meta} title="용량 소진 예측 — 목표선 도달이 30일 안인 서버 수(데이터 부족 · 불안정은 세지 않고 따로) · 함대 ‘용량 예측’ 보기에서 자세히" accent={cap.soon ? toneVar('bad') : undefined} />
      </div>
      <BoardOpsStrip items={items} onOpen={open2} now={now} />

      {/* ── USE 매트릭스 ── */}
      <div className="card" style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline', marginBottom: 6 }}>
          <h4 style={{ margin: 0 }}>USE 매트릭스</h4>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>자원 5 × 사용률(U) · 포화(S) · 오류(E) · 심각도 순 · 머리글을 누르면 정렬</span>
        </div>
        {onPickCmp && (
          <div className="bmcmp-tray" style={{ marginBottom: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>서버 칸의 체크로 비교에 담습니다 — 담은 서버 {cmpKeys?.length || 0}대</span>
            {onCompare && <button type="button" className="btn btn-sm bmp-touch" disabled={(cmpKeys?.length || 0) < 2} onClick={() => onCompare(cmpKeys)}>비교 보기</button>}
            {cmpMsg && <span style={{ fontSize: 12, color: toneVar('warn') }}>{cmpMsg}</span>}
          </div>
        )}
        {!items.length ? (
          <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>표시할 서버가 없습니다.</p>
        ) : (
          <STable className="bmp-matrix" minWidth={1060} limit={all ? 0 : LIMIT}>
            <thead>
              <tr>
                <th colSpan={2} />
                {RES_ORDER.map((r) => <th key={r} colSpan={3} className="bmp-grp">{RES_LABEL[r]}{r === 'hw' ? '(iDRAC)' : ''}</th>)}
                <th />
              </tr>
              <tr>
                <th>서버 · 법인</th><th>경로</th>
                {RES_ORDER.map((r) => USE_KEYS.map((u) => <th key={`${r}${u}`} className="right bmp-ue" title={r === 'hw' ? HW_USE_LABEL[u] : u}>{r === 'hw' ? HW_USE_LABEL[u] : u}</th>))}
                <th>판정 · 판정 한 줄</th>
              </tr>
            </thead>
            <tbody>
              {matrixRows(ordered, { authStops, staleMs, now, th, selKey, open, cmpKeys, onPickCmp })}
            </tbody>
          </STable>
        )}
        {items.length > LIMIT && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>
              {all ? `${items.length}대 전부를 보여 줍니다.` : `상위 ${LIMIT}대만 보여 줍니다(정렬한 뒤 자름) — 나머지 ${items.length - LIMIT}대는 ‘모두 보기’ 또는 사용률 표에서.`}
            </span>
            <button className="btn btn-sm bmp-touch" onClick={() => setAll((v) => !v)}>{all ? '상위만 보기' : '모두 보기'}</button>
          </div>
        )}
        <p style={{ margin: '8px 0 0', fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}>
          <BoldText text={'U 칸의 숫자는 그 칸의 유일한 입력(사용률 — 가장 높은 장치·회선 기준)이고, S·E 칸은 여러 입력 중 **가장 나쁜 것**이라 낱말(정상 · 주의 · 초과)로만 적습니다. 근거 값은 서버를 눌러 상세에서 봅니다. 하드웨어 축은 iDRAC — 전력(cap 대비) · 온도(흡기) · 부품(부품 장애 · SEL). OS 의 OOM 과 iDRAC 의 DIMM 은 합산하지 않고 같은 칸의 입력으로 나란히 둡니다. 칸 색과 판정 한 줄은 **서버가 판정한 그대로**입니다.'} />
        </p>
        {thLine && <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}>판정 기준(설정값 — API): {thLine}</p>}
        {items.some((it) => !it.entry) && <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}><BoldText text={NO_ENTRY_FOOTNOTE} /></p>}
        {foot.map((f, i) => <p key={i} style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}><BoldText text={f} /></p>)}
        {items.some((it) => it.entry?.mismatch?.cpu?.flag) && <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}>
          <BoldText text={'‘≠’ 는 CPU 사용률이 OS 와 iDRAC 에서 기준 이상 다르다는 표지입니다(어느 쪽이 맞는지 단정하지 않습니다 — 칸에 마우스를 올리면 두 값).'} />
        </p>}
      </div>

      {/* ── 병목 Top ── */}
      <div className="card" style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline', marginBottom: 6 }}>
          <h4 style={{ margin: 0 }}>병목 Top</h4>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>서버 판정 등급 순 · 판정 한 줄은 서버 문장 그대로 · 두 경로가 다 읽힌 서버는 교차 판정을 붙입니다</span>
          {onCompare && top.length >= 2 && <button type="button" className="btn btn-sm bmp-touch" onClick={() => onCompare(top.map((it) => it.key))}>Top {top.length} 비교</button>}
        </div>
        {!top.length ? (
          <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>병목·포화·오류·주의로 판정된 서버가 없습니다{k.held ? ` — 다만 판정 보류 ${k.held}대는 정상이라는 뜻이 아닙니다` : ''}.</p>
        ) : (
          <div className="bmp-top">
            {top.map((it) => (
              <div key={`${it.agent}|${refOf(it.key, it.vcenterId)}`} className="bmp-top-item">
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>{RES_LABEL[it.entry.focus] || '—'}</div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                    <span role="button" tabIndex={0} className="bmp-link" onClick={() => open(it.key, it.vcenterId)} onKeyDown={keyOpen(it.key, it.vcenterId)} style={{ fontWeight: 600 }}>{it.name}</span>
                    <VerdictBadge verdict={it.entry.verdict} />
                    <span style={{ fontSize: 11, color: 'var(--muted)' }}>{it.vcenterId || '귀속 없음'} · {coverageView(it.entry.coverage).label}</span>
                  </div>
                  <div style={{ fontSize: 12, lineHeight: 1.6, overflowWrap: 'anywhere' }}>{it.entry.line}</div>
                  {crossBandText(it.entry.cross).map((c, i) => (
                    <div key={i} style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--text-dim)' }}><BoldText text={`→ ${c}`} /></div>
                  ))}
                </div>
                <button className="btn btn-sm bmp-touch" onClick={() => open(it.key, it.vcenterId)}>상세</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
