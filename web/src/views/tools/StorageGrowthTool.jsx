import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { fetchJson, postJson } from '../../api.js';
import { Loading, ErrorBox, Modal } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import {
  GROWTH_UNITS, bytesAuto, bytesIn, growthCell, totalCell,
  fullEtaText, headline, missingNote, heat, maxAbsFor,
} from './storageGrowthText.js';

/**
 * 특수기능 › 스토리지 증가량(v2.531) — **임원 보고서 형태**.
 *
 * 사용자 요청(2026-09-16): "특수기능에 스토리지 증가량이라는 메뉴를 별도로 만들어서, 전체
 * 스토리지를 보여주고 기간별로 스토리지 용량이 얼마나 증가하고 있는지 매트릭스 형태로" ·
 * "장비별로 1일, 1주, 1달, 3개월 등 지정한 기간으로 증가량" · "증가 단위는 1기가/1TB 단위로 구분" ·
 * "임원 보고용 보고서 형태로 멋지게".
 *
 * ── 화면 설계 의도 ──────────────────────────────────────────────────────────────
 *  · 보고서처럼 **위에서 아래로 한 번에 읽힌다**: 표제 → 핵심 수치 4개 → 증가량 매트릭스 →
 *    주의가 필요한 장비 → 단서(무엇을 못 봤는가).
 *  · 매트릭스는 **장비 × 기간**이고 칸의 배경 농도가 그 열에서의 상대 크기다(눈으로 큰 칸을 찾게).
 *  · **판정·문구는 전부 `storageGrowthText.js`(순수)** 가 소유한다 — 여기서 다시 판정하지 않는다.
 *
 * ⚠ **폴링하지 않는다.** 일 롤업을 읽을 뿐이라 장비 왕복은 없지만 5년 × 장비수 행을 매번 읽는다.
 *   마운트 시 1회 + '새로고침' 버튼만. 재진입 가드(`busy`)를 둔다.
 * ⚠ **`null` 을 `0` 으로 그리지 말 것** — 증가량 `null` 은 '기준선이 없어 계산 못 함' 이다.
 *   `growthCell()` 이 그 구분을 갖고 있으니 직접 숫자를 만들지 말 것.
 */

const LS_UNIT = 'storageGrowth.unit';
const LS_PERIODS = 'storageGrowth.periods';

/** localStorage 는 프라이빗 창에서 throw 한다 — 반드시 try/catch(CLAUDE.md 규약). */
const lsGet = (k, d) => { try { return window.localStorage.getItem(k) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { window.localStorage.setItem(k, v); } catch { /* 무시 */ } };

/** 사용자가 고를 수 있는 기간 조합(사용자 예시 "1일, 1주, 1달, 3개월 등"). */
const PERIOD_PRESETS = [
  { key: 'short', label: '단기', days: '1,7,30', hint: '1일 · 1주 · 1개월' },
  { key: 'std', label: '표준', days: '1,7,30,90', hint: '1일 · 1주 · 1개월 · 3개월' },
  { key: 'long', label: '장기', days: '30,90,180,365', hint: '1개월 · 3개월 · 6개월 · 1년' },
  { key: 'all', label: '전체', days: '1,7,30,90,180,365', hint: '1일부터 1년까지 6개 기간' },
];

const TONE_COLOR = { up: 'var(--red)', down: 'var(--green, #37d67a)', flat: 'var(--text-dim)', none: 'var(--text-faint)' };

export default function StorageGrowthTool() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [unit, setUnit] = useState(() => lsGet(LS_UNIT, 'auto'));
  const [periods, setPeriods] = useState(() => lsGet(LS_PERIODS, '1,7,30,90'));
  const [detail, setDetail] = useState(null);
  const [showSettings, setShowSettings] = useState(false);

  const load = useCallback((p) => {
    setBusy(true);
    return fetchJson(`/tools/storage-growth?periods=${encodeURIComponent(p)}`)
      .then((r) => { setD(r); setErr(null); })
      .catch((e) => setErr(e.message))
      .finally(() => setBusy(false));
  }, []);

  // ⚠ 폴링 없음 — 마운트 1회 + 기간이 바뀔 때만.
  useEffect(() => { load(periods); }, [load, periods]);

  const head = useMemo(() => headline(d, unit), [d, unit]);
  const miss = useMemo(() => missingNote(d?.noHistory), [d]);
  const cols = d?.periods || [];
  // 열마다 따로 정규화한다 — 1일 증가량과 1년 증가량을 같은 척도로 칠하면 1일 열이 전부 하얘진다.
  const maxAbs = useMemo(() => {
    const m = {};
    for (const p of cols) m[p.key] = maxAbsFor(d?.devices, p.key);
    return m;
  }, [d, cols]);

  if (err && !d) return <ErrorBox error={err} />;
  if (!d) return <Loading />;

  const t = d.totals || {};

  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr)', minWidth: 0, gap: 14 }}>

      {/* ── 보고서 표제 ─────────────────────────────────────────────── */}
      <div className="card" style={{ padding: '18px 20px', borderLeft: '4px solid var(--accent)' }}>
        <div className="flex gap wrap" style={{ alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div className="muted" style={{ fontSize: 11.5, letterSpacing: 1.2, textTransform: 'uppercase', fontWeight: 700 }}>
              Storage Growth Report
            </div>
            <h2 style={{ margin: '4px 0 0', fontSize: 23, fontWeight: 800, letterSpacing: -0.3 }}>스토리지 증가량 보고서</h2>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 6, whiteSpace: 'normal', lineHeight: 1.65 }}>
              <b style={{ color: 'var(--text)' }}>{head.title}</b>
              {head.body ? <> — <BoldText text={head.body} /></> : null}
            </div>
          </div>
          <div className="flex gap wrap" style={{ gap: 8, alignItems: 'center', flex: 'none' }}>
            <button className="tab" onClick={() => load(periods)} disabled={busy}
              title="저장된 일 단위 이력을 다시 읽습니다(장비에 접속하지 않습니다).">
              {busy ? '불러오는 중…' : '↻ 새로고침'}
            </button>
            <button className="tab" onClick={() => setShowSettings(true)} title="사용량을 몇 년치 보관할지 정합니다.">⚙ 저장 기간</button>
          </div>
        </div>
      </div>

      {/* ── 핵심 수치 ───────────────────────────────────────────────── */}
      <div className="kpis">
        <ReportKpi label="전체 용량" value={bytesAuto(t.totalBytes)} meta={`${t.devices ?? 0}대 합계`} />
        <ReportKpi label="사용 중" value={bytesAuto(t.usedBytes)}
          meta={t.pct != null ? `${t.pct}%` : '사용률 미상'} tone={t.pct >= 90 ? 'bad' : t.pct >= 75 ? 'warn' : 'ok'} />
        <ReportKpi label="남은 용량" value={bytesAuto(t.freeBytes)} meta="전체 − 사용" />
        {cols.map((p) => {
          const c = totalCell(t.growth?.[p.key], unit);
          return <ReportKpi key={p.key} label={`${p.label} 증가`} value={c.text} meta={c.partial ? '일부만 합산' : ''}
            tone={c.partial ? 'warn' : c.tone === 'up' ? 'bad' : 'ok'} title={c.title} />;
        })}
      </div>

      {/* 합계가 '전체' 가 아닐 때는 반드시 먼저 말한다 — 임원 보고에서 가장 위험한 거짓이다. */}
      {cols.some((p) => t.growth?.[p.key]?.partial) && (
        <Note tone="warn" text={`**합계가 전 장비 기준이 아닙니다.** 기간별로 기준선(비교 시작일)이 없는 장비는 그 열의 합계에서 빠졌습니다 — 각 칸에 마우스를 올리면 몇 대를 더했는지 나옵니다. 관측이 그 기간만큼 쌓이면 자동으로 포함됩니다.`} />
      )}
      {t.unknownUsed > 0 && (
        <Note tone="warn" text={`**사용량을 읽지 못한 장비 ${t.unknownUsed}대**가 합계에서 빠졌습니다 — 0 으로 채우지 않았습니다(‘용량 0’ 이라는 거짓을 만들지 않기 위해서입니다).`} />
      )}

      {/* ── 조회 조건 ───────────────────────────────────────────────── */}
      <div className="card" style={{ padding: '10px 14px' }}>
        <div className="flex gap wrap" style={{ alignItems: 'center', gap: 14 }}>
          <span className="muted" style={{ fontSize: 12, fontWeight: 700 }}>기간</span>
          {PERIOD_PRESETS.map((p) => (
            <button key={p.key} className={`tab${periods === p.days ? ' active' : ''}`} title={p.hint}
              onClick={() => { setPeriods(p.days); lsSet(LS_PERIODS, p.days); }}>{p.label}</button>
          ))}
          <span style={{ width: 1, height: 18, background: 'var(--border)' }} />
          <span className="muted" style={{ fontSize: 12, fontWeight: 700 }}>증가 단위</span>
          {GROWTH_UNITS.map((u) => (
            <button key={u.key} className={`tab${unit === u.key ? ' active' : ''}`} title={u.hint}
              onClick={() => { setUnit(u.key); lsSet(LS_UNIT, u.key); }}>{u.label}</button>
          ))}
          <span className="muted" style={{ fontSize: 11.5, marginLeft: 'auto' }}>
            기준일 {d.asOfLabel} · 저장 기간 {d.retention?.dailyKeepDays}일
            {d.retention?.dailyKeepDaysSource === 'default' ? '(기본값)' : '(지정값)'}
          </span>
        </div>
      </div>

      {/* ── 증가량 매트릭스 ─────────────────────────────────────────── */}
      <div className="card" style={{ padding: '14px 16px', minWidth: 0 }}>
        <SectionTitle n="01" title="장비별 증가량 매트릭스"
          sub="칸의 배경 농도는 그 기간 열 안에서의 상대 크기입니다. 값에 마우스를 올리면 기준선 날짜와 실제 비교 구간이 나옵니다." />
        {d.devices.length === 0
          ? <Note tone="info" text={head.body || '아직 집계할 이력이 없습니다.'} />
          : (
            <div style={{ overflowX: 'auto', minWidth: 0 }}>
              <STable className="rpt-table">
                <thead>
                  <tr>
                    <th>장비</th>
                    <th className="right">사용 / 전체</th>
                    <th className="right">사용률</th>
                    {cols.map((p) => <th key={p.key} className="right">{p.label} 증가</th>)}
                    <th className="right">소진 예상</th>
                    <th data-nosort>관측</th>
                  </tr>
                </thead>
                <tbody>
                  {d.devices.map((dev) => <DeviceRow key={dev.deviceId} dev={dev} cols={cols} unit={unit} maxAbs={maxAbs} onOpen={() => setDetail(dev)} />)}
                  <tr data-pin>
                    <td><b>합계</b></td>
                    <td className="right" data-sort={String(t.usedBytes ?? '')}>
                      <b>{bytesAuto(t.usedBytes) ?? '—'}</b> <span className="muted">/ {bytesAuto(t.totalBytes) ?? '—'}</span>
                    </td>
                    <td className="right">{t.pct != null ? `${t.pct}%` : '—'}</td>
                    {cols.map((p) => {
                      const c = totalCell(t.growth?.[p.key], unit);
                      return (
                        <td key={p.key} className="right" title={c.title} data-sort={String(t.growth?.[p.key]?.bytes ?? '')}>
                          <b style={{ color: TONE_COLOR[c.tone] }}>{c.text}</b>
                          {c.partial ? <sup style={{ color: 'var(--amber)', marginLeft: 2 }} title={c.title}>부분</sup> : null}
                        </td>
                      );
                    })}
                    <td className="right">—</td>
                    <td>—</td>
                  </tr>
                </tbody>
              </STable>
            </div>
          )}
      </div>

      {/* ── 주의가 필요한 장비 ───────────────────────────────────────── */}
      <WatchList devices={d.devices} cols={cols} unit={unit} />

      {/* ── 단서(무엇을 못 봤는가) ───────────────────────────────────── */}
      <div className="card" style={{ padding: '14px 16px' }}>
        <SectionTitle n="03" title="이 보고서가 말하지 않는 것"
          sub="수치를 결재 근거로 쓰기 전에 함께 보셔야 하는 전제입니다." />
        <ul className="muted" style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.85, whiteSpace: 'normal' }}>
          {miss && <li><BoldText text={miss.text} />{miss.names?.length ? <> <span style={{ opacity: 0.8 }}>({miss.names.join(', ')}{miss.omitted ? ` 외 ${miss.omitted}대` : ''})</span></> : null}</li>}
          <li><BoldText text={`증가량은 **하루 1행으로 요약한 값**(그 날의 마지막 관측)을 비교합니다 — 하루 안의 등락은 보이지 않습니다.`} /></li>
          <li><BoldText text={`요청한 날짜에 수집이 없으면 **그 이전 가장 가까운 날**과 비교하고, 그 칸의 설명에 실제 구간을 적습니다.`} /></li>
          <li><BoldText text={`소진 예상은 **그 추세가 그대로 이어진다고 가정한 산술 계산**이며 예측이 아닙니다. 근거로 쓴 기간을 칸 설명에 적었습니다.`} /></li>
          <li>
            원시 표본은 {d.retention?.rawKeepDays}일, 일 단위 요약은 {d.retention?.dailyKeepDays}일 보관합니다
            (기준일 {d.asOfLabel}, 하루 경계는 UTC{d.dayOffsetMin >= 0 ? '+' : ''}{Math.round((d.dayOffsetMin || 0) / 60)}시 기준).
          </li>
        </ul>
      </div>

      {detail && <DeviceTrend dev={detail} unit={unit} onClose={() => setDetail(null)} />}
      {showSettings && <RetentionModal onClose={() => setShowSettings(false)} onSaved={() => { setShowSettings(false); load(periods); }} />}
    </div>
  );
}

/* ══ 조각들 ═══════════════════════════════════════════════════════════ */

function SectionTitle({ n, title, sub }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="flex gap" style={{ alignItems: 'baseline', gap: 8 }}>
        <span className="muted" style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1 }}>{n}</span>
        <b style={{ fontSize: 15 }}>{title}</b>
      </div>
      {sub && <div className="muted" style={{ fontSize: 12, marginTop: 3, whiteSpace: 'normal', lineHeight: 1.6 }}>{sub}</div>}
    </div>
  );
}

function ReportKpi({ label, value, meta, tone, title }) {
  const color = tone === 'bad' ? 'var(--red)' : tone === 'warn' ? 'var(--amber)' : undefined;
  return (
    <div className="kpi" title={title || undefined}>
      <div className="label">{label}</div>
      <div className="value" style={{ color, fontSize: 25 }}>{value ?? '—'}</div>
      {meta ? <div className="meta">{meta}</div> : null}
    </div>
  );
}

function Note({ tone, text }) {
  const c = tone === 'warn' ? 'var(--amber)' : tone === 'bad' ? 'var(--red)' : 'var(--border)';
  return (
    <div className="card" style={{ padding: '10px 14px', borderColor: c, borderLeft: `3px solid ${c}` }}>
      <div className="muted" style={{ fontSize: 12.5, whiteSpace: 'normal', lineHeight: 1.7 }}><BoldText text={text} /></div>
    </div>
  );
}

function DeviceRow({ dev, cols, unit, maxAbs, onOpen }) {
  const eta = fullEtaText(dev.daysToFull);
  return (
    <tr>
      <td>
        {/* 표 안의 클릭 가능한 텍스트에 링크 파랑을 쓰지 않는다(v2.527 규약) — 점선 밑줄로 알린다. */}
        <span role="button" tabIndex={0} onClick={onOpen}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
          title={`${dev.name} · ${dev.host || ''} — 클릭하면 일 단위 추이를 봅니다`}
          style={{ color: 'inherit', fontWeight: 700, cursor: 'pointer', textDecoration: 'underline dotted', textUnderlineOffset: 3,
            display: 'block', maxWidth: 190, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {dev.name}
        </span>
        <div className="muted" style={{ fontSize: 11, maxWidth: 190, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {dev.type}{dev.host ? ` · ${dev.host}` : ''}
        </div>
      </td>
      <td className="right" data-sort={String(dev.usedBytes ?? '')}>
        <b>{bytesAuto(dev.usedBytes) ?? '—'}</b> <span className="muted">/ {bytesAuto(dev.totalBytes) ?? '—'}</span>
      </td>
      <td className="right" data-sort={String(dev.pct ?? '')}
        style={{ color: dev.pct >= 90 ? 'var(--red)' : dev.pct >= 75 ? 'var(--amber)' : undefined, fontWeight: 700 }}>
        {dev.pct != null ? `${dev.pct}%` : '—'}
      </td>
      {cols.map((p) => {
        const g = dev.growth?.[p.key];
        const c = growthCell(g, unit);
        const h = heat(g?.bytes, maxAbs[p.key]);
        // 히트맵: 증가는 붉게, 감소는 푸르게. 농도는 그 열 안에서의 상대 크기다.
        const bg = c.tone === 'up' ? `rgba(229,72,77,${(h * 0.32).toFixed(3)})`
          : c.tone === 'down' ? `rgba(55,214,122,${(h * 0.26).toFixed(3)})` : 'transparent';
        return (
          <td key={p.key} className="right" title={c.title} data-sort={String(g?.bytes ?? '')}
            style={{ background: bg, color: TONE_COLOR[c.tone], fontWeight: c.tone === 'none' ? 400 : 700 }}>
            {c.text}
            {/* 요청한 기간과 실제 구간이 다르면 조용히 넘어가지 않는다.
                ⚠ **값이 없는 칸('—')에는 붙이지 않는다** — 비교 자체를 못 했는데 '근사 구간'
                이라 표시하면 뜻이 없고 기호 오류처럼 보인다(v2.531 스크린샷 판독에서 발견). */}
            {c.tone !== 'none' && c.exact === false ? <sup style={{ color: 'var(--amber)', marginLeft: 2 }}>≈</sup> : null}
          </td>
        );
      })}
      <td className="right" data-sort={String(dev.daysToFull?.days ?? '')}
        title={eta?.title} style={{ color: eta?.tone === 'bad' ? 'var(--red)' : eta?.tone === 'warn' ? 'var(--amber)' : undefined }}>
        {eta?.text ?? '—'}
      </td>
      {/* '관측' 은 **그 장비가 가진 전체 이력**이다(조회 구간이 아니다 — 그것을 섞으면
          700일치를 가진 장비가 '92일' 로 보인다. v2.531 스크린샷 판독에서 발견한 결함). */}
      <td data-sort={String(dev.observedDays ?? '')}>
        <span className="muted" style={{ fontSize: 11.5 }}
          title={`첫 관측 ${dev.firstLabel || '—'} · 최근 ${dev.latestLabel || '—'}${dev.gapDays ? ` · 수집이 없던 날 ${dev.gapDays}일` : ''}`}>
          {dev.observedDays}일{dev.gapDays ? <span style={{ color: 'var(--amber)' }} title={`${dev.gapDays}일은 수집 기록이 없습니다`}> +{dev.gapDays}결측</span> : null}
        </span>
      </td>
    </tr>
  );
}

/**
 * 주의가 필요한 장비 — **가장 긴 기간의 증가량**과 사용률·소진 예상으로 고른다.
 * ⚠ 후보가 없으면 '문제 없음' 이라 단정하지 않는다 — '기준에 걸린 장비가 없다' 고만 말한다.
 */
function WatchList({ devices, cols, unit }) {
  const key = cols[cols.length - 1]?.key;
  const rows = useMemo(() => (devices || [])
    .map((d) => ({ d, eta: d.daysToFull?.days ?? null, g: d.growth?.[key]?.bytes ?? null }))
    .filter((x) => (x.eta != null && x.eta < 365) || (x.d.pct != null && x.d.pct >= 75))
    .sort((a, b) => (a.eta ?? 1e9) - (b.eta ?? 1e9) || (b.d.pct ?? 0) - (a.d.pct ?? 0))
    .slice(0, 8), [devices, key]);

  return (
    <div className="card" style={{ padding: '14px 16px' }}>
      <SectionTitle n="02" title="주의가 필요한 장비"
        sub="사용률 75% 이상이거나, 현재 추세로 1년 안에 가득 차는 장비입니다." />
      {!rows.length
        ? <div className="muted" style={{ fontSize: 12.5, whiteSpace: 'normal' }}>
            기준(사용률 75% 이상 · 1년 내 소진)에 걸린 장비가 없습니다. <b>문제가 없다는 뜻은 아닙니다</b> — 관측이 짧아 추세를 내지 못한 장비는 애초에 후보에 들지 못합니다.
          </div>
        : (
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 10, minWidth: 0 }}>
            {rows.map(({ d }) => {
              const eta = fullEtaText(d.daysToFull);
              const c = growthCell(d.growth?.[key], unit);
              return (
                <div key={d.deviceId} className="card" style={{ padding: '11px 13px', minWidth: 0,
                  borderLeft: `3px solid ${eta?.tone === 'bad' ? 'var(--red)' : eta?.tone === 'warn' ? 'var(--amber)' : 'var(--border)'}` }}>
                  <div style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.name}>{d.name}</div>
                  <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>{d.type}{d.host ? ` · ${d.host}` : ''}</div>
                  <div style={{ marginTop: 8, display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 12.5 }}>
                    <span>사용률 <b style={{ color: d.pct >= 90 ? 'var(--red)' : 'var(--amber)' }}>{d.pct != null ? `${d.pct}%` : '—'}</b></span>
                    <span title={c.title}>{cols[cols.length - 1]?.label} <b style={{ color: TONE_COLOR[c.tone] }}>{c.text}</b></span>
                    <span title={eta?.title}>소진 <b style={{ color: eta?.tone === 'bad' ? 'var(--red)' : undefined }}>{eta?.text ?? '—'}</b></span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
    </div>
  );
}

/** 장비 상세 — 일 단위 추이. 여는 순간 1회만 조회한다. */
function DeviceTrend({ dev, unit, onClose }) {
  const [p, setP] = useState(null);
  const [err, setErr] = useState(null);
  const [days, setDays] = useState(365);
  useEffect(() => {
    let live = true;
    fetchJson(`/tools/storage-growth/${encodeURIComponent(dev.deviceId)}/daily?days=${days}`)
      .then((r) => { if (live) { setP(r); setErr(null); } })
      .catch((e) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [dev.deviceId, days]);

  const data = useMemo(() => (p?.points || []).map((x) => ({
    label: x.label, used: x.usedBytes == null ? null : x.usedBytes / 1024 ** 4, total: x.totalBytes == null ? null : x.totalBytes / 1024 ** 4, samples: x.samples,
  })), [p]);

  return (
    <Modal title={`스토리지 증가 추이 — ${dev.name}`} onClose={onClose} width={920}>
      <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 10, gap: 8 }}>
        {[30, 90, 365, 1825].map((n) => (
          <button key={n} className={`tab${days === n ? ' active' : ''}`} onClick={() => setDays(n)}>
            {n >= 365 ? `${Math.round(n / 365)}년` : `${n}일`}
          </button>
        ))}
        <span className="muted" style={{ fontSize: 11.5, marginLeft: 'auto' }}>단위 TB · 하루 1점(그 날의 마지막 관측)</span>
      </div>
      {err && <ErrorBox error={err} />}
      {!p && !err && <Loading />}
      {p && !data.length && (
        <div className="muted" style={{ fontSize: 12.5, whiteSpace: 'normal' }}>
          이 구간에 저장된 일 단위 요약이 없습니다. 수집이 성공한 날부터 하루 1행씩 쌓입니다.
        </div>
      )}
      {!!data.length && (
        <div style={{ height: 300 }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 6, right: 12, bottom: 4, left: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} minTickGap={40} />
              <YAxis tick={{ fontSize: 11 }} width={58} />
              {/* connectNulls={false} — 수집이 없던 날을 직선으로 이어 '그날도 값이 있었다' 고 말하지 않는다. */}
              <Tooltip contentStyle={{ background: 'var(--panel)', border: '1px solid var(--border)', fontSize: 12 }}
                formatter={(v, n) => [v == null ? '—' : `${Number(v).toFixed(2)} TB`, n === 'used' ? '사용' : '전체']} />
              <Area type="monotone" dataKey="total" stroke="var(--text-faint)" fill="var(--panel-2)" fillOpacity={0.5} connectNulls={false} />
              <Area type="monotone" dataKey="used" stroke="var(--accent)" fill="var(--accent)" fillOpacity={0.25} connectNulls={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
      <div className="muted" style={{ fontSize: 11.5, marginTop: 8, whiteSpace: 'normal', lineHeight: 1.7 }}>
        <BoldText text={`수집이 없던 날은 **선을 잇지 않습니다** — 이어 그리면 그 날도 값이 있었던 것처럼 보입니다. 첫 관측 ${dev.firstLabel || '—'} · 최근 ${dev.latestLabel || '—'} · 관측 ${dev.observedDays}일.`} />
      </div>
    </Modal>
  );
}

/** 저장 기간 설정 — 서버가 준 SPEC 으로 폼을 그린다(숫자를 화면에 박지 않는다). */
function RetentionModal({ onClose, onSaved }) {
  const [s, setS] = useState(null);
  const [form, setForm] = useState({});
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [prune, setPrune] = useState(false);

  useEffect(() => {
    fetchJson('/tools/storage-growth/settings')
      .then((r) => { setS(r); setForm(Object.fromEntries(r.spec.map((x) => [x.key, r.values[x.key]]))); })
      .catch((e) => setMsg(`오류: ${e.message}`));
  }, []);

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await postJson('/tools/storage-growth/settings', { ...form, prune });
      setMsg((r.issues || []).length ? `저장했습니다 — ${r.issues.join(' ')}` : `저장했습니다.${r.pruned ? ' 보존 기간을 넘은 이력을 정리했습니다.' : ''}`);
      onSaved?.();
    } catch (e) { setMsg(`오류: ${e.message}`); } finally { setBusy(false); }
  };

  return (
    <Modal title="사용량 저장 기간" onClose={onClose} width={640}>
      {!s && !msg && <Loading />}
      {s && (
        <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr)', gap: 14, minWidth: 0 }}>
          {s.spec.map((x) => (
            <div key={x.key}>
              <div style={{ fontWeight: 700, fontSize: 13.5 }}>{x.label}</div>
              <div className="muted" style={{ fontSize: 12, margin: '3px 0 7px', whiteSpace: 'normal', lineHeight: 1.6 }}>{x.hint}</div>
              <div className="flex gap wrap" style={{ alignItems: 'center', gap: 7 }}>
                {(x.presets || []).map((p) => (
                  <button key={p.days} className={`tab${Number(form[x.key]) === p.days ? ' active' : ''}`}
                    onClick={() => setForm((f) => ({ ...f, [x.key]: p.days }))}>{p.label}</button>
                ))}
                {/* minWidth:0 이 없으면 숫자칸이 설명문 폭으로 자라 옆 칸과 겹친다(v2.520 실측). */}
                <input type="number" min={x.min} max={x.max} value={form[x.key] ?? ''} style={{ width: 110, minWidth: 0 }}
                  onChange={(e) => setForm((f) => ({ ...f, [x.key]: e.target.value }))} />
                <span className="muted" style={{ fontSize: 11.5 }}>일 ({x.min}~{x.max})</span>
              </div>
            </div>
          ))}
          <label className="flex gap" style={{ alignItems: 'flex-start', gap: 8, fontSize: 12.5 }}>
            <input type="checkbox" checked={prune} onChange={(e) => setPrune(e.target.checked)} style={{ marginTop: 3 }} />
            <span className="muted" style={{ whiteSpace: 'normal', lineHeight: 1.6 }}>
              <BoldText text="저장하면서 **기간을 넘은 이력을 지금 정리**합니다. 지운 이력은 되돌릴 수 없습니다 — 체크하지 않으면 다음 수집 때 서서히 정리됩니다." />
            </span>
          </label>
          {msg && <div className="muted" style={{ fontSize: 12.5, whiteSpace: 'normal' }}>{msg}</div>}
          <div className="flex gap" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <button className="tab" onClick={onClose}>닫기</button>
            <button className="login-btn" style={{ flex: 'none', padding: '6px 16px' }} disabled={busy} onClick={save}>
              {busy ? '저장 중…' : '저장'}
            </button>
          </div>
        </div>
      )}
      {!s && msg && <div className="muted" style={{ fontSize: 12.5 }}>{msg}</div>}
    </Modal>
  );
}
