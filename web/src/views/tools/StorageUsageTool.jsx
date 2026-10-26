import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ResponsiveContainer, LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts';
import { fetchJson, postJson, putJson, canCsv, CSV_DENIED_NOTE, downloadFile } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import Select from '../../components/Select.jsx';
import { useHashTab } from '../../hooks/useHashTab.js';
import { facetState, toggleIn, groupBy } from './deviceFacets.js';
import DeviceFacetBar from './DeviceFacetBar.jsx';
import { addressHiddenNote } from './addressHiddenText.js';
import {
  UNITS, bytesText, deltaText, pctText, pctTone, aggregateCells, groupSummary, inexactNote, partialNote,
  probeLine, chartSeries, wideCsv, longCsv, csvFileName, SKIP_TEXT, MISSED_TEXT, DAY_LABELS, mailDirty, parseMailList,
  recipientCount, daysText, deltaOf, legendText, periodText, deviceSub, mailBodyText, ATTACH_TEXT,
} from './storageUsageText.js';

/**
 * 특수기능 › 스토리지 사용량 보고서(v2.789, 도구 키 storage-usage).
 *
 * 사용자 요청(2026-10-26): "스토리지 사용량을 일간/주간 별로 이렇게 정리해서 보는 기능"(엑셀 캡처 — 날짜 행 × 법인 › 장비 ›
 *   Total Usable·Used·Percent, Unity 아래 SAN·NAS 항목) · "표 형식으로 보는 것을 기본 · CSV export 기본 기능" ·
 *   "법인별/같은 종류 스토리지별 비교해서 보기 등 다양한 기능" · "사용자가 지정한 시간에 전체 사용량을 이메일로".
 *
 * ── 화면 설계 ────────────────────────────────────────────────────────────────
 *  · 탭 5개: 날짜별 표(엑셀형 — 기본) · 장비별 표(+ LUN·파일시스템) · 법인별 비교 · 종류별 비교 · 메일 발송(관리자).
 *  · 법인·종류 필터(`DeviceFacetBar` — 다른 스토리지 화면과 같은 메뉴)를 먼저 걸고 그 다음에 묶는다. 필터를 걸면 KPI·합계·차트·CSV 가
 *    전부 그 부분집합으로 다시 계산된다(증가량 화면 v2.533 의 교훈 — 표는 3대인데 합계는 59대인 보고서를 만들지 않는다).
 *  · 판정·합계·문구·CSV 는 전부 `storageUsageText.js`(순수)가 갖는다 — 여기서 숫자를 만들지 않는다.
 * ⚠ **폴링하지 않는다** — 일 롤업을 읽을 뿐이지만 장비 × 기간 행을 읽는다. 마운트 1회 + 조건 변경 + 새로고침 버튼.
 * ⚠ 훅은 전부 조기 return 위에 둔다(React #310).
 */

const lsGet = (k, d) => { try { return window.localStorage.getItem(k) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { window.localStorage.setItem(k, v); } catch { /* 무시 */ } };

const COUNT_CHOICES = { daily: [7, 14, 31, 62, 92], weekly: [4, 8, 13, 26, 52, 104], monthly: [6, 12, 24, 36] };
const DEF_COUNT = { daily: 14, weekly: 8, monthly: 12 };
const TONE_BG = { ok: 'rgba(34,197,94,.16)', warn: 'rgba(245,158,11,.22)', crit: 'rgba(239,68,68,.24)', none: 'transparent' };
const NOTE = { fontSize: 12, color: 'var(--text-dim)', whiteSpace: 'normal', lineHeight: 1.6 };
const TH_GROUP = { textAlign: 'center', borderLeft: '1px solid var(--border)', whiteSpace: 'nowrap', fontWeight: 700 };
const NUM = { textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' };
const STICKY = { position: 'sticky', left: 0, zIndex: 1, background: 'var(--panel)' };
const AXIS = { fill: 'var(--text-dim)', fontSize: 11 };

export default function StorageUsageTool({ isAdmin = false }) {
  const tabs = useMemo(() => ['table', 'devices', 'corp', 'type', ...(isAdmin ? ['mail'] : [])], [isAdmin]);
  const [view, setView] = useHashTab({ base: ['tools', 'storage-usage'], valid: tabs, fallback: 'table' });
  const [gran, setGranState] = useState(() => { const g = lsGet('storageUsage.gran', 'weekly'); return COUNT_CHOICES[g] ? g : 'weekly'; });
  const [count, setCount] = useState(() => DEF_COUNT[lsGet('storageUsage.gran', 'weekly')] || 8);
  const [weekday, setWeekday] = useState(1);
  const [unit, setUnitState] = useState(() => lsGet('storageUsage.unit', 'auto'));
  const [showRes, setShowRes] = useState(() => lsGet('storageUsage.res', '1') === '1');
  const [showPools, setShowPools] = useState(() => lsGet('storageUsage.pools', '1') === '1');
  const [hideEmpty, setHideEmpty] = useState(true);
  const [dcSel, setDcSel] = useState(() => new Set());
  const [typeSel, setTypeSel] = useState(() => new Set());
  const [query, setQuery] = useState('');
  const [cmpType, setCmpType] = useState('');
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [xlsxBusy, setXlsxBusy] = useState(false);
  const [xlsxMsg, setXlsxMsg] = useState('');

  const setGran = (g) => { setGranState(g); setCount(DEF_COUNT[g]); lsSet('storageUsage.gran', g); };
  const setUnit = (u) => { setUnitState(u); lsSet('storageUsage.unit', u); };
  const toggleRes = () => setShowRes((v) => { lsSet('storageUsage.res', v ? '0' : '1'); return !v; });
  const togglePools = () => setShowPools((v) => { lsSet('storageUsage.pools', v ? '0' : '1'); return !v; });

  // 늦게 온 이전 응답이 새 조건의 표를 덮지 않게 — 세대가 같을 때만 반영한다(증가량 화면 v2.612 WEB2612-02).
  const gen = useRef(0);
  const load = useCallback(() => {
    const g = ++gen.current;
    setBusy(true);
    return fetchJson('/tools/storage-usage', { gran, count, weekday })
      .then((r) => { if (g === gen.current) { setD(r); setErr(null); } })
      .catch((e) => { if (g === gen.current) setErr(e.message); })
      .finally(() => { if (g === gen.current) setBusy(false); });
  }, [gran, count, weekday]);
  useEffect(() => { load(); }, [load]);

  const dcName = useCallback((id) => ((d?.datacenters || []).find((x) => x.id === id)?.name || id || '미지정'), [d]);
  const typeLabel = useCallback((t) => ((d?.types || []).find((x) => x.type === t)?.label || t || ''), [d]);
  const kindGroup = useMemo(() => Object.fromEntries(Object.entries(d?.resourceKinds || {}).map(([k, v]) => [k, v.group])), [d]);
  const periods = useMemo(() => d?.periods || [], [d]);
  const withData = useMemo(() => (d?.devices || []).filter((x) => !hideEmpty || x.cells.some(Boolean)), [d, hideEmpty]);
  const facets = useMemo(() => facetState({ rows: withData, dcSel, typeSel, query, dcName, typeLabel }), [withData, dcSel, typeSel, query, dcName, typeLabel]);
  const shown = facets.shown;
  const total = useMemo(() => groupSummary('all', '전체', shown, periods), [shown, periods]);
  const emptyHidden = (d?.devices || []).length - withData.length;

  // 비교 차트 색은 **전체 데이터 기준 고정 순서**(현재 사용량 큰 순)로 정한다 — 필터로 다시 칠하지 않는다.
  const corpOrder = useMemo(() => orderBy(withData, (x) => dcName(x.datacenterId), periods), [withData, dcName, periods]);
  const corpGroups = useMemo(() => groupBy(shown, (x) => dcName(x.datacenterId)).map((g) => ({ ...groupSummary(g.key, g.label, g.list, periods), list: g.list })), [shown, dcName, periods]);
  const typeGroups = useMemo(() => groupBy(shown, (x) => x.type || '', typeLabel).map((g) => ({ ...groupSummary(g.key, g.label, g.list, periods), list: g.list })), [shown, typeLabel, periods]);
  const cmpTypeKey = cmpType && typeGroups.some((g) => g.key === cmpType) ? cmpType : (typeGroups.slice().sort((a, b) => b.devices - a.devices)[0]?.key || '');
  const typeDevs = useMemo(() => shown.filter((x) => x.type === cmpTypeKey), [shown, cmpTypeKey]);
  const devOrder = useMemo(() => orderBy(withData.filter((x) => x.type === cmpTypeKey), (x) => x.deviceId, periods), [withData, cmpTypeKey, periods]);

  const download = (kind) => {
    const opts = { dcName, typeLabel, unit, resources: showRes, pools: showPools, kindGroup };
    const body = kind === 'wide' ? wideCsv(shown, periods, opts) : longCsv(shown, periods, opts);
    const url = URL.createObjectURL(new Blob(['﻿' + body], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = csvFileName({ gran: d?.gran, asOfLabel: d?.asOfLabel, kind, filtered: facets.facetOn || !!query });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  // v2.791 엑셀 — 서버가 만든다(메일 첨부와 같은 파일: 주간 · 누적 전 주차 · 전 장비). 화면 필터는 적용되지 않는다(버튼 설명에 밝힌다).
  //   409(다른 내보내기 진행 중)·403 은 downloadFile 이 던진다 — 문구를 그대로 보인다.
  const downloadXlsx = async () => {
    setXlsxBusy(true); setXlsxMsg('');
    try { await downloadFile(`/tools/storage-usage/xlsx?resources=${showRes ? 1 : 0}`); }
    catch (e) { setXlsxMsg(e?.message || '엑셀을 받지 못했습니다.'); }
    finally { setXlsxBusy(false); }
  };

  if (err && !d) return <ErrorBox error={err} />;
  if (!d) return <Loading />;

  const granLabel = d.grans?.[d.gran]?.label || '';
  const cur = total.cur;
  const prevLabel = periods.length > 1 ? periods[periods.length - 2].label : '';
  const hidden = addressHiddenNote(d);
  const resCount = shown.reduce((a, x) => a + (x.resources?.length || 0), 0);
  const hasPools = shown.some((x) => x.pools?.length);
  const allMax = d.grans?.[gran]?.allMax;

  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr)', minWidth: 0, gap: 14 }}>
      {/* ── 표제 ─────────────────────────────────────────── */}
      <div className="card" style={{ padding: '16px 20px', borderLeft: '4px solid var(--accent)', minWidth: 0 }}>
        <div className="flex gap wrap" style={{ alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div className="muted" style={{ fontSize: 11.5, letterSpacing: 1, fontWeight: 700 }}>Storage Usage Report</div>
            <h2 style={{ margin: '4px 0 0', fontSize: 22, fontWeight: 800 }}>스토리지 사용량 보고서</h2>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 6, whiteSpace: 'normal', lineHeight: 1.6 }}>
              {granLabel} · 기준 {d.asOfLabel} · 표시 장비 {shown.length}대{resCount ? ` · 하위 항목 ${resCount}개` : ''}
              {emptyHidden > 0 ? ` · 이력 없는 장비 ${emptyHidden}대 숨김` : ''}
            </div>
          </div>
          <div className="flex gap wrap" style={{ gap: 8, alignItems: 'center', minWidth: 0 }}>
            <button className="tab" onClick={load} disabled={busy} title="저장된 일 단위 이력을 다시 읽습니다(장비에 접속하지 않습니다).">{busy ? '불러오는 중…' : '↻ 새로고침'}</button>
            {canCsv() ? <>
            <button className="tab" onClick={() => download('wide')} disabled={!shown.length}
              title="화면의 날짜별 표 그대로(머리 3줄: 법인 / 장비·항목 / 지표). 숫자 칸은 숫자만 — 단위는 머리에 적습니다.">⬇ CSV(표 그대로)</button>
            <button className="tab" onClick={() => download('long')} disabled={!shown.length}
              title="한 줄 = 기간 × 장비(또는 LUN·파일시스템). 엑셀 피벗·필터용이고 직전 기간 대비 변화와 실제 관측일을 함께 싣습니다.">⬇ CSV(행 단위)</button>
            <button className="tab" onClick={downloadXlsx} disabled={xlsxBusy || !(d.devices || []).length}
              title="메일 첨부와 같은 엑셀입니다 — 주간(ISO 주차) · 누적된 전 주차 · 전 장비(화면의 법인·종류 필터는 적용되지 않습니다). 시트: 요약 · 주간 사용량 · 법인별·종류별 · 데이터(행 단위) · 읽는 법.">
              {xlsxBusy ? '엑셀 만드는 중…' : '⬇ 엑셀(주간 누적)'}</button>
            </> : <span className="muted" style={{ fontSize: 11.5, whiteSpace: 'normal' }}>{CSV_DENIED_NOTE}</span>}
          </div>
        </div>
      </div>

      {/* ── 핵심 수치 ─────────────────────────────────────── */}
      <div className="kpis">
        <Kpi label="전체 용량" value={bytesText(cur?.totalBytes, unit)} meta={cur ? (partialNote(cur) || `${cur.counted}대 합계`) : '값 없음'} tone={cur?.partial ? 'warn' : ''} />
        <Kpi label="사용" value={bytesText(cur?.usedBytes, unit)} meta={`사용률 ${pctText(cur?.pct)}`} tone={pctTone(cur?.pct) === 'crit' ? 'bad' : pctTone(cur?.pct) === 'warn' ? 'warn' : ''} />
        <Kpi label={prevLabel ? `${prevLabel} 대비` : '직전 기간 대비'} value={deltaText(total.delta, unit)} meta={total.deltaWhy || '사용량 변화'} />
        <Kpi label={`${periods[0]?.label || ''} → ${periods[periods.length - 1]?.label || ''}`} value={deltaText(total.range, unit)}
          meta={total.avg != null ? `${granLabel === '일간' ? '하루' : granLabel === '주간' ? '한 주' : '한 달'} 평균 ${deltaText(total.avg, unit)}` : '범위 양 끝이 완전한 합계일 때만 냅니다'} />
      </div>

      {/* ── 조건(메일 탭에서는 숨긴다 — 메일은 화면 필터와 무관하게 전체 장비다) ── */}
      {view !== 'mail' && <div className="card" style={{ padding: '10px 14px', minWidth: 0 }}>
        <div className="flex gap wrap" style={{ alignItems: 'center', gap: 10 }}>
          <span className="muted" style={{ fontSize: 12 }}>단위</span>
          {Object.entries(d.grans || {}).map(([k, g]) => (
            <button key={k} type="button" className={`tab${gran === k ? ' active' : ''}`} onClick={() => setGran(k)}>{g.label}</button>
          ))}
          <span className="muted" style={{ fontSize: 12, marginLeft: 6 }}>기간 수</span>
          <Select sort={false} className="select" value={count} onChange={(e) => setCount(e.target.value === 'all' ? 'all' : Number(e.target.value))} style={{ width: 'auto' }}>
            {(COUNT_CHOICES[gran] || []).filter((n) => n <= (d.grans?.[gran]?.max || 999)).map((n) => <option key={n} value={n}>{n}개</option>)}
            {allMax ? <option value="all">전체 누적{d.all && d.firstLabel ? ` (${d.firstLabel}부터 ${periods.length}개)` : ''}</option> : null}
          </Select>
          {gran === 'weekly' && (<>
            <span className="muted" style={{ fontSize: 12 }}>기준 요일</span>
            <Select sort={false} className="select" value={weekday} onChange={(e) => setWeekday(Number(e.target.value))} style={{ width: 'auto' }}>
              {(d.weekdayLabels || DAY_LABELS).map((l, i) => <option key={l} value={i}>{l}요일</option>)}
            </Select>
          </>)}
          <span className="muted" style={{ fontSize: 12, marginLeft: 6 }}>표시 단위</span>
          <Select sort={false} className="select" value={unit} onChange={(e) => setUnit(e.target.value)} style={{ width: 'auto' }}>
            {UNITS.map((u) => <option key={u.key} value={u.key}>{u.label}</option>)}
          </Select>
          <label className="flex" style={{ gap: 6, alignItems: 'center', fontSize: 12.5 }}>
            <input type="checkbox" checked={showRes} onChange={toggleRes} /> LUN·파일시스템 포함
          </label>
          {hasPools && <label className="flex" style={{ gap: 6, alignItems: 'center', fontSize: 12.5 }}>
            <input type="checkbox" checked={showPools} onChange={togglePools} /> PowerScale 풀(HDD·SSD) 나눠 보기
          </label>}
          <label className="flex" style={{ gap: 6, alignItems: 'center', fontSize: 12.5 }}>
            <input type="checkbox" checked={hideEmpty} onChange={(e) => setHideEmpty(e.target.checked)} /> 이력 없는 장비 숨김
          </label>
        </div>
        <div style={{ ...NOTE, marginTop: 8 }}>
          <BoldText text={periodRuleText(d.gran, d.weekdayLabels?.[d.weekday])} />
        </div>
      </div>}

      {view !== 'mail' && <DeviceFacetBar dcChips={facets.dcChips} typeChips={facets.typeChips} dcSel={dcSel} typeSel={typeSel}
        onToggleDc={(v) => setDcSel((p) => toggleIn(p, v))} onToggleType={(v) => setTypeSel((p) => toggleIn(p, v))}
        onClear={() => { setDcSel(new Set()); setTypeSel(new Set()); }} query={query} onQuery={setQuery} typeLabel={typeLabel} />}

      {hidden && <div style={NOTE}><BoldText text={hidden} /></div>}
      {err && <div style={{ ...NOTE, color: 'var(--amber)' }}>새로고침 실패 — 직전 결과를 보여 줍니다: {err}</div>}
      {xlsxMsg && <div style={{ ...NOTE, color: 'var(--red)' }}>엑셀 내려받기 실패 — {xlsxMsg}</div>}

      <div className="flex gap wrap" style={{ gap: 6 }}>
        {[['table', '📋 날짜별 표'], ['devices', '🗂 장비별 표'], ['corp', '🏢 법인별 비교'], ['type', '🧩 종류별 비교'], ...(isAdmin ? [['mail', '✉ 메일 발송']] : [])].map(([k, l]) => (
          <button key={k} type="button" className={`tab${view === k ? ' active' : ''}`} onClick={() => setView(k)}>{l}</button>
        ))}
      </div>

      {!shown.length && view !== 'mail' && (
        <div className="card" style={{ ...NOTE, padding: 16 }}>
          {(d.devices || []).length ? '조건에 맞는 장비가 없습니다 — 법인·종류 선택이나 검색어를 확인하세요.' : '등록된 스토리지 장비가 없습니다(특수 기능 › 스토리지 모니터링에서 등록).'}
          {!d.db ? ' 용량 이력 DB 를 쓸 수 없어 이력이 비어 있습니다.' : ''}
        </div>
      )}

      {view === 'table' && shown.length > 0 && <WideTable devices={shown} periods={periods} total={total} unit={unit} showRes={showRes} showPools={showPools} dcName={dcName} typeLabel={typeLabel} kindGroup={kindGroup} />}
      {view === 'devices' && shown.length > 0 && <DeviceTable devices={shown} periods={periods} unit={unit} showRes={showRes} showPools={showPools} dcName={dcName} typeLabel={typeLabel} kindGroup={kindGroup} resourceKinds={d.resourceKinds || {}} />}
      {view === 'corp' && shown.length > 0 && <CorpView groups={corpGroups} order={corpOrder} periods={periods} unit={unit} shown={shown} dcName={dcName} typeLabel={typeLabel} granLabel={granLabel} />}
      {view === 'type' && shown.length > 0 && (
        <TypeView groups={typeGroups} typeKey={cmpTypeKey} onType={setCmpType} devices={typeDevs} order={devOrder} periods={periods} unit={unit} dcName={dcName} granLabel={granLabel} />
      )}
      {view === 'mail' && isAdmin && <MailView offsetMin={d.dayOffsetMin} />}

      {view !== 'mail' && (
        <div style={NOTE}>
          <BoldText text={legendText()} />
        </div>
      )}
    </div>
  );
}

/** 기간 규칙 문구 — 서버 usageReport.js 머리말과 같은 뜻. */
function periodRuleText(gran, wd) {
  if (gran === 'daily') return '일간: **그 날의 마지막 관측**입니다. 그 날 수집이 없으면 빈 칸(—)이고 앞날 값을 끌어오지 않습니다.';
  if (gran === 'monthly') return '월간: **그 달 마지막 날(이번 달은 오늘)** 기준 값입니다. 그 날 수집이 없으면 그 달 안의 가장 최근 관측을 쓰고 ‘≈’ 로 밝힙니다.';
  return `주간: 행 이름은 **ISO 주차**(월요일 시작 · 그 해 첫 목요일이 든 주가 1주차 — 엑셀 ISOWEEKNUM 과 같은 번호)이고, 값은 매주 **${wd || '월'}요일** 기준입니다. 그 날 수집이 없으면 직전 6일 안의 가장 최근 관측을 쓰고 ‘≈’ 로 밝힙니다.`;
}

/** 전체 데이터 기준 고정 순서(현재 사용량 큰 순) — 비교 차트 색을 개체에 고정한다. */
function orderBy(devs, keyOf, periods) {
  const m = new Map();
  for (const x of devs) { const k = keyOf(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return [...m.entries()].map(([k, list]) => {
    const c = aggregateCells(list, periods);
    return [k, c[c.length - 1]?.usedBytes ?? -1];
  }).sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).map(([k]) => k);
}

function Kpi({ label, value, meta, tone }) {
  const color = tone === 'bad' ? 'var(--red)' : tone === 'warn' ? 'var(--amber)' : undefined;
  return (
    <div className="card kpi" style={{ minWidth: 0 }}>
      <div className="label">{label}</div>
      <div className="value" style={{ color, fontSize: 24 }}>{value ?? '—'}</div>
      {meta ? <div className="meta" style={{ whiteSpace: 'normal' }}>{meta}</div> : null}
    </div>
  );
}

function PctCell({ cell, extra }) {
  const tone = pctTone(cell?.pct);
  return (
    <td style={{ ...NUM, background: TONE_BG[tone], fontWeight: tone === 'crit' ? 700 : 500, ...(extra || {}) }} data-sort={cell?.pct ?? ''}>
      {pctText(cell?.pct)}
    </td>
  );
}
function BytesCell({ b, unit, cell, extra }) {
  const note = inexactNote(cell);
  return (
    <td style={{ ...NUM, ...(extra || {}) }} data-sort={b ?? ''} title={note || undefined}>
      {note ? <span style={{ color: 'var(--text-faint)' }}>≈ </span> : null}{bytesText(b, unit)}
    </td>
  );
}

/* ── 날짜별 표(엑셀형) ─────────────────────────────────────── */
function WideTable({ devices, periods, total, unit, showRes, showPools, dcName, typeLabel, kindGroup }) {
  // 열 묶음: 전체 합계 → 법인 순 → 장비(+ 하위 항목). 법인 머리는 colSpan 으로 묶는다(정렬은 마지막 머리 줄만 — STable 규약).
  const corps = groupBy(devices, (x) => dcName(x.datacenterId));
  const cols = [];
  for (const g of corps) {
    for (const dv of g.list.slice().sort((a, b) => String(a.name).localeCompare(String(b.name), 'en', { numeric: true }))) {
      cols.push({ corp: g.label, key: dv.deviceId, title: dv.name, sub: deviceSub(dv, typeLabel), cells: dv.cells, labels: ['Total Usable', 'Used', 'Percent'] });
      // 풀은 장비와 같은 단위(TB) — 하위 항목(GB)과 달리 단위를 바꾸지 않는다.
      if (showPools) for (const pl of dv.pools || []) {
        cols.push({ corp: g.label, key: `${dv.deviceId}|pool:${pl.key}`, title: pl.label, sub: `${dv.name} 하위`, cells: pl.cells, labels: ['Total Usable', 'Used', 'Percent'], res: true });
      }
      if (showRes) for (const r of dv.resources || []) {
        cols.push({ corp: g.label, key: `${dv.deviceId}|${r.rkey}`, title: `${kindGroup[r.kind] || r.kind} ${r.name}`, sub: `${dv.name} 하위`, cells: r.cells, labels: ['Size', 'Used', 'Percent'], res: true, gb: true });
      }
    }
  }
  const corpSpans = [];
  for (const c of cols) { const last = corpSpans[corpSpans.length - 1]; if (last && last.corp === c.corp) last.n += 3; else corpSpans.push({ corp: c.corp, n: 3 }); }
  const minWidth = 110 + 3 * 92 + cols.length * 3 * 86;
  return (
    <div className="card" style={{ padding: 0, minWidth: 0 }}>
      <STable minWidth={minWidth} style={{ fontSize: 12.5 }}>
        <thead>
          <tr>
            <th style={STICKY} data-nosort></th>
            <th colSpan={3} style={{ ...TH_GROUP, background: 'var(--panel-2)' }}>전체(표시 장비 합계)</th>
            {corpSpans.map((c, i) => <th key={`${c.corp}-${i}`} colSpan={c.n} style={{ ...TH_GROUP, color: 'var(--accent)' }}>{c.corp}</th>)}
          </tr>
          <tr>
            <th style={STICKY} data-nosort></th>
            <th colSpan={3} style={{ ...TH_GROUP, fontWeight: 500 }}>{devices.length}대</th>
            {cols.map((c) => (
              <th key={c.key} colSpan={3} style={{ ...TH_GROUP, fontWeight: c.res ? 500 : 700, color: c.res ? 'var(--text-dim)' : undefined }} title={c.sub}>
                {c.title}{!c.res ? <span className="muted" style={{ fontWeight: 400 }}> · {c.sub}</span> : null}
              </th>
            ))}
          </tr>
          <tr>
            <th style={STICKY}>{periods[0]?.dayLabel ? '주차' : '일자'}</th>
            <th style={{ ...NUM, borderLeft: '1px solid var(--border)' }}>Total</th><th style={NUM}>Used</th><th style={NUM}>%</th>
            {cols.map((c) => (
              <React.Fragment key={c.key}>
                <th style={{ ...NUM, borderLeft: '1px solid var(--border)' }}>{c.labels[0]}</th><th style={NUM}>{c.labels[1]}</th><th style={NUM}>{c.labels[2]}</th>
              </React.Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {periods.map((p, i) => {
            const t = total.cells[i];
            return (
              <tr key={p.key}>
                <td style={{ ...STICKY, whiteSpace: 'nowrap', fontWeight: 600 }} data-sort={p.toDay}>{p.label}
                  {/* 기준일은 아래 줄 — 같은 줄이면 고정 첫 열이 400px 화면 표 폭의 절반 가까이를 먹었다(v2.791 Chromium) */}
                  {p.dayLabel ? <div className="muted" style={{ fontWeight: 400, fontSize: 11 }}>{p.dayLabel.slice(5)}</div> : null}
                  {p.current ? <span className="muted" style={{ fontWeight: 400 }}> (오늘까지)</span> : null}</td>
                <BytesCell b={t?.totalBytes} unit={unit} extra={{ borderLeft: '1px solid var(--border)', background: 'var(--panel-2)' }} />
                <td style={{ ...NUM, background: 'var(--panel-2)' }} data-sort={t?.usedBytes ?? ''} title={partialNote(t) || undefined}>
                  {bytesText(t?.usedBytes, unit)}{t?.partial ? <span style={{ color: 'var(--amber)' }}> *</span> : null}
                </td>
                <PctCell cell={t} extra={{ background: 'var(--panel-2)' }} />
                {cols.map((c) => {
                  const cell = c.cells[i];
                  return (
                    <React.Fragment key={c.key}>
                      <BytesCell b={cell?.totalBytes} unit={c.gb && unit === 'auto' ? 'GB' : unit} cell={cell} extra={{ borderLeft: '1px solid var(--border)' }} />
                      <BytesCell b={cell?.usedBytes} unit={c.gb && unit === 'auto' ? 'GB' : unit} cell={cell} />
                      <PctCell cell={cell} />
                    </React.Fragment>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </STable>
      {total.cells.some((c) => c.partial) && (
        <div style={{ ...NOTE, padding: '8px 12px' }}>* 그 시점에 값이 없는 장비가 있어 부분 합입니다(칸에 마우스를 올리면 ‘값 있음 N/M대’).</div>
      )}
    </div>
  );
}

/* ── 장비별 표 + 하위 항목 ─────────────────────────────────── */
function DeviceTable({ devices, periods, unit, showRes, showPools, dcName, typeLabel, kindGroup, resourceKinds }) {
  const n = periods.length;
  const last = n - 1;
  // 장비 한 대도 같은 요약 함수로(직전 대비·범위 변화 — 값이 빠진 기간이면 내지 않는다). 숫자를 여기서 만들지 않는다.
  // 풀(v2.791)은 장비 바로 아래 줄 — 같은 요약 함수에 풀 칸을 장비 칸 자리에 넣어 계산한다(합계에는 더하지 않는다).
  const rows = devices.flatMap((x) => {
    const g = groupSummary(x.deviceId, x.name, [x], periods);
    const own = { key: x.deviceId, x, cells: x.cells, cur: g.cur, delta: g.delta, range: g.range };
    const pools = showPools ? (x.pools || []).map((pl) => {
      const pg = groupSummary(`${x.deviceId}|${pl.key}`, pl.label, [{ ...x, cells: pl.cells }], periods);
      return { key: `${x.deviceId}|pool:${pl.key}`, x, pool: pl, cells: pl.cells, cur: pg.cur, delta: pg.delta, range: pg.range };
    }) : [];
    return [own, ...pools];
  });
  const res = showRes ? devices.flatMap((x) => (x.resources || []).map((r) => ({ x, r, cur: r.cells[last], delta: n > 1 ? deltaOf(r.cells[last - 1], r.cells[last]) : null }))) : [];
  const probes = devices.filter((x) => x.type === 'unity480' || x.resourcesProbe || x.resources?.length);
  return (
    <>
      <div className="card" style={{ padding: 0, minWidth: 0 }}>
        <div style={{ padding: '10px 14px', fontWeight: 700 }}>장비별 — {periods[last]?.label} 기준 · 기간별 사용량</div>
        <STable minWidth={760 + n * 104} style={{ fontSize: 12.5 }}>
          <thead>
            <tr>
              <th>법인</th><th>종류</th><th>장비</th>
              {periods.map((p) => <th key={p.key} style={NUM}>{p.label}</th>)}
              <th style={NUM}>전체</th><th style={NUM}>사용률</th><th style={NUM}>직전 대비</th><th style={NUM}>범위 변화</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ key, x, pool, cells, cur, delta, range }) => (
              <tr key={key}>
                <td>{dcName(x.datacenterId)}</td><td>{typeLabel(x.type)}</td>
                {pool
                  ? <td style={{ color: 'var(--text-dim)' }}>{x.name} › {pool.label}</td>
                  : <td style={{ fontWeight: 600 }}>{x.name}{x.enabled === false ? <span className="muted"> (꺼짐)</span> : null}
                    {x.poolNote ? <span className="muted" style={{ fontWeight: 400 }}> · {x.poolNote}</span> : null}</td>}
                {cells.map((c, i) => <BytesCell key={periods[i].key} b={c?.usedBytes} unit={unit} cell={c} />)}
                <td style={NUM} data-sort={cur?.totalBytes ?? ''}>{bytesText(cur?.totalBytes, unit)}</td>
                <PctCell cell={cur} />
                <td style={NUM} data-sort={delta ?? ''}>{deltaText(delta, unit)}</td>
                <td style={NUM} data-sort={range ?? ''}>{deltaText(range, unit)}</td>
              </tr>
            ))}
          </tbody>
        </STable>
      </div>
      {showRes && (
        <div className="card" style={{ padding: 0, minWidth: 0 }}>
          <div style={{ padding: '10px 14px', fontWeight: 700 }}>하위 항목(LUN·파일시스템) — {res.length}개</div>
          {res.length ? (
            <STable minWidth={820 + n * 104} style={{ fontSize: 12.5 }}>
              <thead>
                <tr>
                  <th>법인</th><th>장비</th><th>구분</th><th>항목</th>
                  {periods.map((p) => <th key={p.key} style={NUM}>{p.label}</th>)}
                  <th style={NUM}>크기</th><th style={NUM}>사용률</th><th style={NUM}>직전 대비</th>
                </tr>
              </thead>
              <tbody>
                {res.map(({ x, r, cur, delta }) => (
                  <tr key={`${x.deviceId}|${r.rkey}`}>
                    <td>{dcName(x.datacenterId)}</td><td>{x.name}</td>
                    <td title={resourceKinds[r.kind]?.label || r.kind}>{kindGroup[r.kind] || r.kind}</td>
                    <td style={{ fontWeight: 600 }} title={r.pool ? `풀 ${r.pool}` : undefined}>{r.name}</td>
                    {r.cells.map((c, i) => <BytesCell key={periods[i].key} b={c?.usedBytes} unit={unit === 'auto' ? 'GB' : unit} cell={c} />)}
                    <td style={NUM} data-sort={cur?.totalBytes ?? ''}>{bytesText(cur?.totalBytes, unit === 'auto' ? 'GB' : unit)}</td>
                    <PctCell cell={cur} />
                    <td style={NUM} data-sort={delta ?? ''}>{deltaText(delta, unit === 'auto' ? 'GB' : unit)}</td>
                  </tr>
                ))}
              </tbody>
            </STable>
          ) : <div style={{ ...NOTE, padding: '0 14px 12px' }}>이 조건의 장비에는 하위 항목 이력이 없습니다. 하위 항목은 지금 Unity(SSH·REST)만 수집합니다.</div>}
          {probes.length > 0 && (
            <div style={{ ...NOTE, padding: '8px 14px 12px', borderTop: '1px solid var(--border-soft)' }}>
              <b style={{ color: 'var(--text)' }}>최근 수집 상태</b>
              {probes.map((x) => (
                <div key={x.deviceId}>
                  {x.name}: {x.lastSnapOk === false
                    ? '최근 수집이 실패해 이번 상태를 알 수 없습니다(이력은 마지막으로 읽은 날까지)'
                    : <>{probeLine('LUN', x.resourcesProbe?.lun)} · {probeLine('파일시스템', x.resourcesProbe?.fs)}</>}
                  {x.resourcesDropped ? ` · 상한·형식 이상으로 뺀 항목 ${x.resourcesDropped}개` : ''}
                </div>
              ))}
              <div style={{ marginTop: 4 }}>
                <BoldText text="⚠ LUN·파일시스템 명령의 실제 출력은 이 포탈이 아직 본 적이 없습니다(Dell CLI·REST 문서 기준으로 읽습니다). ‘출력 형식을 인식하지 못함’ 이 보이면 스토리지 모니터링 상세의 **CLI 원문**을 확인해 알려 주세요." />
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}

/* ── 법인별 비교 ──────────────────────────────────────────── */
function TrendChart({ title, groups, order, periods, metric = 'pct', unit }) {
  const { series, data, cutPoints } = chartSeries(groups, order, periods, { metric });
  const fmt = (v) => (v == null ? '—' : metric === 'pct' ? `${Number(v).toFixed(1)}%` : bytesText(v, unit));
  return (
    <div className="card" style={{ minWidth: 0 }}>
      <div style={{ fontWeight: 700, marginBottom: 8 }}>{title}</div>
      <div style={{ width: '100%', height: 280 }}>
        <ResponsiveContainer>
          <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
            <CartesianGrid stroke="var(--border-soft)" vertical={false} />
            <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={{ stroke: 'var(--border)' }} minTickGap={16} />
            <YAxis tick={AXIS} tickLine={false} axisLine={false} width={metric === 'pct' ? 44 : 72} allowDecimals={false}
              domain={metric === 'pct' ? [(lo) => Math.max(0, Math.floor(lo - 3)), (hi) => Math.min(100, Math.ceil(hi + 3))] : [0, 'auto']} tickFormatter={(v) => (metric === 'pct' ? `${v}%` : bytesText(v, unit))} />
            <Tooltip formatter={(v, n) => [fmt(v), series.find((s) => s.key === n)?.label || n]}
              contentStyle={{ background: 'var(--panel-2)', border: '1px solid var(--border)', fontSize: 12 }} labelStyle={{ color: 'var(--text)' }} />
            <Legend formatter={(k) => <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>{series.find((s) => s.key === k)?.label || k}</span>} />
            {series.map((s) => (
              <Line key={s.key} type="monotone" dataKey={s.key} stroke={s.color} strokeWidth={2} dot={{ r: 3, strokeWidth: 0, fill: s.color }}
                activeDot={{ r: 5, stroke: 'var(--panel)', strokeWidth: 2 }} connectNulls={false} isAnimationActive={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      {cutPoints > 0 && <div style={NOTE}>값이 없는 장비가 있는 시점(부분 합) {cutPoints}곳은 선을 끊었습니다 — 부분 합을 추이로 그리지 않습니다.</div>}
    </div>
  );
}

function SummaryTable({ title, groups, unit, keyHead, granLabel }) {
  return (
    <div className="card" style={{ padding: 0, minWidth: 0 }}>
      <div style={{ padding: '10px 14px', fontWeight: 700 }}>{title}</div>
      <STable minWidth={860} style={{ fontSize: 12.5 }}>
        <thead>
          <tr>
            <th>{keyHead}</th><th style={NUM}>장비</th><th style={NUM}>전체</th><th style={NUM}>사용</th><th style={NUM}>사용률</th>
            <th style={NUM}>직전 대비</th><th style={NUM}>범위 변화</th><th style={NUM}>{granLabel === '일간' ? '하루' : granLabel === '주간' ? '한 주' : '한 달'} 평균</th><th>값 상태</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <tr key={g.key}>
              <td style={{ fontWeight: 600 }}>{g.label}</td>
              <td style={NUM}>{g.devices}</td>
              <td style={NUM} data-sort={g.cur?.totalBytes ?? ''}>{bytesText(g.cur?.totalBytes, unit)}</td>
              <td style={NUM} data-sort={g.cur?.usedBytes ?? ''}>
                <MiniBar pct={g.cur?.pct} />{bytesText(g.cur?.usedBytes, unit)}
              </td>
              <PctCell cell={g.cur} />
              <td style={NUM} data-sort={g.delta ?? ''} title={g.deltaWhy || undefined}>{deltaText(g.delta, unit)}</td>
              <td style={NUM} data-sort={g.range ?? ''}>{deltaText(g.range, unit)}</td>
              <td style={NUM} data-sort={g.avg ?? ''}>{deltaText(g.avg, unit)}</td>
              <td style={{ whiteSpace: 'nowrap', color: g.cur?.partial ? 'var(--amber)' : 'var(--text-dim)' }}>{partialNote(g.cur) || '완전'}</td>
            </tr>
          ))}
        </tbody>
      </STable>
    </div>
  );
}
function MiniBar({ pct }) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  if (pct == null) return null;
  const tone = pctTone(pct);
  return (
    <span aria-hidden="true" style={{ display: 'inline-block', width: 54, height: 6, marginRight: 8, verticalAlign: 'middle', background: 'var(--border-soft)', borderRadius: 3, overflow: 'hidden' }}>
      <span style={{ display: 'block', width: `${p}%`, height: '100%', borderRadius: 3, background: tone === 'crit' ? 'var(--red)' : tone === 'warn' ? 'var(--amber)' : '#3987e5' }} />
    </span>
  );
}

function CorpView({ groups, order, periods, unit, shown, dcName, typeLabel, granLabel }) {
  const last = periods.length - 1;
  const bars = groups.filter((g) => g.cur && g.cur.counted).map((g) => ({
    label: g.label, used: g.cur.usedBytes, free: Math.max(0, g.cur.totalBytes - g.cur.usedBytes), pct: g.cur.pct,
  })).sort((a, b) => b.used - a.used);
  // 법인 × 종류 매트릭스(현재 기간) — 같은 종류를 법인끼리 나란히 본다.
  const types = [...new Set(shown.map((x) => x.type))].sort((a, b) => typeLabel(a).localeCompare(typeLabel(b)));
  return (
    <>
      <SummaryTable title={`법인별 — ${periods[last]?.label} 기준`} groups={groups} unit={unit} keyHead="법인" granLabel={granLabel} />
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 420px), 1fr))', gap: 14, minWidth: 0, alignItems: 'start' }}>
        <TrendChart title={`법인별 사용률 추이(${granLabel})`} groups={groups} order={order} periods={periods} metric="pct" unit={unit} />
        <div className="card" style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>법인별 사용·여유({periods[last]?.label})</div>
          <div style={{ width: '100%', height: Math.max(180, 34 * bars.length + 40) }}>
            <ResponsiveContainer>
              <BarChart data={bars} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 4 }} barCategoryGap={6}>
                <CartesianGrid stroke="var(--border-soft)" horizontal={false} />
                <XAxis type="number" tick={AXIS} tickLine={false} axisLine={false} tickFormatter={(v) => (v === 0 ? '0' : bytesText(v, unit))} />
                <YAxis type="category" dataKey="label" tick={AXIS} tickLine={false} axisLine={false} width={110} />
                <Tooltip formatter={(v, n) => [bytesText(v, unit), n === 'used' ? '사용' : '여유']}
                  contentStyle={{ background: 'var(--panel-2)', border: '1px solid var(--border)', fontSize: 12 }} labelStyle={{ color: 'var(--text)' }} />
                <Legend formatter={(k) => <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>{k === 'used' ? '사용' : '여유'}</span>} />
                <Bar dataKey="used" stackId="a" fill="#3987e5" stroke="var(--panel)" strokeWidth={2} isAnimationActive={false} />
                <Bar dataKey="free" stackId="a" fill="#4b5568" stroke="var(--panel)" strokeWidth={2} radius={[0, 4, 4, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
      <div className="card" style={{ padding: 0, minWidth: 0 }}>
        <div style={{ padding: '10px 14px', fontWeight: 700 }}>법인 × 종류 — {periods[last]?.label} 사용 / 전체 (사용률)</div>
        <STable minWidth={200 + types.length * 170} style={{ fontSize: 12.5 }}>
          <thead><tr><th>법인</th>{types.map((t) => <th key={t} style={NUM}>{typeLabel(t)}</th>)}</tr></thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.key}>
                <td style={{ fontWeight: 600 }}>{g.label}</td>
                {types.map((t) => {
                  const list = shown.filter((x) => dcName(x.datacenterId) === g.key && x.type === t);
                  const c = list.length ? aggregateCells(list, periods)[last] : null;
                  return (
                    <td key={t} style={{ ...NUM, background: TONE_BG[pctTone(c?.pct)] }} data-sort={c?.usedBytes ?? ''} title={c ? `${list.length}대${partialNote(c) ? ` · ${partialNote(c)}` : ''}` : '장비 없음'}>
                      {c && c.counted ? `${bytesText(c.usedBytes, unit)} / ${bytesText(c.totalBytes, unit)} (${pctText(c.pct)})` : (list.length ? '값 없음' : '')}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </STable>
      </div>
    </>
  );
}

/* ── 종류별 비교 ──────────────────────────────────────────── */
function TypeView({ groups, typeKey, onType, devices, order, periods, unit, dcName, granLabel }) {
  const last = periods.length - 1;
  const devGroups = devices.map((x) => ({ ...groupSummary(x.deviceId, `${x.name} (${dcName(x.datacenterId)})`, [x], periods), list: [x], dc: dcName(x.datacenterId), name: x.name }));
  const ranked = devGroups.slice().sort((a, b) => (b.cur?.pct ?? -1) - (a.cur?.pct ?? -1));
  const label = groups.find((g) => g.key === typeKey)?.label || typeKey;
  return (
    <>
      <SummaryTable title={`종류별 — ${periods[last]?.label} 기준`} groups={groups} unit={unit} keyHead="종류" granLabel={granLabel} />
      <div className="card" style={{ padding: '10px 14px', minWidth: 0 }}>
        <div className="flex gap wrap" style={{ gap: 6, alignItems: 'center' }}>
          <span className="muted" style={{ fontSize: 12 }}>같은 종류끼리 비교</span>
          {groups.map((g) => (
            <button key={g.key} type="button" className={`tab${typeKey === g.key ? ' active' : ''}`} onClick={() => onType(g.key)}>{g.label} <span className="muted">{g.devices}</span></button>
          ))}
        </div>
      </div>
      <TrendChart title={`${label} — 장비별 사용률 추이(${granLabel})`} groups={devGroups} order={order} periods={periods} metric="pct" unit={unit} />
      <div className="card" style={{ padding: 0, minWidth: 0 }}>
        <div style={{ padding: '10px 14px', fontWeight: 700 }}>{label} — 장비 순위({periods[last]?.label} 사용률 높은 순)</div>
        <STable minWidth={900} style={{ fontSize: 12.5 }}>
          <thead>
            <tr><th style={NUM}>순위</th><th>법인</th><th>장비</th><th style={NUM}>전체</th><th style={NUM}>사용</th><th style={NUM}>사용률</th><th style={NUM}>직전 대비</th><th style={NUM}>범위 변화</th><th style={NUM}>평균 변화</th></tr>
          </thead>
          <tbody>
            {ranked.map((g, i) => (
              <tr key={g.key}>
                <td style={NUM} data-sort={i + 1}>{g.cur?.pct != null ? i + 1 : '—'}</td>
                <td>{g.dc}</td><td style={{ fontWeight: 600 }}>{g.name}</td>
                <td style={NUM} data-sort={g.cur?.totalBytes ?? ''}>{bytesText(g.cur?.totalBytes, unit)}</td>
                <td style={NUM} data-sort={g.cur?.usedBytes ?? ''}><MiniBar pct={g.cur?.pct} />{bytesText(g.cur?.usedBytes, unit)}</td>
                <PctCell cell={g.cur} />
                <td style={NUM} data-sort={g.delta ?? ''}>{deltaText(g.delta, unit)}</td>
                <td style={NUM} data-sort={g.range ?? ''}>{deltaText(g.range, unit)}</td>
                <td style={NUM} data-sort={g.avg ?? ''}>{deltaText(g.avg, unit)}</td>
              </tr>
            ))}
          </tbody>
        </STable>
      </div>
    </>
  );
}

/* ── 메일 발송(관리자) ────────────────────────────────────── */
/** 보낸 기록 한 줄 — 값이 없으면 단위를 붙이지 않는다('—명' 금지). */
const sentText = (h) => {
  const n = h.accepted ?? h.to;
  return [n == null ? null : `${n}명 수신`, h.devices == null ? null : `장비 ${h.devices}대`, ATTACH_TEXT[h.attach] || null,
    h.attach === 'failed' || h.attach === 'trimmed' ? h.reason : null].filter(Boolean).join(' · ') || '보냄';
};
const slotText = (ms, offsetMin) => {
  if (ms == null) return '—';
  const dt = new Date(Number(ms) + Number(offsetMin || 0) * 60_000);   // 서버 일정은 포탈 시각(dayOffsetMin) — 화면도 같은 기준으로 적는다(숫자를 박지 않는다)
  const iso = dt.toISOString();
  return `${iso.slice(0, 10)} (${DAY_LABELS[dt.getUTCDay()]}) ${iso.slice(11, 16)}`;
};

function MailView({ offsetMin }) {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [toText, setToText] = useState('');
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState('');
  const [preview, setPreview] = useState(null);

  const load = useCallback(() => fetchJson('/tools/storage-usage/mail').then((r) => {
    setData(r); setForm({ ...r.mail }); setToText((r.mail.to || []).join('\n')); setErr(null);
  }).catch((e) => setErr(e.message)), []);
  useEffect(() => { load(); }, [load]);

  if (err && !data) return <ErrorBox error={err} />;
  if (!data || !form) return <Loading />;

  const parsed = parseMailList(toText);
  const formFull = { ...form, to: parsed.list };
  const dirty = mailDirty(formFull, data.mail);
  const rc = recipientCount(form.includeAdmin, data.adminTo, parsed.list);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const toggleDay = (i) => set('days', form.days.includes(i) ? form.days.filter((x) => x !== i) : [...form.days, i].sort((a, b) => a - b));
  const st = data.status || {};

  const save = async () => {
    setBusy('save'); setMsg(null);
    try {
      // ⚠ putJson(sendJson)은 400·409 를 던지지 않고 본문을 돌려준다 — ok 를 보지 않으면 거절을 '저장했습니다' 로 읽는다(v2.742 WEB-02).
      const r = await putJson('/tools/storage-usage/mail', { mail: formFull });
      if (!r?.ok) { setMsg({ ok: false, text: r?.error || r?.reason || '저장하지 못했습니다.' }); return; }
      setData((x) => ({ ...x, mail: r.mail, status: r.status })); setForm({ ...r.mail }); setToText(r.mail.to.join('\n'));
      setMsg({ ok: true, text: '저장했습니다.' });
    } catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(''); }
  };
  const sendNow = async () => {
    setBusy('send'); setMsg(null);
    try {
      // postJson 은 409(보내지 못함)를 던지지 않는다 — 결과 상태를 본다.
      const r = await postJson('/tools/storage-usage/mail/send-now', {});
      if (r?.status) setData((x) => ({ ...x, status: r.status }));
      if (!r?.ok) { setMsg({ ok: false, text: `보내지 않았습니다 — ${SKIP_TEXT[r?.code] || r?.reason || '사유 미상'}` }); return; }
      setMsg({ ok: true, text: r.to == null ? '보냈습니다.' : `보냈습니다(받는 사람 ${r.to}명).` });
    } catch (e) { setMsg({ ok: false, text: e.message }); load(); } finally { setBusy(''); }
  };
  const doPreview = async () => {
    setBusy('preview'); setMsg(null);
    try {
      const r = await postJson('/tools/storage-usage/mail/preview', { mail: formFull });
      if (!r?.ok) { setPreview(null); setMsg({ ok: false, text: r?.error || '미리보기를 만들지 못했습니다.' }); return; }
      setPreview(r);
    } catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(''); }
  };

  return (
    <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 420px), 1fr))', gap: 14, minWidth: 0 }}>
      <div className="card" style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 700, marginBottom: 10 }}>예약 메일 — 정한 요일·시각에 전체 사용량을 보냅니다</div>
        <label className="flex" style={{ gap: 8, alignItems: 'center', marginBottom: 10 }}>
          <input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} /> 예약 발송 켜기
        </label>
        <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>요일</div>
        <div className="flex gap wrap" style={{ gap: 6, marginBottom: 10 }}>
          {DAY_LABELS.map((l, i) => (
            <button key={l} type="button" className={`tab${form.days.includes(i) ? ' active' : ''}`} onClick={() => toggleDay(i)} aria-pressed={form.days.includes(i)}>{l}</button>
          ))}
        </div>
        <div className="flex gap wrap" style={{ gap: 10, alignItems: 'center', marginBottom: 10 }}>
          <span className="muted" style={{ fontSize: 12 }}>시각(포탈 시각)</span>
          <input className="input" type="time" value={form.time} onChange={(e) => set('time', e.target.value)} style={{ width: 120 }} />
        </div>
        <label className="flex" style={{ gap: 8, alignItems: 'center', marginBottom: 6 }}>
          <input type="checkbox" checked={form.includeAdmin} onChange={(e) => set('includeAdmin', e.target.checked)} />
          통합 관리자(설정 › 메일 발송의 기본 받는 사람 {data.adminTo?.length || 0}명) 포함
        </label>
        <div className="muted" style={{ fontSize: 12, margin: '6px 0 4px' }}>추가 받는 사람(줄바꿈·쉼표 구분, 최대 {data.limits?.listMax}명)</div>
        <textarea className="input" rows={4} value={toText} onChange={(e) => setToText(e.target.value)} style={{ width: '100%', resize: 'vertical' }} placeholder="ops@example.com" />
        {parsed.invalid.length > 0 && <div style={{ ...NOTE, color: 'var(--red)' }}>형식이 틀린 주소: {parsed.invalid.slice(0, 3).join(', ')}{parsed.invalid.length > 3 ? ` 외 ${parsed.invalid.length - 3}개` : ''} — 저장하면 거절됩니다.</div>}
        <label className="flex" style={{ gap: 8, alignItems: 'center', marginTop: 8 }}>
          <input type="checkbox" checked={form.attachExcel} onChange={(e) => set('attachExcel', e.target.checked)} /> 엑셀 첨부(누적된 전 주차 · 5시트)
        </label>
        <label className="flex" style={{ gap: 8, alignItems: 'center', marginTop: 4 }}>
          <input type="checkbox" checked={form.includeResources} onChange={(e) => set('includeResources', e.target.checked)} /> LUN·파일시스템 포함(조치 항목·엑셀)
        </label>
        <div style={{ ...NOTE, marginTop: 8 }}>
          <BoldText text={mailBodyText(data.rule, data.attachDataWeeks)} />
        </div>
        <div style={{ ...NOTE, marginTop: 8 }}>
          받는 사람 {rc}명 · 보내는 때 {form.enabled ? `${daysText(form.days)} ${form.time}` : '꺼짐'}. 화면의 법인·종류 필터는 메일에 적용되지 않습니다(전체 장비).
          켜거나 요일·시각을 바꾸면 오늘 이미 지난 시각은 보내지 않습니다. 메일 서버는 설정 › 메일 발송에서 정합니다.
        </div>
        <div className="flex gap wrap" style={{ gap: 8, marginTop: 12 }}>
          <button className="tab active" type="button" onClick={save} disabled={!!busy || parsed.invalid.length > 0}>{busy === 'save' ? '저장 중…' : '저장'}</button>
          <button className="tab" type="button" onClick={doPreview} disabled={!!busy}>{busy === 'preview' ? '만드는 중…' : '미리보기'}</button>
          <button className="tab" type="button" onClick={sendNow} disabled={!!busy || dirty} title={dirty ? '바뀐 칸을 먼저 저장하세요(저장된 설정으로 보냅니다).' : '저장된 설정으로 지금 한 통 보냅니다(예약 회차 기록은 바꾸지 않습니다).'}>
            {busy === 'send' ? '보내는 중…' : '지금 한 번 보내기'}
          </button>
        </div>
        {msg && <div style={{ ...NOTE, marginTop: 8, color: msg.ok ? 'var(--green)' : 'var(--red)' }}>{msg.text}</div>}
      </div>

      <div className="card" style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>상태</div>
        <div style={NOTE}>
          {st.edge ? '이 포탈은 엣지입니다 — 메일은 메인 포탈만 보냅니다. ' : ''}
          다음 발송: {(st.next || []).length ? st.next.map((x) => slotText(x, offsetMin)).join(' · ') : '없음(꺼짐)'}<br />
          마지막 발송: {st.lastSentAt ? slotText(st.lastSentAt, offsetMin) : '없음'}
        </div>
        <div style={{ fontWeight: 700, margin: '12px 0 6px' }}>최근 기록</div>
        {(st.history || []).length ? (
          <STable minWidth={520} style={{ fontSize: 12 }}>
            <thead><tr><th>시각</th><th>종류</th><th>결과</th><th>사유·받는 사람</th></tr></thead>
            <tbody>
              {st.history.map((h, i) => (
                <tr key={`${h.at}-${i}`}>
                  <td style={{ whiteSpace: 'nowrap' }} data-sort={h.at}>{slotText(h.at, offsetMin)}</td>
                  <td>{h.kind === 'manual' ? '지금 보내기' : '예약'}</td>
                  <td style={{ color: h.state === 'sent' ? 'var(--green)' : h.state === 'failed' ? 'var(--red)' : 'var(--amber)' }}>
                    {{ sent: '보냄', skipped: '생략', failed: '실패', missed: '놓침' }[h.state] || h.state}
                  </td>
                  <td style={{ whiteSpace: 'normal' }}>
                    {h.state === 'sent' ? sentText(h) : (SKIP_TEXT[h.code] || MISSED_TEXT[h.code] || h.reason || '')}
                  </td>
                </tr>
              ))}
            </tbody>
          </STable>
        ) : <div style={NOTE}>기록 없음</div>}
      </div>

      {preview && (
        <div className="card" style={{ minWidth: 0, gridColumn: '1 / -1' }}>
          <div className="flex gap wrap" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <div style={{ fontWeight: 700 }}>미리보기 — {preview.subject}</div>
            <button className="tab" type="button" onClick={() => setPreview(null)}>닫기</button>
          </div>
          <div style={NOTE}>받는 사람 {preview.recipients}명 · 장비 {preview.devices}대 · 보내지 않았습니다(미리보기에는 엑셀을 만들지 않습니다 — 같은 파일은 위의 ‘엑셀(주간 누적)’ 로 받을 수 있습니다).</div>
          <iframe title="스토리지 사용량 메일 미리보기" sandbox="" srcDoc={preview.html} style={{ width: '100%', height: 620, border: '1px solid var(--border)', borderRadius: 6, background: '#fff', marginTop: 8 }} />
        </div>
      )}
    </div>
  );
}
