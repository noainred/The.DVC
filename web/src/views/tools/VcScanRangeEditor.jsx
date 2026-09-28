/**
 * VcScanRangeEditor.jsx — vCenter별 스캔 대역 편집기 **한 벌**(v2.639, 리드 결정 U1).
 *
 * 예전에는 같은 편집기가 두 곳에 있었다 — IPMS 설정 ②(초안·문법 검사·서버 400 표시·조회 실패 잠금까지 갖춤)와
 * 대역·스캔 페이지(IpamRanges — 원시 textarea 뿐, 검사·초안·400 표시가 전부 없었다 · D4). 이제 둘 다 이 컴포넌트를 쓴다.
 *  · 폼 값은 편집 초안(`useIpamDraft`) — 키는 페이지별 `<draftPrefix>:<vCenter id>`(`ipms:vcscan:*` / `ranges:vc:*`).
 *    ipamDraft.pageOfKey 가 키의 첫 조각을 서브메뉴 키로 읽어 ● 를 찍으므로 접두는 **서브메뉴 키**여야 한다.
 *  · 저장된 대역(/tools/ipam/vc-ranges)은 부모가 읽어 넘긴다(대역·스캔 페이지는 같은 응답으로 목록 표도 그린다).
 *    못 읽었으면 `vcRangesGate` 가 저장·스캔을 잠근다(빈 칸은 '대역 없음' 이 아니다 — v2.621 WEB-02).
 *  · 문법은 `checkRangeList`(서버와 같은 판정) — 오류 줄이 있으면 저장을 잠그고 줄을 가리킨다. 쉼표는 줄바꿈으로
 *    정규화한다(`normalizeRangeText` — D8: 서버는 쉼표도 받는데 웹 판정은 줄 단위였다).
 *  · 서버 400(`invalid[]`)은 사유 + 줄 목록으로 보인다(D4). 지금 스캔은 실행 중이면 잠근다(부모의 상태 폴링을 prop 으로 받는다).
 *  · 관리자 아님(access 'no')이면 저장·스캔을 잠그고 사유를 말한다(I3 — 서버가 adminOnly 로 집행한다).
 *  · 저장 중 vCenter 를 바꾸면 늦게 온 응답으로 새 vCenter 의 초안을 '저장됨' 으로 만들지 않는다(세대 ref).
 */
import React, { useEffect, useRef, useState } from 'react';
import { postJson, putJson } from '../../api.js';
import { useIpamDraft } from './useIpamDraft.js';
import { DraftBanner } from './IpamDraftBanner.jsx';
import { adminWriteGate } from './ipamShared.jsx';
import { checkRangeList, cleanLines, lineIssueText, listSummaryText, normalizeRangeText } from './ipmsRangeText.js';

export const RANGE_TA = { resize: 'vertical', fontFamily: 'monospace', fontSize: 12, width: '100%' };
export const SCAN_CAP = 4096; // 서버 ipam/scan.js RANGE_CAP — 한 줄이 이보다 크면 스캔은 앞부분만 돈다(경고용)

/**
 * v2.621(감사 WEB-02): vCenter별 스캔 대역 편집 잠금 판정(순수). 저장된 대역을 **읽지 못했으면**(미로드·실패) 빈 칸은
 * '대역 없음' 이 아니다 — 그 상태의 저장은 기존 목록을 입력값으로 통째로 교체하므로 '대역 저장'·'지금 스캔' 을 잠근다.
 * 한 번 읽은 뒤의 재조회 실패는 폼이 이미 서버 값으로 채워져 있으므로 잠그지 않고 사유만 보인다(v2.478 B15 와 같은 판단).
 * @returns {{ locked: boolean, failed: boolean, note: string|null }}
 */
export function vcRangesGate(vcRanges, err) {
  const loaded = !!vcRanges && typeof vcRanges === 'object';
  if (!loaded && err) return { locked: true, failed: true, note: `저장된 스캔 대역을 불러오지 못했습니다(${err}) — 빈 칸은 ‘대역 없음’ 이 아니므로 저장·스캔을 잠갔습니다.` };
  if (!loaded) return { locked: true, failed: false, note: '저장된 스캔 대역을 불러오는 중입니다 — 불러온 뒤 저장할 수 있습니다.' };
  if (err) return { locked: false, failed: true, note: `스캔 대역을 다시 불러오지 못했습니다(${err}) — 아래는 마지막으로 불러온 값입니다.` };
  return { locked: false, failed: false, note: null };
}

/** v2.637: 대역 입력 칸 바로 아래 판정 — 오류(저장 막음)·경고(저장은 됨)·요약을 입력하는 동안 보인다. */
export function RangeCheck({ check, max = 4 }) {
  if (!check) return null;
  const { invalid, warnings } = check;
  return (
    <div style={{ fontSize: 11, marginTop: 4, lineHeight: 1.6 }}>
      <span className="muted">{listSummaryText(check)}</span>
      {invalid.length > 0 && (
        <div style={{ color: 'var(--red)' }}>
          {invalid.slice(0, max).map((x) => <div key={`e${x.line}`}>✕ {lineIssueText(x)}</div>)}
          {invalid.length > max && <div>외 {invalid.length - max}줄</div>}
        </div>
      )}
      {warnings.length > 0 && (
        <div style={{ color: 'var(--amber)' }}>
          {warnings.slice(0, max).map((x, i) => <div key={`w${x.line}-${i}`}>△ {lineIssueText(x)}</div>)}
          {warnings.length > max && <div>외 {warnings.length - max}건</div>}
        </div>
      )}
    </div>
  );
}

/** 결과 문구 한 줄 + 줄 목록(서버 400 의 invalid). IpmsSettings 의 Msg 와 같은 모양이라 그쪽도 이것을 쓴다. */
export function RangeMsg({ m }) {
  if (!m) return null;
  return (
    <div className={`banner ${m.ok ? 'ok' : 'warn'}`} role="status" style={{ marginBottom: 8, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
      {m.text}
      {m.list?.length > 0 && <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12 }}>{m.list.slice(0, 20).map((t, i) => <li key={i}>{t}</li>)}{m.list.length > 20 && <li>외 {m.list.length - 20}건</li>}</ul>}
    </div>
  );
}

/**
 * @param {object} p
 * @param {string} p.vc                선택한 vCenter id('' = 미선택)
 * @param {(id:string)=>void} [p.onVc]  선택 변경(showSelect 일 때)
 * @param {Array<{id:string,name?:string,orphan?:boolean}>|null} p.options  고를 수 있는 vCenter(null = 아직 모름)
 * @param {(o:object)=>string} [p.optionLabel]  선택지 글자(기본 name)
 * @param {boolean} [p.showSelect]     선택기를 이 편집기 안에 그릴지(IPMS 는 ① 의 선택기와 연동하므로 false)
 * @param {object|null} p.vcRanges     GET /tools/ipam/vc-ranges 응답(부모가 읽는다) · vcRangesErr 실패 사유 · onReloadRanges 다시 읽기
 * @param {string} p.draftPrefix       초안 키 접두 = 서브메뉴 키('ipms:vcscan' | 'ranges:vc')
 * @param {boolean} [p.scanRunning]    진행 중 스캔이 있으면 '지금 스캔' 잠금
 * @param {string} [p.access]          'yes'|'no'|'unknown' — 'no' 면 쓰기 잠금(I3)
 * @param {()=>void} [p.onSaved]       저장 성공 뒤(부모가 목록을 다시 읽는다)
 * @param {()=>void} [p.onScanStarted] 스캔 시작 뒤(부모가 상태를 다시 읽는다)
 */
export function VcScanRangeEditor({
  vc, onVc, options, optionLabel, showSelect = false, optionsNote = null,
  vcRanges, vcRangesErr, onReloadRanges, draftPrefix, scanRunning = false, access = 'unknown',
  onSaved, onScanStarted, title = 'vCenter별 스캔 대역 (주기 스캔)', note = null, rows = 6,
}) {
  // vCenter 마다 따로 초안 — vCenter 를 바꿔도 다른 vCenter 에 입력하던 대역이 남는다(v2.636).
  const sd = useIpamDraft(`${draftPrefix}:${vc || '-'}`);
  const scanText = sd.value?.text ?? '';
  const scanEnabled = sd.value ? sd.value.enabled !== false : true;
  const setScanText = (t) => sd.set((c) => ({ ...(c || { enabled: true }), text: normalizeRangeText(t) }));
  const setScanEnabled = (v) => sd.set((c) => ({ ...(c || { text: '' }), enabled: v }));
  const [scanBusy, setScanBusy] = useState(false);
  const [scanMsg, setScanMsg] = useState(null);
  const vcRef = useRef(vc); vcRef.current = vc; // 늦게 온 저장 응답이 다른 vCenter 의 초안을 '저장됨' 으로 만들지 않게
  // 선택한 vCenter 의 저장된 스캔 대역을 폼에 채운다(초안이 있으면 초안이 이긴다 — useIpamDraft.load).
  useEffect(() => {
    if (!vcRanges || !vc) return;
    const e = (vcRanges.ranges || []).find((x) => x.vcenterId === vc);
    sd.load({ text: e ? (e.ranges || []).join('\n') : '', enabled: e ? e.enabled !== false : true });
  }, [vc, vcRanges]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setScanMsg(null); }, [vc]); // 다른 vCenter 의 결과 문구를 새 vCenter 것처럼 두지 않는다

  const cur = (options || []).find((o) => o.id === vc) || null;
  const vcRangeEntry = (vcRanges?.ranges || []).find((x) => x.vcenterId === vc);
  const scanGate = vcRangesGate(vcRanges, vcRangesErr);
  const write = adminWriteGate(access);
  const scanCheck = checkRangeList(scanText, { reversed: 'error', scanCap: SCAN_CAP });
  const scanDirty = !!sd.dirty && JSON.stringify(cleanLines(sd.value?.text)) + scanEnabled !== JSON.stringify(cleanLines(sd.base?.text)) + (sd.base ? sd.base.enabled !== false : true);
  const inputLocked = scanGate.locked || !vc || !!cur?.orphan || write.locked;
  const labelOf = optionLabel || ((o) => o.name || o.id);

  const saveScanRanges = async () => {
    if (!vc || scanGate.locked || write.locked || scanCheck.invalid.length) return; // 버튼 잠금의 이중 방어(v2.621 WEB-02)
    const vcAtSave = vc;
    setScanBusy(true); setScanMsg(null);
    try {
      const r = await putJson('/admin/ipam/vc-ranges', { vcenterId: vcAtSave, ranges: normalizeRangeText(scanText), enabled: scanEnabled });
      if (r.ok) {
        const warn = (r.warnings || []).length ? ` · 경고 ${r.warnings.length}건(저장은 됨)` : '';
        if (vcRef.current === vcAtSave) {
          setScanMsg({ ok: true, text: `저장됨 — 대역 ${(r.ranges || []).length}개${warn}`, list: (r.warnings || []).map(lineIssueText) });
          sd.saved({ text: (r.ranges || []).join('\n'), enabled: r.enabled !== false });
        }
        onSaved?.();
      } else if (vcRef.current === vcAtSave) {
        // 400 은 putJson 이 던지지 않고 본문을 돌려준다 — 사유(reason)와 줄 목록(invalid)을 보인다.
        setScanMsg({ ok: false, text: r.reason || '저장하지 못했습니다', list: (r.invalid || []).map(lineIssueText) });
      }
    } catch (e) { if (vcRef.current === vcAtSave) setScanMsg({ ok: false, text: e?.message || String(e) }); } finally { setScanBusy(false); }
  };
  const scanNow = async () => {
    if (scanGate.locked || write.locked || scanRunning) return;
    setScanBusy(true); setScanMsg(null);
    try {
      const r = await postJson('/admin/ipam/vc-ranges/scan', {});
      setScanMsg(r.ok ? { ok: true, text: '스캔을 시작했습니다(백그라운드) — 진행은 ‘스캔 상태’ 페이지에서 봅니다.' } : { ok: false, text: r.reason || '스캔을 시작하지 못했습니다' });
      onScanStarted?.();
    } catch (e) { setScanMsg({ ok: false, text: e?.message || String(e) }); } finally { setScanBusy(false); }
  };

  const saveTitle = write.locked ? write.title : scanGate.locked ? scanGate.note : scanCheck.invalid.length ? `형식 오류 ${scanCheck.invalid.length}줄을 먼저 고치세요` : undefined;
  const scanTitle = write.locked ? write.title : scanGate.locked ? scanGate.note : scanRunning ? '스캔이 진행 중입니다 — 끝난 뒤 다시 시작할 수 있습니다' : scanDirty ? '저장하지 않은 대역 변경은 이번 스캔에 들어가지 않습니다' : undefined;
  return (
    <>
      <div className="flex between wrap" style={{ alignItems: 'center', gap: 6 }}>
        <b style={{ fontSize: 13 }}>{title}</b>
        <span className="muted" style={{ fontSize: 11 }}>대상: <b>{cur?.name || vc || '—'}</b>{vcRangeEntry ? ` · 저장된 약 ${(vcRangeEntry.ipCount || 0).toLocaleString()} IP` : ''}</span>
      </div>
      {note && <div className="muted" style={{ fontSize: 11, margin: '2px 0 8px' }}>{note}</div>}
      {write.note && <div className="banner warn" role="status" style={{ marginBottom: 6, whiteSpace: 'normal' }}>{write.note}</div>}
      {scanGate.note && (
        <div className="flex gap" style={{ marginBottom: 6, alignItems: 'center', flexWrap: 'wrap', padding: '7px 10px', borderRadius: 8, fontSize: 12, background: scanGate.failed ? 'rgba(239,68,68,.12)' : 'rgba(148,163,184,.12)', color: scanGate.failed ? '#f87171' : undefined }}>
          <span style={{ overflowWrap: 'anywhere' }}>{scanGate.note}</span>
          {scanGate.failed && onReloadRanges && <button className="logout-btn" style={{ padding: '3px 10px', fontSize: 12 }} onClick={onReloadRanges}>다시 불러오기</button>}
        </div>
      )}
      {showSelect && (
        <div className="flex gap wrap" style={{ alignItems: 'center', margin: '6px 0 8px' }}>
          <span style={{ fontSize: 12 }}>vCenter</span>
          <select className="select" value={vc} onChange={(e) => onVc?.(e.target.value)} style={{ maxWidth: '100%', minWidth: 0 }} aria-label="vCenter 선택">
            <option value="">(선택)</option>
            {(options || []).map((o) => <option key={o.id} value={o.id}>{labelOf(o)}</option>)}
          </select>
          {options == null && !vcRangesErr && <span className="muted" style={{ fontSize: 11 }}>목록을 불러오는 중…</span>}
          {options == null && vcRangesErr && <span className="muted" style={{ fontSize: 11 }}>vCenter 목록을 읽지 못했습니다(위 사유)</span>}
          {optionsNote}
        </div>
      )}
      <DraftBanner d={sd} />
      <textarea className="input" rows={rows} value={scanText} disabled={inputLocked} onChange={(e) => setScanText(e.target.value)} placeholder={'10.94.42.0/24\n10.94.43.1-10.94.43.200'} style={RANGE_TA} aria-label="vCenter별 스캔 대역" />
      <RangeCheck check={scanCheck} />
      {cur?.orphan && <div style={{ fontSize: 11, marginTop: 4, color: 'var(--amber)' }}>이 vCenter 는 등록 목록에 없습니다(삭제됨) — 스캔 대역을 저장할 수 없습니다.</div>}
      <div className="flex gap" style={{ marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <label className="muted flex gap" style={{ alignItems: 'center', fontSize: 12 }}><input type="checkbox" checked={scanEnabled} disabled={inputLocked} onChange={(e) => setScanEnabled(e.target.checked)} /> 주기 스캔 포함</label>
        <button className="login-btn" style={{ flex: 'none', padding: '7px 14px' }} disabled={scanBusy || !vc || !!cur?.orphan || scanGate.locked || write.locked || scanCheck.invalid.length > 0}
          title={saveTitle} onClick={saveScanRanges}>대역 저장{scanDirty ? ' ●' : ''}</button>
        <button className="logout-btn" style={{ padding: '7px 12px' }} disabled={scanBusy || scanGate.locked || write.locked || scanRunning} title={scanTitle} onClick={scanNow}>🛰️ 지금 스캔(전체)</button>
      </div>
      {scanDirty && <div style={{ fontSize: 11, marginTop: 6, color: 'var(--amber)' }}>저장하지 않은 변경이 있습니다 — ‘지금 스캔’ 은 <b>저장된</b> 대역으로 돕니다.</div>}
      <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>형식: CIDR(10.0.0.0/24, 마스크 /8~/32) · 범위(10.0.0.1-10.0.0.50 또는 10.0.0.1-50) · 단일 IP — 한 줄에 하나(쉼표는 줄바꿈으로 바뀝니다). 스캔 주기는 ‘IP 스캔 설정’ 의 간격을 따릅니다. 전체 스캔은 전체 범위 계정만 시작할 수 있습니다.</div>
      {scanMsg && <div style={{ marginTop: 8 }}><RangeMsg m={scanMsg} /></div>}
    </>
  );
}
