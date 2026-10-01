/**
 * ExecOverview.jsx — Overview '경영 보기'(v2.670, 사용자 제공 시안 design_handoff_exec_overview).
 *
 * 개발 포탈 `#/overview` 에서 '경영 보기 ↔ 엔지니어 보기' 로 전환한다(엔지니어 보기 = 기존 Overview.jsx — 그대로 둔다).
 * 판정·문구는 전부 `execOverviewText.js`(순수 · vitest)가 소유한다 — 여기는 그리기만 한다.
 *
 * 데이터(새로 수집하지 않는다):
 *   /overview        15초 — 헤드라인·게이지·법인 행(사이트별 CPU/메모리/스토리지 %는 롤업에 이미 있다)
 *   /overview/cards  60초 — 핵심 지표 값·인벤토리
 *   /overview/trend  10분 — 스파크라인·증감(서버 5분 캐시. 기간을 바꾸면 다시 부른다)
 *   /alarms          60초 — 주의 항목 '장애'(inv.alarms 권한이 있을 때만)
 *   /tools/capacity-forecast · /tools/license-expiry — 주의 항목(도구 권한이 있을 때만, **마운트 1회** — 폴링 금지:
 *     capacity-forecast 는 실측 1.5초짜리 무거운 조회다 · v2.508 V4 규약)
 */
import React, { useEffect, useMemo, useState } from 'react';
import { usePolling, fetchJson, can, toolAllowed } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';
import STable from '../components/STable.jsx';
import { capText, countText, cardMeta, firstCollectNotice } from './overviewCardsText.js';
import {
  briefingStamp, gauges, regionCards, siteRowsExec, sortSiteRows, usageTone, TONE_VAR,
  sparkPaths, deltaText, trendNote, attentionItems, inventoryCells, gpuKpi, TREND_DAYS, DAYS_KEY, normDays,
} from './execOverviewText.js';

const readDays = () => { try { return normDays(window.localStorage.getItem(DAYS_KEY)); } catch { return 7; } };
const writeDays = (d) => { try { window.localStorage.setItem(DAYS_KEY, String(d)); } catch { /* 저장 실패는 기능을 막지 않는다 */ } };
const go = (hash) => { window.location.hash = hash; };

export default function ExecOverview({ onSelectSite, onGotoTab, modeToggle = null }) {
  const [days, setDays] = useState(readDays);
  const [sortBy, setSortBy] = useState('vms');
  const { data: ov, error, loading } = usePolling('/overview', {}, 15_000);
  const { data: cards } = usePolling('/overview/cards', {}, 60_000);
  const { data: trend, error: trendErr } = usePolling('/overview/trend', { days }, 600_000);
  const canAlarms = can('inv.alarms');
  const { data: alarmData, error: alarmErr } = usePolling(canAlarms ? '/alarms' : null, { severity: 'critical' }, 60_000);
  const canForecast = can('tools') && toolAllowed('forecast');
  const canLicenses = can('tools') && toolAllowed('license-expiry');
  const [forecast, setForecast] = useState(null);
  const [licenses, setLicenses] = useState(null);
  const [extErr, setExtErr] = useState({});
  useEffect(() => {
    let active = true;
    if (canForecast) fetchJson('/tools/capacity-forecast').then((r) => { if (active) setForecast(r); }).catch((e) => { if (active) setExtErr((x) => ({ ...x, '용량 예측': e?.status === 403 ? 'forbidden' : (e?.message || String(e)) })); });
    if (canLicenses) fetchJson('/tools/license-expiry').then((r) => { if (active) setLicenses(r); }).catch((e) => { if (active) setExtErr((x) => ({ ...x, '라이선스': e?.status === 403 ? 'forbidden' : (e?.message || String(e)) })); });
    return () => { active = false; };
  }, [canForecast, canLicenses]);

  const g = ov?.global || null;
  const rows = useMemo(() => sortSiteRows(siteRowsExec(ov?.sites), sortBy), [ov, sortBy]);
  const regions = useMemo(() => regionCards(ov?.sites), [ov]);
  const attention = useMemo(() => attentionItems({
    sites: ov?.sites || [], g, alarms: alarmData, forecast, licenses,
    can: { alarms: canAlarms, forecast: canForecast, licenses: canLicenses },
    errors: { 알람: alarmErr ? String(alarmErr) : '', ...extErr },
  }), [ov, g, alarmData, forecast, licenses, canAlarms, canForecast, canLicenses, alarmErr, extErr]);

  if (loading && !ov) return <Loading />;
  if (error && !ov) return <ErrorBox message={error} />;
  if (!ov) return null;
  // v2.675: 첫 병합 전 골격(initial)이면 0 대·'정상 운영 중' 헤드라인을 그리지 않는다(firstCollectNotice).
  const fc = firstCollectNotice(ov);
  if (!g || fc) return (
    <div className="muted" style={{ padding: 40, textAlign: 'center' }}>
      {fc ? <><b style={{ color: 'var(--text)' }}>{fc.title}</b><br />{fc.detail}</> : '수집 준비 중… (첫 vCenter 수집 완료 후 표시)'}
    </div>
  );

  const pbc = ov.physicalByCorp && !ov.physicalByCorp.error ? ov.physicalByCorp : null;
  const setD = (d) => { setDays(d); writeDays(d); };
  const t = trend && Number(trend.days) === days ? trend : null;

  const stor = cards?.storage;
  const gk = gpuKpi(cards);
  const kpis = [
    { key: 'virtual', label: '가상 서버', accent: 'var(--green)', value: countText(cards?.virtual?.count ?? g.vms), unit: '대',
      sub: cards?.virtual ? `구동 ${countText(cards.virtual.poweredOn)} · 템플릿 ${countText(cards.virtual.templates)} · vCenter ${countText(cards.virtual.vcenters)}` : `구동 ${countText(g.vmsPoweredOn)}`,
      t: t?.virtual, onClick: () => onGotoTab?.('vcenters') },
    { key: 'physical', label: '물리 서버', accent: 'var(--accent)', value: countText(cards?.physical?.count), unit: cards?.physical?.count != null ? '대' : '',
      sub: `가상화 호스트 ${countText(g.hosts)} · 물리 전용 ${countText(pbc?.physicalOnly)}`,
      t: t?.physical, onClick: () => go('#/tools/serveranalysis/info') },
    { key: 'storage', label: '스토리지 용량', accent: 'var(--accent-2)', value: capText(stor?.totalBytes), unit: '',
      sub: !stor ? '' : stor.reason ? stor.reason : stor.totalBytes == null ? cardMeta('storage', cards) : `사용 ${stor.usedPct == null ? '—' : `${stor.usedPct}%`} · ${capText(stor.usedBytes)} 사용 중${stor.usedUnknown ? ` · 사용량 모름 ${stor.usedUnknown}대` : ''}${stor.stale ? ` · 오래된 값 ${stor.stale}대 제외` : ''}`,
      t: t?.storage, onClick: stor?.reason ? undefined : () => go('#/tools/storage-mon') },
    // v2.677: 소비 전력 카드 자리 — 네트워크 스위치 수량(CVP 등록 장비). 수량 추이는 기록하지 않는다.
    { key: 'network', label: '네트워크 스위치', accent: 'var(--amber)', value: countText(cards?.network?.count), unit: cards?.network?.count != null ? '대' : '',
      sub: cardMeta('network', cards),
      t: cards?.network ? { reason: 'no-series' } : null, onClick: cards?.network?.reason ? undefined : () => go('#/tools/cvp') },
    // v2.678: GPU 카드 수량 — iDRAC 인벤토리 기준(gpuKpi). 수량 추이는 기록하지 않는다.
    { key: 'gpus', label: 'GPU 카드', accent: 'var(--purple)', value: countText(gk.value), unit: gk.value != null ? '장' : '',
      sub: gk.sub, t: cards?.gpus ? { reason: 'no-series' } : null, onClick: () => go('#/tools/serveranalysis/gpu') },
  ];

  return (
    <div className="xov">
      {error && <div className="banner" style={{ marginBottom: 4 }}>갱신 실패(직전 데이터 표시 중): {String(error)}</div>}

      {/* 1. 헤드라인 */}
      <div className="xov-head">
        <div style={{ minWidth: 0 }}>
          <div className="xov-eyebrow"><i />Executive Briefing{briefingStamp(ov.generatedAt) ? ` · ${briefingStamp(ov.generatedAt)}` : ''}</div>
        </div>
        <div className="xov-head-right">
          {modeToggle}
          <div className="xov-pills" role="group" aria-label="추이 기간">
            {TREND_DAYS.map((d) => (
              <button key={d} type="button" className={`xov-pill${d === days ? ' on' : ''}`} aria-pressed={d === days} onClick={() => setD(d)}>{d}일</button>
            ))}
          </div>
        </div>
      </div>

      {/* 2. 핵심 지표 스트립 */}
      <div className="xov-strip">
        {kpis.map((k) => <KpiCell key={k.key} k={k} days={days} trendErr={trendErr} />)}
      </div>

      {/* 3. 자원 사용률 · 리전별 워크로드 */}
      <div className="xov-2col">
        <div className="xov-card">
          <div className="xov-title-row">
            <div className="xov-title"><b>▸</b> 글로벌 자원 사용률</div>
            <div className="xov-legend">
              <span><i style={{ background: 'var(--green)' }} />정상</span>
              <span><i style={{ background: 'var(--amber)' }} />75%↑ 주의</span>
              <span><i style={{ background: 'var(--red)' }} />90%↑ 위험</span>
            </div>
          </div>
          <div className="xov-rings">
            {gauges(g).map((x) => <Ring key={x.key} {...x} />)}
          </div>
          {g.hostsUsageExcluded > 0 && <div className="xov-note">연결이 끊겨 사용량을 읽지 못한 호스트 {countText(g.hostsUsageExcluded)}대는 CPU·메모리 사용률 계산에서 뺐습니다.</div>}
        </div>
        <div className="xov-card">
          <div className="xov-title"><b>▸</b> 리전별 워크로드</div>
          {regions.some((r) => r.vms > 0) ? (
            <div className="xov-regbar">
              {regions.filter((r) => r.pct > 0).map((r) => <span key={r.key} style={{ width: `${r.pct}%`, background: r.color }} title={`${r.key} ${r.pct}%`} />)}
            </div>
          ) : <div className="xov-note">아직 가상 서버 수를 센 법인이 없습니다.</div>}
          <div className="xov-regions">
            {regions.map((r) => (
              <div key={r.key} className="xov-region">
                <div className="xov-region-top"><span><i style={{ background: r.color }} />{r.key}</span><em>{r.pct == null ? '—' : `${r.pct}%`}</em></div>
                <div className="xov-region-v">{countText(r.vms)}<small> VM</small></div>
                <div className="xov-region-d">{r.desc}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 4. 법인별 현황 + 주의 항목 */}
      <div className="xov-row">
        <div className="xov-card xov-sites">
          <div className="xov-title-row">
            <div className="xov-title"><b>▸</b> 법인별 현황</div>
            <div className="xov-seg" role="group" aria-label="정렬">
              <button type="button" className={sortBy === 'vms' ? 'on' : ''} onClick={() => setSortBy('vms')}>가상 서버 많은 순</button>
              <button type="button" className={sortBy === 'risk' ? 'on' : ''} onClick={() => setSortBy('risk')}>사용률 높은 순</button>
            </div>
          </div>
          <STable className="xov-table" minWidth={620}>
            <thead><tr><th>법인</th><th>가상 서버</th><th>CPU</th><th>메모리</th><th>스토리지</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="xov-site-row" role="button" tabIndex={0} title="클릭하면 이 법인의 호스트 목록으로 이동합니다"
                  onClick={() => onSelectSite?.(r.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectSite?.(r.id); } }}>
                  <td data-sort={r.city}>
                    <div className="xov-site">
                      <i style={{ background: TONE_VAR[r.dot], boxShadow: r.dot === 'none' ? 'none' : `0 0 6px ${TONE_VAR[r.dot]}` }} />
                      <div style={{ minWidth: 0 }}>
                        <div className="xov-site-name">{r.city}{r.mark && <span className="badge" style={{ marginLeft: 6, fontSize: 10.5 }} title={r.markTitle || undefined}>{r.mark}</span>}</div>
                        <div className="xov-site-sub">{r.sub}</div>
                      </div>
                    </div>
                  </td>
                  <td data-sort={r.vms ?? ''}>
                    <div className="xov-vmcell">
                      <div className="xov-vmbar">{r.vmPct != null && <span style={{ width: `${Math.max(2, r.vmPct)}%` }} />}</div>
                      <b>{r.vms == null ? '—' : countText(r.vms)}</b>
                    </div>
                  </td>
                  <UseCell v={r.cpu} /><UseCell v={r.mem} /><UseCell v={r.sto} />
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={5} className="muted">표시할 법인이 없습니다.</td></tr>}
            </tbody>
          </STable>
        </div>
        <div className="xov-card xov-attn">
          <div className="xov-title-row">
            <div className="xov-title warn"><b>▸</b> 주의가 필요한 항목</div>
            <span className="xov-count">{attention.total ? `${countText(attention.total)}건` : ''}</span>
          </div>
          {attention.items.map((a, i) => (
            <div key={`${a.tag}-${a.vc}-${i}`} className="xov-attn-item">
              <div className="xov-attn-top"><span className={`badge ${a.tone}`}>{a.tag}</span><em>{a.vc}</em></div>
              <div className="xov-attn-title">{a.title}</div>
              {a.desc && <div className="xov-attn-desc">{a.desc}</div>}
            </div>
          ))}
          {!attention.items.length && <div className="xov-note">지금 확인한 원천에서는 주의 항목이 없습니다.</div>}
          {attention.omitted > 0 && <div className="xov-note">외 {countText(attention.omitted)}건은 생략했습니다.</div>}
          {attention.skipped.length > 0 && <div className="xov-note">확인하지 못한 원천: {attention.skipped.join(' · ')}</div>}
        </div>
      </div>

      {/* 5. 인벤토리 스트립 */}
      <div className="xov-inv">
        {inventoryCells(cards, g).map((c) => {
          const click = c.hash ? () => go(c.hash) : c.tab ? () => onGotoTab?.(c.tab) : null;
          return (
            <div key={c.key} className={`xov-inv-cell${click ? ' click' : ''}`} title={c.title}
              role={click ? 'button' : undefined} tabIndex={click ? 0 : undefined} onClick={click || undefined}
              onKeyDown={click ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); click(); } } : undefined}>
              <div className="xov-inv-l">{c.label}</div>
              <div className="xov-inv-v">{c.value}</div>
            </div>
          );
        })}
      </div>

      {/* 6. 각주 */}
      <div className="xov-foot">
        사용률 임계값(75% · 90%)은 엔지니어 보기와 같습니다. 가상 서버 추이는 매일 00시·12시 스냅샷, 스토리지 추이는 스토리지 모니터링 용량 이력이며,
        일부 장비·법인만 집계된 구간은 그리지 않습니다. 네트워크 스위치는 CVP 등록 장비 수입니다. 소진 시점은 선형 추정치입니다. 금액 환산은 표시하지 않습니다.
      </div>
    </div>
  );
}

function KpiCell({ k, days, trendErr }) {
  const tr = k.t;
  const sp = sparkPaths(tr?.series);
  const dt = deltaText(k.key, tr?.delta, days);
  const note = trendErr && !tr ? '추이를 읽지 못했습니다' : trendNote(k.key, tr);
  return (
    <div className={`xov-kpi${k.onClick ? ' click' : ''}`} style={{ '--kpi-accent': k.accent }}
      role={k.onClick ? 'button' : undefined} tabIndex={k.onClick ? 0 : undefined} onClick={k.onClick}
      onKeyDown={k.onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); k.onClick(); } } : undefined}>
      <div className="xov-kpi-top"><span>{k.label}</span>{dt && <em style={{ color: k.deltaTone || '#4ade80' }}>{dt}</em>}</div>
      <div className="xov-kpi-v">{k.value}{k.value !== '—' && k.unit && <small>{k.unit}</small>}</div>
      <svg className="xov-spark" viewBox="0 0 240 48" preserveAspectRatio="none" aria-hidden="true">
        {sp.area && <path d={sp.area} fill={k.accent} fillOpacity=".10" />}
        {sp.line && <path d={sp.line} fill="none" stroke={k.accent} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />}
        {sp.dots.map((d, i) => <circle key={i} cx={d.x} cy={d.y} r="2" fill={k.accent} />)}
      </svg>
      <div className="xov-kpi-sub">{k.sub}</div>
      {note && <div className="xov-kpi-note">{note}</div>}
    </div>
  );
}

function Ring({ label, pct, basis }) {
  const r = 52; const c = 2 * Math.PI * r;
  const tone = usageTone(pct);
  const col = TONE_VAR[tone];
  const frac = pct == null ? 0 : Math.max(0, Math.min(100, pct)) / 100;
  return (
    <div className="xov-ring">
      <div className="xov-ring-box">
        <svg viewBox="0 0 120 120">
          <circle cx="60" cy="60" r={r} fill="none" stroke="var(--border-soft)" strokeWidth="8" />
          {pct != null && <circle cx="60" cy="60" r={r} fill="none" stroke={col} strokeWidth="8" strokeLinecap="round"
            strokeDasharray={`${(c * frac).toFixed(1)} ${c.toFixed(1)}`} transform="rotate(-90 60 60)" />}
        </svg>
        <div className="xov-ring-mid"><b>{pct == null ? '—' : pct}{pct != null && <small>%</small>}</b><span>{label}</span></div>
      </div>
      <div className="xov-ring-basis">{basis}</div>
    </div>
  );
}

function UseCell({ v }) {
  const tone = usageTone(v);
  const color = tone === 'bad' ? '#f87171' : tone === 'warn' ? '#fbbf24' : undefined;
  return (
    <td data-sort={v ?? ''}>
      <div className="xov-use"><span style={{ color }}>{v == null ? '—' : `${v}%`}</span>
        <div className="xov-use-bar">{v != null && <i style={{ width: `${Math.max(2, Math.min(100, v))}%`, background: TONE_VAR[tone] }} />}</div>
      </div>
    </td>
  );
}
