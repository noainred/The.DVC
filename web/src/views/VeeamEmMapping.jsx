/**
 * views/VeeamEmMapping.jsx — 설정 › Veeam 백업 서버 › Enterprise Manager › 백업 서버 매핑(v2.788.1 — 사용자 요청 'EM 에 연결된 백업 서버 매핑하는 기능').
 *  · EM 이 아는 B&R 서버마다 ① 포탈 B&R 등록(자동 — 이름 · 수동 · 포탈에 없음 확정) ② 백업하는 vCenter(법인)를 정한다.
 *  · 줄 하나씩 편집 · 진행 중 잠금은 그 줄만 · sendJson 은 400 본문을 돌려준다 — r?.ok === false 를 본다(audit2727e).
 *  · 저장하면 서버 › Veeam › EM 탭에 바로 반영된다(응답 캐시 키에 매핑 리비전).
 * ⚠ 훅은 조기 return 위 · 백틱 금지.
 */
import React, { useMemo, useState } from 'react';
import { sendJson } from '../api.js';
import { STable } from '../components/STable.jsx';
import Select from '../components/Select.jsx';
import { brMatchText, vcMatchText, reflectText, mappingSummary, TONE } from './tools/backupEmText.js';

const rowKey = (r) => `${r.emId}|${String(r.name).toLowerCase()}`;

export default function VeeamEmMapping({ mapping, onSaved }) {
  const [edit, setEdit] = useState(null);   // { key, emId, name, br, vcenterIds:Set }
  const [vq, setVq] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);
  const [q, setQ] = useState('');
  const rows = useMemo(() => (Array.isArray(mapping?.rows) ? mapping.rows : []), [mapping]);
  const sum = useMemo(() => mappingSummary(rows), [rows]);
  const shown = rows.filter((r) => !q.trim() || `${r.name} ${r.emName} ${(r.vcNames || []).join(' ')} ${r.brName}`.toLowerCase().includes(q.trim().toLowerCase()));
  const vcs = mapping?.vcenters || [];
  const vcShown = vcs.filter((v) => !vq.trim() || String(v.name).toLowerCase().includes(vq.trim().toLowerCase()));

  const open = (r) => { setMsg(null); setVq(''); setEdit({ key: rowKey(r), emId: r.emId, name: r.name, br: r.manual?.br || '', vcenterIds: new Set(r.manual?.vcenterIds || []) }); };
  const save = async (clear = false) => {
    if (!edit || busy) return;
    setBusy(edit.key); setMsg(null);
    try {
      const body = { emId: edit.emId, server: edit.name, br: clear ? '' : edit.br, vcenterIds: clear ? [] : [...edit.vcenterIds] };
      const r = await sendJson('/admin/veeam/em/map', 'PUT', body);
      if (r?.ok === false) { setMsg({ ok: false, text: r.reason || '저장하지 못했습니다.' }); return; }
      setMsg({ ok: true, text: clear ? `${edit.name} — 매핑을 지웠습니다(자동으로 짝짓기).` : `${edit.name} — 저장했습니다. EM 탭에 바로 반영됩니다.` });
      setEdit(null);
      onSaved?.();
    } catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(''); }
  };
  const toggleVc = (id) => setEdit((e) => { const s = new Set(e.vcenterIds); if (s.has(id)) s.delete(id); else s.add(id); return { ...e, vcenterIds: s }; });

  return (
    <div className="card" data-em-mapping="" style={{ marginTop: 12, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
      <div className="flex gap wrap" style={{ alignItems: 'baseline', rowGap: 4 }}>
        <b>백업 서버 매핑</b>
        <span className="muted" style={{ fontSize: 12 }}>EM 이 아는 B&R 서버 {sum.total}대 · 포탈 B&R 짝 {sum.registered}대 · 법인 정함 {sum.withVc}대{sum.gone ? ` · EM 결과에 없는 매핑 ${sum.gone}줄` : ''}</span>
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="백업 서버·법인 찾기" style={{ marginLeft: 'auto', maxWidth: 220, minWidth: 150 }} />
      </div>
      <div className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
        <b>법인(vCenter)</b>을 정하면 EM 탭의 백업 서버·작업·저장소에 법인 이름이 붙습니다(비우면 짝지어진 B&R 등록의 vCenter 를 따릅니다).
        <b> 포탈 B&R</b>은 이름이 달라 자동으로 못 찾는 서버를 손으로 짝짓거나, 포탈에 등록하지 않을 서버를 '포탈에 없음' 으로 확정합니다.
        <b> vCenter 반영</b> — 법인을 정한 서버는 EM 의 VM 별 기록(작업 결과·복원 지점)이 그 vCenter 의 카드·VM 배지·Veeam 현황에 'EM ·' 출처로 실립니다.
        짝지은 B&R 직접 수집이 정상이면 그쪽이 우선이고, 읽기 실패·첫 수집 대기일 때만 EM 기록으로 채웁니다. EM 기록에는 진행 중·진행률이 없습니다.
      </div>
      {mapping?.unreadable && <div className="banner warn">매핑 파일을 읽지 못했습니다 — 저장하지 않습니다(손상 사본은 설정 폴더에 남았습니다).</div>}
      {msg && <div className={`banner ${msg.ok ? 'info' : 'warn'}`}>{msg.text}</div>}
      {!rows.length ? <div className="muted" style={{ fontSize: 13 }}>아직 EM 수집 결과가 없습니다 — EM 을 등록하고 '지금 수집' 을 누르면 백업 서버 목록이 나옵니다.</div> : (
        <STable minWidth={1000} style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead><tr style={{ textAlign: 'left', fontSize: 12 }}>
            <th style={{ padding: '6px 6px 6px 0' }}>백업 서버</th><th style={{ padding: '6px' }}>EM</th><th style={{ padding: '6px' }}>포탈 B&R</th><th style={{ padding: '6px' }}>법인(vCenter)</th><th style={{ padding: '6px' }}>vCenter 반영</th>
            <th data-nosort="" style={{ padding: '6px 0 6px 6px' }}><span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>동작</span></th>
          </tr></thead>
          <tbody>
            {shown.map((r) => {
              const k = rowKey(r); const b = brMatchText(r); const v = vcMatchText(r); const f = reflectText(r); const on = edit?.key === k;
              return (
                <React.Fragment key={k}>
                  <tr style={{ borderTop: '1px solid var(--border-soft)' }}>
                    <td style={{ padding: '8px 6px 8px 0' }}><b>{r.name}</b><div className="muted" style={{ fontSize: 11 }}>{r.gone ? 'EM 결과에 없음(매핑만 남음)' : (r.version || '판 모름')}</div></td>
                    <td style={{ padding: '8px 6px', color: 'var(--text-dim)' }}>{r.emName}</td>
                    <td data-sort={b.text} style={{ padding: '8px 6px', color: TONE[b.tone] }}>{b.text}</td>
                    <td data-sort={v.text} style={{ padding: '8px 6px' }}><span style={{ color: TONE[v.tone], overflowWrap: 'anywhere' }}>{v.text}</span>{v.sub && <div className="muted" style={{ fontSize: 11 }}>{v.sub}</div>}</td>
                    <td data-sort={f.text} style={{ padding: '8px 6px' }}><span style={{ color: TONE[f.tone] }}>{f.text}</span>{f.sub && <div className="muted" style={{ fontSize: 11 }}>{f.sub}</div>}</td>
                    <td style={{ padding: '8px 0 8px 6px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button type="button" className={on ? 'login-btn' : 'tab'} style={{ flex: 'none' }} onClick={() => (on ? setEdit(null) : open(r))}>{on ? '닫기' : '매핑'}</button>
                    </td>
                  </tr>
                  {on && (
                    <tr><td colSpan={6} style={{ padding: '4px 0 12px' }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, padding: 12, border: '1px solid var(--border)', borderRadius: 10, background: 'var(--panel-deep)' }}>
                        <label className="muted" style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, flex: '1 1 220px', minWidth: 0 }}>포탈 B&R 등록
                          <Select className="input" sort={false} value={edit.br} onChange={(e) => setEdit((x) => ({ ...x, br: e.target.value }))} style={{ minWidth: 0 }}>
                            <option value="">자동(이름으로 짝짓기)</option>
                            <option value="none">포탈에 없음(짝짓지 않음)</option>
                            {(mapping?.brServers || []).map((s) => <option key={s.id} value={s.id}>{s.name} · {s.host}</option>)}
                          </Select>
                        </label>
                        <div style={{ flex: '2 1 320px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                          <div className="flex gap wrap" style={{ alignItems: 'center', rowGap: 4 }}>
                            <span className="muted" style={{ fontSize: 12 }}>법인(vCenter) — {edit.vcenterIds.size ? `${edit.vcenterIds.size}개 고름` : '비우면 B&R 등록을 따름'}</span>
                            <input className="input" value={vq} onChange={(e) => setVq(e.target.value)} placeholder="vCenter 찾기" style={{ marginLeft: 'auto', maxWidth: 180, minWidth: 120 }} />
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '4px 10px', maxHeight: 180, overflowY: 'auto' }}>
                            {vcShown.map((x) => (
                              <label key={x.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, minWidth: 0 }}>
                                <input type="checkbox" checked={edit.vcenterIds.has(x.id)} onChange={() => toggleVc(x.id)} /><span style={{ overflowWrap: 'anywhere' }}>{x.name}</span>
                              </label>
                            ))}
                          </div>
                        </div>
                        <div className="flex gap wrap" style={{ alignSelf: 'flex-end' }}>
                          <button type="button" className="login-btn" style={{ flex: 'none' }} disabled={!!busy || mapping?.unreadable} onClick={() => save(false)}>{busy === k ? '저장 중…' : '저장'}</button>
                          <button type="button" className="tab" style={{ flex: 'none' }} disabled={!!busy || mapping?.unreadable || !r.manual} onClick={() => save(true)} title="이 서버의 매핑을 지우고 자동으로 짝짓습니다">자동으로 되돌리기</button>
                        </div>
                      </div>
                    </td></tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </STable>
      )}
    </div>
  );
}
