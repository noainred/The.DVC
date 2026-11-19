/**
 * hosts/insight-tools/HostToolPanels.jsx — Hypervisor 분석 화면의 특수 기능 요약 패널(v3.22.0 · 설계 docs/design/vm-insight §10 Hypervisor 줄 · 시안 HostInsight.dc.html).
 *
 * 본체(hosts/HostInsight.jsx)와의 약속:
 *   default export — props { vcIds: string[](빈 배열 = 범위 안 전부), rows: object[](호스트 분석 법인 줄 — 이름), group: 'perf'|'config'|'capacity', canTool: (toolKey) => boolean }
 *   · perf = CPU 경합 · 디스크 지연(호스트 · 데이터스토어) · config = ESXi 호스트 구성 점검 · capacity = 데이터스토어 — 곧 가득 · 경로.
 *
 * 규약(VM 분석 패널 VmToolPanels 와 같다 — 부품 · 훅 · 합 보조를 그대로 쓴다):
 *  · 패널마다 그 도구의 요약 모드를 **마운트 1회 + ‘다시 받기’** 로 받는다(useToolSummary — 15초 폴링 없음 · 늦게 온 응답 버림).
 *  · canTool(key) 가 거짓이면 그 패널(데이터스토어 패널은 그 반쪽)을 그리지 않고 요청도 보내지 않는다(요약이 새지 않게).
 *  · 수는 고른 법인(vcIds)의 줄을 더하고 상위 N 은 법인별 상위 N 을 합쳐 도구의 순서로 다시 고른다(hostToolPanelsText).
 *  · 기준값은 응답 값 · 못 읽은 값은 ‘—’ · 판정 밖은 따로 센다 · 403 은 ErrorBox 가 권한 안내로(PanelState).
 */
import React from 'react';
import '../../vms/insight-tools/vmTools.css';
import { toolAllowed } from '../../../api.js';
import { unitText } from '../../unitText.js';
import { useToolSummary } from '../../vms/insight-tools/useToolSummary.js';
import { fmtN, fmtU, fmt1, gbText, corpNameOf, missingText, synthNote, barPct, toolLabel, gateOf } from '../../vms/insight-tools/toolSumText.js';
import { PanelHead, PanelState, ToolLink, Gauge, TopTable, NameCell } from '../../vms/insight-tools/ToolParts.jsx';
import { HYGIENE_CODE_ROWS, WARM, NEUTRAL, contentionRule, contentionEmpty } from '../../vms/insight-tools/vmToolPanelsText.js';
import { SCAN_OFF_NOTE } from '../../contention/contentionText.js';
import { Hero, MiniStats, RankBars } from '../../insight/InsightParts.jsx';
import { contentionHostView, hostHygieneView, forecastView, pathsView, dsLatOf, hostPanelsFor } from './hostToolPanelsText.js';

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

/* ───────────── CPU 경합 · 디스크 지연(호스트) ───────────── */
function ContentionPanel({ vcIds, rows }) {
  const q = useToolSummary('/tools/contention');
  const v = contentionHostView(q.data, vcIds);
  const nameOf = corpNameOf(rows, q.data?.rows);
  const th = v?.th || {};
  const rule = contentionRule(v);
  const hMax = v ? v.hosts.reduce((a, x) => Math.max(a, Number(x.contended) || 0), 0) : 0;
  const dMax = v ? v.datastores.reduce((a, x) => Math.max(a, dsLatOf(x) || 0), 0) : 0;
  return (
    <section className="vit-panel" aria-label="CPU 경합과 디스크 지연(호스트)">
      <PanelHead title="CPU 경합 · 디스크 지연" hint={`VM 이 CPU 를 기다리는 호스트와 느린 데이터스토어 — 특수 기능 ‘${toolLabel('contention')}’ 의 요약입니다`} rule={rule} q={q} onReload={q.reload} />
      <PanelState q={q} view={v} waitText="경합 요약을 받는 중입니다…">
        {v && (
          <div className="vit-gp">
            <div className="vit-sum">
              <Hero value={fmtN(v.hostsReadyCrit)} text={v.hostsReadyCrit == null ? (v.off ? '측정이 꺼져 있어 CPU 대기 판정이 없습니다(0 이 아닙니다)' : '측정한 VM 이 0대라 CPU 대기가 큰 호스트를 모릅니다(0 이 아닙니다)') : `대 — CPU 대기(Ready)가 ${unitText(th.readyCrit, '%')} 이상인 VM 이 있는 호스트입니다(연결된 호스트 ${fmtU(v.hostsConnected, '대')} 중)`} />
              <Stats items={[
                { key: 'hc', tone: 's', big: `${fmtU(v.hostsContended, '대')}`, text: '경합 VM 이 있는 호스트(대기 · Co-stop 경고 포함)', title: '도구의 호스트 표에서 경합 VM 이 하나 이상인 호스트' },
                { key: 'hd', tone: 'c', big: `${fmtU(v.hostsDisk, '대')}`, text: `디스크 지연이 큰 호스트(${unitText(th.diskWarn, 'ms')} 이상)`, title: '호스트가 보고한 디스크 지연이 경고 기준 이상' },
                { key: 'ds', tone: 's', big: `${fmtU(v.dsSlow, '개')}`, text: '느린 데이터스토어', title: '읽기 · 쓰기 응답이 경고 기준 이상인 데이터스토어' },
              ]} />
              {v.off && <div className="vit-note warn">{SCAN_OFF_NOTE}</div>}
              <div className="vit-note">연결된 호스트 {fmtU(v.hostsConnected, '대')} 중 {fmtU(v.hostsMeasured, '대')}를 측정했습니다 — 측정하지 못한 {fmtU(v.hostsNotMeasured, '대')}는 판정 밖입니다.{(v.unmatchedDs || 0) > 0 ? ` 이름을 모르는 데이터스토어 보고 ${fmtU(v.unmatchedDs, '건')}은 세지 않았습니다.` : ''}</div>
              {v.initial && <div className="vit-note warn">첫 측정 중입니다 — 수가 아직 다 차지 않았습니다.</div>}
              <ToolLink toolKey="contention" vcIds={vcIds}>‘{toolLabel('contention')}’ 에서 모두 보기 →</ToolLink>
              <Foot resp={q.data} missing={v.missing} nameOf={nameOf} />
            </div>
            <div className="vit-lst">
              <div className="vit-lh"><b>경합 · 지연이 큰 호스트</b><span>도구의 순서(경합 VM 수 → 가장 큰 대기 → 디스크 지연)</span></div>
              <TopTable label="경합 · 지연이 큰 호스트" cols={[{ label: '호스트', width: '46%' }, { label: '대기 · 이웃' }, { label: '경합 VM', cls: 'r', width: '72px' }]}
                empty={contentionEmpty(v, '이 범위에는 경합 · 지연 판정이 붙은 호스트가 없습니다.')}
                rows={v.hosts.map((x, i) => ({ key: `${x.id}-${i}`, cells: [
                  { node: <NameCell name={x.name} sub={`${nameOf(x.vcenterId)}${x.cluster ? ` · ${x.cluster}` : ''} · VM ${fmtU(x.vmCount, '대')}`} />, sort: x.name },
                  { node: <Gauge w={barPct(x.contended, hMax)} bg={sevColor(x.diskSev || ((x.contended || 0) > 0 ? 'warn' : null))}
                    note={`대기 최고 ${x.worstReady == null ? '—' : `${fmt1(x.worstReady)}%`}${Array.isArray(x.neighbors) && x.neighbors.length ? ` · 부하가 큰 이웃 ${x.neighbors.map((n) => n.name).join(', ')}` : ''}${x.diskMaxMs != null ? ` · 디스크 ${fmt1(x.diskMaxMs)} ms` : ''}`} />, sort: x.worstReady },
                  { node: <span className="vit-big hero">{`${fmtU(x.contended, '대')}`}</span>, sort: x.contended, cls: 'r' },
                ] }))} />
            </div>
            <div className="vit-lst">
              <div className="vit-lh"><b>느린 데이터스토어</b><span>읽기 · 쓰기 평균 중 큰 값 순</span></div>
              <TopTable label="느린 데이터스토어" cols={[{ label: '데이터스토어', width: '46%' }, { label: '읽기 · 쓰기' }, { label: '지연', cls: 'r', width: '72px' }]}
                empty={contentionEmpty(v, '이 범위에는 느림 판정이 붙은 데이터스토어가 없습니다.')}
                rows={v.datastores.map((x, i) => ({ key: `${x.id}-${i}`, cells: [
                  { node: <NameCell name={x.name} sub={`${nameOf(x.vcenterId)}${x.worstHost ? ` · 가장 느린 호스트 ${x.worstHost}` : ''}`} />, sort: x.name },
                  { node: <Gauge w={barPct(dsLatOf(x), dMax)} bg={sevColor(x.sev)} note={`읽기 ${x.readAvg == null ? '—' : `${fmt1(x.readAvg)} ms`} · 쓰기 ${x.writeAvg == null ? '—' : `${fmt1(x.writeAvg)} ms`}`} />, sort: dsLatOf(x) },
                  { node: <span className="vit-big hero">{dsLatOf(x) == null ? '—' : `${fmt1(dsLatOf(x))} ms`}</span>, sort: dsLatOf(x), cls: 'r' },
                ] }))} />
            </div>
          </div>
        )}
      </PanelState>
    </section>
  );
}

/* ───────────── ESXi 호스트 구성 점검 ───────────── */
function HygienePanel({ vcIds, rows }) {
  const q = useToolSummary('/tools/host-hygiene');
  const v = hostHygieneView(q.data, vcIds);
  const nameOf = corpNameOf(rows, q.data?.rows);
  return (
    <section className="vit-panel" aria-label="ESXi 호스트 구성 점검">
      <PanelHead title="ESXi 호스트 구성 점검" hint={`인증서 · 재부팅 · SSH · 시각 동기화 등 보안과 구성 — 특수 기능 ‘${toolLabel('host-hygiene')}’ 의 요약입니다`} q={q} onReload={q.reload} />
      <PanelState q={q} view={v} waitText="구성 점검 요약을 받는 중입니다…">
        {v && (
          <div className="vit-gp">
            <div className="vit-sum">
              <Hero value={fmtN(v.crit)} text="대 — 지금 조치가 필요합니다(심각 판정이 붙은 호스트)" />
              <Stats items={[
                { key: 'p', tone: 's', big: `${fmtU(v.problem, '대')}`, text: '문제가 하나 이상인 호스트', title: '점검 항목에 하나라도 걸린 호스트' },
                { key: 's', tone: 's', big: `${fmtU(v.ssh, '대')}`, text: 'SSH 가 켜져 있는 호스트', title: '작업 뒤 끄지 않은 SSH — 보안 점검 대상' },
                { key: 'o', big: `${fmtU(v.outOfJudgment, '대')}`, text: '판정 밖 — 구성 값을 못 받았거나 끊긴 호스트', title: `구성 값을 못 받은 호스트 ${fmtU(v.notCollected, '대')} · 끊긴 호스트 ${fmtU(v.disconnected, '대')} — 문제 없음이 아니라 모르는 것입니다` },
              ]} />
              <div className="vit-note">정보 수준 판정은 여기서 뺐습니다 — 도구에서 봅니다.</div>
              {v.scan && v.scan.enabled === false && <div className="vit-note warn">호스트 구성 수집이 꺼져 있습니다 — 아래 수는 마지막으로 받은 값입니다.</div>}
              {v.partial && <div className="vit-note warn">값을 읽지 못한 법인이 있어 일부만 센 수입니다{v.notReadVcenters > 0 ? `(${fmtU(v.notReadVcenters, '곳')})` : ''}.</div>}
              {v.notReadDisabled > 0 && <div className="vit-note">수집하지 않는(비활성) 법인 {fmtU(v.notReadDisabled, '곳')}은 이 수에 없습니다.</div>}
              {v.initial && <div className="vit-note warn">첫 수집 중입니다 — 수가 아직 다 차지 않았습니다.</div>}
              <ToolLink toolKey="host-hygiene" vcIds={vcIds}>‘{toolLabel('host-hygiene')}’ 에서 모두 보기 →</ToolLink>
              <Foot resp={q.data} missing={v.missing} nameOf={nameOf} />
            </div>
            <div className="vit-lst">
              <div className="vit-lh"><b>문제 종류</b><span>심각 · 경고 판정 — 해당하는 호스트 수</span></div>
              {!v.codes.length && <div className="vit-empty">이 범위에는 심각 · 경고 판정이 없습니다.</div>}
              <RankBars rows={v.codes.slice(0, HYGIENE_CODE_ROWS).map((c) => ({ key: c.code, name: c.title, n: c.n, bg: sevColor(c.sev), tip: `${c.title} · ${fmtU(c.n, '대')}` }))} />
              {v.codes.length > HYGIENE_CODE_ROWS && <div className="vit-note">그 밖 {fmtU(v.codes.length - HYGIENE_CODE_ROWS, '종')}은 도구에서 봅니다.</div>}
            </div>
            <div className="vit-lst">
              <div className="vit-lh"><b>인증서가 만료된 호스트</b><span>만료된 지 오래된 순 · 전체 {fmtU(v.certExpired, '대')} · 곧 만료 {fmtU(v.certExpiring, '대')}</span></div>
              <TopTable label="인증서가 만료된 호스트" cols={[{ label: '호스트', width: '52%' }, { label: '버전' }, { label: '지난 일수', cls: 'r', width: '72px' }]}
                empty="이 범위에는 인증서가 만료된 호스트가 없습니다."
                rows={v.certList.map((x, i) => ({ key: `${x.id}-${i}`, cells: [
                  { node: <NameCell name={x.name} sub={`${nameOf(x.vcenterId)}${x.cluster ? ` · ${x.cluster}` : ''}`} />, sort: x.name },
                  { node: <span className="vit-sb">{[x.version, x.build].filter(Boolean).join(' · ') || '—'}</span>, sort: x.version || '' },
                  { node: <span className="vit-big hero">{x.days == null ? '—' : `${fmtU(x.days, '일')}`}</span>, sort: x.days, cls: 'r' },
                ] }))} />
            </div>
          </div>
        )}
      </PanelState>
    </section>
  );
}

/* ───────────── 데이터스토어 — 곧 가득 · 경로 ───────────── */
function DsPanel({ vcIds, rows, canTool }) {
  const canFc = canTool('forecast');
  const canSp = canTool('storage-paths');
  const qf = useToolSummary(canFc ? '/tools/capacity-forecast' : null, null, { enabled: canFc });
  const qp = useToolSummary(canSp ? '/tools/storage-paths' : null, null, { enabled: canSp });
  const f = canFc ? forecastView(qf.data, vcIds) : null;
  const p = canSp ? pathsView(qp.data, vcIds) : null;
  const nameOf = corpNameOf(rows, [...(qf.data?.rows || []), ...(qp.data?.rows || [])]);
  // 두 도구 중 먼저 온 것부터 그린다 — 한쪽이 늦어도 다른 쪽을 기다리지 않는다. 둘 다 없을 때만 PanelState(받는 중 · 못 받음 · 권한 안내).
  const lead = canFc ? qf : qp;
  //   r140: 값이 있으면 오류는 **값이 있는 도구의 다시 받기 실패**만 싣는다 — 예전 lead.error 는 예측이 처음부터 못 왔는데(경로만 옴) PanelState 가
  //   ‘다시 받기에 실패했습니다 — 아래는 … 값입니다’ 라고 말했다(예측 실패는 아래 ‘용량 예측 요약을 받지 못했습니다’ 가 따로 밝힌다). 값이 없으면 예전 그대로 lead.error.
  const bothData = (canFc && qf.data) || (canSp && qp.data) || null;
  const staleErr = (canFc && qf.data && qf.error) || (canSp && qp.data && qp.error) || null;
  const both = { data: bothData, error: bothData ? staleErr : lead.error, loading: qf.loading || qp.loading, at: Math.max(qf.at || 0, qp.at || 0) || null };
  const reload = () => { if (canFc) qf.reload(); if (canSp) qp.reload(); };
  const soonMax = f ? f.soonest.reduce((a, x) => Math.max(a, Number(x.usagePct) || 0), 0) : 0;
  const deadMax = p ? p.deadHosts.reduce((a, x) => Math.max(a, Number(x.paths) || 0), 0) : 0;
  const sub = [canFc ? `‘${toolLabel('forecast')}’` : '', canSp ? `‘${toolLabel('storage-paths')}’` : ''].filter(Boolean).join(' · ');
  return (
    <section className="vit-panel" aria-label="데이터스토어 — 곧 가득 · 경로">
      <PanelHead title="데이터스토어 — 곧 가득 · 경로" hint={`특수 기능 ${sub} 의 요약입니다`} q={both} onReload={reload} />
      <PanelState q={both} waitText="데이터스토어 요약을 받는 중입니다…">
        <div className="vit-gp">
          <div className="vit-sum">
            {f && (
              <>
                <Hero value={fmtN(f.soon)} text={`개 — 지금 늘어나는 속도면 ${f.soonDays ?? '—'}일 안에 가득 찹니다(데이터스토어 ${fmtU(f.datastores, '개')} 중)`} />
                <div className="vit-note">예상일이 없는 데이터스토어 {fmtU(f.noForecast, '개')}(증가 근거 부족 · 여유 모름 · 늘지 않음 — 가득 안 참이 아닙니다){(f.usageUnknown || 0) > 0 ? ` · 사용률 모름 ${fmtU(f.usageUnknown, '개')}` : ''}.</div>
                {(f.synthesized || 0) > 0 && <div className="vit-note warn">증가 속도를 목(mock) 서버가 만들어 낸 예상일 {fmtU(f.synthesized, '개')}가 섞여 있습니다 — 실제 환경 값이 아닙니다.</div>}
              </>
            )}
            {canFc && !f && qf.error && <div className="vit-note warn">용량 예측 요약을 받지 못했습니다.</div>}
            <Stats items={[
              ...(f ? [{ key: 'h', tone: 'c', big: `${fmtU(f.high, '개')}`, text: `사용률 ${unitText(f.highPct, '%')} 이상`, title: '지금 사용률이 기준 이상인 데이터스토어' }] : []),
              ...(p ? [
                { key: 'd', tone: 'c', big: `${fmtU(p.dead, '개')}`, text: `죽은 경로 — 호스트 ${fmtU(p.hostsDead, '대')}`, title: '스토리지로 가는 경로 중 죽은 것' },
                { key: 's', tone: 's', big: `${fmtU(p.hostsSingle, '대')}`, text: '경로가 한 줄뿐인 호스트', title: `이중화가 없는 LUN ${fmtU(p.singlePath, '개')} — 경로 하나가 죽으면 끊깁니다` },
              ] : []),
            ]} />
            {p && <div className="vit-note">경로 값을 읽은 호스트 {fmtU(p.read, '대')} · 판정 밖(경로 값을 못 받은 호스트) {fmtU(p.notCollected, '대')}.</div>}
            {canSp && !p && qp.error && <div className="vit-note warn">경로 점검 요약을 받지 못했습니다.</div>}
            {canFc && <ToolLink toolKey="forecast" vcIds={vcIds}>‘{toolLabel('forecast')}’ 에서 모두 보기 →</ToolLink>}
            {canSp && <ToolLink secondary toolKey="storage-paths" vcIds={vcIds}>경로는 ‘{toolLabel('storage-paths')}’ 에서 →</ToolLink>}
            <Foot resp={qf.data || qp.data} missing={(f || p)?.missing} nameOf={nameOf} />
          </div>
          {canFc && (
            <div className="vit-lst">
              <div className="vit-lh"><b>곧 가득 찰 데이터스토어</b><span>예상일이 빠른 순 · 지난 증가가 이어진다는 가정</span></div>
              {!f ? <div className="vit-empty">{qf.loading ? '받는 중…' : '값이 없습니다.'}</div> : (
                <TopTable label="곧 가득 찰 데이터스토어" cols={[{ label: '데이터스토어', width: '46%' }, { label: '사용률 · 증가' }, { label: '남은 일수', cls: 'r', width: '72px' }]}
                  empty="이 범위에는 예상일이 있는 데이터스토어가 없습니다."
                  rows={f.soonest.map((x, i) => ({ key: `${x.id}-${i}`, cells: [
                    { node: <NameCell name={x.name} sub={`${nameOf(x.vcenterId)}${x.type ? ` · ${x.type}` : ''} · 남은 ${gbText(x.freeGB)}`} />, sort: x.name },
                    { node: <Gauge w={barPct(x.usagePct, Math.max(100, soonMax))} bg={(Number(x.usagePct) || 0) >= (f.highPct ?? Infinity) ? WARM[3].bg : '#3987e5'}
                      note={`사용률 ${x.usagePct == null ? '—' : `${fmt1(x.usagePct)}%`} · 하루 ${x.growthGBperDay == null ? '—' : `+${gbText(x.growthGBperDay)}`}${x.synthesized ? ' · 목 값' : ''}`} />, sort: x.usagePct },
                    { node: <span className="vit-big hero">{x.daysToFull == null ? '—' : `${fmtU(x.daysToFull, '일')}`}</span>, sort: x.daysToFull, cls: 'r', title: '예상일 뿐입니다' },
                  ] }))} />
              )}
            </div>
          )}
          {canSp && (
            <div className="vit-lst">
              <div className="vit-lh"><b>죽은 경로가 있는 호스트</b><span>죽은 경로가 많은 순</span></div>
              {!p ? <div className="vit-empty">{qp.loading ? '받는 중…' : '값이 없습니다.'}</div> : (
                <TopTable label="죽은 경로가 있는 호스트" cols={[{ label: '호스트', width: '46%' }, { label: '경로' }, { label: '죽음', cls: 'r', width: '64px' }]}
                  empty="이 범위에는 죽은 경로가 있는 호스트가 없습니다."
                  rows={p.deadHosts.map((x, i) => ({ key: `${x.id}-${i}`, cells: [
                    { node: <NameCell name={x.name} sub={`${nameOf(x.vcenterId)}${x.cluster ? ` · ${x.cluster}` : ''}${Array.isArray(x.deadLuns) && x.deadLuns.length ? ` · ${x.deadLuns.slice(0, 2).join(', ')}` : ''}`} />, sort: x.name },
                    { node: <Gauge w={barPct(x.dead, x.paths ?? deadMax)} bg={WARM[3].bg} note={`경로 ${fmtU(x.paths, '개')} 중 ${fmtU(x.dead, '개')} · 한 줄 경로 ${fmtN(x.singlePath)}`} />, sort: x.paths },
                    { node: <span className="vit-big hero">{`${fmtU(x.dead, '개')}`}</span>, sort: x.dead, cls: 'r' },
                  ] }))} />
              )}
            </div>
          )}
        </div>
      </PanelState>
    </section>
  );
}

const PANEL_COMPONENT = { contention: ContentionPanel, hygiene: HygienePanel, ds: DsPanel };

export default function HostToolPanels({ vcIds = [], rows = [], group = 'perf', canTool }) {
  // canTool 이 없으면 그리지 않는다 · 있으면 toolAllowed(서버 집행 축)를 바닥으로 더한다(VmToolPanels 와 같다).
  const can = typeof canTool === 'function' ? gateOf(canTool, (k) => toolAllowed(k)) : () => false;
  const list = hostPanelsFor(group, can);
  if (!list.length) return null;
  return (
    <div className="vit" style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
      {list.map((k) => { const C = PANEL_COMPONENT[k]; return <C key={k} vcIds={vcIds} rows={rows} canTool={can} />; })}
    </div>
  );
}

