/**
 * FleetHwExportModal — 통합 서버 인벤토리 '서버 하드웨어 정보 내보내기' 창(v2.966 — 승인 시안 docs/design/baremetal-hw-xlsx ② ·
 *   사용자 요청 2026-11-11 "물리서버의 hostname/CPU/memory/disk 등 하드웨어 정보를 excel 로 export" + 값 선택 · CSV/엑셀 · 법인 표시 ·
 *   물리/가상화/둘 다 · iDRAC 수집 정보 전부 · 서버 1대 = 시트 1장. 기본안 7가지 그대로 승인).
 *
 *  · 카탈로그(값 이름 · 관리자 전용 여부) · 법인별 대수 · 기본 묶음 · 저장값은 서버 /insights/fleet/hardware-meta 가 준다(화면에서 지어내지 않는다).
 *  · 기본: 형식 엑셀 · 대상 = 창을 연 탭 · 법인 모두 · 띠로 묶기 · ‘기본’ 묶음 · 사양서 끔. 저장값(계정마다)이 있으면 형식 · 법인 표시 · 값 · 사양서는 그것으로.
 *  · 내려받기에 성공하면 그 조합을 계정 저장값으로 남긴다(PUT /insights/fleet/hardware-prefs — 실패는 창에 적는다).
 *  · 실패(409 동시 내보내기 · 403 · 400)는 파일로 저장하지 않고 창 안에 말한다(downloadFailText).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useLatest } from '../../hooks/useLatest.js';
import { fetchJson, downloadFile, putJson, canCsv } from '../../api.js';
import { downloadFailText } from '../downloadFailText.js';
import { Modal, ErrorBox, Loading } from '../../components/ui.jsx';
import { FORMATS, KINDS, BANDS, PRESETS, presetKeys, corpCount, selectionSummary, hwExportQuery, summaryLine, stateFromPrefs } from './fleetHwExportText.js';

export function FleetHwExportModal({ initialKind = 'bm', screenCorp = '', onClose }) {
  const run = useLatest();
  const [meta, setMeta] = useState(null);
  const [metaErr, setMetaErr] = useState(null);
  const [format, setFormat] = useState('xlsx');
  const [kind, setKind] = useState(initialKind === 'vh' ? 'vh' : 'bm');
  const [band, setBand] = useState('band');
  const [spec, setSpec] = useState(false);
  const [corpSel, setCorpSel] = useState(null);   // null = 모든 법인
  const [sel, setSel] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const allowed = canCsv();
  useEffect(() => {
    if (!allowed) return;
    run(fetchJson('/insights/fleet/hardware-meta'), (m) => {
      setMeta(m);
      const st = stateFromPrefs(m?.prefs, m?.catalog, m?.basicKeys);
      setFormat(st.format); setBand(st.band); setSpec(st.spec); setSel(st.sel);
    }, setMetaErr);
  }, [run, allowed]);
  const catalog = useMemo(() => meta?.catalog || [], [meta]);
  const corps = useMemo(() => meta?.corps || [], [meta]);
  const s = useMemo(() => selectionSummary({ catalog, sel, format, band, spec, corps, kind, corpSel }), [catalog, sel, format, band, spec, corps, kind, corpSel]);
  const noneSel = corpSel != null && corpSel.size === 0;
  const isOn = (id) => corpSel == null || corpSel.has(id);
  const toggleCorp = (id) => setCorpSel((prev) => {
    const n = new Set(prev == null ? corps.map((c) => c.id) : prev);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const fromScreen = () => setCorpSel(screenCorp ? new Set([screenCorp]) : null);
  const toggleKey = (k, locked) => { if (locked) return; setSel((prev) => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; }); };
  const setGroup = (g, on) => setSel((prev) => {
    const n = new Set(prev);
    for (const f of [...(g.sum || []), ...(g.det || [])]) { if (f.locked) continue; if (on) n.add(f.key); else n.delete(f.key); }
    return n;
  });
  const download = async () => {
    setMsg(''); setBusy(true);
    try {
      await downloadFile(`/insights/fleet/hardware-export${hwExportQuery({ format, kind, band, spec, corpSel, sel, catalog })}`);
      const order = catalog.flatMap((g) => [...(g.sum || []), ...(g.det || [])].map((f) => f.key)).filter((k) => sel.has(k));
      const r = await putJson('/insights/fleet/hardware-prefs', { value: { cols: order, fmt: format, band, spec } }).catch((e) => ({ ok: false, reason: e.message }));
      if (r && r.ok === false) { setMsg(`파일은 내려받았습니다. 다만 고른 조합을 기억하지 못했습니다(${r.reason || '저장 실패'}).`); return; }
      onClose?.();
    } catch (e) { setMsg(downloadFailText(e)); }
    finally { setBusy(false); }
  };
  if (!allowed) return null;   // 훅 아래 — 조기 return 이 훅 개수를 바꾸지 않게
  const xl = format === 'xlsx';
  return (
    <Modal title="서버 하드웨어 정보 내보내기" onClose={onClose} width={1120}>
      {metaErr ? <ErrorBox error={metaErr} /> : !meta ? <Loading /> : (
        <div className="hwx">
          <div className="hwx-grid">
            <div className="hwx-col">
              <section className="card gpu-alloc-export-sec">
                <div className="muted lbl">① 파일 형식</div>
                <div className="hwx-two" role="group" aria-label="파일 형식">
                  {FORMATS.map((f) => <button key={f.key} type="button" className={`qn-btn hwx-big${format === f.key ? ' on' : ''}`} aria-pressed={format === f.key} onClick={() => setFormat(f.key)}>{f.label}</button>)}
                </div>
                <div className="muted hwx-note">{FORMATS.find((f) => f.key === format)?.sub}</div>
              </section>

              <section className="card gpu-alloc-export-sec">
                <div className="muted lbl">② 대상 서버</div>
                <div className="hwx-stack" role="group" aria-label="대상 서버">
                  {KINDS.map((k) => {
                    const n = corps.reduce((a, c) => a + corpCount(c, k.key), 0);
                    return (
                      <button key={k.key} type="button" className={`qn-btn hwx-row${kind === k.key ? ' on' : ''}`} aria-pressed={kind === k.key} onClick={() => setKind(k.key)}>
                        <span>{k.label}</span><span className="hwx-cnt">{n}대</span>
                      </button>
                    );
                  })}
                </div>
                <div className="muted hwx-note">{kind === 'bm' ? '통합 서버 인벤토리의 베어메탈과 같은 집합입니다.' : '가상화 서버는 iDRAC 받침이 있는 호스트만 부품 값이 채워집니다. 없으면 vCenter 의 모델 · 코어 · 메모리만 넣고 비고에 적습니다.'}</div>
              </section>

              <section className="card gpu-alloc-export-sec" data-hwx-corps="">
                <div className="flex gap wrap" style={{ alignItems: 'center' }}>
                  <span className="muted lbl">③ 법인(vCenter)</span>
                  <span className="flex gap wrap" style={{ marginLeft: 'auto', gap: 6 }}>
                    <button type="button" className="qn-btn" onClick={() => setCorpSel(null)}>모두</button>
                    <button type="button" className="qn-btn" onClick={() => setCorpSel(new Set())}>모두 해제</button>
                    <button type="button" className="qn-btn" onClick={fromScreen} title={screenCorp ? '화면의 법인 필터를 가져옵니다.' : '화면에서 고른 법인이 없어 모든 법인으로 둡니다.'}>화면 필터대로</button>
                  </span>
                </div>
                <div className="hwx-stack" role="group" aria-label="넣을 법인">
                  {corps.map((c) => {
                    const on = isOn(c.id);
                    return (
                      <button key={c.id} type="button" className={`qn-btn hwx-row hwx-mono${on ? ' on' : ''}`} aria-pressed={on} onClick={() => toggleCorp(c.id)}>
                        <span className="hwx-ellipsis">{c.name}</span><span className="hwx-cnt">{corpCount(c, kind)}대</span>
                      </button>
                    );
                  })}
                </div>
                <div className="muted hwx-note">{noneSel ? '' : `${corpSel == null ? '모든 법인' : `법인 ${s.picked}곳`} · 서버 ${s.servers}대`}</div>
                {noneSel && <div className="gpu-alloc-export-warn">법인을 하나 이상 고르세요.</div>}
              </section>

              <section className="card gpu-alloc-export-sec">
                <div className="muted lbl">④ 법인 표시</div>
                <div className="hwx-stack" role="group" aria-label="법인 표시">
                  {BANDS.map((b) => <button key={b.key} type="button" className={`qn-btn hwx-row${band === b.key ? ' on' : ''}`} aria-pressed={band === b.key} onClick={() => setBand(b.key)}><span>{b.label}</span></button>)}
                </div>
                <div className="muted hwx-note">{BANDS.find((b) => b.key === band)?.sub}{!xl && band === 'band' ? ' CSV 에는 띠를 넣지 않습니다(표가 깨집니다) — 법인 순으로 정렬만 합니다.' : ''}</div>
              </section>

              <section className="card gpu-alloc-export-sec">
                <div className="muted lbl">⑥ 서버별 사양서</div>
                <label className="gpu-alloc-export-chk">
                  <input type="checkbox" checked={xl && spec} disabled={!xl} onChange={() => setSpec((v) => !v)} />
                  <span><b>서버 한 대 = 시트 한 장</b> <span className="muted">— 그 서버의 수집된 사양 전부(식별 · CPU · 메모리 · 디스크 · 컨트롤러 · NIC 포트 · 펌웨어 · 전원 · PCIe · BIOS · iDRAC · 상태) + 목차</span></span>
                </label>
                <div className="muted hwx-note">{!xl ? 'CSV 로는 사양서를 만들 수 없습니다 — 엑셀을 고르세요.' : spec ? `사양서 ${s.servers}장 + 목차. 파일 하나에 ${meta.specMax}장까지 — 넘으면 법인마다 파일을 나눠 ZIP 으로 묶습니다.` : '끄면 사양서 시트를 만들지 않습니다.'}</div>
              </section>
            </div>

            <section className="card gpu-alloc-export-sec hwx-fields" data-hwx-fields="">
              <div className="flex gap wrap" style={{ alignItems: 'center' }}>
                <span className="muted lbl">⑤ 내보낼 값</span>
                <span className="hwx-note">요약 열 {s.cols}개 · 상세 {s.detGroups}종</span>
                <span className="flex gap wrap" style={{ marginLeft: 'auto', gap: 6 }}>
                  {PRESETS.map((p) => <button key={p.key} type="button" className="qn-btn" onClick={() => setSel(presetKeys(p.key, catalog, meta.basicKeys))}>{p.label}</button>)}
                </span>
              </div>
              <div className="muted hwx-note"><b>요약 열</b>은 ‘서버 요약’(서버 한 대 = 한 줄)의 열이 되고, <b>상세</b>는 부품 한 개 = 한 줄인 별도 {xl ? '시트' : '파일'}가 됩니다. 잠긴 값은 항상 들어갑니다.</div>
              {catalog.map((g) => {
                const detOn = (g.det || []).some((f) => sel.has(f.key));
                return (
                  <div key={g.key} className="hwx-group">
                    <div className="flex gap wrap" style={{ alignItems: 'center' }}>
                      <b>{g.name}</b>{g.hint && <span className="muted hwx-note">{g.hint}</span>}
                      <span className="flex gap" style={{ marginLeft: 'auto', gap: 6 }}>
                        <button type="button" className="qn-btn hwx-sm" onClick={() => setGroup(g, true)} aria-label={`${g.name} 전부 넣기`}>전부</button>
                        <button type="button" className="qn-btn hwx-sm" onClick={() => setGroup(g, false)} aria-label={`${g.name} 빼기`}>빼기</button>
                      </span>
                    </div>
                    {(g.sum || []).length > 0 && (
                      <div className="hwx-chips"><span className="muted hwx-part">요약 열</span>
                        {g.sum.map((f) => <button key={f.key} type="button" className={`qn-btn hwx-chip${sel.has(f.key) ? ' on' : ''}${f.locked ? ' locked' : ''}`} aria-pressed={sel.has(f.key)} disabled={f.locked} onClick={() => toggleKey(f.key, f.locked)} title={f.locked ? '항상 들어갑니다' : undefined}>{f.label}</button>)}
                      </div>
                    )}
                    {(g.det || []).length > 0 && (
                      <div className="hwx-chips"><span className="muted hwx-part">상세</span>
                        {g.det.map((f) => <button key={f.key} type="button" className={`qn-btn hwx-chip${sel.has(f.key) ? ' on' : ''}`} aria-pressed={sel.has(f.key)} onClick={() => toggleKey(f.key, false)}>{f.label}</button>)}
                        {detOn && <span className="muted hwx-note">→ ‘{g.sheet || g.name}’ {xl ? '시트' : '파일'} 1{xl ? '장' : '개'}</span>}
                      </div>
                    )}
                  </div>
                );
              })}
              <div className="muted hwx-note"><b>고를 수 없는 것</b> — 시리얼 번호 · iDRAC 사용자 계정 · 이벤트 로그 · 접속 계정.{meta.admin ? '' : ' iDRAC 주소 · MAC · UUID 는 관리자 계정에만 보입니다.'}</div>
            </section>
          </div>

          <div className="muted hwx-note">값의 출처는 iDRAC(Redfish) 인벤토리 저장값입니다 — 내려받을 때 장비에 다시 접속하지 않습니다. 디스크는 물리 디스크 기준이고, 읽지 못한 값은 빈 칸으로 둡니다. 엣지 서버는 축약 인벤토리라 일부 값이 비어 있습니다.</div>
          {msg && <div className="error-box">{msg}</div>}
          <div className="flex gap wrap" style={{ alignItems: 'center' }}>
            <span style={{ flex: '1 1 260px', minWidth: 0, fontSize: 13 }} data-hwx-summary="">{summaryLine(s, format)}</span>
            <button type="button" className="logout-btn" style={{ flex: 'none', padding: '8px 14px' }} onClick={onClose}>닫기</button>
            <button type="button" className="login-btn" style={{ flex: 'none', padding: '8px 18px' }} disabled={busy || noneSel || !s.servers} onClick={download}>
              {busy ? '만드는 중…' : xl ? '엑셀 내려받기' : s.ext === 'zip' ? 'CSV(ZIP) 내려받기' : 'CSV 내려받기'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

export default FleetHwExportModal;
