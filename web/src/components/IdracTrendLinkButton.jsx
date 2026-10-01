// IdracTrendLinkButton.jsx — 호스트 상세 '통합 성능 모니터링'(v2.676, 사용자 요청 "성능 그래프 보기 옆에 통합 성능 모니터링 메뉴 ·
// hostname, TAG 넘버, IP 등으로 복합 조회해서 확실하게 연결"). 누르면 서버에 그 ESXi 호스트의 iDRAC 서버를 묻고
// (`GET /admin/idrac/trend/resolve-host` — 서비스태그·호스트네임·IP·MAC 판정), 찾으면 특수 기능 › iDRAC 통합 추이로 가며 그 서버를 고른다.
// 못 찾거나 규칙이 서로 다른 서버를 가리키면 **이동하지 않고** 사유와 후보를 보여 준다(지어낸 서버로 보내지 않는다).
// 도구가 관리자 전용(adminOnly — 주 API 가 /api/admin)이므로 관리자이고 그 도구가 허용된 계정에게만 버튼을 그린다.
import React, { useState } from 'react';
import { fetchJson, hasRole, toolAllowed } from '../api.js';
import { handoffSearch } from '../hooks/searchHandoff.js';
import { TREND_HANDOFF, MATCH_RULE_LABEL, resolveFailText } from '../views/tools/idracTrendText.js';

const go = (r, cand, hostName, onClose) => {
  handoffSearch(TREND_HANDOFF, JSON.stringify({
    id: cand.id, host: hostName,
    matchedBy: cand.matchedBy || cand.by || [], confidence: cand.confidence || null, conflicts: cand.conflicts || [],
    reverseSame: cand.reverseSame ?? null,
  }));
  if (onClose) onClose();
  window.location.hash = '#/tools/idrac-trend';
};

export default function IdracTrendLinkButton({ hostId, hostName, onClose }) {
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState(null); // { text, candidates } | { error }
  if (!hasRole('admin') || !toolAllowed('idrac-trend')) return null;
  const run = async () => {
    setBusy(true); setFail(null);
    try {
      const r = await fetchJson(`/admin/idrac/trend/resolve-host?hostId=${encodeURIComponent(hostId)}`);
      if (r?.serverId) {
        go(r, { id: r.serverId, matchedBy: r.matchedBy, confidence: r.confidence, conflicts: r.conflicts, reverseSame: r.reverse?.same }, hostName, onClose);
        return;
      }
      setFail({ text: resolveFailText(r), candidates: r?.candidates || [], omitted: r?.candidatesOmitted || 0 });
    } catch (e) {
      setFail({ error: e?.status === 404 ? '스냅샷에 이 ESXi 호스트가 없습니다(첫 수집 중이거나 삭제됨).' : `연결할 iDRAC 서버를 묻지 못했습니다: ${e?.message || e}` });
    } finally { setBusy(false); }
  };
  return (
    <>
      <button className="login-btn" style={{ flex: 'none', padding: '8px 14px' }} onClick={run} disabled={busy}
        title="서비스태그·호스트네임·IP·MAC 으로 이 호스트의 iDRAC 서버를 찾아 특수 기능 › iDRAC 통합 추이에서 엽니다">
        {busy ? '서버 찾는 중…' : '📊 통합 성능 모니터링'}
      </button>
      {fail && (
        <div role="alert" style={{ flexBasis: '100%', fontSize: 12.5, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--amber)', background: 'rgba(245,158,11,.08)', overflowWrap: 'anywhere' }}>
          <div>{fail.error || fail.text}</div>
          {fail.candidates?.length > 0 && (
            <div className="flex wrap" style={{ gap: 6, marginTop: 6 }}>
              {fail.candidates.map((c) => (
                <button key={c.id} type="button" className="tab" style={{ marginTop: 0, padding: '3px 10px', fontSize: 12 }}
                  title={`일치한 규칙: ${c.by.map((b) => MATCH_RULE_LABEL[b] || b).join(' · ')}`}
                  onClick={() => go(null, { id: c.id, by: c.by, confidence: null }, hostName, onClose)}>
                  {c.name}{c.serviceTag ? ` · ${c.serviceTag}` : ''} — {c.by.map((b) => MATCH_RULE_LABEL[b] || b).join('·')}
                </button>
              ))}
              {fail.omitted > 0 && <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>외 {fail.omitted}대</span>}
            </div>
          )}
        </div>
      )}
    </>
  );
}
