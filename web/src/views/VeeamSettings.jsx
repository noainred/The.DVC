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
import { fetchJson, sendJson, postJson, delJson, canCsv } from '../api.js';
import { STable } from '../components/STable.jsx';
import Select from '../components/Select.jsx';
import { droppedSecretNote } from './droppedSecretText.js';
import { resultLabel } from './veeamBadge.js';
import BulkDeviceIo from './tools/BulkDeviceIo.jsx'; // v2.751 CSV·자유텍스트 대량 등록(스토리지·SAN·Horizon 과 같은 모달)

// v2.763(V5-2): agentTouched — 사람이 '읽는 곳' 을 골랐는가('' 는 '아직 안 고름' 과 '중앙에서 직접(명시)' 둘 다라 따로 든다). 서버로 보내지 않는다.
const EMPTY = { id: '', name: '', host: '', port: '', username: '', password: '', apiVersion: '', agent: '', agentTouched: false, vcenterIds: [], enabled: true, note: '' };
const fmt = (ms) => {
  if (ms == null || !Number.isFinite(Number(ms))) return '—';
  const d = new Date(Number(ms)); const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const num = (v) => (Number.isFinite(v) ? v : null);

/** 상태 칸 문구·색. */
export function statusCell(st) {
  if (!st) return { text: '아직 읽지 않음', tone: 'muted' };
  // v2.763(V5-4): 성공 결과라도 한도보다 오래됐으면(엣지가 멈춤 등) '정상' 만 말하지 않는다 — 사용자 화면의 stale 과 같은 판정(서버가 준 값).
  if (st.ok && st.stale) return { text: `오래된 결과 · ${fmt(st.ts)} — 그 뒤로 새 결과가 오지 않았습니다(백업 중 수는 모름)`, tone: 'warn' };
  if (st.ok) return { text: `정상 · ${fmt(st.ts)}`, tone: 'ok' };
  if (st.authStop) return { text: `인증 실패로 주기 수집 정지 · ${st.error || ''}`, tone: 'bad' };
  return { text: `실패 · ${fmt(st.ts)} · ${st.error || '사유 미상'}${st.lastOkTs ? ` (마지막 성공 ${fmt(st.lastOkTs)})` : ''}`, tone: 'bad' };
}
const TONE = { ok: '#4ade80', bad: '#f87171', warn: 'var(--amber)', muted: 'var(--text-dim)' };

/**
 * v2.763(V5-2): vCenter 를 체크할 때 읽는 곳 제안 — **신규이고 사람이 읽는 곳을 건드리지 않았고 아직 비어 있을 때만** 그 vCenter 를 보고하는
 *   엣지로. 예전에는 '' 를 '미선택' 으로만 봐서 편집 중 사람이 고른 '중앙에서 직접' 을 조용히 엣지로 바꿨다(다음 pull 로 비밀번호가 그 엣지로 간다).
 */
export function agentAfterVcToggle(f, adding, siteAgent) {
  if (!adding || f.id || f.agentTouched || f.agent) return f.agent;
  return siteAgent || '';
}

/**
 * v2.763(V5-1·V2-1): 행 동작 버튼. 진행 중 잠금은 **그 서버의 그 버튼만**(docs/rules/web.md v2.529) — 편집·작업 목록은 잠그지 않고, 잠긴 버튼은 title 로 이유.
 *   엣지에서 중앙이 배정한 서버(centralManaged)는 편집·삭제 대신 안내(서버도 409) — 연결 시험·지금 읽기는 그대로(엣지에서 인증 정지를 푸는 길).
 * @param {object} s 목록 원소 @param {Set<string>} busy 진행 중 키('test:<id>'·'collect:<id>'·'del:<id>'·'save')
 */
export function rowActions(s, busy) {
  const on = (k) => !!busy?.has?.(`${k}:${s.id}`);
  const out = [];
  if (!s.agent || s.readsHere) {
    out.push({ kind: 'test', label: on('test') ? '시험 중…' : '연결 시험', disabled: on('test'), title: on('test') ? '이 서버의 연결 시험이 진행 중입니다 — 끝나면 다시 누를 수 있습니다' : undefined });
    const off = s.enabled === false;
    out.push({ kind: 'collect', label: on('collect') ? '읽는 중…' : '지금 읽기', disabled: off || on('collect'),
      title: off ? '수집이 꺼진 서버입니다 — 편집에서 켠 뒤 읽으세요' : on('collect') ? '이 서버를 읽는 중입니다 — 끝나면 다시 누를 수 있습니다' : undefined });
  }
  if (s.centralManaged) {
    out.push({ kind: 'central', label: '중앙 배정', title: '중앙 포탈이 배정한 서버입니다 — 이 엣지에서 고치면 중앙과 어긋나고 재시작 뒤 되돌아가므로 편집·삭제는 중앙 포탈의 설정 › Veeam 백업 서버에서 하세요' });
  } else {
    out.push({ kind: 'edit', label: '편집', disabled: false });
    out.push({ kind: 'del', label: on('del') ? '삭제 중…' : '삭제', disabled: on('del'), title: on('del') ? '이 서버를 삭제하는 중입니다' : undefined });
  }
  return out;
}

export default function VeeamSettings() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [denied, setDenied] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(() => new Set());   // v2.763(V5-1): 진행 중인 동작 키 — 그 대상만 잠근다
  const busyOn = (k) => setBusy((b) => new Set(b).add(k));
  const busyOff = (k) => setBusy((b) => { const n = new Set(b); n.delete(k); return n; });
  const [open, setOpen] = useState(null); // 작업 목록을 펼친 서버 id
  const [bulk, setBulk] = useState(false); // CSV·자유텍스트 대량 등록 모달
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

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value, ...(k === 'agent' ? { agentTouched: true } : {}) }));
  const toggleVc = (id) => setForm((f) => {
    const has = f.vcenterIds.includes(id);
    const vcenterIds = has ? f.vcenterIds.filter((x) => x !== id) : [...f.vcenterIds, id];
    // 신규이고 읽는 곳을 아직 안 골랐으면 그 vCenter 를 보고하는 엣지를 제안한다(같은 데이터센터의 Veeam 은 보통 그 엣지에서 닿는다 — v2.763 V5-2).
    const site = !has ? (d?.vcenters || []).find((v) => v.id === id)?.siteAgent : '';
    return { ...f, vcenterIds, agent: agentAfterVcToggle(f, !has, site) };
  });
  const save = async () => {
    busyOn('save'); setMsg(null);
    try {
      const { agentTouched: _t, ...body } = form;
      const r = await sendJson('/admin/veeam/servers', 'POST', { ...body, port: form.port === '' ? undefined : Number(form.port) });
      if (!r.ok) { setMsg({ ok: false, text: r.reason || '저장하지 못했습니다.' }); return; }
      const drop = droppedSecretNote(r.server);
      setMsg(drop ? { ok: false, text: drop } : { ok: true, text: '저장했습니다. 담당 노드가 다음 수집(엣지는 배정 pull 뒤 곧바로)에 읽습니다.' });
      setForm(drop ? { ...form, id: r.server.id, password: '' } : EMPTY);
      load();
    } catch (e) { setMsg({ ok: false, text: e.message }); } finally { busyOff('save'); }
  };
  const act = async (s, kind) => {
    const key = `${kind}:${s.id}`;
    if (busy.has(key)) return;
    busyOn(key); setMsg(null);
    try {
      if (kind === 'del') {
        if (!window.confirm(`Veeam 서버 '${s.name}' 등록을 삭제할까요?`)) return;
        const r = await delJson(`/admin/veeam/servers/${encodeURIComponent(s.id)}`);
        setMsg(r?.ok === false ? { ok: false, text: r.reason || '삭제하지 못했습니다.' } : { ok: true, text: '삭제했습니다.' });
      } else {
        const r = await postJson(`/admin/veeam/servers/${encodeURIComponent(s.id)}/${kind}`, {});
        // v2.763(V5-I2): 시험 성공이 인증 실패 정지를 풀었으면 그렇게 말한다(서버가 authStopCleared) · 작업 수를 모르면 단위를 붙이지 않는다.
        if (kind === 'test') setMsg(r.ok ? { ok: true, text: `연결 성공 · 작업 ${Number.isFinite(r.jobs) ? `${r.jobs}개` : '수 모름'} · ${r.ms}ms · API ${r.apiVersion}${r.authStopCleared ? ' · 인증 실패로 멈춘 주기 수집을 풀었습니다(다음 주기부터 다시 읽습니다)' : ''}` } : { ok: false, text: r.reason || '연결 실패' });
        // v2.761(D6): 응답의 ok 는 성공 여부(불리언) · 개수는 okCount/failCount. 실패하면 서버가 준 사유(status.error)까지 보인다.
        else setMsg(r.ok ? { ok: true, text: `읽기 완료(성공 ${r.okCount ?? 0} · 실패 ${r.failCount ?? 0})` }
          : { ok: false, text: r.reason || (r.skipped ? '이미 수집 중입니다 — 끝나면 목록에 반영됩니다' : `읽기 실패${r.status?.error ? `: ${r.status.error}` : ''}`) });
      }
      load();
    } catch (e) { setMsg({ ok: false, text: e.message }); } finally { busyOff(key); }
  };

  const servers = d?.servers || [];
  // 기존 서버의 읽는 곳은 이미 정해진 값이다(agentTouched — vCenter 를 더 체크해도 바꾸지 않는다).
  const edit = (s) => setForm({ id: s.id, name: s.name, host: s.host, port: String(s.port || ''), username: s.username, password: '', apiVersion: s.apiVersion || '', agent: s.agent || '', agentTouched: true, vcenterIds: s.vcenterIds || [], enabled: s.enabled !== false, note: s.note || '' });
  // 편집 중 읽는 곳이 중앙인데 고른 vCenter 를 엣지가 보고하면 제안만 문구로(값은 바꾸지 않는다).
  const siteHint = !form.agent && form.agentTouched ? (d?.vcenters || []).find((v) => form.vcenterIds.includes(v.id) && v.siteAgent)?.siteAgent : '';

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
                    <td>{s.agent ? `엣지 ${s.agent}` : '중앙'}{s.agent && Array.isArray(d?.tokenAgents) && !d.tokenAgents.some((a) => String(a).toLowerCase() === String(s.agent).toLowerCase()) && (
                      <div style={{ color: 'var(--amber)', fontSize: 11, marginTop: 2 }} title="Veeam 위임은 엣지별(개별) 토큰으로만 받습니다 — 공유 토큰으로는 어느 엣지인지 가릴 수 없어 자격증명을 내려보내지 않습니다">개별 토큰 없음 — 설정 › 수집 서버에서 발급</div>
                    )}</td>
                    <td style={{ color: TONE[c.tone], maxWidth: 360, overflowWrap: 'anywhere' }}>{c.text}</td>
                    <td className="right" data-sort={num(cn.jobs) ?? ''}>{num(cn.jobs) ?? '—'}</td>
                    <td className="right" data-sort={num(cn.vmJobs) ?? ''} title="작업에 VM 단위로 넣은 VM 수 · 복원 지점이 있는 VM 수">{num(cn.vmJobs) != null || num(cn.backupObjects) != null ? `${num(cn.vmJobs) ?? 0} · 복원 ${num(cn.backupObjects) ?? 0}` : '—'}</td>
                    <td className="right" data-sort={num(cn.running) ?? ''} title={st?.runningStale ? '실패 중이거나 오래된 결과라 지금 백업 중인 VM 수를 알 수 없습니다(0 이 아닙니다)' : undefined}>{num(cn.running) ?? '—'}</td>
                    <td className="right nowrap">
                      <button className={open === s.id ? 'login-btn' : 'tab'} style={{ flex: 'none' }} onClick={() => setOpen(open === s.id ? null : s.id)}>작업 목록</button>{' '}
                      {/* v2.762(G3): 이 노드가 읽는 서버(readsHere — 엣지에서는 받은 자기 몫)도 연다 — 엣지에서 인증 정지를 푸는 길 · v2.763: 잠금은 그 버튼만 */}
                      {rowActions(s, busy).map((a) => (a.kind === 'central'
                        ? <span key={a.kind} className="badge gray" style={{ marginLeft: 2 }} title={a.title}>중앙 배정 — 중앙에서 수정</span>
                        : <React.Fragment key={a.kind}><button className="tab" style={a.kind === 'del' ? { color: 'var(--red)' } : undefined} disabled={a.disabled} title={a.title}
                          onClick={() => (a.kind === 'edit' ? edit(s) : act(s, a.kind))}>{a.label}</button>{' '}</React.Fragment>))}
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
              {st?.runningStale && <div style={{ fontSize: 12, color: 'var(--amber)' }}>ⓘ 이 서버는 {st.ok ? '결과가 오래돼' : '지금 읽기에 실패 중이라'} 작업의 '실행 중' 여부를 표시하지 않습니다(목록은 마지막 성공 기준).</div>}
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
            {siteHint && <span className="muted" style={{ display: 'block', fontSize: 11, marginTop: 2 }}>고른 vCenter 를 엣지 {siteHint} 가 보고합니다 — 그 엣지에서 읽으려면 위에서 바꾸세요.</span>}
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
          <button className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} disabled={busy.has('save') || !form.host || !form.name || !form.vcenterIds.length} title={busy.has('save') ? '저장 중입니다' : undefined} onClick={save}>{busy.has('save') ? '저장 중…' : form.id ? '수정 저장' : '등록'}</button>
          {form.id && <button className="tab" style={{ flex: 'none', padding: '8px 16px' }} disabled={busy.has('save')} title={busy.has('save') ? '저장 중입니다' : undefined} onClick={() => { setForm(EMPTY); setMsg(null); }}>새로 입력</button>}
          {canCsv() && <button className="tab" style={{ flex: 'none', padding: '8px 16px' }} onClick={() => setBulk(true)}>📥 CSV · 자유텍스트 대량 등록</button>}
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.6 }}>
          읽는 것: 작업 목록(작업에 VM 단위로 넣은 VM) · 작업 상태 · 백업 객체(복원 지점이 있는 VM) · 실행 중 세션의 VM 별 진행. 작업을 시작·중지하지 않습니다(조회 전용).
          폴더·클러스터·태그 단위로 넣은 VM 은 복원 지점이 생기거나 백업 중일 때 표시됩니다. 주기는 {Number.isFinite(d?.poller?.intervalMs) ? `${Math.round(d.poller.intervalMs / 60_000)}분` : '서버 설정값'}(VEEAM_POLL_MS)이고, 엣지 담당 서버는 엣지가 배정을 받는 대로 읽습니다.
          엣지 담당 서버의 연결 시험·지금 읽기는 그 엣지의 망에서만 의미가 있어 중앙 화면에서는 하지 않습니다 — 그 엣지 포탈의 이 화면(설정 › Veeam 백업 서버)에서 누르세요(인증 실패로 멈춘 주기 수집을 같은 비밀번호로 확인할 때도 같습니다).
        </div>
      </div>
      {(d?.edges || []).length > 0 && (
        <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          엣지 보고: {d.edges.map((e) => `${e.agent} ${fmt(e.at)}(서버 ${e.status?.servers != null ? `${e.status.servers}대` : '—'})`).join(' · ')}
        </div>
      )}
      <VeeamVcAccounts />
      {canCsv() && bulk && (
        <BulkDeviceIo base="/admin/veeam" resource="servers" unitLabel="서버" typeCol={null} keyLabel="host:port"
          title="Veeam 백업 서버 대량 등록 — CSV · 자유텍스트"
          onClose={() => setBulk(false)} onDone={() => { setBulk(false); load(); }} />
      )}
    </>
  );
}

/**
 * v2.754: vCenter 이벤트로 Veeam 백업을 가리는 'Veeam 계정'(Veeam 이 vCenter 에 접속하는 계정).
 * 이름에 'veeam' 이 든 계정은 적지 않아도 된다 · 지금 Veeam 임시 스냅샷을 만든 계정은 자동으로 배운다(아래 목록) · 엣지는 다음 pull 때 받는다.
 * 조회 실패 상태로 저장 버튼을 열지 않는다(덮어쓰기 방지).
 */
function VeeamVcAccounts() {
  const [d, setD] = useState(null);
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const load = () => {
    const my = ++seq.current;
    fetchJson('/admin/veeam/vc-accounts')
      .then((r) => { if (my !== seq.current) return; setD(r); setText((r.manual || []).join('\n')); setErr(''); })
      .catch((e) => { if (my === seq.current) setErr(e.message || String(e)); });
  };
  useEffect(() => { load(); return () => { seq.current += 1; }; }, []);
  const save = async () => {
    setBusy(true); setMsg('');
    try {
      const r = await sendJson('/admin/veeam/vc-accounts', 'PUT', { accounts: text });
      // 서버가 거부(400·409 {ok:false, reason})하면 저장했다고 말하지 않는다(v2.742 WEB-02 · audit2727e 스윕).
      if (!r?.ok) { setMsg(`저장하지 못했습니다: ${r?.reason || '서버가 거부했습니다'}`); setBusy(false); return; }
      setD(r); setText((r.manual || []).join('\n'));
      setMsg(`저장했습니다 — ${r.saved}개${r.dropped ? ` · 형식·상한으로 버림 ${r.dropped}개` : ''}. 엣지는 다음 pull 때 받습니다.`);
    } catch (e) { setMsg(`저장하지 못했습니다: ${e.message || e}`); }
    setBusy(false);
  };
  const forget = async (name) => {
    setBusy(true); setMsg('');
    try {
      const r = await sendJson('/admin/veeam/vc-accounts', 'PUT', { forget: [name] });
      if (!r?.ok) { setMsg(`지우지 못했습니다: ${r?.reason || '서버가 거부했습니다'}`); setBusy(false); return; }
      setD(r); setMsg(r.forgot ? `학습 계정을 지웠습니다: ${name}` : '이미 없는 계정입니다.');
    } catch (e) { setMsg(`지우지 못했습니다: ${e.message || e}`); }
    setBusy(false);
  };
  // v2.761(D7): 계정 파일을 못 읽은 상태(loadError)에서는 입력·저장·지우기를 열지 않는다(조회 실패 상태로 저장 버튼을 열지 않는다 규약).
  const locked = !d || !!busy || !!d?.loadError;
  return (
    <div className="card" style={{ marginTop: 12, padding: '12px 14px', minWidth: 0 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Veeam 이 vCenter 에 접속하는 계정 — 이벤트로 Veeam 백업 찾기</div>
      <div className="muted" style={{ fontSize: 12, lineHeight: 1.6, marginBottom: 8, overflowWrap: 'anywhere' }}>
        vCenter › VM 및 폴더의 하늘색 점선 배지(📸 날짜 — Veeam 백업 시도)는 최근 7일 vCenter 이벤트 중 이 계정들이 만든 VM 스냅샷으로 정합니다. 이름에 veeam 이 든 계정은 적지 않아도 되고,
        지금 Veeam 임시 스냅샷을 만든 계정은 자동으로 배웁니다. 한 줄에 하나 — 도메인까지 적으면 그 계정만(예: CORP\svc-backup · VSPHERE.LOCAL\Administrator 와 administrator@vsphere.local 은 같은 계정), 도메인 없이 적으면 어느 도메인의 같은 이름이든 맞춥니다. administrator 같은 공용 계정을 적으면 사람이 만든 스냅샷과 섞이지 않게 만들고 12시간 안에 지운 스냅샷만 셉니다.
      </div>
      {err ? <div style={{ color: 'var(--red)', fontSize: 12 }}>불러오지 못했습니다: {err}</div> : (
        <>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} disabled={locked} placeholder="CORP\svc-backup"
            style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'var(--mono, monospace)', fontSize: 12 }} aria-label="Veeam vCenter 계정" />
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 6 }}>
            <button className="login-btn" style={{ flex: 'none' }} disabled={locked} onClick={save}>{busy ? '저장 중…' : '저장'}</button>
            {msg && <span className="muted" style={{ fontSize: 12, overflowWrap: 'anywhere', minWidth: 0 }}>{msg}</span>}
          </div>
          {d && (
            <div className="muted" style={{ fontSize: 12, marginTop: 8, lineHeight: 1.6, overflowWrap: 'anywhere' }}>
              <div>자동으로 배운 계정{(d.learned || []).length ? '' : ': 아직 없음'} <span style={{ opacity: 0.8 }}>(서로 다른 VM {d.minVms ?? 2}대 이상에서 확인돼야 씁니다 · 잘못 배웠으면 지우세요)</span></div>
              {(d.learned || []).map((x) => (
                <div key={x.name} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <span style={{ overflowWrap: 'anywhere', minWidth: 0 }}>{x.name} · VM {x.vms}대 · 마지막 {fmt(x.lastSeen)} · {x.active ? '사용 중' : '후보(아직 안 씀)'}</span>
                  <button className="tab" style={{ flex: 'none' }} disabled={locked} onClick={() => forget(x.name)}>지우기</button>
                </div>
              ))}
              {(d.pulled || []).length > 0 && <div>중앙에서 받은 계정: {d.pulled.join(' · ')}</div>}
              {d.loadError && <div style={{ color: 'var(--amber)' }}>계정 파일을 읽지 못했습니다(손상본은 옆에 보존) — 이 상태로는 저장하지 않습니다.</div>}
              {!d.loadError && d.corruptKept && <div style={{ color: 'var(--amber)' }}>예전에 손상돼 옆에 보존된 계정 파일(veeam-vc-accounts.json.corrupt.*)이 있습니다 — 그때 적은 계정이 빠졌다면 다시 적으세요.</div>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
