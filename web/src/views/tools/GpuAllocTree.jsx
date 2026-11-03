/**
 * GpuAllocTree — GPU 모니터링 '할당 계층' 보기(v2.852 — 승인 시안 https://claude.ai/artifact/GQKnG775UijSAU7aUSFFeB '계층 표' ·
 *   사용자 요청 "법인의 vcenter - 데이터센터 - 클러스터 - 가상화 호스트에 어떤 GPU 가 설치되어 있고 … 어떤 VM 에 얼만큼의 vGPU/GPU 가
 *   할당되어 있고 할당량/예비량이 얼마다는 표" + "결과를 excel 로").
 *
 * 숫자·판정은 서버 /tools/gpu-alloc(server/src/gpu/allocTree.js) — 이 화면은 펼치기·정렬·찾기만 한다(gpuAllocText.js).
 * 조회는 마운트 1회 + '새로 고침'(무거운 집계는 15초 폴링 금지 — 스냅샷만 읽지만 GPU VM 전부를 행으로 만든다). 늦게 온 이전 응답은 버린다(useLatest).
 * 내려받기는 data.csv 권한(canCsv)일 때만 보이고, 실패는 파일로 저장하지 않고 화면에 말한다(downloadFailText).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useLatest } from '../../hooks/useLatest.js';
import { fetchJson, downloadFile, canCsv } from '../../api.js';
import { downloadFailText } from '../downloadFailText.js';
import { Loading, ErrorBox, SearchBox } from '../../components/ui.jsx';
import { vcQuickDot } from '../vcCardText.js';
import { STable } from '../../components/STable.jsx';
import { ALLOC_LEVELS, DEFAULT_LEVEL, KIND_TEXT, flattenAlloc, openForLevel, numText, pctText, sumTotals, corpChips, allocExportQuery } from './gpuAllocText.js';
import { GpuAllocExportModal } from './GpuAllocExportModal.jsx';   // v2.855 내보내기 창(시안)

const KIND_BADGE = { vc: 'blue', dc: 'gray', cl: 'gray', host: 'blue', gpu: 'teal', pt: 'amber', vsga: 'gray', unplaced: 'gray', off: 'gray', vm: 'gray' };
const COLS = [
  { key: 'name', label: '이름' }, { key: null, label: '구분' }, { key: null, label: 'GPU 모델 · 프로파일' },
  { key: 'cap', label: '전체 GB', num: true }, { key: 'alloc', label: '할당 GB', num: true }, { key: 'spare', label: '예비 GB', num: true },
  { key: 'pct', label: '할당률' }, { key: 'off', label: '꺼진 VM GB', num: true }, { key: null, label: 'VM 켜짐/꺼짐', num: true },
  // v2.868: 호스트·VM CPU/메모리(법인~호스트 = 호스트 합 · VM = 그 VM) · 켜진 GPU VM 의 vCPU·메모리 합
  { key: 'cores', label: '코어·vCPU', num: true }, { key: 'cpuPct', label: 'CPU', num: true }, { key: 'memGB', label: '메모리 GB', num: true },
  { key: 'memPct', label: '메모리', num: true }, { key: null, label: 'GPU VM vCPU·GB', num: true },
  { key: null, label: '비고' },
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
  const [exportOpen, setExportOpen] = useState(false);   // v2.855: 엑셀은 창에서 단계·시트를 고른 뒤 받는다
  // v2.853: 법인 칩(바로가기 모양 — 사용자 요청). 빈 Set = 전체. 여러 개 고를 수 있다.
  // v2.856(버그 수정 — v2.853 보고의 '한계'): 상태 점(/vcenters)을 마운트에 한 번만 읽어 '⟳ 새로 고침' 을 눌러도 점이 그대로였다.
  //   이제 load() 가 계층과 함께 다시 읽는다. 다시 읽기가 실패하면 직전 점을 지우지 않는다(처음 실패만 빈 목록 — 점이 흐려진다).
  const [vcSel, setVcSel] = useState(() => new Set());
  const [vcs, setVcs] = useState(null);
  const runVcs = useLatest();
  const loadVcs = () => runVcs(fetchJson('/vcenters'), (d) => setVcs(Array.isArray(d) ? d : []), () => setVcs((prev) => prev ?? []));

  const load = () => {
    setLoading(true); setErr(null);
    loadVcs();
    const q = scope ? `?vcenterId=${encodeURIComponent(scope)}` : '';
    run(fetchJson(`/tools/gpu-alloc${q}`), (d) => { setData(d); setLoading(false); }, (e) => { setErr(e); setLoading(false); });
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setData(null); setOpen(null); setVcSel(new Set()); load(); }, [scope]);
  useEffect(() => { if (data && open == null) setOpen(openForLevel(data, level)); }, [data, open, level]);

  const rows = useMemo(() => (data ? flattenAlloc(data, { open: open || new Set(), sort, query, vcSel }) : []), [data, open, sort, query, vcSel]);
  const chips = useMemo(() => (data ? corpChips(data, (vcs || []).filter((v) => !scope || String(v.id) === scope)) : []), [data, vcs, scope]);
  const toggleVc = (id) => setVcSel((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const pickLevel = (lv) => { setLevel(lv); setOpen(openForLevel(data, lv)); };
  const toggle = (id) => setOpen((prev) => { const n = new Set(prev || []); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const clickSort = (key) => setSort((s) => (!s || s.key !== key ? { key, dir: key === 'name' ? 'asc' : 'desc' } : s.dir === (key === 'name' ? 'asc' : 'desc') ? { key, dir: key === 'name' ? 'desc' : 'asc' } : null));
  const download = async (fmt) => {
    setDlMsg(''); setDlBusy(fmt);
    // v2.853: 고른 법인만 내려받는다(화면과 같은 범위). 서버가 조회 범위와 교집합을 먼저 낸다. v2.855: 쿼리는 allocExportQuery 하나.
    const q = allocExportQuery({ scope, vcSel });
    try { await downloadFile(`/tools/gpu-alloc.${fmt}${q}`); } catch (e) { setDlMsg(downloadFailText(e)); } finally { setDlBusy(''); }
  };

  if (err && !data) return <ErrorBox error={err} />;
  if (!data) return <Loading />;
  const T = sumTotals(data, vcSel) || {};
  const kpis = [
    { label: '전체 용량', value: numText(T.capGB), unit: T.capGB != null ? 'GB' : '', sub: `GPU ${T.gpus}장 · 호스트 ${T.hosts}대${T.vsga ? ` · vSGA ${T.vsga}장 제외` : ''}${T.capUnknown ? ` · 모름 ${T.capUnknown}장` : ''}` },
    { label: '할당(켜진 VM)', value: numText(T.allocGB), unit: 'GB', sub: `vGPU·GPU VM ${T.vmsOn}대 켜짐${T.allocUnknown ? ` · 모름 ${T.allocUnknown}대` : ''}`, tone: 'alloc' },
    { label: '예비', value: numText(T.spareGB), unit: T.spareGB != null ? 'GB' : '', sub: `빈 GPU ${T.freeGpus}장${T.spareGB == null ? ' · 모르는 값이 섞여 계산 안 함' : ''}`, tone: 'spare' },
    { label: '할당률', value: pctText(T.allocPct), unit: '', sub: T.allocPct != null && T.allocPct >= 90 ? '포화에 가깝습니다' : '전체 대비 할당' },
    { label: '꺼진 VM', value: numText(T.offGB), unit: T.offGB != null ? 'GB' : '', sub: `${T.vmsOff}대 — 켜면 필요한 양${T.offUnknown ? ` · 모름 ${T.offUnknown}대` : ''}`, tone: 'off' },
    { label: '확인할 것', value: String((T.allocUnknown || 0) + (T.capUnknown || 0) + (T.unplaced || 0)), unit: '건', sub: `할당 모름 ${T.allocUnknown || 0} · 용량 모름 ${T.capUnknown || 0} · 미배치 VM ${T.unplaced || 0}` },
  ];
  const arrow = (key) => (sort && sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '');

  return (
    <div className="gpu-alloc">
      <div className="muted" style={{ fontSize: 12, marginBottom: 10, lineHeight: 1.6 }}>
        법인(vCenter) › 데이터센터 › 클러스터 › 호스트 › 물리 GPU › VM 순서로 보여 줍니다. <b>할당</b>은 켜진 VM 이 받은 프레임버퍼(vGPU 는 프로파일 GB, 패스스루는 GPU 한 장)이고 <b>예비</b>는 전체 − 할당입니다.
        꺼진 VM 은 GPU 에 올라가 있지 않아 따로 적습니다. 모르는 값이 섞이면 예비를 비웁니다(0 으로 채우지 않습니다). 같은 GPU 에는 같은 vGPU 프로파일만 올라가므로 예비는 그 프로파일 슬롯 단위로만 쓸 수 있습니다.
      </div>
      <div className="vc-quicknav gpu-alloc-corps" data-gpu-alloc-corps="">
        <span className="qn-label">🏢 법인</span>
        {chips.map((c) => {
          const on = vcSel.has(c.id);
          const st = c.site ? vcQuickDot(c.site) : { dot: 'var(--text-faint)', down: false };
          const none = c.hosts === 0;
          return (
            <button key={c.id} type="button" className={`qn-btn${on ? ' on' : ''}${st.down || none ? ' down' : ''}`} aria-pressed={on} onClick={() => toggleVc(c.id)}
              title={`${c.name} — GPU 호스트 ${c.hosts}대 · GPU ${c.gpus}장${none ? '(GPU 가 설치된 호스트 없음)' : ''}\n${on ? '클릭하면 선택 해제' : '클릭하면 이 법인만 표시(여러 개 선택 가능)'}`}>
              <span className="qn-dot" style={{ background: st.dot }} />{c.id}
              <span className="muted" style={{ fontWeight: 400, fontSize: 11 }}>{c.hosts}</span>
            </button>
          );
        })}
        <span className="flex gap" style={{ marginLeft: 'auto', alignItems: 'center', gap: 8 }}>
          <SearchBox className="input" style={{ maxWidth: 240, minWidth: 170 }} value={query} onChange={setQuery} placeholder="법인 · 호스트 · VM 이름 찾기" />
          {vcSel.size > 0 && <button type="button" className="qn-btn" onClick={() => setVcSel(new Set())} title="법인 선택을 모두 해제하고 전체를 봅니다.">✕ 전체 법인</button>}
        </span>
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
        <span style={{ marginLeft: 'auto' }} />
        <button type="button" className="logout-btn" style={{ flex: 'none', padding: '6px 11px' }} disabled={loading} onClick={load}>{loading ? '불러오는 중…' : '⟳ 새로 고침'}</button>
        {canCsv() && <button type="button" className="logout-btn" style={{ flex: 'none', padding: '6px 11px' }} disabled={!!dlBusy} onClick={() => download('csv')} title="GPU·VM 한 줄씩(계층 열을 모두 채운 평면 표) — UTF-8(BOM)">{dlBusy === 'csv' ? '내려받는 중…' : '⬇ CSV'}</button>}
        {canCsv() && <button type="button" className="login-btn" style={{ flex: 'none', padding: '6px 13px' }} disabled={!!dlBusy} onClick={() => setExportOpen(true)} title="넣을 단계(호스트 · GPU · VM)와 시트(계층 표 · 평면 표 · 안내)를 고른 뒤 내려받습니다">⬇ 엑셀(.xlsx)…</button>}
      </div>
      {dlMsg && <div className="error-box" style={{ marginBottom: 8 }}>{dlMsg}</div>}
      {canCsv() && exportOpen && <GpuAllocExportModal scope={scope} vcSel={vcSel} onClose={() => setExportOpen(false)} />}
      {err && <ErrorBox error={err} />}
      {(data.vcenters || []).length === 0 ? (
        <div className="card" style={{ padding: 16 }}><span className="muted">GPU 가 설치된 호스트가 없습니다.</span></div>
      ) : rows.length === 0 ? (
        <div className="card" style={{ padding: 16 }}><span className="muted">{query ? `‘${query}’ 에 맞는 법인·호스트·VM 이 없습니다` : '고른 법인에 GPU 가 설치된 호스트가 없습니다'}{vcSel.size ? ` (법인 ${[...vcSel].join(', ')} 선택 중)` : ''}.</span></div>
      ) : (
        <STable className="gpu-alloc-table" minWidth={1620}>
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
                <td className="num">{r.cores != null ? numText(r.cores) : ''}</td>
                <td className="num">{r.cpuPct != null ? pctText(r.cpuPct) : ''}</td>
                <td className="num">{r.memGB != null ? numText(r.memGB) : ''}</td>
                <td className="num">{r.memPct != null ? pctText(r.memPct) : ''}</td>
                <td className="num">{r.gvmVcpu != null || r.gvmMemGB != null ? `${numText(r.gvmVcpu)} · ${numText(r.gvmMemGB)}` : ''}</td>
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
