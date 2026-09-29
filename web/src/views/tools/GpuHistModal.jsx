// v2.650: GPU 추이 모달(사용률·메모리 점유·온도) — GPU 모니터링 화면과 호스트 상세가 같이 쓴다.
import React, { useEffect, useRef, useState } from 'react';
import { fetchJson } from '../../api.js';
import { Loading, ErrorBox } from '../../components/primitives.jsx';
import { Modal } from '../../components/Modal.jsx';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Brush, Legend } from 'recharts';
import { fmtTrendTick } from './shared.jsx';
import { numOrNull } from '../../numOrNull.js';

export const GPU_HIST_METRICS = [['util', '사용률'], ['mem', '메모리 사용률'], ['memmb', '메모리 사용량'], ['temp', '온도']];
export const GPU_HIST_PERIODS = [[1, '1일'], [7, '1주'], [30, '1달'], [365, '1년'], [1830, '5년']];

/**
 * v2.655: 집계 단위(서버 GPU_HIST_BUCKETS 와 같은 키). '자동' 은 기간으로 정한다(예전 동작).
 * 점 상한(서버 GPU_HIST_MAX_POINTS 3,000)을 넘는 기간은 고를 수 없게 한다 — 골라도 서버가 최근 쪽만 준다.
 */
export const GPU_HIST_BUCKETS = [['auto', '자동', 0], ['1m', '1분', 60_000], ['10m', '10분', 600_000], ['1h', '1시간', 3_600_000], ['6h', '6시간', 21_600_000]];
export const GPU_HIST_MAX_POINTS = 3000;
export function periodAllowed(bucket, days) {
  const ms = GPU_HIST_BUCKETS.find(([k]) => k === bucket)?.[2] || 0;
  if (!ms) return true;
  return (days * 86_400_000) / ms <= GPU_HIST_MAX_POINTS;
}
/** 단위를 바꿀 때 지금 기간이 안 되면 되는 가장 긴 기간으로. */
export function fitPeriod(bucket, days) {
  if (periodAllowed(bucket, days)) return days;
  const ok = GPU_HIST_PERIODS.map(([n]) => n).filter((n) => periodAllowed(bucket, n));
  return ok.length ? ok[ok.length - 1] : 1;
}
/** 눈금 — 짧은 단위는 시:분, 1일을 넘으면 날짜를 붙인다. */
export function gpuTick(ts, days, bucketMs) {
  if (bucketMs && bucketMs < 86_400_000 && days > 1) {
    const d = new Date(ts);
    if (days > 31) return `${String(d.getFullYear()).slice(2)}/${d.getMonth() + 1}/${d.getDate()}`;
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return fmtTrendTick(ts, days);
}

/**
 * v2.656: 수집이 없던 구간은 선을 잇지 않는다 — 앞뒤 점을 직선으로 이으면 그 구간에도 값이 있었던 것처럼 보인다
 *   (bmUsageChart·roomTempView 와 같은 규약). 이웃 점 간격이 '집계 단위 × 2'(수집 주기가 더 길면 그 × 2)를 넘으면
 *   사이에 빈 점(avg·max 가 null)을 넣는다 — recharts 는 null 에서 선을 끊는다(connectNulls 기본 false).
 *   양옆이 비어 선이 그려지지 않는 외톨이 점은 `iso` 로 표시해 점으로 그린다(없애면 그 값이 화면에서 사라진다).
 *   단위를 모르면(bucketMs 없음) 이웃 간격의 중앙값을 단위로 본다. 반환 { rows, gaps }.
 */
export function gapRows(points, bucketMs, sampleSec) {
  const pts = (Array.isArray(points) ? points : []).filter((p) => p && numOrNull(p.ts) != null).slice().sort((a, b) => a.ts - b.ts);
  let unit = numOrNull(bucketMs);
  if (!unit && pts.length > 2) {
    const diffs = pts.slice(1).map((p, i) => p.ts - pts[i].ts).filter((x) => x > 0).sort((a, b) => a - b);
    unit = diffs.length ? diffs[Math.floor(diffs.length / 2)] : null;
  }
  const s = numOrNull(sampleSec);
  const limit = unit ? Math.max(unit, s ? s * 1000 : 0) * 2 : null;
  const rows = []; let gaps = 0;
  for (let i = 0; i < pts.length; i++) {
    if (i > 0 && limit && pts[i].ts - pts[i - 1].ts > limit) {
      rows.push({ ts: pts[i - 1].ts + 1, avg: null, max: null, gap: true });
      gaps += 1;
    }
    rows.push({ ts: pts[i].ts, avg: numOrNull(pts[i].avg), max: numOrNull(pts[i].max) });
  }
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].gap) continue;
    const prevOk = i > 0 && !rows[i - 1].gap;
    const nextOk = i < rows.length - 1 && !rows[i + 1].gap;
    if (!prevOk && !nextOk) rows[i].iso = true;
  }
  return { rows, gaps };
}

/** level: host|cluster|vc|vm. 클러스터·법인은 사용률만 있다(서버가 400 을 준다). */
export default function GpuHistModal({ level, hkey, title, initialMetric = 'util', onClose }) {
  const [days, setDays] = useState(1);
  const [metric, setMetric] = useState(initialMetric);
  const [bucket, setBucket] = useState('auto');
  const [d, setD] = useState({ loading: true });
  const gen = useRef(0);
  const metrics = level === 'host' || level === 'vm' ? GPU_HIST_METRICS : GPU_HIST_METRICS.slice(0, 1);
  useEffect(() => {
    const g = ++gen.current;
    setD({ loading: true });
    fetchJson(`/tools/gpu/history?level=${level}&key=${encodeURIComponent(hkey)}&days=${days}&metric=${metric}${bucket !== 'auto' ? `&bucket=${bucket}` : ''}`)
      .then((r) => { if (g === gen.current) setD(r || { error: true }); })
      .catch(() => { if (g === gen.current) setD({ error: true }); });
  }, [level, hkey, days, metric, bucket]);
  const temp = metric === 'temp';
  const mb = metric === 'memmb'; // v2.653: 서버는 MB 로 저장한다 — GB 로 그린다
  const conv = (v) => (v == null ? null : mb ? Math.round((v / 1024) * 10) / 10 : v);
  const label = GPU_HIST_METRICS.find(([k]) => k === metric)?.[1] || '';
  const bucketLabel = GPU_HIST_BUCKETS.find(([k]) => k === bucket)?.[1] || '';
  const bMs = numOrNull(d.bucketMs);
  const gapped = gapRows(d.points, bMs, d.sampleSec);
  return (
    <Modal title={`GPU ${label} 추이 — ${title || hkey}`} onClose={onClose} width={760}>
      <div className="flex gap" style={{ marginBottom: 10, flexWrap: 'wrap', rowGap: 6 }}>
        {metrics.length > 1 && metrics.map(([k, l]) => (
          <button key={k} className={metric === k ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '6px 12px', fontSize: 12 }} onClick={() => setMetric(k)}>{l}</button>
        ))}
        {metrics.length > 1 && <span style={{ width: 8 }} />}
        {GPU_HIST_PERIODS.map(([n, l]) => {
          const ok = periodAllowed(bucket, n);
          return (
            <button key={n} className={days === n ? 'login-btn' : 'logout-btn'} disabled={!ok}
              title={ok ? '' : `${bucketLabel} 단위로는 점이 ${GPU_HIST_MAX_POINTS.toLocaleString()}개를 넘어 이 기간을 볼 수 없습니다 — 더 큰 단위를 고르세요.`}
              style={{ flex: 'none', padding: '6px 12px', fontSize: 12, ...(ok ? {} : { opacity: 0.4, cursor: 'not-allowed' }) }} onClick={() => setDays(n)}>{l}</button>
          );
        })}
      </div>
      <div className="flex gap" style={{ marginBottom: 10, flexWrap: 'wrap', rowGap: 6, alignItems: 'center' }}>
        <span className="muted" style={{ fontSize: 12 }}>집계 단위</span>
        {GPU_HIST_BUCKETS.map(([k, l]) => (
          <button key={k} className={bucket === k ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '4px 10px', fontSize: 12 }}
            onClick={() => { setBucket(k); setDays((cur) => fitPeriod(k, cur)); }}>{l}</button>
        ))}
        {d.synthesized && <span className="badge amber" style={{ alignSelf: 'center' }}>데모 합성</span>}
      </div>
      {d.loading ? <Loading /> : d.error ? <ErrorBox message="이력을 불러오지 못했습니다." /> : (d.points || []).length === 0
        ? <div className="muted">해당 기간 데이터가 없습니다{metric === 'util' ? '(수집 누적 후 표시)' : (mb ? '(메모리 사용량 추이는 v2.653 부터 쌓입니다)' : '(메모리·온도 추이는 v2.650 부터 게스트 수집값으로, v2.653 부터 ESXi 카운터 값으로도 쌓입니다)')}.</div>
        : (
          <>
            <ResponsiveContainer width="100%" height={320}>
              <LineChart data={gapped.rows.map((p) => ({ t: p.gap ? '' : gpuTick(p.ts, days, bMs), avg: conv(p.avg), max: conv(p.max), iso: !!p.iso }))}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.08)" />
                <XAxis dataKey="t" tick={{ fontSize: 11 }} minTickGap={40} />
                <YAxis tick={{ fontSize: 11 }} unit={temp ? '℃' : mb ? 'GB' : '%'} domain={temp || mb ? [mb ? 0 : 'auto', 'auto'] : [0, 100]} allowDataOverflow={!temp && !mb} />
                <Tooltip contentStyle={{ background: '#0b1220', border: '1px solid #243049', fontSize: 12 }} />
                <Legend verticalAlign="top" height={24} iconType="plainline" wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="avg" stroke="#a78bfa" dot={isoDot('#a78bfa')} name="평균" isAnimationActive={false} />
                <Line type="monotone" dataKey="max" stroke="#f59e0b" dot={isoDot('#f59e0b')} name="최고" isAnimationActive={false} />
                <Brush dataKey="t" height={22} stroke="#6366f1" travellerWidth={8} tickFormatter={() => ''} />
              </LineChart>
            </ResponsiveContainer>
            <div className="muted" style={{ fontSize: 11, marginTop: 4, textAlign: 'center' }}>{bucketNote(d, bucketLabel)}{gapNote(gapped.gaps)}아래 막대를 드래그하면 구간을 좁혀 확대해 볼 수 있습니다.{temp ? ' 온도 축은 값 범위에 맞춥니다.' : mb ? ' 메모리 사용량 축은 값 범위에 맞춥니다(GB).' : ''}</div>
          </>
        )}
    </Modal>
  );
}

/** 외톨이 점(양옆이 빈 구간)만 점으로 그린다 — 나머지는 선. recharts dot 렌더 함수. */
function isoDot(color) {
  return (props) => {
    const { cx, cy, payload, key } = props || {};
    if (!payload?.iso || cx == null || cy == null) return <g key={key} />;
    return <circle key={key} cx={cx} cy={cy} r={2.5} fill={color} stroke="none" />;
  };
}
/** 끊은 구간 안내 — 0 이면 빈 문자열. */
export function gapNote(gaps) {
  return gaps > 0 ? `수집이 없던 구간 ${gaps}곳은 선을 잇지 않았습니다(빈 칸 = 값 없음). ` : '';
}

/** 단위 안내 — 실제로 쓴 단위 · 잘림 · 수집 주기보다 짧은 단위. 값이 없으면 빈 문자열. */
export function bucketNote(d, bucketLabel) {
  const bits = [];
  const ms = numOrNull(d?.bucketMs);
  if (ms) bits.push(`집계 단위 ${ms >= 3_600_000 ? `${ms / 3_600_000}시간` : `${ms / 60_000}분`}(점마다 평균·최고).`);
  if (d?.truncated && numOrNull(d.coveredSince)) {
    const c = new Date(d.coveredSince);
    bits.push(`${bucketLabel || '이'} 단위는 점 ${numOrNull(d.limit)?.toLocaleString() || ''}개까지라 ${c.getMonth() + 1}/${c.getDate()} ${String(c.getHours()).padStart(2, '0')}:${String(c.getMinutes()).padStart(2, '0')} 이후만 그렸습니다.`);
  }
  const s = numOrNull(d?.sampleSec);
  if (ms && s && ms < s * 1000 * 2) bits.push(`사용률 수집 주기가 ${s >= 60 ? `${Math.round(s / 60)}분` : `${s}초`}라 ${Math.round(ms / 60_000)}분 단위에서는 같은 값이 이어지거나 빈 칸이 생길 수 있습니다.`);
  return bits.length ? `${bits.join(' ')} ` : '';
}
