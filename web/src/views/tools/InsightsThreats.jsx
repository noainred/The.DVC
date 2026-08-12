// InsightsThreats.jsx — SpecialTools.jsx(구 5,070줄)에서 분리(v2.282 대형 파일 분할). 본문은 원본 그대로 이동.
import React, { useState } from 'react';
import { Loading, ErrorBox, UsageCell, VmLink } from '../../components/ui.jsx';
import { Card, useTool } from './shared.jsx';


/** 운영 인사이트 — 라이트사이징 · 클러스터 N+1 · 알람 핫스팟 · GPU 유휴 (기존 스냅샷 기반). */
export function Insights({ scope }) {
  const { loading, data, error } = useTool('/tools/insights', scope ? { vcenterId: scope } : {});
  const [sec, setSec] = useState('rightsizing');
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  const rs = data.rightsizing, cl = data.clusters || [], ah = data.alarmHotspot, gw = data.gpuWaste;
  const n1Bad = cl.filter((c) => !c.n1Ok).length;
  const SECS = [
    ['rightsizing', `♻ VM 라이트사이징`],
    ['n1', `🛡 클러스터 N+1 (위험 ${n1Bad})`],
    ['alarms', `🚨 알람 핫스팟 (${ah.total})`],
    ['gpu', `🎮 GPU 유휴 (${gw.idleGpus})`],
  ];
  const vmRows = (arr) => (
    <div className="table-wrap" style={{ maxHeight: '52vh' }}>
      <table><thead><tr><th>VM</th><th>법인</th><th>호스트</th><th style={{ textAlign: 'right' }}>vCPU</th><th style={{ textAlign: 'right' }}>RAM</th><th>CPU%</th><th>MEM%</th></tr></thead>
        <tbody>
          {arr.length === 0 && <tr><td colSpan={7} className="center muted" style={{ padding: 18 }}>해당 VM이 없습니다.</td></tr>}
          {arr.map((v) => (
            <tr key={`${v.vcenterId}:${v.name}`}>
              {/* VM 이름 클릭 → 상세(VmLink가 이름+vCenter로 조회해 모달로 띄운다). 회수 후보를
                  판단하려면 OS·IP·스냅샷 등 상세가 필요한데 여기서 바로 확인할 수 있게 한다. */}
              <td><VmLink name={v.name} vcenterId={v.vcenterId} label={v.name} style={{ fontWeight: 700 }} /></td>
              <td className="muted">{v.vcenterId}</td><td className="muted" style={{ fontSize: 12 }}>{v.host}</td>
              <td style={{ textAlign: 'right' }}>{v.vcpu}</td><td style={{ textAlign: 'right' }}>{v.ramGB} GB</td>
              <td>{v.cpuPct == null ? '—' : <UsageCell pct={v.cpuPct} />}</td><td>{v.memPct == null ? '—' : <UsageCell pct={v.memPct} />}</td>
            </tr>
          ))}
        </tbody></table>
    </div>
  );
  return (
    <>
      <div className="kpis" style={{ marginBottom: 14 }}>
        <Card label="유휴 VM" value={rs.idleCount} accent="var(--amber)" meta="전원 ON·CPU<5%·MEM<20%" />
        <Card label="회수 가능(추정)" value={`${rs.reclaimableVcpu} vCPU`} meta={`${rs.reclaimableRamGB} GB RAM`} />
        <Card label="N+1 위험 클러스터" value={n1Bad} accent={n1Bad ? 'var(--red)' : 'var(--green)'} meta={`전체 ${cl.length} 클러스터`} />
        <Card label="유휴 GPU" value={gw.idleGpus} accent="var(--amber)" meta={`GPU 호스트 ${gw.totalGpuHosts} · 미보고 ${gw.unreporting}`} />
        <Card label="알람" value={ah.total} accent={ah.bySeverity.critical ? 'var(--red)' : 'var(--text)'} meta={`위험 ${ah.bySeverity.critical || 0} · 경고 ${ah.bySeverity.warning || 0}`} />
      </div>
      <div className="flex gap wrap" style={{ marginBottom: 10 }}>
        {SECS.map(([k, l]) => <button key={k} className={sec === k ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '7px 14px' }} onClick={() => setSec(k)}>{l}</button>)}
      </div>

      {sec === 'rightsizing' && (
        <>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>실사용률 기준. <b>유휴</b>(회수 후보) · <b>과대</b>(vCPU≥4·CPU&lt;10%) · <b>과소</b>(CPU&gt;85% 또는 MEM&gt;90%, 증설 필요).</div>
          <div className="section-title" style={{ fontSize: 14 }}>유휴 VM ({rs.idleCount})</div>{vmRows(rs.idle)}
          <div className="section-title" style={{ fontSize: 14, marginTop: 14 }}>과대 할당 VM ({rs.oversizedCount})</div>{vmRows(rs.oversized)}
          <div className="section-title" style={{ fontSize: 14, marginTop: 14 }}>과소(증설 필요) VM ({rs.undersizedCount})</div>{vmRows(rs.undersized)}
        </>
      )}
      {sec === 'n1' && (
        <div className="table-wrap" style={{ maxHeight: '64vh' }}>
          <div className="muted" style={{ fontSize: 12, margin: '0 0 8px' }}>호스트 1대(가장 큰 호스트) 장애 시 잔여 용량으로 현재 사용량을 수용할 수 있는지. 90% 초과·단일 호스트면 위험.</div>
          <table><thead><tr><th>법인</th><th>클러스터</th><th style={{ textAlign: 'right' }}>호스트</th><th>현재 CPU</th><th>현재 MEM</th><th>1대 장애 후 CPU</th><th>1대 장애 후 MEM</th><th>N+1</th></tr></thead>
            <tbody>
              {cl.map((c) => (
                <tr key={`${c.vcenterId}:${c.cluster}`} style={{ background: c.n1Ok ? undefined : 'rgba(239,68,68,.10)' }}>
                  <td className="muted">{c.vcenterId}</td><td><b>{c.cluster}</b></td><td style={{ textAlign: 'right' }}>{c.hosts}</td>
                  <td><UsageCell pct={c.cpuUsagePct} /></td><td><UsageCell pct={c.memUsagePct} /></td>
                  <td>{c.cpuAfterFailPct > 200 ? '—' : <UsageCell pct={Math.min(c.cpuAfterFailPct, 100)} />}</td>
                  <td>{c.memAfterFailPct > 200 ? '—' : <UsageCell pct={Math.min(c.memAfterFailPct, 100)} />}</td>
                  <td>{c.n1Ok ? <span className="badge green">여유</span> : <span className="badge red">위험</span>}</td>
                </tr>
              ))}
            </tbody></table>
        </div>
      )}
      {sec === 'alarms' && (
        <div className="grid2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <div><div className="section-title" style={{ fontSize: 14 }}>알람 많은 엔티티</div>
            <div className="table-wrap" style={{ maxHeight: '52vh' }}><table><thead><tr><th>엔티티</th><th style={{ textAlign: 'right' }}>알람 수</th></tr></thead>
              <tbody>{ah.topEntities.length === 0 && <tr><td colSpan={2} className="center muted" style={{ padding: 18 }}>알람 없음</td></tr>}
                {ah.topEntities.map((e) => <tr key={e.entity}><td>{e.entity}</td><td style={{ textAlign: 'right' }}><b>{e.count}</b></td></tr>)}</tbody></table></div></div>
          <div><div className="section-title" style={{ fontSize: 14 }}>센터별 알람</div>
            <div className="table-wrap" style={{ maxHeight: '52vh' }}><table><thead><tr><th>vCenter</th><th style={{ textAlign: 'right' }}>알람 수</th></tr></thead>
              <tbody>{ah.byVcenter.map((e) => <tr key={e.vcenterId || '_'}><td>{e.vcenterId || '—'}</td><td style={{ textAlign: 'right' }}><b>{e.count}</b></td></tr>)}</tbody></table></div></div>
        </div>
      )}
      {sec === 'gpu' && (
        <div className="table-wrap" style={{ maxHeight: '64vh' }}>
          <div className="muted" style={{ fontSize: 12, margin: '0 0 8px' }}>ESXi 보고 사용률 &lt;10% GPU 호스트(유휴/낭비 후보). 미보고({gw.unreporting})는 패스쓰루로 사용률 미관측.</div>
          <table><thead><tr><th>호스트</th><th>법인</th><th>GPU 모델</th><th style={{ textAlign: 'right' }}>개수</th><th>사용률</th><th style={{ textAlign: 'right' }}>할당 VM</th></tr></thead>
            <tbody>
              {gw.list.length === 0 && <tr><td colSpan={6} className="center muted" style={{ padding: 18 }}>유휴 GPU 호스트가 없습니다.</td></tr>}
              {gw.list.map((g) => (
                <tr key={g.host}><td><b>{g.host}</b></td><td className="muted">{g.vcenterId}</td><td>{g.model}</td>
                  <td style={{ textAlign: 'right' }}>{g.count}</td><td><UsageCell pct={g.util} /></td><td style={{ textAlign: 'right' }}>{g.assignedVms}</td></tr>
              ))}
            </tbody></table>
        </div>
      )}
    </>
  );
}

/** 위협 탐지 — 텔레메트리 기반(마이닝/위험포트/EOL/rogue) + NSX 분산 IDS 이벤트. 방어 목적. */
export function Threats({ scope }) {
  const { loading, data, error } = useTool('/tools/threats', scope ? { vcenterId: scope } : {});
  const [sec, setSec] = useState('mining');
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  const s = data.summary;
  const fmt = (t) => (t ? new Date(t).toLocaleString('ko-KR') : '—');
  const SECS = [
    ['mining', `⛏ 마이닝 의심 (${s.mining})`],
    ['risky', `🚪 위험 포트 (${s.riskyTotal})`],
    ['eol', `🧟 EOL OS (${s.eol})`],
    ['rogue', `👻 신규 rogue IP (${s.rogue})`],
    ['ids', `🛡 NSX IDS (${s.idsEvents})`],
  ];
  return (
    <>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>자사 인프라 <b>방어적 위협 탐지</b>입니다. 텔레메트리·스캔·NSX IDS 신호 기반이며, 확정 판정이 아닌 <b>점검 후보</b>를 제시합니다.</div>
      <div className="kpis" style={{ marginBottom: 14 }}>
        <Card label="마이닝 의심(고CPU)" value={s.mining} accent={s.mining ? 'var(--amber)' : 'var(--green)'} meta="전원ON·CPU≥90%" />
        <Card label="위험 포트 노출" value={s.riskyTotal} accent={s.riskyPublic ? 'var(--red)' : 'var(--amber)'} meta={`공인 노출 ${s.riskyPublic}`} />
        <Card label="EOL/취약 OS" value={s.eol} accent={s.eol ? 'var(--amber)' : 'var(--green)'} meta="지원종료 추정" />
        <Card label="신규 rogue IP" value={s.rogue} accent={s.rogue ? 'var(--amber)' : 'var(--green)'} meta="7일 내 첫 관측" />
        <Card label="NSX IDS 이벤트" value={s.idsEvents} accent={s.idsCritical ? 'var(--red)' : 'var(--text)'} meta={`위험 ${s.idsCritical}`} />
      </div>
      <div className="flex gap wrap" style={{ marginBottom: 10 }}>
        {SECS.map(([k, l]) => <button key={k} className={sec === k ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '7px 14px' }} onClick={() => setSec(k)}>{l}</button>)}
      </div>

      {sec === 'mining' && (
        <div className="table-wrap" style={{ maxHeight: '64vh' }}>
          <div className="muted" style={{ fontSize: 12, margin: '0 0 8px' }}>전원 ON·CPU ≥ 90%. 지속 고부하는 크립토마이닝/폭주 프로세스 신호일 수 있습니다(확정 아님).</div>
          <table><thead><tr><th>VM</th><th>법인</th><th>호스트</th><th>CPU%</th><th>MEM%</th></tr></thead>
            <tbody>{data.mining.length === 0 && <tr><td colSpan={5} className="center muted" style={{ padding: 18 }}>해당 없음</td></tr>}
              {data.mining.map((v) => <tr key={`${v.vcenterId}:${v.name}`}><td><b>{v.name}</b></td><td className="muted">{v.vcenterId}</td><td className="muted" style={{ fontSize: 12 }}>{v.host}</td><td><UsageCell pct={v.cpuPct} /></td><td>{v.memPct == null ? '—' : <UsageCell pct={v.memPct} />}</td></tr>)}</tbody></table>
        </div>
      )}
      {sec === 'risky' && (
        <div className="table-wrap" style={{ maxHeight: '64vh' }}>
          <div className="muted" style={{ fontSize: 12, margin: '0 0 8px' }}>스캔에서 확인된 위험 서비스 포트(Telnet/SMB/RDP/DB 등). <b>공인 IP 노출</b>은 즉시 점검 권장.</div>
          <table><thead><tr><th>IP</th><th>호스트명</th><th>위험 포트</th><th>분류</th><th>위험도</th></tr></thead>
            <tbody>{data.risky.length === 0 && <tr><td colSpan={5} className="center muted" style={{ padding: 18 }}>해당 없음</td></tr>}
              {data.risky.map((r) => <tr key={r.ip} style={{ background: r.public ? 'rgba(239,68,68,.10)' : undefined }}><td><b>{r.ip}</b></td><td className="muted">{r.hostname || '—'}</td><td>{(r.ports || []).map((p) => <span key={p} className="badge amber" style={{ marginRight: 4 }}>{p}</span>)}</td><td>{r.public ? <span className="badge red">공인</span> : <span className="badge gray">사설</span>}</td><td>{r.severity === 'high' ? <span className="badge red">높음</span> : <span className="badge amber">보통</span>}</td></tr>)}</tbody></table>
        </div>
      )}
      {sec === 'eol' && (
        <div className="table-wrap" style={{ maxHeight: '64vh' }}>
          <table><thead><tr><th>VM</th><th>법인</th><th>OS</th><th>사유</th></tr></thead>
            <tbody>{data.eol.length === 0 && <tr><td colSpan={4} className="center muted" style={{ padding: 18 }}>해당 없음</td></tr>}
              {data.eol.map((v) => <tr key={`${v.vcenterId}:${v.name}`}><td><b>{v.name}</b></td><td className="muted">{v.vcenterId}</td><td>{v.os}</td><td><span className="badge amber">{v.reason}</span></td></tr>)}</tbody></table>
        </div>
      )}
      {sec === 'rogue' && (
        <div className="table-wrap" style={{ maxHeight: '64vh' }}>
          <div className="muted" style={{ fontSize: 12, margin: '0 0 8px' }}>vCenter가 모르는데 최근 7일 내 처음 스캔된 IP — 미등록 장비/침입 가능성 점검.</div>
          <table><thead><tr><th>IP</th><th>호스트명</th><th>최초 관측</th><th>포트</th></tr></thead>
            <tbody>{data.rogue.length === 0 && <tr><td colSpan={4} className="center muted" style={{ padding: 18 }}>해당 없음</td></tr>}
              {data.rogue.map((r) => <tr key={r.ip}><td><b>{r.ip}</b></td><td className="muted">{r.hostname || '—'}</td><td className="muted" style={{ fontSize: 12 }}>{fmt(r.firstSeen)}</td><td className="muted" style={{ fontSize: 12 }}>{(r.ports || []).join(', ')}</td></tr>)}</tbody></table>
        </div>
      )}
      {sec === 'ids' && (
        <>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>NSX 분산 IDS/IPS. {data.ids.managers.map((m) => `${m.name}: ${m.enabled === true ? '활성' : m.enabled === false ? '비활성' : '미상'}(프로파일 ${m.profiles})`).join(' · ') || 'NSX 매니저 없음'}</div>
          <div className="table-wrap" style={{ maxHeight: '60vh' }}>
            <table><thead><tr><th>시각</th><th>시그니처</th><th>심각도</th><th>출발지</th><th>목적지</th><th>조치</th><th style={{ textAlign: 'right' }}>횟수</th></tr></thead>
              <tbody>{data.ids.events.length === 0 && <tr><td colSpan={7} className="center muted" style={{ padding: 18 }}>IDS 이벤트가 없습니다(미활성 또는 NSX 버전/NAPP 미지원일 수 있음).</td></tr>}
                {data.ids.events.map((e) => <tr key={e.id}><td className="muted" style={{ fontSize: 12 }}>{fmt(e.at)}</td><td>{e.signature}</td><td>{/crit|high/.test(e.severity) ? <span className="badge red">{e.severity}</span> : <span className="badge amber">{e.severity}</span>}</td><td className="muted">{e.src || '—'}</td><td className="muted">{e.dst || '—'}</td><td>{e.action || '—'}</td><td style={{ textAlign: 'right' }}>{e.count}</td></tr>)}</tbody></table>
          </div>
        </>
      )}
    </>
  );
}
