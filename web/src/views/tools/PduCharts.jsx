import React, { useEffect, useMemo, useState } from 'react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend, ReferenceLine } from 'recharts';
import { fetchJson } from '../../api.js';
import { Loading } from '../../components/ui.jsx';

/**
 * PDU 추이 그래프 — 전력(W) · 온도(℃) · 습도(%RH).
 *
 * 서버가 이미 버킷 단위로 집계해 내려주므로(pdu/db.js) 여기서는 그리기만 한다.
 * - 값이 없는 버킷은 **null 로 남긴다** — recharts 는 null 을 선 끊김으로 그린다.
 *   0 으로 채우면 '수집 중단'이 '측정값 0'으로 보여 오해를 만든다(connectNulls 미사용).
 * - 임계치는 ReferenceLine 으로 겹쳐 그려 '얼마나 여유가 있는지'를 바로 보이게 한다.
 */

const RANGES = [
  { k: 1, label: '1시간' }, { k: 6, label: '6시간' }, { k: 24, label: '24시간' },
  { k: 24 * 7, label: '7일' }, { k: 24 * 30, label: '30일' },
];
const COLORS = ['#60a5fa', '#f59e0b', '#34d399', '#f472b6', '#a78bfa', '#22d3ee', '#fb7185', '#a3e635'];

const fmtTime = (ts, hours) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return hours <= 24 ? `${p(d.getHours())}:${p(d.getMinutes())}` : `${d.getMonth() + 1}/${d.getDate()}`;
};

export default function PduCharts({ devices = [], thresholds = {} }) {
  const [hours, setHours] = useState(24);
  const [mode, setMode] = useState('avg');           // avg | peak
  const [sel, setSel] = useState([]);                // 선택 장비 id(빈 배열 = 전체)
  const [power, setPower] = useState(null);
  const [env, setEnv] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const idsParam = sel.join(',');
  useEffect(() => {
    let alive = true;
    setBusy(true);
    const q = { hours, points: 150, ...(idsParam ? { ids: idsParam } : {}) };
    Promise.all([
      fetchJson('/tools/pdu/series/power', q),
      fetchJson('/tools/pdu/series/env', q),
    ]).then(([p, e]) => { if (!alive) return; setPower(p); setEnv(e); setErr(null); })
      .catch((e) => { if (alive) setErr(e.message); })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [hours, idsParam]);

  const nameOf = useMemo(() => {
    const m = new Map(devices.map((d) => [d.id, d.name || d.host]));
    // 온습도 시리즈 키는 `<deviceId>#<sensorIndex>` 형태다(pdu/db.js envSeries).
    return (key) => {
      const [id, sensor] = String(key).split('#');
      const base = m.get(id) || id;
      return sensor ? `${base} 센서#${sensor}` : base;
    };
  }, [devices]);

  const powerRows = useMemo(() => toRows(power, mode), [power, mode]);
  const tempRows = useMemo(() => toRows(env, mode), [env, mode]);
  const humRows = useMemo(() => toRows(env, 'humidity'), [env]);

  const unavailable = power?.unavailable || env?.unavailable;

  return (
    <div>
      {/* 컨트롤 */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <span className="muted" style={{ fontSize: 12 }}>기간</span>
        {RANGES.map((r) => (
          <button key={r.k} className={hours === r.k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '5px 12px', fontSize: 12.5 }}
            onClick={() => setHours(r.k)}>{r.label}</button>
        ))}
        <span className="muted" style={{ fontSize: 12, marginLeft: 10 }}>기준</span>
        {[['avg', '평균'], ['peak', '피크']].map(([k, l]) => (
          <button key={k} className={mode === k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '5px 12px', fontSize: 12.5 }}
            onClick={() => setMode(k)}>{l}</button>
        ))}
        <span className="muted" style={{ fontSize: 11.5, marginLeft: 'auto' }}>
          {mode === 'peak' ? '버킷 안 최댓값' : '버킷 안 평균'} · 값 없는 구간은 선이 끊깁니다
        </span>
      </div>

      {/* 장비 필터 */}
      {devices.length > 1 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          <button className={sel.length === 0 ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '4px 10px', fontSize: 12 }}
            onClick={() => setSel([])}>전체 {devices.length}</button>
          {devices.map((d) => {
            const on = sel.includes(d.id);
            return (
              <button key={d.id} className={on ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '4px 10px', fontSize: 12 }}
                onClick={() => setSel((p) => (on ? p.filter((x) => x !== d.id) : [...p, d.id]))}>{d.name || d.host}</button>
            );
          })}
        </div>
      )}

      {err && <div className="card error-box" style={{ padding: 10, marginBottom: 12, fontSize: 13 }}>{err}</div>}
      {unavailable && (
        <div className="card" style={{ padding: 10, marginBottom: 12, fontSize: 13 }}>
          시계열 DB를 열 수 없어 추이를 표시하지 못합니다(수집 자체는 계속됩니다).
        </div>
      )}
      {busy && !power && <Loading />}

      {/* v2.598: 데이지체인 유닛 중 하나라도 전력을 못 읽은 시각은 합계가 부분 합이라 서버가 뺐다(pdu/db.js partialSamples) — 조용히 빼지 않는다. */}
      {partialSamplesNote(power?.partialSamples) && (
        <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>{partialSamplesNote(power.partialSamples)}</div>
      )}
      <Chart title="전력 (W)" rows={powerRows} series={power?.series} nameOf={nameOf} hours={hours} unit="W"
        refs={[
          { y: thresholds.powerWarnW, label: '경고', color: '#f59e0b' },
          { y: thresholds.powerCritW, label: '위험', color: '#ef4444' },
        ]} />

      <Chart title="온도 (℃)" rows={tempRows} series={env?.series} nameOf={nameOf} hours={hours} unit="℃"
        refs={[
          { y: thresholds.tempWarnC, label: '경고', color: '#f59e0b' },
          { y: thresholds.tempCritC, label: '위험', color: '#ef4444' },
        ]} />

      <Chart title="습도 (%RH)" rows={humRows} series={env?.series} nameOf={nameOf} hours={hours} unit="%RH"
        refs={[
          { y: thresholds.humLowPct, label: '하한', color: '#60a5fa' },
          { y: thresholds.humHighPct, label: '상한', color: '#f59e0b' },
        ]} />
    </div>
  );
}

/**
 * 전력 추이에서 뺀 시각 수 안내(v2.598). 한 수집 시각에 유닛 전력을 하나라도 못 읽으면 그 시각의 장비 합은
 * 부분 합(거짓 하락)이라 서버가 평균·최대에서 뺀다. 0·결측이면 말하지 않는다.
 */
export function partialSamplesNote(n) {
  const v = Number(n);
  if (n == null || n === '' || !Number.isFinite(v) || v <= 0) return '';
  return `유닛 일부 미수집 ${v}개 시각 제외 — 그 시각의 장비 합계는 부분 합이라 평균·최대에서 뺐습니다(0 W 가 아닙니다).`;
}

/** 시리즈 배열 → recharts 가 먹는 행 배열. 값 없는 칸은 null 로 남긴다(선 끊김). */
function toRows(data, field) {
  if (!data?.buckets?.length) return [];
  const pick = (s) => (field === 'peak' ? s.peak : field === 'humidity' ? s.humidity : s.avg);
  return data.buckets.map((ts, i) => {
    const row = { ts };
    for (const s of data.series || []) {
      const arr = pick(s);
      row[s.key] = arr ? (arr[i] ?? null) : null;
    }
    return row;
  });
}

function Chart({ title, rows, series = [], nameOf, hours, unit, refs = [] }) {
  const keys = (series || []).map((s) => s.key);
  const hasData = rows.some((r) => keys.some((k) => r[k] != null));
  return (
    <div className="card" style={{ padding: 14, marginBottom: 14 }}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>{title}</div>
      {!hasData ? (
        <div className="muted" style={{ fontSize: 12.5, padding: '20px 0', textAlign: 'center' }}>
          이 기간에 수집된 데이터가 없습니다. (수집 후 몇 주기가 지나야 선이 그려집니다)
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={rows} margin={{ top: 5, right: 12, bottom: 5, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.08)" />
            <XAxis dataKey="ts" tickFormatter={(t) => fmtTime(t, hours)} stroke="#9aa4b2" fontSize={11} minTickGap={40} />
            <YAxis stroke="#9aa4b2" fontSize={11} width={58} tickFormatter={(v) => `${v}`} />
            <Tooltip
              contentStyle={{ background: '#0f172a', border: '1px solid rgba(255,255,255,.15)', borderRadius: 8, fontSize: 12 }}
              labelFormatter={(t) => new Date(t).toLocaleString('ko-KR')}
              formatter={(v, k) => [v == null ? '—' : `${v} ${unit}`, nameOf(k)]}
            />
            <Legend formatter={(k) => nameOf(k)} wrapperStyle={{ fontSize: 11 }} />
            {refs.filter((r) => r.y != null).map((r) => (
              <ReferenceLine key={r.label} y={r.y} stroke={r.color} strokeDasharray="4 4"
                label={{ value: `${r.label} ${r.y}${unit}`, fill: r.color, fontSize: 10, position: 'right' }} />
            ))}
            {keys.map((k, i) => (
              <Line key={k} type="monotone" dataKey={k} stroke={COLORS[i % COLORS.length]} dot={false} strokeWidth={1.6} isAnimationActive={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
