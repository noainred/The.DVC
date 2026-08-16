import React, { useEffect, useMemo, useState } from 'react';
import { fetchJson, postJson, delJson } from '../../api.js';
import { Loading, ErrorBox, Kpi, UsageCell, Modal } from '../../components/ui.jsx';

/**
 * 특수기능 › 스토리지 모니터링(v2.302) — 글로벌 법인 스토리지(Isilon 우선, XtremIO·PowerStore·
 * PowerMax 등 확장 예정)의 사용량·버전·계정·노드 상태를 중앙에서 통합 조회.
 *
 * 데이터 흐름(사용자 설계 요구): 중앙에서 장비+수집 주체(엣지) 등록 → 엣지가 자기 몫을 pull →
 * 현지에서 OneFS API 수집 → 정규화 스냅샷을 중앙으로 push → 이 화면이 법인별/타입별/장비별로
 * 그룹핑해 표시(그룹핑은 프론트 — 뷰 추가에 서버 변경 불필요).
 * 조회는 전체 범위 계정 전용(서버 403 — 스토리지는 vCenter 범위 개념 밖), 등록/삭제는 admin.
 */
const tbFmt = (bytes) => {
  const tb = (Number(bytes) || 0) / 1024 ** 4;
  return tb >= 1024 ? `${(tb / 1024).toFixed(2)} PB` : `${tb.toFixed(1)} TB`;
};
// bps 표기(isi status 스타일 — k/M/G). null 은 '—'(수집 실패를 0 으로 위장하지 않음).
const bps = (v) => (v == null ? '—' : v >= 1e9 ? `${(v / 1e9).toFixed(1)}G` : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : String(Math.round(v)));
// 미디어 풀 셀(HDD/SSD 공용) — 사용/전체(%). null = 해당 미디어 없음(무디스크 노드 등).
const MediaCell = ({ m }) => (m ? <span title={`${tbFmt(m.usedBytes)} / ${tbFmt(m.totalBytes)}`}><UsageCell pct={m.pct ?? 0} /><span className="muted" style={{ fontSize: 10.5, display: 'block' }}>{tbFmt(m.usedBytes)}/{tbFmt(m.totalBytes)}</span></span> : <span className="muted">—</span>);
const ago = (ts) => {
  if (!ts) return '—';
  const s = Math.round((Date.now() - ts) / 1000);
  return s < 60 ? `${s}초 전` : s < 3600 ? `${Math.round(s / 60)}분 전` : `${Math.round(s / 3600)}시간 전`;
};

export default function StorageMonTool() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState('devices');   // devices | dc | type
  const [detail, setDetail] = useState(null);    // 장비 상세 모달 — id 로 보관(v2.306: load() 후 최신 스냅샷 자동 반영)
  const [form, setForm] = useState(null);        // 등록/수정 폼

  const load = () => fetchJson('/tools/storage').then((r) => { setD(r); setErr(null); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, []);
  if (err && !d) return <ErrorBox message={err} />;
  if (!d) return <Loading />;

  const rows = d.devices || [];
  const dcName = (id) => ((d.datacenters || []).find((x) => x.id === id)?.name || id || '미지정');
  const typeLabel = (t) => ((d.types || []).find((x) => x.type === t)?.label || t);
  const sum = (list, f) => list.reduce((a, x) => a + (f(x) || 0), 0);
  const withSnap = rows.filter((r) => r.snap);
  const totals = {
    total: sum(withSnap, (r) => r.snap.capacity?.totalBytes),
    used: sum(withSnap, (r) => r.snap.capacity?.usedBytes),
    fail: rows.filter((r) => r.snap && !r.snap.ok).length + rows.filter((r) => !r.snap).length,
    alerts: sum(withSnap, (r) => r.snap.alerts?.unresolved),
  };
  // 그룹핑(법인별/타입별) — 서버 평탄 목록을 프론트에서 묶는다(뷰 확장 자유).
  const groupBy = (keyFn) => {
    const m = new Map();
    for (const r of rows) { const k = keyFn(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
    return [...m.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  };

  const collectNow = async (id) => {
    setBusy(true); setMsg(null);
    try { const r = await postJson(`/tools/storage/devices/${encodeURIComponent(id)}/collect`, {}); setMsg(r.ok ? '수집 완료 — 갱신됨' : r.reason); await load(); }
    catch (e) { setMsg(`오류: ${e.message}`); } finally { setBusy(false); }
  };
  const remove = async (r) => {
    if (!window.confirm(`'${r.name}' (${r.host}) 장비를 삭제할까요? (수집 이력 스냅샷도 화면에서 제거)`)) return;
    setBusy(true); try { await delJson(`/tools/storage/devices/${encodeURIComponent(r.id)}`); await load(); } catch (e) { setMsg(`오류: ${e.message}`); } finally { setBusy(false); }
  };

  const DeviceRow = ({ r }) => {
    const s = r.snap;
    return (
      <tr key={r.id} style={{ opacity: r.enabled === false ? 0.5 : 1 }}>
        <td><button className="cell-link" onClick={() => setDetail(r.id)}><b>{s?.name || r.name}</b></button><div className="muted" style={{ fontSize: 11 }}>{r.host}</div></td>
        <td><span className="badge blue">{typeLabel(r.type)}</span></td>
        <td className="muted">{dcName(r.datacenterId)}</td>
        <td>{r.agent ? <span className="badge" style={{ background: 'rgba(167,139,250,.2)', color: '#a78bfa' }}>{r.agent}</span> : <span className="muted">중앙</span>}
          {r.type === 'isilon' && <span className={`badge ${r.collectMethod === 'api' ? 'blue' : 'gray'}`} style={{ marginLeft: 4, fontSize: 10 }} title="이 장비의 수집 방식(등록에서 변경)">{r.collectMethod === 'api' ? 'API' : 'SSH'}</span>}</td>
        <td className="muted" style={{ fontSize: 12 }}>{s?.version || '—'}</td>
        <td style={{ minWidth: 140 }}>{s?.capacity?.pct != null ? <UsageCell pct={s.capacity.pct} /> : <span className="muted">—</span>}
          {s?.capacity?.totalBytes ? <div className="muted" style={{ fontSize: 10.5 }}>{tbFmt(s.capacity.usedBytes)} / {tbFmt(s.capacity.totalBytes)}</div> : null}</td>
        {/* HDD/SSD 풀 분리(v2.303, 사용자 요구 — isi status 의 Cluster Storage HDD/SSD 컬럼) */}
        <td style={{ minWidth: 120 }}><MediaCell m={s?.media?.hdd} /></td>
        <td style={{ minWidth: 120 }}><MediaCell m={s?.media?.ssd} /></td>
        <td style={{ textAlign: 'right' }}>{s ? `${s.nodes?.count ?? 0}${s.nodes?.unhealthy ? ` (⚠${s.nodes.unhealthy})` : ''}` : '—'}</td>
        <td style={{ textAlign: 'right' }}>{s?.accounts?.length ?? '—'}</td>
        <td>{!s ? <span className="badge gray">수집 전</span> : s.ok ? <span className="badge green">정상</span> : <span className="badge red" title={s.error}>실패</span>}
          <div className="muted" style={{ fontSize: 10.5 }}>{ago(s?.collectedAt)}{s?.agent ? ` · ${s.agent}` : ''}</div></td>
        <td className="right" style={{ whiteSpace: 'nowrap' }}>
          <button className="logout-btn" style={{ padding: '3px 8px', fontSize: 11.5 }} disabled={busy} onClick={() => collectNow(r.id)} title={r.agent ? '엣지 수집 장비 — 주기 반영 안내' : '지금 수집(연결 테스트)'}>수집</button>
          {' '}<button className="logout-btn" style={{ padding: '3px 8px', fontSize: 11.5 }} disabled={busy} onClick={() => setForm({ ...r, password: '' })}>수정</button>
          {' '}<button className="logout-btn" style={{ padding: '3px 8px', fontSize: 11.5, color: 'var(--red)' }} disabled={busy} onClick={() => remove(r)}>삭제</button>
        </td>
      </tr>
    );
  };
  const DeviceTable = ({ list }) => (
    <div className="table-wrap" style={{ maxHeight: '52vh' }}>
      <table>
        <thead><tr><th>장비</th><th>타입</th><th>법인</th><th>수집</th><th>버전</th><th>사용률(전체)</th><th>HDD 풀</th><th>SSD 풀</th><th style={{ textAlign: 'right' }}>노드</th><th style={{ textAlign: 'right' }}>계정</th><th>상태</th><th className="right">작업</th></tr></thead>
        <tbody>
          {list.length === 0 && <tr><td colSpan={12} className="center muted" style={{ padding: 20 }}>등록된 장비가 없습니다 — "+ 장비 등록"으로 시작하세요.</td></tr>}
          {list.map((r) => <DeviceRow key={r.id} r={r} />)}
        </tbody>
      </table>
    </div>
  );

  return (
    <div>
      <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 12 }}>
        <button className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} onClick={() => setForm({ type: 'isilon', name: '', host: '', username: 'root', password: '', agent: '', datacenterId: '', collectMethod: 'ssh', sshPort: 22, enabled: true })}>+ 장비 등록</button>
        {['devices', 'dc', 'type'].map((v) => (
          <button key={v} className={view === v ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '7px 13px' }} onClick={() => setView(v)}>
            {v === 'devices' ? '🗄 장비별' : v === 'dc' ? '🏢 법인별' : '📦 타입별'}
          </button>
        ))}
        {msg && <span className="muted" style={{ fontSize: 12.5 }}>{msg}</span>}
      </div>

      {/* 요약 KPI — 전 법인 합산 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 14 }}>
        <Kpi label="장비" value={rows.length} meta={`수집됨 ${withSnap.length}`} />
        <Kpi label="총 용량" value={tbFmt(totals.total)} />
        <Kpi label="사용" value={tbFmt(totals.used)} pct={totals.total ? Math.round((totals.used / totals.total) * 100) : 0} />
        <Kpi label="수집 실패/대기" value={totals.fail} accent={totals.fail ? 'var(--red)' : 'var(--green)'} />
        <Kpi label="미해결 경보" value={totals.alerts} accent={totals.alerts ? 'var(--amber)' : undefined} />
      </div>

      {form && <DeviceForm d={d} form={form} setForm={setForm} onSaved={() => { setForm(null); load(); }} />}

      {view === 'devices' && <DeviceTable list={rows} />}
      {view === 'dc' && groupBy((r) => dcName(r.datacenterId)).map(([dc, list]) => {
        const t = sum(list.filter((r) => r.snap), (r) => r.snap.capacity?.totalBytes);
        const u = sum(list.filter((r) => r.snap), (r) => r.snap.capacity?.usedBytes);
        return (
          <div key={dc} style={{ marginBottom: 14 }}>
            <div className="section-title" style={{ fontSize: 14 }}>🏢 {dc} <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>— 장비 {list.length} · {tbFmt(u)} / {tbFmt(t)}{t ? ` (${Math.round((u / t) * 100)}%)` : ''}</span></div>
            <DeviceTable list={list} />
          </div>
        );
      })}
      {view === 'type' && groupBy((r) => typeLabel(r.type)).map(([ty, list]) => (
        <div key={ty} style={{ marginBottom: 14 }}>
          <div className="section-title" style={{ fontSize: 14 }}>📦 {ty} <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>— 장비 {list.length}</span></div>
          <DeviceTable list={list} />
        </div>
      ))}

      {(d.orphans || []).length > 0 && (
        <div className="card" style={{ padding: '9px 13px', marginTop: 8, borderColor: 'var(--amber)', fontSize: 12 }}>
          ⚠ 등록부에 없는 스냅샷 {d.orphans.length}건(삭제된 장비의 엣지 잔존 push) — 다음 엣지 push 주기에 자연 소멸합니다.
        </div>
      )}
      <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
        수집 주기 {Math.round((d.poller?.intervalMs || 0) / 60000)}분 · 엣지 장비는 config pull(≤5분) 후 현지 수집 → 중앙 push(≤5분).
        확장 로드맵(카탈로그): {(d.types || []).filter((t) => !t.implemented).map((t) => t.label).join(' · ')} — 수집기 구현 시 이 화면 변경 없이 표시됩니다.
      </div>

      {detail && (() => {
        const row = rows.find((x) => x.id === detail);
        if (!row) return null; // 새로고침 사이에 삭제된 장비 — 모달 조용히 닫힘 방지 위해 null
        return <DeviceDetail r={row} typeLabel={typeLabel} dcName={dcName} onClose={() => setDetail(null)}
          onRefresh={async () => { const res = await postJson(`/tools/storage/devices/${encodeURIComponent(row.id)}/collect`, {}); await load(); return res; }} />;
      })()}
    </div>
  );
}

/** 장비 상세 모달 — 정규화 스냅샷 전부(풀·계정·섹션별 수집 상태·경보). */
function DeviceDetail({ r, typeLabel, dcName, onClose, onRefresh }) {
  const s = r.snap;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [areaView, setAreaView] = useState(null); // OneFS API 영역 원문 뷰(v2.308) — 배지 클릭
  const refresh = async () => {
    setBusy(true); setMsg(null);
    try {
      const res = await onRefresh();
      setMsg(res?.ok ? '수집 완료 — 최신 상태로 갱신됨' : (res?.reason || '수집 실패'));
    } catch (e) { setMsg(`오류: ${e.message}`); }
    finally { setBusy(false); }
  };
  // 폭 900(v2.310, 사용자 요구 — 실화면 덤프 기준 열 간 공백 과다): v2.306 에서 가로 스크롤
  // 제거를 위해 1100 으로 넓혔으나 실제 렌더 결과 노드 표 열 사이 빈 공간이 커서 압축.
  // 노드 표 실제 콘텐츠 폭(모노스페이스 수치 포함)은 ~700px 이라 900 에서도 가로 스크롤 없음.
  return (
    <Modal title={`${typeLabel(r.type)} — ${s?.name || r.name}`} onClose={onClose} width={900}>
      {/* 새로고침(v2.306, 사용자 요구) — 중앙 수집 장비는 즉시 재수집, 엣지 장비는 주기 안내(202 사유) */}
      <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 10 }}>
        <button className="login-btn" style={{ flex: 'none', padding: '6px 14px', fontSize: 12.5 }} disabled={busy} onClick={refresh}>
          {busy ? '수집 중…' : '↻ 새로고침(지금 수집)'}
        </button>
        {msg && <span className="muted" style={{ fontSize: 12 }}>{msg}</span>}
      </div>
      {!s ? <div className="muted" style={{ padding: 8 }}>아직 수집된 스냅샷이 없습니다(첫 수집 주기 대기).</div> : (
        <>
          <div className="flex gap wrap" style={{ fontSize: 12.5, marginBottom: 10 }}>
            <span className="muted">호스트 <b style={{ color: 'var(--text)' }}>{r.host}</b></span>
            <span className="muted">법인 <b style={{ color: 'var(--text)' }}>{dcName(r.datacenterId)}</b></span>
            <span className="muted">버전 <b style={{ color: 'var(--text)' }}>{s.version || '—'}</b></span>
            <span className="muted">시리얼/GUID <b style={{ color: 'var(--text)' }}>{s.serial || '—'}</b></span>
            <span className="muted">수집 {new Date(s.collectedAt).toLocaleString('ko-KR')}{s.agent ? ` · 엣지 ${s.agent}` : ' · 중앙'}{s.extra?.collectMethod ? ` · ${s.extra.collectMethod.toUpperCase()}` : ''}</span>
          </div>
          {/* 타입 고유 헬스 노출(v2.311 적대적 검증 반영 — 수집·테스트까지 된 장애 신호가 UI 에서
              사장되던 결함 수정): VPLEX/Metro Node 클러스터별 헬스(degraded/critical-failure 가
              디렉터 정상일 때도 보이게), XtremIO 시스템 헬스. */}
          {Array.isArray(s.extra?.clusters) && s.extra.clusters.length > 0 && (
            <div className="flex gap wrap" style={{ fontSize: 12.5, marginBottom: 10 }}>
              {s.extra.clusters.map((c, i) => (
                <span key={i} className={`badge ${c.health === 'ok' ? 'green' : c.health === 'unknown' ? 'gray' : 'red'}`} title={c.operational ? `operational: ${c.operational}` : undefined}>
                  {c.name}: {String(c.health || '?').toUpperCase()}
                </span>
              ))}
            </div>
          )}
          {s.extra?.healthState && !s.extra?.clusterHealth && (
            <div className="flex gap wrap" style={{ fontSize: 12.5, marginBottom: 10 }}>
              <span className={`badge ${String(s.extra.healthState).toLowerCase() === 'healthy' ? 'green' : 'red'}`}>Health: {s.extra.healthState}</span>
              {s.extra.dataReduction && <span className="muted">Data Reduction <b style={{ color: 'var(--text)' }}>{s.extra.dataReduction}</b></span>}
            </div>
          )}
          {/* SSH(isi status) 모드 부가 정보(v2.304) — 사용자 화면 상단 블록과 동일 항목 */}
          {(s.extra?.clusterHealth || s.extra?.dataReduction || s.extra?.vhsBytes > 0) && !s.extra?.healthState && (
            <div className="flex gap wrap" style={{ fontSize: 12.5, marginBottom: 10 }}>
              {s.extra.clusterHealth && <span className={`badge ${s.extra.clusterHealth === 'OK' ? 'green' : 'red'}`}>Cluster Health: {s.extra.clusterHealth}</span>}
              {s.extra.dataReduction && <span className="muted">Data Reduction <b style={{ color: 'var(--text)' }}>{s.extra.dataReduction}</b></span>}
              {s.extra.storageEfficiency && <span className="muted">Storage Efficiency <b style={{ color: 'var(--text)' }}>{s.extra.storageEfficiency}</b></span>}
              {s.extra.vhsBytes > 0 && <span className="muted">VHS <b style={{ color: 'var(--text)' }}>{tbFmt(s.extra.vhsBytes)}</b></span>}
              {s.extra.l3TotalBytes > 0 && <span className="muted">L3 캐시 합계 <b style={{ color: 'var(--text)' }}>{tbFmt(s.extra.l3TotalBytes)}</b></span>}
            </div>
          )}
          {s.error && <div className="card" style={{ borderColor: 'var(--red)', padding: '8px 12px', marginBottom: 10, fontSize: 12.5, color: 'var(--red)' }}>⛔ {s.error}</div>}

          {/* HDD/SSD 풀 요약(v2.303) — isi status Cluster Storage 와 동일 의미 */}
          {s.media && (
            <div className="flex gap wrap" style={{ marginBottom: 12 }}>
              {[['HDD 풀', s.media.hdd], ['SSD 풀', s.media.ssd]].map(([lb, m]) => (
                <div key={lb} className="card" style={{ padding: '8px 12px', minWidth: 170 }}>
                  <div className="muted" style={{ fontSize: 12 }}>{lb}</div>
                  {m ? <>
                    <div style={{ fontSize: 15, fontWeight: 700 }}>{tbFmt(m.usedBytes)} <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>/ {tbFmt(m.totalBytes)}</span></div>
                    <UsageCell pct={m.pct ?? 0} />
                  </> : <div className="muted">없음</div>}
                </div>
              ))}
            </div>
          )}

          {/* 노드별 상세(v2.303, 사용자 요구 — isi status 노드 표): ID·IP·상태·외부망 처리량·노드별 HDD/SSD
              v2.310 검증 반영: XtremIO 컨트롤러/Unity SP/PowerStore 노드는 name 이 유일 식별자인데
              (id 는 수집기 합성 순번, ip 는 비어 있을 수 있음) 표가 name 을 안 그려 사장됐다 —
              하나라도 name 이 있으면 '이름' 열을 추가한다(isilon 은 name 없음 → 열 미표시로 기존 유지). */}
          {(s.nodes?.list || []).length > 0 && (() => { const hasName = s.nodes.list.some((n) => n.name); return (
            <>
              <div className="section-title" style={{ fontSize: 13 }}>노드 {s.nodes.list.length}{s.nodes.count > s.nodes.list.length ? ` (표시 상한 — 전체 ${s.nodes.count})` : ''}</div>
              <div className="table-wrap" style={{ maxHeight: '32vh', marginBottom: 12 }}>
                <table>
                  {/* 고정폭 열 명시(v2.310 공백 압축) — width:100% 표의 잉여 공간이 수치 열 사이에
                      균등 분산돼 열 간 공백이 커지는 것을 방지(잉여는 IP·HDD/SSD 텍스트 열이 흡수). */}
                  <thead><tr><th style={{ textAlign: 'right', width: 40 }}>ID</th>{hasName && <th>이름</th>}<th>IP</th><th style={{ width: 56 }}>상태</th><th style={{ width: 44 }}>Ext</th><th style={{ textAlign: 'right', width: 84 }}>In(bps)</th><th style={{ textAlign: 'right', width: 84 }}>Out(bps)</th><th>HDD Used/Size</th><th>SSD Used/Size</th></tr></thead>
                  <tbody>
                    {s.nodes.list.map((n) => (
                      <tr key={n.id}>
                        <td style={{ textAlign: 'right' }}>{n.id}</td>
                        {hasName && <td style={{ whiteSpace: 'nowrap' }}>{n.name || '—'}</td>}
                        <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{n.ip || '—'}</td>
                        <td><span className={`badge ${/ok|healthy|up|green/.test(n.health) ? 'green' : n.health === 'unknown' ? 'gray' : 'red'}`}>{n.health === 'unknown' ? '?' : n.health.toUpperCase()}</span></td>
                        <td>{n.ext ? <span className={`badge ${n.ext === 'C' ? 'green' : 'red'}`} title="C=Connected · N=Not Connected">{n.ext}</span> : <span className="muted">—</span>}</td>
                        <td style={{ textAlign: 'right', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{bps(n.inBps)}</td>
                        <td style={{ textAlign: 'right', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{bps(n.outBps)}</td>
                        {/* 'No Storage HDDs' 는 isilon(isi status) 전용 문구 — 타 타입의 hdd null 은 '—' */}
                        <td style={{ whiteSpace: 'nowrap' }}>{n.hdd ? `${tbFmt(n.hdd.usedBytes)}/${tbFmt(n.hdd.totalBytes)} (${n.hdd.pct}%)` : <span className="muted">{r.type === 'isilon' ? 'No Storage HDDs' : '—'}</span>}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{n.ssd ? `${tbFmt(n.ssd.usedBytes)}/${tbFmt(n.ssd.totalBytes)} (${n.ssd.pct}%)` : n.l3Bytes > 0 ? <span className="muted">L3: {tbFmt(n.l3Bytes)}</span> : <span className="muted">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ); })()}

          {(s.pools || []).length > 0 && (
            <>
              <div className="section-title" style={{ fontSize: 13 }}>스토리지 풀 {s.pools.length}</div>
              <table className="data-table" style={{ width: '100%', fontSize: 12.5, marginBottom: 12 }}>
                <thead><tr><th style={{ textAlign: 'left' }}>풀</th><th style={{ textAlign: 'right' }}>사용</th><th style={{ textAlign: 'right' }}>전체</th><th>사용률</th></tr></thead>
                <tbody>{s.pools.map((p, i) => (
                  <tr key={i}><td>{p.name}</td><td style={{ textAlign: 'right' }}>{tbFmt(p.usedBytes)}</td><td style={{ textAlign: 'right' }}>{tbFmt(p.totalBytes)}</td><td>{p.pct != null ? <UsageCell pct={p.pct} /> : '—'}</td></tr>
                ))}</tbody>
              </table>
            </>
          )}
          {(s.accounts || []).length > 0 && (
            <>
              <div className="section-title" style={{ fontSize: 13 }}>계정 {s.accounts.length}{s.accounts.length >= 200 ? '+(상한 절단)' : ''}</div>
              <div className="flex gap wrap" style={{ marginBottom: 12 }}>
                {s.accounts.map((a, i) => <span key={i} className={`badge ${a.enabled ? 'gray' : 'red'}`}>{a.name}{a.enabled ? '' : ' (비활성)'}</span>)}
              </div>
            </>
          )}
          {/* Critical Events + Cluster Job Status(v2.307, 사용자 요구 — isi status 꼬리 섹션) */}
          {s.extra?.criticalEvents && (
            <>
              <div className="section-title" style={{ fontSize: 13 }}>Critical Events {s.extra.criticalEvents.length}</div>
              {s.extra.criticalEvents.length === 0
                ? <div className="muted" style={{ fontSize: 12.5, marginBottom: 12 }}>✅ 미해결 Critical 이벤트 없음</div>
                : (
                  <div className="table-wrap" style={{ maxHeight: '20vh', marginBottom: 12 }}>
                    <table>
                      <thead><tr><th>시각</th><th style={{ textAlign: 'right' }}>LNN</th><th>이벤트</th></tr></thead>
                      <tbody>{s.extra.criticalEvents.map((e, i) => (
                        <tr key={i}><td style={{ whiteSpace: 'nowrap', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{e.time}</td><td style={{ textAlign: 'right' }}>{e.lnn}</td><td style={{ fontSize: 12.5, color: 'var(--red)' }}>{e.event}</td></tr>
                      ))}</tbody>
                    </table>
                  </div>
                )}
            </>
          )}
          {s.extra?.jobs && (
            <>
              <div className="section-title" style={{ fontSize: 13 }}>Cluster Job Status
                <span className="muted" style={{ fontSize: 11.5, fontWeight: 400 }}> — 실행 {s.extra.jobs.running.length} · 대기 {s.extra.jobs.paused.length} · 실패 {s.extra.jobs.failed.length}</span>
              </div>
              {(s.extra.jobs.running.length + s.extra.jobs.paused.length + s.extra.jobs.failed.length) === 0
                ? <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>실행/대기/실패 잡 없음</div>
                : (
                  <div className="table-wrap" style={{ maxHeight: '22vh', marginBottom: 8 }}>
                    <table>
                      <thead><tr><th>잡</th><th>구분</th><th>Impact</th><th style={{ textAlign: 'right' }}>Pri</th><th>Policy</th><th>Phase</th><th>Run Time</th></tr></thead>
                      <tbody>
                        {s.extra.jobs.running.map((j, i) => (
                          <tr key={`r${i}`}><td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{j.job}</td><td><span className="badge amber">실행 중</span></td><td>{j.impact}</td><td style={{ textAlign: 'right' }}>{j.pri}</td><td>{j.policy}</td><td>{j.phase}</td><td style={{ whiteSpace: 'nowrap' }}>{j.runTime}</td></tr>
                        ))}
                        {s.extra.jobs.paused.map((j, i) => (
                          <tr key={`p${i}`}><td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{j.job}</td><td><span className="badge gray">{j.state || '대기'}</span></td><td>{j.impact}</td><td style={{ textAlign: 'right' }}>{j.pri}</td><td>{j.policy}</td><td>{j.phase}</td><td style={{ whiteSpace: 'nowrap' }}>{j.runTime}</td></tr>
                        ))}
                        {s.extra.jobs.failed.map((j, i) => (
                          <tr key={`f${i}`}><td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{j.job}</td><td><span className="badge red">실패</span></td><td colSpan={5} style={{ fontSize: 12 }}>{j.detail}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              {s.extra.jobs.recent.length > 0 && (
                <>
                  <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>최근 잡 결과 {s.extra.jobs.recent.length}건</div>
                  <div className="table-wrap" style={{ maxHeight: '18vh', marginBottom: 12 }}>
                    <table>
                      <thead><tr><th>시각</th><th>잡</th><th>결과</th></tr></thead>
                      <tbody>{s.extra.jobs.recent.map((j, i) => (
                        <tr key={i}><td style={{ whiteSpace: 'nowrap', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{j.time}</td><td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{j.job}</td><td><span className={`badge ${/succeeded/i.test(j.event) ? 'green' : 'red'}`}>{j.event}</span></td></tr>
                      ))}</tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          )}

          {/* OneFS API 전 영역 수집(v2.308, 사용자 40개 표) — 요약은 push 로 전 장비, 원문은
              수집 노드 DB(중앙 수집 장비만 이 화면에서 열람 — 엣지 원문은 엣지 DB, 안내 표시). */}
          {s.extra?.areas && (
            <>
              <div className="section-title" style={{ fontSize: 13 }}>OneFS API 영역 수집 {s.extra.areas.filter((a) => !a.skipped).length}
                <span className="muted" style={{ fontSize: 11, fontWeight: 400 }}> — 엔드포인트 {s.extra.areasEndpoints ?? '—'}개 · {s.extra.areasAt ? new Date(s.extra.areasAt).toLocaleString('ko-KR') : ''} · 원문은 수집 노드 DB 저장</span>
              </div>
              <div className="flex gap wrap" style={{ marginBottom: 8 }}>
                {s.extra.areas.map((a) => (
                  <span key={a.area} className={`badge ${a.skipped ? 'gray' : a.failed === 0 ? 'green' : a.ok > 0 ? 'amber' : 'red'}`}
                    title={a.error || `성공 ${a.ok} · 실패 ${a.failed}`} style={{ fontSize: 10.5, cursor: !a.skipped && !r.agent ? 'pointer' : 'default' }}
                    onClick={() => { if (!a.skipped && !r.agent) setAreaView(a.area); }}>
                    {a.area}{a.skipped ? ' (비활성)' : a.failed ? ` ${a.ok}/${a.ok + a.failed}` : ''}
                  </span>
                ))}
              </div>
              {r.agent
                ? <div className="muted" style={{ fontSize: 11, marginBottom: 12 }}>이 장비는 엣지 '{r.agent}' 가 수집 — API 원문은 엣지 포탈의 DB 에 저장됩니다(여기는 요약만).</div>
                : <div className="muted" style={{ fontSize: 11, marginBottom: 12 }}>배지를 클릭하면 저장된 원문(JSON)을 봅니다.</div>}
              {areaView && !r.agent && <AreaJsonViewer deviceId={r.id} area={areaView} onClose={() => setAreaView(null)} />}
            </>
          )}

          <div className="section-title" style={{ fontSize: 13 }}>섹션별 수집 상태 <span className="muted" style={{ fontSize: 11, fontWeight: 400 }}>— 부분 실패를 숨기지 않습니다(버전별 API 차이 진단용)</span></div>
          <div className="flex gap wrap">
            {Object.entries(s.sections || {}).map(([k, v]) => (
              <span key={k} className={`badge ${v === 'ok' ? 'green' : v === 'skip' ? 'gray' : 'red'}`} title={String(v)}>{k}: {v === 'ok' ? 'OK' : v === 'skip' ? '건너뜀' : '오류'}</span>
            ))}
          </div>
          {/* skip 사유 노출(v2.311) — VPLEX/Metro Node 의 capacity skip 은 오류가 아니라 제품 특성
              (가상화 계층 — 자체 용량 없음). 사유 없이 '건너뜀'만 보이면 수집 실패로 오해한다. */}
          {s.extra?.capacityNote && <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>ℹ {s.extra.capacityNote}</div>}
        </>
      )}
    </Modal>
  );
}

/** 등록/수정 폼 — 타입(구현/예정 구분)·법인·수집 주체(중앙/엣지)·자격증명. */
function DeviceForm({ d, form, setForm, onSaved }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const save = async () => {
    setBusy(true); setErr(null);
    try { const r = await postJson('/tools/storage/devices', form); if (r.ok === false) setErr(r.reason); else onSaved(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="card" style={{ padding: 14, marginBottom: 12, background: 'rgba(96,165,250,.05)' }}>
      <div className="flex between" style={{ marginBottom: 8 }}>
        <b style={{ fontSize: 13 }}>{form.id ? `장비 수정 — ${form.name}` : '장비 등록'}</b>
        <button className="logout-btn" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setForm(null)}>닫기</button>
      </div>
      <div className="flex gap wrap" style={{ alignItems: 'flex-end' }}>
        <label style={{ fontSize: 12 }}>타입<br />
          <select className="select" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
            {(d.types || []).map((t) => <option key={t.type} value={t.type} disabled={!t.implemented}>{t.label}{t.implemented ? '' : ' (예정)'}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 12 }}>표시명<br /><input className="input" style={{ width: 160 }} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="WA-Isilon-01" /></label>
        <label style={{ fontSize: 12 }}>host(IP/FQDN)<br /><input className="input" style={{ width: 180 }} value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="10.20.0.50" /></label>
        {/* 수집 방식 선택은 PowerScale(Isilon) 전용(v2.305 사용자 요구) — 다른 타입 수집기는 API 전용이라 숨김(서버도 api 고정). */}
        {form.type === 'isilon' && (
          <label style={{ fontSize: 12 }} title="SSH: 장비에 접속해 isi status 출력을 파싱(운영자 화면과 동일 소스 — 권장) · API: OneFS REST">수집 방식(PowerScale)<br />
            <select className="select" value={form.collectMethod || 'ssh'} onChange={(e) => setForm({ ...form, collectMethod: e.target.value })}>
              <option value="ssh">SSH (isi status 파싱 — 권장)</option>
              <option value="api">REST API (OneFS Platform)</option>
            </select>
          </label>
        )}
        {form.type === 'isilon' && (form.collectMethod || 'ssh') === 'ssh' && (
          <label style={{ fontSize: 12 }}>SSH 포트<br /><input className="input" type="number" min={1} max={65535} style={{ width: 80 }} value={form.sshPort || 22} onChange={(e) => setForm({ ...form, sshPort: Number(e.target.value) || 22 })} /></label>
        )}
        <label style={{ fontSize: 12 }}>계정<br /><input className="input" style={{ width: 110 }} value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></label>
        <label style={{ fontSize: 12 }}>비밀번호{form.id ? '(변경 시만)' : ''}<br /><input className="input" type="password" style={{ width: 140 }} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder={form.hasPassword ? '•••• (유지)' : ''} /></label>
        <label style={{ fontSize: 12 }}>법인(DataCenter)<br />
          <select className="select" value={form.datacenterId || ''} onChange={(e) => setForm({ ...form, datacenterId: e.target.value })}>
            <option value="">(미지정)</option>
            {(d.datacenters || []).map((x) => <option key={x.id} value={x.id}>{x.name || x.id}</option>)}
          </select>
        </label>
        {/* 수집 주체(v2.312 개선): 알려진 엣지 목록을 제안하되 **직접 입력도 허용**(datalist).
            엣지가 아직 중앙에 한 번도 보고하지 않은 부트스트랩(토큰 미발급·최초 구성) 상황에서도
            위임을 걸 수 있어야 한다(select 만이면 목록이 비어 위임 자체가 불가능했던 것이 원인).
            빈 값 = 중앙에서 직접 수집. */}
        <label style={{ fontSize: 12 }} title="중앙이 직접 못 닿는 폐쇄망 장비는 그 법인의 엣지 포탈이 현지에서 수집합니다(iDRAC 위임과 동일). 목록에 없으면 엣지 이름(AGENT_NAME)을 직접 입력하세요.">수집 주체(비우면 중앙 직접)<br />
          <input className="input" list="storage-agent-list" style={{ width: 200 }} value={form.agent || ''}
            onChange={(e) => setForm({ ...form, agent: e.target.value })} placeholder="🖥️ 중앙에서 직접 (또는 엣지 이름)" />
          <datalist id="storage-agent-list">
            {(d.agents || []).map((a) => <option key={a} value={a}>엣지 {a}</option>)}
          </datalist>
        </label>
        <label className="muted flex gap" style={{ alignItems: 'center', fontSize: 12, padding: '6px 0' }}>
          <input type="checkbox" checked={form.enabled !== false} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> 활성
        </label>
        <button className="login-btn" style={{ flex: 'none', padding: '8px 18px' }} disabled={busy || !form.name || !form.host} onClick={save}>{busy ? '저장 중…' : '저장'}</button>
      </div>
      {err && <div style={{ color: 'var(--red)', fontSize: 12.5, marginTop: 8 }}>⚠ {err}</div>}
      <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>비밀번호는 '설정 › 자격증명 저장 방식'의 정책(평문/암호화)에 따라 저장됩니다. host 변경 시 기존 비밀번호는 이월되지 않습니다(재입력 필요 — 보안 규칙).</div>
    </div>
  );
}

/** OneFS API 영역 원문 뷰어(v2.308) — 이 노드 DB(api_latest)의 엔드포인트별 최신 JSON. */
function AreaJsonViewer({ deviceId, area, onClose }) {
  const [rows, setRows] = useState(null);   // 영역의 엔드포인트 목록
  const [sel, setSel] = useState(null);     // 선택한 엔드포인트 원문
  const [err, setErr] = useState(null);
  useEffect(() => {
    fetchJson(`/tools/storage/devices/${encodeURIComponent(deviceId)}/areas`)
      .then((r) => setRows((r.rows || []).filter((x) => x.area === area)))
      .catch((e) => setErr(e.message));
  }, [deviceId, area]);
  const open = (ep) => fetchJson(`/tools/storage/devices/${encodeURIComponent(deviceId)}/areas/json`, { endpoint: ep })
    .then((r) => setSel({ ep, ...r })).catch((e) => setSel({ ep, error: e.message }));
  return (
    <div className="card" style={{ padding: 12, marginBottom: 12, background: 'rgba(96,165,250,.05)' }}>
      <div className="flex between" style={{ marginBottom: 6 }}>
        <b style={{ fontSize: 12.5 }}>영역 원문 — {area}</b>
        <button className="logout-btn" style={{ padding: '3px 9px', fontSize: 11.5 }} onClick={onClose}>닫기</button>
      </div>
      {err ? <ErrorBox message={err} /> : !rows ? <Loading /> : rows.length === 0 ? <div className="muted" style={{ fontSize: 12 }}>저장된 원문 없음(다음 영역 수집 주기 대기 — 기본 60분)</div> : (
        <>
          <div className="flex gap wrap" style={{ marginBottom: 6 }}>
            {rows.map((x) => (
              <button key={x.endpoint} className="tab" style={{ padding: '3px 9px', fontSize: 11, color: x.ok ? undefined : 'var(--red)' }}
                title={x.error || `${Math.round(x.bytes / 1024)}KB · ${new Date(x.ts).toLocaleString('ko-KR')}${x.truncated ? ' · 512KB 절단' : ''}`}
                onClick={() => open(x.endpoint)}>{x.endpoint.split('?')[0]}{x.ok ? '' : ' ⛔'}</button>
            ))}
          </div>
          {sel && (
            sel.error ? <div style={{ color: 'var(--red)', fontSize: 12 }}>⛔ {sel.error}</div> : (
              <>
                {sel.truncated ? <div className="muted" style={{ fontSize: 11, color: 'var(--amber)' }}>⚠ 원문이 512KB 를 넘어 절단 저장됨(뒷부분 생략)</div> : null}
                <pre style={{ maxHeight: '30vh', overflow: 'auto', fontSize: 11, background: 'rgba(0,0,0,.25)', padding: 8, borderRadius: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{(() => { try { return JSON.stringify(JSON.parse(sel.json), null, 2); } catch { return sel.json; } })()}</pre>
              </>
            )
          )}
        </>
      )}
    </div>
  );
}
