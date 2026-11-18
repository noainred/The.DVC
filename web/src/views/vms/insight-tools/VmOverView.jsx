/**
 * insight-tools/VmOverView.jsx — VM 탭 보기 ‘과할당’ 본문(v3.21.0 · docs/design/vm-insight §4-2 · host-insight §9 S2 · 시안 VmInsight.dc.html).
 *
 * 본체와의 약속: default export — props { vcIds: string[](빈 배열 = 범위 안 전부), rows: object[](VM 집계 법인 줄), canTool: (toolKey) => boolean }.
 *   canTool('waste') 가 거짓이면 아무것도 그리지 않고 요청도 보내지 않는다(본체는 그때 ‘과할당’ 칸을 숨긴다 — §6 ⑪).
 *
 * 구성: CPU · 메모리 · 회수 가능 스토리지(추정) 3장(사용 / 미사용 두 조각 막대에 글을 직접 · 미사용 주황) → 관리 상태 4장 →
 *   무엇을 볼지 갈래 5개(누르면 아래 두 패널이 바뀐다) → 법인별 막대 · VM 5대 + ‘Optimization 에서 모두 보기 →’.
 * 값: `/tools/waste?summary=1`(꺼진 VM 패널과 같은 칸 — 한 번만 받는다) · S2 의 호스트 평균 메모리는 `/hosts/corp`(권한이 없거나 못 받으면 환산을 빼고 말한다).
 * 판정(줄일 후보 기준)은 응답 thresholds 값 — 화면에 박지 않는다.
 */
import { unitText } from '../../unitText.js'; // v3.21.0: 값이 없으면 단위 없는 ‘—’(BUG-20 규약)
import React, { useEffect, useState } from 'react';
import './vmTools.css';
import { fetchJson, toolAllowed } from '../../../api.js';
import { useLatest } from '../../../hooks/useLatest.js';
import { useToolSummary } from './useToolSummary.js';
import { fmtN, fmtU, fmt1, gbText, mbText, ghzText, pctText, pctOf, corpNameOf, hostAvgMemGB, hostsEq, missingText, synthNote, barPct, toolLabel, gateOf } from './toolSumText.js';
import { overTotals, kindCounts, corpBars, topVms, OVER_KINDS, normKind, OVER_COLORS, OVER_CORP_ROWS } from './vmOverText.js';
import { PanelHead, PanelState, SegBar, Legend, ToolLink, TopTable, NameCell } from './ToolParts.jsx';

function HeroCard({ title, right, big, bigText, segs, note, title2 }) {
  return (
    <section className="vit-panel" title={title2 || undefined}>
      <div className="vit-ph"><h2>{title}</h2>{right && <span className="vit-rt">{right}</span>}</div>
      <div className="vit-ovh"><b>{big}</b><span>{bigText}</span></div>
      <SegBar tall segs={segs} />
      <Legend segs={segs.map((s) => ({ ...s, text: s.legend, label: s.legendLabel }))} />
      {note && <div className="vit-note">{note}</div>}
    </section>
  );
}

/** 두 조각(사용 · 미사용) — 글은 조각 위에 직접(비율). 값이 없으면 조각이 없다. */
function duoSegs(used, idle, alloc, fmt) {
  return [
    { key: 'u', n: used, ...OVER_COLORS.used, label: '사용', text: `사용 ${pctText(used, alloc)}`, legendLabel: '사용', legend: fmt(used) },
    { key: 'd', n: idle, ...OVER_COLORS.idle, label: '미사용', text: `미사용 ${pctText(idle, alloc)}`, legendLabel: '미사용', legend: fmt(idle) },
  ];
}

export default function VmOverView({ vcIds = [], rows = [], canTool }) {
  const can = typeof canTool === 'function' && gateOf(canTool, (k) => toolAllowed(k))('waste');
  const q = useToolSummary('/tools/waste', null, { enabled: can });
  const [kind, setKind] = useState('mem');
  const [corps, setCorps] = useState(null);   // /hosts/corp 법인 줄(S2 환산) — 못 받으면 null
  const run = useLatest();
  useEffect(() => {
    if (!can) return;
    run(fetchJson('/hosts/corp'), (d) => setCorps(Array.isArray(d?.corps) ? d.corps : null), () => setCorps(null));
  }, [can, run]);
  if (!can) return null;

  const t = overTotals(q.data, vcIds);
  const nameOf = corpNameOf(rows, q.data?.rows);
  const hostAvg = hostAvgMemGB(corps, vcIds);
  const k = normKind(kind);
  const counts = kindCounts(t);
  const isUse = k === 'mem' || k === 'cpu';
  const bars = t ? corpBars(t, k) : [];
  const shown = bars.slice(0, OVER_CORP_ROWS);
  const top = t ? topVms(t, k) : [];

  let heroes = null;
  if (t) {
    const memIdleGB = t.mem.idleMB == null ? null : t.mem.idleMB / 1024;
    const eq = hostsEq(memIdleGB, hostAvg);
    const rc = t.reclaim;
    heroes = (
      <div className="vit-row3">
        <HeroCard title="CPU — 준 것과 쓰는 것" right={`할당 ${ghzText(t.cpu.allocMhz)}`} big={ghzText(t.cpu.idleMhz)}
          bigText={`미사용 — 할당의 ${pctText(t.cpu.idleMhz, t.cpu.allocMhz)}`} title2="구동 VM 의 CPU 할당 · 사용 합"
          segs={duoSegs(t.cpu.usedMhz, t.cpu.idleMhz, t.cpu.allocMhz, ghzText)}
          note={`줄일 후보 ${fmtU(t.cpu.candidates, '대')} — 구동 VM ${fmtU(t.poweredOnVms, '대')} 중 CPU 사용률이 ${unitText(t.cpuIdlePct, '%')} 이하인 VM.${t.usageUnknown.cpu ? ` 사용률을 못 읽은 ${fmtU(t.usageUnknown.cpu, '대')}는 합 · 판정에서 뺐습니다.` : ''}`} />
        <HeroCard title="메모리 — 준 것과 쓰는 것" right={`할당 ${mbText(t.mem.allocMB)}`} big={mbText(t.mem.idleMB)}
          bigText={`미사용 — 할당의 ${pctText(t.mem.idleMB, t.mem.allocMB)}${eq == null ? '' : ` · 호스트 약 ${fmt1(eq)}대분`}`} title2="구동 VM 의 메모리 할당 · 게스트 사용 합"
          segs={duoSegs(t.mem.usedMB, t.mem.idleMB, t.mem.allocMB, mbText)}
          note={`줄일 후보 ${fmtU(t.mem.candidates, '대')} — 게스트가 실제로 쓰는 메모리가 할당의 ${unitText(t.memIdlePct, '%')} 이하인 VM.`
            + (hostAvg ? ` 호스트 환산은 이 범위 호스트 한 대의 평균 메모리 ${fmtN(hostAvg.avgGB)} GB 기준입니다(용량을 읽은 호스트 ${fmtU(hostAvg.hosts, '대')}).` : ' 호스트 평균 메모리를 받지 못해 호스트 대수로 바꾸지 않았습니다.')
            + (t.usageUnknown.mem ? ` 사용량을 못 읽은 ${fmtU(t.usageUnknown.mem, '대')}는 합 · 판정에서 뺐습니다.` : '')} />
        <HeroCard title="회수 가능 스토리지(추정)" right="두 가지의 합" big={rc ? gbText(rc.totalGB) : '—'} bigText="꺼진 VM 점유 + Thin 여유"
          title2="전원이 꺼진 VM 이 잡은 디스크와 Thin 여유의 합"
          segs={rc ? [
            { key: 'o', n: rc.offGB, ...OVER_COLORS.idle, label: '꺼진 VM', text: `꺼진 VM ${pctText(rc.offGB, rc.totalGB)}`, legendLabel: `꺼진 VM(${fmtU(t.poweredOff, '대')}) 점유`, legend: gbText(rc.offGB) },
            { key: 't', n: rc.thinGB, ...OVER_COLORS.thin, label: 'Thin 여유', text: `Thin 여유 ${pctText(rc.thinGB, rc.totalGB)}`, legendLabel: `Thin 여유(${fmtU(t.thinVms, '대')})`, legend: gbText(rc.thinGB) },
          ] : []}
          note={`추정값입니다 — VM 을 지우거나 디스크를 줄이기 전에는 돌아오지 않습니다.${rc && (rc.offUnknown || rc.thinUnknown) ? ` 용량을 못 읽은 VM ${fmtU(rc.offUnknown + rc.thinUnknown, '대')}는 합에서 뺐습니다(합은 하한).` : ''}`} />
      </div>
    );
  }

  const kpis = t ? [
    { key: 'off', l: '전원 꺼짐 VM', v: `${fmtU(t.poweredOff, '대')}`, s: `디스크 ${gbText(t.poweredOffGB)} 점유`, title: '전원이 꺼진 VM(템플릿 제외)' },
    { key: 'snap', l: '스냅샷 보유 VM', v: `${fmtU(t.snapshots, '대')}`, s: `스냅샷 크기 ${gbText(t.snapshotGB)}`, title: '스냅샷이 있는 VM' },
    { key: 'tools', l: 'Tools 미실행(구동 중)', v: `${fmtU(t.noTools, '대')}`, s: 'Tools 상태가 ‘실행 중’ 이 아닌 구동 VM', title: '전원이 켜져 있는데 VMware Tools 상태가 실행 중이 아닌 VM' },
    { key: 'thin', l: 'Thin 여유', v: gbText(t.thinReclaimGB), s: `Thin 디스크 VM ${fmtU(t.thinVms, '대')}의 아직 쓰지 않은 공간`, title: 'Thin(씬) 디스크 VM 의 아직 쓰지 않은 공간(uncommitted) 합' },
  ] : [];

  const unit = (v) => (k === 'mem' ? mbText(v) : ghzText(v));
  const corpTitle = { mem: '법인별 — 준 것과 쓰는 것(메모리)', cpu: '법인별 — 준 것과 쓰는 것(CPU)', off: '법인별 — 꺼진 VM 이 잡은 디스크', snap: '법인별 — 스냅샷 크기', tools: '법인별 — Tools 미실행 VM' }[k];
  const corpHint = isUse ? '막대 길이 = 할당 · 회색 = 사용 · 주황 = 미사용 · 숫자 = 미사용(큰 순)' : k === 'tools' ? '막대 = 대수 · 많은 순' : k === 'off' ? '막대 · 숫자 = 점유 디스크 · 큰 순' : '막대 · 숫자 = 스냅샷 크기 · 큰 순';
  const topTitle = { mem: '메모리를 줄일 수 있는 VM', cpu: 'CPU 를 줄일 수 있는 VM', off: '전원이 꺼진 VM', snap: '스냅샷이 큰 VM', tools: 'Tools 상태가 ‘실행 중’ 이 아닌 구동 VM' }[k];
  const topHint = isUse ? '미사용이 큰 순 · 막대 길이 = 할당' : k === 'off' ? '디스크를 많이 잡은 순' : k === 'snap' ? '스냅샷 크기가 큰 순' : '도구가 준 순서(순위가 아닙니다)';
  const topRule = k === 'mem' ? `후보 = 사용률 ${unitText(t?.memIdlePct, '%')} 이하` : k === 'cpu' ? `후보 = 사용률 ${unitText(t?.cpuIdlePct, '%')} 이하` : '';
  const allocMax = top.reduce((a, x) => Math.max(a, Number(k === 'mem' ? x.memAllocGB : x.cpuAllocMhz) || 0), 0);
  const valMax = top.reduce((a, x) => Math.max(a, Number(k === 'off' ? x.storageGB : x.snapshotSizeGB) || 0), 0);

  const topCols = isUse
    ? [{ label: 'VM', width: '40%' }, { label: '할당 대비 사용' }, { label: '미사용', cls: 'r', width: '96px' }]
    : k === 'tools' ? [{ label: 'VM', width: '55%' }, { label: 'Tools 상태' }]
      : [{ label: 'VM', width: '46%' }, { label: k === 'off' ? '잡은 디스크' : '스냅샷' }, { label: '크기', cls: 'r', width: '96px' }];
  const topRows = top.map((x, i) => {
    const corp = nameOf(x.vcenterId);
    if (isUse) {
      const alloc = k === 'mem' ? x.memAllocGB : x.cpuAllocMhz; const used = k === 'mem' ? x.memUsedGB : x.cpuUsedMhz; const idle = k === 'mem' ? x.memIdleGB : x.cpuIdleMhz;
      const fmtV = (v) => (k === 'mem' ? gbText(v) : ghzText(v));
      const usage = k === 'mem' ? x.memUsagePct : x.cpuUsagePct; const save = k === 'mem' ? x.memSavingPct : x.cpuSavingPct;
      return { key: `${x.id || x.name}-${i}`, cells: [
        { node: <NameCell name={x.name} sub={`${corp} · ${x.guestOS || '—'}${x.vcpu != null ? ` · ${fmtN(x.vcpu)} vCPU` : ''}`} />, sort: x.name },
        { node: (
          <>
            <span className="vit-duo" style={{ width: `${barPct(alloc, allocMax)}%` }} aria-hidden="true">
              <i className="u" style={{ flex: `${Math.max(0.01, Number(used) || 0)} 1 0` }} /><i className="d" style={{ flex: `${Math.max(0, Number(idle) || 0)} 1 0` }} />
            </span>
            <span className="vit-fr">할당 {fmtV(alloc)} · 사용 {fmtV(used)} · 사용률 {usage == null ? '—' : `${fmtN(usage)}%`}</span>
          </>
        ), sort: usage },
        { node: <><span className="vit-big hero">{fmtV(idle)}</span><span className="vit-sb">절감 가능 {save == null ? '—' : `${fmtN(save)}%`}</span></>, sort: idle, cls: 'r' },
      ] };
    }
    if (k === 'tools') {
      return { key: `${x.id || x.name}-${i}`, cells: [
        { node: <NameCell name={x.name} sub={corp} />, sort: x.name },
        { node: <span className="vit-sb">{x.toolsStatus || '—'} — 구동 중인데 Tools 가 ‘실행 중’ 이 아닙니다</span>, sort: x.toolsStatus || '' },
      ] };
    }
    const val = k === 'off' ? x.storageGB : x.snapshotSizeGB;
    return { key: `${x.id || x.name}-${i}`, cells: [
      { node: <NameCell name={x.name} sub={k === 'off' ? `${corp} · ${x.guestOS || '—'}` : `${corp} · 스냅샷 ${fmtU(x.snapshotCount, '개')}`} />, sort: x.name },
      { node: <span className="vit-duo" style={{ width: `${barPct(val, valMax)}%` }} aria-hidden="true"><i className="d" style={{ flex: '1 1 0' }} /></span>, sort: val },
      { node: <span className="vit-big hero">{gbText(val)}</span>, sort: val, cls: 'r' },
    ] };
  });

  return (
    <div className="vit vit-over">
      <PanelHead title={`과할당 — 특수 기능 ‘${toolLabel('waste')}’ 의 요약`} hint="판정과 계산은 그 도구 그대로입니다 · 법인을 고르면 그 법인들의 합으로 바뀝니다" q={q} onReload={q.reload} />
      <PanelState q={q} view={t} waitText="과할당 요약을 받는 중입니다…">
        {t && (
          <>
            {heroes}
            <div className="vit-k4">
              {kpis.map((x) => <div key={x.key} className="vit-kpi" title={x.title}><span className="l">{x.l}</span><span className="v">{x.v}</span><span className="s">{x.s}</span></div>)}
            </div>
            <div className="vit-tabs" role="tablist" aria-label="무엇을 볼지">
              <span>무엇을 볼지</span>
              {OVER_KINDS.map((x) => (
                <button key={x.key} type="button" role="tab" aria-selected={k === x.key} onClick={() => setKind(x.key)}>{x.label} <b>{fmtN(counts[x.key])}</b></button>
              ))}
            </div>
            <div className="vit-row2">
              <section className="vit-panel" aria-label="법인별">
                <div className="vit-ph"><h2>{corpTitle}</h2><span className="vit-hint">{corpHint}</span></div>
                {!shown.length && <div className="vit-empty">이 범위에는 해당하는 법인이 없습니다.</div>}
                {shown.map((c) => {
                  const text = isUse
                    ? <><b>{unit(c.value)}</b> · {pctText(c.idle, c.alloc)} · 후보 {fmtU(c.n, '대')}</>
                    : k === 'tools' ? <><b>{fmtU(c.value, '대')}</b> · 구동 {fmtU(c.poweredOn, '대')} 중 {pctOf(c.value, c.poweredOn) == null ? '—' : `${pctOf(c.value, c.poweredOn)}%`}</>
                      : <><b>{gbText(c.value)}</b> · {fmtU(c.n, '대')}</>;
                  return (
                    <div key={c.vcenterId} className="vit-oc" title={isUse ? `${nameOf(c.vcenterId)} — 할당 ${unit(c.alloc)} · 사용 ${unit(c.used)} · 미사용 ${unit(c.idle)} · 후보 ${fmtU(c.n, '대')}` : nameOf(c.vcenterId)}>
                      <span className="nm">{nameOf(c.vcenterId)}</span>
                      <span><span className="vit-duo" style={{ width: `${c.w}%` }}>
                        {isUse && <i className="u" style={{ flex: `${c.used} 1 0` }} />}<i className="d" style={{ flex: `${c.idle} 1 0` }} />
                      </span></span>
                      <span className="tx">{text}</span>
                    </div>
                  );
                })}
                {bars.length > shown.length && <div className="vit-note">그 밖 {fmtU(bars.length - shown.length, '곳')}은 도구에서 봅니다.</div>}
              </section>
              <section className="vit-panel" aria-label={topTitle}>
                <div className="vit-ph"><h2>{topTitle}</h2><span className="vit-hint">{topHint}</span>{topRule && <span className="vit-rt">{topRule}</span>}</div>
                <TopTable label={topTitle} cols={topCols} rows={topRows} />
                <ToolLink toolKey="waste" sub={k} vcIds={vcIds}>{toolLabel('waste')} 에서 모두 보기 →</ToolLink>
                <div className="vit-note">후보 전체 목록 · 7일 사용률 추이 · 근거 리포트 · 엑셀(ZIP) 내보내기는 특수 기능 ‘{toolLabel('waste')}’ 에 그대로 있습니다. 이 화면은 그 요약이고, 포탈은 VM 을 지우지 않습니다(확인 필요 후보).</div>
                {missingText(t.missing, nameOf) && <div className="vit-note">{missingText(t.missing, nameOf)}</div>}
                {synthNote(q.data) && <div className="vit-note">{synthNote(q.data)}</div>}
              </section>
            </div>
          </>
        )}
      </PanelState>
    </div>
  );
}
