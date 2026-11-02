/**
 * GpuAllocTree — GPU 모니터링 '할당 계층' 보기(v2.852 — 승인 시안 https://claude.ai/artifact/GQKnG775UijSAU7aUSFFeB '계층 표' ·
 *   사용자 요청 "법인의 vcenter - 데이터센터 - 클러스터 - 가상화 호스트에 어떤 GPU 가 설치되어 있고 … 어떤 VM 에 얼만큼의 vGPU/GPU 가
 *   할당되어 있고 할당량/예비량이 얼마다는 표" + "결과를 excel 로").
 *
 * 숫자·판정은 서버 /tools/gpu/alloc(server/src/gpu/allocTree.js) — 이 화면은 펼치기·정렬·찾기만 한다(gpuAllocText.js).
 * 조회는 마운트 1회 + '새로 고침'(무거운 집계는 15초 폴링 금지 — 스냅샷만 읽지만 GPU VM 전부를 행으로 만든다). 늦게 온 이전 응답은 버린다(useLatest).
 * 내려받기는 data.csv 권한(canCsv)일 때만 보이고, 실패는 파일로 저장하지 않고 화면에 말한다(downloadFailText).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useLatest } from '../../hooks/useLatest.js';
import { fetchJson, downloadFile, canCsv } from '../../api.js';
import { downloadFailText } from '../downloadFailText.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { ALLOC_LEVELS, DEFAULT_LEVEL, KIND_TEXT, flattenAlloc, openForLevel, numText, pctText } from './gpuAllocText.js';

const KIND_BADGE = { vc: 'blue', dc: 'gray', cl: 'gray', host: 'blue', gpu: 'teal', pt: 'amber', vsga: 'gray', unplaced: 'gray', off: 'gray', vm: 'gray' };
const COLS = [
  { key: 'name', label: '이름' }, { key: null, label: '구분' }, { key: null, label: 'GPU 모델 · 프로파일' },
  { key: 'cap', label: '전체 GB', num: true }, { key: 'alloc', label: '할당 GB', num: true }, { key: 'spare', label: '예비 GB', num: true },
  { key: 'pct', label: '할당률' }, { key: 'off', label: '꺼진 VM GB', num: true }, { key: null, label: 'VM 켜짐/꺼짐', num: true }, { key: null, label: '비고' },
];

function Bar({ pct }) {
  if (pct == null) return <span className="muted">—</span>;
  const over = pct >= 90;
  return (
    <span className="gpu-alloc-bar" title={`할당률 ${pct}%`}>
      <span className="track"><span className={`fill${over ? ' over' : ''}`} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} /></span>
      <span className="num">{pctText(pct)}</span>
    </span>
  );
}

export function GpuAllocTree({ scope }) {
  const run = useLatest();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(null);       // null = 아직 단계 기본값을 정하지 않음
  const [level, setLevel] = useState(DEFAULT_LEVEL);
  const [sort, setSort] = useState(null);
  const [query, setQuery] = useState('');
  const [dlMsg, setDlMsg] = useState('');
  const [dlBusy, setDlBusy] = useState('');

  const load = () => {
    setLoading(true); setErr(null);
    const q = scope ? `?vcenterId=${encodeURIComponent(scope)}` : '';
    run(fetchJson(`/tools/gpu/alloc${q}`), (d) => { setData(d); setLoading(false); }, (e) => { setErr(e); setLoading(false); });
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setData(null); setOpen(null); load(); }, [scope]);
  useEffect(() => { if (data && open == null) setOpen(openForLevel(data, level)); }, [data, open, level]);

  const rows = useMemo(() => (data ? flattenAlloc(data, { open: open || new Set(), sort, query }) : []), [data, open, sort, query]);

  const pickLevel = (lv) => { setLevel(lv); setOpen(openForLevel(data, lv)); };
  const toggle = (id) => setOpen((prev) => { const n = new Set(prev || []); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const clickSort = (key) => setSort((s) => (!s || s.key !== key ? { key, dir: key === 'name' ? 'asc' : 'desc' } : s.dir === (key === 'name' ? 'asc' : 'desc') ? { key, dir: key === 'name' ? 'desc' : 'asc' } : null));
  const download = async (fmt) => {
    setDlMsg(''); setDlBusy(fmt);
    const q = scope ? `?vcenterId=${encodeURIComponent(scope)}` : '';
    try { await downloadFile(`/tools/gpu/alloc.${fmt}${q}`); } catch (e) { setDlMsg(downloadFailText(e)); } finally { setDlBusy(''); }
  };

  if (err && !data) return <ErrorBox error={err} />;
  if (!data) return <Loading />;
  const T = data.totals || {};
  const kpis = [
    { label: '전체 용량', value: numText(T.capGB), unit: T.capGB != null ? 'GB' : '', sub: `GPU ${T.gpus}장 · 호스트 ${T.hosts}대${T.vsga ? ` · vSGA ${T.vsga}장 제외` : ''}` },
    { label: '할당(켜진 VM)', value: numText(T.allocGB), unit: 'GB', sub: `vGPU·GPU VM ${T.vmsOn}대 켜짐`, tone: 'alloc' },
    { label: '예비', value: numText(T.spareGB), unit: T.spareGB != null ? 'GB' : '', sub: `빈 GPU ${T.freeGpus}장${T.spareGB == null ? ' · 모르는 값이 섞여 계산 안 함' : ''}`, tone: 'spare' },
    { label: '할당률', value: pctText(T.allocPct), unit: '', sub: T.allocPct != null && T.allocPct >= 90 ? '포화에 가깝습니다' : '전체 대비 할당' },
    { label: '꺼진 VM', value: numText(T.offGB), unit: T.offGB != null ? 'GB' : '', sub: `${T.vmsOff}대 — 켜면 필요한 양`, tone: 'off' },
    { label: '확인할 것', value: String((T.allocUnknown || 0) + (T.capUnknown || 0) + (T.unplaced || 0)), unit: '건', sub: `할당 모름 ${T.allocUnknown || 0} · 용량 모름 ${T.capUnknown || 0} · 미배치 VM ${T.unplaced || 0}` },
  ];
  const arrow = (key) => (sort && sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '');

  return (
    <div className="gpu-alloc">
      <div className="muted" style={{ fontSize: 12, marginBottom: 10, lineHeight: 1.6 }}>
        법인(vCenter) › 데이터센터 › 클러스터 › 호스트 › 물리 GPU › VM 순서로 보여 줍니다. <b>할당</b>은 켜진 VM 이 받은 프레임버퍼(vGPU 는 프로파일 GB, 패스스루는 GPU 한 장)이고 <b>예비</b>는 전체 − 할당입니다.
        꺼진 VM 은 GPU 에 올라가 있지 않아 따로 적습니다. 모르는 값이 섞이면 예비를 비웁니다(0 으로 채우지 않습니다). 같은 GPU 에는 같은 vGPU 프로파일만 올라가므로 예비는 그 프로파일 슬롯 단위로만 쓸 수 있습니다.
      </div>
      <div className="gpu-alloc-kpis">
        {kpis.map((k) => (
          <div key={k.label} className={`card gpu-alloc-kpi${k.tone ? ` ${k.tone}` : ''}`}>
            <div className="muted lbl">{k.label}</div>
            <div className="val">{k.value}{k.unit && <small> {k.unit}</small>}</div>
            <div className="muted sub">{k.sub}</div>
          </div>
        ))}
      </div>
      <div className="flex gap wrap gpu-alloc-ctl">
        <span className="muted" style={{ fontSize: 12 }}>펼침 단계</span>
        {ALLOC_LEVELS.map((l) => (
          <button key={l.depth} type="button" className={level === l.depth && !query ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '6px 11px' }} onClick={() => pickLevel(l.depth)}>{l.label}</button>
        ))}
        <label className="gpu-alloc-find">
          <span className="muted">찾기</span>
          <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="호스트·VM 이름" aria-label="호스트·VM 이름 찾기" />
        </label>
        <span style={{ marginLeft: 'auto' }} />
        <button type="button" className="logout-btn" style={{ flex: 'none', padding: '6px 11px' }} disabled={loading} onClick={load}>{loading ? '불러오는 중…' : '⟳ 새로 고침'}</button>
        {canCsv() && <button type="button" className="logout-btn" style={{ flex: 'none', padding: '6px 11px' }} disabled={!!dlBusy} onClick={() => download('csv')} title="GPU·VM 한 줄씩(계층 열을 모두 채운 평면 표) — UTF-8(BOM)">{dlBusy === 'csv' ? '내려받는 중…' : '⬇ CSV'}</button>}
        {canCsv() && <button type="button" className="login-btn" style={{ flex: 'none', padding: '6px 13px' }} disabled={!!dlBusy} onClick={() => download('xlsx')} title="계층 표(행 그룹 · 단계 색) · 평면 표(자동 필터) · 안내 — 3장">{dlBusy === 'xlsx' ? '만드는 중…' : '⬇ 엑셀(.xlsx)'}</button>}
      </div>
      {dlMsg && <div className="error-box" style={{ marginBottom: 8 }}>{dlMsg}</div>}
      {err && <ErrorBox error={err} />}
      {(data.vcenters || []).length === 0 ? (
        <div className="card" style={{ padding: 16 }}><span className="muted">GPU 가 설치된 호스트가 없습니다.</span></div>
      ) : rows.length === 0 ? (
        <div className="card" style={{ padding: 16 }}><span className="muted">‘{query}’ 에 맞는 호스트·VM 이 없습니다.</span></div>
      ) : (
        <STable className="gpu-alloc-table" minWidth={1180}>
          <thead>
            <tr>
              {COLS.map((c) => (c.key ? (
                <th key={c.label} className={c.num ? 'num' : ''} aria-sort={sort?.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  onClick={() => clickSort(c.key)} style={{ cursor: 'pointer' }} title="같은 단계(형제)끼리 정렬합니다">{c.label}{arrow(c.key)}</th>
              ) : <th key={c.label} className={c.num ? 'num' : ''} data-nosort>{c.label}</th>))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={`lv${r.depth} k-${r.kind}`}>
                <td>
                  <span className="gpu-alloc-name" style={{ paddingLeft: r.depth * 18 }}>
                    {r.hasKids
                      ? <button type="button" className="gpu-alloc-tog" aria-expanded={r.isOpen} aria-label={`${r.isOpen ? '접기' : '펼치기'}: ${r.name}`} onClick={() => toggle(r.id)} disabled={!!query}>{r.isOpen ? '−' : '+'}</button>
                      : <span className="gpu-alloc-tog leaf" aria-hidden="true">·</span>}
                    <span className="nm" title={r.name}>{r.name}</span>
                    {r.sub && <span className="muted sub">{r.sub}</span>}
                  </span>
                </td>
                <td><span className={`badge ${KIND_BADGE[r.kind] || 'gray'}`}>{KIND_TEXT[r.kind]}</span></td>
                <td className="prof" title={r.prof}>{r.prof}</td>
                <td className="num">{numText(r.cap)}</td>
                <td className="num alloc">{numText(r.alloc)}</td>
                <td className={`num spare${r.spare != null && r.spare < 0 ? ' neg' : ''}`}>{numText(r.spare)}</td>
                <td>{r.pct != null || r.depth < 5 ? <Bar pct={r.pct} /> : ''}</td>
                <td className="num off">{r.off != null ? numText(r.off) : ''}</td>
                <td className="num">{r.vms}</td>
                <td className={`note${r.tone ? ` t-${r.tone}` : ''}`}>{r.note}</td>
              </tr>
            ))}
          </tbody>
        </STable>
      )}
      {data.truncated > 0 && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>GPU 호스트가 많아 {data.truncated}대는 넣지 않았습니다.</div>}
    </div>
  );
}

export default GpuAllocTree;
