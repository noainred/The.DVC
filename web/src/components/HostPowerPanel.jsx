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

      {!loading && data?.matched && data.info && <ServerInfo info={data.info} />}
    </div>
  );
}

function IRow({ label, value }) {
  if (value == null || value === '') return null;
  return (
    <div className="flex between" style={{ padding: '5px 0', borderBottom: '1px solid rgba(36,48,73,.35)', gap: 12 }}>
      <span className="muted" style={{ fontSize: 12 }}>{label}</span>
      <span style={{ fontSize: 12, textAlign: 'right', wordBreak: 'break-all' }}>{value}</span>
    </div>
  );
}

/** Rich iDRAC hardware/firmware inventory (hostname, BIOS/CMOS, IPMI, CPU…). */
function ServerInfo({ info }) {
  const [showBios, setShowBios] = useState(false);
  const sys = info.system || {}, idrac = info.idrac || {}, cpu = info.cpu || {}, mem = info.memory || {};
  const bios = info.bios || {};
  const nics = info.network || [];
  const biosAttrs = Object.entries(bios.attributes || {});

  return (
    <div style={{ marginTop: 16, borderTop: '1px solid rgba(36,48,73,.6)', paddingTop: 12 }}>
      <div className="flex between" style={{ marginBottom: 8 }}>
        <b style={{ fontSize: 13 }}>🖥️ 서버 상세 정보 (iDRAC)</b>
        {info.collectedAt && <span className="muted" style={{ fontSize: 11 }}>{new Date(info.collectedAt).toLocaleString('ko-KR')}</span>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 20px' }}>
        <IRow label="호스트명" value={sys.hostName} />
        <IRow label="전원 상태" value={sys.powerState} />
        <IRow label="모델" value={[sys.manufacturer, sys.model].filter(Boolean).join(' ')} />
        <IRow label="서비스 태그" value={sys.serviceTag} />
        <IRow label="시리얼 번호" value={sys.serialNumber} />
        <IRow label="자산 태그" value={sys.assetTag} />
        <IRow label="BIOS 버전" value={sys.biosVersion} />
        <IRow label="iDRAC 펌웨어" value={idrac.firmwareVersion} />
        <IRow label="IPMI 버전" value={idrac.ipmiVersion} />
        <IRow label="iDRAC 모델" value={idrac.model} />
        <IRow label="CPU" value={cpu.model ? `${cpu.model}${cpu.count ? ` ×${cpu.count}` : ''}${cpu.cores ? ` · ${cpu.cores}코어` : ''}` : null} />
        <IRow label="메모리" value={mem.totalGiB != null ? `${mem.totalGiB} GiB` : null} />
        <IRow label="시스템 상태" value={sys.health} />
        <IRow label="UUID" value={sys.uuid} />
      </div>

      {nics.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>iDRAC 네트워크</div>
          {nics.map((n, i) => (
            <div key={i} className="muted" style={{ fontSize: 11 }}>
              {n.name && <b style={{ color: 'var(--text)' }}>{n.name}</b>} {n.ipv4 || ''} {n.mac ? `· ${n.mac}` : ''} {n.fqdn ? `· ${n.fqdn}` : ''}
            </div>
          ))}
        </div>
      )}

      {biosAttrs.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <button className="tab" onClick={() => setShowBios((v) => !v)}>
            {showBios ? '▼' : '▶'} BIOS / CMOS 설정 {bios.attributeCount ? `(주요 ${biosAttrs.length} / 전체 ${bios.attributeCount})` : ''}
          </button>
          {showBios && (
            <div style={{ marginTop: 6, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 20px' }}>
              {biosAttrs.map(([k, v]) => <IRow key={k} label={k} value={String(v)} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
