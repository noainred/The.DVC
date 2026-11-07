// 호스트 상세 ‘네트워크’ 카드의 CVP 업링크 블록(v2.920 — 시안 D-② HostNet). 매칭 포트 타일(송신·수신·에러) + 그 장비의 24h 이벤트.
//   데이터는 HostDetail 이 받아 넘긴다(/hosts/:id/net-uplinks — NIC 표의 CVP 열과 같은 응답). 문구는 hostNetText.js(순수).
import React from 'react';
import { basisOf, bpsText, errText, dropText, daySumText, speedText, portLabel, uplinkSummary, uplinkTotals, SEVERITY_BADGE, eventTimeText } from './hostNetText.js';
import { agoText } from './tools/relTime.js';

export default function HostNetCvp({ data, nics = [] }) {
  if (!data) return null;
  if (data.error) return <div className="muted hd-note">CVP 업링크를 읽지 못했습니다({data.error}).</div>;
  const s = uplinkSummary(data, nics);
  const ups = Array.isArray(data.uplinks) ? data.uplinks : [];
  const t = uplinkTotals(ups);
  return (
    <div style={{ marginTop: 12 }}>
      <div className="flex wrap" style={{ alignItems: 'baseline', gap: 8, justifyContent: 'space-between' }}>
        <div style={{ fontSize: 12.5 }}><b>CVP 업링크</b> <span className="muted">{s.text}</span></div>
        <span className="muted" style={{ fontSize: 11 }}>방향은 스위치 포트 기준 — In = 서버 송신 · Out = 서버 수신</span>
      </div>
      {s.note && <div className="muted hd-note" style={{ marginTop: 4 }}>{s.note}</div>}
      {ups.length > 0 && (
        <>
          <div className="hd-kpis" style={{ margin: '8px 0' }}>
            <div className="ht-kpi"><span className="ht-kpi-l">업링크 지금 송신 / 수신</span><span className="ht-kpi-v hd-kpi-v" style={{ fontSize: 16 }}>{t.tx == null && t.rx == null ? '—' : `${bpsText(t.tx)} / ${bpsText(t.rx)}`}</span><span className="ht-kpi-s">매칭 포트 {ups.length} 합{t.unmeasured ? ` · 값 없는 포트 ${t.unmeasured}` : ''}</span></div>
            <div className="ht-kpi"><span className="ht-kpi-l">업링크 에러 · 최근 24시간</span><span className="ht-kpi-v hd-kpi-v" style={{ fontSize: 16 }}>{t.errDay == null ? '—' : t.errDay.toLocaleString('en-US')}</span><span className="ht-kpi-s">매칭 포트 in + out 합 · 직전 주기 {t.err == null ? '—' : t.err.toLocaleString('en-US')}</span></div>
            <div className="ht-kpi"><span className="ht-kpi-l">업링크 드롭 · 최근 24시간</span><span className="ht-kpi-v hd-kpi-v" style={{ fontSize: 16 }}>{t.dropDay == null ? '—' : t.dropDay.toLocaleString('en-US')}</span><span className="ht-kpi-s">스위치 discards in + out · 직전 주기 {t.drop == null ? '—' : t.drop.toLocaleString('en-US')} · ESXi 쪽 드롭은 별도</span></div>
          </div>
          <div className="flex gap wrap">
            {ups.map((u, i) => {
              const b = basisOf(u.basis);
              return (
                <div key={`${u.cvpId}-${u.key}-${u.port}-${i}`} className="card" style={{ padding: '8px 10px', minWidth: 200, flex: '1 1 200px', fontSize: 12 }} title={`설명: ${u.desc || ''}\n근거: ${b.note}`}>
                  <div className="flex" style={{ justifyContent: 'space-between', gap: 6 }}>
                    <b style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{portLabel(u)}</b>
                    <span className={`badge ${b.tone}`} style={{ flex: 'none' }}>{b.label}</span>
                  </div>
                  {u.evidence ? <div className="muted" style={{ fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={[u.evidence, ...(u.also || []).map((x) => `${x.label} — ${x.evidence || ''}`)].join('\n')}>근거 {u.evidence}{u.also?.length ? ` 외 ${u.also.length}` : ''}</div> : null}
                  <div className="muted" style={{ fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.nic ? `${u.nic} · ` : 'NIC 미확정 · '}{u.oper === 'up' ? 'Up' : u.oper === 'down' ? 'Down' : u.oper || '—'} · {speedText(u.speedBps)}{u.lag ? ` · ${u.lag}` : ''}</div>
                  <div style={{ marginTop: 4 }}>송신 <b>{bpsText(u.inBps)}</b> · 수신 <b>{bpsText(u.outBps)}</b></div>
                  <div className="muted" style={{ fontSize: 11 }}>에러 in/out {errText(u)} · 드롭 in/out {dropText(u)} · 측정 {agoText(u.rateTs ?? u.ts)}</div>
                  <div className="muted" style={{ fontSize: 11 }} title="최근 24시간 원시 표본 합 — 값이 있는 표본만 더했습니다(첫 주기·간격 비정상·카운터 리셋·드롭 수집 전은 빠짐)">24시간 에러 {daySumText(u.day, 'err')} · 드롭 {daySumText(u.day)}</div>
                </div>
              );
            })}
          </div>
        </>
      )}
      {data.events?.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>매칭 스위치의 CVP 이벤트 · 최근 24시간 {data.events.length}건</div>
          <div className="flex gap wrap" style={{ flexDirection: 'column', gap: 4 }}>
            {data.events.map((e, i) => (
              <div key={`${e.ts}-${i}`} style={{ fontSize: 12, display: 'flex', gap: 8, alignItems: 'baseline', minWidth: 0 }}>
                <span className={`badge ${SEVERITY_BADGE[e.severity] || 'gray'}`} style={{ flex: 'none' }}>{e.severity}</span>
                <span className="muted" style={{ flex: 'none', fontFamily: 'var(--mono)', fontSize: 11 }}>{eventTimeText(e.ts)}</span>
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.desc}>{e.title || e.type || '—'}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {ups.length > 0 && !data.events?.length && !data.eventsUnavailable && <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>매칭 스위치의 최근 24시간 CVP 이벤트 없음</div>}
      {data.vmNicMacs > 0 && <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>이 호스트 VM 의 vNIC MAC {data.vmNicMacs}개 — 스위치 MAC 테이블 수집(다음 단계)에서 매칭 근거로 씁니다</div>}
    </div>
  );
}
