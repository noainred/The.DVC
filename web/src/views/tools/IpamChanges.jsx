// IpamChanges.jsx — IP관리 › IP 변화(v3.1.0, 시안 docs/design/ipam-alerts-mac-dns ②). 스캔이 본 변화 기록 — 알림을 끈 종류도 남는다.
// 폴링 30초(가벼운 목록 — 서버가 상한까지 잘라 준다). 403(범위 계정)은 ErrorBox 가 권한 안내로.
import React, { useState } from 'react';
import { usePolling } from '../../api.js';
import { ErrorBox, Loading } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import { fmtDt, agentLabel } from './ipamShared.jsx';
import { CHANGE_TYPE, CHANGE_ORDER, changeDetail, notifyBadge } from './ipamChangeText.js';

const LIMITS = [200, 500, 2000];

export function IpamChanges() {
  const [type, setType] = useState('');
  const [ip, setIp] = useState('');
  const [limit, setLimit] = useState(500);
  const params = { limit, ...(type ? { type } : {}), ...(ip.trim() ? { ip: ip.trim() } : {}) };
  const { data, error, errorInfo, loading } = usePolling('/admin/ipam/changes', params, 30_000);
  if (error && !data) return <ErrorBox message={errorInfo || error} />;
  const rows = data?.entries || [];
  const counts = data?.counts || {};
  const all = Object.values(counts).reduce((a, n) => a + (Number(n) || 0), 0);
  return (
    <div className="card ipam-page" style={{ padding: 14, minWidth: 0 }}>
      <div className="flex between wrap gap" style={{ alignItems: 'center', marginBottom: 8 }}>
        <b style={{ fontSize: 15 }}>🔔 IP 변화</b>
        <a href="#/settings/alerts" className="muted" style={{ fontSize: 12 }}>알림 규칙 — 설정 › 알림 ›</a>
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10, lineHeight: 1.7 }}>
        IP 스캔이 끝날 때마다 지난 결과와 비교한 변화입니다. 알림을 끈 종류와 알리지 않을 에이전트의 변화도 남습니다.
        대역 줄의 첫 완료 스캔은 기준선이라 새 미등록 IP 로 세지 않고, 시한에 걸린 스캔은 비교하지 않습니다.
        충돌 의심은 VM 의 IP 에 그 VM 의 NIC 이 아닌 MAC 이 연속으로 응답한 경우입니다 — 스캐너는 한 번에 한 MAC 만 보므로 충돌이라고 단정하지 않습니다.
        DNS 불일치는 역DNS 이름을 정방향으로 다시 물은 답이 알던 판정에서 다른 IP · 정방향 없음으로 바뀐 경우이고 알림 없이 기록만 합니다 — 지금 어긋난 IP 전부는 추천 › DNS 정합성 카드에 있습니다.
      </div>
      <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 10 }}>
        <button className={type === '' ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '5px 11px', fontSize: 12 }} onClick={() => setType('')}>전체 ({all.toLocaleString()})</button>
        {CHANGE_ORDER.map((k) => (
          <button key={k} className={type === k ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '5px 11px', fontSize: 12 }}
            onClick={() => setType((cur) => (cur === k ? '' : k))}>{CHANGE_TYPE[k].label} ({(Number(counts[k]) || 0).toLocaleString()})</button>
        ))}
      </div>
      <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 10 }}>
        <input className="input" style={{ width: 200, maxWidth: '100%', minWidth: 0 }} placeholder="IP 로 찾기(정확히)" value={ip} onChange={(e) => setIp(e.target.value)} aria-label="IP 로 찾기" />
        <Select sort={false} className="select" value={String(limit)} onChange={(e) => setLimit(Number(e.target.value))} aria-label="표시 개수">
          {LIMITS.map((n) => <option key={n} value={n}>최근 {n.toLocaleString()}건</option>)}
        </Select>
        {data && <span className="muted" style={{ fontSize: 12 }}>{data.matched.toLocaleString()}건{data.truncated ? ` 중 ${rows.length.toLocaleString()}건 표시` : ''} · 최근 {Number(data.max).toLocaleString()}건 · {data.maxAgeDays}일 보관</span>}
      </div>
      {loading && !data ? <Loading /> : (
        <div className="table-wrap">
          <STable minWidth={900} wrap={false}>
            <thead><tr><th>시각</th><th>종류</th><th>IP</th><th>내용</th><th>에이전트</th><th>알림</th></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={6} className="center muted" style={{ padding: 20, whiteSpace: 'normal' }}>{type || ip.trim() ? '조건에 맞는 변화가 없습니다.' : '아직 기록된 변화가 없습니다 — 스캔이 끝나면 쌓입니다.'}</td></tr>}
              {rows.map((e) => {
                const t = CHANGE_TYPE[e.type] || { label: e.type, tone: 'gray' };
                const nb = notifyBadge(e.notify);
                return (
                  <tr key={e.id}>
                    <td style={{ whiteSpace: 'nowrap' }} data-sort={e.ts ?? ''}>{fmtDt(e.ts)}</td>
                    <td><span className={`badge ${t.tone}`}>{t.label}</span></td>
                    <td style={{ fontFamily: 'var(--mono)', whiteSpace: 'nowrap' }}>{e.ip || '—'}</td>
                    <td style={{ whiteSpace: 'normal', minWidth: 260, overflowWrap: 'anywhere' }}>{changeDetail(e)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{e.agent ? agentLabel(e.agent) : '—'}</td>
                    <td style={{ whiteSpace: 'nowrap' }} data-sort={e.notify || ''}>{nb.tone ? <span className={`badge ${nb.tone}`} title={nb.title || ''}>{nb.text}</span> : <span className="muted">{nb.text}</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </STable>
        </div>
      )}
    </div>
  );
}
