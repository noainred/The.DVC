// v2.650: GPU 추이 모달(사용률·메모리 점유·온도) — GPU 모니터링 화면과 호스트 상세가 같이 쓴다.
import React, { useEffect, useRef, useState } from 'react';
import { fetchJson } from '../../api.js';
import { Loading, ErrorBox } from '../../components/primitives.jsx';
import { Modal } from '../../components/Modal.jsx';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Brush } from 'recharts';
import { fmtTrendTick } from './shared.jsx';

export const GPU_HIST_METRICS = [['util', '사용률'], ['mem', '메모리 점유'], ['temp', '온도']];

/** level: host|cluster|vc|vm. 클러스터·법인은 사용률만 있다(서버가 400 을 준다). */
export default function GpuHistModal({ level, hkey, title, initialMetric = 'util', onClose }) {
  const [days, setDays] = useState(7);
  const [metric, setMetric] = useState(initialMetric);
  const [d, setD] = useState({ loading: true });
  const gen = useRef(0);
  const metrics = level === 'host' || level === 'vm' ? GPU_HIST_METRICS : GPU_HIST_METRICS.slice(0, 1);
  useEffect(() => {
    const g = ++gen.current;
    setD({ loading: true });
    fetchJson(`/tools/gpu/history?level=${level}&key=${encodeURIComponent(hkey)}&days=${days}&metric=${metric}`)
      .then((r) => { if (g === gen.current) setD(r || { error: true }); })
      .catch(() => { if (g === gen.current) setD({ error: true }); });
  }, [level, hkey, days, metric]);
  const temp = metric === 'temp';
  const label = GPU_HIST_METRICS.find(([k]) => k === metric)?.[1] || '';
  return (
    <Modal title={`GPU ${label} 추이 — ${title || hkey}`} onClose={onClose} width={760}>
      <div className="flex gap" style={{ marginBottom: 10, flexWrap: 'wrap', rowGap: 6 }}>
        {metrics.length > 1 && metrics.map(([k, l]) => (
          <button key={k} className={metric === k ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '6px 12px', fontSize: 12 }} onClick={() => setMetric(k)}>{l}</button>
        ))}
        {metrics.length > 1 && <span style={{ width: 8 }} />}
        {[[1, '1일'], [7, '1주'], [30, '1달'], [365, '1년'], [1830, '5년']].map(([n, l]) => (
          <button key={n} className={days === n ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '6px 12px', fontSize: 12 }} onClick={() => setDays(n)}>{l}</button>
        ))}
        {d.synthesized && <span className="badge amber" style={{ alignSelf: 'center' }}>데모 합성</span>}
      </div>
      {d.loading ? <Loading /> : d.error ? <ErrorBox message="이력을 불러오지 못했습니다." /> : (d.points || []).length === 0
        ? <div className="muted">해당 기간 데이터가 없습니다{metric === 'util' ? '(수집 누적 후 표시)' : '(메모리·온도 추이는 v2.650 부터 게스트 수집값으로 쌓입니다)'}.</div>
        : (
          <>
            <ResponsiveContainer width="100%" height={320}>
              <LineChart data={(d.points || []).map((p) => ({ t: fmtTrendTick(p.ts, days), avg: p.avg, max: p.max }))}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.08)" />
                <XAxis dataKey="t" tick={{ fontSize: 11 }} minTickGap={40} />
                <YAxis tick={{ fontSize: 11 }} unit={temp ? '℃' : '%'} domain={temp ? ['auto', 'auto'] : [0, 100]} allowDataOverflow={!temp} />
                <Tooltip contentStyle={{ background: '#0b1220', border: '1px solid #243049', fontSize: 12 }} />
                <Line type="monotone" dataKey="avg" stroke="#a78bfa" dot={false} name="평균" isAnimationActive={false} />
                <Line type="monotone" dataKey="max" stroke="#f59e0b" dot={false} name="최고" isAnimationActive={false} />
                <Brush dataKey="t" height={22} stroke="#6366f1" travellerWidth={8} tickFormatter={() => ''} />
              </LineChart>
            </ResponsiveContainer>
            <div className="muted" style={{ fontSize: 11, marginTop: 4, textAlign: 'center' }}>아래 막대를 드래그하면 구간을 좁혀 확대해 볼 수 있습니다.{temp ? ' 온도 축은 값 범위에 맞춥니다.' : ''}</div>
          </>
        )}
    </Modal>
  );
}
