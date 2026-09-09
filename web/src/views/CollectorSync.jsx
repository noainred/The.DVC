import React, { useEffect, useState } from 'react';
import { fetchJson, postJson } from '../api.js';
import { STable } from '../components/STable.jsx';

/**
 * 에이전트 ↔ 수집 서버(원격) 대조·연결(v2.434, 사용자 요구 '에이전트가 설치되어 있는데 수집서버가
 * 설정되어 있지 않으면 추가하는 기능').
 *
 * 엣지에 깔리는 프로그램은 하나(`vmware-portal`)지만 중앙은 그 하나를 두 목록에 적어 둔다 —
 * 설치용 SSH 대상(에이전트)과 pull 용 URL+토큰(수집 서버). 배포 성공 시에만 후자가 자동 생성되므로
 * '대상만 저장' 하거나 '수집 토큰 없이 배포' 한 사이트는 수집 서버 목록에 뜨지 않는다. 여기서 메운다.
 */
const BADGE = {
  linked: ['연결됨', 'green'],
  missing: ['수집 서버 없음', 'red'],
  'no-token': ['수집 토큰 없음', 'amber'],
  'url-mismatch': ['URL 불일치', 'red'],
  'token-mismatch': ['토큰 불일치', 'red'],
  disabled: ['대상 비활성', 'gray'],
};

export default function CollectorSync() {
  // ⚠ 훅은 전부 조기 return 위에(React #310 회귀 방지).
  const [data, setData] = useState(null);
  const [sel, setSel] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [opt, setOpt] = useState({ generateToken: true, syncToEdge: false, verify: true });
  const [result, setResult] = useState(null);
  const [open, setOpen] = useState(false);

  const load = async () => {
    try {
      const d = await fetchJson('/admin/agent-deploy/collector-sync');
      setData(d);
      setSel((prev) => new Set([...prev].filter((id) => d.rows.some((r) => r.id === id && r.canAdd))));
    } catch (e) { setMsg(`대조 실패: ${e.message}`); }
  };
  useEffect(() => { if (open) load(); }, [open]);

  const rows = data?.rows || [];
  const addable = rows.filter((r) => r.canAdd);
  const s = data?.summary;
  const toggle = (id) => setSel((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const addSelected = async () => {
    const ids = [...sel];
    if (!ids.length) { setMsg('추가할 대상을 선택하세요.'); return; }
    const newTokens = ids.filter((id) => rows.find((r) => r.id === id && !r.hasToken)).length;
    const warn = [
      `수집 서버 ${ids.length}건을 추가합니다.`,
      newTokens ? `\n· ${newTokens}건은 수집 토큰이 없어 새로 만듭니다.` : '',
      newTokens && !opt.syncToEdge
        ? '\n· 새 토큰은 아직 엣지에 없으므로 연결 확인이 403 으로 나옵니다.\n  ("엣지에 반영"을 켜거나, 나중에 배포하면 해결됩니다.)'
        : '',
      opt.syncToEdge ? '\n· 엣지에 SSH 로 접속해 토큰을 바꾸고 vmware-portal 을 재시작합니다(수 초 단절).' : '',
      '\n\n계속할까요?',
    ].join('');
    if (!window.confirm(warn)) return;
    setBusy(true); setMsg(null); setResult(null);
    try {
      const r = await postJson('/admin/agent-deploy/collector-sync', { ids, ...opt });
      setResult(r);
      setMsg(r.ok ? `추가 완료 — 성공 ${r.added}/${r.total}` : `실패: ${r.reason}`);
      setSel(new Set());
      await load();
    } catch (e) { setMsg(`추가 실패: ${e.message}`); }
    finally { setBusy(false); }
  };

  if (!open) {
    return (
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="flex gap wrap" style={{ alignItems: 'center' }}>
          <b style={{ fontSize: 14 }}>🔗 수집 서버(원격) 연결 상태</b>
          <span className="muted" style={{ fontSize: 12 }}>
            에이전트가 설치돼 있어도 <b>수집 서버로 등록되지 않으면 중앙이 데이터를 당겨오지 않습니다.</b> 두 목록을 대조해 빠진 것을 채웁니다.
          </span>
          <span style={{ flex: 1 }} />
          <button className="login-btn" style={{ flex: 'none', padding: '6px 16px' }} onClick={() => setOpen(true)}>대조하기</button>
        </div>
      </div>
    );
  }

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 8 }}>
        <b style={{ fontSize: 14 }}>🔗 수집 서버(원격) 연결 상태</b>
        {s && <>
          <span className="badge green">연결됨 {s.linked}</span>
          <span className={`badge ${s.missing ? 'red' : 'gray'}`}>수집 서버 없음 {s.missing}</span>
          <span className={`badge ${s.noToken ? 'amber' : 'gray'}`}>토큰 없음 {s.noToken}</span>
          <span className={`badge ${s.mismatch ? 'red' : 'gray'}`}>불일치 {s.mismatch}</span>
          {!!s.disabled && <span className="badge gray">비활성 {s.disabled}</span>}
        </>}
        <span style={{ flex: 1 }} />
        <button className="tab" disabled={busy} onClick={load}>새로고침</button>
        <button className="tab" onClick={() => setOpen(false)}>접기</button>
      </div>

      {!data ? <div className="muted" style={{ fontSize: 12 }}>대조 중…</div> : (
        <>
          <div className="flex gap wrap" style={{ alignItems: 'center', fontSize: 12, marginBottom: 8 }}>
            <label className="flex gap" style={{ alignItems: 'center' }}>
              <input type="checkbox" checked={addable.length > 0 && sel.size === addable.length} disabled={!addable.length}
                onChange={(e) => setSel(e.target.checked ? new Set(addable.map((r) => r.id)) : new Set())} />
              추가 가능 전체 선택 ({addable.length})
            </label>
            <span style={{ opacity: .4 }}>|</span>
            <label className="flex gap" style={{ alignItems: 'center' }} title="대상에 수집 토큰이 없으면 새로 만들어 저장합니다.">
              <input type="checkbox" checked={opt.generateToken} onChange={(e) => setOpt((p) => ({ ...p, generateToken: e.target.checked }))} />수집 토큰 없으면 생성
            </label>
            <label className="flex gap" style={{ alignItems: 'center' }} title="SSH 로 엣지 portal.env 의 COLLECTOR_TOKEN 을 바꾸고 vmware-portal 을 재시작합니다. 새로 만든 토큰은 이걸 해야 바로 pull 이 됩니다.">
              <input type="checkbox" checked={opt.syncToEdge} onChange={(e) => setOpt((p) => ({ ...p, syncToEdge: e.target.checked }))} />엣지에 반영(SSH · 서비스 재시작)
            </label>
            <label className="flex gap" style={{ alignItems: 'center' }} title="등록 후 실제로 데이터를 당겨올 수 있는지 확인합니다.">
              <input type="checkbox" checked={opt.verify} onChange={(e) => setOpt((p) => ({ ...p, verify: e.target.checked }))} />등록 후 연결 확인
            </label>
            <span style={{ flex: 1 }} />
            <button className="login-btn" style={{ flex: 'none', padding: '6px 16px' }} disabled={busy || !sel.size} onClick={addSelected}>
              {busy ? '추가 중…' : `선택 ${sel.size}건 수집 서버에 추가`}
            </button>
          </div>
          {msg && <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>{msg}</div>}

          <div style={{ overflowX: 'auto' }}>
            <STable style={{ fontSize: 12 }}>
              <thead><tr>
                <th data-nosort>선택</th><th>에이전트</th><th>호스트</th><th>수집 URL</th><th>설치</th>
                <th>수집 토큰</th><th>수집 서버</th><th>상태</th><th>문제 · 조치</th>
              </tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.canAdd ? <input type="checkbox" checked={sel.has(r.id)} onChange={() => toggle(r.id)} /> : ''}</td>
                  <td><b>{r.agentName || '—'}</b>{r.datacenter && r.datacenter !== r.agentName ? <span className="muted"> / {r.datacenter}</span> : null}</td>
                  <td>{r.host}{r.port !== 22 ? `:${r.port}` : ''}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: 11 }}>{r.url}</td>
                  <td data-sort={r.at || 0}>{r.installed ? <span className="badge green" title={r.why}>설치됨</span> : <span className="badge gray" title={r.why}>미확인</span>}</td>
                  <td>{r.hasToken ? <span className="badge green">있음</span> : <span className="badge amber">없음</span>}</td>
                  <td>{r.collectorId ? <span title={r.collectorUrl}>{r.collectorId}</span> : <span className="muted">—</span>}</td>
                  <td><span className={`badge ${BADGE[r.status]?.[1] || 'gray'}`}>{BADGE[r.status]?.[0] || r.status}</span></td>
                  <td className="muted" style={{ maxWidth: 420 }}>{r.issue}{r.fix ? <><br /><b>조치:</b> {r.fix}</> : null}</td>
                </tr>))}</tbody>
            </STable>
          </div>

          {data.orphans?.length > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary className="muted" style={{ fontSize: 12, cursor: 'pointer' }}>
                배포 대상이 없는 수집 서버 {data.orphans.length}건 — 수동 등록·자기등록 엣지(조치 대상 아님)
              </summary>
              <STable style={{ fontSize: 12, marginTop: 4 }}>
                <thead><tr><th>id</th><th>이름</th><th>URL</th><th>법인</th><th>사용</th></tr></thead>
                <tbody>{data.orphans.map((o) => (
                  <tr key={o.id}><td>{o.id}</td><td>{o.name}</td><td style={{ fontFamily: 'monospace', fontSize: 11 }}>{o.url}</td><td>{o.datacenter || '—'}</td>
                    <td>{o.enabled ? <span className="badge green">사용</span> : <span className="badge gray">중지</span>}</td></tr>))}</tbody>
              </STable>
              <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                SSH 계정을 중앙에 저장하지 않았거나 엣지가 스스로 등록한 항목입니다. 배포·토큰 동기화를 하려면 '에이전트 추가/변경'에 SSH 대상을 등록하세요.
              </div>
            </details>
          )}

          {result && (
            <div className="card" style={{ marginTop: 8, background: 'var(--panel-2)' }}>
              <b style={{ fontSize: 13 }}>추가 결과 — 성공 {result.added}/{result.total}</b>
              <STable style={{ fontSize: 12, marginTop: 4 }}>
                <thead><tr><th>호스트</th><th>에이전트</th><th>결과</th><th>수집 서버</th><th>토큰</th><th>엣지 반영</th><th>연결 확인</th><th>사유</th></tr></thead>
                <tbody>{(result.results || []).map((x) => (
                  <tr key={x.id}>
                    <td>{x.host}</td><td>{x.agentName || '—'}</td>
                    <td>{x.ok ? <span className="badge green">성공</span> : <span className="badge red">실패</span>}</td>
                    <td>{x.collectorId ? `${x.collectorId}${x.updated ? ' (갱신)' : ''}` : '—'}</td>
                    <td>{x.tokenGenerated ? <span className="badge blue">새로 생성</span> : <span className="muted">기존</span>}</td>
                    <td>{x.edge ? (x.edge.ok ? <span className="badge green">{x.edge.active}</span> : <span className="badge red" title={x.edge.reason}>실패</span>) : '—'}</td>
                    <td>{x.verified ? (x.verified.ok ? <span className="badge green">OK</span> : <span className="badge amber" title={x.verified.reason}>실패</span>) : '—'}</td>
                    <td className="muted" style={{ maxWidth: 360 }}>{x.reason || x.verified?.reason || ''}</td>
                  </tr>))}</tbody>
              </STable>
            </div>
          )}

          <div className="muted" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.7 }}>
            <b>판정 기준</b> — '설치' 는 <b>마지막 배포 기록</b>으로만 판단합니다(24대를 매번 SSH 로 확인하면 화면이 수 분 멈추므로).
            확실히 보려면 위 목록의 '상태 확인'을 쓰세요. 매칭은 접속 URL(host:port)이 먼저이고, 없으면 수집 서버 id 로 찾습니다.
            <br /><b>정직한 한계</b> — 여기서 만든 토큰은 중앙에만 저장됩니다. '엣지에 반영'을 켜지 않으면 엣지의 <code>COLLECTOR_TOKEN</code> 은 그대로라
            연결 확인이 403 으로 나옵니다(다음 배포 때 자동으로 맞춰집니다).
          </div>
        </>
      )}
    </div>
  );
}
