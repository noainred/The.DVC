// views/VmListExportDialog.jsx — '백업 내보내기' 창(v2.798 — v2.800 부터 서버 › Veeam 백업 현황 › Detail 의 CSV 버튼).
// v2.800(사용자 지시 "vCenter 화면은 전체 VM, 백업 현황은 백업 — 분리"): vCenter 화면은 'VM 전체 정보 내보내기'(tools/VmExport.jsx)를 연다.
//   이 창은 백업 항목(기본 식별 · Veeam · 스냅샷 · 백업 표시 · 메모·태그)만 고르고, 엑셀은 요약 · 폴더 트리 · 데이터 시트를 만든다.
// 사용자 요청: "메모, TAG, 디스크 파티션 종류 등의 구성 정보에서 내가 필요한 것만 선택해서 export" + "지금 설정을 기본값으로 · 이름1~5 다섯 칸 · 저장하는 값을 지정".
// 시안 https://claude.ai/artifact/FS8Uk5piEnbFJE7qvLRWQW. 항목·조합은 서버 카탈로그(GET /veeam/vm-list/catalog)를 그대로 쓴다(복제하지 않는다).
// 저장값은 계정에(PUT /veeam/vm-list/prefs — 본인 것만). 미리보기는 고른 항목으로 대상 첫 3대(서버가 내려받기와 같은 표 함수로 만든다).
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, postJson, putJson, postDownload } from '../api.js';
import { Modal } from '../components/Modal.jsx';
import { STable } from '../components/STable.jsx';
import Select from '../components/Select.jsx';
import { ErrorBox } from '../components/primitives.jsx';
import { VM_LIST_MAX_IDS } from './vcdVmList.js';
import {
  SLOT_COUNT, NAME_MAX, SAVE_WHAT, folderOptions, vmsInFolder, availBadge, moveCol, toggleCol, addCols, dropCols,
  valueToSave, applyValue, initialState, slotLabel, defaultLine, savedText, exportBody,
} from './vmListExportText.js';

const TONE = { ok: '#86efac', run: '#93c5fd', warn: '#fcd34d', none: 'var(--text-dim)' };
const BORDER = { ok: '#14532d', run: '#1e3a8a', warn: '#713f12', none: 'var(--border-soft)' };
const chipBtn = (on) => ({ flex: 'none', fontSize: 12.5, borderRadius: 99, padding: '5px 12px', ...(on ? { background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' } : {}) });

/**
 * @param {{ vcenterId:string, vcName:string, vms:Array, screenReq:{body:object|null,count:number,error?:string}, screenText:string, downloadFailText:(e)=>string, onLegacyCsv?:()=>void, onClose:()=>void }} p
 *   vms = 백업 현황이 받은 VM(전원·제외 반영 — 폴더 고르기의 범위) · screenReq = 화면 기준 요청(vmListExportText.backupScreenRequest — 보기·검색 반영)
 *   onLegacyCsv = 예전 '화면 열 그대로' CSV(GET /tools/backup-detail.csv — 외부 스크립트 호환으로 남김)
 */
export default function VmListExportDialog({ vcenterId, vcName, vms, screenReq, screenText, downloadFailText, onLegacyCsv, onClose }) {
  const [cat, setCat] = useState(null);
  const [err, setErr] = useState(null);
  const [prefs, setPrefs] = useState(null);
  const [st, setSt] = useState(null);           // { cols, fmt, tagCols, target, folder }
  const [q, setQ] = useState('');
  const [save, setSave] = useState(null);       // { slot, name, what:{fmt,tagCols,target}, alsoDefault } — 열렸을 때만
  const [msg, setMsg] = useState(null);         // { ok, text }
  const [busy, setBusy] = useState('');
  const [pv, setPv] = useState(null);
  const pvGen = useRef(0);

  useEffect(() => {
    let alive = true;
    fetchJson(`/veeam/vm-list/catalog?vcenterId=${encodeURIComponent(vcenterId)}`)
      .then((r) => { if (!alive) return; setCat(r); setPrefs(r.prefs || null); setSt(initialState(r, r.prefs)); })
      .catch((e) => { if (alive) setErr(e); });
    return () => { alive = false; };
  }, [vcenterId]);

  const folders = useMemo(() => folderOptions(vms), [vms]);
  const folderVms = useMemo(() => (st?.target === 'folder' && st.folder ? vmsInFolder(vms, st.folder) : []), [vms, st?.target, st?.folder]);
  const target = st ? exportBody(st, screenReq, folderVms) : null;
  const itemOf = useMemo(() => new Map((cat?.groups || []).flatMap((g) => g.items).map((it) => [it.key, it])), [cat]);

  // 미리보기 — 고른 항목이 바뀌면 0.5초 뒤 대상 첫 3대. 늦게 온 이전 응답은 버린다.
  const pvIds = useMemo(() => {
    if (!st) return [];
    if (st.target === 'folder') return folderVms.slice(0, 3).map((v) => v.id);
    return (screenReq?.body?.ids || vms.map((v) => v.id)).slice(0, 3);
  }, [st, folderVms, screenReq, vms]);
  const pvKey = st ? JSON.stringify([st.cols, st.tagCols, pvIds]) : '';
  useEffect(() => {
    if (!st || !st.cols.length || !pvIds.length) { setPv(null); return undefined; }
    const my = ++pvGen.current;
    const h = setTimeout(() => {
      postJson(`/veeam/vm-list/preview?vcenterId=${encodeURIComponent(vcenterId)}`, { cols: st.cols, tagCols: st.tagCols, ids: pvIds })
        .then((r) => { if (my === pvGen.current) setPv(r?.ok === false ? { error: r.reason } : r); })
        .catch((e) => { if (my === pvGen.current) setPv({ error: e?.message || '미리보기를 받지 못했습니다' }); });
    }, 500);
    return () => clearTimeout(h);
  }, [pvKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (err) return <Modal title="백업 내보내기" onClose={onClose} width={720}><ErrorBox error={err} /></Modal>;
  if (!cat || !st) return <Modal title="백업 내보내기" onClose={onClose} width={720}><div className="muted">항목 목록을 불러오는 중…</div></Modal>;

  const set = (patch) => setSt((x) => ({ ...x, ...patch }));
  const ql = q.trim().toLowerCase();
  const presetOn = (p) => p.keys.length === st.cols.length && p.keys.every((k, i) => st.cols[i] === k);
  const tooMany = target && target.count > VM_LIST_MAX_IDS && st.target === 'folder';
  const canDownload = st.cols.length > 0 && target?.body && !tooMany && !busy && (st.target !== 'folder' || (st.folder && folderVms.length));

  const download = async () => {
    if (!canDownload) return;
    setBusy('down'); setMsg(null);
    try { await postDownload(`/veeam/vm-list.${st.fmt}?vcenterId=${encodeURIComponent(vcenterId)}`, target.body); }
    catch (e) { setMsg({ ok: false, text: downloadFailText(e) }); }
    finally { setBusy(''); }
  };
  const putPref = async (slot, value, alsoDefault = false) => {
    setBusy('save'); setMsg(null);
    try {
      const r = await putJson('/veeam/vm-list/prefs', { slot, value, alsoDefault });
      if (r?.ok === false) { setMsg({ ok: false, text: r.reason || '저장하지 못했습니다.' }); return false; }
      setPrefs(r.prefs); setMsg({ ok: true, text: savedText(slot, value, alsoDefault) });
      return true;
    } catch (e) { setMsg({ ok: false, text: e?.message || '저장하지 못했습니다.' }); return false; }
    finally { setBusy(''); }
  };
  const openSave = () => {
    const empty = (prefs?.slots || []).findIndex((s) => !s);
    const i = empty >= 0 ? empty : 0;
    setSave({ slot: i + 1, name: prefs?.slots?.[i]?.name || `이름${i + 1}`, what: { fmt: true, tagCols: true, target: false }, alsoDefault: false });
  };
  const pickSlot = (n) => setSave((s) => ({ ...s, slot: n, name: prefs?.slots?.[n - 1]?.name || `이름${n}` }));
  const slotTarget = save ? prefs?.slots?.[save.slot - 1] : null;

  return (
    <Modal title={`백업 내보내기 — 필요한 항목만 고르기 · ${vcName}`} onClose={onClose} width={1120}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }} data-vmlist-export="">
        {/* 대상 · 형식 */}
        <div className="flex gap wrap" style={{ alignItems: 'center', rowGap: 6 }}>
          <span className="muted">대상</span>
          <label className="flex gap" style={{ alignItems: 'center', gap: 6 }}><input type="radio" name="vle-target" checked={st.target === 'screen'} onChange={() => set({ target: 'screen' })} />{screenText} <b>{(screenReq?.count || 0).toLocaleString()}대</b></label>
          <label className="flex gap" style={{ alignItems: 'center', gap: 6 }}><input type="radio" name="vle-target" checked={st.target === 'folder'} onChange={() => set({ target: 'folder' })} />폴더 고르기</label>
          {st.target === 'folder' && (
            <Select sort={false} className="input" aria-label="폴더" value={st.folder} onChange={(e) => set({ folder: e.target.value })} style={{ maxWidth: 360, minWidth: 0 }}>
              <option value="">폴더를 고르세요</option>
              {folders.map((f) => <option key={f.path} value={f.path}>{`${'\u00a0\u00a0'.repeat(f.depth - 1)}${f.path} (하위 포함 ${f.count}대)`}</option>)}
            </Select>
          )}
          <span className="flex gap" style={{ marginLeft: 'auto', alignItems: 'center', gap: 10 }}>
            <span className="muted">형식</span>
            <label className="flex gap" style={{ alignItems: 'center', gap: 6 }}><input type="radio" name="vle-fmt" checked={st.fmt === 'csv'} onChange={() => set({ fmt: 'csv' })} />CSV</label>
            <label className="flex gap" style={{ alignItems: 'center', gap: 6 }}><input type="radio" name="vle-fmt" checked={st.fmt === 'xlsx'} onChange={() => set({ fmt: 'xlsx' })} />엑셀(요약 · 폴더 트리 · 데이터)</label>
          </span>
        </div>

        {/* 빠른 조합 */}
        <div className="flex gap wrap" style={{ alignItems: 'center', rowGap: 6 }}>
          <span className="muted">빠른 조합</span>
          {cat.presets.map((p) => <button key={p.id} type="button" className="tab" style={chipBtn(presetOn(p))} onClick={() => set({ cols: [...p.keys] })}>{p.name}</button>)}
        </div>

        {/* 내 저장값 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 12px', border: '1px solid var(--border-soft)', borderRadius: 10, background: 'var(--panel-deep)' }}>
          <div className="flex gap wrap" style={{ alignItems: 'center', rowGap: 6 }}>
            <span className="muted">내 저장값</span>
            {Array.from({ length: SLOT_COUNT }, (_, i) => {
              const s = prefs?.slots?.[i]; const l = slotLabel(s, i); const isDef = prefs?.def?.from === i + 1;
              return (
                <button key={i} type="button" className="tab" disabled={l.empty} onClick={() => { setSt((x) => applyValue(x, s)); setMsg({ ok: true, text: `${i + 1}번 ‘${l.name}’ 을 불러왔습니다(${l.cols}개 항목${s?.droppedCols ? ` · 없어진 항목 ${s.droppedCols}개 뺌` : ''}).` }); }}
                  title={l.empty ? '비어 있음 — 지금 설정 저장하기로 채웁니다' : `${l.cols}개 항목 · 눌러서 불러오기`}
                  style={{ flex: 'none', fontSize: 12.5, borderStyle: l.empty ? 'dashed' : 'solid', opacity: l.empty ? 0.7 : 1 }}>
                  <span className="muted" style={{ marginRight: 6 }}>{l.no}</span>{l.name}{isDef && <span style={{ marginLeft: 6, fontSize: 11, color: TONE.ok }}>기본</span>}
                </button>
              );
            })}
            <span className="flex gap wrap" style={{ marginLeft: 'auto', alignItems: 'center', rowGap: 6 }}>
              <button type="button" className="tab" style={{ flex: 'none', color: TONE.ok }} disabled={!st.cols.length || busy === 'save' || prefs?.unreadable}
                onClick={() => putPref('default', valueToSave(st, { fmt: true, tagCols: true, target: true }, '기본값'))}>지금 설정을 기본값으로</button>
              <button type="button" className={save ? 'login-btn' : 'tab'} style={{ flex: 'none' }} disabled={!st.cols.length || prefs?.unreadable} onClick={() => (save ? setSave(null) : openSave())}>지금 설정 저장하기…</button>
            </span>
          </div>
          <div className="muted" style={{ fontSize: 12 }}>{prefs?.unreadable ? '저장값 파일을 읽지 못해 저장할 수 없습니다(손상 사본은 설정 폴더에 남았습니다).' : defaultLine(prefs)}</div>
          {save && (
            <div className="flex gap wrap" style={{ alignItems: 'flex-end', gap: '12px 24px', paddingTop: 8, borderTop: '1px solid var(--border-soft)' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <b style={{ fontSize: 12.5 }}>어느 칸에</b>
                <div className="flex gap" style={{ gap: 6 }}>
                  {Array.from({ length: SLOT_COUNT }, (_, i) => (
                    <button key={i} type="button" aria-label={`${i + 1}번 칸`} className={save.slot === i + 1 ? 'login-btn' : 'tab'} style={{ flex: 'none', width: 38, padding: '6px 0' }} onClick={() => pickSlot(i + 1)}>{i + 1}</button>
                  ))}
                </div>
                <span className="muted" style={{ fontSize: 11.5 }}>{slotTarget ? `${save.slot}번 ‘${slotTarget.name}’ 을 덮어씁니다` : `${save.slot}번은 비어 있습니다`}</span>
              </div>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <b style={{ fontSize: 12.5 }}>이름</b>
                <input className="input" value={save.name} maxLength={NAME_MAX} onChange={(e) => setSave((s) => ({ ...s, name: e.target.value }))} style={{ width: 200, maxWidth: '100%' }} />
              </label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                <b style={{ fontSize: 12.5 }}>저장할 내용</b>
                <div className="flex gap wrap" style={{ gap: '4px 14px' }}>
                  {SAVE_WHAT.map(([k, label, fixed]) => (
                    <label key={k} className="flex gap" style={{ alignItems: 'center', gap: 6 }}>
                      <input type="checkbox" checked={fixed || !!save.what[k]} disabled={fixed} onChange={() => setSave((s) => ({ ...s, what: { ...s.what, [k]: !s.what[k] } }))} />{label}
                    </label>
                  ))}
                </div>
                <label className="flex gap" style={{ alignItems: 'center', gap: 6, color: TONE.ok }}>
                  <input type="checkbox" checked={save.alsoDefault} onChange={() => setSave((s) => ({ ...s, alsoDefault: !s.alsoDefault }))} />이 칸을 기본값으로도 쓰기(창을 열면 이것으로 시작)
                </label>
              </div>
              <span className="flex gap" style={{ marginLeft: 'auto', gap: 8 }}>
                <button type="button" className="tab" style={{ flex: 'none' }} onClick={() => setSave(null)}>취소</button>
                <button type="button" className="login-btn" style={{ flex: 'none' }} disabled={busy === 'save'}
                  onClick={async () => { if (await putPref(save.slot, valueToSave(st, save.what, save.name), save.alsoDefault)) setSave(null); }}>
                  {slotTarget ? `${save.slot}번에 덮어쓰기` : `${save.slot}번에 저장`}
                </button>
              </span>
            </div>
          )}
        </div>
        {msg && <div className={`banner ${msg.ok ? 'info' : 'warn'}`}>{msg.text}</div>}

        {/* 본문 — 왼쪽 항목 · 오른쪽 고른 항목·미리보기 */}
        <div className="flex wrap" style={{ gap: 14, alignItems: 'flex-start' }}>
          <div style={{ flex: '1 1 440px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="항목 찾기 — 예: Veeam, 스냅샷, 메모" aria-label="항목 찾기" />
            <div className="muted flex gap wrap" style={{ fontSize: 11, rowGap: 2 }}>
              <span><b style={{ color: TONE.ok }}>항상</b> 30초 인벤토리</span><span><b style={{ color: TONE.run }}>캐시</b> 주기 수집 — 늦게 채워짐</span>
              <span>못 모은 값은 파일에 ‘{cat.missingText}’</span>
            </div>
            {cat.groups.map((g) => {
              const items = g.items.filter((it) => !ql || it.label.toLowerCase().includes(ql) || g.name.toLowerCase().includes(ql));
              if (!items.length) return null;
              const keys = g.items.map((it) => it.key); const n = keys.filter((k) => st.cols.includes(k)).length;
              return (
                <div key={g.id} style={{ border: '1px solid var(--border-soft)', borderRadius: 10, background: 'var(--panel)', minWidth: 0 }}>
                  <div className="flex gap" style={{ alignItems: 'center', padding: '7px 12px', borderBottom: '1px solid var(--border-soft)' }}>
                    <b>{g.name}</b><span className="muted" style={{ fontSize: 12 }}>{n}/{keys.length}</span>
                    <button type="button" className="tab" style={{ marginLeft: 'auto', flex: 'none', fontSize: 12, padding: '3px 8px' }} onClick={() => set({ cols: addCols(st.cols, keys) })}>모두</button>
                    <button type="button" className="tab" style={{ flex: 'none', fontSize: 12, padding: '3px 8px' }} onClick={() => set({ cols: dropCols(st.cols, keys) })}>해제</button>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '0 10px', padding: '4px 10px 6px' }}>
                    {items.map((it) => {
                      const b = availBadge(it, cat.status); const on = st.cols.includes(it.key);
                      return (
                        <label key={it.key} className="flex gap" style={{ alignItems: 'center', gap: 8, padding: '5px 4px', borderRadius: 6, minWidth: 0, cursor: 'pointer', background: on ? 'rgba(59,130,246,.14)' : 'transparent' }}>
                          <input type="checkbox" checked={on} onChange={() => set({ cols: toggleCol(st.cols, it.key) })} />
                          <span style={{ flex: 1, minWidth: 0 }}>{it.label}</span>
                          {b.text && <span style={{ flex: 'none', fontSize: 10.5, color: TONE[b.tone], border: `1px solid ${BORDER[b.tone]}`, borderRadius: 99, padding: '0 7px', lineHeight: '18px' }}>{b.text}</span>}
                        </label>
                      );
                    })}
                  </div>
                  {g.note && <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.55, padding: '0 12px 8px' }}>{g.note}</div>}
                </div>
              );
            })}
          </div>

          <div style={{ flex: '1 1 360px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div><b>고른 항목 {st.cols.length}개</b> <span className="muted" style={{ fontSize: 12 }}>이 순서대로 열이 됩니다 · ‹ › 로 순서 · × 로 빼기</span></div>
            <div className="flex gap wrap" style={{ gap: 6 }}>
              {st.cols.map((k) => (
                <span key={k} className="flex gap" style={{ alignItems: 'center', gap: 2, padding: '2px 4px 2px 8px', border: '1px solid var(--border)', borderRadius: 99, background: 'var(--panel-deep)', fontSize: 12, minWidth: 0 }}>
                  <button type="button" aria-label="앞으로" className="tab" style={{ flex: 'none', padding: '0 4px', border: 0, background: 'transparent' }} onClick={() => set({ cols: moveCol(st.cols, k, -1) })}>‹</button>
                  <span style={{ overflowWrap: 'anywhere' }}>{itemOf.get(k)?.label || k}</span>
                  <button type="button" aria-label="뒤로" className="tab" style={{ flex: 'none', padding: '0 4px', border: 0, background: 'transparent' }} onClick={() => set({ cols: moveCol(st.cols, k, 1) })}>›</button>
                  <button type="button" aria-label="빼기" className="tab" style={{ flex: 'none', padding: '0 4px', border: 0, background: 'transparent' }} onClick={() => set({ cols: toggleCol(st.cols, k) })}>×</button>
                </span>
              ))}
              {!st.cols.length && <span className="muted">아직 고른 항목이 없습니다.</span>}
            </div>

            <div><b>미리보기</b> <span className="muted" style={{ fontSize: 12 }}>대상 첫 3대 · 내려받는 파일과 같은 값</span></div>
            {pv?.error ? <div className="banner warn">{pv.error}</div> : !pv ? <div className="muted" style={{ fontSize: 12 }}>{st.cols.length ? '미리보기를 만드는 중…' : '항목을 고르면 보입니다.'}</div> : (
              <div style={{ overflowX: 'auto', border: '1px solid var(--border-soft)', borderRadius: 10 }}>
                <STable minWidth={Math.max(360, pv.head.length * 120)} style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead><tr style={{ textAlign: 'left' }}>{pv.head.map((h, i) => <th key={i} style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>{h}</th>)}</tr></thead>
                  <tbody>{pv.cells.map((row, ri) => (
                    <tr key={ri} style={{ borderTop: '1px solid var(--border-soft)' }}>{row.map((c, ci) => (
                      <td key={ci} style={{ padding: '6px 8px', whiteSpace: 'nowrap', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', color: c === cat.missingText ? TONE.warn : undefined }} title={String(c ?? '')}>{String(c ?? '')}</td>
                    ))}</tr>
                  ))}</tbody>
                </STable>
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 12px', border: '1px solid var(--border-soft)', borderRadius: 10, background: 'var(--panel-deep)' }}>
              <b style={{ fontSize: 12.5 }}>여러 값이 있는 항목(태그 · 작업 · 스냅샷 이름)</b>
              <span className="muted" style={{ fontSize: 12 }}>한 칸에 ‘ | ’ 로 이어 씁니다 — VM 1대 = 1행</span>
              <label className="flex gap" style={{ alignItems: 'center', gap: 8 }}><input type="checkbox" checked={st.tagCols} onChange={() => set({ tagCols: !st.tagCols })} />vSphere 태그는 카테고리마다 따로 열(‘태그: 환경’ · ‘태그: 서비스’ …)</label>
            </div>
            <div className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
              못 읽은 값은 빈칸입니다(0·‘없음’ 으로 쓰지 않습니다). 그 vCenter 에서 아직 모으지 않은 값(태그 수집 전)은 ‘{cat.missingText}’ 입니다.
              디스크·파티션·구성 같은 VM 전체 정보는 vCenter 화면의 ‘⤓ VM 전체 정보 내보내기…’ 에 있습니다.
            </div>
          </div>
        </div>

        {/* 아래 */}
        <div className="flex gap wrap" style={{ alignItems: 'center', rowGap: 8, paddingTop: 10, borderTop: '1px solid var(--border-soft)' }}>
          <span className="muted">
            {tooMany ? `이 폴더는 ${target.count.toLocaleString()}대라 한 번에 내보낼 수 있는 ${VM_LIST_MAX_IDS.toLocaleString()}대를 넘습니다 — 하위 폴더를 고르세요.`
              : target?.error ? target.error
                : st.target === 'folder' && !st.folder ? '폴더를 고르세요.'
                  : `${st.cols.length}개 항목 · ${(target?.count || 0).toLocaleString()}대`}
          </span>
          <span className="flex gap wrap" style={{ marginLeft: 'auto', gap: 8, rowGap: 6 }}>
            {onLegacyCsv && <button type="button" className="tab" style={{ flex: 'none' }} disabled={!!busy} onClick={onLegacyCsv}
              title="v2.779 의 백업 현황 CSV — 화면 열 그대로(고른 항목·저장값과 무관 · 검색어 미반영)">예전 CSV(화면 열 그대로)</button>}
            <button type="button" className="tab" style={{ flex: 'none' }} onClick={onClose}>닫기</button>
            <button type="button" className="login-btn" style={{ flex: 'none' }} disabled={!canDownload} onClick={download}>
              {busy === 'down' ? '만드는 중…' : `⤓ ${st.fmt === 'xlsx' ? '엑셀' : 'CSV'} 내려받기`}
            </button>
          </span>
        </div>
      </div>
    </Modal>
  );
}
