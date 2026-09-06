import React, { useEffect, useMemo, useState } from 'react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts';
import { fetchJson, postJson, delJson } from '../../api.js';
import { Loading, ErrorBox, Kpi, UsageCell, Modal, SearchBox } from '../../components/ui.jsx';
import { stateLabel, stateTone, opticalHealth, errorLevel, capacityLevel, aggregate,
  throughputText, filterPorts, shortDeviceName, saturationPct, saturationLevel, bytesPerSecText,
  toChartRows, topSeries, bps, sortPorts, nextSort, sortRows, seriesStats,
  RX_WARN_DBM, RX_BAD_DBM } from './sanSwitchPorts.js';

/**
 * 특수기능 › SAN 스위치 모니터링(v2.410 — 사용자 요구 'Brocade SAN switch 포트 모니터링 및
 * 용량 모니터링').
 *
 * '용량'의 뜻: SAN 스위치에는 저장 용량이 없다. 여기서 용량은 **포트 용량**이다 —
 * 라이선스(POD)로 쓸 수 있는 포트가 몇 개인지, 그중 몇 개가 실제로 물려 있는지, 몇 개가
 * 남았는지. 이 값이 신규 서버·어레이를 더 붙일 수 있는지를 결정한다.
 * ⚠ 라이선스 없는 포트(No_License)는 **여유에서 뺀다** — 살 수 없는 포트를 여유로 세면
 *   증설 판단이 틀린다(판정 규칙은 sanSwitchPorts.js·types.js summarizePorts 에 고정).
 *
 * 데이터 흐름은 스토리지 모니터링과 같다: 중앙 등록 → 엣지가 pull → 현지 수집 → 중앙 push.
 * 조회는 전체 범위 계정 전용(서버 403), 등록/수정/삭제/테스트는 admin.
 */

const ago = (ts) => {
  if (!ts) return '—';
  const s = Math.round((Date.now() - ts) / 1000);
  return s < 60 ? `${s}초 전` : s < 3600 ? `${Math.round(s / 60)}분 전` : `${Math.round(s / 3600)}시간 전`;
};
const TONE = { ok: 'var(--green, #22c55e)', warn: 'var(--amber, #f59e0b)', bad: 'var(--red, #ef4444)', muted: 'var(--muted, #94a3b8)' };
// 고정 폭 셀에서 긴 값이 옆 칸을 덮지 않게 하는 한 줄 말줄임(전문은 각 셀의 title 툴팁).
const ELLIPSIS = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };

/** 수집 실패 사유 한 줄 — 부분 실패(섹션만 오류)여도 사유가 반드시 드러나게. */
function failReason(s) {
  if (!s) return '수집 기록 없음';
  return s.error
    || Object.entries(s.sections || {}).filter(([, v]) => v && v !== 'ok' && v !== 'skip').map(([k, v]) => `${k}: ${v}`).join(' · ')
    || '알 수 없는 오류';
}

const EMPTY_FORM = { type: 'brocade', name: '', host: '', username: 'admin', password: '',
  collectMethod: 'ssh', sshPort: 22, agent: '', datacenterId: '', vfId: '', note: '', enabled: true };

export default function SanSwitchTool() {
  // ⚠ 훅은 전부 조기 return 위에(React #310 회귀 방지 — CLAUDE.md).
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');
  const [dcSel, setDcSel] = useState(() => new Set());
  const [form, setForm] = useState(null);          // null = 폼 닫힘
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [test, setTest] = useState(null);
  const [detail, setDetail] = useState(null);      // 포트 상세 모달 { device, ports, ... }
  const [dcPerf, setDcPerf] = useState(null);      // 법인 단위 스토리지 사용량 분석 모달
  const [portFilter, setPortFilter] = useState('all');
  const [portQ, setPortQ] = useState('');
  const [infoOpen, setInfoOpen] = useState(false);   // 장비 일반 정보 펼침
  const [tab, setTab] = useState('ports');           // 포트 목록 / 사용량 분석
  const [sort, setSort] = useState({ key: 'index', dir: 'asc' });  // 표 정렬(제목 클릭)

  const load = async () => {
    try { setData(await fetchJson('/tools/sanswitch')); setError(null); }
    catch (e) { setError(e.message); }
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  const dcName = useMemo(() => {
    const m = new Map((data?.datacenters || []).map((d) => [d.id, d.name || d.id]));
    return (id) => m.get(id) || id || '(법인 미지정)';
  }, [data]);
  // 칩은 법인 '이름'으로 고르는데 서버는 id 로 거른다 — 역방향 표를 하나 둔다.
  const dcIdOfName = useMemo(() => {
    const m = new Map((data?.datacenters || []).map((d) => [d.name || d.id, d.id]));
    return (name) => m.get(name) || '';
  }, [data]);

  const rows = data?.devices || [];
  const searched = rows.filter((r) => {
    if (!q.trim()) return true;
    const s = q.trim().toLowerCase();
    return [r.name, r.host, r.agent, dcName(r.datacenterId), r.snap?.model, r.snap?.fabricOs]
      .some((v) => String(v || '').toLowerCase().includes(s));
  });
  const shown = searched.filter((r) => dcSel.size === 0 || dcSel.has(dcName(r.datacenterId)));
  const dcChips = [...new Set(searched.map((r) => dcName(r.datacenterId)))].sort((a, b) => a.localeCompare(b));
  const agg = aggregate(shown);

  if (error && !data) return <ErrorBox message={error} />;   // 데이터 보유 중 폴링 오류로 화면을 갈아치우지 않음
  if (!data) return <Loading />;

  const openForm = (r) => setForm(r
    ? { ...EMPTY_FORM, ...r, password: '', vfId: r.vfId ?? '' }
    : { ...EMPTY_FORM, agent: '', datacenterId: data.datacenters?.[0]?.id || '' });

  const save = async () => {
    setBusy(true); setMsg(null);
    try { await postJson('/tools/sanswitch/devices', form); setForm(null); await load(); setMsg('저장되었습니다.'); }
    catch (e) { setMsg(`저장 실패: ${e.message}`); }
    finally { setBusy(false); }
  };
  const remove = async (r) => {
    if (!window.confirm(`'${r.name}' 스위치 등록을 삭제할까요? 수집된 스냅샷도 함께 지워집니다.`)) return;
    setBusy(true);
    try { await delJson(`/tools/sanswitch/devices/${r.id}`); await load(); setMsg('삭제되었습니다.'); }
    catch (e) { setMsg(`삭제 실패: ${e.message}`); }
    finally { setBusy(false); }
  };
  const runTest = async () => {
    setBusy(true); setTest(null);
    try { setTest(await postJson('/tools/sanswitch/test', form)); }
    catch (e) { setTest({ ok: false, reason: e.message }); }
    finally { setBusy(false); }
  };
  const collectNow = async (r) => {
    setBusy(true); setMsg(null);
    try { const res = await postJson(`/tools/sanswitch/devices/${r.id}/collect`, {}); setMsg(res.reason || '수집했습니다.'); await load(); }
    catch (e) { setMsg(`수집 실패: ${e.message}`); }
    finally { setBusy(false); }
  };
  const openDetail = async (r) => {
    setDetail({ loading: true, device: r }); setPortFilter('all'); setPortQ(''); setInfoOpen(false); setTab('ports'); setSort({ key: 'index', dir: 'asc' });
    try { setDetail({ device: r, ...(await fetchJson(`/tools/sanswitch/devices/${r.id}/ports`)) }); }
    catch (e) { setDetail({ device: r, error: e.message }); }
  };

  return (
    <>
      <div className="section-title" style={{ marginTop: 0 }}>🔗 SAN 스위치 모니터링</div>

      {/* 상단 KPI — '용량'은 포트 용량이다. 라이선스 없는 포트는 여유에서 빠진다. */}
      <div className="kpis" style={{ marginBottom: 12 }}>
        <Kpi label="스위치" value={agg.switches} meta={agg.failed ? `수집 실패 ${agg.failed}대` : '전부 수집 정상'} accent={agg.failed ? 'var(--red)' : undefined} />
        <Kpi label="물리 포트" value={agg.total.toLocaleString()} meta={`라이선스 ${agg.licensed.toLocaleString()}`} />
        <Kpi label="사용 중" value={agg.online.toLocaleString()} pct={agg.usedPct} meta={`포트 사용률 ${agg.usedPct}%`} />
        <Kpi label="여유 포트" value={agg.free.toLocaleString()} meta="라이선스 − 사용중(증설 가능분)" accent={capacityLevel(agg.usedPct) === 'bad' ? 'var(--red)' : capacityLevel(agg.usedPct) === 'warn' ? 'var(--amber)' : undefined} />
        <Kpi label="장애/비활성 포트" value={`${agg.faulty} / ${agg.disabled}`} meta={agg.alerts ? `헬스 경보 ${agg.alerts}` : '헬스 경보 없음'} accent={agg.faulty ? 'var(--red)' : undefined} />
      </div>

      {/* 법인 필터 + 검색 + 등록 */}
      <div className="vc-quicknav" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
        <div className="flex gap wrap" style={{ alignItems: 'center', gap: 8 }}>
          <span className="qn-label" style={{ minWidth: 60 }}>🏢 법인</span>
          {dcChips.map((dc) => {
            const on = dcSel.has(dc);
            const list = searched.filter((r) => dcName(r.datacenterId) === dc);
            const a = aggregate(list);
            return (
              <button key={dc} className={`qn-btn${on ? ' on' : ''}${a.failed ? ' down' : ''}`} aria-pressed={on}
                onClick={() => setDcSel((p) => { const n = new Set(p); n.has(dc) ? n.delete(dc) : n.add(dc); return n; })}
                title={`${dc} — 스위치 ${a.switches}대 · 포트 ${a.online}/${a.licensed} (${a.usedPct}%) · 여유 ${a.free}`}>
                {dc}<span className="muted" style={{ fontWeight: 400, fontSize: 11 }}>{list.length}</span>
              </button>
            );
          })}
          {/* 법인 단위 스토리지 사용량 분석(v2.412, 사용자 요구) — 어레이는 팹 A/B 두 스위치에
              나눠 물리므로 스위치 하나만 보면 트래픽의 절반만 보인다. 선택한 법인의 모든
              스위치를 합산해야 어레이의 실제 사용량이 나온다. */}
          <button className="tab" style={{ flex: 'none', padding: '6px 12px' }}
            onClick={() => setDcPerf({ datacenterId: dcSel.size === 1 ? dcIdOfName([...dcSel][0]) : '', label: dcSel.size === 1 ? [...dcSel][0] : '전체' })}
            title={dcSel.size === 1
              ? `'${[...dcSel][0]}' 법인의 모든 스위치를 합산해 스토리지별 사용량을 분석합니다.`
              : '법인 칩을 하나 고르면 그 법인만, 고르지 않으면 전체 스위치를 합산해 분석합니다.'}>
            📊 스토리지 사용량 분석{dcSel.size === 1 ? ` — ${[...dcSel][0]}` : ' — 전체'}
          </button>
          <SearchBox className="input" style={{ marginLeft: 'auto', maxWidth: 260, minWidth: 180 }}
            value={q} onChange={setQ} placeholder="스위치·host·모델·엣지 찾기" />
          <button className="login-btn" style={{ flex: 'none', padding: '6px 14px' }} onClick={() => openForm(null)}>+ 스위치 등록</button>
        </div>
      </div>

      {msg && <div className="muted" style={{ fontSize: 12, margin: '6px 0 10px 2px' }}>{msg}</div>}

      {/* 스위치 목록 */}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>스위치</th><th>법인</th><th>모델</th><th>FOS</th><th>Domain</th><th>상태</th>
              <th title="사용중 / 라이선스 포트. 라이선스 없는 포트(No_License)는 분모에서 뺍니다.">포트 사용</th>
              <th style={{ minWidth: 130 }}>포트 사용률</th>
              <th title="라이선스 − 사용중. 지금 새로 물릴 수 있는 포트 수입니다.">여유</th>
              <th>장애/비활성</th><th>수집</th><th>수집 시각</th><th></th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const s = r.snap;
              const p = s?.ports || {};
              const lvl = capacityLevel(p.usedPct);
              return (
                <tr key={r.id}>
                  <td>
                    <button className="tab" style={{ padding: '2px 8px', fontWeight: 600 }} onClick={() => openDetail(r)} title="클릭하면 포트 상세를 봅니다">{r.name}</button>
                    {/* 스위치가 스스로 보고한 이름(switchshow 의 switchName)을 함께 보여준다 —
                        등록 표시명은 사람이 정한 별칭이라, 현장에서 콘솔에 찍히는 실제 이름과
                        다를 수 있고 그때 어느 장비인지 헷갈린다(사용자 요구). */}
                    <div className="muted" style={{ fontSize: 11 }}>
                      {s?.name && s.name !== r.name ? <><b style={{ fontWeight: 600 }}>{s.name}</b>{' · '}</> : null}
                      {r.host}{r.vfId ? ` · VF ${r.vfId}` : ''}
                    </div>
                  </td>
                  <td>{dcName(r.datacenterId)}</td>
                  <td>{s?.model || (s?.extra?.switchType
                    ? <span className="muted" title="chassisshow 에서 모델명을 읽지 못해 switchType 원값을 표시합니다.">type {s.extra.switchType}</span>
                    : <span className="muted">—</span>)}</td>
                  <td>{s?.fabricOs || <span className="muted">—</span>}</td>
                  <td>{s?.domainId ?? <span className="muted">—</span>}</td>
                  <td>
                    {s?.ok
                      ? <span style={{ color: s.switchState === 'Online' ? TONE.ok : TONE.warn }}>{s.switchState || 'OK'}</span>
                      : <span className="badge" style={{ background: TONE.bad, color: '#fff' }} title={failReason(s)}>실패 ⓘ</span>}
                  </td>
                  <td>{s?.ok ? <>{p.online}<span className="muted"> / {p.licensed}</span>{p.noLicense ? <span className="muted" style={{ fontSize: 11 }}> (미라이선스 {p.noLicense})</span> : null}</> : <span className="muted">—</span>}</td>
                  <td>{s?.ok ? <span title={`${p.usedPct}% 사용 · ${lvl === 'bad' ? '증설 검토 필요' : lvl === 'warn' ? '여유 부족' : '여유 있음'}`}><UsageCell pct={p.usedPct || 0} /></span> : <span className="muted">—</span>}</td>
                  <td style={{ color: lvl === 'bad' ? TONE.bad : lvl === 'warn' ? TONE.warn : undefined, fontWeight: 600 }}>{s?.ok ? p.free : '—'}</td>
                  <td>{s?.ok ? <span style={{ color: (p.faulty || p.disabled) ? TONE.warn : undefined }}>{p.faulty} / {p.disabled}</span> : <span className="muted">—</span>}</td>
                  <td className="muted" style={{ fontSize: 11 }}>{r.agent ? `엣지 ${r.agent}` : '중앙 직접'}<div>{r.collectMethod === 'rest' ? 'REST' : 'SSH'}</div></td>
                  <td className="muted" style={{ fontSize: 11 }}>{ago(s?.collectedAt)}{r.pending ? <div style={{ color: TONE.warn }}>재수집 대기</div> : null}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="tab" style={{ padding: '2px 8px' }} disabled={busy} onClick={() => collectNow(r)}>수집</button>{' '}
                    <button className="tab" style={{ padding: '2px 8px' }} onClick={() => openForm(r)}>수정</button>{' '}
                    <button className="tab" style={{ padding: '2px 8px' }} disabled={busy} onClick={() => remove(r)}>삭제</button>
                  </td>
                </tr>
              );
            })}
            {!shown.length && <tr><td colSpan={13} className="muted" style={{ textAlign: 'center', padding: 24 }}>
              등록된 SAN 스위치가 없습니다. 오른쪽 위 '+ 스위치 등록'으로 추가하세요.
            </td></tr>}
          </tbody>
        </table>
      </div>

      <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
        수집 주기 {Math.round((data.poller?.intervalMs || 0) / 60000)}분(동시 {data.poller?.concurrency}대) ·
        마지막 수집 {ago(data.poller?.at)} · 성공 {data.poller?.collected ?? 0} / 실패 {data.poller?.failed ?? 0}
        {data.poller?.busy ? ' · 수집 진행중' : ''}
      </div>

      {form && <DeviceForm {...{ form, setForm, data, save, busy, runTest, test, setTest }} />}
      {detail && <PortDetail {...{ detail, setDetail, portFilter, setPortFilter, portQ, setPortQ, infoOpen, setInfoOpen, tab, setTab, sort, setSort }} />}
      {dcPerf && <DcStoragePerf dcPerf={dcPerf} onClose={() => setDcPerf(null)} />}
    </>
  );
}

/** 등록/수정 폼 — 수집 방식 목록은 서버 카탈로그(types.js)를 그대로 그린다. */
function DeviceForm({ form, setForm, data, save, busy, runTest, test, setTest }) {
  const set = (k) => (e) => setForm((p) => ({ ...p, [k]: e.target.value }));
  const type = data.types.find((t) => t.type === form.type) || data.types[0];
  return (
    <Modal title={form.id ? 'SAN 스위치 수정' : 'SAN 스위치 등록'} onClose={() => { setForm(null); setTest(null); }} width={760}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10 }}>
        <label style={{ fontSize: 12 }}>표시명<input className="input" value={form.name} onChange={set('name')} placeholder="예: SAN-A-01" /></label>
        <label style={{ fontSize: 12 }}>host (IP/호스트명)<input className="input" value={form.host} onChange={set('host')} placeholder="10.10.10.11" /></label>
        <label style={{ fontSize: 12 }}>타입
          <select className="input" value={form.type} onChange={(e) => setForm((p) => ({ ...p, type: e.target.value, collectMethod: (data.types.find((t) => t.type === e.target.value)?.methods || [])[0]?.value || 'ssh' }))}>
            {data.types.map((t) => <option key={t.type} value={t.type} disabled={!t.implemented}>{t.label}{t.implemented ? '' : ' (예정)'}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 12 }}>수집 방식
          <select className="input" value={form.collectMethod} onChange={set('collectMethod')}
            title={(type?.methods || []).find((m) => m.value === form.collectMethod)?.hint || ''}>
            {(type?.methods || []).map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 12 }}>계정<input className="input" value={form.username} onChange={set('username')} autoComplete="off" /></label>
        <label style={{ fontSize: 12 }}>비밀번호
          <input className="input" type="password" value={form.password} onChange={set('password')} autoComplete="new-password"
            placeholder={form.hasPassword ? '(변경할 때만 입력)' : ''} />
        </label>
        <label style={{ fontSize: 12 }}>SSH 포트<input className="input" type="number" value={form.sshPort} onChange={set('sshPort')} /></label>
        <label style={{ fontSize: 12 }}>법인(DataCenter)
          <select className="input" value={form.datacenterId} onChange={set('datacenterId')}>
            <option value="">(미지정)</option>
            {(data.datacenters || []).map((d) => <option key={d.id} value={d.id}>{d.name || d.id}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 12 }}>수집 주체
          <select className="input" value={form.agent} onChange={set('agent')}
            title="중앙에서 스위치에 직접 닿지 않으면 그 법인의 엣지를 지정하세요. 엣지가 현지에서 수집해 중앙으로 올립니다.">
            <option value="">중앙이 직접 수집</option>
            {(data.agents || []).map((a) => <option key={a} value={a}>엣지 {a}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 12 }} title="Virtual Fabrics 를 쓰는 장비에서 특정 논리 스위치만 볼 때 지정합니다. 비워두면 기본 컨텍스트만 수집합니다.">
          VF ID (선택)<input className="input" type="number" value={form.vfId} onChange={set('vfId')} placeholder="예: 128" />
        </label>
        <label style={{ fontSize: 12, gridColumn: '1 / -1' }}>메모<input className="input" value={form.note} onChange={set('note')} /></label>
      </div>
      <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
        {(type?.methods || []).find((m) => m.value === form.collectMethod)?.hint}
      </div>
      <div className="flex gap" style={{ marginTop: 12 }}>
        <button className="tab" disabled={busy} onClick={runTest}>연결 테스트</button>
        <button className="login-btn" style={{ flex: 'none', padding: '6px 18px' }} disabled={busy} onClick={save}>저장</button>
      </div>
      {test && <TestResult test={test} />}
    </Modal>
  );
}

/** 연결 테스트 결과 — 실패해도 원인을 감추지 않고, SSH 는 CLI 원문을 접어서 보여준다. */
function TestResult({ test }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div style={{ color: test.ok ? TONE.ok : TONE.bad, fontWeight: 600 }}>
        {test.ok ? '연결 성공' : '연결 실패'} <span className="muted" style={{ fontWeight: 400 }}>({test.ms}ms)</span>
      </div>
      {!test.ok && <div style={{ marginTop: 6 }}>{test.reason}</div>}
      {test.ok && test.snap && (
        <div style={{ marginTop: 6, fontSize: 13, lineHeight: 1.7 }}>
          이름 <b>{test.snap.name}</b> · 모델 <b>{test.snap.model || '—'}</b> · FOS <b>{test.snap.fabricOs || '—'}</b>
          {' · '}Domain {test.snap.domainId ?? '—'} · 시리얼 {test.snap.serial || '—'}
          <div>포트 {test.snap.ports.online} / {test.snap.ports.licensed} 사용({test.snap.ports.usedPct}%) · 여유 {test.snap.ports.free} · 전체 {test.snap.ports.total}</div>
          {Object.entries(test.snap.sections || {}).filter(([, v]) => v !== 'ok').length > 0 && (
            <div className="muted" style={{ marginTop: 4 }}>
              일부 항목 미수집: {Object.entries(test.snap.sections).filter(([, v]) => v !== 'ok').map(([k, v]) => `${k}(${v})`).join(', ')}
            </div>
          )}
        </div>
      )}
      {!!(test.cliRaw || []).length && (
        <>
          <button className="tab" style={{ marginTop: 8, padding: '2px 8px' }} onClick={() => setOpen(!open)}>
            {open ? '▾' : '▸'} CLI 명령 원문 ({test.cliRaw.length}개)
          </button>
          {open && (
            <div style={{ maxHeight: 320, overflow: 'auto', marginTop: 6 }}>
              {test.cliRaw.map((r, i) => (
                <details key={i} open={!r.ok}>
                  <summary style={{ cursor: 'pointer', color: r.ok ? undefined : TONE.warn }}>{r.cmd}</summary>
                  <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', margin: '4px 0 8px' }}>{r.sample}</pre>
                </details>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * 장비 일반 정보 한 줄 요약(v2.411, 사용자 요구) — 필터 줄 옆에 붙는다.
 * 값이 없는 항목은 아예 넣지 않는다(빈 칸을 '—' 로 나열하면 요약이 아니라 잡음이 된다).
 */
function infoSummary(d) {
  const h = d.health || {};
  const bits = [];
  if (d.domainId != null) bits.push(`Domain ${d.domainId}`);
  if (d.extra?.switchRole) bits.push(d.extra.switchRole);
  if (d.serial) bits.push(`S/N ${d.serial}`);
  if (h.fans?.total) bits.push(`팬 ${h.fans.total}`);
  if (h.psus?.total) bits.push(`PSU ${h.psus.total}${h.powerWatts ? ` · ${h.powerWatts}W` : ''}`);
  if (d.extra?.awakeDays != null) bits.push(`가동 ${d.extra.awakeDays}일`);
  return bits.join(' · ');
}

/** 장비 일반 정보 상세 — 수집된 값만 항목으로 만든다(없는 항목은 표시하지 않는다). */
function DeviceInfo({ d }) {
  const h = d.health || {};
  const rows = [
    ['스위치 이름', d.name],
    ['host', d.host],
    ['모델', d.model || (d.extra?.switchType ? `(모델명 미보고) switchType ${d.extra.switchType}` : '')],
    ['Fabric OS', d.fabricOs],
    ['섀시 시리얼', d.serial],
    ['섀시 Part Num', d.extra?.chassisPartNumber],
    ['섀시 ID', d.extra?.chassisId],
    ['Switch WWN', d.wwn],
    ['Domain ID', d.domainId],
    ['스위치 역할', d.extra?.switchRole],
    ['스위치 상태', d.switchState],
    ['Fabric 이름', d.extra?.fabricName],
    ['팹 스위치 수', d.fabric?.switches],
    ['활성 Zone 설정', d.zoning?.effectiveConfig],
    ['팬', h.fans ? (h.fans.ok == null ? `${h.fans.total}개` : `${h.fans.ok}/${h.fans.total} 정상`) : ''],
    ['전원공급장치', h.psus ? (h.psus.ok == null ? `${h.psus.total}개` : `${h.psus.ok}/${h.psus.total} 정상`) : ''],
    ['소비전력(PSU 합)', h.powerWatts ? `${h.powerWatts} W` : ''],
    ['SFP 최고 온도', h.tempC != null ? `${h.tempC} ℃` : ''],
    ['가동(Time Awake)', d.extra?.awakeDays != null ? `${d.extra.awakeDays}일` : ''],
    ['총 수명(Time Alive)', d.extra?.aliveDays != null ? `${d.extra.aliveDays}일` : ''],
    ['수집 방식', d.extra?.collectMethod === 'rest' ? 'REST API' : 'SSH CLI'],
    ['수집 주체', d.source],
  ].filter(([, v]) => v !== '' && v != null);

  return (
    <div className="card" style={{ marginBottom: 10, padding: 10 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '4px 14px', fontSize: 12 }}>
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: 'flex', gap: 6, minWidth: 0 }}>
            <span className="muted" style={{ flex: '0 0 108px' }}>{k}</span>
            <b style={{ ...ELLIPSIS, minWidth: 0 }} title={String(v)}>{String(v)}</b>
          </div>
        ))}
      </div>
      {/* PSU 상세 — 입력 전압·소비전력은 전원 이상 징후를 바로 드러낸다(한쪽 0W = 계통 단선). */}
      {!!(h.psuDetail || []).length && (
        <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
          PSU 상세: {h.psuDetail.map((p) => `#${p.unit} ${p.source || ''} ${p.voltageV != null ? `${p.voltageV}V` : ''} ${p.powerW != null ? `${p.powerW}W` : ''}${p.serial ? ` (S/N ${p.serial})` : ''}`.replace(/\s+/g, ' ').trim()).join(' · ')}
        </div>
      )}
      {!!(d.licenses || []).length && (
        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
          라이선스: {d.licenses.map((l) => l.name).join(' · ')}
        </div>
      )}
    </div>
  );
}

const HOURS = [[1, '1시간'], [6, '6시간'], [24, '24시간'], [24 * 7, '7일'], [24 * 30, '30일']];

/** 제목 클릭 정렬 헤더(v2.412, 사용자 요구 '타이틀별로 소팅'). 분석 표 두 곳이 공유한다. */
function SortTh({ k, label, sort, setSort, title, style }) {
  const on = sort.key === k;
  return (
    <th onClick={() => setSort((c) => nextSort(c, k))} style={{ cursor: 'pointer', userSelect: 'none', ...style }}
      title={`${title ? `${title}\n\n` : ''}클릭하면 이 열로 정렬합니다.`}>
      {label}{title ? ' ⓘ' : ''}
      <span style={{ opacity: on ? 1 : 0.25, marginLeft: 3 }}>{on ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}</span>
    </th>
  );
}
const LINE_COLORS = ['#60a5fa', '#f59e0b', '#34d399', '#f472b6', '#a78bfa', '#fbbf24', '#22d3ee', '#fb7185'];
const tsLabel = (ts, hours) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return hours <= 24 ? `${p(d.getHours())}:${p(d.getMinutes())}` : `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}시`;
};

/**
 * 사용량 분석(v2.411, 사용자 요구 '수집한 포트 사용정보를 차트로 보면서 포트의 사용량을
 * 분석해서 스토리지 사용량을 볼 수 있게').
 *
 * 두 관점을 나란히 둔다:
 *  1) 포트별 — 어느 포트가 얼마나 쓰이나. 포화도(협상 속도 대비 %)까지 봐야 증설 판단이 된다.
 *  2) 스토리지별 — 같은 어레이에 여러 포트가 물려 있으므로(SYMMETRIX 의 SAF-1d/3d/5d…)
 *     포트 처리량을 어레이 단위로 합산해야 '그 스토리지가 실제로 얼마나 쓰이는지'가 보인다.
 */
function PerfPanel({ deviceId, ports }) {
  const [hours, setHours] = useState(24);
  const [view, setView] = useState('port');     // 'port' | 'storage'
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [sort, setSort] = useState({ key: 'avg', dir: 'desc' });   // 기본: 많이 쓰는 순
  // 연결 스토리지별 뷰에서 어레이/호스트를 구분한다 — 같은 HBA 모델·펌웨어를 쓰는 서버들은
  // 네임서버 심볼릭 이름이 같아 한 덩어리로 묶인다(실측: 'QLE2692 FW:… (포트 25)').
  // 그게 스토리지 2위로 올라오면 오독하므로 기본은 스토리지만 본다.
  const [kind, setKind] = useState('array');

  /**
   * ⚠ 응답에 **어느 뷰의 것인지**를 각인해 두고, 뷰가 일치할 때만 그린다.
   * 처음에는 view 상태만 보고 그렸는데, `setView('storage')` 로 리렌더가 먼저 일어나고
   * 데이터 초기화(useEffect)는 그 다음이라 **'뷰는 storage, 데이터는 포트'** 인 렌더가 한 번
   * 끼어들었다. 그 렌더에서 포트 시리즈에 없는 `s.ports.length` 를 읽어 화면 전체가 크래시했다
   * (Playwright 로 실제로 잡음). 뷰-데이터 짝을 강제하면 이 부류가 원천 차단된다.
   */
  useEffect(() => {
    let alive = true;
    setData(null); setError(null);
    const v = view;
    const path = v === 'storage' ? `/tools/sanswitch/devices/${deviceId}/perf/storage` : `/tools/sanswitch/devices/${deviceId}/perf`;
    fetchJson(path, { hours })
      .then((d) => { if (alive) setData({ ...d, view: v }); })
      .catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [deviceId, hours, view]);

  // 포트 현재 속도(포화도 계산용) — 목록 스냅샷에서 가져온다.
  const speedOf = useMemo(() => {
    const m = new Map((ports || []).map((p) => [p.index, p.speed]));
    return (port) => m.get(port) || '';
  }, [ports]);

  // 뷰가 일치하는 응답만 사용(위 주석 참조). 필드도 방어적으로 읽는다.
  const shown = data && data.view === view ? data : null;
  const raw = shown?.series || [];
  // 어레이/호스트 구분은 서버와 같은 규칙(perfDb.endpointKind)을 쓴다 — 이름에 '::' 가 있으면 어레이.
  const kindOf = (key) => (String(key) === '(미확인)' ? 'unknown' : (String(key).includes('::') ? 'array' : 'host'));
  const kindCounts = view === 'storage'
    ? raw.reduce((a, s) => { const k = kindOf(s.key); a[k] = (a[k] || 0) + 1; a.all = (a.all || 0) + 1; return a; }, {})
    : {};
  const rawShown = view === 'storage' && kind !== 'all' ? raw.filter((s) => kindOf(s.key) === kind) : raw;
  const seriesAll = view === 'storage'
    ? rawShown.map((s) => ({ key: s.key, label: `${s.key} (포트 ${(s.ports || []).length})`, values: s.sum || [], portCount: (s.ports || []).length, kind: kindOf(s.key) }))
    : rawShown.map((s) => ({ key: `p${s.port}`, label: `${s.port}${s.name ? ` · ${shortDeviceName(s.name, 24)}` : ''}`, values: s.avg || [], port: s.port, speed: s.speed, name: s.name }));
  const top = topSeries(seriesAll, 8);
  const rows = toChartRows(shown?.buckets || [], top);

  // 표에 쓸 파생값을 미리 계산해 두고(평균·최대·포화도) 그 위에서 정렬한다 —
  // 정렬 키와 화면에 보이는 값이 반드시 같은 계산이어야 한다.
  const tableRows = seriesAll.map((s) => {
    const { avg, max } = seriesStats(s.values);
    const speed = view === 'port' ? (s.speed || speedOf(s.port)) : '';
    return { ...s, avg, max, speed, sat: view === 'port' ? saturationPct(max, speed) : null };
  });
  const SORTERS = {
    name: (r) => (view === 'storage' ? r.key : r.port),
    attached: (r) => (view === 'storage' ? r.portCount : (r.name || null)),
    speed: (r) => { const m = String(r.speed || '').match(/^(\d+)G$/); return m ? Number(m[1]) : null; },
    avg: (r) => r.avg,
    max: (r) => r.max,
    sat: (r) => r.sat,
  };
  const sorted = sortRows(tableRows, SORTERS[sort.key] || SORTERS.avg, sort.dir, (r) => r.key);

  return (
    <div style={{ marginBottom: 10 }}>
      <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 8 }}>
        {[['port', '포트별'], ['storage', '연결 스토리지별']].map(([k, label]) => (
          <button key={k} className={view === k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '4px 12px' }}
            onClick={() => setView(k)}
            title={k === 'storage' ? '같은 어레이에 물린 포트들의 처리량을 합산해, 그 스토리지가 실제로 얼마나 쓰이는지 보여줍니다.' : '포트 하나하나의 처리량입니다.'}>
            {label}
          </button>
        ))}
        {view === 'storage' && [['array', '스토리지'], ['host', '호스트(HBA)'], ['all', '전체']].map(([k, label]) => (
          <button key={k} className={kind === k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '4px 10px' }}
            onClick={() => setKind(k)}
            title={k === 'array' ? '벤더 심볼릭 이름이 어레이 형식인 연결 대상입니다.'
              : k === 'host' ? '서버 HBA 등 스토리지가 아닌 연결 대상입니다. 같은 HBA 모델·펌웨어를 쓰는 서버들은 네임서버 이름이 같아 한 덩어리로 묶입니다.'
              : '구분 없이 모두 봅니다.'}>
            {label}{kindCounts[k] != null ? ` ${kindCounts[k]}` : ''}
          </button>
        ))}
        <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>기간</span>
        {HOURS.map(([h, label]) => (
          <button key={h} className={hours === h ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '4px 10px' }}
            onClick={() => setHours(h)}>{label}</button>
        ))}
      </div>

      {error && <ErrorBox message={error} />}
      {!error && !shown && <Loading />}
      {shown && !rows.length && (
        <div className="card muted" style={{ fontSize: 13, lineHeight: 1.8 }}>
          아직 수집된 사용량 데이터가 없습니다.
          <div style={{ marginTop: 4 }}>
            <b>설정 › 수집 서버 › SAN 스위치 포트 사용량</b> 에서 수집을 켜면 <code>portperfshow</code> 를 주기적으로
            실행해 쌓기 시작합니다(기본은 꺼짐 — 운영 스위치에 주기 접속을 임의로 만들지 않기 위해서입니다).
            {shown.unavailable ? <div style={{ color: 'var(--amber)', marginTop: 4 }}>이 서버는 시계열 DB(node:sqlite)를 쓸 수 없어 이력이 저장되지 않습니다.</div> : null}
          </div>
        </div>
      )}

      {!!rows.length && (
        <>
          <div className="card" style={{ padding: 8, marginBottom: 8 }}>
            <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
              {view === 'storage' ? '연결 스토리지별 합산 처리량' : '포트별 처리량'} · 평균 사용량 상위 {top.length}개 ·
              값은 스위치가 보고한 바이트/초를 bps 로 환산한 것입니다.
            </div>
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={rows} margin={{ top: 4, right: 12, bottom: 4, left: 4 }}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
                <XAxis dataKey="ts" tickFormatter={(t) => tsLabel(t, hours)} fontSize={11} minTickGap={28} />
                <YAxis tickFormatter={(v) => bps(v * 8)} fontSize={11} width={78} />
                <Tooltip
                  labelFormatter={(t) => new Date(t).toLocaleString()}
                  formatter={(v, name) => [bytesPerSecText(v), name]} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {top.map((s, i) => (
                  <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} dot={false}
                    stroke={LINE_COLORS[i % LINE_COLORS.length]} strokeWidth={1.6} connectNulls={false} isAnimationActive={false} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* 분석 표 — 평균/최대, 그리고 포화도(협상 속도 대비 %). 절대값만으로는 증설 판단이 안 된다. */}
          <div className="table-wrap" style={{ maxHeight: '28vh', overflow: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <SortTh k="name" label={view === 'storage' ? '스토리지' : '포트'} sort={sort} setSort={setSort} />
                  <SortTh k="attached" label={view === 'storage' ? '포트 수' : '연결 장비'} sort={sort} setSort={setSort} />
                  {view === 'port' && <SortTh k="speed" label="속도" sort={sort} setSort={setSort} />}
                  <SortTh k="avg" label="평균" sort={sort} setSort={setSort} />
                  <SortTh k="max" label="최대" sort={sort} setSort={setSort} />
                  {view === 'port' && <SortTh k="sat" label="포화도(최대)" sort={sort} setSort={setSort}
                    title="최대 처리량 ÷ 협상 속도. 속도를 모르는 포트는 판정하지 않습니다(빈칸이며 정렬에서도 뒤로 갑니다)." />}
                </tr>
              </thead>
              <tbody>
                {sorted.map((s) => {
                  const lvl = saturationLevel(s.sat);
                  return (
                    <tr key={s.key}>
                      <td style={ELLIPSIS} title={s.label}>
                        <b>{view === 'storage' ? s.key : s.port}</b>
                        {view === 'storage' && s.kind === 'host'
                          ? <div className="muted" style={{ fontSize: 10.5 }}>호스트(HBA)</div> : null}
                      </td>
                      {view === 'storage'
                        ? <td className="muted">{s.portCount}</td>
                        : <td style={ELLIPSIS} title={s.name || ''}>{shortDeviceName(s.name || '', 30) || '—'}</td>}
                      {view === 'port' && <td>{s.speed || <span className="muted">—</span>}</td>}
                      <td>{bytesPerSecText(s.avg)}</td>
                      <td>{bytesPerSecText(s.max)}</td>
                      {view === 'port' && (
                        <td style={{ color: lvl === 'none' ? TONE.muted : TONE[lvl], fontWeight: lvl === 'bad' ? 600 : 400 }}>
                          {s.sat == null ? '—' : `${s.sat}%`}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * 법인 단위 스토리지 사용량 분석(v2.412, 사용자 요구 '법인을 선택하면 그 법인에 포함된
 * 모든 스토리지의 사용량을 다수개로 분석').
 *
 * 스위치 하나가 아니라 **법인 안의 모든 스위치를 합산**한다 — 어레이는 이중화를 위해
 * 팹 A/B 두 스위치에 나눠 물리므로(OC2-1/OC2-2, OC2-3/OC2-4), 한 대만 보면 그 어레이가
 * 실제로 쓰는 트래픽의 절반만 보인다.
 *
 * 표에는 대역폭(얼마나 바쁜가)과 **용량 사용률(얼마나 찼는가)** 을 나란히 둔다. 두 축은
 * 다른 문제를 가리킨다 — 용량은 널널한데 대역폭이 포화면 경로/포트 증설이고, 반대면 디스크
 * 증설이다. 용량은 등록된 스토리지의 시리얼이 어레이 시리얼과 **확실히 일치할 때만** 붙인다.
 */
function DcStoragePerf({ dcPerf, onClose }) {
  const [hours, setHours] = useState(24);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  // 기본은 스토리지 어레이만 — 법인 합산이면 서버 HBA 가 수십 개 잡혀 표를 덮는다(실측 64개).
  const [kind, setKind] = useState('array');
  const [sort, setSort] = useState({ key: 'avg', dir: 'desc' });   // 기본: 많이 쓰는 순

  useEffect(() => {
    let alive = true;
    setData(null); setError(null);
    fetchJson('/tools/sanswitch/perf/storage-summary', { datacenterId: dcPerf.datacenterId, hours })
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [dcPerf.datacenterId, hours]);

  const series = (data?.series || []).filter((s) => kind === 'all' || s.endpointKind === kind);
  const chartSeries = topSeries(series.map((s) => ({ key: s.key, label: `${s.key} (스위치 ${s.switches.length}·포트 ${s.portCount})`, values: s.sum })), 8);
  const rows = toChartRows(data?.buckets || [], chartSeries);
  const grand = series.reduce((a, s) => a + s.avgTotal, 0);
  const SORTERS = {
    name: (s) => s.key,
    switches: (s) => s.switches.length,
    ports: (s) => s.portCount,
    avg: (s) => s.avgTotal,
    max: (s) => s.maxTotal,
    cap: (s) => (s.capacity?.pct ?? null),   // 용량 미매칭은 null → 항상 뒤로
  };
  const sorted = sortRows(series, SORTERS[sort.key] || SORTERS.avg, sort.dir, (s) => s.key);

  return (
    <Modal title={`스토리지 사용량 분석 — ${dcPerf.label}`} onClose={onClose} width={1180}>
      <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 8 }}>
        {/* 연결 대상 구분 — 어레이/호스트를 섞으면 스토리지가 HBA 수십 개에 묻힌다. */}
        {[['array', '스토리지'], ['host', '호스트(HBA)'], ['all', '전체']].map(([k, label]) => (
          <button key={k} className={kind === k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '4px 12px' }}
            onClick={() => setKind(k)}
            title={k === 'array'
              ? '벤더 심볼릭 이름이 어레이 형식이거나, 등록된 스토리지의 시리얼과 일치하는 연결 대상입니다.'
              : k === 'host' ? '서버 HBA 등 스토리지가 아닌 연결 대상입니다.' : '구분 없이 모두 봅니다.'}>
            {label}{data?.counts?.[k] != null ? ` ${data.counts[k]}` : (k === 'all' && data ? ` ${(data.series || []).length}` : '')}
          </button>
        ))}
        <span className="muted" style={{ fontSize: 12, marginLeft: 6 }}>기간</span>
        {HOURS.map(([h, label]) => (
          <button key={h} className={hours === h ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '4px 10px' }}
            onClick={() => setHours(h)}>{label}</button>
        ))}
        {data && (
          <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>
            스위치 {data.switches.length}대 합산 · {series.length}개 · 평균 합 {bytesPerSecText(grand)}
          </span>
        )}
      </div>

      {error && <ErrorBox message={error} />}
      {!error && !data && <Loading />}
      {data && !rows.length && (
        <div className="card muted" style={{ fontSize: 13, lineHeight: 1.8 }}>
          이 {dcPerf.label === '전체' ? '범위' : '법인'}에 아직 수집된 포트 사용량이 없습니다.
          <div style={{ marginTop: 4 }}>
            <b>설정 › 수집 서버 › SAN 스위치 포트 사용량</b> 에서 수집을 켜야 <code>portperfshow</code> 로 쌓기 시작합니다(기본 꺼짐).
            {data.unavailable ? <div style={{ color: 'var(--amber)', marginTop: 4 }}>이 서버는 시계열 DB(node:sqlite)를 쓸 수 없어 이력이 저장되지 않습니다.</div> : null}
            {!data.switches.length ? <div style={{ marginTop: 4 }}>이 법인에 등록된 스위치가 없습니다.</div> : null}
            {data.series?.length && !series.length
              ? <div style={{ marginTop: 4 }}>'{kind === 'array' ? '스토리지' : '호스트(HBA)'}' 로 분류된 연결 대상이 없습니다 — 위에서 '전체'를 눌러 보세요.</div>
              : null}
          </div>
        </div>
      )}

      {!!rows.length && (
        <>
          <div className="card" style={{ padding: 8, marginBottom: 8 }}>
            <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
              스토리지별 합산 처리량(법인 내 전 스위치) · 평균 사용량 상위 {chartSeries.length}개 ·
              스위치가 여러 대인 항목은 팹 A/B 를 합친 값입니다.
            </div>
            <ResponsiveContainer width="100%" height={250}>
              <LineChart data={rows} margin={{ top: 4, right: 12, bottom: 4, left: 4 }}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
                <XAxis dataKey="ts" tickFormatter={(t) => tsLabel(t, hours)} fontSize={11} minTickGap={28} />
                <YAxis tickFormatter={(v) => bps(v * 8)} fontSize={11} width={78} />
                <Tooltip labelFormatter={(t) => new Date(t).toLocaleString()} formatter={(v, name) => [bytesPerSecText(v), name]} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {chartSeries.map((s, i) => (
                  <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} dot={false}
                    stroke={LINE_COLORS[i % LINE_COLORS.length]} strokeWidth={1.6} connectNulls={false} isAnimationActive={false} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className="table-wrap" style={{ maxHeight: '40vh', overflow: 'auto' }}>
            <table style={{ tableLayout: 'fixed', width: '100%' }}>
              <colgroup>
                <col /><col style={{ width: 150 }} /><col style={{ width: 70 }} />
                <col style={{ width: 110 }} /><col style={{ width: 110 }} /><col style={{ width: 190 }} />
              </colgroup>
              <thead>
                <tr>
                  <SortTh k="name" label="스토리지" sort={sort} setSort={setSort} />
                  <SortTh k="switches" label="연결 스위치" sort={sort} setSort={setSort} />
                  <SortTh k="ports" label="포트" sort={sort} setSort={setSort} />
                  <SortTh k="avg" label="평균" sort={sort} setSort={setSort} />
                  <SortTh k="max" label="최대" sort={sort} setSort={setSort} />
                  <SortTh k="cap" label="용량 사용률" sort={sort} setSort={setSort}
                    title="등록된 스토리지 장비의 시리얼이 이 어레이 시리얼과 일치할 때만 표시합니다. 대역폭(바쁨)과 용량(참)은 다른 축이라 나란히 봐야 합니다. 미매칭은 정렬에서 뒤로 갑니다." />
                </tr>
              </thead>
              <tbody>
                {sorted.map((s) => (
                  <tr key={s.key}>
                    <td style={ELLIPSIS} title={s.key}>
                      <b>{s.key}</b>
                      <div className="muted" style={{ fontSize: 10.5 }}>
                        {s.endpointKind === 'host' ? '호스트(HBA) · ' : ''}{s.arraySerial ? `S/N ${s.arraySerial}` : ''}
                      </div>
                    </td>
                    <td style={ELLIPSIS} title={s.switches.join(', ')}>{s.switches.join(', ')}</td>
                    <td>{s.portCount}</td>
                    <td>{bytesPerSecText(s.avgTotal)}</td>
                    <td>{bytesPerSecText(s.maxTotal)}</td>
                    <td>
                      {s.capacity
                        ? <span title={`${s.capacity.name} (${s.capacity.type})`}>
                            <UsageCell pct={s.capacity.pct ?? 0} />
                            <span className="muted" style={{ fontSize: 10.5, display: 'block', ...ELLIPSIS }}>{s.capacity.name}</span>
                          </span>
                        : <span className="muted" title="등록된 스토리지와 시리얼이 일치하지 않아 용량을 붙이지 않았습니다(억지 매칭 금지).">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
            합산 대상 스위치: {data.switches.map((s) => s.name).join(' · ')}
          </div>
        </>
      )}
    </Modal>
  );
}

/** 포트 상세 — 이 화면이 '포트 모니터링'의 본체다. */
function PortDetail({ detail, setDetail, portFilter, setPortFilter, portQ, setPortQ, infoOpen, setInfoOpen, tab, setTab, sort, setSort }) {
  const d = detail;
  const list = d.ports?.list || [];
  const unit = d.extra?.rateUnit || 'fps';
  const filtered = sortPorts(filterPorts(list, portFilter).filter((p) => {
    if (!portQ.trim()) return true;
    const s = portQ.trim().toLowerCase();
    return [p.slotPort, p.portType, p.attachedName, (p.attached || []).join(' '), p.sfpVendor, p.sfpSerial]
      .some((v) => String(v || '').toLowerCase().includes(s));
  }), sort.key, sort.dir);
  return (
    <Modal title={`포트 상세 — ${d.device?.name || ''}`} onClose={() => setDetail(null)} width={1180}>
      {d.loading && <Loading />}
      {d.error && <ErrorBox message={d.error} />}
      {!d.loading && !d.error && (
        <>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            {d.model || (d.extra?.switchType
              ? <span title="chassisshow 에서 모델명(Chassis Family)을 읽지 못했습니다. 대신 스위치가 보고한 switchType 원값을 그대로 표시합니다 — 타입 코드를 모델명으로 바꾸는 표는 확실하지 않아 넣지 않았습니다.">switchType {d.extra.switchType}</span>
              : '모델 미상')} · FOS {d.fabricOs || '—'} · {d.host || ''} · {d.source} · 수집 {ago(d.collectedAt)}
            {d.ports?.portsOmitted ? (
              <div style={{ color: TONE.warn, marginTop: 4 }}>
                ⚠ 이 스위치는 엣지가 수집합니다. 회선 부담 때문에 중앙에는 <b>문제 포트만</b> 올라옵니다 —
                정상 포트 {d.ports.portsOmitted}개는 여기 표에 없습니다(요약 수치는 전체 기준으로 정확합니다).
              </div>
            ) : null}
            {d.extra?.rateReady === false && (
              <div style={{ marginTop: 4 }}>처리량은 두 번째 수집부터 표시됩니다(누적 카운터의 차이로 계산 — 첫 수집은 비교 대상이 없습니다).</div>
            )}
          </div>

          {/* 포트 목록 / 사용량 분석 전환(v2.411) — 분석 탭은 portperfshow 시계열 DB 를 읽는다. */}
          <div className="vc-views" style={{ marginBottom: 8, display: 'flex', gap: 6 }}>
            {[['ports', '포트 목록'], ['perf', '📈 사용량 분석']].map(([k, label]) => (
              <button key={k} className={tab === k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '5px 14px' }}
                onClick={() => setTab(k)}>{label}</button>
            ))}
          </div>

          {tab === 'perf' && <PerfPanel deviceId={d.deviceId} ports={list} />}

          {tab === 'ports' && <>
          <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 8 }}>
            {[['all', '전체'], ['online', '사용중'], ['free', '비어있음'], ['problem', '문제만']].map(([k, label]) => (
              <button key={k} className={portFilter === k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '4px 12px' }}
                onClick={() => setPortFilter(k)}>{label}</button>
            ))}
            {/* 장비 일반 정보(v2.411, 사용자 요구) — 수집은 하고 있었지만 화면에 쓰지 않던
                WWN·Domain·시리얼·팹·존·FRU·가동일을 여기서 보여준다. 요약은 한 줄,
                누르면 전체 항목이 펼쳐진다(표를 밀어내지 않게 기본은 접힘). */}
            <button className="tab" style={{ flex: 'none', padding: '4px 12px' }} onClick={() => setInfoOpen((v) => !v)}
              title="스위치 일반 정보 펼치기/접기">
              {infoOpen ? '▾' : '▸'} 장비 정보
            </button>
            <span className="muted" style={{ fontSize: 12 }}>{infoSummary(d)}</span>
            <SearchBox className="input" style={{ marginLeft: 'auto', maxWidth: 240 }} value={portQ} onChange={setPortQ}
              placeholder="포트·연결 장비·SFP 찾기" />
            <span className="muted" style={{ fontSize: 12 }}>{filtered.length} / {list.length}</span>
          </div>

          {infoOpen && <DeviceInfo d={d} />}

          {/* table-layout:fixed + 열 너비 명시(v2.411, 사용자 신고 '1줄에 길게 나와서 읽을 수 없음').
              기본 auto 레이아웃에서는 '연결 장비'의 긴 심볼릭 이름(SYMMETRIX::… 100자 이상)이
              칸을 밀고 나가 옆의 CRC 열 위에 겹쳐 그려졌다. 너비를 고정해야 어떤 값이 와도
              칸을 침범하지 못한다 — 긴 값은 셀 안에서 말줄임 처리하고 전문은 툴팁에 남긴다. */}
          <div className="table-wrap" style={{ maxHeight: '58vh', overflow: 'auto' }}>
            <table style={{ tableLayout: 'fixed', width: '100%' }}>
              <colgroup>
                <col style={{ width: 96 }} />{/* 포트 */}
                <col style={{ width: 74 }} />{/* 상태 */}
                <col style={{ width: 58 }} />{/* 속도 */}
                <col style={{ width: 74 }} />{/* 타입 */}
                <col />{/* 연결 장비 — 남는 폭을 가져가되 넘치면 말줄임 */}
                <col style={{ width: 150 }} />{/* 에러 카운터 */}
                <col style={{ width: 132 }} />{/* 광레벨 */}
                <col style={{ width: 74 }} />{/* SFP 온도 */}
                <col style={{ width: 118 }} />{/* 처리량 */}
              </colgroup>
              {/* 제목 클릭으로 정렬(v2.411, 사용자 요구). 값이 없는 행은 방향과 무관하게 뒤로
                  간다(sanSwitchPorts.sortPorts) — 미수집이 맨 앞에 오면 오독을 만든다. */}
              <thead>
                <tr>
                  {[
                    ['index', '포트', ''],
                    ['state', '상태', ''],
                    ['speed', '속도', ''],
                    ['portType', '타입', ''],
                    ['attached', '연결 장비', ''],
                    ['err', 'CRC / LinkFail / LossSync', '누적 에러 카운터입니다 — 마지막 초기화 이후의 합계이며, 값이 크다고 지금 장애라는 뜻은 아닙니다. 정렬은 세 값의 합 기준입니다.'],
                    ['optical', '광레벨 Rx/Tx', `SFP 수신·송신 광레벨. 일반 권장 하한 ${RX_WARN_DBM} dBm, 위험 ${RX_BAD_DBM} dBm — 정확한 임계는 SFP 모델·거리에 따라 다릅니다. 정렬은 수신(Rx) 기준입니다.`],
                    ['temp', 'SFP 온도', ''],
                    ['throughput', '처리량 (In/Out)', ''],
                  ].map(([key, label, tip]) => (
                    <th key={key} onClick={() => setSort((c) => nextSort(c, key))}
                      style={{ cursor: 'pointer', userSelect: 'none' }}
                      title={`${tip ? `${tip}\n\n` : ''}클릭하면 이 열로 정렬합니다.`}>
                      {label}{tip ? ' ⓘ' : ''}
                      <span style={{ opacity: sort.key === key ? 1 : 0.25, marginLeft: 3 }}>
                        {sort.key === key ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => {
                  const el = errorLevel(p);
                  const oh = opticalHealth(p.rxPowerDbm, p.txPowerDbm);
                  return (
                    <tr key={p.index}>
                      <td style={{ overflow: 'hidden' }}><b>{p.slotPort}</b><div className="muted" style={{ ...ELLIPSIS, fontSize: 10.5 }}>idx {p.index}{p.address ? ` · ${p.address}` : ''}</div></td>
                      <td><span style={{ color: TONE[stateTone(p.state)] }} title={p.stateRaw || ''}>{stateLabel(p.state)}</span></td>
                      <td>{p.speed || <span className="muted">—</span>}</td>
                      <td style={ELLIPSIS} title={p.portType || ''}>{p.portType || <span className="muted">—</span>}</td>
                      {/* 이름·WWN 모두 한 줄 말줄임. 전문은 툴팁(마우스 올리면 전체가 보인다). */}
                      <td style={{ overflow: 'hidden' }}
                        title={[p.attachedName, (p.attached || []).join(', ')].filter(Boolean).join('\n') || '연결된 장비 없음'}>
                        {p.attachedName
                          ? <div style={ELLIPSIS}>{shortDeviceName(p.attachedName)}</div>
                          : null}
                        <div className="muted" style={{ ...ELLIPSIS, fontSize: 10.5 }}>{(p.attached || []).join(', ') || '—'}</div>
                      </td>
                      <td style={{ color: TONE[el.level === 'ok' ? 'muted' : el.level] }}>
                        {p.errCrc ?? '—'} / {p.errLinkFail ?? '—'} / {p.errLossSync ?? '—'}
                      </td>
                      <td style={{ color: oh.level === 'none' ? TONE.muted : TONE[oh.level] }} title={oh.why}>
                        {p.rxPowerDbm ?? '—'} / {p.txPowerDbm ?? '—'}{oh.level === 'bad' || oh.level === 'warn' ? ' ⚠' : ''}
                      </td>
                      <td className="muted">{p.sfpTempC != null ? `${p.sfpTempC}℃` : '—'}</td>
                      <td>{throughputText(p, unit)}</td>
                    </tr>
                  );
                })}
                {!filtered.length && <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 20 }}>조건에 맞는 포트가 없습니다.</td></tr>}
              </tbody>
            </table>
          </div>

          </>}

          {Object.entries(d.sections || {}).filter(([, v]) => v && v !== 'ok').length > 0 && (
            <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
              미수집 항목 — 이 스위치에서 해당 명령을 실행하지 못했습니다(포트 현황에는 영향 없음):
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {Object.entries(d.sections).filter(([, v]) => v && v !== 'ok').map(([k, v]) => (
                  <li key={k} style={ELLIPSIS} title={String(v)}><b>{k}</b> — {String(v)}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
