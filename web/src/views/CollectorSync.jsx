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
  'url-conflict': ['URL 중복', 'red'],
  'url-mismatch': ['URL 불일치', 'red'],
  'token-mismatch': ['토큰 불일치', 'amber'],
  disabled: ['대상 비활성', 'gray'],
};
/** 토큰 정렬 방향 — '진단' 결과가 어느 쪽이 살아있는지 알려준다. */
const DIRS = [
  ['central-to-target', '중앙 → 대상', '수집 서버의 토큰을 배포 대상에 복사합니다. SSH 없이 즉시 끝나고 지금 수집 동작은 그대로입니다(재배포 시 끊기는 것만 막습니다). 대개 이것이 정답입니다.'],
  ['target-to-central', '대상 → 중앙', '배포 대상의 토큰을 수집 서버에 반영합니다. 엣지가 대상 토큰을 받고 있어 지금 pull 이 실패 중일 때 씁니다. SSH 불필요.'],
  ['target-to-edge', '대상 → 엣지(SSH)', '배포 대상의 토큰을 엣지 portal.env 에 밀어넣고 서비스를 재시작한 뒤 중앙도 맞춥니다. 어느 토큰도 통하지 않을 때만 쓰세요(수 초 단절).'],
];
const RECO = { 'central-to-target': '중앙 → 대상', 'target-to-central': '대상 → 중앙', 'target-to-edge': '대상 → 엣지(SSH)', none: '—' };

export default function CollectorSync() {
  // ⚠ 훅은 전부 조기 return 위에(React #310 회귀 방지).
  const [data, setData] = useState(null);
  const [sel, setSel] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [opt, setOpt] = useState({ generateToken: true, syncToEdge: false, verify: true });
  const [result, setResult] = useState(null);
  const [open, setOpen] = useState(false);
  const [dir, setDir] = useState('central-to-target');   // 토큰 정렬 방향(v2.436)
  const [probe, setProbe] = useState(null);              // id → 진단 결과

  const load = async () => {
    try {
      const d = await fetchJson('/admin/agent-deploy/collector-sync');
      setData(d);
      setSel((prev) => new Set([...prev].filter((id) => d.rows.some((r) => r.id === id && (r.canAdd || r.canFix)))));
    } catch (e) { setMsg(`대조 실패: ${e.message}`); }
  };
  useEffect(() => { if (open) load(); }, [open]);

  const rows = data?.rows || [];
  const actionable = rows.filter((r) => r.canAdd || r.canFix);
  const selRows = actionable.filter((r) => sel.has(r.id));
  const selFix = selRows.filter((r) => r.canFix).length;
  const selAdd = selRows.filter((r) => r.canAdd).length;
  const s = data?.summary;
  const toggle = (id) => setSel((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const runProbe = async () => {
    const ids = [...sel];
    if (!ids.length) { setMsg('진단할 대상을 선택하세요.'); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await postJson('/admin/agent-deploy/collector-sync/probe', { ids });
      const m = {}; for (const x of r.results || []) m[x.id] = x;
      setProbe(m);
      const votes = {};
      for (const x of r.results || []) if (x.recommend) votes[x.recommend] = (votes[x.recommend] || 0) + 1;
      const best = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
      if (best && DIRS.some((d2) => d2[0] === best[0])) setDir(best[0]);
      setMsg(`진단 완료 — ${(r.results || []).length}건. 권장 방향: ${best ? `${RECO[best[0]]} (${best[1]}건)` : '판단 불가'}`);
    } catch (e) { setMsg(`진단 실패: ${e.message}`); }
    finally { setBusy(false); }
  };
  const applySelected = async () => {
    const ids = [...sel];
    if (!ids.length) { setMsg('조치할 대상을 선택하세요.'); return; }
    const newTokens = selRows.filter((r) => r.canAdd && !r.hasToken).length;
    const dirLabel = DIRS.find((d2) => d2[0] === dir)?.[1] || dir;
    const warn = [
      selAdd ? `수집 서버 ${selAdd}건 추가` : '',
      selAdd && selFix ? ' · ' : '',
      selFix ? `토큰 정렬 ${selFix}건 (${dirLabel})` : '',
      '\n',
      newTokens ? `\n· ${newTokens}건은 수집 토큰이 없어 새로 만듭니다.` : '',
      newTokens && !opt.syncToEdge
        ? '\n· 새 토큰은 아직 엣지에 없으므로 연결 확인이 403 으로 나옵니다("엣지에 반영"을 켜거나 나중에 배포하면 해결).'
        : '',
      (opt.syncToEdge || dir === 'target-to-edge') ? '\n· 엣지에 SSH 로 접속해 토큰을 바꾸고 vmware-portal 을 재시작합니다(수 초 단절).' : '',
      dir === 'central-to-target' && selFix ? '\n· 중앙→대상 정렬은 SSH 없이 배포 대상 기록만 고칩니다 — 지금 수집 동작은 바뀌지 않습니다.' : '',
      '\n\n계속할까요?',
    ].join('');
    if (!window.confirm(warn)) return;
    setBusy(true); setMsg(null); setResult(null);
    try {
      const r = await postJson('/admin/agent-deploy/collector-sync', { ids, tokenDirection: dir, ...opt });
      setResult(r);
      setMsg(r.ok ? `조치 완료 — 성공 ${r.added}/${r.total}` : `실패: ${r.reason}`);
      setSel(new Set()); setProbe(null);
      await load();
    } catch (e) { setMsg(`조치 실패: ${e.message}`); }
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
          <span className={`badge ${s.mismatch ? 'amber' : 'gray'}`}>토큰/URL 불일치 {s.mismatch}</span>
          {!!s.conflict && <span className="badge red">URL 중복 {s.conflict}</span>}
          {!!s.disabled && <span className="badge gray">비활성 {s.disabled}</span>}
        </>}
        <span style={{ flex: 1 }} />
        <button className="tab" disabled={busy} onClick={load}>새로고침</button>
        <button className="tab" onClick={() => setOpen(false)}>접기</button>
      </div>

      {!data ? <div className="muted" style={{ fontSize: 12 }}>대조 중…</div> : (
        <>
          <div className="flex gap wrap" style={{ alignItems: 'center', fontSize: 12, marginBottom: 6 }}>
            <label className="flex gap" style={{ alignItems: 'center' }}>
              <input type="checkbox" checked={actionable.length > 0 && sel.size === actionable.length} disabled={!actionable.length}
                onChange={(e) => setSel(e.target.checked ? new Set(actionable.map((r) => r.id)) : new Set())} />
              조치 가능 전체 선택 ({actionable.length})
            </label>
            {!!selRows.length && <span className="muted">선택: 추가 {selAdd} · 정렬 {selFix}</span>}
            <span style={{ flex: 1 }} />
            <button className="tab" disabled={busy || !sel.size} onClick={runProbe}
              title="선택한 대상의 수집 URL 로 두 토큰(중앙·대상)을 각각 시도해, 엣지가 실제로 어느 값을 받는지 측정합니다. 아무것도 바꾸지 않습니다.">
              🔍 진단 (읽기 전용)
            </button>
            <button className="login-btn" style={{ flex: 'none', padding: '6px 16px' }} disabled={busy || !sel.size} onClick={applySelected}>
              {busy ? '처리 중…' : `선택 ${sel.size}건 조치`}
            </button>
          </div>

          {/* 토큰 정렬 방향 — 정렬 대상이 선택됐을 때만 보인다 */}
          {!!selFix && (
            <div className="card" style={{ padding: '8px 10px', marginBottom: 6, background: 'var(--panel-2)', fontSize: 12 }}>
              <b>토큰 정렬 방향</b> <span className="muted">({selFix}건에 적용 · 추가 대상에는 영향 없음)</span>
              <div className="flex gap wrap" style={{ marginTop: 4 }}>
                {DIRS.map(([k, label, help]) => (
                  <label key={k} className="flex gap" style={{ alignItems: 'center' }} title={help}>
                    <input type="radio" name="tokendir" checked={dir === k} onChange={() => setDir(k)} />{label}
                  </label>
                ))}
              </div>
              <div className="muted" style={{ marginTop: 4 }}>{DIRS.find((d2) => d2[0] === dir)?.[2]}</div>
            </div>
          )}

          <div className="flex gap wrap" style={{ alignItems: 'center', fontSize: 12, marginBottom: 8 }}>
            <label className="flex gap" style={{ alignItems: 'center' }} title="수집 서버를 새로 추가하는 대상에만 적용됩니다.">
              <input type="checkbox" checked={opt.generateToken} onChange={(e) => setOpt((p) => ({ ...p, generateToken: e.target.checked }))} />수집 토큰 없으면 생성
            </label>
            <label className="flex gap" style={{ alignItems: 'center' }} title="SSH 로 엣지 portal.env 의 COLLECTOR_TOKEN 을 바꾸고 vmware-portal 을 재시작합니다. 새로 만든 토큰은 이걸 해야 바로 pull 이 됩니다.">
              <input type="checkbox" checked={opt.syncToEdge} onChange={(e) => setOpt((p) => ({ ...p, syncToEdge: e.target.checked }))} />엣지에 반영(SSH · 서비스 재시작)
            </label>
            <label className="flex gap" style={{ alignItems: 'center' }} title="조치 후 실제로 데이터를 당겨올 수 있는지 확인합니다.">
              <input type="checkbox" checked={opt.verify} onChange={(e) => setOpt((p) => ({ ...p, verify: e.target.checked }))} />조치 후 연결 확인
            </label>
          </div>
          {msg && <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>{msg}</div>}

          <div style={{ overflowX: 'auto' }}>
            <STable style={{ fontSize: 12 }}>
              <thead><tr>
                <th data-nosort>선택</th><th>에이전트</th><th>호스트</th><th>수집 URL</th><th>설치</th>
                <th>수집 토큰</th><th>수집 서버</th><th>상태</th><th>진단</th><th>문제 · 조치</th>
              </tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.id}>
                  <td>{(r.canAdd || r.canFix) ? <input type="checkbox" checked={sel.has(r.id)} onChange={() => toggle(r.id)} /> : ''}</td>
                  <td><b>{r.agentName || '—'}</b>{r.datacenter && r.datacenter !== r.agentName ? <span className="muted"> / {r.datacenter}</span> : null}</td>
                  <td>{r.host}{r.port !== 22 ? `:${r.port}` : ''}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: 11 }}>{r.url}</td>
                  <td data-sort={r.at || 0}>{r.installed ? <span className="badge green" title={r.why}>설치됨</span> : <span className="badge gray" title={r.why}>미확인</span>}</td>
                  <td>{r.hasToken ? <span className="badge green">있음</span> : <span className="badge amber">없음</span>}</td>
                  <td>{r.collectorId ? <span title={r.collectorUrl}>{r.collectorId}</span> : <span className="muted">—</span>}</td>
                  <td><span className={`badge ${BADGE[r.status]?.[1] || 'gray'}`}>{BADGE[r.status]?.[0] || r.status}</span></td>
                  <td style={{ fontSize: 11 }}>{probe?.[r.id] ? (
                    <span title={probe[r.id].why}>
                      중앙 {probe[r.id].central.ok ? <span className="badge green">OK</span> : <span className="badge red">{probe[r.id].central.reason || '실패'}</span>}<br />
                      대상 {probe[r.id].target.ok ? <span className="badge green">OK</span> : <span className="badge red">{probe[r.id].target.reason || '실패'}</span>}<br />
                      <b>권장 {RECO[probe[r.id].recommend] || '—'}</b>
                    </span>) : <span className="muted">—</span>}</td>
                  <td className="muted" style={{ maxWidth: 420 }}>{r.issue}{r.fix ? <><br /><b>조치:</b> {r.fix}</> : null}
                    {probe?.[r.id]?.why ? <><br /><b style={{ color: 'var(--accent)' }}>진단:</b> {probe[r.id].why}</> : null}</td>
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
                <thead><tr><th>호스트</th><th>에이전트</th><th>결과</th><th>수집 서버</th><th>조치</th><th>토큰</th><th>엣지 반영</th><th>연결 확인</th><th>사유</th></tr></thead>
                <tbody>{(result.results || []).map((x) => (
                  <tr key={x.id}>
                    <td>{x.host}</td><td>{x.agentName || '—'}</td>
                    <td>{x.ok ? <span className="badge green">성공</span> : <span className="badge red">실패</span>}</td>
                    <td>{x.collectorId ? `${x.collectorId}${x.updated ? ' (갱신)' : ''}` : '—'}</td>
                    <td>{x.aligned ? <span className="badge teal">{RECO[x.aligned] || x.aligned}</span> : <span className="muted">추가</span>}</td>
                    <td>{x.tokenGenerated ? <span className="badge blue">새로 생성</span> : <span className="muted">기존</span>}</td>
                    <td>{x.edge ? (x.edge.ok ? <span className="badge green">{x.edge.active}</span> : <span className="badge red" title={x.edge.reason}>실패</span>) : '—'}</td>
                    <td>{x.verified ? (x.verified.ok ? <span className="badge green">OK</span> : <span className="badge amber" title={x.verified.reason}>실패</span>) : '—'}</td>
                    <td className="muted" style={{ maxWidth: 360 }}>{x.reason || x.note || x.verified?.reason || ''}</td>
                  </tr>))}</tbody>
              </STable>
            </div>
          )}

          <div className="muted" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.7 }}>
            <b>판정 기준</b> — '설치' 는 <b>마지막 배포 기록</b>으로만 판단합니다(24대를 매번 SSH 로 확인하면 화면이 수 분 멈추므로).
            확실히 보려면 위 목록의 '상태 확인'을 쓰세요. 매칭은 접속 URL(host:port)이 먼저이고, 없으면 수집 서버 id 로 찾습니다.
            <br /><b>토큰 불일치란</b> — 수집 서버(<code>collectors.json</code>)와 배포 대상(<code>agent-deploy-targets.json</code>)에 저장된 토큰이 다르다는 뜻일 뿐,
            <b>지금 수집이 끊겼다는 뜻은 아닙니다</b>. 수집 서버 화면에서 토큰을 재발급·강제 동기화하면 중앙과 엣지만 갱신되고 배포 대상 기록은 낡은 채로 남습니다.
            진짜 위험은 <b>그 대상을 재배포할 때 낡은 값이 엣지를 덮어써 수집이 끊기는 것</b>입니다. 어느 쪽이 살아있는지는 <b>🔍 진단</b>으로 실제 측정하세요.
            <br /><b>정직한 한계</b> — 여기서 만든 토큰은 중앙에만 저장됩니다. '엣지에 반영'을 켜지 않으면 엣지의 <code>COLLECTOR_TOKEN</code> 은 그대로라
            연결 확인이 403 으로 나옵니다(다음 배포 때 자동으로 맞춰집니다). '설치' 는 마지막 배포 기록으로만 판단합니다.
          </div>
        </>
      )}
    </div>
  );
}
