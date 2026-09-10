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
import { fetchJson, putJson, postJson, downloadFile } from '../../api.js';
import { STable } from '../../components/STable.jsx';
import { Loading, ErrorBox } from '../../components/ui.jsx';

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

const TREND = {
  growing: { label: '증가', color: 'var(--gd-up, #f87171)' },
  flat: { label: '평탄', color: 'var(--gd-flat, #93c5fd)' },
  shrinking: { label: '감소', color: 'var(--gd-down, #4ade80)' },
};
const trendLabel = (t) => (t && TREND[t] ? TREND[t] : { label: '근거 부족', color: 'var(--muted, #9ca3af)' });
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
  const [isAdmin, setIsAdmin] = useState(false);
  const [busy, setBusy] = useState('');
  const [minReclaimStr, setMinReclaimStr] = useState('0');  // 기본 0=전체 표시(문자열 상태 — 0 이 안 지워지던 버그 수정)
  const [maxRatioStr, setMaxRatioStr] = useState('');       // 사용률(%) 이하 필터(빈 값 = 미적용)
  const [qStr, setQStr] = useState('');                     // VM/vCenter/클러스터 이름 검색(클라이언트)
  const [clusterSel, setClusterSel] = useState('');         // 클러스터 콤보 선택('' = 전체)
  const [unit, setUnit] = useState('auto');
  const [group, setGroup] = useState('none');
  const [pageSize, setPageSize] = useState('50');   // 한 화면 표시 개수('0'=전체)
  const [page, setPage] = useState(0);              // 0-based
  const [detail, setDetail] = useState(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [form, setForm] = useState(null);

  const reload = useCallback(async (mrStr = minReclaimStr, ratioStr = maxRatioStr) => {
    setError(null);
    const mr = Number(mrStr);
    const params = { minReclaimGB: Number.isFinite(mr) ? mr : 0 };
    if (ratioStr !== '' && Number.isFinite(Number(ratioStr))) params.maxRatioPct = Number(ratioStr);
    if (scopeRef.current) params.vcenterId = scopeRef.current;
    try {
      const r = await fetchJson('/tools/guest-disk', params);
      setData(r);
      setForm({ enabled: !!r.settings?.enabled, intervalHours: r.settings?.intervalHours ?? 12 });
    } catch (e) { setError(e.message); }
  }, [minReclaimStr, maxRatioStr]);

  useEffect(() => { fetchJson('/auth/me').then((m) => setIsAdmin(m?.user?.role === 'admin')).catch(() => {}); }, []);
  // 최초 로드 + 상단 vCenter 선택이 바뀔 때 재조회(현재 필터값 유지).
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  // 최소 회수(GB) 증감 버튼(+100/-100/+500/-500) — 0 미만으로는 내리지 않는다.
  const bumpMin = (delta) => {
    const next = Math.max(0, (Number(minReclaimStr) || 0) + delta);
    const s = String(next); setMinReclaimStr(s); reload(s, maxRatioStr);
  };

  const openVm = async (vmId) => {
    setDetailBusy(true); setDetail(null);
    try { setDetail(await fetchJson(`/tools/guest-disk/vm/${encodeURIComponent(vmId)}`)); }
    catch (e) { setDetail({ error: e.message }); }
    finally { setDetailBusy(false); }
  };
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

  const tableHead = (
    <thead>
      <tr>
        <th>법인</th><th>vCenter</th><th>클러스터</th><th>VM</th>
        <th>할당</th><th>사용</th><th>회수가능</th><th>사용률</th><th>파티션</th><th data-nosort>추이</th>
      </tr>
    </thead>
  );
  const rowEl = (r) => (
    <tr key={r.vmId} className="gd-row" onClick={() => openVm(r.vmId)} title="클릭하면 파티션별 상세·추이">
      <td>{r.corpName || '—'}</td>
      <td>{r.vcenterName || r.vcenterId}</td>
      <td>{r.cluster || '—'}</td>
      <td className="gd-vm">{r.vmName}</td>
      <td data-sort={r.allocGB} className="gd-num">{fmtSize(r.allocGB, unit)}</td>
      <td data-sort={r.usedGB} className="gd-num">{fmtSize(r.usedGB, unit)}</td>
      <td data-sort={r.freeGB} className="gd-num gd-free">{fmtSize(r.freeGB, unit)}</td>
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
          <div className="gd-card-m">여유 ≥ {fmtSize(data.minReclaimGB, unit)}</div>
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
        <button type="button" className="gd-btn" onClick={() => reload(minReclaimStr, maxRatioStr)}>적용</button>
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

      {rows.length === 0 ? (
        <div className="gd-empty">
          회수 대상이 없습니다. {data.settings?.enabled ? '' : '주기 수집이 꺼져 있으면 '}‘지금 수집’으로 데이터를 채운 뒤 확인하세요(VMware Tools가 실행 중인 VM만 집계됩니다).
        </div>
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

      {(detailBusy || detail) && (
        <div className="gd-detail">
          {detailBusy && <Loading />}
          {detail?.error && <ErrorBox error={detail.error} />}
          {detail && !detail.error && (
            <>
              <div className="gd-detail-head">
                <b>{detail.vmName}</b>
                <span className="muted">{detail.corpName ? `${detail.corpName} · ` : ''}{detail.vcenterName}{detail.cluster ? ` · ${detail.cluster}` : ''}</span>
                <span className="muted">할당 {fmtSize(detail.allocGB, unit)} · 사용 {fmtSize(detail.usedGB, unit)} · 회수가능 <b className="gd-free">{fmtSize(detail.freeGB, unit)}</b></span>
                {detail.vmTrend?.growthGBPerDay != null && (
                  <span style={{ color: trendLabel(detail.vmTrend.trend).color }}>전체 추이 {trendLabel(detail.vmTrend.trend).label} ({detail.vmTrend.growthGBPerDay > 0 ? '+' : ''}{detail.vmTrend.growthGBPerDay} GB/일)</span>
                )}
              </div>
              <STable className="gd-table">
                <thead><tr><th>파티션</th><th>할당</th><th>사용</th><th>여유</th><th>증가율(GB/일)</th><th>추이</th><th data-nosort>판정</th></tr></thead>
                <tbody>
                  {(detail.partitions || []).map((p) => (
                    <tr key={p.path}>
                      <td>{p.path}</td>
                      <td data-sort={p.capGB} className="gd-num">{fmtSize(p.capGB, unit)}</td>
                      <td data-sort={p.usedGB} className="gd-num">{fmtSize(p.usedGB, unit)}</td>
                      <td data-sort={p.freeGB} className="gd-num gd-free">{fmtSize(p.freeGB, unit)}</td>
                      <td data-sort={p.trend?.growthGBPerDay == null ? -9999 : p.trend.growthGBPerDay} className="gd-num">{p.trend?.growthGBPerDay == null ? '—' : p.trend.growthGBPerDay}</td>
                      <td><span style={{ color: trendLabel(p.trend?.trend).color }}>{trendLabel(p.trend?.trend).label}</span></td>
                      <td data-nosort>{p.advice?.label || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </STable>
              <p className="muted gd-note">추이는 관측 시작 이후만 표시합니다(그 이전 근거 부족). 표본이 2점 미만이면 증가율을 계산하지 않습니다.</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
