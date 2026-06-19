import React, { useEffect, useState } from 'react';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts';
import { fetchJson } from '../api.js';

const tipStyle = { background: '#0c1322', border: '1px solid #243049', borderRadius: 8, color: '#e6edf6', fontSize: 12 };
const itemStyle = { color: '#e6edf6' };
const labelStyle = { color: '#8b9bb4' };

/**
 * Shows real Dell iDRAC power for one ESXi host: current draw + recent history.
 * Renders a helpful hint when the host isn't mapped to a registered iDRAC.
 */
export default function HostPowerPanel({ hostName }) {
  const [state, setState] = useState({ loading: true });

  useEffect(() => {
    let active = true;
    setState({ loading: true });
    fetchJson('/idrac/host-power', { name: hostName, hours: 24 })
      .then((d) => { if (active) setState({ loading: false, data: d }); })
      .catch((e) => { if (active) setState({ loading: false, error: e.message }); });
    return () => { active = false; };
  }, [hostName]);

  const { loading, data, error } = state;

  return (
    <div style={{ marginTop: 16, borderTop: '1px solid rgba(36,48,73,.6)', paddingTop: 12 }}>
      <div className="flex between" style={{ marginBottom: 8 }}>
        <b style={{ fontSize: 13 }}>⚡ 서버 소비전력 (Dell iDRAC)</b>
        {data?.server && <span className="muted" style={{ fontSize: 12 }}>{data.server.name} · {data.server.host?.replace(/^https?:\/\//, '')}</span>}
      </div>

      {loading && <div className="muted" style={{ fontSize: 12, padding: '6px 0' }}>불러오는 중…</div>}
      {error && <div className="muted" style={{ fontSize: 12, padding: '6px 0' }}>전력 데이터를 불러올 수 없습니다.</div>}

      {!loading && data && !data.matched && (
        <div className="muted" style={{ fontSize: 12, padding: '6px 0', lineHeight: 1.6 }}>
          이 호스트에 매핑된 iDRAC가 없습니다.<br />
          관리자 → <b>전력 수집</b> 메뉴에서 이 호스트 이름으로 Dell 서버를 등록하면 실시간 전력이 표시됩니다.
        </div>
      )}

      {!loading && data?.matched && (
        <>
          <div className="flex" style={{ gap: 24, alignItems: 'baseline', marginBottom: 8 }}>
            <div>
              <div className="muted" style={{ fontSize: 11 }}>현재</div>
              <div style={{ fontSize: 26, fontWeight: 800, color: 'var(--amber)' }}>
                {data.current ? `${(data.current.watts / 1000).toFixed(2)} kW` : '—'}
                {data.current && <small style={{ fontSize: 13, color: 'var(--text-dim)', fontWeight: 600 }}> {data.current.watts} W</small>}
              </div>
            </div>
            {data.current && <div className="muted" style={{ fontSize: 11 }}>{new Date(data.current.ts).toLocaleString('ko-KR')}</div>}
          </div>

          {data.history?.length > 1 ? (
            <ResponsiveContainer width="100%" height={150}>
              <AreaChart data={data.history.map((p) => ({ t: p.ts, w: p.watts }))} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
                <defs>
                  <linearGradient id="pwrFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#f59e0b" stopOpacity={0.5} />
                    <stop offset="100%" stopColor="#f59e0b" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#243049" />
                <XAxis dataKey="t" stroke="#8b9bb4" fontSize={10}
                  tickFormatter={(t) => new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })} />
                <YAxis stroke="#8b9bb4" fontSize={10} width={40} unit="W" />
                <Tooltip contentStyle={tipStyle} itemStyle={itemStyle} labelStyle={labelStyle}
                  labelFormatter={(t) => new Date(t).toLocaleString('ko-KR')}
                  formatter={(v) => [`${v} W`, '전력']} />
                <Area type="monotone" dataKey="w" stroke="#f59e0b" strokeWidth={2} fill="url(#pwrFill)" />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="muted" style={{ fontSize: 12 }}>이력 데이터 수집 중입니다 (최초 수집까지 잠시 기다려주세요).</div>
          )}
        </>
      )}
    </div>
  );
}
