/**
 * GuestDiskReport.jsx — 게스트 디스크 회수 리포트(v2.459).
 *
 * 사용자 요구: VM 별 게스트 파티션 할당량/사용량·비율, 파티션별 사용량 증가 추이를 DB 에 저장해
 * 추이를 검색해서 '줄일 수 있는 용량과 VM' 을 정리해 보여주고 CSV export.
 *
 * 판정·저장은 서버(guestdisk/*)가 하고 여기서는 표시만 한다. 주기 수집은 opt-in(기본 꺼짐)이라
 * 관리자가 켜야 추이가 쌓인다 — 켜기 전에는 '지금 수집'으로 즉석 1회 수집할 수 있다.
 */
import React, { useEffect, useState, useCallback } from 'react';
import { fetchJson, putJson, postJson, downloadFile } from '../../api.js';
import { STable } from '../../components/STable.jsx';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { Card } from './shared.jsx';

const gb = (x) => (x == null ? '—' : `${x} GB`);
const pct = (x) => (x == null ? '—' : `${x}%`);
const TREND = {
  growing: { label: '증가', color: '#f87171' },
  flat: { label: '평탄', color: '#93c5fd' },
  shrinking: { label: '감소', color: '#4ade80' },
};
const trendLabel = (t) => (t && TREND[t] ? TREND[t] : { label: '근거 부족', color: '#9ca3af' });
const when = (ts) => (ts ? new Date(ts).toLocaleString() : '—');

export default function GuestDiskReport() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [busy, setBusy] = useState('');
  const [minReclaim, setMinReclaim] = useState(5);
  const [detail, setDetail] = useState(null);       // 선택 VM 파티션 상세
  const [detailBusy, setDetailBusy] = useState(false);
  const [form, setForm] = useState(null);           // 설정 편집(enabled/intervalHours)

  const reload = useCallback(async (mr = minReclaim) => {
    setError(null);
    try {
      const r = await fetchJson('/tools/guest-disk', { minReclaimGB: mr });
      setData(r);
      setForm({ enabled: !!r.settings?.enabled, intervalHours: r.settings?.intervalHours ?? 12 });
    } catch (e) { setError(e.message); }
  }, [minReclaim]);

  useEffect(() => { reload(); fetchJson('/auth/me').then((m) => setIsAdmin(m?.user?.role === 'admin')).catch(() => {}); }, [reload]);

  const openVm = async (vmId) => {
    setDetailBusy(true); setDetail(null);
    try { setDetail(await fetchJson(`/tools/guest-disk/vm/${encodeURIComponent(vmId)}`)); }
    catch (e) { setDetail({ error: e.message }); }
    finally { setDetailBusy(false); }
  };

  const runNow = async () => {
    setBusy('run');
    try { const r = await postJson('/tools/guest-disk/run', {}); await reload();
      if (r.skipped) alert('이미 수집이 진행 중입니다.');
      else if (!r.ok) alert(`수집 실패: ${r.reason || '알 수 없음'}`);
    } catch (e) { alert(`수집 실패: ${e.message}`); } finally { setBusy(''); }
  };

  const saveSettings = async () => {
    setBusy('save');
    try { await putJson('/tools/guest-disk/settings', form); await reload(); }
    catch (e) { alert(`저장 실패: ${e.message}`); } finally { setBusy(''); }
  };

  const exportCsv = () => downloadFile(`/api/tools/guest-disk/export.csv?minReclaimGB=${minReclaim}`).catch((e) => alert(e.message));

  if (error && !data) return <ErrorBox error={error} />;
  if (!data) return <Loading />;

  const rows = data.rows || [];
  const poller = data.poller || {};
  const dbOk = data.db?.available;

  return (
    <div>
      <h3 style={{ marginTop: 0 }}>게스트 디스크 회수 리포트</h3>
      <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.7, marginTop: 4 }}>
        VM 게스트(VMware Tools) 파티션의 <b>할당(alloc)</b> 대비 <b>사용(used)</b> 을 비교해 <b>줄일 수 있는 여유(회수 가능)</b> 가
        큰 VM 을 정렬합니다. 파티션별 사용량 <b>증가 추이</b> 를 함께 봐 '증가 중' 이면 축소를 보류합니다.
        <br />여유(free)는 <b>게스트 관점의 회수 상한</b> 입니다 — 실제 스토리지 회수는 디스크 축소(shrink)+UNMAP 이 필요하며 전량을 회수하지 못할 수 있습니다.
      </p>

      <div className="flex gap" style={{ flexWrap: 'wrap', margin: '10px 0' }}>
        <Card label="회수 가능 합계" value={`${data.totalReclaimGB} GB`} accent />
        <Card label="대상 VM" value={`${data.vmCount}대`} meta={`여유 ≥ ${data.minReclaimGB}GB`} />
        <Card label="주기 수집" value={data.settings?.enabled ? '켜짐' : '꺼짐'} meta={poller.lastRunTs ? `최근 ${when(poller.lastRunTs)}` : '아직 수집 없음'} />
        <Card label="추이 DB" value={dbOk ? '정상' : '사용 불가'} meta={dbOk ? '' : (data.db?.error || 'node:sqlite 없음')} />
      </div>

      <div className="flex gap" style={{ alignItems: 'center', flexWrap: 'wrap', margin: '10px 0' }}>
        <label className="flex gap muted" style={{ alignItems: 'center', fontSize: 12.5 }}>
          최소 회수(GB)
          <input className="input" type="number" min={0} style={{ width: 80 }} value={minReclaim}
            onChange={(e) => setMinReclaim(Number(e.target.value))}
            onKeyDown={(e) => { if (e.key === 'Enter') reload(Number(e.target.value)); }} />
          <button className="logout-btn" style={{ padding: '3px 10px', fontSize: 12 }} onClick={() => reload()}>적용</button>
        </label>
        <button className="login-btn" style={{ flex: 'none', padding: '7px 16px' }} onClick={exportCsv} disabled={!rows.length}>⬇ CSV 다운로드 ({data.vmCount}대)</button>
        {isAdmin && <button className="logout-btn" style={{ padding: '7px 14px' }} disabled={busy === 'run'} onClick={runNow}>{busy === 'run' ? '수집 중…' : '지금 수집'}</button>}
      </div>

      {isAdmin && form && (
        <div className="card" style={{ padding: 12, margin: '8px 0', maxWidth: 560 }}>
          <b style={{ fontSize: 13 }}>주기 수집 설정 (관리자)</b>
          <div className="flex gap" style={{ alignItems: 'center', flexWrap: 'wrap', marginTop: 8, fontSize: 12.5 }}>
            <label className="flex gap" style={{ alignItems: 'center' }}>
              <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> 주기 수집 사용(opt-in)
            </label>
            <label className="flex gap muted" style={{ alignItems: 'center' }}>
              주기(시간)
              <input className="input" type="number" min={1} max={168} style={{ width: 70 }} value={form.intervalHours}
                onChange={(e) => setForm({ ...form, intervalHours: Number(e.target.value) })} />
            </label>
            <button className="login-btn" style={{ flex: 'none', padding: '5px 14px' }} disabled={busy === 'save'} onClick={saveSettings}>{busy === 'save' ? '저장 중…' : '저장'}</button>
          </div>
          <p className="muted" style={{ fontSize: 11, marginTop: 6 }}>5,850 VM 규모라 기본 꺼짐입니다. 켜면 {form.intervalHours}시간마다 전 vCenter 게스트 디스크를 수집해 추이를 쌓습니다.</p>
        </div>
      )}

      {poller.lastResult?.errors?.length > 0 && (
        <div className="muted" style={{ fontSize: 11.5, color: '#fbbf24', margin: '4px 0' }}>
          최근 수집에서 {poller.lastResult.errors.length}개 vCenter 조회 실패(엣지 수집 vCenter 는 중앙에서 직접 접속이 안 될 수 있습니다).
        </div>
      )}

      {rows.length === 0 ? (
        <div className="muted" style={{ padding: '16px 0' }}>
          회수 대상이 없습니다. {data.settings?.enabled ? '' : '주기 수집이 꺼져 있으면 '}‘지금 수집’ 으로 데이터를 채운 뒤 확인하세요(VMware Tools 가 실행 중인 VM 만 집계됩니다).
        </div>
      ) : (
        <STable className="data-table">
          <thead>
            <tr>
              <th>vCenter</th><th>VM</th><th>할당(GB)</th><th>사용(GB)</th><th>회수가능(GB)</th><th>사용률(%)</th><th>파티션</th><th data-nosort>추이</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.vmId} style={{ cursor: 'pointer' }} onClick={() => openVm(r.vmId)} title="클릭하면 파티션별 상세·추이">
                <td>{r.vcenterName || r.vcenterId}</td>
                <td>{r.vmName}</td>
                <td data-sort={r.allocGB}>{r.allocGB}</td>
                <td data-sort={r.usedGB}>{r.usedGB}</td>
                <td data-sort={r.freeGB}><b style={{ color: '#4ade80' }}>{r.freeGB}</b></td>
                <td data-sort={r.ratioPct == null ? -1 : r.ratioPct}>{pct(r.ratioPct)}</td>
                <td data-sort={r.partCount}>{r.partCount}</td>
                <td data-nosort><span className="muted" style={{ fontSize: 11 }}>상세 ▸</span></td>
              </tr>
            ))}
          </tbody>
        </STable>
      )}

      {(detailBusy || detail) && (
        <div className="card" style={{ padding: 14, marginTop: 14 }}>
          {detailBusy && <Loading />}
          {detail?.error && <ErrorBox error={detail.error} />}
          {detail && !detail.error && (
            <>
              <div className="flex gap" style={{ alignItems: 'baseline', flexWrap: 'wrap' }}>
                <b style={{ fontSize: 14 }}>{detail.vmName}</b>
                <span className="muted" style={{ fontSize: 12 }}>{detail.vcenterName}</span>
                <span className="muted" style={{ fontSize: 12 }}>할당 {gb(detail.allocGB)} · 사용 {gb(detail.usedGB)} · 회수가능 <b style={{ color: '#4ade80' }}>{gb(detail.freeGB)}</b></span>
                {detail.vmTrend?.growthGBPerDay != null && (
                  <span style={{ fontSize: 12, color: trendLabel(detail.vmTrend.trend).color }}>
                    전체 추이 {trendLabel(detail.vmTrend.trend).label} ({detail.vmTrend.growthGBPerDay > 0 ? '+' : ''}{detail.vmTrend.growthGBPerDay} GB/일)
                  </span>
                )}
              </div>
              <STable className="data-table" style={{ marginTop: 10 }}>
                <thead>
                  <tr><th>파티션</th><th>할당(GB)</th><th>사용(GB)</th><th>여유(GB)</th><th>증가율(GB/일)</th><th>추이</th><th data-nosort>판정</th></tr>
                </thead>
                <tbody>
                  {(detail.partitions || []).map((p) => (
                    <tr key={p.path}>
                      <td>{p.path}</td>
                      <td data-sort={p.capGB}>{p.capGB}</td>
                      <td data-sort={p.usedGB}>{p.usedGB}</td>
                      <td data-sort={p.freeGB}>{p.freeGB}</td>
                      <td data-sort={p.trend?.growthGBPerDay == null ? -9999 : p.trend.growthGBPerDay}>{p.trend?.growthGBPerDay == null ? '—' : p.trend.growthGBPerDay}</td>
                      <td><span style={{ color: trendLabel(p.trend?.trend).color }}>{trendLabel(p.trend?.trend).label}</span></td>
                      <td data-nosort>{p.advice?.label || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </STable>
              <p className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                추이는 관측 시작 이후만 표시합니다(그 이전은 근거 부족). 표본이 2점 미만이면 증가율을 계산하지 않습니다.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
