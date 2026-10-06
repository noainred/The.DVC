/**
 * ScanRangeMigration.jsx — v2.691 'vCenter 별 스캔 대역 → 에이전트' 1회 이전 안내(스캔 대역·설정 페이지 맨 위).
 *
 * 서버(GET /admin/ipam/scan/migration)가 이전 기록과 **아직 옮기지 못한 vCenter 별 대역**을 준다. 옮기지 못한 대역은 예전처럼
 * 중앙이 계속 스캔한다(조용한 손실 없음) — 여기서 에이전트를 골라 옮기거나 지운다. 옮기거나 지우면 onChanged 로 폼·소유자를 다시 읽는다.
 */
import React, { useEffect, useState } from 'react';
import { fetchJson, postJson } from '../../api.js';
import { STable } from '../../components/STable.jsx';
import { agentName, migrationRow, migrationVisible } from './scanRangeImportText.js';
import Select from '../../components/Select.jsx';

const TONE = { ok: 'var(--green)', warn: 'var(--amber)', dim: 'var(--text-dim)' };

export function ScanRangeMigration({ onChanged }) {
  const [m, setM] = useState(null);
  const [pick, setPick] = useState({});
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(true);
  useEffect(() => { let alive = true; fetchJson('/admin/ipam/scan/migration').then((r) => { if (alive) setM(r); }).catch(() => { /* 안내가 없을 뿐 — 화면은 그대로 쓸 수 있다 */ }); return () => { alive = false; }; }, []);
  if (!migrationVisible(m)) return null;
  const st = m.state || {};
  const items = (st.items || []).map((it) => ({ it, row: migrationRow(it) }));
  const remaining = m.remaining || [];
  const act = async (path, body, okText) => {
    setBusy(true); setMsg(null);
    try {
      const r = await postJson(path, body);
      if (r && r.ok === false) { setMsg({ ok: false, text: r.reason || '서버가 거부했습니다' }); return; }
      setM(r); setMsg(okText ? { ok: true, text: okText(r) } : null); onChanged?.();
    } catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(false); }
  };
  const moved = items.filter((x) => x.it.result === 'moved').length;
  return (
    <section className="card" style={{ padding: 14, marginBottom: 12, borderColor: remaining.length ? 'var(--amber)' : 'var(--border)' }} aria-label="기존 대역 이전 안내">
      <div className="flex between wrap" style={{ alignItems: 'center', gap: 8 }}>
        <b style={{ fontSize: 14 }}>vCenter 별 스캔 대역을 에이전트로 옮겼습니다{moved ? ` (${moved}건)` : ''}</b>
        <span className="flex gap wrap">
          <button className="tab" style={{ flex: 'none', padding: '4px 10px', fontSize: 12 }} aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? '접기' : '펼치기'}</button>
          {!remaining.length && !st.dismissedAt && <button className="tab" style={{ flex: 'none', padding: '4px 10px', fontSize: 12 }} disabled={busy} onClick={() => act('/admin/ipam/scan/migration/dismiss', {}, null)}>확인 — 다시 보지 않기</button>}
        </span>
      </div>
      {open && (
        <>
          <div className="muted" style={{ fontSize: 12, lineHeight: 1.7, margin: '6px 0 8px' }}>
            예전 ‘대역·스캔’ 메뉴에 vCenter 별로 저장된 대역을 그 vCenter 를 수집하는 쪽으로 옮겼습니다 — 중앙 직접 수집 vCenter 는 ‘이 포탈에서 직접’,
            엣지 위임 vCenter 는 그 엣지입니다. <b>이제 엣지 법인 대역은 그 엣지가 자기 사이트에서 스캔합니다</b>(예전에는 중앙이 스캔했습니다).
            {st.backup && <> 옮기기 전 파일은 <code>{st.backup}</code> 로 백업했습니다.</>}
          </div>
          {items.length > 0 && (
            <STable className="v3-table" minWidth={760}>
              <thead><tr><th>vCenter</th><th>수집 방식</th><th>옮긴 곳</th><th>대역</th><th>결과</th></tr></thead>
              <tbody>
                {items.map(({ it, row }) => (
                  <tr key={it.vcenterId}>
                    <td style={{ fontWeight: 700 }}>{row.vcenter}</td>
                    <td>{row.mode}</td>
                    <td style={{ color: row.tone === 'warn' ? TONE.warn : undefined }}>{row.target}</td>
                    <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{row.ranges}</td>
                    <td style={{ color: TONE[row.tone], whiteSpace: 'normal' }}>{row.result}</td>
                  </tr>
                ))}
              </tbody>
            </STable>
          )}
        </>
      )}
      {remaining.length > 0 && (
        <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--amber)', background: 'rgba(245,158,11,.08)' }}>
          <div style={{ fontSize: 12.5, marginBottom: 6 }}><b>옮기지 못한 대역 {remaining.length}건</b> — 켜진 대역은 예전처럼 이 포탈이 계속 스캔하고, 꺼진 대역은 스캔하지 않습니다. 에이전트를 골라 옮기거나(옮기면 그 에이전트가 스캔합니다) 지우세요.</div>
          {remaining.map((r) => (
            <div key={r.vcenterId} className="flex gap wrap" style={{ alignItems: 'center', margin: '4px 0' }}>
              <b style={{ minWidth: 120 }}>{r.vcenterName}</b>
              <span className={`badge ${r.enabled ? 'green' : 'gray'}`}>{r.enabled ? '스캔 중(이 포탈)' : '꺼짐'}</span>
              <span style={{ fontFamily: 'monospace', fontSize: 12, overflowWrap: 'anywhere' }}>{(r.ranges || []).slice(0, 3).join(', ')}{(r.ranges || []).length > 3 ? ` 외 ${r.ranges.length - 3}줄` : ''}</span>
              <Select className="select" value={pick[r.vcenterId] || ''} onChange={(e) => setPick((p) => ({ ...p, [r.vcenterId]: e.target.value }))} aria-label={`${r.vcenterName} 옮길 에이전트`} style={{ maxWidth: '100%', minWidth: 0 }}>
                <option value="">에이전트 선택</option>
                {(m.agents || []).map((a) => <option key={a} value={a}>{agentName(a)}</option>)}
              </Select>
              <button className="login-btn" style={{ flex: 'none', padding: '5px 12px', fontSize: 12 }} disabled={busy || !pick[r.vcenterId]}
                onClick={() => act('/admin/ipam/scan/migration/move', { vcenterId: r.vcenterId, agent: pick[r.vcenterId] }, (x) => `${r.vcenterName} 대역 ${x.moved ?? 0}줄을 ${agentName(pick[r.vcenterId])} 로 옮겼습니다${x.enabledAgent ? ' — 그 에이전트 주기 스캔을 켰습니다' : ''}.`)}>선택한 에이전트로 옮기기</button>
              <button className="logout-btn" style={{ padding: '5px 12px', fontSize: 12, color: 'var(--red)' }} disabled={busy}
                onClick={() => { if (window.confirm(`${r.vcenterName} 의 스캔 대역 ${(r.ranges || []).length}줄을 지울까요? 지우면 이 대역은 더 이상 스캔하지 않습니다.`)) act('/admin/ipam/scan/migration/remove', { vcenterId: r.vcenterId }, () => `${r.vcenterName} 대역을 지웠습니다.`); }}>지우기</button>
            </div>
          ))}
        </div>
      )}
      {msg && <div style={{ fontSize: 12, marginTop: 8, color: msg.ok ? 'var(--green)' : 'var(--red)' }}>{msg.text}</div>}
    </section>
  );
}
