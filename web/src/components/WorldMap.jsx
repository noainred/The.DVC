import React, { useState } from 'react';
import { ComposableMap, Geographies, Geography, Marker } from 'react-simple-maps';
import geoData from 'world-atlas/countries-110m.json';

/** Marker color/size driven by the worst alarm state at a site. */
function markerStyle(site) {
  const m = site.metrics || {};
  if (site.status !== 'connected') return { fill: '#ef4444', r: 7, ring: '#ef4444' };
  if (m.alarmsCritical > 0) return { fill: '#ef4444', r: 6, ring: '#ef4444' };
  if (m.alarmsWarning > 0) return { fill: '#f59e0b', r: 6, ring: '#f59e0b' };
  return { fill: '#22c55e', r: 5, ring: '#22c55e' };
}

export default function WorldMap({ sites = [], onSelect }) {
  const [tip, setTip] = useState(null);

  return (
    <div className="card map-wrap" style={{ padding: 8 }}>
      <ComposableMap
        projection="geoEqualEarth"
        // Rotate the projection so Korea (~127°E, 37°N) sits at screen center.
        projectionConfig={{ scale: 175, center: [0, 12], rotate: [-127, 0, 0] }}
        style={{ width: '100%', height: 'auto' }}
        height={420}
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
              onMouseMove={(e) => setTip((t) => (t ? { ...t, x: e.clientX, y: e.clientY } : t))}
              onMouseLeave={() => setTip(null)}
              onClick={() => onSelect?.(s.id)}
              style={{ default: { cursor: 'pointer' } }}
            >
              <circle r={st.r + 5} fill={st.ring} opacity={0.18}>
                <animate attributeName="r" from={st.r + 3} to={st.r + 11} dur="2.2s" repeatCount="indefinite" />
                <animate attributeName="opacity" from="0.35" to="0" dur="2.2s" repeatCount="indefinite" />
              </circle>
              <circle r={st.r} fill={st.fill} stroke="#0a0e17" strokeWidth={1.2} />
            </Marker>
          );
        })}
      </ComposableMap>

      <div className="map-legend">
        <span className="legend-item"><span className="dot" style={{ background: '#22c55e' }} /> 정상</span>
        <span className="legend-item"><span className="dot" style={{ background: '#f59e0b' }} /> 경고</span>
        <span className="legend-item"><span className="dot" style={{ background: '#ef4444' }} /> 위험/연결끊김</span>
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
    </div>
  );
}
