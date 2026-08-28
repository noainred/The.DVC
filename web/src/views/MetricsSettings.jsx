import React, { useEffect, useRef, useState } from 'react';
import { fetchJson, putJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';

// Common presets for the temperature/metrics sampling interval.
const PRESETS = [
  { label: '30초', ms: 30_000 },
  { label: '1분', ms: 60_000 },
  { label: '5분', ms: 300_000 },
  { label: '10분', ms: 600_000 },
  { label: '30분', ms: 1_800_000 },
  { label: '1시간', ms: 3_600_000 },
];

const fmtAgo = (ts) => {
  if (!ts) return '없음';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.round(s / 60)}분 전`;
  return `${Math.round(s / 3600)}시간 전`;
};

/** 지표 수집(ESXi 온도/데이터스토어 용량/GPU) 주기·보존기간 설정. */
export default function MetricsSettings() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [intervalSec, setIntervalSec] = useState(60);
  const [retentionDays, setRetentionDays] = useState(1830);
  const [gpuEnabled, setGpuEnabled] = useState(true);
  const [gpuSec, setGpuSec] = useState(60);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const inited = useRef(false);
  const load = async () => {
    try {
      const d = await fetchJson('/admin/metrics/settings');
      setData(d); // '마지막 수집' 상태는 매 폴링 갱신
      // 입력 폼은 최초 1회만 서버값으로 채운다 — 20초 폴링이 편집 중인 값을 되돌리던 버그 방지.
      if (!inited.current) {
        inited.current = true;
        setIntervalSec(Math.round((d.settings.sampleIntervalMs || 60000) / 1000));
        setRetentionDays(d.settings.retentionDays ?? 1830);
        setGpuEnabled(d.settings.gpuUtilEnabled !== false);
        setGpuSec(d.settings.gpuUtilIntervalSec ?? 60);
      }
      setError(null);
    } catch (e) { setError(e.message); }
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 20_000); // refresh "마지막 수집" 상태
    return () => clearInterval(t);
  }, []);

  if (error && !data) return <ErrorBox message={error} />; // 데이터 보유 중 일시 폴링 오류로 화면 전체를 갈아치우지 않음(CLAUDE.md)
  if (!data) return <Loading />;

  const limits = data.limits || { minIntervalMs: 10000, maxIntervalMs: 86400000 };
  const minSec = Math.round(limits.minIntervalMs / 1000);
  const maxSec = Math.round(limits.maxIntervalMs / 1000);

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const ms = Math.max(limits.minIntervalMs, Math.min(limits.maxIntervalMs, intervalSec * 1000));
      const r = await putJson('/admin/metrics/settings', { sampleIntervalMs: ms, retentionDays: Number(retentionDays) || 0, gpuUtilEnabled: gpuEnabled, gpuUtilIntervalSec: Number(gpuSec) || 60 });
      setData(r);
      setIntervalSec(Math.round(r.settings.sampleIntervalMs / 1000));
      setMsg('저장되었습니다. 새 주기가 즉시 적용됩니다.');
    } catch (e) { setMsg(`오류: ${e.message}`); }
    finally { setBusy(false); }
  };

  const status = data.status || {};
  const last = status.lastRun;

  return (
    <div style={{ maxWidth: 640 }}>
      <div className="section-title" style={{ marginTop: 0 }}>🌡️ 지표 수집 주기</div>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        ESXi 온도 · 데이터스토어 사용량 · GPU 사용률을 주기적으로 수집해 시계열로 저장합니다.
        기본값은 <b>1분</b>이며 아래에서 변경할 수 있습니다.
      </p>

      <div className="card" style={{ padding: 16 }}>
        <label className="muted" style={{ fontSize: 12 }}>수집 주기</label>
        <div className="flex gap wrap" style={{ margin: '6px 0 10px' }}>
          {PRESETS.map((p) => (
            <button key={p.ms} className={intervalSec * 1000 === p.ms ? 'login-btn' : 'tab'}
              style={{ flex: 'none', padding: '6px 12px' }} onClick={() => setIntervalSec(p.ms / 1000)}>{p.label}</button>
          ))}
        </div>
        <div className="flex gap" style={{ alignItems: 'center' }}>
          <input className="input" type="number" min={minSec} max={maxSec} value={intervalSec}
            onChange={(e) => setIntervalSec(Number(e.target.value))} style={{ width: 120 }} />
          <span className="muted">초 ({minSec}~{maxSec}초 허용)</span>
        </div>

        <label className="muted" style={{ fontSize: 12, display: 'block', marginTop: 16 }}>보존 기간 (일, 0=무제한)</label>
        <div className="flex gap" style={{ alignItems: 'center', marginTop: 6 }}>
          <input className="input" type="number" min={0} value={retentionDays}
            onChange={(e) => setRetentionDays(Number(e.target.value))} style={{ width: 120 }} />
          <span className="muted">일 (기본 1830일 ≈ 5년)</span>
        </div>

        <div style={{ borderTop: '1px solid rgba(255,255,255,.08)', marginTop: 16, paddingTop: 14 }}>
          <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}>
            <input type="checkbox" checked={gpuEnabled} onChange={(e) => setGpuEnabled(e.target.checked)} /> GPU 호스트 사용률 수집(vCenter 성능 카운터 <code>gpu.utilization</code>)
          </label>
          <div className="flex gap" style={{ alignItems: 'center', marginTop: 8 }}>
            <span className="muted" style={{ fontSize: 12 }}>GPU 사용률 수집 주기</span>
            <input className="input" type="number" min={20} max={86400} value={gpuSec} disabled={!gpuEnabled}
              onChange={(e) => setGpuSec(Number(e.target.value))} style={{ width: 110 }} />
            <span className="muted">초 (20초~24시간)</span>
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>GPU 호스트만 대상이며, vGPU/vSGA는 ESXi가 사용률을 보고합니다. 패스쓰루는 게스트 수집(설정 › GPU 게스트 수집)으로 보완됩니다. GPU 인벤토리 화면의 <b>‘지금 수집’</b>으로 즉시 1회 수집도 가능합니다.</div>
        </div>

        <div className="flex gap" style={{ alignItems: 'center', marginTop: 18 }}>
          <button className="login-btn" style={{ flex: 'none', padding: '8px 18px' }} disabled={busy} onClick={save}>
            {busy ? '저장 중…' : '저장'}
          </button>
          {msg && <span className="muted" style={{ fontSize: 13 }}>{msg}</span>}
        </div>
      </div>

      <div className="card" style={{ padding: 16, marginTop: 14 }}>
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>현재 상태</div>
        <div className="flex gap wrap" style={{ fontSize: 13 }}>
          <span className="muted">적용 주기 <b style={{ color: 'var(--text)' }}>{Math.round((status.intervalMs || 0) / 1000)}초</b></span>
          <span className="muted">보존 <b style={{ color: 'var(--text)' }}>{status.retentionDays}일</b></span>
          <span className="muted">마지막 수집 <b style={{ color: 'var(--text)' }}>{fmtAgo(last?.at)}</b></span>
          {last && <span className="muted">온도 보고 호스트 <b style={{ color: 'var(--text)' }}>{last.hostsWithTemp}</b> · 행 <b style={{ color: 'var(--text)' }}>{last.rows}</b></span>}
        </div>
      </div>

      {/* VM 성능 트래킹(낭비 리소스 원본) — vCenter별 독립 DB · 보존기간·대상 선택(v2.376) */}
      <VmPerfTrackingSettings />
    </div>
  );
}

/**
 * VM 성능 트래킹 설정(v2.376) — 낭비 리소스의 '할당 vs 사용' 시계열을 얼마나·어떤 vCenter 만
 * 저장할지 고른다. 이 계열은 vCenter 별 **독립 DB**(CONFIG_DIR/vmperf/<id>.db)에 저장되므로
 * 대상에서 빼면 파일이 삭제되어 **용량이 즉시 회수**된다(공용 DB 면 행만 지워지고 파일은 안 줄어듦).
 *
 * 용량 감각(실측 기준, 행당 ~308B): 6,000 VM · 1시간 간격 · 2계열 → 90일 ≈ 7.4GB / 1년 ≈ 30GB.
 * 그래서 기본 보존은 90일이고, 필요한 vCenter 만 선택하는 것을 권한다.
 */
export function VmPerfTrackingSettings() {
  // ⚠ 훅은 전부 조기 return 위에서 선언(CLAUDE.md — React #310 방지).
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [enabled, setEnabled] = useState(true);
  const [days, setDays] = useState(90);
  const [ids, setIds] = useState([]);        // 빈 배열 = 전체
  const [trackTotal, setTrackTotal] = useState(true);

  const load = async () => {
    try {
      const r = await fetchJson('/tools/waste/settings');
      setD(r); setErr(null);
      setEnabled(r.settings.enabled);
      setDays(r.settings.retentionDays);
      setIds(r.settings.vcenterIds || []);
      setTrackTotal(r.settings.trackTotal !== false);
    } catch (e) { setErr(e.message); }
  };
  useEffect(() => { load(); }, []);

  const fmtBytes = (b) => {
    if (!b) return '0';
    const GB = 1024 ** 3; const MB = 1024 ** 2;
    return b >= GB ? `${(b / GB).toFixed(2)} GB` : b >= MB ? `${(b / MB).toFixed(1)} MB` : `${(b / 1024).toFixed(0)} KB`;
  };
  const toggle = (id) => setIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await putJson('/tools/waste/settings', {
        enabled, retentionDays: Number(days) || 0, vcenterIds: ids, trackTotal,
      });
      const dropped = (r.dropped || []).length;
      setMsg(`저장되었습니다.${dropped ? ` 제외된 ${dropped}개 vCenter 의 데이터를 삭제해 용량을 회수했습니다.` : ''}`);
      await load();
    } catch (e) { setMsg(`오류: ${e.message}`); }
    finally { setBusy(false); }
  };

  if (err) return <ErrorBox message={err} />;
  if (!d) return <Loading />;
  const usage = d.usage || [];

  return (
    <div className="card" style={{ padding: 16, marginTop: 14 }}>
      <div className="flex between wrap" style={{ alignItems: 'center', marginBottom: 6 }}>
        <b style={{ fontSize: 14 }}>VM 성능 트래킹 (낭비 리소스 · 할당 vs 사용)</b>
        <span className="muted" style={{ fontSize: 12 }}>총 사용량 <b style={{ color: 'var(--text)' }}>{fmtBytes(d.totalBytes)}</b></span>
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 12, lineHeight: 1.6 }}>
        낭비 리소스 › 사용 추이 차트의 원본 데이터입니다. vCenter 별로 <b>독립 DB</b>에 저장되어, 대상에서 빼면 파일을 삭제해 <b>용량이 즉시 회수</b>됩니다.
        <br />용량 감각(실측): 6,000 VM · 1시간 간격이면 <b>90일 ≈ 7.4GB</b> · <b>1년 ≈ 30GB</b>. 필요한 vCenter 만 선택하는 것을 권합니다.
      </div>

      <div className="flex gap wrap" style={{ alignItems: 'center', gap: 18, marginBottom: 12 }}>
        <label className="flex gap" style={{ alignItems: 'center', cursor: 'pointer' }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> <b>수집 사용</b>
        </label>
        <span className="muted" style={{ fontSize: 13 }}>보존기간</span>
        <input className="input" type="number" min={0} max={d.limits?.maxRetentionDays || 1830} style={{ width: 100 }}
          value={days} onChange={(e) => setDays(e.target.value)} disabled={!enabled} />
        <span className="muted" style={{ fontSize: 12 }}>일 (0 = 무제한)</span>
        <label className="flex gap muted" style={{ alignItems: 'center', fontSize: 12, cursor: 'pointer' }}>
          <input type="checkbox" checked={trackTotal} onChange={(e) => setTrackTotal(e.target.checked)} disabled={!enabled} /> 전체 합계 계열도 저장
        </label>
      </div>

      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
        수집 대상 vCenter — <b>아무것도 선택하지 않으면 전체</b>가 대상입니다. ({ids.length ? `${ids.length}개 선택` : '전체'})
      </div>
      <div className="flex gap wrap" style={{ gap: 8, marginBottom: 12 }}>
        {(d.vcenters || []).map((v) => {
          const on = ids.includes(v.id);
          const u = usage.find((x) => x.vcenterId === v.id);
          return (
            <button key={v.id} className={on ? 'login-btn' : 'logout-btn'} disabled={!enabled}
              style={{ flex: 'none', padding: '6px 12px', fontSize: 12 }}
              title={u ? `저장된 데이터 ${fmtBytes(u.bytes)}` : '저장된 데이터 없음'}
              onClick={() => toggle(v.id)}>
              {v.name}{u ? <span className="muted" style={{ marginLeft: 6 }}>{fmtBytes(u.bytes)}</span> : null}
            </button>
          );
        })}
        {(d.vcenters || []).length === 0 && <span className="muted" style={{ fontSize: 12 }}>표시할 vCenter 가 없습니다.</span>}
      </div>

      {usage.length > 0 && (
        <div className="table-wrap" style={{ marginBottom: 12, maxHeight: 220 }}>
          <table>
            <thead><tr><th>저장된 vCenter 데이터</th><th style={{ textAlign: 'right' }}>용량</th></tr></thead>
            <tbody>
              {usage.map((u) => (
                <tr key={u.file}>
                  <td>{u.vcenterId || <span className="muted">(전체 합계)</span>}</td>
                  <td style={{ textAlign: 'right' }}>{fmtBytes(u.bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex gap" style={{ alignItems: 'center' }}>
        <button className="login-btn" style={{ padding: '8px 18px' }} disabled={busy} onClick={save}>{busy ? '저장 중…' : '저장'}</button>
        {msg && <span className="muted" style={{ fontSize: 13 }}>{msg}</span>}
      </div>
    </div>
  );
}
