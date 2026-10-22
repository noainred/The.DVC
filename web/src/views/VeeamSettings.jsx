/**
 * views/VeeamSettings.jsx — 설정 › vCenter 관리 › Veeam 백업 서버(v2.751).
 *
 * 사용자 요청(2026-10-22): "vcenter 별로 veeam 백업 서버가 별도로 있는데, 스토리지 원격 점검 하는 것처럼 원격 vcenter 와 같은
 *   데이터센터에 설치된 원격 veeam 에서 정보를 읽어서 표시". 등록한 서버를 vCenter 에 묶고, 읽는 곳을 중앙 또는 그 법인 엣지로 정한다.
 *  · 읽는 곳은 자유 입력이 아니라 아는 엣지 목록에서 고른다(엣지 규약). vCenter 를 고르면 그 vCenter 를 보고하는 엣지를 제안한다.
 *  · 비밀번호는 응답에 없다(hasPassword) — 비우면 유지 · 접속처(주소·포트·계정)를 바꾸면 서버가 저장 비밀번호를 버리고 그 사실을 말한다.
 *  · 목록 403(범위 제한 관리자)·읽기 실패를 '0대 등록' 으로 칠하지 않는다. 늦게 온 이전 응답은 버린다(세대 번호).
 * ⚠ 훅은 전부 조기 return 위에(React #310). 백틱 금지(BoldText 는 **만 해석).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, sendJson, postJson, delJson } from '../api.js';
import { STable } from '../components/STable.jsx';
import Select from '../components/Select.jsx';
import { droppedSecretNote } from './droppedSecretText.js';
import { resultLabel } from './veeamBadge.js';

const EMPTY = { id: '', name: '', host: '', port: '', username: '', password: '', apiVersion: '', agent: '', vcenterIds: [], enabled: true, note: '' };
const fmt = (ms) => {
  if (ms == null || !Number.isFinite(Number(ms))) return '—';
  const d = new Date(Number(ms)); const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const num = (v) => (Number.isFinite(v) ? v : null);

/** 상태 칸 문구·색. */
export function statusCell(st) {
  if (!st) return { text: '아직 읽지 않음', tone: 'muted' };
  if (st.ok) return { text: `정상 · ${fmt(st.ts)}`, tone: 'ok' };
  if (st.authStop) return { text: `인증 실패로 주기 수집 정지 · ${st.error || ''}`, tone: 'bad' };
  return { text: `실패 · ${fmt(st.ts)} · ${st.error || '사유 미상'}${st.lastOkTs ? ` (마지막 성공 ${fmt(st.lastOkTs)})` : ''}`, tone: 'bad' };
}
const TONE = { ok: '#4ade80', bad: '#f87171', muted: 'var(--text-dim)' };

export default function VeeamSettings() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [denied, setDenied] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState('');
  const [open, setOpen] = useState(null); // 작업 목록을 펼친 서버 id
  const seq = useRef(0);
  const load = () => {
    const my = ++seq.current;
    fetchJson('/admin/veeam/servers')
      .then((r) => { if (my !== seq.current) return; setD(r); setErr(''); setDenied(false); })
      .catch((e) => { if (my !== seq.current) return; if (e?.status === 403) setDenied(true); else setErr(e?.message || String(e)); });
  };
  useEffect(() => { load(); return () => { seq.current += 1; }; }, []);
  const vcName = useMemo(() => new Map((d?.vcenters || []).map((v) => [v.id, v.name])), [d]);

  if (denied) {
    return <div className="muted" style={{ fontSize: 12 }}>Veeam 백업 서버 등록은 전체 범위(vCenter 제한 없는) 관리자만 볼 수 있습니다.</div>;
  }

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const toggleVc = (id) => setForm((f) => {
    const has = f.vcenterIds.includes(id);
    const vcenterIds = has ? f.vcenterIds.filter((x) => x !== id) : [...f.vcenterIds, id];
    // 읽는 곳이 비어 있으면 그 vCenter 를 보고하는 엣지를 제안한다(같은 데이터센터의 Veeam 은 보통 그 엣지에서 닿는다).
    const site = !has ? (d?.vcenters || []).find((v) => v.id === id)?.siteAgent : '';
    return { ...f, vcenterIds, agent: f.agent || site || '' };
  });
  const save = async () => {
    setBusy('save'); setMsg(null);
    try {
      const r = await sendJson('/admin/veeam/servers', 'POST', { ...form, port: form.port === '' ? undefined : Number(form.port) });
      if (!r.ok) { setMsg({ ok: false, text: r.reason || '저장하지 못했습니다.' }); return; }
      const drop = droppedSecretNote(r.server);
      setMsg(drop ? { ok: false, text: drop } : { ok: true, text: '저장했습니다. 담당 노드가 다음 수집(엣지는 배정 pull 뒤 곧바로)에 읽습니다.' });
      setForm(drop ? { ...form, id: r.server.id, password: '' } : EMPTY);
      load();
    } catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(''); }
  };
  const act = async (s, kind) => {
    setBusy(`${kind}:${s.id}`); setMsg(null);
    try {
      if (kind === 'del') {
        if (!window.confirm(`Veeam 서버 '${s.name}' 등록을 삭제할까요?`)) return;
        const r = await delJson(`/admin/veeam/servers/${encodeURIComponent(s.id)}`);
        setMsg(r?.ok === false ? { ok: false, text: r.reason || '삭제하지 못했습니다.' } : { ok: true, text: '삭제했습니다.' });
      } else {
        const r = await postJson(`/admin/veeam/servers/${encodeURIComponent(s.id)}/${kind}`, {});
        if (kind === 'test') setMsg(r.ok ? { ok: true, text: `연결 성공 · 작업 ${r.jobs}개 · ${r.ms}ms · API ${r.apiVersion}` } : { ok: false, text: r.reason || '연결 실패' });
        else setMsg(r.ok ? { ok: true, text: `읽기 완료(성공 ${r.ok ?? 0} · 실패 ${r.fail ?? 0})` } : { ok: false, text: r.reason || (r.skipped ? '이미 수집 중입니다 — 끝나면 목록에 반영됩니다' : '읽기 실패') });
      }
      load();
    } catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(''); }
  };

  const servers = d?.servers || [];
  const edit = (s) => setForm({ id: s.id, name: s.name, host: s.host, port: String(s.port || ''), username: s.username, password: '', apiVersion: s.apiVersion || '', agent: s.agent || '', vcenterIds: s.vcenterIds || [], enabled: s.enabled !== false, note: s.note || '' });

  return (
    <>
      <div className="section-title" style={{ marginTop: 0 }}>🛟 Veeam 백업 서버{d ? ` (${servers.length}대)` : ''}</div>
      <div className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
        vCenter 별 Veeam Backup &amp; Replication 서버를 등록하면 vCenter › VM 및 폴더의 <b>Veeam 백업 VM 표시</b> 체크박스가 백업 대상·지금 백업 중인 VM 에 배지를 붙입니다.
        스토리지 원격 점검처럼 <b>읽는 곳</b>을 그 vCenter 와 같은 데이터센터의 엣지로 정하면 엣지가 Veeam REST API(기본 포트 9419, v12 이상)를 읽어 중앙으로 올립니다.
        읽기 전용 계정(Veeam Backup Viewer 역할)을 권장합니다. 처음 접속하면 Veeam 의 자체서명 인증서가 승인 대기로 끊길 수 있습니다 — 그 노드의 설정 › Security › 장비 신뢰에서 승인하세요.
      </div>
      {d?.registryError && <div className="banner warn" style={{ marginTop: 8 }}>Veeam 서버 등록부를 읽지 못했습니다({d.registryError}) — 등록이 0대라는 뜻이 아닙니다.</div>}
      {err && <div className="banner warn" style={{ marginTop: 8 }}>목록을 읽지 못했습니다(0대라는 뜻이 아닙니다): {err} <button className="tab" style={{ marginLeft: 8, padding: '2px 10px' }} onClick={load}>다시 읽기</button></div>}
      <div className="card" style={{ marginTop: 10, padding: 14, minWidth: 0 }}>
        {servers.length > 0 && (
          <STable minWidth={980} style={{ marginBottom: 10 }}>
            <thead><tr><th>이름</th><th>주소</th><th>vCenter</th><th>읽는 곳</th><th>상태</th><th className="right">작업</th><th className="right">VM</th><th className="right">백업 중</th><th data-nosort className="right">동작</th></tr></thead>
            <tbody>
              {servers.map((s) => {
                const st = s.status; const c = statusCell(st); const cn = st?.counts || {};
                return (
                  <tr key={s.id}>
                    <td><b>{s.name}</b>{s.enabled === false && <span className="badge gray" style={{ marginLeft: 6 }}>꺼짐</span>}</td>
                    <td className="muted">{s.host}:{s.port}</td>
                    <td>{(s.vcenterIds || []).map((id) => vcName.get(id) || id).join(', ')}</td>
                    <td>{s.agent ? `엣지 ${s.agent}` : '중앙'}</td>
                    <td style={{ color: TONE[c.tone], maxWidth: 360, overflowWrap: 'anywhere' }}>{c.text}</td>
                    <td className="right" data-sort={num(cn.jobs) ?? ''}>{num(cn.jobs) ?? '—'}</td>
                    <td className="right" data-sort={num(cn.vmJobs) ?? ''} title="작업에 VM 단위로 넣은 VM 수 · 복원 지점이 있는 VM 수">{num(cn.vmJobs) != null || num(cn.backupObjects) != null ? `${num(cn.vmJobs) ?? 0} · 복원 ${num(cn.backupObjects) ?? 0}` : '—'}</td>
                    <td className="right" data-sort={num(cn.running) ?? ''}>{num(cn.running) ?? '—'}</td>
                    <td className="right nowrap">
                      <button className={open === s.id ? 'login-btn' : 'tab'} style={{ flex: 'none' }} disabled={!!busy} onClick={() => setOpen(open === s.id ? null : s.id)}>작업 목록</button>{' '}
                      {!s.agent && <><button className="tab" disabled={!!busy} onClick={() => act(s, 'test')}>{busy === `test:${s.id}` ? '시험 중…' : '연결 시험'}</button>{' '}</>}
                      {!s.agent && <><button className="tab" disabled={!!busy} onClick={() => act(s, 'collect')}>{busy === `collect:${s.id}` ? '읽는 중…' : '지금 읽기'}</button>{' '}</>}
                      <button className="tab" disabled={!!busy} onClick={() => edit(s)}>편집</button>{' '}
                      <button className="tab" style={{ color: 'var(--red)' }} disabled={!!busy} onClick={() => act(s, 'del')}>삭제</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </STable>
        )}
        {(() => {
          // 작업 목록은 표 밖에 따로 그린다 — 정렬 표 안에 펼침 행을 끼우면 정렬 때 부모 행과 떨어진다.
          const s = servers.find((x) => x.id === open);
          if (!s) return null;
          const st = s.status;
          return (
            <div style={{ margin: '0 0 12px', padding: 10, borderRadius: 8, background: 'rgba(148,163,184,.06)', minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{s.name} — 작업 목록</div>
              {(st?.notes || []).map((n, i) => <div key={i} className="muted" style={{ fontSize: 12 }}>ⓘ {n}</div>)}
              {(st?.jobs || []).length ? (
                <STable minWidth={640} style={{ marginTop: 6 }}>
                  <thead><tr><th>작업</th><th>상태</th><th>마지막 결과</th><th>마지막 실행</th><th className="right">VM 단위 포함</th><th className="right">컨테이너 포함</th></tr></thead>
                  <tbody>{st.jobs.map((j, i) => (
                    <tr key={i}><td>{j.name}</td><td>{j.running ? <span className="badge amber">실행 중</span> : j.disabled ? '꺼짐' : (j.status || '—')}</td>
                      <td>{resultLabel(j.lastResult) || '—'}</td><td data-sort={j.lastRun ?? ''}>{fmt(j.lastRun)}</td><td className="right">{j.vms ?? '—'}</td><td className="right">{j.containers ?? '—'}</td></tr>
                  ))}</tbody>
                </STable>
              ) : <div className="muted" style={{ fontSize: 12 }}>읽은 작업이 없습니다{st ? '' : '(아직 읽지 않음)'}.</div>}
            </div>
          );
        })()}
        {d && servers.length === 0 && !d.registryError && <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>등록된 Veeam 서버가 없습니다. 아래에 입력해 등록하세요.</div>}
        <div className="spec-grid">
          <label>표시 이름 <input className="input" value={form.name} onChange={set('name')} placeholder="AZ Veeam" /></label>
          <label>주소(IP·호스트명) <input className="input" value={form.host} onChange={set('host')} placeholder="10.1.2.3 또는 vbr01.corp.local" /></label>
          <label>포트 <input className="input" value={form.port} onChange={set('port')} placeholder={String(d?.defaults?.port || 9419)} inputMode="numeric" /></label>
          <label>계정 <input className="input" value={form.username} onChange={set('username')} placeholder="CORP\svc-veeam-ro" /></label>
          <label>비밀번호 <input className="input" type="password" value={form.password} onChange={set('password')} placeholder={form.id ? '●●●●● (비우면 유지)' : ''} /></label>
          <label>API 판(x-api-version) <input className="input" value={form.apiVersion} onChange={set('apiVersion')} placeholder={d?.defaults?.apiVersion || '1.1-rev0'} /></label>
          <label>읽는 곳
            <Select className="input" value={form.agent} onChange={set('agent')}>
              <option value="">중앙에서 직접</option>
              {[...new Set([...(d?.agents || []), ...(form.agent ? [form.agent] : [])])].map((a) => <option key={a} value={a}>엣지 {a}</option>)}
            </Select>
          </label>
          <label>메모 <input className="input" value={form.note} onChange={set('note')} /></label>
        </div>
        <div style={{ marginTop: 10, fontSize: 12 }}>
          <div className="muted" style={{ marginBottom: 4 }}>이 Veeam 서버가 백업하는 vCenter(여러 개 가능)</div>
          <div className="flex gap wrap" style={{ rowGap: 4 }}>
            {(d?.vcenters || []).map((v) => (
              <label key={v.id} className="flex gap" style={{ alignItems: 'center', flex: 'none', cursor: 'pointer', padding: '3px 8px', borderRadius: 6, border: '1px solid var(--border, rgba(148,163,184,.25))' }}
                title={v.siteAgent ? `이 vCenter 는 엣지 ${v.siteAgent} 가 보고합니다` : '중앙이 직접 수집하는 vCenter'}>
                <input type="checkbox" checked={form.vcenterIds.includes(v.id)} onChange={() => toggleVc(v.id)} /> {v.name}{v.siteAgent ? <span className="muted"> · {v.siteAgent}</span> : null}
              </label>
            ))}
          </div>
        </div>
        <label className="muted flex gap" style={{ alignItems: 'center', fontSize: 12, marginTop: 8, cursor: 'pointer' }}>
          <input type="checkbox" checked={form.enabled} onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))} /> 수집 켜기
        </label>
        {msg && <div style={{ marginTop: 8, padding: '7px 10px', borderRadius: 8, fontSize: 12, background: msg.ok ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)', color: msg.ok ? '#4ade80' : '#f87171', overflowWrap: 'anywhere' }}>{msg.text}</div>}
        <div className="flex gap wrap" style={{ marginTop: 10 }}>
          <button className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} disabled={!!busy || !form.host || !form.name || !form.vcenterIds.length} onClick={save}>{busy === 'save' ? '저장 중…' : form.id ? '수정 저장' : '등록'}</button>
          {form.id && <button className="tab" style={{ flex: 'none', padding: '8px 16px' }} disabled={!!busy} onClick={() => { setForm(EMPTY); setMsg(null); }}>새로 입력</button>}
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.6 }}>
          읽는 것: 작업 목록(작업에 VM 단위로 넣은 VM) · 작업 상태 · 백업 객체(복원 지점이 있는 VM) · 실행 중 세션의 VM 별 진행. 작업을 시작·중지하지 않습니다(조회 전용).
          폴더·클러스터·태그 단위로 넣은 VM 은 복원 지점이 생기거나 백업 중일 때 표시됩니다. 주기는 기본 10분(VEEAM_POLL_MS)이고, 엣지 담당 서버는 엣지가 배정을 받는 대로(최대 5분) 읽습니다.
          엣지 담당 서버의 연결 시험·지금 읽기는 그 엣지의 망에서만 의미가 있어 중앙 화면에서는 하지 않습니다.
        </div>
      </div>
      {(d?.edges || []).length > 0 && (
        <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          엣지 보고: {d.edges.map((e) => `${e.agent} ${fmt(e.at)}(서버 ${e.status?.servers != null ? `${e.status.servers}대` : '—'})`).join(' · ')}
        </div>
      )}
    </>
  );
}
