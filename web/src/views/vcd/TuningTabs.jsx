/**
 * views/vcd/TuningTabs.jsx — VM · ESXi 호스트 개체 보기의 '성능 튜닝' 탭(v2.897 — 승인 시안 ⑫⑬ · 기본값 11~13).
 * vSphere Client 에 없는 포탈 전용 탭 — 흩어진 판정(축소 근거 · 경합 · 구성 · 데이터스토어)의 이 개체 몫을 한 자리에 모으고 조치 계획을 붙인다.
 * 판정 · 계획은 vcd/tuning.js(순수). 서버 호출은 VM 의 /tools/rightsize(열 때 1회 · 기간을 바꿀 때) 하나 — 호스트 탭은 받은 목록만 쓴다.
 * 조치 계획은 저장하지 않는다(기본값 11 — 체크리스트 내보내기만). 적용은 지금 도구 · vSphere 에서.
 */
import React, { useMemo, useState } from 'react';
import { toolAllowed, canCsv } from '../../api.js';
import { ErrorBox, Loading, UsageCell, StateBadge } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { useOnce, toolDenied } from './useOnce.js';
import { Card, KV, Note } from './VcdParts.jsx';
import { dayStamp } from '../../dayStamp.js';
import { vmDiskRows, vmDatastoreRows, vmsOnHost, hostDatastoresFromVms } from './objTabs.js';
import { gbText } from './vcdTabs.js';
import {
  VM_TUNING_DAYS, DEFAULT_VM_TUNING_DAYS, vmTuningAxes, vmTuningPlan, hostTuningAxes, hostTuningPlan, heavyNeighbors, planCsv, planMarkdown,
} from './tuning.js';
import { vmContentionFindings, CONTENTION_TEXT } from '../contention/contentionText.js';
import { vmCfgFindings, VM_CFG_TEXT } from '../vmcfg/vmCfgText.js';

const RightsizeReport = React.lazy(() => import('../tools/RightsizeReport.jsx'));
const STATE_COLOR = { ok: 'var(--green)', warn: 'var(--amber)', crit: 'var(--red)', unknown: 'var(--text-dim)' };
const LV_BADGE = { crit: ['red', '위험'], warn: ['amber', '주의'], ok: ['gray', '참고'] };
const GRID = 'vcd-obj-grid';

function Axes({ axes }) {
  return (
    <div className="vcd-axes">
      {axes.map((a) => (
        <div key={a.k}>
          <span>{a.label}</span>
          <b style={{ color: STATE_COLOR[a.state] }}>{a.state === 'unknown' && a.title === '—' ? '—' : a.title}</b>
          {a.detail && <i>{a.detail}</i>}
        </div>
      ))}
    </div>
  );
}

function download(name, text, type) {
  try {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  } catch { /* 내려받기를 막은 환경 — 버튼이 아무것도 하지 않는다 */ }
}

function Plan({ rows, title, fileStem }) {
  const can = canCsv();
  const safe = String(fileStem || 'tuning').replace(/[^a-zA-Z0-9._-]+/g, '_');
  return (
    <Card title="조치 계획" sub="진단 근거에서만 만든 목록 · 적용은 지금 도구 · vSphere 에서 · 저장하지 않음"
      more={can && rows.length ? (
        <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
          <button type="button" className="tab" style={{ flex: 'none', padding: '5px 10px' }} onClick={() => download(`${safe}-tuning-${dayStamp()}.csv`, planCsv(rows, title), 'text/csv;charset=utf-8')}>⤓ CSV</button>
          <button type="button" className="tab" style={{ flex: 'none', padding: '5px 10px' }} onClick={() => download(`${safe}-tuning-${dayStamp()}.md`, planMarkdown(rows, title), 'text/markdown;charset=utf-8')}>⤓ 체크리스트(.md)</button>
        </span>
      ) : null}>
      {rows.length ? (
        <STable className="v3-table" minWidth={860}>
          <thead><tr><th>#</th><th>단계</th><th>조치</th><th>근거</th><th>위험 · 조건</th><th>어디서</th></tr></thead>
          <tbody>
            {rows.map((r, i) => {
              const [b, t] = LV_BADGE[r.lv] || ['gray', r.lv];
              return (
                <tr key={r.k}>
                  <td data-sort={String(i)}>{i + 1}</td>
                  <td data-sort={r.lv === 'crit' ? '0' : r.lv === 'warn' ? '1' : '2'}><span className={`badge ${b}`}>{t}</span></td>
                  <td style={{ whiteSpace: 'normal', minWidth: 220 }}><b>{r.action}</b></td>
                  <td style={{ whiteSpace: 'normal', minWidth: 200 }} className="muted">{r.why || '—'}</td>
                  <td style={{ whiteSpace: 'normal', minWidth: 160 }} className="muted">{r.risk || '—'}</td>
                  <td style={{ whiteSpace: 'normal' }}>{r.tool && toolAllowed(r.tool) ? <a href={`#/tools/${r.tool}`} className="vcd-more">{r.where} →</a> : r.where}</td>
                </tr>
              );
            })}
          </tbody>
        </STable>
      ) : <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>진단에서 조치할 항목이 나오지 않았습니다(‘—’ 인 축은 판정하지 않은 것이라 이 목록에 들어가지 않습니다).</div>}
      <Note>상태(대기 · 담당 확인 · 적용 · 무시)는 저장하지 않습니다 — 체크리스트로 내려받아 씁니다{can ? '' : '(내려받기는 CSV · 텍스트 내보내기 권한이 있을 때만)'}. 바꾼 뒤에는 같은 기간으로 이 탭을 다시 열어 비교합니다.</Note>
    </Card>
  );
}

/* ── VM ──────────────────────────────────────────────────────────────────── */
export function VmTuning({ vm, vms, datastores }) {
  const [days, setDays] = useState(DEFAULT_VM_TUNING_DAYS);
  const [report, setReport] = useState(false);
  const on = vm?.powerState === 'POWERED_ON';
  const allowed = toolAllowed('rightsizing');
  const q = useOnce('/tools/rightsize', { vmId: vm?.id, days }, allowed && on && !!vm?.id);
  const disks = useMemo(() => vmDiskRows(vm, datastores), [vm, datastores]);
  const dsRows = useMemo(() => vmDatastoreRows(disks), [disks]);
  const neighbors = useMemo(() => heavyNeighbors(vmsOnHost(vms, { name: vm?.host, vcenterId: vm?.vcenterId }), 5), [vms, vm]);
  const rs = q.data && q.data.ok !== false ? q.data : null;
  const rsError = q.error ? (q.error.serverReason || q.error.message || String(q.error)) : '';
  const axes = vmTuningAxes({ vm, rs, rsError: rs ? '' : rsError, rsDenied: !allowed, dsRows });
  const plan = vmTuningPlan({ vm, rs, dsRows });
  const cont = vmContentionFindings(vm);
  const cfgF = vmCfgFindings(vm);
  const c = rs?.cpu; const m = rs?.mem;
  const p = vm?.perfc;
  return (
    <>
      <Card title="진단" sub={rs?.window ? `표본 ${rs.window.samples ?? '—'} · 덮음 ${rs.window.coveragePct ?? '—'}% · 롤업 ${rs.window.intervalSec ? `${rs.window.intervalSec / 60}분` : '—'}` : ''}
        more={<span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="muted" style={{ fontSize: 11.5 }}>기간</span>
          {VM_TUNING_DAYS.map((d) => <button key={d} type="button" className={days === d ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '4px 10px' }} onClick={() => setDays(d)}>{d}일</button>)}
          {allowed && on && <button type="button" className="tab" style={{ flex: 'none', padding: '4px 10px' }} onClick={q.reload} disabled={q.loading}>{q.loading ? '계산 중…' : '다시 계산'}</button>}
        </span>}>
        <Axes axes={axes} />
        <Note>판정은 기존 기능의 값 그대로입니다(VM 라이트사이징 · CPU 경합 · 디스크 지연 · VM 구성 점검 · 데이터스토어 알람 규칙). ‘—’ 는 못 읽거나 판정하지 않은 것이고 ‘정상’ 이 아닙니다. 점수 · 등급은 두지 않습니다.</Note>
      </Card>

      <div className={GRID}>
        <Card title="자원 적정화" sub="/tools/rightsize · 축소 근거 리포트와 같은 계산"
          more={allowed && on ? <button type="button" className="vcd-more" onClick={() => setReport(true)}>리포트 전체 →</button> : null}>
          {!on ? <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>꺼진 VM 은 사용량 근거가 없어 판정하지 않습니다.</div>
            : !allowed ? <div style={{ padding: 12 }}><ErrorBox error={toolDenied('VM 라이트사이징')} /></div>
              : q.error && !q.data ? <div style={{ padding: 12 }}><ErrorBox error={q.error} /></div>
                : !rs ? <Loading label="적정화 근거(vCenter 성능 롤업)" /> : (
                  <KV rows={[
                    ['판정', <span key="v"><b>{rs.verdict?.title || '—'}</b>{rs.verdict?.summary ? <span className="muted"> · {rs.verdict.summary}</span> : null}</span>],
                    ['CPU', c ? `${c.vcpu} vCPU · 사용 p95 ${c.usagePct?.p95 ?? '—'}% · 최대 ${c.usagePct?.max ?? '—'}%${c.recommendedVcpu != null ? ` · 권장 ${c.recommendedVcpu} vCPU` : ''}` : '—'],
                    ['메모리', m ? `${gbText(m.allocMB / 1024)} · 워킹셋 ${gbText((m.workingSetMB ?? 0) / 1024)}${m.recommendedMB != null ? ` · 권장 ${gbText(m.recommendedMB / 1024)}` : ''}` : '—'],
                    ['감축 금지 신호', m ? `벌룬 ${m.balloon?.n ? `${m.balloon.samplesAbove0 || 0}회` : '못 읽음'} · 스왑 ${m.swapped?.n ? `${m.swapped.samplesAbove0 || 0}회` : '못 읽음'} · Ready p95 ${c?.readyPct?.p95 ?? '—'}%` : '—'],
                    ['근거', rs.evidence?.sufficient === false ? <span className="badge amber" key="e">불충분 — {(rs.evidence.reasons || [])[0] || ''}</span> : '충분'],
                  ]} />
                )}
          <Note>값은 vCenter 성능 롤업을 열 때 빌려옵니다(저장 안 함). 신호를 못 읽었으면 감축을 권하지 않습니다(서버 정책).</Note>
        </Card>

        <Card title="CPU 경합 · 같은 호스트의 무거운 VM" sub="perfc 최근 창">
          <KV rows={[
            ['CPU 대기(Ready)', p?.readyPct ? `${p.readyPct.avg ?? '—'}% (최대 ${p.readyPct.max ?? '—'}%)` : '—'],
            ['Co-stop', p?.costopPct ? `${p.costopPct.avg ?? '—'}% (최대 ${p.costopPct.max ?? '—'}%)` : '—'],
            ['판정', cont.filter((f) => f.code.startsWith('cpu-')).length ? cont.filter((f) => f.code.startsWith('cpu-')).map((f) => CONTENTION_TEXT[f.code]?.title || f.code).join(' · ') : (p ? '경고선 아래' : '측정하지 않음')],
          ]} />
          {neighbors.length > 0 && (
            <STable className="v3-table" minWidth={460}>
              <thead><tr><th>{vm.host} 의 VM</th><th>CPU</th><th>vCPU</th><th>Ready</th></tr></thead>
              <tbody>
                {neighbors.map((v) => (
                  <tr key={v.id}><td>{v.id === vm.id ? <b>{v.name} (이 VM)</b> : v.name}</td><td data-sort={String(v.cpuUsagePct ?? '')}><UsageCell pct={v.cpuUsagePct} /></td><td>{v.cpuCount ?? '—'}</td><td data-sort={String(v.perfc?.readyPct?.avg ?? '')}>{v.perfc?.readyPct?.avg != null ? `${v.perfc.readyPct.avg}%` : '—'}</td></tr>
                ))}
              </tbody>
            </STable>
          )}
          <Note>이웃 VM 이 무겁다는 것만으로 원인을 단정하지 않습니다. 이동(vMotion)은 포탈이 하지 않습니다 — vSphere 에서.</Note>
        </Card>

        <Card title="스토리지 지연" sub="perfc 디스크 · 데이터스토어 사용률">
          <KV rows={[
            ['읽기 · 쓰기 지연', p?.readMs || p?.writeMs ? `${p.readMs?.avg ?? '—'} ms · ${p.writeMs?.avg ?? '—'} ms${p.disk ? ` (가장 느린 ${p.disk})` : ''}` : '—'],
            ['스냅샷', vm.snapshotCount ? `${vm.snapshotCount}개 · ${gbText(vm.snapshotSizeGB)}` : '없음'],
          ]} />
          {dsRows?.length ? (
            <STable className="v3-table" minWidth={340}>
              <thead><tr><th>데이터스토어</th><th>이 VM 디스크</th><th>DS 사용률</th></tr></thead>
              <tbody>{dsRows.map((d) => <tr key={d.datastore || '-'}><td className="mono">{d.datastore || '—'}</td><td>{d.disks}</td><td data-sort={String(d.dsUsagePct ?? '')}>{d.dsKnown ? <UsageCell pct={d.dsUsagePct} /> : '—'}</td></tr>)}</tbody>
            </STable>
          ) : <div className="muted" style={{ padding: '0 14px 10px', fontSize: 12.5 }}>{dsRows ? '디스크가 없습니다.' : 'vmcfg 가 아직 디스크를 읽지 않았습니다.'}</div>}
        </Card>

        <Card title="구성 권장" sub="VM 구성 점검과 같은 판정">
          {!vm.cfg ? <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>vmcfg 가 아직 이 VM 을 읽지 않았습니다.</div>
            : cfgF.length ? (
              <div style={{ padding: '6px 14px 10px', display: 'grid', gap: 8 }}>
                {cfgF.map((f) => (
                  <div key={f.code} className="vcd-line" style={{ alignItems: 'flex-start' }}>
                    <span className={`badge ${f.sev === 'crit' ? 'red' : f.sev === 'warn' ? 'amber' : 'gray'}`} style={{ flex: 'none' }}>{f.sev === 'crit' ? '위험' : f.sev === 'warn' ? '주의' : '참고'}</span>
                    <span style={{ minWidth: 0 }}><b>{VM_CFG_TEXT[f.code]?.title || f.code}</b><span className="muted" style={{ display: 'block', fontSize: 12 }}>{VM_CFG_TEXT[f.code]?.fix || ''}</span></span>
                  </div>
                ))}
              </div>
            ) : <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>읽은 값에서 확인할 항목이 없습니다.</div>}
          <Note>전원 정책 · NUMA 배치 · 지연 민감도 · 네트워크 어댑터 유형(vmxnet3 여부)은 수집하지 않습니다(2차).</Note>
        </Card>
      </div>

      <Plan rows={plan} title={`${vm.name} 성능 튜닝 체크리스트`} fileStem={vm.name} />
      {report && rs && <React.Suspense fallback={null}><RightsizeReport vm={vm} onClose={() => setReport(false)} /></React.Suspense>}
    </>
  );
}

/* ── ESXi 호스트 ─────────────────────────────────────────────────────────── */
export function HostTuning({ host, vms, datastores, includeOff = true }) {
  const onHost = useMemo(() => vmsOnHost(vms, host), [vms, host]);
  const counted = useMemo(() => (includeOff ? onHost : onHost.filter((v) => v.powerState === 'POWERED_ON')), [onHost, includeOff]);
  const vcpuAlloc = counted.reduce((a, v) => a + (Number(v.cpuCount) || 0), 0);
  const memAllocMB = counted.reduce((a, v) => a + (Number(v.memMB) || 0), 0);
  const ds = useMemo(() => hostDatastoresFromVms(onHost, datastores), [onHost, datastores]);
  const axes = hostTuningAxes({ host, vcpuAlloc, memAllocMB, onHost, dsRows: ds.rows });
  const plan = hostTuningPlan({ host, onHost, dsRows: ds.rows, vcpuAlloc });
  const heavy = heavyNeighbors(onHost, 8);
  return (
    <>
      <Card title="진단" sub={`이 호스트 VM ${onHost.length}대 · 가상화율 기준 ${includeOff ? '전체 VM(꺼진 VM 포함)' : '켜진 VM 만'}`}>
        <Axes axes={axes} />
        <Note>판정은 기존 값 그대로(호스트 사용률 · 트리와 같은 가상화율 기준 · CPU 경합 규칙 · ESXi 호스트 구성 점검 · 데이터스토어 알람 규칙). 호스트 벌룬 · 스왑 합 · 전원 정책 · NUMA 는 수집하지 않습니다.</Note>
      </Card>
      <div className={GRID}>
        <Card title="이 호스트를 무겁게 하는 VM" sub="CPU 사용률 × vCPU 순">
          {heavy.length ? (
            <STable className="v3-table" minWidth={520}>
              <thead><tr><th>VM</th><th>CPU</th><th>vCPU</th><th>메모리</th><th>Ready</th></tr></thead>
              <tbody>
                {heavy.map((v) => (
                  <tr key={v.id}><td><b>{v.name}</b></td><td data-sort={String(v.cpuUsagePct ?? '')}><UsageCell pct={v.cpuUsagePct} /></td><td>{v.cpuCount ?? '—'}</td><td data-sort={String(v.memMB ?? '')}>{v.memMB != null ? gbText(v.memMB / 1024) : '—'}</td><td data-sort={String(v.perfc?.readyPct?.avg ?? '')}>{v.perfc?.readyPct?.avg != null ? `${v.perfc.readyPct.avg}%` : '—'}</td></tr>
                ))}
              </tbody>
            </STable>
          ) : <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>사용률을 읽은 켜진 VM 이 없습니다.</div>}
          <Note>VM 별 감축 근거는 그 VM 의 개체 보기 › 성능 튜닝에서 봅니다(여기서 VM 수십 대의 성능 롤업을 한꺼번에 묻지 않습니다 — 고RTT vCenter 부하).</Note>
        </Card>
        <Card title="하드웨어 · 상태">
          <KV rows={[
            ['상태', <StateBadge key="s" state={host.connectionState} />],
            ['CPU', `${host.cpuSockets ?? '—'} 소켓 · ${host.cpuCores ?? '—'} 코어 · 사용 ${host.cpuUsagePct ?? '—'}%`],
            ['메모리', `${gbText((host.memTotalMB ?? null) == null ? null : host.memTotalMB / 1024)} · 사용 ${host.memUsagePct ?? '—'}%`],
            ['소비 전력', host.powerWatts > 0 ? `${host.powerWatts} W` : '—'],
            ['온도', host.tempMaxC != null ? `최고 ${host.tempMaxC} °C` : '—'],
            ['재부팅 필요', host.hcfg ? (host.hcfg.rebootRequired === true ? '예' : host.hcfg.rebootRequired === false ? '아니오' : '—') : '—'],
          ]} />
          <Note>온도 · 전력에서 스로틀링을 추정하지 않습니다(센서 값 그대로).</Note>
        </Card>
      </div>
      <Plan rows={plan} title={`${host.name} 성능 튜닝 체크리스트`} fileStem={host.name} />
    </>
  );
}
