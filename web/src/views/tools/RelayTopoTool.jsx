import React, { useEffect, useRef, useState } from 'react';
import { useHashTab } from '../../hooks/useHashTab.js';
import { fetchJson, postJson, putJson, downloadFile } from '../../api.js';
import { agoText } from './relTime.js';
import { Loading, ErrorBox, Kpi, Modal } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { buildGraph, frame3d, COLORS } from './relayTopoLayout.js';
import { topologyPayload, servicesDroppedText } from './relayTopoForm.js'; // v2.606 WEB2606-10: 빈 포트 칸 · 버린 서비스 행
import { relaySecretsDroppedText } from '../droppedSecretText.js'; // v2.607 WEB2607-03

/**
 * 중계 토폴로지(HAProxy 구성) 도구(v2.431, 사용자 요구 '첨부한 표처럼 Main-Edge1-Edge2 구조의 접속이 필요한 서비스(ssh/vcsa/portal 등)를
 * 입력하면 각각을 haproxy 로 구성하고 점검' + 'main/edge 서버 정보를 입력하면 정보를 가져와 표로 구성하고 오류 점검' +
 * 'import/export csv/json' + '노드 입력 시 ip/id/pw/키' + '입력 완료 후 화려한 2D/3D 그래픽').
 * 탭: 구성 입력(표·서비스·노드 SSH·가져오기/내보내기) → 점검·HAProxy(SSH 로 실제 구성 가져오기·대조·관리 블록 적용) → 토폴로지 그래픽(2D SVG / 3D 캔버스).
 */
const EMPTY_SSH = { port: 22, username: '', password: '', privateKey: '', passphrase: '' };
const EMPTY_NODE = { privateIp: '', publicIp: '', vcenterIp: '', ssh: { ...EMPTY_SSH } };
const EMPTY_SITE = { dc: '', edge: { ...EMPTY_NODE }, irs: { ...EMPTY_NODE, ssh: { ...EMPTY_SSH } }, sshTargetId: '', note: '' };
const STATUS = { ok: ['정상', 'green'], missing: ['블록 없음', 'red'], 'wrong-backend': ['백엔드 불일치', 'red'], 'self-loop': ['자기 자신(self-loop)', 'red'], 'no-listener': ['리스너 없음', 'amber'], 'unknown-backend': ['server 없음', 'red'], timeout: ['timeout 짧음', 'amber'] };
const LEVEL = { error: ['오류', 'red'], warn: ['경고', 'amber'], info: ['참고', 'blue'] };
// v2.613 DEPS2613-11: 상대시각은 공용 코어 relTime.agoText 하나다(로컬 ago 사본 제거).
const sshSummary = (ssh) => { if (!ssh) return '—'; const has = ssh.hasPassword || ssh.password ? '비밀번호' : ssh.hasPrivateKey || ssh.privateKey ? '키' : ''; return ssh.username ? `${ssh.username}@:${ssh.port || 22}${has ? ` (${has})` : ' (비밀 없음)'}` : '—'; };

export default function RelayTopoTool() {
  // ⚠ 훅은 전부 조기 return 위에(React #310 회귀 방지).
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null);
  // 하위 탭을 URL 에 실어 새로고침·북마크·뒤로가기에서 유지한다(v2.438, hooks/useHashTab.js).
  const [tab, setTab] = useHashTab({ base: ['tools', 'relaytopo'], valid: ['config', 'check', 'graph'], fallback: 'config' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [edit, setEdit] = useState(null);          // 사이트 편집 모달 { site, index|-1 }
  const [importText, setImportText] = useState('');
  const [importReplace, setImportReplace] = useState(false);
  const [preview, setPreview] = useState(null);
  const [results, setResults] = useState({});      // dc → fetch 결과
  const [renderText, setRenderText] = useState(null); // { dc, text, missing }
  const [applyRes, setApplyRes] = useState(null);
  const [testRes, setTestRes] = useState(null);
  const [graphMode, setGraphMode] = useState('3d');
  const [autoRotate, setAutoRotate] = useState(true);
  const [pick, setPick] = useState(null);          // 그래픽에서 고른 노드
  const canvasRef = useRef(null);
  const camRef = useRef({ rotY: 0.6, rotX: 0.5, scale: 1 });
  const dragRef = useRef(null);

  const load = async () => {
    try { const d = await fetchJson('/tools/relaytopo'); setData(d); setForm((f) => f || d.topology); setResults(d.results || {}); setError(null); }
    catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, []);

  // 3D 캔버스 애니메이션 — 라이브러리 없이 원근 투영 + 패킷 애니메이션(relayTopoLayout 순수 계산)
  useEffect(() => {
    if (tab !== 'graph' || graphMode !== '3d' || !form) return undefined;
    const cv = canvasRef.current; if (!cv) return undefined;
    const ctx = cv.getContext('2d');
    const graph = buildGraph(form, results);
    let raf = 0; const t0 = performance.now();
    const draw = (now) => {
      const t = (now - t0) / 1000;
      if (autoRotate && !dragRef.current) camRef.current.rotY += 0.0035;
      const dpr = window.devicePixelRatio || 1; const w = cv.clientWidth, h = cv.clientHeight;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const bg = ctx.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, Math.max(w, h) * 0.8); bg.addColorStop(0, '#0f1a2e'); bg.addColorStop(1, '#05080f');
      ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
      const cam = { rotY: camRef.current.rotY, rotX: camRef.current.rotX, dist: 7, scale: Math.min(w, h) * 0.13 * camRef.current.scale, cx: w / 2, cy: h / 2 + 20 };
      // 바닥 링(Edge 원·IRS 원) — 공간감
      const { project } = { project: (p) => frame3d({ nodes: [{ id: 'p', p3: p }], links: [] }, cam, 0).nodes[0] };
      for (const [r, y, col] of [[2.2, 0.1, 'rgba(167,139,250,.25)'], [3.19, -1.2, 'rgba(45,212,191,.22)']]) {
        ctx.beginPath();
        for (let i = 0; i <= 72; i++) { const a = (i / 72) * Math.PI * 2; const p = project([Math.cos(a) * r, y, Math.sin(a) * r]); if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); }
        ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.stroke();
      }
      const f = frame3d(graph, cam, t * 0.35);
      for (const l of f.links) {
        const col = COLORS[l.status] || COLORS.unknown;
        ctx.beginPath(); ctx.moveTo(l.x1, l.y1); ctx.lineTo(l.x2, l.y2);
        ctx.strokeStyle = l.kind === 'hq' ? 'rgba(96,165,250,.35)' : `${col}66`; ctx.lineWidth = l.kind === 'vcenter' ? 1 : 1.6; ctx.setLineDash(l.dashed ? [6, 6] : []); ctx.stroke(); ctx.setLineDash([]);
        // 패킷
        ctx.beginPath(); ctx.arc(l.px, l.py, 3, 0, Math.PI * 2); ctx.fillStyle = l.kind === 'hq' ? COLORS.main : col; ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 12; ctx.fill(); ctx.shadowBlur = 0;
      }
      for (const n of f.nodes) {
        const r = (n.kind === 'main' ? 22 : n.small ? 9 : 15) * n.f;
        const sc = COLORS[n.status] || COLORS.unknown;
        ctx.beginPath(); ctx.arc(n.x, n.y, r + 6, 0, Math.PI * 2); ctx.fillStyle = `${n.kind === 'main' ? COLORS.main : sc}22`; ctx.fill();
        ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        const g = ctx.createRadialGradient(n.x - r * 0.3, n.y - r * 0.3, 1, n.x, n.y, r); g.addColorStop(0, '#ffffff'); g.addColorStop(0.25, n.color); g.addColorStop(1, `${n.color}88`);
        ctx.fillStyle = g; ctx.shadowColor = n.kind === 'main' ? COLORS.main : sc; ctx.shadowBlur = 18; ctx.fill(); ctx.shadowBlur = 0;
        ctx.lineWidth = 2; ctx.strokeStyle = n.kind === 'main' ? COLORS.main : sc; ctx.stroke();
        ctx.fillStyle = '#e5edf7'; ctx.font = `${n.kind === 'main' ? 'bold 13px' : n.small ? '10px' : '12px'} system-ui, sans-serif`; ctx.textAlign = 'center';
        ctx.fillText(n.label, n.x, n.y + r + 14); ctx.fillStyle = '#9fb0c8'; ctx.font = '10px monospace'; ctx.fillText(n.sub, n.x, n.y + r + 26);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [tab, graphMode, form, results, autoRotate]);

  if (error && !data) return <ErrorBox message={error} />;
  if (!data || !form) return <Loading />;

  const setMain = (k, v) => setForm((p) => ({ ...p, main: { ...p.main, [k]: v } }));
  const setMainSsh = (k, v) => setForm((p) => ({ ...p, main: { ...p.main, ssh: { ...(p.main.ssh || EMPTY_SSH), [k]: v } } }));
  const setSvc = (i, k, v) => setForm((p) => ({ ...p, services: p.services.map((s, j) => (j === i ? { ...s, [k]: v } : s)) }));
  const run = async (label, fn) => { setBusy(true); setMsg(null); try { const r = await fn(); if (r && r.ok === false && r.reason) setMsg(`${label} 실패: ${r.reason}`); return r; } catch (e) { setMsg(`${label} 실패: ${e.message}`); return null; } finally { setBusy(false); } };
  const save = () => run('저장', async () => { const r = await putJson('/tools/relaytopo', topologyPayload(form)); if (r.ok) { setForm(r.topology); const dropTxt = servicesDroppedText(r); const secTxt = relaySecretsDroppedText(r); setMsg(`저장되었습니다 — 사이트 ${r.topology.sites.length} · 서비스 ${r.topology.services.length} · 점검 ${r.issues.length}건${dropTxt ? ` · ⚠ ${dropTxt}` : ''}${secTxt ? ` · ⚠ ${secTxt}` : ''}`); await load(); } return r; });
  const importPreview = () => run('가져오기 미리보기', async () => { const r = await postJson('/tools/relaytopo/import', { text: importText, replace: importReplace }); if (r.ok) setPreview(r); return r; });
  const importApply = () => run('가져오기 적용', async () => { const r = await postJson('/tools/relaytopo/import', { text: importText, replace: importReplace, apply: true }); if (r.ok) { setForm(r.topology); setPreview(null); setImportText(''); { const dropTxt = servicesDroppedText(r); const secTxt = relaySecretsDroppedText(r); setMsg(`가져오기 완료 — 사이트 ${r.parsedSites}개 인식(건너뜀 ${r.skipped.length}). 저장됨.${dropTxt ? ` ⚠ ${dropTxt}` : ''}${secTxt ? ` ⚠ ${secTxt}` : ''}`); } await load(); } return r; });
  const onFile = (e) => { const f = e.target.files?.[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => setImportText(String(rd.result || '')); rd.readAsText(f); e.target.value = ''; };
  const exportAs = (fmt) => run('내보내기', () => downloadFile(`/tools/relaytopo/export?format=${fmt}`));
  const fetchOne = (dc) => run(`${dc} 가져오기`, async () => { const r = await postJson(`/tools/relaytopo/fetch/${encodeURIComponent(dc)}`, {}); if (r.ok) { setResults((p) => ({ ...p, [dc]: r })); setMsg(r.edge.ok ? `${dc}: 서비스 ${r.summary.total}개 대조 — 문제 ${r.summary.bad}건${r.irs ? (r.irs.ok ? ' · IRS 확인됨' : ` · IRS 접속 실패(${r.irs.error})`) : ''}` : `${dc}: Edge 접속 실패 — ${r.edge.error}`); } return r; });
  const fetchAllSites = () => run('전체 가져오기', async () => { const r = await postJson('/tools/relaytopo/fetch', {}); if (r.ok) { const m = {}; for (const x of r.results) if (x.dc) m[x.dc] = x; setResults((p) => ({ ...p, ...m })); setMsg(`전체 가져오기 완료 — Edge 접속 ${r.results.filter((x) => x.ok && x.edge?.ok).length}/${r.results.length} 사이트 · 문제 ${r.results.reduce((a, x) => a + (x.summary?.bad || 0), 0)}건`); } return r; });
  const renderOne = (dc) => run('미리보기', async () => { const r = await fetchJson(`/tools/relaytopo/render/${encodeURIComponent(dc)}`); if (r.ok) setRenderText(r); return r; });
  const applyOne = (dc, dryRun) => {
    if (!dryRun && !window.confirm(`${dc} 중계 엣지의 /etc/haproxy/haproxy.cfg 관리 블록을 교체하고 haproxy 를 reload 합니다(백업 생성·검증 실패 시 원본 유지·reload 실패 시 롤백). 계속할까요?`)) return null;
    return run(dryRun ? '검증' : '적용', async () => { const r = await postJson(`/tools/relaytopo/apply/${encodeURIComponent(dc)}`, { dryRun, confirm: !dryRun }); setApplyRes(r); if (r.applied) { setMsg(`${dc}: 적용 완료 — 리스너 ${(r.listeners || []).join(', ')}`); fetchOne(dc); } else if (r.unchanged) setMsg(`${dc}: 변경 없음(관리 블록이 이미 같음)`); else if (r.dryRun) setMsg(`${dc}: 검증 통과(파일 미변경)`); return r; });
  };
  const testSsh = (dc, role) => run('SSH 테스트', async () => { const r = await postJson('/tools/relaytopo/test-ssh', { dc, role }); setTestRes({ dc, role, ...r }); return r; });
  const removeSite = (i) => { if (!window.confirm(`사이트 '${form.sites[i].dc}' 를 표에서 제거할까요? (저장을 눌러야 반영)`)) return; setForm((p) => ({ ...p, sites: p.sites.filter((_, j) => j !== i) })); };
  const saveEdit = () => {
    const s = edit.site; if (!s.dc.trim()) { setMsg('DC(사이트) 이름은 필수입니다.'); return; }
    setForm((p) => ({ ...p, sites: edit.index < 0 ? [...p.sites, s] : p.sites.map((x, j) => (j === edit.index ? s : x)) })); setEdit(null);
  };
  const issues = data.issues || [];
  const badSites = Object.values(results).filter((r) => r.ok && r.summary?.bad).length;
  const graph = buildGraph(form, results);

  return (
    <div>
      <div className="card" style={{ marginBottom: 12, fontSize: 13, lineHeight: 1.7 }}>
        <b>무엇을 하나</b> — 구성도(Main → Edge DVC(HAProxy) → IRS)를 표로 입력하면 ① 표 자체의 오류(중복 IP · Edge=IRS · 수집 서버 누락)를 즉시 점검하고,
        ② 사이트마다 필요한 서비스(IRS 포탈 4068 · IRS SSH 4067 · IRS vCenter 4066 · Edge vCenter 4065 · HQ 4001 …)를 <b>HAProxy 관리 블록</b>으로 생성해 중계 엣지에 검증(<code>haproxy -c</code>) 후 적용하며,
        ③ 각 노드에 SSH 로 들어가 실제 <code>haproxy.cfg</code>·서비스 상태·리스너·<code>portal.env</code> 를 가져와 기대값과 대조해 오류와 해결책을 표로 보여줍니다. 입력한 사이트는 'HAProxy 경로 점검' 주기 점검 대상에도 자동 포함됩니다.
        <div className="muted" style={{ marginTop: 4 }}>정직한 한계: SSH 자격증명(노드에 입력한 ID/비밀번호/키 또는 배포 대상)이 있는 노드만 가져오기/적용이 됩니다. IRS 는 중앙에서 직접 닿지 않으므로 중계 엣지의 SSH 서비스 포트(기본 :4067)를 경유합니다. 적용은 관리 블록(# BEGIN/END vmware-portal-relay)만 바꾸며 그 밖의 haproxy.cfg 내용은 손대지 않습니다. 비밀은 봉인 저장되고 어떤 응답·내보내기에도 포함되지 않습니다.</div>
      </div>

      {data?.addressHidden && (
        <div className="card" style={{ marginBottom: 12, fontSize: 13, borderColor: 'var(--amber)' }}>
          관리자 계정이 아니라서 <b>주소·SSH 계정명을 가렸습니다</b>(사설·공인 IP · vCenter IP). 구성·서비스 목록만 보입니다.
          표 점검 결과는 문구에 주소가 들어 있어 개수만 알립니다 — {data.issueCount || 0}건. 저장·가져오기·적용은 관리자만 할 수 있습니다.
        </div>
      )}
      <div className="kpis" style={{ marginBottom: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
        <Kpi label="사이트" value={form.sites.length} meta={`IRS 있는 사이트 ${form.sites.filter((s) => s.irs?.privateIp || s.irs?.publicIp || s.irs?.present).length}`} />
        <Kpi label="서비스" value={form.services.filter((s) => s.enabled !== false).length} meta={form.services.filter((s) => s.enabled !== false).map((s) => s.listenPort).join(' · ')} />
        {data?.addressHidden
          ? <Kpi label="표 점검" value="—" meta={`관리자만 상세 확인 · ${data.issueCount || 0}건`} />
          : <Kpi label="표 점검" value={issues.filter((i) => i.level === 'error').length} meta={`오류 · 경고 ${issues.filter((i) => i.level === 'warn').length}`} accent={issues.some((i) => i.level === 'error') ? 'var(--red)' : 'var(--green)'} />}
        <Kpi label="가져온 사이트" value={Object.values(results).filter((r) => r.ok && r.edge?.ok).length} meta={badSites ? `문제 ${badSites} 사이트` : Object.keys(results).length ? '문제 없음' : '아직 없음'} accent={badSites ? 'var(--amber)' : undefined} />
      </div>

      <div className="flex gap" style={{ marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        {[['config', '① 구성 입력'], ['check', '② 점검 · HAProxy'], ['graph', '③ 토폴로지 그래픽']].map(([k, l]) => <button key={k} className={`tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>{l}</button>)}
        <span style={{ flex: 1 }} />
        {msg && <span className="muted" style={{ fontSize: 12 }}>{msg}</span>}
      </div>

      {tab === 'config' && (
        <>
          {issues.length > 0 && (
            <div className="card" style={{ marginBottom: 12 }}>
              <b>표 점검 결과</b> <span className="muted" style={{ fontSize: 12 }}>(저장된 토폴로지 기준 · SSH 없이 표만 보고 판정)</span>
              {/* ⚠ minWidth 필수(v2.576 실측): '내용'·'해결책' 이 문장이라 400px 에서 이 표와
                  아래 서비스 표가 함께 페이지를 **613px** 밀어냈다. */}
              <STable minWidth={640} style={{ marginTop: 6, fontSize: 12 }}>
                <thead><tr><th>수준</th><th>사이트</th><th>내용</th><th>해결책</th></tr></thead>
                <tbody>{issues.map((i, k) => <tr key={k}><td><span className={`badge ${LEVEL[i.level]?.[1] || 'gray'}`}>{LEVEL[i.level]?.[0] || i.level}</span></td><td>{i.dc || '—'}</td><td>{i.text}</td><td className="muted">{i.fix || '—'}</td></tr>)}</tbody>
              </STable>
            </div>
          )}

          <div className="card" style={{ marginBottom: 12 }}>
            <b>Main(중앙) 포탈</b>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginTop: 8, fontSize: 12 }}>
              <label>이름<input className="input" value={form.main.name || ''} onChange={(e) => setMain('name', e.target.value)} /></label>
              <label>private IP<input className="input" value={form.main.privateIp || ''} onChange={(e) => setMain('privateIp', e.target.value)} placeholder="192.168.20.143" /></label>
              <label>public IP<input className="input" value={form.main.publicIp || ''} onChange={(e) => setMain('publicIp', e.target.value)} placeholder="10.94.40.217" /></label>
              <label>포탈 포트<input className="input" type="number" value={form.main.portalPort ?? ''} onChange={(e) => setMain('portalPort', e.target.value)} /></label>
              <label>SSH ID<input className="input" value={form.main.ssh?.username || ''} onChange={(e) => setMainSsh('username', e.target.value)} placeholder="root" /></label>
              <label>SSH 포트<input className="input" type="number" value={form.main.ssh?.port ?? ''} onChange={(e) => setMainSsh('port', e.target.value)} /></label>
              <label>SSH 비밀번호 {form.main.ssh?.hasPassword ? '(저장됨 · 비우면 유지)' : ''}<input className="input" type="password" value={form.main.ssh?.password || ''} onChange={(e) => setMainSsh('password', e.target.value)} autoComplete="new-password" /></label>
            </div>
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>HQ 서비스(:4001)의 백엔드는 public IP 우선, 없으면 private IP:포탈 포트입니다. Main SSH 는 선택(가져오기 시 중앙 자신의 상태 확인용).</div>
          </div>

          <div className="card" style={{ marginBottom: 12 }}>
            <div className="flex gap wrap" style={{ alignItems: 'center' }}>
              <b>서비스(중계 엣지 HAProxy listen 포트 → 백엔드)</b><span style={{ flex: 1 }} />
              <button className="tab" onClick={() => setForm((p) => ({ ...p, services: [...p.services, { key: '', label: '', listenPort: '', target: 'irs', targetPort: '', mode: 'tcp', enabled: true }] }))}>+ 서비스 추가</button>
              <button className="tab" onClick={() => setForm((p) => ({ ...p, services: data.defaultServices.map((s) => ({ ...s })) }))}>기본값 복원</button>
            </div>
            <STable minWidth={900} style={{ marginTop: 6, fontSize: 12 }}>
              <thead><tr><th>사용</th><th>키</th><th>표시명</th><th>listen 포트</th><th>대상</th><th>대상 포트</th><th>mode</th><th data-nosort>삭제</th></tr></thead>
              <tbody>{form.services.map((s, i) => (
                <tr key={i}>
                  <td><input type="checkbox" checked={s.enabled !== false} onChange={(e) => setSvc(i, 'enabled', e.target.checked)} /></td>
                  <td><input className="input" style={{ minWidth: 90, width: 100 }} value={s.key} onChange={(e) => setSvc(i, 'key', e.target.value)} placeholder="portal" /></td>
                  <td><input className="input" style={{ minWidth: 100, width: 130 }} value={s.label || ''} onChange={(e) => setSvc(i, 'label', e.target.value)} /></td>
                  <td><input className="input" type="number" style={{ minWidth: 80, width: 90 }} value={s.listenPort ?? ''} onChange={(e) => setSvc(i, 'listenPort', e.target.value)} /></td>
                  <td><select className="input" style={{ minWidth: 150 }} value={s.target} onChange={(e) => setSvc(i, 'target', e.target.value)}>{Object.entries(data.targets).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></td>
                  <td><input className="input" type="number" style={{ minWidth: 80, width: 90 }} value={s.targetPort ?? ''} onChange={(e) => setSvc(i, 'targetPort', e.target.value)} /></td>
                  <td><select className="input" style={{ minWidth: 70 }} value={s.mode} onChange={(e) => setSvc(i, 'mode', e.target.value)}><option value="tcp">tcp</option><option value="http">http</option></select></td>
                  <td><button className="tab" onClick={() => setForm((p) => ({ ...p, services: p.services.filter((_, j) => j !== i) }))}>삭제</button></td>
                </tr>))}</tbody>
            </STable>
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>대상: IRS 서버=IRS 의 포탈(4000)/SSH(22) 등 · IRS 사이트 vCenter=IRS 행의 vCenter IP · Edge 사이트 vCenter=Edge 행의 vCenter IP · 중앙(Main)=IRS 가 중앙으로 갈 때 지나는 HQ 문. 키는 소문자/숫자/하이픈, listen 포트는 사이트 공통.</div>
          </div>

          <div className="card" style={{ marginBottom: 12 }}>
            <div className="flex gap" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
              <b>사이트(DC) — Edge DVC · IRS</b><span style={{ flex: 1 }} />
              <button className="tab" onClick={() => setEdit({ site: structuredClone(EMPTY_SITE), index: -1 })}>+ 사이트 추가</button>
              <button className="tab" onClick={() => exportAs('json')} disabled={busy}>⬇ JSON</button>
              <button className="tab" onClick={() => exportAs('csv')} disabled={busy}>⬇ CSV</button>
              <button className="login-btn" style={{ flex: 'none', padding: '6px 16px' }} onClick={save} disabled={busy}>저장</button>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <STable style={{ marginTop: 6, fontSize: 12 }}>
                <thead><tr><th>DC</th><th>Edge private</th><th>Edge public</th><th>Edge vCenter</th><th>Edge SSH</th><th>IRS private</th><th>IRS public</th><th>IRS vCenter</th><th>IRS SSH</th><th>접속 경로</th><th>비고</th><th data-nosort>작업</th></tr></thead>
                <tbody>{form.sites.map((s, i) => { const acc = data.access?.[s.dc]; return (
                  <tr key={s.dc || i}>
                    <td><b>{s.dc}</b></td>
                    <td>{s.edge?.privateIp || '—'}</td><td>{s.edge?.publicIp || '—'}</td><td>{s.edge?.vcenterIp || '—'}</td>
                    <td>{sshSummary(s.edge?.ssh)}{acc?.edge?.source?.startsWith('deploy:') ? <span className="badge blue" style={{ marginLeft: 4 }}>배포 대상</span> : null}</td>
                    <td>{s.irs?.privateIp || '—'}</td><td>{s.irs?.publicIp || '—'}</td><td>{s.irs?.vcenterIp || '—'}</td>
                    <td>{sshSummary(s.irs?.ssh)}</td>
                    <td className="muted" style={{ fontSize: 11 }}>{acc ? <>Edge {acc.edge.host}:{acc.edge.port}{acc.edge.error ? <span className="badge amber" style={{ marginLeft: 4 }} title={acc.edge.error}>자격증명 없음</span> : ''}<br />IRS {acc.irs.host ? `${acc.irs.host}:${acc.irs.port}` : '—'}{acc.irs.via ? ` (${acc.irs.via})` : ''}</> : '(저장 후 표시)'}</td>
                    <td className="muted">{s.note || ''}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="tab" onClick={() => setEdit({ site: structuredClone({ ...EMPTY_SITE, ...s, edge: { ...EMPTY_NODE, ...s.edge, ssh: { ...EMPTY_SSH, ...s.edge?.ssh } }, irs: { ...EMPTY_NODE, ...s.irs, ssh: { ...EMPTY_SSH, ...s.irs?.ssh } } }), index: i })}>편집</button>
                      <button className="tab" onClick={() => testSsh(s.dc, 'edge')} disabled={busy || !acc}>Edge SSH</button>
                      <button className="tab" onClick={() => testSsh(s.dc, 'irs')} disabled={busy || !acc || !(s.irs?.privateIp || s.irs?.publicIp)}>IRS SSH</button>
                      <button className="tab" onClick={() => removeSite(i)}>삭제</button>
                    </td>
                  </tr>); })}</tbody>
              </STable>
            </div>
            {form.sites.length === 0 && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>사이트가 없습니다 — '+ 사이트 추가' 또는 아래 '표 붙여넣기 / 파일 가져오기'로 입력하세요.</div>}
            {testRes && (
              <div className="card" style={{ marginTop: 8, fontSize: 12, background: 'var(--panel-2)' }}>
                <b>SSH 테스트 — {testRes.dc || 'Main'} {testRes.role}</b> → {testRes.host}:{testRes.port} {testRes.via ? `(${testRes.via})` : ''} · 자격증명 {testRes.source || '없음'} ·
                {testRes.ok ? <span className="badge green" style={{ marginLeft: 4 }}>성공 {testRes.ms}ms</span> : <span className="badge red" style={{ marginLeft: 4 }}>실패</span>} {testRes.reason || testRes.detail}
                {testRes.trace?.length > 0 && <pre style={{ fontSize: 11, maxHeight: 160, overflow: 'auto', marginTop: 4 }}>{testRes.trace.map((x) => `${new Date(x.at).toLocaleTimeString()} ${x.m}`).join('\n')}</pre>}
                <button className="tab" style={{ marginTop: 4 }} onClick={() => setTestRes(null)}>닫기</button>
              </div>
            )}
          </div>

          <div className="card" style={{ marginBottom: 12 }}>
            <b>가져오기 — 표 붙여넣기 / CSV·JSON 파일</b>
            <div className="muted" style={{ fontSize: 12, margin: '4px 0 6px' }}>
              스프레드시트(첨부 표)를 그대로 붙여넣으세요: 열 순서 <code>Datacenter · Server(Main/Edge/IRS) · private IP · public IP …</code>, IRS 행의 DC 가 비어 있으면 직전 DC 로 이어집니다. 이 도구가 내보낸 CSV/JSON 도 같은 자리에서 읽습니다(머리글로 자동 판별). 같은 DC 는 IP 를 갱신하되 저장된 SSH 비밀은 유지합니다.
            </div>
            <textarea className="input" rows={7} style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }} value={importText} onChange={(e) => setImportText(e.target.value)} placeholder={'OC2\tMain\t192.168.20.143\t10.94.40.217\nAZ\tEdge\t192.168.30.221\t10.112.158.217\n\tIRS\t192.168.31.11\t10.112.159.11'} />
            <div className="flex gap" style={{ alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
              <input type="file" accept=".csv,.tsv,.txt,.json" onChange={onFile} style={{ fontSize: 12 }} />
              <label className="flex gap" style={{ alignItems: 'center', fontSize: 12 }}><input type="checkbox" checked={importReplace} onChange={(e) => setImportReplace(e.target.checked)} />기존 사이트 목록 교체(병합 대신)</label>
              <span style={{ flex: 1 }} />
              <button className="tab" onClick={importPreview} disabled={busy || !importText.trim()}>미리보기</button>
              <button className="login-btn" style={{ flex: 'none', padding: '6px 16px' }} onClick={importApply} disabled={busy || !importText.trim()}>가져와서 저장</button>
            </div>
            {preview && (
              <div style={{ marginTop: 8, fontSize: 12 }}>
                <b>미리보기</b> — 형식 {preview.format} · 인식 사이트 {preview.parsedSites} · 저장 후 사이트 {preview.preview.sites.length} · 건너뜀 {preview.skipped.length}줄 · 점검 {preview.issues.length}건
                <STable style={{ marginTop: 4 }}>
                  <thead><tr><th>DC</th><th>Edge private</th><th>Edge public</th><th>IRS private</th><th>IRS public</th></tr></thead>
                  <tbody>{preview.preview.sites.map((s) => <tr key={s.dc}><td>{s.dc}</td><td>{s.edge.privateIp || '—'}</td><td>{s.edge.publicIp || '—'}</td><td>{s.irs.privateIp || '—'}</td><td>{s.irs.publicIp || '—'}</td></tr>)}</tbody>
                </STable>
                {preview.skipped.length > 0 && <pre className="muted" style={{ fontSize: 11, maxHeight: 100, overflow: 'auto' }}>{'건너뜀:\n' + preview.skipped.join('\n')}</pre>}
              </div>
            )}
          </div>
        </>
      )}

      {tab === 'check' && (
        <>
          <div className="card" style={{ marginBottom: 12 }}>
            <div className="flex gap" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
              <b>실제 구성 가져오기(SSH) · HAProxy 관리 블록</b>
              <span className="muted" style={{ fontSize: 12 }}>사이트별로 Edge(+IRS)에 접속해 haproxy.cfg · 서비스 상태 · 리스너 · portal.env 를 읽고 기대값과 대조합니다. 노드당 타임아웃 45초, 동시 4개.</span>
              <span style={{ flex: 1 }} />
              <button className="login-btn" style={{ flex: 'none', padding: '6px 16px' }} onClick={fetchAllSites} disabled={busy || !form.sites.length}>전체 가져오기</button>
            </div>
          </div>
          {form.sites.map((s) => { const r = results[s.dc]; return (
            <div className="card" key={s.dc} style={{ marginBottom: 12 }}>
              <div className="flex gap" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
                <b style={{ fontSize: 15 }}>{s.dc}</b>
                <span className="muted" style={{ fontSize: 12 }}>Edge {s.edge?.publicIp || s.edge?.privateIp || '—'} · IRS {s.irs?.privateIp || s.irs?.publicIp || (s.irs?.present ? '있음(주소 가림)' : '없음')}</span>
                {r?.ok && <span className={`badge ${r.summary.edgeFailed ? 'red' : r.summary.bad ? 'amber' : 'green'}`}>{r.summary.edgeFailed ? 'Edge 접속 실패' : r.summary.bad ? `문제 ${r.summary.bad}건` : '모두 정상'}</span>}
                {r && !r.ok && <span className="badge red">{r.reason}</span>}
                {r && <span className="muted" style={{ fontSize: 11 }}>{agoText(r.at)}</span>}
                <span style={{ flex: 1 }} />
                <button className="tab" onClick={() => fetchOne(s.dc)} disabled={busy}>가져오기</button>
                <button className="tab" onClick={() => renderOne(s.dc)} disabled={busy}>HAProxy 미리보기</button>
                <button className="tab" onClick={() => applyOne(s.dc, true)} disabled={busy}>검증(모의)</button>
                <button className="tab" style={{ color: '#fbbf24' }} onClick={() => applyOne(s.dc, false)} disabled={busy}>적용</button>
              </div>
              {r?.ok && (
                <>
                  <STable minWidth={880} style={{ marginTop: 8, fontSize: 12 }}>
                    <thead><tr><th>노드</th><th>접속</th><th>호스트명</th><th>IP</th><th>HAProxy</th><th>리스너</th><th>포탈 유닛</th><th>portal.env</th></tr></thead>
                    <tbody>{[r.edge, r.irs].filter(Boolean).map((n) => (
                      <tr key={n.role}>
                        <td><b>{n.role === 'edge' ? 'Edge' : 'IRS'}</b></td>
                        <td className="muted" style={{ fontSize: 11 }}>{n.host}:{n.port}{n.via ? <><br />{n.via}</> : ''}<br />{n.ok ? <span className="badge green">접속 {n.ms}ms</span> : <span className="badge red" title={n.error}>실패</span>}{!n.ok && <div style={{ color: 'var(--red)' }}>{n.error}</div>}</td>
                        <td>{n.node?.hostname || '—'}</td>
                        <td style={{ fontSize: 11 }}>{(n.node?.ips || []).join(' ') || '—'}</td>
                        <td>{n.ok ? (n.haproxy.installed ? <>{n.haproxy.version}<br /><span className={`badge ${n.haproxy.active ? 'green' : 'red'}`}>{n.haproxy.activeText}</span>{n.haproxy.enabled ? '' : <span className="badge amber" style={{ marginLeft: 3 }}>부팅 자동시작 아님</span>}</> : <span className="muted">미설치</span>) : '—'}</td>
                        <td style={{ fontSize: 11 }}>{(n.listeners || []).join(', ') || '—'}</td>
                        <td style={{ fontSize: 11 }}>{(n.portal?.units || []).map((u) => <div key={u.unit}>{u.unit} <span className={`badge ${u.active === 'active' ? 'green' : 'gray'}`}>{u.sub || u.active}</span></div>)}</td>
                        <td><pre style={{ fontSize: 10, margin: 0, maxWidth: 260, whiteSpace: 'pre-wrap' }}>{(n.portal?.env || []).join('\n') || '—'}</pre></td>
                      </tr>))}</tbody>
                  </STable>
                  {r.edge.ok && (
                    <STable minWidth={880} style={{ marginTop: 8, fontSize: 12 }}>
                      <thead><tr><th>서비스</th><th>listen</th><th>기대 백엔드</th><th>실제 백엔드</th><th>mode</th><th>상태</th><th>문제</th><th>해결</th></tr></thead>
                      <tbody>{r.rows.map((x) => <tr key={x.key}>
                        <td><b>{x.label}</b> <span className="muted">{x.key}</span></td><td>{x.listenPort || '—'}</td>
                        <td>{x.expected ? `${x.expected.host}:${x.expected.port}` : '—'}</td><td>{x.actual ? `${x.actual.host}:${x.actual.port}` : '—'}</td><td>{x.mode || '—'}</td>
                        <td><span className={`badge ${STATUS[x.status]?.[1] || 'gray'}`}>{STATUS[x.status]?.[0] || x.status}</span></td>
                        <td>{x.issue || '—'}</td><td className="muted">{x.fix || '—'}</td>
                      </tr>)}</tbody>
                    </STable>
                  )}
                  {r.irsIssues?.length > 0 && <ul style={{ fontSize: 12, marginTop: 8 }}>{r.irsIssues.map((i, k) => <li key={k}><span className={`badge ${LEVEL[i.level]?.[1]}`}>{LEVEL[i.level]?.[0]}</span> {i.text} <span className="muted">— {i.fix}</span></li>)}</ul>}
                  {r.maskedAddress && r.irsIssueCount > 0 && <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>IRS 점검 {r.irsIssueCount}건 — 문구에 주소가 들어 있어 관리자만 확인할 수 있습니다.</div>}
                  {r.edge.ok && r.edge.haproxy?.hasCfg && <details style={{ marginTop: 6 }}><summary className="muted" style={{ fontSize: 12, cursor: 'pointer' }}>현재 haproxy.cfg 전문</summary><pre style={{ fontSize: 11, maxHeight: 320, overflow: 'auto' }}>{r.edge.haproxy.cfg}</pre></details>}
                </>
              )}
              {r?.ok && !r.edge.ok && <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 6 }}>Edge 접속 실패: {r.edge.error}</div>}
              {!r && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>아직 가져오지 않았습니다.</div>}
            </div>); })}
          {renderText && (
            <Modal title={`HAProxy 관리 블록 미리보기 — ${renderText.dc}`} onClose={() => setRenderText(null)} width={760}>
              {renderText.missing.length > 0 && <div style={{ color: 'var(--amber)', fontSize: 12, marginBottom: 6 }}>백엔드 IP 미입력으로 건너뛴 서비스: {renderText.missing.join(', ')}</div>}
              <pre style={{ fontSize: 12, maxHeight: 480, overflow: 'auto' }}>{renderText.text}</pre>
              <div className="muted" style={{ fontSize: 11 }}>이 블록을 중계 엣지 /etc/haproxy/haproxy.cfg 의 # BEGIN/END vmware-portal-relay 자리에 넣습니다(없으면 끝에 추가). 그 밖의 내용(global/defaults/기존 listen)은 그대로 둡니다.</div>
            </Modal>
          )}
          {applyRes && (
            <Modal title={`HAProxy ${applyRes.dryRun ? '검증' : '적용'} 결과 — ${applyRes.dc}`} onClose={() => setApplyRes(null)} width={760}>
              <div style={{ marginBottom: 6 }}>{applyRes.ok ? <span className="badge green">성공</span> : <span className="badge red">실패</span>} {applyRes.reason || ''} {applyRes.applied ? `· 백업 ${applyRes.backup}` : applyRes.unchanged ? '· 변경 없음' : ''}</div>
              <STable style={{ fontSize: 12 }}>
                <thead><tr><th>단계</th><th>결과</th><th>내용</th></tr></thead>
                <tbody>{(applyRes.steps || []).map((s, i) => <tr key={i}><td>{s.name}</td><td><span className={`badge ${s.ok ? 'green' : 'red'}`}>{s.ok ? 'OK' : '실패'}</span></td><td><pre style={{ fontSize: 11, margin: 0, whiteSpace: 'pre-wrap' }}>{s.detail}</pre></td></tr>)}</tbody>
              </STable>
              {applyRes.merged && <details style={{ marginTop: 6 }}><summary className="muted" style={{ fontSize: 12, cursor: 'pointer' }}>적용(예정) 전문</summary><pre style={{ fontSize: 11, maxHeight: 320, overflow: 'auto' }}>{applyRes.merged}</pre></details>}
            </Modal>
          )}
        </>
      )}

      {tab === 'graph' && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="flex gap" style={{ alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
            <button className={`tab${graphMode === '2d' ? ' active' : ''}`} onClick={() => setGraphMode('2d')}>2D 구성도</button>
            <button className={`tab${graphMode === '3d' ? ' active' : ''}`} onClick={() => setGraphMode('3d')}>3D 뷰</button>
            {graphMode === '3d' && <label className="flex gap" style={{ alignItems: 'center', fontSize: 12 }}><input type="checkbox" checked={autoRotate} onChange={(e) => setAutoRotate(e.target.checked)} />자동 회전 <span className="muted">(드래그 회전 · 휠 확대)</span></label>}
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 11 }} className="muted">색: <span style={{ color: COLORS.ok }}>■ 정상</span> <span style={{ color: COLORS.warn }}>■ 문제 있음</span> <span style={{ color: COLORS.bad }}>■ 접속 실패</span> <span style={{ color: COLORS.unknown }}>■ 미점검</span> · 노드: <span style={{ color: COLORS.main }}>● Main</span> <span style={{ color: COLORS.edge }}>● Edge</span> <span style={{ color: COLORS.irs }}>● IRS</span> <span style={{ color: COLORS.vc }}>● vCenter</span></span>
          </div>
          {graphMode === '3d' ? (
            <canvas ref={canvasRef} style={{ width: '100%', height: 560, borderRadius: 10, cursor: dragRef.current ? 'grabbing' : 'grab', display: 'block' }}
              onMouseDown={(e) => { dragRef.current = { x: e.clientX, y: e.clientY }; }}
              onMouseMove={(e) => { if (!dragRef.current) return; camRef.current.rotY += (e.clientX - dragRef.current.x) * 0.008; camRef.current.rotX = Math.max(-1.2, Math.min(1.4, camRef.current.rotX + (e.clientY - dragRef.current.y) * 0.006)); dragRef.current = { x: e.clientX, y: e.clientY }; }}
              onMouseUp={() => { dragRef.current = null; }} onMouseLeave={() => { dragRef.current = null; }}
              onWheel={(e) => { camRef.current.scale = Math.max(0.4, Math.min(3, camRef.current.scale * (e.deltaY > 0 ? 0.92 : 1.08))); }} />
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <svg viewBox={`0 0 ${graph.width} ${graph.height}`} style={{ width: '100%', minWidth: 700, background: 'linear-gradient(180deg,#0f1a2e,#05080f)', borderRadius: 10 }}>
                <defs>
                  <filter id="rt-glow"><feGaussianBlur stdDeviation="3" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
                  <style>{'@keyframes rt-dash{to{stroke-dashoffset:-24}} .rt-link{stroke-dasharray:8 6;animation:rt-dash 1.2s linear infinite}'}</style>
                </defs>
                {graph.links.map((l) => { const a = graph.nodes.find((n) => n.id === l.from), b = graph.nodes.find((n) => n.id === l.to); if (!a || !b) return null; const col = l.kind === 'hq' ? COLORS.main : COLORS[l.status]; const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2; return (
                  <g key={l.id}>
                    <line className="rt-link" x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={col} strokeWidth={l.kind === 'vcenter' ? 1.2 : 2} opacity={l.kind === 'hq' ? 0.45 : 0.85} />
                    {l.label && <text x={mx + (l.kind === 'hq' ? -40 : 6)} y={my + (l.kind === 'ssh' ? 12 : l.kind === 'portal' && a.kind === 'edge' ? -4 : 4)} fill="#cbd5e1" fontSize="10" fontFamily="monospace">{l.label}</text>}
                  </g>); })}
                {graph.nodes.map((n) => { const sc = n.kind === 'main' ? COLORS.main : COLORS[n.status]; const w = n.kind === 'main' ? 150 : n.small ? 92 : 124, h = n.small ? 30 : 42; return (
                  <g key={n.id} transform={`translate(${n.x - w / 2},${n.y - h / 2})`} style={{ cursor: 'pointer' }} onClick={() => setPick(n)}>
                    <rect width={w} height={h} rx={10} fill="#111c31" stroke={sc} strokeWidth={pick?.id === n.id ? 3 : 1.6} filter="url(#rt-glow)" />
                    <circle cx={14} cy={h / 2} r={5} fill={n.color} />
                    <text x={26} y={n.small ? 13 : 17} fill="#e5edf7" fontSize={n.small ? 10 : 12} fontWeight="600">{n.label}</text>
                    <text x={26} y={n.small ? 24 : 32} fill="#9fb0c8" fontSize="10" fontFamily="monospace">{n.sub}</text>
                  </g>); })}
              </svg>
            </div>
          )}
          {pick && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>선택: <b>{pick.label}</b> {pick.sub} {pick.dc ? <>· 상태 <span className={`badge ${pick.status === 'ok' ? 'green' : pick.status === 'warn' ? 'amber' : pick.status === 'bad' ? 'red' : 'gray'}`}>{pick.status}</span> <button className="tab" onClick={() => { setTab('check'); }}>점검 탭으로</button></> : null}</div>}
          <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>선은 중계 엣지의 listen 포트 → 백엔드 포트를 뜻합니다(점선은 IRS → 중계 엣지 HQ 포트 → 중앙). 색은 '점검' 탭에서 가져온 결과 기준이며, 가져오기 전에는 회색(미점검)입니다.</div>
        </div>
      )}

      {edit && (
        <Modal title={edit.index < 0 ? '사이트 추가' : `사이트 편집 — ${edit.site.dc}`} onClose={() => setEdit(null)} width={860}>
          <SiteForm site={edit.site} onChange={(s) => setEdit({ ...edit, site: s })} deployTargets={data.deployTargets || []} />
          <div className="flex gap" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
            <button className="tab" onClick={() => setEdit(null)}>취소</button>
            <button className="login-btn" style={{ flex: 'none', padding: '6px 16px' }} onClick={saveEdit}>확인(표에 반영 → 저장 필요)</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function NodeFields({ title, node, onChange, hint }) {
  const set = (k, v) => onChange({ ...node, [k]: v });
  const setSsh = (k, v) => onChange({ ...node, ssh: { ...(node.ssh || EMPTY_SSH), [k]: v } });
  const ssh = node.ssh || EMPTY_SSH;
  return (
    <div className="card" style={{ background: 'var(--panel-2)', marginTop: 8 }}>
      <b>{title}</b> <span className="muted" style={{ fontSize: 11 }}>{hint}</span>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8, marginTop: 6, fontSize: 12 }}>
        <label>private IP<input className="input" style={{ minWidth: 0, width: '100%' }} value={node.privateIp || ''} onChange={(e) => set('privateIp', e.target.value)} /></label>
        <label>public IP<input className="input" style={{ minWidth: 0, width: '100%' }} value={node.publicIp || ''} onChange={(e) => set('publicIp', e.target.value)} /></label>
        <label>vCenter IP<input className="input" style={{ minWidth: 0, width: '100%' }} value={node.vcenterIp || ''} onChange={(e) => set('vcenterIp', e.target.value)} /></label>
        <label>SSH ID<input className="input" style={{ minWidth: 0, width: '100%' }} value={ssh.username || ''} onChange={(e) => setSsh('username', e.target.value)} placeholder="root" autoComplete="off" /></label>
        <label>SSH 포트<input className="input" type="number" style={{ minWidth: 0, width: '100%' }} value={ssh.port ?? ''} onChange={(e) => setSsh('port', e.target.value)} /></label>
        <label>비밀번호 {ssh.hasPassword ? <span className="badge green">저장됨</span> : ''}<input className="input" type="password" style={{ minWidth: 0, width: '100%' }} value={ssh.password || ''} onChange={(e) => setSsh('password', e.target.value)} placeholder={ssh.hasPassword ? '비우면 기존 유지' : ''} autoComplete="new-password" />
          {ssh.hasPassword && <label style={{ fontSize: 11 }}><input type="checkbox" checked={!!ssh.clearPassword} onChange={(e) => setSsh('clearPassword', e.target.checked)} /> 저장된 비밀번호 삭제</label>}</label>
      </div>
      <label style={{ fontSize: 12, display: 'block', marginTop: 6 }}>SSH 개인키(PEM/OpenSSH) {ssh.hasPrivateKey ? <span className="badge green">저장됨 · 비우면 유지</span> : '(선택 — 비밀번호 대신)'}
        <textarea className="input" rows={3} style={{ width: '100%', fontFamily: 'monospace', fontSize: 11 }} value={ssh.privateKey || ''} onChange={(e) => setSsh('privateKey', e.target.value)} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
      </label>
      <div className="flex gap" style={{ alignItems: 'center', fontSize: 12 }}>
        <label>키 패스프레이즈 {ssh.hasPassphrase ? '(저장됨)' : ''}<input className="input" type="password" value={ssh.passphrase || ''} onChange={(e) => setSsh('passphrase', e.target.value)} autoComplete="new-password" /></label>
        {ssh.hasPrivateKey && <label style={{ fontSize: 11 }}><input type="checkbox" checked={!!ssh.clearPrivateKey} onChange={(e) => setSsh('clearPrivateKey', e.target.checked)} /> 저장된 키 삭제</label>}
      </div>
    </div>
  );
}

function SiteForm({ site, onChange, deployTargets }) {
  const set = (k, v) => onChange({ ...site, [k]: v });
  return (
    <div style={{ fontSize: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr 2fr', gap: 8 }}>
        <label>DC(사이트) *<input className="input" style={{ minWidth: 0, width: '100%' }} value={site.dc} onChange={(e) => set('dc', e.target.value)} placeholder="AZ" /></label>
        <label>배포 대상(SSH 자격증명 폴백)<select className="input" style={{ minWidth: 0, width: '100%' }} value={site.sshTargetId || ''} onChange={(e) => set('sshTargetId', e.target.value)}><option value="">(같은 IP 의 배포 대상 자동)</option>{deployTargets.map((t) => <option key={t.id} value={t.id}>{t.host} ({t.username}) — {t.id}</option>)}</select></label>
        <label>비고<input className="input" style={{ minWidth: 0, width: '100%' }} value={site.note || ''} onChange={(e) => set('note', e.target.value)} /></label>
      </div>
      <NodeFields title="Edge DVC(중계 엣지 · HAProxy)" node={site.edge} onChange={(n) => set('edge', n)} hint="중앙이 접속하는 주소는 public IP 우선. SSH 는 root 또는 passwordless sudo(haproxy.cfg 교체·reload)." />
      <NodeFields title="IRS(Edge 뒤 사이트)" node={site.irs} onChange={(n) => set('irs', n)} hint="중앙에서 직접 닿지 않으므로 SSH 는 중계 엣지의 IRS SSH 서비스 포트(기본 :4067)를 경유합니다. private IP 가 HAProxy 백엔드가 됩니다." />
    </div>
  );
}
