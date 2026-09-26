import React from 'react';
import { usePolling, can } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { loadPhase, loadText } from '../../version_4/loadState.js';
import { fmtInt, siteRows } from '../../console/consoleData.js';
import { agoText } from '../../views/tools/relTime.js';
import { opsStatus, infraTotals, trustSummary, attentionSites } from '../overviewData.js';

/**
 * V5 Overview(v2.616) — 카드 3장(현재 운영 상태 · 인프라 규모 · 데이터 신뢰도). 시안 ① 그대로.
 * 폴링: /overview 30초 · /alarms 30초(inv.alarms 권한이 있을 때만) · /hosts 60초(영향 호스트가 있을 때만 —
 * 영향 VM 을 세려고 부른다. 없으면 부르지 않는다). 권한이 없는 API 는 호출하지 않는다(403 을 만들지 않는다).
 * 값이 없으면 '—' 이고 단위를 붙이지 않는다(v2.575 — '— TB' 는 0 처럼 읽힌다).
 */
const LEVEL = {
  ok: { label: '정상', color: 'var(--green)' },
  warn: { label: '주의', color: 'var(--amber)' },
  crit: { label: '위험', color: 'var(--red)' },
  wait: { label: '판정 대기', color: 'var(--text)' },
};
const tb = (v) => (v == null ? '—' : `${Number(v).toLocaleString('en-US', { maximumFractionDigits: 1 })} TB`);
const dash = (v) => (v == null ? '—' : fmtInt(v));

export default function V5Overview({ scope = '', health, healthError, onGotoTab }) {
  const { data: ov, error } = usePolling('/overview', {}, 30_000);
  const canAlarms = can('inv.alarms');
  const { data: alarms } = usePolling(canAlarms ? '/alarms' : '', {}, 30_000);
  const pre = opsStatus({ ov, alarms: canAlarms ? alarms : null, hosts: null, scopeId: scope });
  const needHosts = can('inv.hosts') && (pre.affectedHosts || 0) > 0;
  const { data: hosts } = usePolling(needHosts ? '/hosts' : '', {}, 60_000);
  const ops = needHosts ? opsStatus({ ov, alarms, hosts, scopeId: scope }) : pre;
  const infra = infraTotals(ov, scope);
  const trust = trustSummary({ health, ov, scopeId: scope });

  if (error && !ov) return <ErrorBox message={error} />;
  if (!ov) return <Loading label="Overview" />;
  if (!ov.global) {
    const phase = loadPhase({ health, healthError, poll: { data: null, error } });
    const t = loadText(phase, { health, pollError: error });
    return <div className="v5-card"><div className="v5-card-title">수집 준비 중</div><div className="v5-line">{t.long}</div></div>;
  }

  const rows = siteRows(ov.sites || []).filter((r) => !scope || r.id === scope);
  const attention = attentionSites(rows, 5);
  const trustColor = trust.unreachable > 0 ? 'var(--red)' : trust.pending > 0 ? 'var(--amber)' : 'var(--green)';

  return (
    <div>
      <div className="v5-ov-head">
        <h2>Overview</h2>
        <span className="muted" style={{ fontSize: 13 }}>{scope ? `${rows[0]?.name || scope} 범위` : '전체 법인'} · vCenter {fmtInt(ops.total)}곳 기준</span>
      </div>
      <div className="v5-ov-grid">
        <section className="v5-card" aria-label="현재 운영 상태">
          <div className="v5-card-title">현재 운영 상태<span className="v5-card-sub">vCenter 단위</span></div>
          <div className="v5-tiles">
            {['ok', 'warn', 'crit', 'wait'].map((k) => (
              <button key={k} type="button" className="v5-tile" onClick={() => onGotoTab?.(k === 'ok' || k === 'wait' ? 'vcenters' : 'alarms')}
                title={k === 'wait' ? '첫 수집 중이거나 경보·사용률을 읽지 못한 곳 — 정상으로 세지 않았습니다' : undefined}>
                <span className="v5-tile-label">{LEVEL[k].label}</span>
                <span className="v5-tile-value" style={{ color: ops[k] > 0 ? LEVEL[k].color : 'var(--text)' }}>{fmtInt(ops[k])}</span>
              </button>
            ))}
          </div>
          <div className="v5-line">
            {canAlarms ? (
              <>영향 법인 <b>{dash(ops.affectedSites)}</b> · 영향 호스트 <b>{dash(ops.affectedHosts)}</b> · 영향 호스트의 VM <b>{ops.affectedVmsUnknown > 0 && ops.affectedVms != null ? `최소 ${fmtInt(ops.affectedVms)}` : dash(ops.affectedVms)}</b>
                {ops.affectedVmsUnknown > 0 && <span className="muted" style={{ fontSize: 12 }}> (VM 수를 모르는 호스트 {ops.affectedVmsUnknown}대)</span>}</>
            ) : '알람 조회 권한(inv.alarms)이 없어 영향 범위를 계산하지 않았습니다.'}
          </div>
          {attention.length > 0 && (
            <div className="v5-sites">
              {attention.map((r) => {
                const lv = r.level;
                return (
                  <div key={r.id} className="v5-site">
                    <span className="v5-dot" style={{ background: LEVEL[lv].color }} />
                    <span className="v5-site-name" title={r.name}>{r.name}</span>
                    <span className="muted" style={{ fontSize: 12 }}>
                      {r.why}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          <div className="v5-note">
            위험 = 연결 실패 또는 위험 경보·사용률 90% 이상, 주의 = 주의 경보·75% 이상.
            {ops.maint > 0 && ` 점검중 ${ops.maint}곳은 어느 쪽에도 세지 않았습니다.`}
            {ops.off > 0 && ` 비활성(수집 꺼짐) ${ops.off}곳은 판정하지 않았습니다.`}
            {' '}영향 VM 은 경보가 걸린 호스트에 올라간 VM 수입니다(경보에는 VM 대상이 없습니다).
          </div>
        </section>

        <section className="v5-card" aria-label="인프라 규모">
          <div className="v5-card-title">인프라 규모<span className="v5-card-sub">{scope ? '선택 법인' : `vCenter ${dash(infra?.vcenters)}`}</span></div>
          <div className="v5-tiles two">
            <div className="v5-tile" title={infra?.physicalNote || 'iDRAC 로 수집하는 물리 서버'}>
              <span className="v5-tile-label">물리 서버</span>
              <span className="v5-tile-value">{dash(infra?.physical)}</span>
              <span className="v5-tile-meta">iDRAC 등록 기준</span>
            </div>
            <button type="button" className="v5-tile" onClick={() => onGotoTab?.('hosts')}>
              <span className="v5-tile-label">ESXi 호스트</span>
              <span className="v5-tile-value">{dash(infra?.hosts)}</span>
            </button>
            <button type="button" className="v5-tile" onClick={() => onGotoTab?.('vms')}>
              <span className="v5-tile-label">가상머신</span>
              <span className="v5-tile-value">{dash(infra?.vms)}</span>
              <span className="v5-tile-meta">{infra?.vmsOn == null ? '구동 수 미상' : `구동중 ${fmtInt(infra.vmsOn)}`}</span>
            </button>
            <button type="button" className="v5-tile" onClick={() => onGotoTab?.('datastores')}>
              <span className="v5-tile-label">스토리지</span>
              <span className="v5-tile-value">{tb(infra?.storageTotalTB)}</span>
              <span className="v5-tile-meta">{infra?.storagePct == null ? '사용률 —' : `사용 ${tb(infra.storageUsedTB)} · ${Math.round(infra.storagePct)}%`}</span>
            </button>
          </div>
          <div className="v5-note">스토리지는 vCenter 데이터스토어 합계입니다(스토리지 어레이 원시 용량이 아닙니다).</div>
        </section>

        <section className="v5-card" aria-label="데이터 신뢰도">
          <div className="v5-card-title">데이터 신뢰도</div>
          <div className="v5-line">
            마지막 수집 <b>{trust.generatedMs ? new Date(trust.generatedMs).toLocaleTimeString('ko-KR') : '—'}</b>
            {trust.generatedMs ? ` (${agoText(trust.generatedMs)})` : ''}
          </div>
          <div className="v5-line">vCenter 보고율 <b>{trust.connected == null ? '—' : `${fmtInt(trust.connected + (trust.maintenance || 0))}/${fmtInt(trust.total)}`}</b>{trust.ratePct == null ? '' : ` · ${trust.ratePct}%`}</div>
          <div className="v5-bar"><div style={{ width: `${trust.ratePct ?? 0}%`, background: trustColor }} /></div>
          {trust.pending > 0 && <div className="v5-line">첫 수집 중 <b>{trust.pending}</b>곳 — 기다리면 채워집니다.</div>}
          {trust.unreachable > 0 && <div className="v5-line" style={{ color: 'var(--red)' }}>연결 실패 <b>{trust.unreachable}</b>곳 — 기다려도 채워지지 않습니다(설정 › vCenter 등록·관리에서 확인).</div>}
          {trust.maintenance > 0 && <div className="v5-line">점검중 {trust.maintenance}곳(보고율에 포함)</div>}
          {trust.disabled > 0 && <div className="v5-line">비활성 {trust.disabled}곳 — 설정에서 수집을 꺼 두어 보고율에서 뺐습니다(설정 › vCenter 에서 켤 수 있습니다).</div>}
          {trust.restFallback > 0 && <div className="v5-line">REST 폴백 {trust.restFallback}곳 — 경보를 조회하지 않아 경보 수를 모릅니다.</div>}
          <div className="v5-note">보고율은 연결됨 + 점검중을 셉니다. 첫 수집 중인 곳은 실패로 세지 않았습니다.</div>
        </section>
      </div>
    </div>
  );
}
