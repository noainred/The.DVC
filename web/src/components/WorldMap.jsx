import React, { useEffect, useRef, useState } from 'react';
import { ComposableMap, Geographies, Geography, Marker } from 'react-simple-maps';
import geoData from 'world-atlas/countries-110m.json';
import { Modal } from './ui.jsx';

/** Marker color/size driven by the worst alarm state at a site. */
function markerStyle(site) {
  const m = site.metrics || {};
  if (site.status !== 'connected') return { fill: '#ef4444', r: 7, ring: '#ef4444' };
  if (m.alarmsCritical > 0) return { fill: '#ef4444', r: 6, ring: '#ef4444' };
  if (m.alarmsWarning > 0) return { fill: '#f59e0b', r: 6, ring: '#f59e0b' };
  return { fill: '#22c55e', r: 5, ring: '#22c55e' };
}

export default function WorldMap({ sites = [], onSelect, height = 420, onResizeEnd }) {
  const [tip, setTip] = useState(null);
  const [picked, setPicked] = useState(null); // vCenter clicked on the map
  const [h, setH] = useState(height);
  useEffect(() => { setH(height); }, [height]);

  // Horizontal drag rotates the projection's center longitude. Because the
  // rotation is modular (360°), dragging keeps scrolling around the globe
  // forever: 아시아 → 미국 → 유럽 → 다시 아시아. Start centered on Asia/Korea.
  const [lambda, setLambda] = useState(-127);
  const drag = useRef(null);
  const moved = useRef(false);

  const clamp = (v) => Math.max(240, Math.min(1200, v));
  const changeHeight = (delta) => { const nh = clamp(h + delta); setH(nh); onResizeEnd?.(nh); };

  const onPointerDown = (e) => {
    // ignore drags that start on a marker (let the marker handle click/hover)
    drag.current = { x: e.clientX, lambda };
    moved.current = false;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e) => {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.x;
    if (Math.abs(dx) > 2) moved.current = true;
    // ~0.32°/px; drag left → 동쪽(아시아→미국), drag right → 서쪽
    setLambda(drag.current.lambda + dx * 0.32);
  };
  const endDrag = (e) => {
    if (drag.current) e.currentTarget?.releasePointerCapture?.(e.pointerId);
    drag.current = null;
  };

  return (
    <div className="card map-wrap" style={{ padding: 8 }}>
      {/* map height controls (saved server-side, shared by all users) */}
      <div className="map-size-ctrl">
        <button onClick={() => changeHeight(-60)} title="지도 축소" disabled={h <= 240}>−</button>
        <span className="map-size-val">{Math.round(h)}px</span>
        <button onClick={() => changeHeight(60)} title="지도 확대" disabled={h >= 1200}>+</button>
      </div>
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
          return (
            <Marker
              key={s.id}
              coordinates={[loc.lon, loc.lat]}
              onMouseEnter={(e) => setTip({ x: e.clientX, y: e.clientY, site: s })}
              onMouseMove={(e) => setTip({ x: e.clientX, y: e.clientY, site: s })}
              onMouseLeave={() => setTip(null)}
              onClick={() => { if (!moved.current) { setTip(null); setPicked(s); } }}
            >
              {/* decorative pulse + marker — ignore pointer events so hover is stable */}
              <circle r={st.r + 5} fill={st.ring} opacity={0.18} style={{ pointerEvents: 'none' }}>
                <animate attributeName="r" from={st.r + 3} to={st.r + 11} dur="2.2s" repeatCount="indefinite" />
                <animate attributeName="opacity" from="0.35" to="0" dur="2.2s" repeatCount="indefinite" />
              </circle>
              <circle r={st.r} fill={st.fill} stroke="#0a0e17" strokeWidth={1.2} style={{ pointerEvents: 'none' }} />
              {/* larger transparent hit area so hovering (not clicking) reliably shows info */}
              <circle r={15} fill="transparent" style={{ cursor: 'pointer' }} />
            </Marker>
          );
        })}
      </ComposableMap>

      <div className="map-legend">
        <span className="legend-item"><span className="dot" style={{ background: '#22c55e' }} /> 정상</span>
        <span className="legend-item"><span className="dot" style={{ background: '#f59e0b' }} /> 경고</span>
        <span className="legend-item"><span className="dot" style={{ background: '#ef4444' }} /> 위험/연결끊김</span>
        <span className="legend-item muted" style={{ marginLeft: 'auto' }}>← 드래그하면 지구가 계속 돌아갑니다 →</span>
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
