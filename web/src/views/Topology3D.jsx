import React, { useEffect, useRef, useState } from 'react';
import { fetchJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';

// 노드 종류별 색.
const COLOR = {
  central: '#3b82f6',
  agent: '#22c55e',
  vcenter: (s) => (s === 'connected' ? '#38bdf8' : s === 'unreachable' ? '#ef4444' : '#64748b'),
  nsx: '#a855f7',
  host: (s) => (s === 'CONNECTED' ? '#cbd5e1' : s === 'MAINTENANCE' ? '#f59e0b' : s === 'DISCONNECTED' ? '#ef4444' : '#94a3b8'),
  vm: (s) => (s === 'on' ? '#eab308' : '#475569'),
};
const nodeColor = (n) => { const c = COLOR[n.type]; return typeof c === 'function' ? c(n.status) : (c || '#94a3b8'); };
const LEGEND = [['central', '중앙 포탈', '#3b82f6'], ['agent', '엣지 포탈(에이전트)', '#22c55e'], ['vcenter', 'vCenter', '#38bdf8'], ['nsx', 'NSX', '#a855f7'], ['host', 'ESXi 호스트', '#cbd5e1'], ['vm', 'VM', '#eab308']];

/** 설정된 구성을 3D 네트워크로 — 줌인/아웃(휠)·회전(드래그)·노드 클릭 포커스. */
export default function Topology3D() {
  const wrapRef = useRef(null);
  const graphRef = useRef(null);
  const [error, setError] = useState(null);
  const [counts, setCounts] = useState(null);
  const [showVms, setShowVms] = useState(false);
  const [loading, setLoading] = useState(true);

  // 그래프 생성(1회) + 데이터 로드.
  useEffect(() => {
    let destroyed = false;
    let Graph = null;
    (async () => {
      try {
        const { default: ForceGraph3D } = await import('3d-force-graph');
        if (destroyed || !wrapRef.current) return;
        Graph = ForceGraph3D()(wrapRef.current)
          .backgroundColor('#0b1220')
          .nodeLabel((n) => `<div style="font:12px system-ui;color:#e2e8f0;background:#1e293b;padding:4px 8px;border-radius:6px;border:1px solid #334155">${n.label}${n.region ? ` · ${n.region}` : ''}${n.cpu != null ? ` · CPU ${n.cpu}%` : ''}${n.gpus ? ` · GPU ${n.gpus}` : ''}</div>`)
          .nodeColor(nodeColor)
          .nodeVal((n) => n.val || 4)
          .nodeOpacity(0.95)
          .nodeResolution(12)
          .linkColor((l) => (l.kind === 'token' ? '#22c55e' : l.kind === 'direct' ? '#f59e0b' : l.kind === 'nsx' ? '#a855f7' : '#334155'))
          .linkWidth((l) => (l.kind === 'token' ? 1.4 : 0.6))
          .linkDirectionalParticles((l) => (l.kind === 'token' || l.kind === 'collect' ? 2 : 0))
          .linkDirectionalParticleSpeed(0.006)
          .linkOpacity(0.5)
          .onNodeClick((node) => {
            const d = Math.hypot(node.x, node.y, node.z) || 1;
            const r = 1 + 60 / d;
            Graph.cameraPosition({ x: node.x * r, y: node.y * r, z: node.z * r }, node, 800);
          })
          .onNodeDragEnd((node) => { node.fx = node.x; node.fy = node.y; node.fz = node.z; });
        graphRef.current = Graph;
        const resize = () => { if (wrapRef.current) { Graph.width(wrapRef.current.clientWidth); Graph.height(wrapRef.current.clientHeight); } };
        resize();
        window.addEventListener('resize', resize);
        Graph.__resize = resize;
        await load();
      } catch (e) { if (!destroyed) setError(e.message); }
    })();
    return () => {
      destroyed = true;
      try { if (Graph?.__resize) window.removeEventListener('resize', Graph.__resize); Graph?._destructor?.(); } catch { /* */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = async (vms = showVms) => {
    setLoading(true); setError(null);
    try {
      const d = await fetchJson(`/insights/graph${vms ? '?vms=1' : ''}`);
      setCounts(d.counts);
      if (graphRef.current) {
        graphRef.current.graphData({ nodes: d.nodes, links: d.links });
        setTimeout(() => graphRef.current?.zoomToFit?.(600, 40), 400);
      }
    } catch (e) { setError(e.message); }
    setLoading(false);
  };

  const zoom = (factor) => {
    const G = graphRef.current; if (!G) return;
    const c = G.cameraPosition();
    G.cameraPosition({ x: c.x * factor, y: c.y * factor, z: c.z * factor }, undefined, 300);
  };
  const toggleVms = () => { const next = !showVms; setShowVms(next); load(next); };

  return (
    <div>
      <div className="flex between wrap gap" style={{ alignItems: 'center', marginBottom: 8 }}>
        <div className="muted" style={{ fontSize: 13 }}>
          설정된 구성을 3D 네트워크로 표시 — <b>휠=줌</b>, <b>드래그=회전</b>, 노드 클릭=포커스.
          {counts && <span style={{ marginLeft: 8 }}>중앙 1 · 엣지 {counts.agents} · vCenter {counts.vcenters} · NSX {counts.nsx} · 호스트 {counts.hosts}{showVms ? ` · VM ${counts.vms}` : ''}</span>}
        </div>
        <div className="flex gap" style={{ flex: 'none' }}>
          <button className="logout-btn" style={{ padding: '6px 11px' }} onClick={() => zoom(0.75)} title="줌인">＋</button>
          <button className="logout-btn" style={{ padding: '6px 11px' }} onClick={() => zoom(1.33)} title="줌아웃">－</button>
          <button className="logout-btn" style={{ padding: '6px 11px' }} onClick={() => graphRef.current?.zoomToFit?.(600, 40)} title="전체 맞춤">⤢ 맞춤</button>
          <button className={showVms ? 'login-btn' : 'logout-btn'} style={{ padding: '6px 11px' }} onClick={toggleVms} title="VM 노드 표시(상한 1500)">{showVms ? 'VM 표시중' : 'VM 표시'}</button>
          <button className="logout-btn" style={{ padding: '6px 11px' }} onClick={() => load()} title="새로고침">⟳</button>
        </div>
      </div>
      {error && <ErrorBox message={error} />}
      <div style={{ position: 'relative', width: '100%', height: '72vh', borderRadius: 12, overflow: 'hidden', border: '1px solid var(--border,#1e293b)', background: '#0b1220' }}>
        <div ref={wrapRef} style={{ width: '100%', height: '100%' }} />
        {loading && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}><Loading /></div>}
        <div style={{ position: 'absolute', left: 12, bottom: 12, background: 'rgba(15,23,42,.8)', border: '1px solid #1e293b', borderRadius: 8, padding: '8px 10px', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {LEGEND.map(([k, l, c]) => <span key={k} style={{ fontSize: 11, color: '#cbd5e1', display: 'flex', alignItems: 'center', gap: 5 }}><span style={{ width: 10, height: 10, borderRadius: '50%', background: c, display: 'inline-block' }} />{l}</span>)}
        </div>
      </div>
      <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>초록 링크=중앙⇄에이전트(토큰 push) · 주황=중앙 직접수집 · 보라=NSX. 데이터는 라이브 스냅샷+등록된 구성 기반입니다.</div>
    </div>
  );
}
