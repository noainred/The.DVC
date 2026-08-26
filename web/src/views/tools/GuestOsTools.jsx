// GuestOsTools.jsx — SpecialTools.jsx(구 5,070줄)에서 분리(v2.282 대형 파일 분할). 본문은 원본 그대로 이동.
import React, { useEffect, useState } from 'react';
import { fetchJson, postJson, putJson, getToken } from '../../api.js';
import { DataTable, Loading, ErrorBox, Modal, SearchBox, VmLink } from '../../components/ui.jsx';
import { Card, useTool } from './shared.jsx';
import { csvCell as esc } from '../../util/csv.js'; // 수식 인젝션 가드 포함 공통 셀 이스케이프


export function GuestOs({ scope }) {
  const [q, setQ] = useState('');
  const [view, setView] = useState('os'); // os | family | vcenter (v2.328: vCenter별 분해)
  const [power, setPower] = useState('all'); // all | on | off
  const [kind, setKind] = useState('all');   // all | vm | template
  const [vmList, setVmList] = useState(null); // { label, q:{os|family} }
  const [openVc, setOpenVc] = useState(null); // vCenter별 뷰에서 펼친 행(OS 분해)
  const params = { ...(scope ? { vcenterId: scope } : {}), ...(power !== 'all' ? { power } : {}), ...(kind !== 'all' ? { kind } : {}) };
  const { loading, data, error } = useTool('/tools/guest-os', params);
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  const term = q.trim().toLowerCase();
  const num = (n) => (n || 0).toLocaleString();
  const countCell = (r, label, qq) => <button className="cell-link" title="대상 VM 보기 / CSV" onClick={() => setVmList({ label, q: qq })}>{r.total}</button>;
  // v2.328: 할당 코어(vCPU) 열 추가 — 사용자 요구('몇 개의 core 가 할당되어 있는지').
  const osCols = [
    { key: 'os', label: 'Guest OS (종류·버전)', render: (r) => <b>{r.os}</b> },
    { key: 'family', label: '계열', render: (r) => <span className="badge gray">{r.family}</span> },
    { key: 'total', label: 'VM 수', align: 'right', render: (r) => countCell(r, r.os, { os: r.os }) },
    { key: 'vcpu', label: '할당 vCPU', align: 'right', render: (r) => <span className="tabular">{num(r.vcpu)}</span> },
    { key: 'on', label: 'On', align: 'right', render: (r) => <span className="badge green">{r.on}</span> },
    { key: 'off', label: 'Off', align: 'right', render: (r) => <span className="badge gray">{r.off}</span> },
  ];
  const famCols = [
    { key: 'family', label: 'OS 계열', render: (r) => <b>{r.family}</b> },
    { key: 'total', label: 'VM 수', align: 'right', render: (r) => countCell(r, r.family, { family: r.family }) },
    { key: 'vcpu', label: '할당 vCPU', align: 'right', render: (r) => <span className="tabular">{num(r.vcpu)}</span> },
    { key: 'on', label: 'On', align: 'right', render: (r) => <span className="badge green">{r.on}</span> },
  ];
  const rows = view === 'vcenter'
    ? (data.byVcenter || []).filter((r) => !term || (r.name || r.id).toLowerCase().includes(term))
    : (view === 'os' ? data.items : data.families).filter((r) => !term || (r.os || r.family).toLowerCase().includes(term));
  return (
    <>
      <div className="kpis" style={{ marginBottom: 14 }}>
        <Card label="총 VM" value={data.total.toLocaleString()} meta={scope ? '선택 법인' : '전체 법인'} />
        <Card label="총 할당 vCPU" value={num(data.totalVcpu)} meta="Guest 합계" />
        <Card label="OS 종류(버전 포함)" value={data.distinctOs} />
        <Card label="OS 계열" value={data.families.length} meta={data.families.slice(0, 3).map((f) => f.family).join(' · ')} />
      </div>
      <div className="flex gap wrap" style={{ marginBottom: 8, alignItems: 'center' }}>
        <button className={view === 'os' ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '7px 14px' }} onClick={() => setView('os')}>OS·버전별 ({data.items.length})</button>
        <button className={view === 'family' ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '7px 14px' }} onClick={() => setView('family')}>계열별 ({data.families.length})</button>
        <button className={view === 'vcenter' ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '7px 14px' }} onClick={() => setView('vcenter')}>vCenter별 ({(data.byVcenter || []).length})</button>
        <SearchBox className="input" style={{ maxWidth: 260 }} placeholder={view === 'vcenter' ? 'vCenter 이름 검색' : 'OS 이름 검색 (예: Windows, Ubuntu 22)'} value={q} onChange={setQ} />
        <span style={{ width: 8 }} />
        <span className="muted" style={{ fontSize: 12 }}>전원</span>
        {[['all', '전체'], ['on', '켜짐'], ['off', '꺼짐']].map(([k, l]) => (
          <button key={k} className={power === k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '6px 11px', fontSize: 12 }} onClick={() => setPower(k)}>{l}</button>
        ))}
        <span className="muted" style={{ fontSize: 12, marginLeft: 6 }}>종류</span>
        {[['all', '전체'], ['vm', 'VM'], ['template', '템플릿']].map(([k, l]) => (
          <button key={k} className={kind === k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '6px 11px', fontSize: 12 }} onClick={() => setKind(k)}>{l}</button>
        ))}
      </div>
      {view === 'vcenter' ? (
        // vCenter별 — 각 행 클릭 시 그 vCenter의 OS별 VM 수·할당 vCPU 분해를 펼친다(사용자 요구).
        <div className="table-wrap">
          <table>
            <thead><tr><th>vCenter (법인)</th><th style={{ textAlign: 'right' }}>VM 수</th><th style={{ textAlign: 'right' }}>할당 vCPU</th><th style={{ textAlign: 'right' }}>OS 종류</th></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={4} className="center muted" style={{ padding: 16 }}>표시할 vCenter가 없습니다.</td></tr>}
              {rows.map((vc) => (
                <React.Fragment key={vc.id}>
                  <tr style={{ cursor: 'pointer' }} onClick={() => setOpenVc(openVc === vc.id ? null : vc.id)}>
                    <td><b>{openVc === vc.id ? '▾ ' : '▸ '}{vc.name}</b>{vc.region ? <span className="muted" style={{ fontSize: 11 }}> · {vc.region}</span> : ''}</td>
                    <td style={{ textAlign: 'right' }} className="tabular">{num(vc.total)}</td>
                    <td style={{ textAlign: 'right' }} className="tabular">{num(vc.vcpu)}</td>
                    <td style={{ textAlign: 'right' }} className="muted">{(vc.os || []).length}</td>
                  </tr>
                  {openVc === vc.id && (
                    <tr><td colSpan={4} style={{ padding: 0 }}>
                      <table style={{ width: '100%', background: 'rgba(255,255,255,.02)' }}>
                        <thead><tr><th style={{ paddingLeft: 24 }}>Guest OS</th><th>계열</th><th style={{ textAlign: 'right' }}>VM 수</th><th style={{ textAlign: 'right' }}>할당 vCPU</th></tr></thead>
                        <tbody>
                          {(vc.os || []).map((o) => (
                            <tr key={o.os}>
                              <td style={{ paddingLeft: 24 }}>{o.os}</td>
                              <td><span className="badge gray">{o.family}</span></td>
                              <td style={{ textAlign: 'right' }} className="tabular">
                                <button className="cell-link" title="대상 VM 보기 / CSV" onClick={(e) => { e.stopPropagation(); setVmList({ label: `${vc.name} · ${o.os}`, q: { vcenterId: vc.id, os: o.os } }); }}>{num(o.count)}</button>
                              </td>
                              <td style={{ textAlign: 'right' }} className="tabular">{num(o.vcpu)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td></tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <DataTable columns={view === 'os' ? osCols : famCols} rows={rows} initialSort={{ key: 'total', dir: 'desc' }} />
      )}
      {vmList && <GuestOsVmsModal label={vmList.label} params={{ ...params, ...vmList.q }} onClose={() => setVmList(null)} />}
    </>
  );
}

export function GuestOsVmsModal({ label, params, onClose }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [vcf, setVcf] = useState(''); // vCenter 필터(로드된 VM을 vCenter별로 보기)
  useEffect(() => {
    const qs = new URLSearchParams(Object.entries(params || {}).filter(([, v]) => v)).toString();
    fetchJson(`/tools/guest-os/vms${qs ? `?${qs}` : ''}`).then(setD).catch((e) => setErr(e.message));
  }, []);
  const allItems = d?.items || [];
  const vcenters = [...new Set(allItems.map((r) => r.vcenterId).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));
  const items = vcf ? allItems.filter((r) => r.vcenterId === vcf) : allItems;
  const exportCsv = () => {
    const head = ['vm', 'vcenter', 'cluster', 'host', 'cpu', 'memory_gb', 'disk_gb', 'ip', 'power'];
    const lines = [head.join(',')];
    for (const r of items) lines.push([r.name, r.vcenterId, r.cluster, r.host, r.cpu, r.memGB, r.diskGB, r.ip, r.powerState === 'POWERED_ON' ? 'On' : 'Off'].map(esc).join(','));
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `guestos-${String(label).replace(/[^a-zA-Z0-9._-]+/g, '_')}-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); URL.revokeObjectURL(url);
  };
  const cols = [
    { key: 'name', label: 'VM', render: (r) => <VmLink name={r.name} vcenterId={r.vcenterId} label={r.name} /> },
    { key: 'vcenterId', label: 'vCenter', render: (r) => <span className="muted">{r.vcenterId}</span> },
    { key: 'cluster', label: '클러스터', render: (r) => <span style={{ fontSize: 12 }}>{r.cluster || '—'}</span> },
    { key: 'host', label: '호스트', render: (r) => <span className="muted" style={{ fontSize: 12 }}>{r.host || '—'}</span> },
    { key: 'cpu', label: 'CPU', align: 'right', render: (r) => `${r.cpu}` },
    { key: 'memGB', label: 'MEM(GB)', align: 'right' },
    { key: 'diskGB', label: 'DISK(GB)', align: 'right' },
    { key: 'ip', label: 'IP', render: (r) => <span style={{ fontSize: 12 }}>{r.ip || '—'}</span> },
    { key: 'powerState', label: '전원', render: (r) => (r.powerState === 'POWERED_ON' ? <span className="badge green">On</span> : <span className="badge gray">Off</span>) },
  ];
  return (
    <Modal title={`대상 VM — ${label}`} onClose={onClose} width={1040} resizable minWidth={620} minHeight={380}>
      {err ? <ErrorBox message={err} /> : !d ? <Loading /> : (
        <>
          <div className="flex between" style={{ alignItems: 'center', marginBottom: 10, gap: 10, flexWrap: 'wrap' }}>
            <div className="flex" style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span className="muted" style={{ fontSize: 13 }}>
                대상 VM <b>{d.total.toLocaleString()}</b>개{d.total > (d.items?.length || 0) ? ` (상위 ${d.items.length} 로드)` : ''}
                {vcf ? <> · <b>{items.length.toLocaleString()}</b>개 표시</> : null}
              </span>
              {vcenters.length > 1 && (
                <label className="flex" style={{ alignItems: 'center', gap: 6, fontSize: 12 }}>
                  <span className="muted">vCenter</span>
                  <select value={vcf} onChange={(e) => setVcf(e.target.value)} style={{ padding: '4px 8px', fontSize: 12 }}>
                    <option value="">전체 ({vcenters.length})</option>
                    {vcenters.map((vc) => (
                      <option key={vc} value={vc}>{vc} ({allItems.filter((r) => r.vcenterId === vc).length})</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <button className="logout-btn" style={{ flex: 'none', padding: '7px 14px' }} disabled={!items.length} onClick={exportCsv}>⬇ CSV 내보내기</button>
          </div>
          <DataTable columns={cols} rows={items} initialSort={{ key: 'name', dir: 'asc' }} />
        </>
      )}
    </Modal>
  );
}

export function RealOs({ scope }) {
  const [st, setSt] = useState(null);     // /admin/os-scan status+settings
  const [rows, setRows] = useState(null);
  const [mm, setMm] = useState(false);    // 불일치만
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);

  const loadStatus = () => fetchJson('/admin/os-scan').then((r) => { setSt((cur) => ({ ...(cur || {}), ...r, settings: cur?.dirty ? cur.settings : r.settings })); setErr(null); }).catch((e) => setErr(e.message));
  const loadResults = () => fetchJson(`/admin/os-scan/results?${new URLSearchParams({ ...(scope ? { vcenterId: scope } : {}), ...(mm ? { mismatch: '1' } : {}) })}`).then((r) => setRows(r.items || [])).catch(() => setRows([]));
  useEffect(() => { loadStatus(); /* eslint-disable-next-line */ }, []);
  useEffect(() => { loadResults(); /* eslint-disable-next-line */ }, [scope, mm]);

  if (err) return <ErrorBox message={err} />;
  if (!st) return <Loading />;
  const s = st.settings || {};
  const setS = (patch) => setSt((cur) => ({ ...cur, dirty: true, settings: { ...cur.settings, ...patch } }));

  const saveSettings = async () => { setBusy('save'); setMsg(null); try { const r = await putJson('/admin/os-scan/settings', s); setSt((c) => ({ ...c, ...r, dirty: false })); setMsg('저장됨'); } catch (e) { setMsg(e.message); } finally { setBusy(''); } };
  const runNow = async () => { setBusy('run'); setMsg(null); try { const r = await postJson('/admin/os-scan/run', scope ? { vcenterId: scope } : {}); setMsg(r.ok ? `스캔 완료 — 탐지 ${r.found ?? 0}건` : `오류: ${r.reason || '실패'}`); await loadStatus(); await loadResults(); } catch (e) { setMsg(e.message); } finally { setBusy(''); } };
  const exportCsv = async () => {
    const qs = new URLSearchParams({ ...(scope ? { vcenterId: scope } : {}), ...(mm ? { mismatch: '1' } : {}) }).toString();
    const res = await fetch(`/api/admin/os-scan/results.csv${qs ? `?${qs}` : ''}`, { headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {} });
    const blob = await res.blob(); const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `real-os-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); URL.revokeObjectURL(url);
  };

  const sum = st.summary || {};
  const cols = [
    { key: 'vmName', label: 'VM', render: (r) => <VmLink name={r.vmName} vcenterId={r.vcenterId} label={r.vmName} /> },
    { key: 'vcenterId', label: 'vCenter', render: (r) => <span className="muted">{r.vcenterId}</span> },
    { key: 'host', label: '호스트', render: (r) => <span className="muted" style={{ fontSize: 12, maxWidth: 160, display: 'inline-block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }} title={r.host}>{r.host || '—'}</span> },
    { key: 'esxiGuestOS', label: 'ESXi 보고', render: (r) => <span style={{ fontSize: 12 }}>{r.esxiGuestOS || '—'}</span> },
    { key: 'os', label: '실제 OS', render: (r) => (r.os ? <b>{r.os}</b> : <span className="badge red" title={r.error}>실패</span>) },
    { key: 'osVersion', label: '버전', render: (r) => r.osVersion || '—' },
    { key: 'family', label: '계열', render: (r) => r.family ? <span className="badge gray">{r.family}</span> : '—' },
    { key: 'mismatch', label: '불일치', sortValue: (r) => (r.mismatch ? 1 : 0), render: (r) => (r.mismatch ? <span className="badge amber">불일치</span> : (r.os ? <span className="badge green">일치</span> : '—')) },
    { key: 'at', label: '스캔', render: (r) => <span className="muted" style={{ fontSize: 11 }}>{r.at ? new Date(r.at).toLocaleString('ko-KR') : '—'}</span> },
  ];

  return (
    <>
      <div className="kpis" style={{ marginBottom: 14 }}>
        <Card label="스캔된 VM" value={(sum.scanned ?? 0).toLocaleString()} meta={st.lastRun ? `마지막 ${new Date(st.lastRun).toLocaleString('ko-KR')}` : '아직 실행 안 함'} />
        <Card label="불일치(ESXi≠실제)" value={sum.mismatches ?? 0} accent={sum.mismatches ? 'var(--amber)' : ''} meta="ESXi 보고와 실제 설치 OS 차이" />
        <Card label="탐지 실패" value={sum.errors ?? 0} accent={sum.errors ? 'var(--red)' : ''} meta="계정/Tools/권한 등" />
        <Card label="계열 분포" value={(sum.byFamily || []).length} meta={(sum.byFamily || []).slice(0, 3).map((f) => `${f.family} ${f.count}`).join(' · ')} />
      </div>

      <div className="card" style={{ padding: 14, marginBottom: 12 }}>
        <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>게스트 OS에서 <code>/etc/os-release</code>·<code>/etc/redhat-release</code>(Linux)·<code>Win32_OperatingSystem</code>(Windows)를 직접 읽어 <b>실제 설치 OS</b>를 확인합니다(ESXi 보고값과 별개). 계정은 <b>설정 › GPU 게스트 수집</b>의 OS별 계정을 사용합니다. 상단 <b>vCenter 선택</b>이 스캔 범위입니다.</p>
        <div className="flex gap wrap" style={{ alignItems: 'center', gap: 14 }}>
          <label className="flex gap" style={{ alignItems: 'center', cursor: 'pointer' }}><input type="checkbox" checked={!!s.enabled} onChange={(e) => setS({ enabled: e.target.checked })} /> <b>주기 스캔</b></label>
          <span className="muted">주기</span><input className="input" type="number" min={5} style={{ width: 90 }} value={s.intervalMin} onChange={(e) => setS({ intervalMin: e.target.value })} /><span className="muted">분</span>
          <span className="muted">최대</span><input className="input" type="number" min={1} style={{ width: 80 }} value={s.maxVms} onChange={(e) => setS({ maxVms: e.target.value })} /><span className="muted">대/회</span>
          <span className="muted">재스캔</span><input className="input" type="number" min={0} style={{ width: 70 }} value={s.rescanDays} onChange={(e) => setS({ rescanDays: e.target.value })} /><span className="muted">일(0=안함)</span>
          <span className="muted">동시</span><input className="input" type="number" min={1} max={16} style={{ width: 56 }} value={s.concurrency} onChange={(e) => setS({ concurrency: e.target.value })} />
        </div>
        <div className="flex gap" style={{ marginTop: 12, alignItems: 'center' }}>
          <button className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} disabled={busy === 'save'} onClick={saveSettings}>설정 저장</button>
          <button className="logout-btn" style={{ padding: '8px 16px' }} disabled={busy === 'run'} onClick={runNow}>{busy === 'run' ? '스캔 중…' : `지금 스캔 (${scope || '전체 vCenter'})`}</button>
          {st.lastErr ? <span className="muted" style={{ fontSize: 12, color: 'var(--amber)' }}>최근 오류: {st.lastErr.slice(0, 60)}</span> : null}
          {msg && <span className="muted" style={{ fontSize: 13 }}>{msg}</span>}
        </div>
      </div>

      <div className="flex gap wrap" style={{ marginBottom: 8, alignItems: 'center' }}>
        <button className={mm ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '7px 14px' }} onClick={() => setMm((v) => !v)}>{mm ? '불일치만 ✓' : '불일치만 보기'}</button>
        <span className="muted" style={{ fontSize: 12 }}>{rows ? `${rows.length}건` : ''}</span>
        <button className="logout-btn" style={{ flex: 'none', padding: '7px 14px', marginLeft: 'auto' }} disabled={!rows?.length} onClick={exportCsv}>⬇ CSV 내보내기</button>
      </div>
      {!rows ? <Loading /> : rows.length === 0 ? <div className="card"><span className="muted">{mm ? '불일치 VM이 없습니다.' : '스캔 결과가 없습니다. ‘지금 스캔’을 실행하세요(계정은 GPU 게스트 수집 설정 사용).'}</span></div>
        : <DataTable columns={cols} rows={rows} initialSort={{ key: 'mismatch', dir: 'desc' }} />}
    </>
  );
}
