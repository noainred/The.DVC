import React, { useEffect, useRef, useState } from 'react';
import { ComposableMap, Geographies, Geography, Marker } from 'react-simple-maps';
import geoData from 'world-atlas/countries-110m.json';
import { Modal } from './ui.jsx';

/** Marker color/size driven by the worst alarm state at a site. */
function markerStyle(site) {
  const m = site.metrics || {};
  // 점검중/비활성은 장애가 아니므로 빨강이 아닌 회색/주황으로 구분.
  if (site.status === 'maintenance') return { fill: '#f59e0b', r: 6, ring: '#f59e0b' };
  if (site.status === 'disabled') return { fill: '#6b7280', r: 5, ring: '#6b7280' };
  if (site.status !== 'connected') return { fill: '#ef4444', r: 7, ring: '#ef4444' };
  if (m.alarmsCritical > 0) return { fill: '#ef4444', r: 6, ring: '#ef4444' };
  if (m.alarmsWarning > 0) return { fill: '#f59e0b', r: 6, ring: '#f59e0b' };
  return { fill: '#22c55e', r: 5, ring: '#22c55e' };
}

export default function WorldMap({ sites = [], onSelect, height = 420, onResizeEnd, lambda: lambda0 = -127, offsetY: offsetY0 = 0, onViewEnd }) {
  const [tip, setTip] = useState(null);
  const [picked, setPicked] = useState(null); // vCenter clicked on the map
  const [h, setH] = useState(height);
  useEffect(() => { setH(height); }, [height]);

  // Horizontal drag rotates the projection's center longitude. Because the
  // rotation is modular (360°), dragging keeps scrolling around the globe
  // forever: 아시아 → 미국 → 유럽 → 다시 아시아. Start centered on Asia/Korea.
  const [lambda, setLambda] = useState(lambda0);
  const [offsetY, setOffsetY] = useState(offsetY0); // vertical pan, in SVG units
  const drag = useRef(null);
  const moved = useRef(false);
  const wrapRef = useRef(null);
  // 서버에서 저장된 뷰가 (마운트 이후) 도착하면 드래그 중이 아닐 때 한 번 반영.
  useEffect(() => { if (!drag.current) setLambda(lambda0); }, [lambda0]);
  useEffect(() => { if (!drag.current) setOffsetY(offsetY0); }, [offsetY0]);

  const clamp = (v) => Math.max(240, Math.min(1200, v));
  const changeHeight = (delta) => { const nh = clamp(h + delta); setH(nh); onResizeEnd?.(nh); };

  // ComposableMap renders an 800-wide viewBox scaled to 100% width; convert a
  // screen-pixel delta into SVG units so vertical panning tracks the cursor.
  const svgFactor = () => {
    const w = wrapRef.current?.getBoundingClientRect().width || 800;
    return 800 / w;
  };

  const onPointerDown = (e) => {
    drag.current = { x: e.clientX, y: e.clientY, lambda, offsetY };
    moved.current = false;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e) => {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.x;
    const dy = e.clientY - drag.current.y;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved.current = true;
    // ~0.32°/px; drag left → 동쪽(아시아→미국), drag right → 서쪽
    setLambda(drag.current.lambda + dx * 0.32);
    // vertical pan, clamped so the map can't be dragged completely out of view
    const lim = h * 0.55;
    const ny = drag.current.offsetY + dy * svgFactor();
    setOffsetY(Math.max(-lim, Math.min(lim, ny)));
  };
  const endDrag = (e) => {
    if (drag.current) {
      e.currentTarget?.releasePointerCapture?.(e.pointerId);
      if (moved.current) onViewEnd?.({ lambda, offsetY }); // 드래그 종료 시 위치 저장(공유)
    }
    drag.current = null;
  };

  // 같은/비슷한 지역에 여러 사이트가 있으면 마커가 겹친다. 격자 반올림은 경계에 걸친 근접 사이트를
  // 놓치므로, '실제 근접 거리(경위도 유클리드)'로 군집화한다(단일연결 그리디). 군집 내 마커를 원형으로
  // 분산(offset)해 겹치지 않게 한다.
  const spread = (() => {
    const pts = [];
    for (const s of sites) {
      const loc = s.location || {};
      if (loc.lon == null || loc.lat == null) continue;
      pts.push({ id: s.id, lon: Number(loc.lon), lat: Number(loc.lat) });
    }
    const THRESH = 4; // 도(°) 이내면 같은 지역으로 묶음(≈ 수백 km, '비슷한 지역')
    // union-find로 THRESH 이내 쌍을 모두 병합 → 배열 순서와 무관하게 전이적으로 같은 군집으로
    // 묶는다(A–C, C–B가 가까우면 A·B도 같은 군집). 이전 단일연결 방식은 순서에 따라 겹치는
    // 마커가 다른 군집으로 남아 분산이 안 되던 문제가 있었다.
    const parent = new Map(pts.map((p) => [p.id, p.id]));
    const find = (x) => { let r = x; while (parent.get(r) !== r) r = parent.get(r); while (parent.get(x) !== r) { const nx = parent.get(x); parent.set(x, r); x = nx; } return r; };
    const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(ra, rb); };
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        if (Math.hypot(pts[i].lon - pts[j].lon, pts[i].lat - pts[j].lat) <= THRESH) union(pts[i].id, pts[j].id);
      }
    }
    const cid = new Map();
    for (const p of pts) cid.set(p.id, find(p.id)); // 군집 키 = 대표(root) id
    const byC = new Map();
    for (const p of pts) { const c = cid.get(p.id); if (!byC.has(c)) byC.set(c, []); byC.get(c).push(p.id); }
    const m = new Map();
    for (const ids of byC.values()) ids.forEach((id, i) => m.set(id, { idx: i, total: ids.length }));
    return m;
  })();
  const offsetOf = (id) => {
    const c = spread.get(id);
    if (!c || c.total <= 1) return [0, 0];
    // 겹침만 살짝 풀 정도로 최소한만 분산(너무 멀어지지 않게 반경을 작게).
    const R = 9 + c.total * 1.5;
    const ang = (c.idx / c.total) * Math.PI * 2 - Math.PI / 2; // 위쪽(12시)부터 시계방향
    return [Math.cos(ang) * R, Math.sin(ang) * R];
  };

  return (
    <div className="card map-wrap" style={{ padding: 8 }}>
      {/* map height controls (saved server-side, shared by all users) */}
      <div className="map-size-ctrl">
        <button onClick={() => changeHeight(-60)} title="지도 축소" disabled={h <= 240}>−</button>
        <span className="map-size-val">{Math.round(h)}px</span>
        <button onClick={() => changeHeight(60)} title="지도 확대" disabled={h >= 1200}>+</button>
      </div>
      <div ref={wrapRef} style={{ overflow: 'hidden', borderRadius: 8 }}>
      <ComposableMap
        projection="geoEqualEarth"
        projectionConfig={{ scale: 175, rotate: [lambda, 0, 0] }}
        style={{ width: '100%', height: 'auto', cursor: drag.current ? 'grabbing' : 'grab', touchAction: 'none' }}
        height={h}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
      >
        <g transform={`translate(0, ${offsetY})`}>
        <Geographies geography={geoData}>
          {({ geographies }) =>
            geographies.map((geo) => (
              <Geography
                key={geo.rsmKey}
                geography={geo}
                style={{
                  default: { fill: '#1a2236', stroke: '#243049', strokeWidth: 0.4, outline: 'none' },
                  hover: { fill: '#222d45', outline: 'none' },
                  pressed: { fill: '#222d45', outline: 'none' },
                }}
              />
            ))
          }
        </Geographies>

        {sites.map((s) => {
          const loc = s.location || {};
          if (loc.lon == null || loc.lat == null) return null;
          const st = markerStyle(s);
          const [dx, dy] = offsetOf(s.id);
          const clustered = dx !== 0 || dy !== 0;
          return (
            <Marker
              key={s.id}
              coordinates={[loc.lon, loc.lat]}
              onMouseEnter={(e) => setTip({ x: e.clientX, y: e.clientY, site: s })}
              onMouseMove={(e) => setTip({ x: e.clientX, y: e.clientY, site: s })}
              onMouseLeave={() => setTip(null)}
              onClick={() => { if (!moved.current) { setTip(null); setPicked(s); } }}
            >
              {/* 겹침 방지: 같은 지역 군집이면 원위치에서 이동해 마커만 깔끔히 분산(연결선/점 없음). */}
              <g transform={clustered ? `translate(${dx}, ${dy})` : undefined}>
                {/* decorative pulse + marker — ignore pointer events so hover is stable */}
                <circle r={st.r + 5} fill={st.ring} opacity={0.18} style={{ pointerEvents: 'none' }}>
                  <animate attributeName="r" from={st.r + 3} to={st.r + 11} dur="2.2s" repeatCount="indefinite" />
                  <animate attributeName="opacity" from="0.35" to="0" dur="2.2s" repeatCount="indefinite" />
                </circle>
                <circle r={st.r} fill={st.fill} stroke="#0a0e17" strokeWidth={1.2} style={{ pointerEvents: 'none' }} />
                {/* larger transparent hit area so hovering (not clicking) reliably shows info */}
                <circle r={15} fill="transparent" style={{ cursor: 'pointer' }} />
              </g>
            </Marker>
          );
        })}
        </g>
      </ComposableMap>
      </div>

      <div className="map-legend">
        <span className="legend-item"><span className="dot" style={{ background: '#22c55e' }} /> 정상</span>
        <span className="legend-item"><span className="dot" style={{ background: '#f59e0b' }} /> 경고</span>
        <span className="legend-item"><span className="dot" style={{ background: '#ef4444' }} /> 위험/연결끊김</span>
        <span className="legend-item muted" style={{ marginLeft: 'auto' }}>드래그: ←→ 지구 무한 회전 · ↑↓ 상하 이동</span>
      </div>

      {tip && (
        <div className="tooltip" style={{ left: tip.x + 14, top: tip.y + 14 }}>
          <div className="t-title">{tip.site.name}</div>
          <div className="t-row"><span>위치</span><b>{tip.site.location?.city}, {tip.site.location?.country}</b></div>
          <div className="t-row"><span>상태</span><b>{tip.site.status}</b></div>
          <div className="t-row"><span>호스트</span><b>{tip.site.metrics?.hosts ?? '-'}</b></div>
          <div className="t-row"><span>VM</span><b>{tip.site.metrics?.vms ?? '-'} ({tip.site.metrics?.vmsPoweredOn ?? 0} on)</b></div>
          <div className="t-row"><span>CPU</span><b>{tip.site.metrics?.cpuUsagePct ?? '-'}%</b></div>
          <div className="t-row"><span>메모리</span><b>{tip.site.metrics?.memUsagePct ?? '-'}%</b></div>
          <div className="t-row"><span>스토리지</span><b>{tip.site.metrics?.storageUsagePct ?? '-'}%</b></div>
          {(tip.site.metrics?.alarmsCritical > 0 || tip.site.metrics?.alarmsWarning > 0) && (
            <div className="t-row"><span>알람</span><b>{tip.site.metrics?.alarmsCritical || 0} 위험 / {tip.site.metrics?.alarmsWarning || 0} 경고</b></div>
          )}
        </div>
      )}

      {picked && (() => {
        const m = picked.metrics || {};
        const row = (label, value) => (
          <div className="flex between" style={{ padding: '8px 0', borderBottom: '1px solid rgba(36,48,73,.4)', gap: 16 }}>
            <span className="muted">{label}</span>
            <span style={{ textAlign: 'right' }}>{value}</span>
          </div>
        );
        return (
          <Modal title={`vCenter — ${picked.name}`} onClose={() => setPicked(null)} width={520}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 24px' }}>
              {row('ID', picked.id)}
              {row('상태', <b style={{ color: picked.status === 'connected' ? 'var(--green)' : 'var(--red)' }}>{picked.status}</b>)}
              {row('위치', `${picked.location?.city || '-'}, ${picked.location?.country || '-'}`)}
              {row('리전', picked.location?.region || '-')}
              {row('버전', picked.version || '-')}
              {row('호스트', m.hosts ?? '-')}
              {row('VM', `${m.vms ?? '-'} (${m.vmsPoweredOn ?? 0} on)`)}
              {row('CPU 사용률', `${m.cpuUsagePct ?? '-'}%`)}
              {row('메모리 사용률', `${m.memUsagePct ?? '-'}%`)}
              {row('스토리지 사용률', `${m.storageUsagePct ?? '-'}%`)}
              {m.powerKw > 0 && row('소비전력', `${m.powerKw} kW`)}
              {row('알람', `위험 ${m.alarmsCritical || 0} · 경고 ${m.alarmsWarning || 0}`)}
            </div>
            <div className="flex" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
              <button className="login-btn" style={{ flex: 'none', padding: '9px 16px' }} onClick={() => { onSelect?.(picked.id); setPicked(null); }}>
                이 vCenter 자원 보기 →
              </button>
            </div>
          </Modal>
        );
      })()}
    </div>
  );
}
