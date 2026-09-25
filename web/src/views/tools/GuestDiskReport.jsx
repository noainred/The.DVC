/**
 * GuestDiskReport.jsx — 게스트 디스크 회수 리포트(v2.459, v2.461 개선).
 *
 * 사용자 요구: VM별 게스트 파티션 할당/사용·비율·증가 추이를 DB에 저장해 줄일 수 있는 용량과 VM을
 * 정리해 보여주고 CSV export. v2.461 추가: 법인/vCenter/클러스터 구분, GB/TB/PB 단위 전환,
 * 최소 회수 입력 버그(0이 안 지워짐) 수정, UI 개선.
 *
 * 판정·저장은 서버(guestdisk/*)가 하고 여기서는 표시만 한다.
 */
import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { fetchJson, putJson, postJson, downloadFile, hasRole } from '../../api.js';
import { STable } from '../../components/STable.jsx';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import GuestDiskDetailModal from './GuestDiskDetailModal.jsx';
import BoldText from '../../components/boldText.jsx';
import { partsUnknownNote } from './guestDiskText.js'; // v2.600 LO2600-07: 여유 미보고 파티션 제외 안내
import { vcAuthSkipNote } from '../authSkipText.js'; // v2.591(감사 F1): vCenter 인증 정지로 건너뛴 vCenter

// ── 단위 변환(값은 GB 기준) ──────────────────────────────────────────────
const UNIT_DIV = { GB: 1, TB: 1024, PB: 1024 * 1024 };
function fmtIn(gb, unit) {
  const v = gb / UNIT_DIV[unit];
  const dec = unit === 'GB' ? (Math.abs(v) >= 100 ? 0 : 1) : 2;
  return `${v.toLocaleString(undefined, { maximumFractionDigits: dec })} ${unit}`;
}
function fmtSize(gb, unit) {
  if (gb == null || Number.isNaN(gb)) return '—';
  if (unit === 'auto') {
    const abs = Math.abs(gb);
    return fmtIn(gb, abs >= 1024 * 1024 ? 'PB' : abs >= 1024 ? 'TB' : 'GB');
  }
  return fmtIn(gb, unit);
}
const pct = (x) => (x == null ? '—' : `${x}%`);

const when = (ts) => (ts ? new Date(ts).toLocaleString() : '—');

const UNIT_OPTS = [['auto', '자동'], ['GB', 'GB'], ['TB', 'TB'], ['PB', 'PB']];
const GROUP_OPTS = [['none', '없음'], ['corp', '법인'], ['vcenter', 'vCenter'], ['cluster', '클러스터']];
const groupField = { corp: 'corpName', vcenter: 'vcenterName', cluster: 'cluster' };
const PAGE_OPTS = [['25', '25'], ['50', '50'], ['100', '100'], ['200', '200'], ['0', '전체']];

// 세그먼트 컨트롤(단위·구분 토글)
function Segmented({ opts, value, onChange, label }) {
  return (
    <div className="gd-seg-wrap">
      {label && <span className="gd-seg-label">{label}</span>}
      <div className="gd-seg" role="tablist">
        {opts.map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={value === k}
            className={`gd-seg-btn${value === k ? ' active' : ''}`} onClick={() => onChange(k)}>{l}</button>
        ))}
      </div>
    </div>
  );
}

export default function GuestDiskReport({ scope = '' }) {
  const scopeRef = useRef(scope); scopeRef.current = scope;   // 상단 vCenter 선택('' = 전체)
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const isAdmin = hasRole('admin'); // v2.613 WEB2613-01: 역할은 App 이 채운 현재 사용자 객체에서 읽는다(화면이 /auth/me 를 다시 부르지 않는다).
  const [busy, setBusy] = useState('');
  const [minReclaimStr, setMinReclaimStr] = useState('0');  // 기본 0=전체 표시(문자열 상태 — 0 이 안 지워지던 버그 수정)
  const [maxRatioStr, setMaxRatioStr] = useState('');       // 사용률(%) 이하 필터(빈 값 = 미적용)
  const [factorStr, setFactorStr] = useState('1');          // v2.482 사용량 배율 — 회수 = 할당 − 사용×배율(기본 1)
  const [qStr, setQStr] = useState('');                     // VM/vCenter/클러스터 이름 검색(클라이언트)
  const [clusterSel, setClusterSel] = useState('');         // 클러스터 콤보 선택('' = 전체)
  const [unit, setUnit] = useState('auto');
  const [group, setGroup] = useState('none');
  const [pageSize, setPageSize] = useState('50');   // 한 화면 표시 개수('0'=전체)
  const [page, setPage] = useState(0);              // 0-based
  const [detailVm, setDetailVm] = useState(null);   // { id, name } — 추이 상세 팝업 대상
  const [form, setForm] = useState(null);
  const reqGen = useRef(0);   // v2.606 WEB2606-07: 마지막 reload 세대

  const reload = useCallback(async (mrStr = minReclaimStr, ratioStr = maxRatioStr, fStr = factorStr) => {
    setError(null);
    const mr = Number(mrStr);
    const params = { minReclaimGB: Number.isFinite(mr) ? mr : 0 };
    if (ratioStr !== '' && Number.isFinite(Number(ratioStr))) params.maxRatioPct = Number(ratioStr);
    if (fStr !== '' && Number.isFinite(Number(fStr)) && Number(fStr) > 0 && Number(fStr) !== 1) params.usageFactor = Number(fStr);
    if (scopeRef.current) params.vcenterId = scopeRef.current;
    // v2.606(감사 WEB2606-07): 세대 ref — vCenter·필터를 바꿔 reload 가 겹치면 **마지막 요청의 응답만** 반영한다.
    // 느린 '전체' 응답이 뒤에 오면 선택은 vCenter X 인데 표는 전 법인이 됐다(v2.596 WS 규약의 누락).
    const gen = ++reqGen.current;
    try {
      const r = await fetchJson('/tools/guest-disk', params);
      if (gen !== reqGen.current) return;
      setData(r);
      setForm({ enabled: !!r.settings?.enabled, intervalHours: r.settings?.intervalHours ?? 12 });
    } catch (e) { if (gen === reqGen.current) setError(e.message); }
  }, [minReclaimStr, maxRatioStr, factorStr]);

  // 최초 로드 + 상단 vCenter 선택이 바뀔 때 재조회(현재 필터값 유지).
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  // 최소 회수(GB) 증감 버튼(+100/-100/+500/-500) — 0 미만으로는 내리지 않는다.
  const bumpMin = (delta) => {
    const next = Math.max(0, (Number(minReclaimStr) || 0) + delta);
    const s = String(next); setMinReclaimStr(s); reload(s, maxRatioStr, factorStr);
  };
  // 사용량 배율 프리셋 — 누르면 즉시 재조회.
  const setFactor = (v) => { const s = String(v); setFactorStr(s); reload(minReclaimStr, maxRatioStr, s); };

  // 행 클릭 → 추이 상세 팝업(모달)을 연다. 데이터·기간 조회는 모달이 스스로 한다.
  const openVm = (r) => setDetailVm({ id: r.vmId, name: r.vmName });
  const runNow = async () => {
    setBusy('run');
    try {
      const r = await postJson('/tools/guest-disk/run', {}); await reload(minReclaimStr);
      if (r.skipped) alert('이미 수집이 진행 중입니다.');
      else if (!r.ok) alert(`수집 실패: ${r.reason || '알 수 없음'}`);
    } catch (e) { alert(`수집 실패: ${e.message}`); } finally { setBusy(''); }
  };
  const saveSettings = async () => {
    setBusy('save');
    try { await putJson('/tools/guest-disk/settings', form); await reload(minReclaimStr); }
    catch (e) { alert(`저장 실패: ${e.message}`); } finally { setBusy(''); }
  };
  const exportCsv = () => {
    const q = new URLSearchParams({ minReclaimGB: String(Number(minReclaimStr) || 0) });
    if (maxRatioStr !== '' && Number.isFinite(Number(maxRatioStr))) q.set('maxRatioPct', String(Number(maxRatioStr)));
    if (Number.isFinite(Number(factorStr)) && Number(factorStr) > 0 && Number(factorStr) !== 1) q.set('usageFactor', String(Number(factorStr)));
    if (scope) q.set('vcenterId', scope);
    downloadFile(`/api/tools/guest-disk/export.csv?${q.toString()}`).catch((e) => alert(e.message));
  };

  // 콤보용 클러스터 목록 — 서버 인벤토리 기준(선택 vCenter 의 클러스터, 게스트 데이터가 없어도 채워짐).
  // 서버가 안 주면 로드된 데이터에서 유추(하위호환).
  const clusterOpts = useMemo(() => {
    if (Array.isArray(data?.clusters) && data.clusters.length) return data.clusters;
    return [...new Set((data?.rows || []).map((r) => r.cluster).filter((c) => c && c !== '(미지정)'))].sort((a, b) => a.localeCompare(b));
  }, [data]);
  const rows = useMemo(() => {
    let all = data?.rows || [];
    if (clusterSel) all = all.filter((r) => r.cluster === clusterSel);
    const q = qStr.trim().toLowerCase();
    if (!q) return all;
    return all.filter((r) => `${r.vmName || ''} ${r.vcenterName || ''} ${r.cluster || ''} ${r.corpName || ''}`.toLowerCase().includes(q));
  }, [data, qStr, clusterSel]);
  // 구분(그룹핑) — 선택 축으로 묶고 회수합계 내림차순 정렬.
  const groups = useMemo(() => {
    if (group === 'none') return null;
    const field = groupField[group];
    const m = new Map();
    for (const r of rows) {
      const key = r[field] || '(미지정)';
      if (!m.has(key)) m.set(key, { key, rows: [], free: 0, alloc: 0, used: 0 });
      const g = m.get(key);
      g.rows.push(r); g.free += r.freeGB || 0; g.alloc += r.allocGB || 0; g.used += r.usedGB || 0;
    }
    return [...m.values()].sort((a, b) => b.free - a.free);
  }, [rows, group]);

  // 페이지네이션 — 구분 없음이면 VM 행, 구분이면 그룹을 한 화면 개수 단위로 나눈다('0'=전체).
  const items = group === 'none' ? rows : (groups || []);
  const perPage = Number(pageSize) || 0;
  const totalPages = perPage > 0 ? Math.max(1, Math.ceil(items.length / perPage)) : 1;
  const pageClamped = Math.min(page, totalPages - 1);
  const pageItems = perPage > 0 ? items.slice(pageClamped * perPage, pageClamped * perPage + perPage) : items;
  // 구분·페이지 크기·데이터가 바뀌면 첫 페이지로(훅은 조기 return 위에 둔다 — React #310).
  useEffect(() => { setPage(0); }, [group, pageSize, data, qStr, clusterSel]);
  // vCenter(범위)가 바뀌면 이전 vCenter 의 클러스터 선택은 무효 — 전체로 되돌린다.
  useEffect(() => { setClusterSel(''); }, [scope]);
  // 선택한 클러스터가 새 데이터에 없으면 전체로.
  useEffect(() => { if (clusterSel && !clusterOpts.includes(clusterSel)) setClusterSel(''); }, [clusterOpts, clusterSel]);

  if (error && !data) return <ErrorBox error={error} />;
  if (!data) return <Loading />;

  const poller = data.poller || {};
  const dbOk = data.db?.available;
  const coverage = Array.isArray(data.coverage) ? data.coverage : [];
  const covWithData = coverage.filter((c) => c.vmCount > 0).length;
  const covEmpty = coverage.length - covWithData;
  const uf = Number(data.usageFactor) || 1;   // 서버가 실제 적용한 배율(정규화 후)

  const tableHead = (
    <thead>
      <tr>
        <th>법인</th><th>vCenter</th><th>클러스터</th><th>VM</th>
        <th className="gd-num">할당</th><th className="gd-num">사용</th><th className="gd-num" title={uf !== 1 ? `회수가능 = 할당 − 사용 × ${uf}` : '회수가능 = 할당 − 사용'}>회수가능{uf !== 1 ? ` (×${uf})` : ''}</th><th className="gd-num">사용률</th><th className="gd-num">파티션</th><th data-nosort>추이</th>
      </tr>
    </thead>
  );
  const rowEl = (r) => (
    <tr key={r.vmId} className="gd-row" onClick={() => openVm(r)} title="클릭하면 파티션별 상세·추이(팝업)">
      <td>{r.corpName || '—'}</td>
      <td>{r.vcenterName || r.vcenterId}</td>
      <td>{r.cluster || '—'}</td>
      <td className="gd-vm">{r.vmName}</td>
      <td data-sort={r.allocGB} className="gd-num">{fmtSize(r.allocGB, unit)}</td>
      <td data-sort={r.usedGB} className="gd-num">{fmtSize(r.usedGB, unit)}</td>
      <td data-sort={r.freeGB} className="gd-num gd-free" title={uf !== 1 ? `${fmtSize(r.allocGB, unit)} − ${fmtSize(r.usedGB, unit)} × ${uf} (필요 ${fmtSize(r.neededGB, unit)})` : undefined}>{fmtSize(r.freeGB, unit)}</td>
      <td data-sort={r.ratioPct == null ? -1 : r.ratioPct} className="gd-num">
        <div className="gd-ratio"><span>{pct(r.ratioPct)}</span><i style={{ width: `${Math.min(100, r.ratioPct || 0)}%` }} /></div>
      </td>
      <td data-sort={r.partCount} className="gd-num">{r.partCount}</td>
      <td data-nosort><span className="gd-more">상세 ▸</span></td>
    </tr>
  );

  return (
    <div className="gd-report">
      <div className="gd-hero">
        <h3>게스트 디스크 회수 리포트</h3>
        <p>VM 게스트(VMware Tools) 파티션의 <b>할당</b> 대비 <b>사용</b>을 비교해 <b>줄일 수 있는 여유(회수 가능)</b>가 큰 VM을 정렬합니다.
          행을 클릭하면 파티션별 <b>증가 추이</b>와 회수 판정을 봅니다. 여유는 <b>게스트 관점의 회수 상한</b>이며, 실제 회수는 디스크 축소(shrink)+UNMAP이 필요합니다.</p>
      </div>

      <div className="gd-cards">
        <div className="gd-card accent">
          <div className="gd-card-k">회수 가능 합계</div>
          <div className="gd-card-v">{fmtSize(data.totalReclaimGB, unit === 'auto' ? 'auto' : unit)}</div>
          <div className="gd-card-m">여유 ≥ {fmtSize(data.minReclaimGB, unit)}{uf !== 1 ? ` · 배율 ×${uf} (회수 = 할당 − 사용×${uf})` : ''}</div>
        </div>
        <div className="gd-card">
          <div className="gd-card-k">대상 VM</div>
          <div className="gd-card-v">{data.vmCount.toLocaleString()}<small>대</small></div>
          <div className="gd-card-m">{group === 'none' ? '구분 없음' : `${groups?.length || 0}개 ${GROUP_OPTS.find((g) => g[0] === group)[1]}`}</div>
        </div>
        <div className="gd-card">
          <div className="gd-card-k">주기 수집</div>
          <div className={`gd-card-v ${data.settings?.enabled ? 'on' : 'off'}`}>{data.settings?.enabled ? '켜짐' : '꺼짐'}</div>
          <div className="gd-card-m">{poller.lastRunTs ? `최근 ${when(poller.lastRunTs)}` : '아직 수집 없음'}</div>
        </div>
        <div className="gd-card">
          <div className="gd-card-k">추이 DB</div>
          <div className={`gd-card-v ${dbOk ? 'on' : 'off'}`}>{dbOk ? '정상' : '사용 불가'}</div>
          <div className="gd-card-m">{dbOk ? '변경분 diff-저장' : (data.db?.error || 'node:sqlite 없음')}</div>
        </div>
      </div>

      <div className="gd-toolbar">
        <Segmented label="단위" opts={UNIT_OPTS} value={unit} onChange={setUnit} />
        <Segmented label="구분" opts={GROUP_OPTS} value={group} onChange={setGroup} />
        <Segmented label="개수" opts={PAGE_OPTS} value={pageSize} onChange={setPageSize} />
        {/* v2.482 사용량 배율 — 회수 가능 = 할당 − 사용×배율. 100 TB 할당·30 TB 사용에 ×2 → 40 TB. */}
        <div className="gd-min" title="회수 가능 = 할당 − 사용 × 배율. 사용량의 N배는 운영 여유로 남겨 둔다는 뜻입니다(예: 100 TB 할당·30 TB 사용, ×2 → 40 TB).">
          <span>사용량 배율</span>
          {[1, 1.5, 2, 3].map((v) => <button key={v} type="button" className={`gd-step${Number(factorStr) === v ? ' gd-step-on' : ''}`} onClick={() => setFactor(v)}>×{v}</button>)}
          <input type="text" inputMode="decimal" style={{ width: 56 }} value={factorStr}
            onChange={(e) => setFactorStr(e.target.value.replace(/[^\d.]/g, ''))}
            onKeyDown={(e) => { if (e.key === 'Enter') reload(minReclaimStr, maxRatioStr, factorStr); }} placeholder="1" />
          <span className="muted" style={{ fontSize: 11 }}>배 → 회수 = 할당 − 사용×배율</span>
        </div>
      </div>
      <div className="gd-toolbar">
        <label className="gd-min gd-search">
          <span>검색</span>
          <input type="text" value={qStr} onChange={(e) => setQStr(e.target.value)} placeholder="VM·vCenter·클러스터 이름" />
          {qStr && <button type="button" className="gd-step" onClick={() => setQStr('')} title="검색 지우기">✕</button>}
        </label>
        <label className="gd-min">
          <span>클러스터</span>
          <select className="gd-sel" value={clusterSel} onChange={(e) => setClusterSel(e.target.value)}
            title={clusterOpts.length ? '' : '표시할 데이터가 있어야 클러스터가 채워집니다'}>
            <option value="">전체 클러스터{clusterOpts.length ? ` (${clusterOpts.length})` : ''}</option>
            {clusterOpts.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <div className="gd-min">
          <span>최소 회수(GB)</span>
          <button type="button" className="gd-step" onClick={() => bumpMin(-500)}>-500</button>
          <button type="button" className="gd-step" onClick={() => bumpMin(-100)}>-100</button>
          <input type="text" inputMode="numeric" value={minReclaimStr}
            onChange={(e) => setMinReclaimStr(e.target.value.replace(/[^\d.]/g, ''))}
            onKeyDown={(e) => { if (e.key === 'Enter') reload(minReclaimStr, maxRatioStr); }} placeholder="0" />
          <button type="button" className="gd-step" onClick={() => bumpMin(100)}>+100</button>
          <button type="button" className="gd-step" onClick={() => bumpMin(500)}>+500</button>
        </div>
        <label className="gd-min">
          <span>사용률(%) 이하</span>
          <input type="text" inputMode="numeric" style={{ width: 64 }} value={maxRatioStr}
            onChange={(e) => setMaxRatioStr(e.target.value.replace(/[^\d.]/g, ''))}
            onKeyDown={(e) => { if (e.key === 'Enter') reload(minReclaimStr, maxRatioStr); }} placeholder="전체" />
          {maxRatioStr !== '' && <button type="button" className="gd-step" onClick={() => { setMaxRatioStr(''); reload(minReclaimStr, ''); }} title="필터 해제">✕</button>}
        </label>
        <button type="button" className="gd-btn" onClick={() => reload(minReclaimStr, maxRatioStr, factorStr)}>적용</button>
        {isAdmin && <button type="button" className="gd-btn" disabled={busy === 'run'} onClick={runNow}>{busy === 'run' ? '수집 중…' : '지금 수집'}</button>}
        <div className="gd-spacer" />
        <button type="button" className="gd-btn primary" onClick={exportCsv} disabled={!rows.length}>⬇ CSV ({data.vmCount})</button>
      </div>

      {isAdmin && form && (
        <div className="gd-admin">
          <b>주기 수집 설정 (관리자)</b>
          <label className="gd-chk"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> 주기 수집 사용(opt-in)</label>
          <label className="gd-inline">주기(시간)<input type="text" inputMode="numeric" value={String(form.intervalHours)} onChange={(e) => setForm({ ...form, intervalHours: e.target.value.replace(/[^\d]/g, '') })} /></label>
          <button type="button" className="gd-btn primary" disabled={busy === 'save'} onClick={saveSettings}>{busy === 'save' ? '저장 중…' : '저장'}</button>
          <span className="gd-admin-note">5,850 VM 규모라 기본 꺼짐입니다. 켜면 {form.intervalHours || 12}시간마다 전 vCenter 게스트 디스크를 수집해 추이를 쌓습니다.</span>
        </div>
      )}

      {vcAuthSkipNote(poller.lastResult?.authStopped, { what: '게스트 디스크 수집', manual: '지금 수집' }) && (
        <div className="gd-warn"><BoldText text={vcAuthSkipNote(poller.lastResult?.authStopped, { what: '게스트 디스크 수집', manual: '지금 수집' })} /></div>
      )}
      {partsUnknownNote(poller.lastResult?.partsUnknown) && (
        <div className="gd-warn"><BoldText text={partsUnknownNote(poller.lastResult?.partsUnknown)} /></div>
      )}
      {poller.lastResult?.errors?.length > 0 && (
        <div className="gd-warn">최근 수집에서 {poller.lastResult.errors.length}개 vCenter 조회 실패(엣지 수집 vCenter는 중앙에서 직접 접속이 안 될 수 있습니다).</div>
      )}

      {rows.length > 0 && (
        <div className="gd-pager">
          <span className="gd-pager-sum">
            전체 <b>{data.vmCount.toLocaleString()}</b>대
            {group !== 'none' && <> · <b>{items.length}</b>개 {GROUP_OPTS.find((g) => g[0] === group)[1]}</>}
            {perPage > 0
              ? <> · <b>{totalPages}</b>페이지 중 <b>{pageClamped + 1}</b>페이지 ({perPage}{group === 'none' ? '개' : '그룹'}씩)</>
              : <> · 전체 한 화면</>}
          </span>
          {perPage > 0 && totalPages > 1 && (
            <span className="gd-pager-btns">
              <button type="button" className="gd-step" disabled={pageClamped <= 0} onClick={() => setPage(0)}>« 처음</button>
              <button type="button" className="gd-step" disabled={pageClamped <= 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>‹ 이전</button>
              <span className="gd-pager-pos">{pageClamped + 1} / {totalPages}</span>
              <button type="button" className="gd-step" disabled={pageClamped >= totalPages - 1} onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}>다음 ›</button>
              <button type="button" className="gd-step" disabled={pageClamped >= totalPages - 1} onClick={() => setPage(totalPages - 1)}>끝 »</button>
            </span>
          )}
        </div>
      )}

      {coverage.length > 0 && (
        <details className="gd-coverage" open={rows.length === 0}>
          <summary>
            vCenter 커버리지 — {coverage.length}개 중 <b>{covWithData}</b>개 데이터 있음{covEmpty > 0 ? `, ${covEmpty}개 없음` : ''}
          </summary>
          <STable minWidth={720} className="gd-table">
            <thead><tr><th>vCenter</th><th>법인</th><th>수집원</th><th className="gd-num">데이터 VM</th><th>최근 수집</th><th data-nosort>상태</th></tr></thead>
            <tbody>
              {coverage.map((c) => (
                <tr key={c.vcenterId}>
                  <td>{c.vcenterName}</td>
                  <td>{c.corpName || '—'}</td>
                  <td>{c.collectSource === 'site' ? '엣지 수집(push)' : '중앙 직접'}</td>
                  <td data-sort={c.vmCount} className="gd-num">{c.vmCount.toLocaleString()}</td>
                  <td data-sort={c.lastTs || 0}>{when(c.lastTs)}</td>
                  <td data-nosort>{c.vmCount > 0 ? '✅ 데이터 있음' : (c.collectSource === 'site' ? '⏳ 엣지 push 대기' : '⏳ 미수집')}</td>
                </tr>
              ))}
            </tbody>
          </STable>
          <p className="muted gd-note">‘데이터 VM’은 VMware Tools가 파티션을 보고한 VM 수입니다. <b>엣지 수집(site)</b> vCenter는 중앙이 직접 접속할 수 없어, 엣지가 게스트 디스크를 중앙으로 push할 때 채워집니다(기본 12시간 주기). <b>중앙 직접</b> vCenter는 ‘지금 수집’ 또는 주기 수집을 켜면 채워집니다.</p>
        </details>
      )}

      {rows.length === 0 ? (
        (data.collectedCount > 0 && !qStr && !clusterSel) ? (
          // 데이터는 있는데(수집됨) 필터가 다 걸러낸 경우 — '데이터 없음'과 구분해 정직하게 안내.
          <div className="gd-empty">
            범위 내 <b>{data.collectedCount.toLocaleString()}대</b>가 수집됐지만, <b>최소 회수 {fmtSize(data.minReclaimGB, unit)}</b> 조건{Number.isFinite(Number(maxRatioStr)) && maxRatioStr !== '' ? <> · <b>사용률 {maxRatioStr}% 이하</b> 조건</> : ''}을 넘는 VM이 없습니다.
            {' '}가장 여유가 큰 VM도 <b className="gd-free">{fmtSize(data.maxFreeGB, unit)}</b>입니다{data.maxFreeGB > 0 ? '' : ' (모든 VM이 할당=사용, 즉 회수 여유 0)'}.
            <div style={{ marginTop: 10 }}>
              <button type="button" className="gd-btn primary"
                onClick={() => { setMinReclaimStr('0'); setMaxRatioStr(''); reload('0', ''); }}>
                최소 회수 0으로 전체 보기 ({data.collectedCount.toLocaleString()}대)
              </button>
              {data.maxFreeGB > 0 && (
                <span className="gd-admin-note" style={{ marginLeft: 10 }}>
                  또는 최소 회수를 {Math.max(1, Math.floor(data.maxFreeGB / 2))} 이하로 낮춰 보세요.
                </span>
              )}
            </div>
          </div>
        ) : (
          <div className="gd-empty">
            {data.collectedCount > 0
              ? <>수집된 {data.collectedCount.toLocaleString()}대 중 현재 검색·클러스터·필터 조건에 맞는 VM이 없습니다. 검색어/클러스터/최소 회수를 조정하세요.</>
              : <>회수 대상이 없습니다. {data.settings?.enabled ? '' : '주기 수집이 꺼져 있으면 '}‘지금 수집’으로 데이터를 채운 뒤 확인하세요(VMware Tools가 실행 중인 VM만 집계됩니다).</>}
            {data.collectedCount === 0 && covEmpty > 0 && <> 위 <b>vCenter 커버리지</b>에서 데이터가 없는 vCenter와 사유(엣지 push 대기/미수집)를 확인하세요.</>}
          </div>
        )
      ) : group === 'none' ? (
        <STable className="gd-table">{tableHead}<tbody>{pageItems.map(rowEl)}</tbody></STable>
      ) : (
        <div className="gd-groups">
          {pageItems.map((g) => (
            <details key={g.key} className="gd-group" open={groups.length <= 8}>
              <summary>
                <span className="gd-group-name">{g.key}</span>
                <span className="gd-group-meta">{g.rows.length}대 · 회수가능 <b className="gd-free">{fmtSize(g.free, unit)}</b> · 할당 {fmtSize(g.alloc, unit)}</span>
              </summary>
              <STable className="gd-table">{tableHead}<tbody>{g.rows.map(rowEl)}</tbody></STable>
            </details>
          ))}
        </div>
      )}

      {detailVm && <GuestDiskDetailModal vm={detailVm} initUnit={unit} usageFactor={uf} onClose={() => setDetailVm(null)} />}
    </div>
  );
}
