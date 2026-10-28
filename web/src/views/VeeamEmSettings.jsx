/**
 * views/VeeamEmSettings.jsx — 설정 › Veeam 백업 서버 › Enterprise Manager(v2.788 · 사용자 요청 + 시안).
 *  · Enterprise Manager(REST 기본 9398)를 등록하면 **중앙 포탈이 직접** 읽어 Backup 현황 › EM 탭을 채운다(엣지 배정 없음).
 *  · 비밀번호는 응답에 없다(hasPassword) — 비우면 유지 · 주소·포트·계정을 바꾸면 서버가 저장 비밀번호를 버리고 그 사실을 말한다.
 *  · 목록 403(범위 제한 관리자)·읽기 실패를 '0대 등록' 으로 칠하지 않는다 · 늦게 온 이전 응답은 버린다 · 진행 중 잠금은 그 대상만.
 *  · sendJson·delJson 은 400 본문을 돌려준다 — r?.ok === false 를 본다(audit2727e).
 * ⚠ 훅은 전부 조기 return 위에. 백틱 금지.
 */
import React, { useEffect, useRef, useState } from 'react';
import { fetchJson, sendJson, postJson, delJson } from '../api.js';
import { STable } from '../components/STable.jsx';
import { droppedSecretNote } from './droppedSecretText.js';
import { SECTION_LABEL } from './tools/backupEmText.js';
import VeeamEmMapping from './VeeamEmMapping.jsx'; // v2.788.1 백업 서버 매핑

const EMPTY = { id: '', name: '', host: '', port: '', username: '', password: '', enabled: true, note: '' };
const fmt = (ms) => {
  if (ms == null || !Number.isFinite(Number(ms))) return '—';
  const d = new Date(Number(ms)); const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** 상태 칸 — { text, tone, sub }(순수 — 테스트 대상). */
export function emStatusCell(st, enabled = true) {
  if (!enabled) return { text: '수집 꺼짐', tone: 'muted', sub: '' };
  if (!st) return { text: '아직 수집 전', tone: 'muted', sub: '첫 수집은 포탈 시작 2분 뒤 — 지금 수집으로 바로 읽을 수 있습니다' };
  if (st.kind === 'auth-stopped' || st.authStop) return { text: '인증 실패 — 주기 수집 멈춤', tone: 'bad', sub: '계정을 고치면 다시 시작합니다(자동 재시도 없음)' };
  if (st.kind === 'no-password') return { text: '비밀번호 없음', tone: 'bad', sub: '수정에서 비밀번호를 다시 입력하세요' };
  if (!st.ok) return { text: '수집 실패', tone: 'bad', sub: `${String(st.error || '').slice(0, 160)}${st.lastOkTs ? ` · 마지막 성공 ${fmt(st.lastOkTs)}` : ''}` };
  const failed = Object.entries(st.sections || {}).filter(([, v]) => !v.ok).map(([k]) => SECTION_LABEL[k] || k);
  return { text: '정상', tone: failed.length ? 'warn' : 'ok', sub: `${fmt(st.ts)}${failed.length ? ` · 못 읽은 항목: ${failed.join(', ')}` : ''}` };
}
const TONE = { ok: '#86efac', warn: '#fcd34d', bad: '#fca5a5', muted: 'var(--text-dim)' };

export default function VeeamEmSettings() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [denied, setDenied] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(() => new Set());
  const busyOn = (k) => setBusy((b) => new Set(b).add(k));
  const busyOff = (k) => setBusy((b) => { const n = new Set(b); n.delete(k); return n; });
  const seq = useRef(0);
  const load = () => {
    const my = ++seq.current;
    fetchJson('/admin/veeam/em')
      .then((r) => { if (my !== seq.current) return; setD(r); setErr(''); setDenied(false); })
      .catch((e) => { if (my !== seq.current) return; if (e?.status === 403) setDenied(true); else setErr(e?.message || String(e)); });
  };
  useEffect(() => { load(); return () => { seq.current += 1; }; }, []);

  if (denied) return <div className="muted" style={{ fontSize: 12 }}>Veeam Enterprise Manager 등록은 전체 범위(vCenter 제한 없는) 관리자만 볼 수 있습니다.</div>;

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const save = async () => {
    busyOn('save'); setMsg(null);
    try {
      const r = await sendJson('/admin/veeam/em', 'POST', { ...form, port: form.port === '' ? undefined : Number(form.port) });
      if (r?.ok === false || !r?.em) { setMsg({ ok: false, text: r?.reason || '저장하지 못했습니다.' }); return; }
      const drop = droppedSecretNote(r.em);
      setMsg(drop ? { ok: false, text: drop } : { ok: true, text: '저장했습니다. 다음 수집(또는 지금 수집)에 읽습니다.' });
      setForm(drop ? { ...EMPTY, ...r.em, port: String(r.em.port || ''), password: '' } : EMPTY);
      load();
    } catch (e) { setMsg({ ok: false, text: e.message }); } finally { busyOff('save'); }
  };
  const act = async (em, kind) => {
    const key = `${kind}:${em.id}`;
    if (busy.has(key)) return;
    busyOn(key); setMsg(null);
    try {
      if (kind === 'del') {
        if (!window.confirm(`Enterprise Manager '${em.name}' 등록을 삭제할까요?`)) return;
        const r = await delJson(`/admin/veeam/em/${encodeURIComponent(em.id)}`);
        setMsg(r?.ok === false ? { ok: false, text: r.reason || '삭제하지 못했습니다.' } : { ok: true, text: '삭제했습니다.' });
      } else {
        const r = await postJson(`/admin/veeam/em/${encodeURIComponent(em.id)}/${kind}`, {});
        if (kind === 'test') setMsg(r?.ok ? { ok: true, text: `연결 성공 · 백업 서버 ${Number.isFinite(r.backupServers) ? `${r.backupServers}대` : '수 모름'} · ${r.ms}ms${r.authStopCleared ? ' · 인증 실패로 멈춘 주기 수집을 풀었습니다' : ''}` } : { ok: false, text: r?.reason || '연결 실패' });
        else setMsg(r?.ok ? { ok: true, text: '수집했습니다 — Backup 현황 › EM 탭에서 확인하세요.' } : { ok: false, text: r?.reason || '수집 실패' });
      }
      load();
    } catch (e) { setMsg({ ok: false, text: e.message }); } finally { busyOff(key); }
  };
  const edit = (em) => setForm({ id: em.id, name: em.name, host: em.host, port: String(em.port || ''), username: em.username, password: '', enabled: em.enabled !== false, note: em.note || '' });
  const ems = d?.ems || [];

  return (
    <>
      <div className="section-title" style={{ marginTop: 0 }}>🛰️ Veeam Enterprise Manager{d ? ` (${ems.length}대)` : ''}</div>
      <div className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
        Enterprise Manager 를 등록하면 <b>중앙 포탈이 직접</b> EM REST API(기본 포트 9398)를 읽어 전 백업 서버의 작업 결과·세션·저장소를 <b>Backup 현황 › EM</b> 탭에 보입니다.
        읽기 전용 계정(EM Portal User 역할)을 권장합니다 — 포탈은 작업을 시작·중지하지 않습니다. 처음 연결하면 EM 인증서가 <b>승인 대기</b>로 멈춥니다(설정 › Security › 장비 신뢰에서 지문 확인 뒤 승인).
      </div>
      {d?.registryError && <div className="banner warn" style={{ marginTop: 8 }}>등록부를 읽지 못했습니다(0대라는 뜻이 아닙니다): {d.registryError}</div>}
      {err && <div className="banner warn" style={{ marginTop: 8 }}>목록을 읽지 못했습니다(0대라는 뜻이 아닙니다): {err} <button type="button" className="tab" style={{ marginLeft: 8, padding: '2px 10px' }} onClick={load}>다시 읽기</button></div>}
      {msg && <div className={`banner ${msg.ok ? 'info' : 'warn'}`} style={{ marginTop: 8 }}>{msg.text}</div>}

      <div className="card" style={{ marginTop: 10, overflowX: 'auto' }}>
        {!d && !err ? <div className="muted" style={{ padding: 12 }}>읽는 중…</div> : !ems.length ? <div className="muted" style={{ padding: 12, fontSize: 13 }}>등록된 Enterprise Manager 가 없습니다 — 아래에서 추가하세요.</div> : (
          <STable minWidth={820}>
            <thead><tr><th>이름</th><th>주소</th><th>계정</th><th>상태</th><th data-nosort=""><span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>동작</span></th></tr></thead>
            <tbody>
              {ems.map((em) => {
                const c = emStatusCell(em.status, em.enabled !== false);
                return (
                  <tr key={em.id}>
                    <td><b>{em.name}</b>{em.note && <div className="muted" style={{ fontSize: 11 }}>{em.note}</div>}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{em.host}:{em.port}</td>
                    <td>{em.username}{!em.hasPassword && <div style={{ fontSize: 11, color: TONE.bad }}>비밀번호 없음</div>}</td>
                    <td data-sort={c.text}><span style={{ color: TONE[c.tone], fontWeight: 700 }}>{c.text}</span>{c.sub && <div className="muted" style={{ fontSize: 11, overflowWrap: 'anywhere' }}>{c.sub}</div>}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button type="button" className="tab" disabled={busy.has(`collect:${em.id}`)} onClick={() => act(em, 'collect')}>{busy.has(`collect:${em.id}`) ? '수집 중…' : '지금 수집'}</button>{' '}
                      <button type="button" className="tab" disabled={busy.has(`test:${em.id}`)} onClick={() => act(em, 'test')}>{busy.has(`test:${em.id}`) ? '시험 중…' : '연결 시험'}</button>{' '}
                      <button type="button" className="tab" onClick={() => edit(em)}>수정</button>{' '}
                      <button type="button" className="tab" style={{ color: 'var(--red)' }} disabled={busy.has(`del:${em.id}`)} onClick={() => act(em, 'del')}>삭제</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </STable>
        )}
      </div>

      {d && ems.length > 0 && <VeeamEmMapping mapping={d.mapping} onSaved={load} />}

      <div className="card" style={{ marginTop: 12, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 720 }}>
        <b>{form.id ? `수정 — ${form.name}` : 'Enterprise Manager 추가'}</b>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
          <label className="muted" style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>표시명<input className="input" value={form.name} onChange={set('name')} placeholder="예: HQ-VEM01" /></label>
          <label className="muted" style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>호스트(IP·이름)<input className="input" value={form.host} onChange={set('host')} placeholder="vem01.corp.local" /></label>
          <label className="muted" style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>포트<input className="input" value={form.port} onChange={set('port')} placeholder={String(d?.defaults?.port || 9398)} inputMode="numeric" /></label>
          <label className="muted" style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>계정<input className="input" value={form.username} onChange={set('username')} placeholder="CORP\svc-vem-ro" autoComplete="off" /></label>
          <label className="muted" style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>비밀번호<input className="input" type="password" value={form.password} onChange={set('password')} placeholder={form.id ? '비우면 저장된 값 유지' : ''} autoComplete="new-password" /></label>
          <label className="muted" style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>메모<input className="input" value={form.note} onChange={set('note')} maxLength={200} /></label>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}><input type="checkbox" checked={form.enabled} onChange={set('enabled')} /> 주기 수집 켜기</label>
        <div className="flex gap wrap">
          <button type="button" className="login-btn" style={{ flex: 'none' }} disabled={busy.has('save') || !form.name || !form.host || !form.username || (!form.id && !form.password)} onClick={save}>{busy.has('save') ? '저장 중…' : '저장'}</button>
          {form.id && <button type="button" className="tab" style={{ flex: 'none' }} onClick={() => setForm(EMPTY)}>취소</button>}
        </div>
        <div className="muted" style={{ fontSize: 12 }}>연결 시험은 저장한 EM 에만 합니다(입력 중인 주소로 저장된 비밀번호를 보내지 않습니다). 주소·포트·계정을 바꾸면 비밀번호를 다시 입력해야 합니다.</div>
      </div>
    </>
  );
}
