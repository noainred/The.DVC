/**
 * insight-tools/VmToolPanels.jsx — VM 분석 화면의 특수 기능 요약 패널(v3.21.0 · docs/design/vm-insight §4-1 · §8 · §10 · 시안 VmInsight.dc.html).
 *
 * 본체(VmInsight.jsx)와의 약속(바꾸지 말 것):
 *   default export — props { vcIds: string[](빈 배열 = 범위 안 전부), rows: object[](VM 집계 법인 줄), group: 'capacity'|'perf'|'config', canTool: (toolKey) => boolean }
 *   · capacity = 디스크가 차 가는 VM(게스트 파티션 · §4-1) · 꺼진 VM(§8) · VM 수 추이 · 생성/삭제(§10)
 *   · perf = CPU 경합 · 디스크 지연(§10) · config = VM 구성 점검(§10). 오래된 스냅샷 패널은 본체가 그린다.
 *   · (선택) only: 패널 키 배열('disk' · 'off' · 'trend' · 'contention' · 'hygiene') — 본체가 패널 사이에 다른 패널을 끼울 때 쓴다.
 *
 * 규약:
 *  · 패널마다 그 도구의 요약 모드를 **마운트 1회 + ‘다시 받기’** 로 받는다(15초 폴링 없음) — 다른 패널을 기다리지 않는다.
 *  · canTool(key) 가 거짓이면 그 패널을 그리지 않고 요청도 보내지 않는다(§6 ⑪ — 요약이 새지 않게).
 *  · 수는 고른 법인(vcIds)의 줄을 더하고 상위 5 는 법인별 상위 5 를 합쳐 다시 고른다(vmToolPanelsText · toolSumText).
 *  · 기준값은 응답 값 · 못 읽은 값은 ‘—’ · 판정 밖은 따로 센다.
 */
import { unitText } from '../../unitText.js'; // v3.21.0: 값이 없으면 단위 없는 ‘—’(BUG-20 규약)
import React, { useState } from 'react';
import './vmTools.css';
import { useToolSummary } from './useToolSummary.js';
import {
  fmtN, fmtU, fmt1, gbText, pctText, corpNameOf, missingText, synthNote, barPct, toolLabel, gateOf,
} from './toolSumText.js';
import {
  guestPartView, offView, trackView, lifeView, contentionView, contentionRule, contentionEmpty, hygieneView, slotText, dayText, osName, HYGIENE_CODE_ROWS, WARM, NEUTRAL,
} from './vmToolPanelsText.js';
import { OFF_SRC_SHORT } from '../../tools/wasteViewText.js';
import { SCAN_OFF_NOTE } from '../../contention/contentionText.js';
import { toolAllowed } from '../../../api.js';
import { PanelHead, PanelState, ToolLink, Gauge, TopTable, NameCell } from './ToolParts.jsx';
import { Hero, MiniStats, StackBar, RankBars } from '../../insight/InsightParts.jsx';   // 분석 화면 공용 부품(숫자 · 작은 타일 · 조각 막대 · 순서 막대)

export const PANEL_GROUPS = Object.freeze({
  capacity: Object.freeze(['disk', 'off', 'trend']),
  perf: Object.freeze(['contention']),
  config: Object.freeze(['hygiene']),
});

/** 패널 → 필요한 도구 키(하나라도 허용이면 그 패널을 그린다 — 추이 패널은 두 도구를 나눠 그린다). */
export const PANEL_TOOLS = Object.freeze({
  disk: Object.freeze(['guest-partition']),
  off: Object.freeze(['waste']),
  trend: Object.freeze(['vm-track', 'vm-lifecycle']),
  contention: Object.freeze(['contention']),
  hygiene: Object.freeze(['vm-hygiene']),
});

/** 그릴 패널 목록(순수 — 권한 없는 패널은 뺀다). */
export function panelsFor(group, canTool, only = null) {
  const can = typeof canTool === 'function' ? canTool : () => false;
  const list = PANEL_GROUPS[group] || [];
  return list.filter((p) => (!Array.isArray(only) || only.includes(p)) && PANEL_TOOLS[p].some((k) => can(k)));
}

/** 작은 타일 — tone 'c'(빨강) · 's'(주황)을 공용 MiniStats 의 글자색으로. */
const STAT_COLOR = { c: '#fca5a5', s: '#fdba74' };
function Stats({ items }) {
  return <MiniStats stats={(items || []).map((x) => ({ key: x.key, value: x.big, text: x.text, color: STAT_COLOR[x.tone] || undefined, tip: x.title }))} />;
}

const sevColor = (sev) => (sev === 'crit' ? WARM[3].bg : sev === 'warn' ? WARM[1].bg : NEUTRAL.bg);

function Foot({ resp, missing, nameOf }) {
  const a = synthNote(resp);
  const b = missingText(missing, nameOf);
  if (!a && !b) return null;
  return <>{b && <div className="vit-note">{b}</div>}{a && <div className="vit-note">{a}</div>}</>;
}

/* ───────────── 디스크가 차 가는 VM ───────────── */
function DiskPanel({ vcIds, rows }) {
  const q = useToolSummary('/tools/guest-partition', null, { timeoutMs: 60_000, retries: 0 });   // 도구 화면과 같은 넉넉한 시한 · 한 번만(캐시 없는 DB 조회)
  const v = guestPartView(q.data, vcIds);
  const nameOf = corpNameOf(rows, q.data?.rows);
  const thrText = v ? (v.thrMixed ? '기준 법인별' : v.thr == null ? '' : `기준 ${v.thr}%`) : '';
  const rule = v ? [thrText, v.critPct == null ? '' : `위험 ${v.critPct}%`].filter(Boolean).join(' · ') : '';
  const thrWord = v?.thrMixed ? '기준(법인별)' : v?.thr == null ? '기준' : `기준 ${v.thr}%`;
  return (
    <section className="vit-panel" aria-label="디스크가 차 가는 VM">
      <PanelHead title="디스크가 차 가는 VM" hint={`VM 안의 드라이브 · 마운트 사용률 — 특수 기능 ‘${toolLabel('guest-partition')}’ 의 요약입니다`} rule={rule} q={q} onReload={q.reload} />
      <PanelState q={q} view={v} waitText="게스트 파티션 요약을 받는 중입니다(파티션 수가 많으면 오래 걸릴 수 있습니다)…">
        {v && (
          <div className="vit-gp">
            <div className="vit-sum">
              <Hero value={fmtN(v.overVms)} text={v.noValues ? '아직 수집된 파티션 값이 없습니다 — 값을 받은 VM 이 0대라 초과 수를 모릅니다(0 이 아닙니다)' : `대 — 파티션 ${fmtU(v.overParts, '개')}가 ${thrWord} 이상 · 값을 받은 VM ${fmtU(v.reported, '대')} 중 ${pctText(v.overVms, v.reported)}`} />
              <Stats items={[
                { key: 'crit', tone: 'c', big: v.crit == null ? '—' : `${fmtU(v.crit, '개')}`, text: `위험 — 사용률 ${unitText(v.critPct, '%')} 이상`, title: '사용률이 위험 기준 이상인 파티션' },
                { key: 'soon', tone: 's', big: v.soon == null ? '—' : `${fmtU(v.soon, '개')}`, text: `${v.soonDays ?? '—'}일 안에 가득 참 예상`, title: `지난 ${v.growthDays ?? '—'}일의 증가 속도가 이어지면 가득 차는 파티션 — 예상일 뿐입니다` },
                { key: 'nr', big: `${fmtU(v.notReported, '대')}`, text: '판정 밖 — 파티션 값을 받지 못한 VM', title: `VMware Tools 가 파티션을 알려 주지 않은 VM(꺼진 VM ${fmtU(v.offNotReported, '대')} 포함) — 0% 가 아니라 모르는 것입니다` },
              ]} />
              <StackBar tall segs={v.bands.map((b) => ({ key: b.key, label: b.label, n: b.n, bg: b.bg, ink: b.ink }))} label="초과 파티션의 사용률 구간" />
              {!v.noValues && <div className="vit-note">초과 VM — Windows {fmtN(v.os.win || 0)} · Linux {fmtN(v.os.lnx || 0)}{v.os.other ? ` · 그 밖 ${fmtN(v.os.other)}` : ''}</div>}
              {v.collect && v.collect.enabled === false && <div className="vit-note warn">게스트 파티션 수집이 꺼져 있습니다(도구 설정) — 아래 수는 마지막으로 받은 값입니다.</div>}
              {v.collect && v.collect.empty === true && <div className="vit-note">아직 쌓인 파티션 값이 없습니다.</div>}
              {v.staleCorps > 0 && <div className="vit-note warn">{fmtU(v.staleCorps, '곳')}은 파티션 값이 오래됐습니다(도구의 보관 시한을 넘김).</div>}
              <ToolLink toolKey="guest-partition" vcIds={vcIds}>{toolLabel('guest-partition')}에서 모두 보기 →</ToolLink>
              <Foot resp={q.data} missing={v.missing} nameOf={nameOf} />
            </div>
            <div className="vit-lst">
              <div className="vit-lh"><b>가장 찬 파티션</b><span>사용률이 높은 순 {fmtU(v.fullest.length, '개')} · 흰 세로줄 = 기준</span></div>
              <TopTable label="가장 찬 파티션" cols={[{ label: '파티션', width: '46%' }, { label: '사용률 · 남은 용량' }, { label: '사용률', cls: 'r', width: '64px' }]}
                empty="이 범위에는 기준을 넘긴 파티션이 없습니다."
                rows={v.fullest.map((p, i) => ({ key: `${p.vmId}-${p.path}-${i}`, cells: [
                  { node: <NameCell name={p.vmName} sub={`${nameOf(p.vcenterId)} · ${osName(p.os)} · ${p.path || '—'}`} />, sort: p.vmName },
                  { node: <Gauge w={p.pct} bg={v.bandColor(p.pct).bg} mark={p.thr ?? v.thr} note={`남은 ${gbText(p.freeGB)} / ${gbText(p.capGB)}`} />, sort: p.freeGB },
                  { node: <span className="vit-big hero">{p.pct == null ? '—' : `${fmt1(p.pct)}%`}</span>, sort: p.pct, cls: 'r' },
                ] }))} />
            </div>
            <div className="vit-lst">
              <div className="vit-lh"><b>곧 가득 찰 파티션</b><span>지난 {v.growthDays ?? '—'}일의 증가(+GB)로 본 예상 · 빠른 순</span></div>
              <TopTable label="곧 가득 찰 파티션" cols={[{ label: '파티션', width: '46%' }, { label: '사용률 · 증가' }, { label: '남은 일수', cls: 'r', width: '72px' }]}
                empty={`이 범위에는 ${v.soonDays ?? '—'}일 안에 가득 찰 것으로 보이는 파티션이 없습니다.`}
                rows={v.soonest.map((p, i) => ({ key: `${p.vmId}-${p.path}-${i}`, cells: [
                  { node: <NameCell name={p.vmName} sub={`${nameOf(p.vcenterId)} · ${osName(p.os)} · ${p.path || '—'}`} />, sort: p.vmName },
                  { node: <Gauge w={p.pct} bg={v.bandColor(p.pct).bg} mark={p.thr ?? v.thr} note={`${p.growth7dGB == null ? '—' : `+${gbText(p.growth7dGB)}`} · 남은 ${gbText(p.freeGB)}`} />, sort: p.pct },
                  { node: <span className="vit-big hero">{p.etaDays == null ? '—' : `${Math.round(p.etaDays)}일`}</span>, sort: p.etaDays, cls: 'r', title: '지난 증가가 이어진다는 가정의 예상입니다' },
                ] }))} />
            </div>
          </div>
        )}
      </PanelState>
    </section>
  );
}

/* ───────────── 꺼진 VM ───────────── */
function OffPanel({ vcIds, rows, canTool }) {
  const q = useToolSummary('/tools/waste');
  const qs = useToolSummary('/tools/waste/off-since', null, { timeoutMs: 60_000, retries: 0 });   // 두 단계 — DB 조회라 따로 · 수 · 디스크를 먼저 그린다
  const [sort, setSort] = useState('disk');
  const v = offView(q.data, qs.data, vcIds);
  const nameOf = corpNameOf(rows, q.data?.rows);
  const src = qs.data?.sources;
  const rule = src?.observedEnabled && src?.observedIntervalHours ? `점검 주기 ${src.observedIntervalHours}시간` : '';
  const byDays = sort === 'days' && v?.byDays;
  const list = v ? (byDays ? v.byDays : v.byDisk) : [];
  const listMax = list.reduce((a, x) => Math.max(a, Number(x.storageGB) || 0), 0);
  const corps = v ? v.corps.slice(0, 6) : [];
  const corpMax = corps.reduce((a, c) => Math.max(a, c.gb || 0), 0);
  const reload = () => { q.reload(); qs.reload(); };
  return (
    <section className="vit-panel" aria-label="꺼진 VM">
      <PanelHead title="꺼진 VM" hint={`전원이 꺼진 VM(템플릿 제외) — 특수 기능 ‘${toolLabel('waste')}’ 의 ‘전원 꺼짐’ 조사(꺼진 지 며칠) 요약입니다`} rule={rule}
        q={{ ...q, loading: q.loading || qs.loading }} onReload={reload} />
      {/* r140: 꺼진 지(off-since) 값이 있는데 다시 받기가 실패하면 그것도 ‘다시 받기에 실패’ 로 밝힌다 — 예전에는 waste 의 오류만 보아 옛 구간 · 목록이 조용히 남았다 */}
      <PanelState q={q.data ? { ...q, error: q.error || (qs.data && qs.error) || null } : q} view={v} waitText="꺼진 VM 요약을 받는 중입니다…">
        {v && (
          <div className="vit-gp">
            <div className="vit-sum">
              <Hero value={fmtN(v.count)} text={`대 — 디스크 ${gbText(v.diskGB)} 를 잡고 있습니다 · 템플릿을 뺀 VM ${fmtU(v.vms, '대')} 중 ${pctText(v.count, v.vms)}`} />
              <Stats items={[
                { key: 'cpu', big: fmtN(v.vcpu), text: '잡고 있는 vCPU(할당)', title: '꺼진 VM 에 준 vCPU — 켜기 전에는 쓰지 않지만 다시 켜면 필요합니다' },
                { key: 'mem', big: gbText(v.memGB), text: '잡고 있는 메모리(할당)', title: '꺼진 VM 에 준 메모리' },
                { key: 'snap', tone: 's', big: `${fmtU(v.withSnap, '대')}`, text: '스냅샷도 남아 있는 VM', title: '꺼져 있으면서 스냅샷이 있는 VM — 정리 후보' },
              ]} />
              {v.bands
                ? <StackBar tall segs={v.bands.map((b) => ({ key: b.key, label: b.label, n: b.n, bg: b.bg, ink: b.ink }))} label="꺼진 지 구간" />
                : <div className="vit-note">{qs.loading ? '꺼진 지(며칠)를 찾는 중입니다…' : qs.error ? '꺼진 지(며칠)를 받지 못했습니다 — ‘다시 받기’ 를 눌러 보세요.' : ''}</div>}
              <div className="vit-note">꺼진 지는 도구가 찾은 출처(이벤트 · VM 추적 · 주기 점검 · 처음 본 때)로 셉니다 — 찾지 못한 VM 은 ‘모름’ 이고 0일로 넣지 않습니다.</div>
              {(v.diskUnknown > 0 || v.allocUnknown > 0) && (
                <div className="vit-note warn">{[v.diskUnknown > 0 ? `디스크 용량을 못 읽은 ${fmtU(v.diskUnknown, '대')}` : '', v.allocUnknown > 0 ? `vCPU · 메모리를 못 읽은 ${fmtU(v.allocUnknown, '대')}` : ''].filter(Boolean).join(' · ')}는 합에서 뺐습니다.</div>
              )}
              <ToolLink toolKey="waste" sub="off" vcIds={vcIds}>‘{toolLabel('waste')} › 전원 꺼짐’ 에서 모두 보기 →</ToolLink>
              {typeof canTool === 'function' && canTool('zombie-vms') && <ToolLink secondary toolKey="zombie-vms" vcIds={vcIds}>오래 방치된 VM · 고아 VM 은 ‘{toolLabel('zombie-vms')}’ 에서 →</ToolLink>}
              <Foot resp={q.data} missing={v.missing} nameOf={nameOf} />
            </div>
            <div className="vit-lst">
              <div className="vit-lh">
                <b>꺼진 VM</b>
                <span className="vit-seg" role="group" aria-label="정렬">
                  <button type="button" aria-pressed={sort === 'disk'} onClick={() => setSort('disk')}>디스크 큰 순</button>
                  <button type="button" aria-pressed={sort === 'days'} disabled={!v.byDays} title={!v.byDays ? '꺼진 지(며칠)를 아직 받지 못했습니다' : undefined} onClick={() => setSort('days')}>오래 꺼진 순</button>
                </span>
                <span>{fmtU(list.length, '대')}</span>
              </div>
              <TopTable label="꺼진 VM" cols={[{ label: 'VM', width: '46%' }, { label: byDays ? '꺼진 지' : '잡은 디스크' }, { label: byDays ? '일수' : '디스크', cls: 'r', width: '84px' }]}
                empty="이 범위에는 꺼진 VM 이 없습니다."
                rows={list.map((x, i) => ({ key: `${x.id || x.name}-${i}`, cells: byDays ? [
                  { node: <NameCell name={x.name} sub={`${nameOf(x.vcenterId)} · 디스크 ${gbText(x.storageGB)}`} />, sort: x.name },
                  { node: <Gauge w={barPct(x.offDays, list[0]?.offDays)} bg={WARM[1].bg} note={x.offDays == null ? '꺼진 지 모름' : `출처 ${OFF_SRC_SHORT[x.source] || x.source || '—'}${x.exact ? '' : ' · 하한'}`} />, sort: x.offDays },
                  { node: <span className="vit-big hero">{x.offDays == null ? '—' : `${fmtU(x.offDays, '일')}${x.exact ? '' : ' 이상'}`}</span>, sort: x.offDays, cls: 'r' },
                ] : [
                  { node: <NameCell name={x.name} sub={`${nameOf(x.vcenterId)} · ${x.guestOS || '—'}`} />, sort: x.name },
                  { node: <Gauge w={barPct(x.storageGB, listMax)} bg={WARM[1].bg} />, sort: x.storageGB },
                  { node: <span className="vit-big hero">{gbText(x.storageGB)}</span>, sort: x.storageGB, cls: 'r' },
                ] }))} />
            </div>
            <div className="vit-lst">
              <div className="vit-lh"><b>법인별</b><span>꺼진 VM 이 잡은 디스크가 큰 순</span></div>
              {!corps.length && <div className="vit-empty">이 범위에는 꺼진 VM 이 없습니다.</div>}
              {corps.map((c) => (
                <div key={c.vcenterId} className="vit-oc" title={`${nameOf(c.vcenterId)} — 꺼진 VM ${fmtU(c.n, '대')} · 디스크 ${gbText(c.gb)}`}>
                  <span className="nm">{nameOf(c.vcenterId)}</span>
                  <span><span className="vit-duo" style={{ width: `${barPct(c.gb, corpMax)}%` }}><i className="d" style={{ flex: '1 1 0' }} /></span></span>
                  <span className="tx"><b>{gbText(c.gb)}</b> · {fmtU(c.n, '대')}</span>
                </div>
              ))}
              {v.corps.length > corps.length && <div className="vit-note">그 밖 {fmtU(v.corps.length - corps.length, '곳')}은 도구에서 봅니다.</div>}
            </div>
          </div>
        )}
      </PanelState>
    </section>
  );
}

/* ───────────── VM 수 추이 · 생성/삭제 ───────────── */
function TrendPanel({ vcIds, rows, canTool }) {
  const canTrack = canTool('vm-track');
  const canLife = canTool('vm-lifecycle');
  const qt = useToolSummary('/tools/vm-track', null, { enabled: canTrack });
  const ql = useToolSummary('/tools/vm-lifecycle', null, { enabled: canLife });
  const t = trackView(qt.data, vcIds);
  const l = lifeView(ql.data, vcIds);
  const nameOf = corpNameOf(rows, qt.data?.rows || ql.data?.rows);
  const rule = [t?.days != null ? `추이 ${t.days}일` : '', l?.days != null ? `생성/삭제 지난 ${l.days}일` : ''].filter(Boolean).join(' · ');
  const reload = () => { if (canTrack) qt.reload(); if (canLife) ql.reload(); };
  // 두 도구 중 하나라도 값이 있으면 그린다 — 둘 다 못 받았을 때만 오류(권한 안내 포함) 자리.
  //   r140: 값이 있는 도구의 다시 받기 실패는 싣는다(PanelState 의 ‘다시 받기에 실패했습니다 — 아래는 … 값입니다’) — 예전에는 값이 하나라도 있으면 오류를 null 로 지워
  //   다시 받기가 실패해도 옛 값만 조용히 남았다(useToolSummary 규약: error 와 data 가 함께 있으면 값 + 실패 안내). 처음부터 못 온 쪽은 아래 ‘받지 못했습니다’ 줄이 밝힌다.
  const staleErr = (canTrack && qt.data && qt.error) || (canLife && ql.data && ql.error) || null;
  const main = { data: qt.data || ql.data, error: !qt.data && !ql.data ? (qt.error || ql.error) : staleErr, loading: qt.loading || ql.loading, at: qt.at || ql.at };
  const span = t && t.max != null && t.min != null ? t.max - t.min : 0;
  const yOf = (n) => (span > 0 ? ((n - t.min) / span) * 100 : 50);
  return (
    <section className="vit-panel" aria-label="VM 수 추이와 생성 · 삭제">
      <PanelHead title="VM 수 추이 · 생성/삭제"
        hint={`특수 기능 ${[canTrack ? `‘${toolLabel('vm-track')}’` : '', canLife ? `‘${toolLabel('vm-lifecycle')}’` : ''].filter(Boolean).join(' · ')} 의 요약입니다`}
        rule={rule} q={main} onReload={reload} />
      <PanelState q={main} waitText="추이 · 생성/삭제 요약을 받는 중입니다…">
        <div className="vit-gp">
          <div className="vit-sum">
            {canTrack && t && (t.current != null
              ? <Hero value={fmtN(t.current)} text={t.diff == null ? (t.slotsMixed ? '대 — 지금 VM 수(법인마다 첫 기록 · 마지막 기록 시각이 달라 증감을 말하지 않습니다)' : '대 — 지금 VM 수') : `대 — ${t.baseSlot ? slotText(t.baseSlot) : '창의 첫 기록'}보다 ${t.diff > 0 ? '+' : ''}${fmtN(t.diff)}(${fmtN(t.base)} → ${fmtN(t.current)})`} />
              : <div className="vit-note">{t.empty ? '' : '고른 법인 중 지금 값이 없는 곳이 있어 합과 증감을 말하지 않습니다.'}</div>)}
            {canTrack && qt.error && !qt.data && <div className="vit-note warn">VM 수 추이를 받지 못했습니다.</div>}
            {canLife && l && (
              <>
                <Stats items={[
                  { key: 'a', big: l.added == null ? '—' : `+${fmtN(l.added)}`, text: `지난 ${l.days ?? '—'}일 생성`, title: '새로 만듦 · 복제 · 템플릿 배포 · 인벤토리 등록' },
                  { key: 'r', big: fmtN(l.removed), text: `지난 ${l.days ?? '—'}일 삭제`, title: '지우거나 인벤토리에서 뺀 VM' },
                  { key: 'n', tone: (l.net || 0) > 0 ? 's' : '', big: l.net == null ? '—' : `${l.net > 0 ? '+' : ''}${fmtN(l.net)}`, text: '순증(생성 − 삭제)', title: '도구가 센 순증' },
                ]} />
                {/* 고른 법인이 모두 수집 밖이면 ‘기록이 없다’ 고 단정하지 않는다(dbg3221 8회차 — 아래 수집 밖 안내만) */}
                {!l.allNotCollected && <div className="vit-note">{l.kinds.filter((k) => k.n > 0).map((k) => `${k.label} ${fmtN(k.n)}`).join(' · ') || '이 기간에 기록된 생성 · 삭제가 없습니다.'}</div>}
                {l.truncated && <div className="vit-note warn">이벤트가 많아 도구가 읽는 상한에서 잘렸습니다 — 수는 하한입니다.</div>}
                {l.notCollected > 0 && <div className="vit-note warn">{l.allNotCollected ? `고른 법인 ${fmtU(l.notCollected, '곳')} 모두 이벤트를 수집하지 않아 생성 · 삭제를 세지 못했습니다.` : `이벤트를 수집하지 않는 법인 ${fmtU(l.notCollected, '곳')}은 세지 않았습니다.`}</div>}
              </>
            )}
            {canLife && ql.error && !ql.data && <div className="vit-note warn">생성 · 삭제 이력을 받지 못했습니다.</div>}
            {canTrack && <ToolLink toolKey="vm-track" vcIds={vcIds}>‘{toolLabel('vm-track')}’ 에서 보기 →</ToolLink>}
            {canLife && <ToolLink secondary toolKey="vm-lifecycle" vcIds={vcIds}>누가 무엇을 만들고 지웠는지는 ‘{toolLabel('vm-lifecycle')}’ 에서 →</ToolLink>}
            <Foot resp={qt.data || ql.data} missing={(t || l)?.missing} nameOf={nameOf} />
          </div>
          {canTrack && (
            <div className="vit-lst">
              <div className="vit-lh"><b>VM 수</b>{t && !t.empty && <span>수집 시점 순 {fmtU(t.points.length, '점')} · 세로 눈금은 {fmtN(t.min)} ~ {fmtN(t.max)}(0 부터가 아닙니다)</span>}</div>
              {!t || t.empty
                ? <div className="vit-empty">{qt.loading ? '받는 중…' : '쌓인 추이가 아직 없습니다 — 기록이 쌓이면 그려집니다.'}</div>
                : (
                  <>
                    <div className="vit-dots" role="img" aria-label={`VM 수 ${fmtN(t.min)} ~ ${fmtN(t.max)}`}>
                      <span className="yl yt">{fmtN(t.max)}</span><span className="yl yb">{fmtN(t.min)}</span>
                      {t.points.map((p, i) => (
                        <i key={p.slot} className={p.partial ? 'p' : ''} style={{ left: `${t.points.length > 1 ? (i / (t.points.length - 1)) * 100 : 50}%`, bottom: `${yOf(p.total)}%` }}
                          title={`${slotText(p.slot)} · VM ${fmtU(p.total, '대')}${p.partial ? ` — 부분 합(${fmtU(p.missingCorps, '곳')} 값 없음)` : ''}`} />
                      ))}
                    </div>
                    <div className="vit-axis"><span>{slotText(t.points[0].slot)}</span><span>{slotText(t.points[t.points.length - 1].slot)}</span></div>
                    {t.partialPoints > 0 && <div className="vit-note">속이 빈 점 = 부분 합(그때 값이 없는 법인이 있습니다) {fmtU(t.partialPoints, '점')}.</div>}
                  </>
                )}
            </div>
          )}
          {canLife && (
            <div className="vit-lst">
              <div className="vit-lh"><b>날마다 생성 · 삭제</b><span>파랑 = 생성 · 회색 = 삭제</span></div>
              {!l || !l.series.length
                ? <div className="vit-empty">{ql.loading ? '받는 중…' : l?.allNotCollected ? '이벤트를 수집하지 않는 법인이라 날마다 수가 없습니다.' : '기록된 날이 없습니다.'}</div>
                : l.series.map((s) => (
                  <div key={s.day} className="vit-oc" title={`${dayText(s.day)} — 생성 ${fmtN(s.added)} · 삭제 ${fmtN(s.removed)}${s.partial ? ' · 이 날은 기간의 일부만 셌습니다' : ''}`}>
                    <span className="nm">{dayText(s.day)}{s.partial ? ' (일부)' : ''}</span>
                    <span><span className="vit-duo" style={{ width: `${barPct(s.added + s.removed, l.seriesMax)}%` }}>
                      {s.added > 0 && <i className="a" style={{ flex: `${s.added} 1 0` }} />}{s.removed > 0 && <i className="u" style={{ flex: `${s.removed} 1 0` }} />}
                    </span></span>
                    <span className="tx"><b>+{fmtN(s.added)}</b> · 삭제 {fmtN(s.removed)}</span>
                  </div>
                ))}
            </div>
          )}
        </div>
      </PanelState>
    </section>
  );
}

/* ───────────── CPU 경합 · 디스크 지연 ───────────── */
function ContentionPanel({ vcIds, rows }) {
  const q = useToolSummary('/tools/contention');
  const v = contentionView(q.data, vcIds);
  const nameOf = corpNameOf(rows, q.data?.rows);
  const th = v?.th || {};
  const rule = contentionRule(v);
  const readyMax = v ? v.ready.reduce((a, x) => Math.max(a, Number(x.readyAvg) || 0), 0) : 0;
  const diskOf = (x) => Math.max(Number(x.readAvg) || 0, Number(x.writeAvg) || 0);
  const diskMax = v ? v.disk.reduce((a, x) => Math.max(a, diskOf(x)), 0) : 0;
  return (
    <section className="vit-panel" aria-label="CPU 경합과 디스크 지연">
      <PanelHead title="CPU 경합 · 디스크 지연" hint={`VM 이 CPU 를 기다리는 시간(Ready)과 디스크 응답 시간 — 특수 기능 ‘${toolLabel('contention')}’ 의 요약입니다`} rule={rule} q={q} onReload={q.reload} />
      <PanelState q={q} view={v} waitText="경합 요약을 받는 중입니다…">
        {v && (
          <div className="vit-gp">
            <div className="vit-sum">
              <Hero value={fmtN(v.readyCrit)} text={v.noValues ? (v.off ? '측정이 꺼져 있어 CPU 대기 판정이 없습니다(0 이 아닙니다)' : '측정한 VM 이 0대라 CPU 대기 판정을 모릅니다(0 이 아닙니다)') : `대 — CPU 대기(Ready)가 ${unitText(th.readyCrit, '%')} 이상입니다. 사용률이 낮아도 호스트가 붐비면 VM 이 기다립니다`} />
              <Stats items={[
                { key: 'rw', tone: 's', big: `${fmtU(v.readyWarn, '대')}`, text: `CPU 대기 경고(${unitText(th.readyWarn, '%')} 이상)`, title: `Ready 평균이 ${unitText(th.readyWarn, '%')} 이상 ${unitText(th.readyCrit, '%')} 미만` },
                { key: 'co', tone: 's', big: `${fmtU(v.costop, '대')}`, text: 'Co-stop(vCPU 끼리 기다림)', title: 'vCPU 가 많은 VM 이 서로를 기다리는 시간' },
                { key: 'dc', tone: 'c', big: `${fmtU(v.diskCrit, '대')}`, text: `디스크 지연 심각(${unitText(th.diskCrit, 'ms')} 이상)`, title: `디스크 읽기 · 쓰기 응답이 ${unitText(th.diskCrit, 'ms')} 이상 — 경고(${unitText(th.diskWarn, 'ms')} 이상)는 ${fmtU(v.diskWarn, '대')}` },
              ]} />
              {v.off && <div className="vit-note warn">{SCAN_OFF_NOTE}</div>}
              <div className="vit-note">구동 VM {fmtU(v.poweredOn, '대')} 중 {fmtU(v.measured, '대')}를 측정했습니다 — 측정하지 못한 {fmtU(v.notMeasured, '대')}는 판정 밖입니다.{(v.stale || 0) > 0 ? ` 측정값이 오래된 VM ${fmtU(v.stale, '대')}.` : ''}</div>
              {v.initial && <div className="vit-note warn">첫 측정 중입니다 — 수가 아직 다 차지 않았습니다.</div>}
              <ToolLink toolKey="contention" vcIds={vcIds}>‘{toolLabel('contention')}’ 에서 모두 보기 →</ToolLink>
              <Foot resp={q.data} missing={v.missing} nameOf={nameOf} />
            </div>
            <div className="vit-lst">
              <div className="vit-lh"><b>CPU 대기가 큰 VM</b><span>대기(Ready) 평균이 큰 순</span></div>
              <TopTable label="CPU 대기가 큰 VM" cols={[{ label: 'VM', width: '46%' }, { label: '대기 평균 · 최고' }, { label: '평균', cls: 'r', width: '64px' }]}
                empty={contentionEmpty(v, '이 범위에는 CPU 대기 판정이 붙은 VM 이 없습니다.')}
                rows={v.ready.map((x, i) => ({ key: `${x.id}-${i}`, cells: [
                  { node: <NameCell name={x.name} sub={`${nameOf(x.vcenterId)} · ${x.host || '—'}`} />, sort: x.name },
                  { node: <Gauge w={barPct(x.readyAvg, readyMax)} bg={sevColor(x.sev)} note={`최고 ${x.readyMax == null ? '—' : `${fmt1(x.readyMax)}%`}`} />, sort: x.readyMax },
                  { node: <span className="vit-big hero">{x.readyAvg == null ? '—' : `${fmt1(x.readyAvg)}%`}</span>, sort: x.readyAvg, cls: 'r' },
                ] }))} />
            </div>
            <div className="vit-lst">
              <div className="vit-lh"><b>디스크 지연이 큰 VM</b><span>읽기 · 쓰기 평균 중 큰 값 순</span></div>
              <TopTable label="디스크 지연이 큰 VM" cols={[{ label: 'VM', width: '46%' }, { label: '읽기 · 쓰기' }, { label: '지연', cls: 'r', width: '72px' }]}
                empty={contentionEmpty(v, '이 범위에는 디스크 지연 판정이 붙은 VM 이 없습니다.')}
                rows={v.disk.map((x, i) => ({ key: `${x.id}-${i}`, cells: [
                  { node: <NameCell name={x.name} sub={`${nameOf(x.vcenterId)} · ${x.host || '—'}${x.disk ? ` · ${x.disk}` : ''}`} />, sort: x.name },
                  { node: <Gauge w={barPct(diskOf(x), diskMax)} bg={sevColor(x.sev)} note={`읽기 ${x.readAvg == null ? '—' : `${fmt1(x.readAvg)} ms`} · 쓰기 ${x.writeAvg == null ? '—' : `${fmt1(x.writeAvg)} ms`}`} />, sort: x.diskMax },
                  { node: <span className="vit-big hero">{x.readAvg == null && x.writeAvg == null ? '—' : `${fmtN(diskOf(x))} ms`}</span>, sort: diskOf(x), cls: 'r' },
                ] }))} />
            </div>
          </div>
        )}
      </PanelState>
    </section>
  );
}

/* ───────────── VM 구성 점검 ───────────── */
function HygienePanel({ vcIds, rows }) {
  const q = useToolSummary('/tools/vm-hygiene');
  const v = hygieneView(q.data, vcIds);
  const nameOf = corpNameOf(rows, q.data?.rows);
  return (
    <section className="vit-panel" aria-label="VM 구성 점검">
      <PanelHead title="VM 구성 점검" hint={`백업 실패 · 멈춤으로 이어지는 구성 문제 — 특수 기능 ‘${toolLabel('vm-hygiene')}’ 의 요약입니다`} q={q} onReload={q.reload} />
      <PanelState q={q} view={v} waitText="구성 점검 요약을 받는 중입니다…">
        {v && (
          <div className="vit-gp">
            <div className="vit-sum">
              <Hero value={fmtN(v.crit)} text="대 — 지금 조치가 필요합니다(심각 판정이 붙은 VM)" />
              <Stats items={[
                { key: 'w', tone: 's', big: `${fmtU(v.warn, '대')}`, text: '경고가 있는 VM', title: '경고 수준의 구성 문제가 하나 이상 있는 VM' },
                { key: 'c', tone: 's', big: `${fmtU(v.consolidation, '대')}`, text: '디스크 통합 필요', title: '스냅샷 정리가 끝나지 않아 통합이 필요한 VM — 백업 실패로 이어집니다' },
                { key: 'n', big: `${fmtU(v.notCollected, '대')}`, text: '판정 밖 — 구성 값을 못 받은 VM', title: '구성 값을 받지 못한 VM — 문제 없음이 아니라 모르는 것입니다' },
              ]} />
              <div className="vit-note">정보 수준(CBT 꺼짐 · 예약 · 독립 디스크 등)은 여기서 뺐습니다 — 도구에서 봅니다.</div>
              {v.settingsUnreadable && <div className="vit-note warn">도구 설정을 읽지 못해 기본 기준으로 판정한 값입니다.</div>}
              {v.partial && <div className="vit-note warn">값을 읽지 못한 법인이 있어 일부만 센 수입니다{v.notReadVcenters > 0 ? `(${fmtU(v.notReadVcenters, '곳')})` : ''}.</div>}
              {v.notReadDisabled > 0 && <div className="vit-note">수집하지 않는(비활성) 법인 {fmtU(v.notReadDisabled, '곳')}은 이 수에 없습니다.</div>}
              {v.initial && <div className="vit-note warn">첫 수집 중입니다 — 수가 아직 다 차지 않았습니다.</div>}
              <ToolLink toolKey="vm-hygiene" vcIds={vcIds}>‘{toolLabel('vm-hygiene')}’ 에서 모두 보기 →</ToolLink>
              <Foot resp={q.data} missing={v.missing} nameOf={nameOf} />
            </div>
            <div className="vit-lst">
              <div className="vit-lh"><b>문제 종류</b><span>심각 · 경고 판정 — 해당하는 VM 수</span></div>
              {!v.codes.length && <div className="vit-empty">이 범위에는 심각 · 경고 판정이 없습니다.</div>}
              <RankBars rows={v.codes.slice(0, HYGIENE_CODE_ROWS).map((c) => ({ key: c.code, name: c.title, n: c.n, bg: sevColor(c.sev), tip: `${c.title} · ${fmtU(c.n, '대')}` }))} />
              {v.codes.length > HYGIENE_CODE_ROWS && <div className="vit-note">그 밖 {fmtU(v.codes.length - HYGIENE_CODE_ROWS, '종')}은 도구에서 봅니다.</div>}
            </div>
            <div className="vit-lst">
              <div className="vit-lh"><b>응답을 기다리며 멈춘 VM</b><span>vCenter 질문에 답할 때까지 멈춰 있습니다 · 전체 {fmtU(v.question, '대')}</span></div>
              <TopTable label="응답을 기다리며 멈춘 VM" cols={[{ label: 'VM', width: '48%' }, { label: '질문' }]}
                empty="이 범위에는 없습니다."
                rows={v.questions.map((x, i) => ({ key: `${x.id}-${i}`, cells: [
                  { node: <NameCell name={x.name} sub={`${nameOf(x.vcenterId)} · ${x.host || '—'}`} />, sort: x.name },
                  { node: <span className="vit-sb" title={x.question?.text || ''}>{x.question?.text || '—'}</span>, sort: x.question?.text || '' },
                ] }))} />
            </div>
          </div>
        )}
      </PanelState>
    </section>
  );
}

const PANEL_COMPONENT = { disk: DiskPanel, off: OffPanel, trend: TrendPanel, contention: ContentionPanel, hygiene: HygienePanel };

export default function VmToolPanels({ vcIds = [], rows = [], group = 'capacity', canTool, only = null }) {
  // canTool 이 없으면 그리지 않는다(약속된 prop) · 있으면 toolAllowed 를 바닥으로 더한다.
  const can = typeof canTool === 'function' ? gateOf(canTool, (k) => toolAllowed(k)) : () => false;
  const list = panelsFor(group, can, only);
  if (!list.length) return null;
  return (
    <div className="vit" style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
      {list.map((p) => { const C = PANEL_COMPONENT[p]; return <C key={p} vcIds={vcIds} rows={rows} canTool={can} />; })}
    </div>
  );
}
