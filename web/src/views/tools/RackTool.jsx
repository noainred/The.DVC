/**
 * 특수 기능 › 랙 실장도(도구 키 rack) — 설계 docs/design/rack-elevation/README.md(시안 ① 조회 · ② 끌어 놓기 편집).
 *   1차 범위(2026-11-20 사용자 선택 '원장+조회+편집'): 법인 › 데이터센터 › 전산실 › 랙 원장 · 전면/후면 실장도 · 겹쳐 보기(종류 · 상태) ·
 *   서버 서비스 태그 ↔ iDRAC 연결 정보 · 미배치 서버 · 관리자 끌어 놓기 편집 · 수동 장비 · 랙 종류 · 변경 이력 · 엑셀 내보내기.
 *   엑셀 가져오기 · PDU 측정값 · 데이터센터 요약 · 평면도 · 배치 계획은 다음 차수(시안에는 있다).
 * 판정(겹침 · 범위 · 권한)은 서버가 한다 — 화면은 끌어 놓는 동안 미리 보기만 하고, 놓으면 서버 응답(409 사유)을 그대로 보여 준다.
 * 폴링하지 않는다(열 때 1회 + 새로 고침 + 쓰기 뒤 재조회). 늦게 온 이전 응답은 버린다(요청 순번).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, postJson, downloadFile, canCsv } from '../../api.js';
import { Loading, ErrorBox, SearchBox, Modal } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import { downloadFailText } from '../downloadFailText.js';
import {
  U_PX, KIND_LABEL, FACE_LABEL, colorOf, legendOf, fmtU, placesForFace, placementIssue, dropStartU, boxOf, wattText,
  roomSummary, matchPlace, ACTION_LABEL, partChips, chipColor, statusKeyOf,
  diffCountText, DIFF_OP_LABEL, DIFF_TYPE_LABEL, fieldsText, matchUnplaced, UNPLACED_PAGE,
} from './rackView.js';

const card = { background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 12, minWidth: 0 };
const btn = { height: 32, padding: '0 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--panel)', color: 'var(--text)', fontWeight: 600, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' };
const btnPri = { ...btn, background: 'var(--accent)', borderColor: 'var(--accent)', color: '#04101f' };
const lab = { fontSize: 11, color: 'var(--text-dim)', fontWeight: 600 };
const sel = { height: 32, padding: '0 8px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--panel-deep)', color: 'var(--text)', minWidth: 0 };
const mono = { fontFamily: 'var(--mono)' };
const segBtn = (on) => ({ height: 30, padding: '0 12px', border: 0, background: on ? 'rgba(59,130,246,.22)' : 'transparent', color: on ? 'var(--text)' : '#aebbd0', fontWeight: 600, fontSize: 12, cursor: 'pointer' });
const seg = { display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', background: 'var(--panel-deep)' };

function Seg({ items, value, onChange, label, wrap = false }) {
  return (
    <div style={wrap ? { ...seg, flexWrap: 'wrap', maxWidth: '100%' } : seg} role="group" aria-label={label}>
      {items.map(([k, t]) => <button key={k} type="button" style={{ ...segBtn(value === k), whiteSpace: 'nowrap' }} aria-pressed={value === k} onClick={() => onChange(k)}>{t}</button>)}
    </div>
  );
}

/** 데이터가 있는데 다시 불러오기만 실패했을 때의 한 줄 안내(화면 전체를 오류 상자로 바꾸지 않는다 — 점검 C22). */
function StaleBanner({ what, error, onRetry }) {
  const why = error?.serverReason || error?.message || '';
  return (
    <div role="alert" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', padding: '8px 12px', borderRadius: 8, fontSize: 12, border: '1px solid var(--amber)', background: 'rgba(245,158,11,.12)' }}>
      <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{what} 다시 불러오지 못했습니다{why ? `(${String(why).slice(0, 160)})` : ''} — 아래는 직전에 불러온 내용입니다.</span>
      <button type="button" style={{ ...btn, height: 26 }} onClick={onRetry}>다시 시도</button>
    </div>
  );
}

function Tile({ k, n, s, color }) {
  return (
    <div style={{ ...card, borderRadius: 10, padding: '10px 12px' }}>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', fontWeight: 600 }}>{k}</div>
      <div style={{ fontSize: 20, fontWeight: 800, marginTop: 2, color: color || 'var(--text)' }}>{n}</div>
      {s ? <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{s}</div> : null}
    </div>
  );
}

/** 랙 하나(정면도). 편집 모드면 끌어 놓기 대상. */
function RackColumn({ rack, places, mode, face, q, selId, onPick, edit, drag, onDragOverRack, onDropRack, preview }) {
  const H = rack.heightU;
  const shown = placesForFace(places, face);
  const us = useMemo(() => Array.from({ length: H }, (_, i) => H - i), [H]);
  const slotsRef = useRef(null);
  const yOf = (e) => { const r = slotsRef.current?.getBoundingClientRect(); return r ? e.clientY - r.top : 0; };
  const t = rack.totals || {};
  const pv = preview && preview.rackId === rack.id ? preview : null;
  return (
    <div style={{ width: 236, flex: '0 0 auto', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, padding: '0 2px 4px', whiteSpace: 'nowrap', overflow: 'hidden' }}>
        <strong style={{ ...mono, fontSize: 14 }}>{rack.name}</strong>
        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{t.usedU ?? 0} / {H}U{t.usePct != null ? ` · ${t.usePct}%` : ''}</span>
        <span style={{ fontSize: 11, color: 'var(--text-dim)', marginLeft: 'auto', overflow: 'hidden', textOverflow: 'ellipsis' }}>{[rack.row && `${rack.row} 줄`, rack.role].filter(Boolean).join(' · ')}</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 8px', fontSize: 10.5, color: 'var(--text-dim)', padding: '0 2px 6px' }}>
        <span>운전 {wattText(t.opW, t.opRead, t.devices)}</span>
        <span>세로 PDU A {rack.pduA} · B {rack.pduB}</span>
      </div>
      <div style={{ display: 'flex', gap: 4, border: `2px solid ${pv ? (pv.ok ? 'var(--green)' : 'var(--red)') : '#3a4866'}`, borderRadius: 6, background: 'var(--bg)', padding: 4 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }} aria-hidden="true">
          {Array.from({ length: rack.pduA }, (_, i) => <div key={i} title={`PDU A${i + 1}`} style={{ flex: 1, width: 6, borderRadius: 2, border: '1px solid #3a4866', background: 'var(--panel)' }} />)}
        </div>
        <div style={{ flex: '0 0 18px', display: 'flex', flexDirection: 'column' }} aria-hidden="true">
          {us.map((u) => <span key={u} style={{ height: U_PX, lineHeight: `${U_PX}px`, fontSize: 9, color: 'var(--text-faint)', textAlign: 'right', ...mono }}>{u}</span>)}
        </div>
        <div
          ref={slotsRef}
          style={{ position: 'relative', flex: 1, minWidth: 0, height: H * U_PX, background: `repeating-linear-gradient(to bottom,var(--panel-deep) 0 ${U_PX - 1}px,var(--border-soft) ${U_PX - 1}px ${U_PX}px)` }}
          onDragOver={edit ? (e) => { e.preventDefault(); onDragOverRack(rack, yOf(e)); } : undefined}
          onDrop={edit ? (e) => { e.preventDefault(); onDropRack(rack, yOf(e)); } : undefined}
        >
          {shown.map((p) => {
            const c = colorOf(p, mode);
            const b = boxOf(p);
            const m = matchPlace(p, q);
            const back = face === 'rear' && p.face === 'full';
            const isSel = p.id === selId;
            const dragging = drag?.type === 'place' && drag.id === p.id;
            return (
              <button
                key={p.id}
                type="button"
                draggable={edit}
                onDragStart={edit ? (e) => { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', p.id); } catch { /* */ } drag.start({ type: 'place', id: p.id, size: p.uSize, face: p.face }); } : undefined}
                onDragEnd={edit ? () => drag.end() : undefined}
                onClick={() => onPick(p.id)}
                title={`${p.label || p.serial || '이름 없음'} — ${rack.name} ${fmtU(p)} · ${FACE_LABEL[p.face] || ''}`}
                style={{
                  position: 'absolute', left: 1, right: 1, bottom: b.bottom, height: b.height, boxSizing: 'border-box', borderRadius: 3,
                  display: 'flex', alignItems: 'center', gap: 6, padding: '0 6px', fontSize: 10, lineHeight: 1, textAlign: 'left', overflow: 'hidden', whiteSpace: 'nowrap',
                  cursor: edit ? 'grab' : 'pointer',
                  background: back ? 'var(--panel)' : c.bg, border: `1px solid ${back ? '#3a4866' : c.bd}`, color: back ? 'var(--text-dim)' : c.fg,
                  ...(isSel ? { outline: '2px solid #ffffff', outlineOffset: 0 } : m ? { outline: '2px solid #fcd34d', outlineOffset: -1 } : {}),
                  opacity: dragging ? 0.35 : (m === false ? 0.35 : 1),
                }}
              >
                <span style={{ ...mono, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, flex: 1 }}>{p.label || p.serial || '이름 없음'}</span>
                <span style={{ fontWeight: 700, flex: '0 0 auto' }}>{back ? '뒷면' : c.val}</span>
              </button>
            );
          })}
          {pv ? (
            <div aria-hidden="true" style={{
              position: 'absolute', left: 1, right: 1, bottom: (pv.uStart - 1) * U_PX, height: pv.uSize * U_PX - 1, boxSizing: 'border-box', borderRadius: 3, pointerEvents: 'none',
              border: `2px dashed ${pv.ok ? 'var(--green)' : 'var(--red)'}`, background: pv.ok ? 'rgba(34,197,94,.2)' : 'rgba(239,68,68,.3)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, color: pv.ok ? '#bbf7d0' : '#ffffff',
            }}>{pv.ok ? `U${pv.uStart}${pv.uSize > 1 ? `–${pv.uStart + pv.uSize - 1}` : ''} 에 놓기` : pv.reason}</div>
          ) : null}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }} aria-hidden="true">
          {Array.from({ length: rack.pduB }, (_, i) => <div key={i} title={`PDU B${i + 1}`} style={{ flex: 1, width: 6, borderRadius: 2, border: '1px solid #3a4866', background: 'var(--panel)' }} />)}
        </div>
      </div>
    </div>
  );
}

function Detail({ p, rack, onEdit, edit }) {
  if (!p) return <div style={{ padding: '12px 14px', fontSize: 12, color: 'var(--text-dim)' }}>랙에서 장비를 누르면 여기에 정보가 나옵니다.</div>;
  const l = p.link;
  const dl = { display: 'grid', gridTemplateColumns: '84px minmax(0,1fr)', gap: '6px 10px', fontSize: 12, margin: 0 };
  const dt = { color: 'var(--text-dim)' };
  const dd = { margin: 0, minWidth: 0, overflowWrap: 'anywhere' };
  const st = statusKeyOf(p);
  return (
    <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10, fontWeight: 700, border: '1px solid var(--border)', borderRadius: 5, padding: '1px 6px', color: '#c3cee0' }}>{KIND_LABEL[p.kind] || '기타'}</span>
        <strong style={{ ...mono, fontSize: 14, overflowWrap: 'anywhere' }}>{p.label || p.serial || '이름 없음'}</strong>
        {edit ? <button type="button" style={{ ...btn, marginLeft: 'auto' }} onClick={onEdit}>고치기</button> : null}
      </div>
      <dl style={dl}>
        <dt style={dt}>위치</dt><dd style={{ ...dd, ...mono }}>{rack?.name} · {fmtU(p)} ({p.uSize}U) · {FACE_LABEL[p.face]}</dd>
        <dt style={dt}>모델</dt><dd style={dd}>{p.model || '—'}</dd>
        <dt style={dt}>{p.kind === 'server' ? '서비스 태그' : '시리얼'}</dt>
        <dd style={{ ...dd, ...mono }}>{p.serialHidden ? '— (범위 계정에는 보이지 않습니다)' : [p.serial, ...(p.extraSerials || [])].filter(Boolean).join(' / ') || '—'}</dd>
        <dt style={dt}>계획 전력</dt><dd style={dd}>운전 {wattText(p.opW)} · 정격 {wattText(p.ratedW)}</dd>
        <dt style={dt}>무게</dt><dd style={dd}>{p.weightKg == null ? '—' : `${p.weightKg} kg`}</dd>
        {p.note ? <><dt style={dt}>메모</dt><dd style={dd}>{p.note}</dd></> : null}
      </dl>
      {p.kind === 'server' ? (
        <div style={{ borderTop: '1px solid var(--border-soft)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <strong>iDRAC 정보</strong>
            {l?.collectedAt ? <span style={{ fontSize: 11, color: 'var(--text-dim)', marginLeft: 'auto' }}>{new Date(l.collectedAt).toLocaleString()} 수집{l.remote ? ' · 엣지' : ''}</span> : null}
          </div>
          {p.linkState === 'no-serial' ? <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>서비스 태그가 비어 있어 iDRAC 등록 서버와 잇지 못했습니다 — 고치기에서 서비스 태그를 넣으세요.</div> : null}
          {p.linkState === 'not-found' ? <div style={{ fontSize: 12, color: '#fde68a' }}>이 서비스 태그의 서버를 iDRAC 등록 서버(이 계정이 볼 수 있는 범위)에서 찾지 못했습니다.</div> : null}
          {l ? (
            <>
              <dl style={dl}>
                <dt style={dt}>호스트 이름</dt><dd style={{ ...dd, ...mono }}>{l.hostname || l.name || '—'}</dd>
                <dt style={dt}>모델</dt><dd style={dd}>{l.model || '—'}</dd>
                <dt style={dt}>상태</dt><dd style={dd}>{{ ok: '정상', warn: '경고', crit: '장애' }[st] || '못 읽음'}</dd>
                <dt style={dt}>전원</dt><dd style={dd}>{l.powerState === 'On' ? '켜짐' : l.powerState === 'Off' ? '꺼짐' : (l.powerState || '—')}</dd>
                <dt style={dt}>CPU · 메모리</dt>
                <dd style={dd}>{l.hw?.cpu ? `${l.hw.cpu.sockets ?? '?'} × ${l.hw.cpu.model || 'CPU'}` : '—'}{l.hw?.mem?.gib != null ? ` · ${l.hw.mem.gib} GB` : ''}</dd>
                <dt style={dt}>펌웨어</dt><dd style={dd}>{l.hw?.fw ? `iDRAC ${l.hw.fw}` : '—'}</dd>
                {l.mgmtHost !== undefined ? <><dt style={dt}>관리 주소</dt><dd style={{ ...dd, ...mono }}>{l.mgmtHost || '—'}</dd></> : null}
              </dl>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {partChips(l.parts).map((c) => { const k = chipColor(c.state); return <span key={c.k} style={{ display: 'inline-flex', alignItems: 'center', height: 22, padding: '0 8px', borderRadius: 999, fontSize: 11, fontWeight: 600, background: k[0], border: `1px solid ${k[1]}`, color: k[2] }}>{c.text}</span>; })}
                {!l.parts ? <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>부품 정보를 아직 수집하지 않았습니다.</span> : null}
              </div>
              {l.mgmtHost ? <a href={`https://${l.mgmtHost}`} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: '#93c5fd' }}>iDRAC 웹 콘솔 열기 ↗</a> : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const EMPTY_PLACE = { face: 'full', uStart: '', uSize: '', kind: 'server', label: '', model: '', serial: '', extraSerials: '', note: '', opW: '', ratedW: '', weightKg: '' };

function PlaceModal({ init, racks, onClose, onSave, onRemove, busy, error }) {
  const [f, setF] = useState(() => ({ ...EMPTY_PLACE, ...init, extraSerials: Array.isArray(init.extraSerials) ? init.extraSerials.join(' / ') : (init.extraSerials || '') }));
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const row = { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: '1 1 140px' };
  const inp = { ...sel, width: '100%', boxSizing: 'border-box' };
  return (
    <Modal title={init.id ? '장비 고치기' : '장비 놓기'} onClose={onClose} width={620}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {init.serialHidden ? <div style={{ fontSize: 12, color: '#fde68a' }}>이 계정에는 시리얼이 보이지 않아 고칠 수 없습니다.</div> : null}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          <label style={row}><span style={lab}>랙</span>
            <Select style={inp} value={f.rackId} onChange={set('rackId')}>{racks.map((r) => <option key={r.id} value={r.id}>{r.name} ({r.heightU}U)</option>)}</Select></label>
          <label style={row}><span style={lab}>시작 U(아래가 1)</span><input style={inp} inputMode="numeric" value={f.uStart} onChange={set('uStart')} /></label>
          <label style={row}><span style={lab}>높이(U) — 1U 로 가정하지 않습니다</span><input style={inp} inputMode="numeric" value={f.uSize} onChange={set('uSize')} /></label>
          <label style={row}><span style={lab}>면</span>
            <Select sort={false} style={inp} value={f.face} onChange={set('face')}>{Object.entries(FACE_LABEL).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</Select></label>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          <label style={row}><span style={lab}>종류</span>
            <Select sort={false} style={inp} value={f.kind} onChange={set('kind')}>{Object.entries(KIND_LABEL).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</Select></label>
          <label style={{ ...row, flex: '2 1 220px' }}><span style={lab}>표시 이름</span><input style={inp} value={f.label} onChange={set('label')} placeholder="예: 가상화서버 #16" /></label>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          <label style={row}><span style={lab}>모델</span><input style={inp} value={f.model} onChange={set('model')} placeholder="예: PowerEdge R740" /></label>
          <label style={row}><span style={lab}>{f.kind === 'server' ? '서비스 태그(iDRAC 연결 기준)' : '시리얼'}</span><input style={{ ...inp, ...mono }} value={f.serial} onChange={set('serial')} disabled={!!init.serialHidden} /></label>
        </div>
        <label style={{ ...row, flex: 'none' }}><span style={lab}>추가 시리얼(섀시 안 노드 등 — ‘/’ 또는 쉼표로 구분)</span><input style={{ ...inp, ...mono }} value={f.extraSerials} onChange={set('extraSerials')} disabled={!!init.serialHidden} /></label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          <label style={row}><span style={lab}>운전 전력(W)</span><input style={inp} inputMode="decimal" value={f.opW ?? ''} onChange={set('opW')} /></label>
          <label style={row}><span style={lab}>정격 전력(W)</span><input style={inp} inputMode="decimal" value={f.ratedW ?? ''} onChange={set('ratedW')} /></label>
          <label style={row}><span style={lab}>무게(kg)</span><input style={inp} inputMode="decimal" value={f.weightKg ?? ''} onChange={set('weightKg')} /></label>
        </div>
        <label style={{ ...row, flex: 'none' }}><span style={lab}>메모</span><input style={inp} value={f.note} onChange={set('note')} /></label>
        {error ? <div role="alert" style={{ fontSize: 12, color: '#fecaca', border: '1px solid var(--red)', background: 'rgba(239,68,68,.12)', borderRadius: 8, padding: '8px 10px' }}>{error}</div> : null}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {init.id ? <button type="button" style={{ ...btn, color: '#fecaca' }} disabled={busy} onClick={onRemove}>장비 빼기</button> : null}
          <span style={{ flex: 1 }} />
          <button type="button" style={btn} onClick={onClose}>취소</button>
          <button type="button" style={btnPri} disabled={busy} onClick={() => onSave(f)}>{busy ? '저장 중…' : '저장'}</button>
        </div>
      </div>
    </Modal>
  );
}

function RackModal({ init, types, onClose, onSave, onRemove, busy, error }) {
  const [f, setF] = useState(() => ({ name: '', row: '', role: '', typeId: '', heightU: 42, pduA: 2, pduB: 2, ...init }));
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const row = { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: '1 1 140px' };
  const inp = { ...sel, width: '100%', boxSizing: 'border-box' };
  return (
    <Modal title={init.id ? '랙 고치기' : '랙 추가'} onClose={onClose} width={560}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          <label style={row}><span style={lab}>랙 이름</span><input style={inp} value={f.name} onChange={set('name')} placeholder="예: A4" /></label>
          <label style={row}><span style={lab}>줄</span><input style={inp} value={f.row} onChange={set('row')} placeholder="예: A" /></label>
          <label style={row}><span style={lab}>용도</span><input style={inp} value={f.role} onChange={set('role')} placeholder="예: DVC SERVER(ESX2)" /></label>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          <label style={row}><span style={lab}>랙 종류</span>
            <Select style={inp} value={f.typeId} onChange={set('typeId')}>
              <option value="">직접 높이 입력</option>
              {types.map((t) => <option key={t.id} value={t.id}>{t.name} · {t.heightU}U</option>)}
            </Select></label>
          <label style={row}><span style={lab}>높이(U)</span><input style={inp} inputMode="numeric" value={f.typeId ? (types.find((t) => t.id === f.typeId)?.heightU ?? '') : f.heightU} disabled={!!f.typeId} onChange={set('heightU')} /></label>
          <label style={row}><span style={lab}>세로 PDU A 계통</span><input style={inp} inputMode="numeric" value={f.pduA} onChange={set('pduA')} /></label>
          <label style={row}><span style={lab}>세로 PDU B 계통</span><input style={inp} inputMode="numeric" value={f.pduB} onChange={set('pduB')} /></label>
        </div>
        {error ? <div role="alert" style={{ fontSize: 12, color: '#fecaca', border: '1px solid var(--red)', background: 'rgba(239,68,68,.12)', borderRadius: 8, padding: '8px 10px' }}>{error}</div> : null}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {init.id ? <button type="button" style={{ ...btn, color: '#fecaca' }} disabled={busy} onClick={onRemove}>랙 지우기(빈 랙만)</button> : null}
          <span style={{ flex: 1 }} />
          <button type="button" style={btn} onClick={onClose}>취소</button>
          <button type="button" style={btnPri} disabled={busy} onClick={() => onSave(f)}>{busy ? '저장 중…' : '저장'}</button>
        </div>
      </div>
    </Modal>
  );
}

function NameModal({ title, init = '', extra = null, onClose, onSave, onRemove, removeLabel, busy, error }) {
  const [v, setV] = useState(init);
  return (
    <Modal title={title} onClose={onClose} width={440}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><span style={lab}>이름</span>
          <input style={{ ...sel, width: '100%', boxSizing: 'border-box' }} value={v} onChange={(e) => setV(e.target.value)} autoFocus /></label>
        {extra}
        {error ? <div role="alert" style={{ fontSize: 12, color: '#fecaca' }}>{error}</div> : null}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {onRemove ? <button type="button" style={{ ...btn, color: '#fecaca' }} disabled={busy} onClick={onRemove}>{removeLabel}</button> : null}
          <span style={{ flex: 1 }} />
          <button type="button" style={btn} onClick={onClose}>취소</button>
          <button type="button" style={btnPri} disabled={busy || !v.trim()} onClick={() => onSave(v)}>{busy ? '저장 중…' : '저장'}</button>
        </div>
      </div>
    </Modal>
  );
}

function TypesModal({ types, onClose, onAdd, onRemove, busy, error }) {
  const [name, setName] = useState(''); const [h, setH] = useState('42');
  return (
    <Modal title="랙 종류(전 법인 공용)" onClose={onClose} width={520}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <STable style={{ width: '100%', fontSize: 12 }}>
          <thead><tr><th style={{ textAlign: 'left' }}>이름</th><th style={{ textAlign: 'right' }}>높이</th><th data-nosort="1" /></tr></thead>
          <tbody>{types.map((t) => (
            <tr key={t.id}><td>{t.name}</td><td style={{ textAlign: 'right' }} data-sort={t.heightU}>{t.heightU}U</td>
              <td style={{ textAlign: 'right' }}><button type="button" style={btn} disabled={busy} onClick={() => onRemove(t.id)}>지우기</button></td></tr>
          ))}</tbody>
        </STable>
        {!types.length ? <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>아직 랙 종류가 없습니다. 랙을 추가할 때 높이를 직접 넣어도 됩니다.</div> : null}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '2 1 160px' }}><span style={lab}>이름</span><input style={sel} value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 스토리지 랙 40U" /></label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 80px' }}><span style={lab}>높이(U)</span><input style={sel} inputMode="numeric" value={h} onChange={(e) => setH(e.target.value)} /></label>
          <button type="button" style={btnPri} disabled={busy || !name.trim()} onClick={() => onAdd(name, h).then((ok) => { if (ok) setName(''); })}>추가</button>
        </div>
        {error ? <div role="alert" style={{ fontSize: 12, color: '#fecaca' }}>{error}</div> : null}
      </div>
    </Modal>
  );
}

/**
 * 판 기록(법인별 최근 30개) — 판을 고르면 '이 판에서 바뀐 것' 과 '되돌리면 바뀌는 것' 을 보여 주고, 권한이 있으면 그 판으로 되돌린다.
 * 되돌리기는 확인을 한 번 더 받는다(원장을 통째로 바꾼다). 판 목록은 열 때 1회 + 되돌린 뒤 다시 읽는다(폴링 없음).
 */
function VersionsModal({ corpId, corpName, onClose, onRestored }) {
  const [list, setList] = useState(null);
  const [err, setErr] = useState(null);
  const [selVid, setSelVid] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailErr, setDetailErr] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [detailTick, setDetailTick] = useState(0);   // 되돌리기 충돌 뒤 고른 판의 차이를 새 원장 기준으로 다시 읽는다(점검 C14)
  const seqRef = useRef(0);
  const load = useCallback(async () => {
    try { const r = await fetchJson('/tools/rack/versions', { corp: corpId }); setList(r); setErr(null); return r; } catch (e) { setErr(e); return null; }
  }, [corpId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    setDetail(null); setDetailErr(''); setConfirm(false);
    if (selVid == null) return;
    const my = ++seqRef.current;
    fetchJson(`/tools/rack/versions/${selVid}`, { corp: corpId })
      .then((d) => { if (my === seqRef.current) setDetail(d); })
      .catch((e) => { if (my === seqRef.current) setDetailErr(e?.serverReason || e?.message || '판을 읽지 못했습니다.'); });
  }, [selVid, corpId, detailTick]);
  useEffect(() => { setMsg(''); }, [selVid]);
  const restore = async () => {
    setBusy(true); setMsg('');
    try {
      const r = await postJson('/tools/rack/op', { op: 'version.restore', corpId, versionId: selVid, expectLatestId: list?.latestId });
      if (r?.ok === false) {
        setMsg(r.reason || '되돌리지 못했습니다.');
        if (r.code === 'versionConflict') { await load(); setConfirm(false); setDetailTick((x) => x + 1); }
        return;
      }
      await load();
      setSelVid(null);
      onRestored(`판 #${r.restoredFrom} 으로 되돌렸습니다(새 판 #${r.latestId} 로 남김 — 다시 되돌릴 수 있습니다).`);
    } catch (e) { setMsg(e?.serverReason || e?.message || '되돌리지 못했습니다.'); } finally { setBusy(false); }
  };
  const versions = list?.versions || [];
  const sel = versions.find((v) => v.id === selVid);
  const itemList = (d) => (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: 220, overflowY: 'auto', border: '1px solid var(--border-soft)', borderRadius: 8 }}>
      {d.items.map((it, i) => (
        <li key={`${it.type}-${it.id}-${it.op}-${i}`} style={{ padding: '5px 10px', borderBottom: '1px solid var(--border-soft)', fontSize: 12, display: 'flex', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
          <span style={{ color: it.op === 'remove' ? '#fca5a5' : it.op === 'add' ? '#bbf7d0' : '#fde68a', fontWeight: 700, flex: '0 0 auto' }}>{DIFF_TYPE_LABEL[it.type]} {DIFF_OP_LABEL[it.op]}</span>
          <span style={{ ...mono, overflowWrap: 'anywhere' }}>{it.name}</span>
          {it.where ? <span style={{ color: 'var(--text-dim)', overflowWrap: 'anywhere' }}>{it.where}</span> : null}
          {it.fields ? <span style={{ color: 'var(--text-dim)' }}>{fieldsText(it.fields)}</span> : null}
        </li>
      ))}
      {!d.items.length ? <li style={{ padding: '6px 10px', fontSize: 12, color: 'var(--text-dim)' }}>바뀐 것 없음</li> : null}
      {d.omitted ? <li style={{ padding: '6px 10px', fontSize: 11, color: 'var(--text-dim)' }}>외 {d.omitted}건은 줄였습니다.</li> : null}
    </ul>
  );
  return (
    <Modal title={`판 기록 — ${corpName}`} onClose={onClose} width={980}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>
          변경이 저장될 때마다 이 법인의 랙 실장도 전체(데이터센터 · 전산실 · 랙 · 장비 배치)를 한 판으로 남깁니다. 법인마다 {list?.keep != null ? `최근 ${list.keep}개만` : '정해진 개수의 최근 판만'} 남고 더 오래된 판은 지워집니다.
        </span>
        {err ? <ErrorBox error={err} /> : !list ? <Loading label="판 기록" /> : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-start' }}>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, flex: '1 1 300px', minWidth: 0, maxHeight: 460, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 10 }}>
              {versions.map((v, i) => (
                <li key={v.id}>
                  <button type="button" onClick={() => setSelVid(v.id)} aria-pressed={v.id === selVid}
                    style={{ width: '100%', textAlign: 'left', padding: '8px 12px', border: 0, borderBottom: '1px solid var(--border-soft)', cursor: 'pointer', background: v.id === selVid ? 'rgba(59,130,246,.16)' : 'transparent', color: 'var(--text)', display: 'flex', flexDirection: 'column', gap: 2, minHeight: 44 }}>
                    <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 11, color: 'var(--text-dim)' }}>
                      <span style={mono}>#{v.id}</span><span style={mono}>{new Date(v.ts).toLocaleString()}</span>
                      {i === 0 ? <span style={{ color: '#93c5fd', fontWeight: 700 }}>지금 원장</span> : null}
                      {v.user ? <span>{v.user}</span> : null}
                    </span>
                    <span style={{ fontSize: 12, fontWeight: 600 }}>{ACTION_LABEL[v.action] || v.action}</span>
                    <span style={{ fontSize: 11.5, color: 'var(--text-dim)', overflowWrap: 'anywhere' }}>{v.detail}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>랙 {v.counts?.racks ?? '—'} · 장비 {v.counts?.places ?? '—'}</span>
                  </button>
                </li>
              ))}
              {!versions.length ? <li style={{ padding: 12, fontSize: 12, color: 'var(--text-dim)' }}>아직 저장된 판이 없습니다.</li> : null}
            </ul>
            <div style={{ flex: '2 1 420px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {selVid == null ? <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>왼쪽에서 판을 고르면 무엇이 바뀌었는지 보여 줍니다.</span> : null}
              {detailErr ? <div role="alert" style={{ fontSize: 12, color: '#fecaca' }}>{detailErr}</div> : null}
              {selVid != null && !detail && !detailErr ? <Loading label="판" /> : null}
              {detail && !detail.readable ? <div role="alert" style={{ fontSize: 12, color: '#fecaca' }}>이 판을 읽지 못했습니다(손상) — 보거나 되돌릴 수 없습니다.</div> : null}
              {detail?.readable ? (
                <>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <strong style={{ fontSize: 13 }}>이 판에서 바뀐 것 <span style={{ fontWeight: 400, color: 'var(--text-dim)', fontSize: 12 }}>(바로 앞 판 → 판 #{detail.version.id})</span></strong>
                    {detail.changes ? <><span style={{ fontSize: 12 }}>{diffCountText(detail.changes.counts)}</span>{itemList(detail.changes)}</> : <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{detail.prevUnreadable ? '바로 앞 판을 읽지 못해(손상) 비교할 수 없습니다.' : '앞 판이 남아 있지 않아 비교할 수 없습니다(가장 오래된 판).'}</span>}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <strong style={{ fontSize: 13 }}>되돌리면 바뀌는 것 <span style={{ fontWeight: 400, color: 'var(--text-dim)', fontSize: 12 }}>(지금 원장 → 판 #{detail.version.id})</span></strong>
                    {detail.restore ? <><span style={{ fontSize: 12 }}>{diffCountText(detail.restore.counts)}</span>{itemList(detail.restore)}</> : <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>—</span>}
                  </div>
                  {list.canRestore && sel && selVid !== list.latestId ? (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', padding: '10px 12px', border: `1px solid ${confirm ? 'var(--red)' : 'var(--border)'}`, borderRadius: 10, background: confirm ? 'rgba(239,68,68,.10)' : 'transparent' }}>
                      {!confirm ? (
                        <button type="button" style={btnPri} onClick={() => setConfirm(true)}>이 판으로 되돌리기</button>
                      ) : (
                        <>
                          <span style={{ fontSize: 12, flex: '1 1 260px' }}>{corpName} 의 랙 실장도 전체가 판 #{selVid} 의 모습으로 바뀝니다. 지금 모습도 판으로 남아 다시 되돌릴 수 있습니다. 열려 있는 다른 편집 화면은 다음 저장에서 최신을 다시 불러옵니다.</span>
                          <button type="button" style={btn} disabled={busy} onClick={() => setConfirm(false)}>취소</button>
                          <button type="button" style={{ ...btnPri, background: 'var(--red)', borderColor: 'var(--red)', color: '#ffffff' }} disabled={busy} onClick={restore}>{busy ? '되돌리는 중…' : '되돌리기 확인'}</button>
                        </>
                      )}
                    </div>
                  ) : null}
                  {sel && selVid === list.latestId ? <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>지금 원장과 같은 판입니다.</span> : null}
                  {!list.canRestore ? <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>되돌리기는 관리자(이 법인 쓰기 범위)만 할 수 있습니다.</span> : null}
                </>
              ) : null}
              {msg ? <div role="alert" style={{ fontSize: 12, color: '#fecaca', border: '1px solid var(--red)', background: 'rgba(239,68,68,.12)', borderRadius: 8, padding: '8px 10px' }}>{msg}</div> : null}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

export default function RackTool() {
  const [tree, setTree] = useState(null);
  const [treeErr, setTreeErr] = useState(null);
  const [corpId, setCorpId] = useState('');
  const [siteId, setSiteId] = useState('');
  const [roomId, setRoomId] = useState('');
  const [viewRaw, setView] = useState(null);
  const [viewErr, setViewErr] = useState(null);
  const [loadingRoom, setLoadingRoom] = useState(false);
  const [mode, setMode] = useState('kind');
  const [face, setFace] = useState('front');
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState(false);
  const [selId, setSelId] = useState('');
  const [modal, setModal] = useState(null);   // { kind, ... }
  const [busy, setBusy] = useState(false);
  const [modalErr, setModalErr] = useState('');
  const [note, setNote] = useState(null);     // { tone, text }
  const [dragInfo, setDragInfo] = useState(null);
  const [preview, setPreview] = useState(null);
  const seq = useRef(0);
  const roomIdRef = useRef('');
  roomIdRef.current = roomId;
  // 화면 · 쓰기에 쓰는 전산실 응답은 **지금 고른 전산실의 것만**(늦게 온 다른 전산실 응답 · 법인을 바꾼 뒤 남은 응답으로 보이지 않는 원장에 쓰지 않게 — 점검 C1).
  const view = viewRaw && viewRaw.room?.id === roomId ? viewRaw : null;
  const treeSeq = useRef(0);

  const loadTree = useCallback(async () => {
    const my = ++treeSeq.current;
    try {
      const t = await fetchJson('/tools/rack');
      if (my !== treeSeq.current) return null;   // 늦게 온 이전 응답은 버린다
      setTree(t); setTreeErr(null);
      return t;
    } catch (e) { if (my === treeSeq.current) setTreeErr(e); return null; }
  }, []);

  const loadRoom = useCallback(async (id) => {
    const my = ++seq.current;   // 빈 전산실로 바꿀 때도 올린다 — 앞 요청의 늦은 응답이 되살아나지 않게(점검 C1)
    if (!id) { setView(null); setViewErr(null); setLoadingRoom(false); return null; }
    setLoadingRoom(true); setViewErr(null);
    try {
      const v = await fetchJson(`/tools/rack/room/${encodeURIComponent(id)}`);
      if (my !== seq.current || id !== roomIdRef.current) return null;   // 늦게 온 이전 응답 · 다른 전산실 응답은 버린다
      setView(v); setViewErr(null);
      return v;
    } catch (e) {
      if (my === seq.current) { setViewErr(e); setView(null); }
      return null;
    } finally { if (my === seq.current) setLoadingRoom(false); }
  }, []);

  useEffect(() => { loadTree(); }, [loadTree]);

  // 고른 법인 · 데이터센터 · 전산실이 목록에서 사라졌으면 첫 항목으로(목록이 바뀔 때만).
  const sites = useMemo(() => (tree?.sites || []).filter((s) => s.corpId === corpId), [tree, corpId]);
  const rooms = useMemo(() => (tree?.rooms || []).filter((r) => r.siteId === siteId), [tree, siteId]);
  useEffect(() => {
    if (!tree) return;
    const corps = tree.corps || [];
    if (!corps.some((c) => c.id === corpId)) setCorpId(corps.find((c) => (tree.sites || []).some((s) => s.corpId === c.id))?.id || corps[0]?.id || '');
  }, [tree, corpId]);
  useEffect(() => { if (tree && !sites.some((s) => s.id === siteId)) setSiteId(sites[0]?.id || ''); }, [tree, sites, siteId]);
  useEffect(() => { if (tree && !rooms.some((r) => r.id === roomId)) setRoomId(rooms[0]?.id || ''); }, [tree, rooms, roomId]);
  // 전산실을 바꾸면 고른 장비 · 미리 보기 · 앞 전산실의 알림 줄을 지운다(다른 전산실 작업 결과가 남아 보이지 않게).
  useEffect(() => { setSelId(''); setPreview(null); setNote(null); loadRoom(roomId); }, [roomId, loadRoom]);

  const corp = (tree?.corps || []).find((c) => c.id === corpId);
  const canEdit = !!view?.canEdit;
  const corpWritable = !!corp?.writable;
  useEffect(() => { if (!canEdit && !corpWritable) setEdit(false); }, [canEdit, corpWritable]);

  const placesByRack = useMemo(() => {
    const m = new Map();
    for (const p of view?.places || []) { if (!m.has(p.rackId)) m.set(p.rackId, []); m.get(p.rackId).push(p); }
    return m;
  }, [view]);
  const selected = (view?.places || []).find((p) => p.id === selId) || null;
  const selRack = selected ? (view?.racks || []).find((r) => r.id === selected.rackId) : null;
  const sum = useMemo(() => roomSummary(view), [view]);
  // 개선 3: 미배치 서버는 검색어로 거르고(랙 강조와 같은 검색 칸), 한 번에 UNPLACED_PAGE 대씩 그린다(예전엔 앞 50대만 끌 수 있었다).
  const [unplacedShow, setUnplacedShow] = useState(UNPLACED_PAGE);
  const unplacedHit = useMemo(() => (view?.unplaced || []).filter((u) => matchUnplaced(u, q)), [view, q]);
  useEffect(() => { setUnplacedShow(UNPLACED_PAGE); }, [q, roomId]);

  const say = (tone, text) => setNote({ tone, text });

  /** 쓰기 연산 하나 — 409(충돌 · 겹침)는 사유를 그대로 보여 주고, 판이 바뀌었으면 최신을 다시 불러온다. */
  const run = useCallback(async (body, { okText = '저장했습니다.', closeModal = true } = {}) => {
    setBusy(true); setModalErr('');
    try {
      const r = await postJson('/tools/rack/op', body);
      if (r?.ok === false) {
        const why = r.reason || '저장하지 못했습니다.';
        if (r.code === 'revConflict') {
          await loadRoom(roomIdRef.current);
          // 창을 닫지 않는다(입력 유지 — 점검 C20). 서버 사유가 이미 '최신 배치를 불러온 뒤 다시 하세요' 라 덧붙이지 않는다(Chromium 확인에서 같은 말이 두 번 나왔다).
          setModalErr(`${why} 입력은 그대로 두었습니다.`);
          say('warn', why);
          return null;
        }
        setModalErr(why); say('err', why);
        return null;
      }
      // 이 화면의 rev 로 쓴 변경이 성공했으면 새 rev 를 바로 반영한다 — 다시 불러오기 전에 이어서 끌어 놓아도 자기 변경과 충돌하지 않게(점검 C19).
      if (Number.isInteger(r?.rev) && Number.isInteger(body?.rev)) setView((v) => (v && v.rev === body.rev ? { ...v, rev: r.rev } : v));
      if (closeModal) setModal(null);
      say('ok', okText);
      return r;
    } catch (e) {
      const why = e?.serverReason || e?.message || '저장하지 못했습니다.';
      setModalErr(why); say('err', why);
      return null;
    } finally { setBusy(false); }
  }, [loadRoom]);

  // 쓰기 뒤 다시 불러올 전산실은 **그때 고른 전산실**(쓰는 동안 전산실을 바꿨으면 옛 전산실로 화면이 돌아가지 않게 — 점검 C2).
  const afterRoomWrite = async (r) => { if (r) await Promise.all([loadRoom(roomIdRef.current), loadTree()]); return r; };

  // ── 끌어 놓기 ──
  const drag = useMemo(() => ({
    start: (d) => setDragInfo(d),
    end: () => { setDragInfo(null); setPreview(null); },
  }), []);
  const candOf = (rack, y) => {
    if (!dragInfo) return null;
    const size = dragInfo.size || 1;
    const uStart = dropStartU(y, rack.heightU, size);
    if (uStart == null) return { rackId: rack.id, uStart: 1, uSize: size, ok: false, reason: '랙보다 큽니다' };
    const issue = placementIssue(rack, placesByRack.get(rack.id) || [], { face: dragInfo.face || 'full', uStart, uSize: size }, dragInfo.type === 'place' ? dragInfo.id : '');
    return { rackId: rack.id, uStart, uSize: size, ok: !issue, reason: issue?.code === 'overlap' ? '다른 장비와 겹침 — 놓을 수 없음' : issue ? '놓을 수 없음' : '' };
  };
  const onDragOverRack = (rack, y) => {
    const c = candOf(rack, y);
    if (c && (!preview || preview.rackId !== c.rackId || preview.uStart !== c.uStart || preview.ok !== c.ok)) setPreview(c);
  };
  const onDropRack = async (rack, y) => {
    const c = candOf(rack, y);
    const d = dragInfo;
    setDragInfo(null); setPreview(null);
    if (!c || !d) return;
    if (busy) { say('warn', '앞 변경을 저장하는 중입니다 — 끝난 뒤 다시 놓으세요.'); return; }
    if (!c.ok) { say('err', `${rack.name} U${c.uStart} 에는 놓을 수 없습니다 — ${c.reason}.`); return; }
    if (d.type === 'place') {
      afterRoomWrite(await run({ op: 'place.update', id: d.id, rackId: rack.id, rev: view.rev, place: { uStart: c.uStart } }, { okText: `${rack.name} U${c.uStart} 로 옮겼습니다.` }));
    } else if (d.type === 'server') {
      // 미배치 서버 — 높이를 모르므로 1U 로 가정하지 않고 입력 창을 연다(위치는 놓은 자리로 채운다).
      setModalErr('');
      setModal({ kind: 'place', init: { rackId: rack.id, uStart: c.uStart, uSize: '', face: 'full', kind: 'server', label: d.name || '', model: d.model || '', serial: d.serviceTag || '' } });
    }
  };

  const savePlace = async (f) => {
    const body = {
      face: f.face, uStart: f.uStart, uSize: f.uSize, kind: f.kind, label: f.label, model: f.model, note: f.note,
      opW: f.opW, ratedW: f.ratedW, weightKg: f.weightKg,
      ...(modal.init.serialHidden ? {} : { serial: f.serial, extraSerials: f.extraSerials }),
    };
    const r = modal.init.id
      ? await run({ op: 'place.update', id: modal.init.id, rackId: f.rackId, rev: view.rev, place: body })
      : await run({ op: 'place.add', rackId: f.rackId, rev: view.rev, place: body }, { okText: '장비를 놓았습니다.' });
    if (r?.id) setSelId(r.id);
    afterRoomWrite(r);
  };

  const exportXlsx = async () => {
    try { await downloadFile(`/tools/rack/room/${encodeURIComponent(roomId)}/xlsx`, `rack-${view?.room?.name || 'room'}.xlsx`); }
    catch (e) { say('err', downloadFailText ? downloadFailText(e) : (e?.message || '내려받지 못했습니다.')); }
  };

  if (treeErr && !tree) return <ErrorBox error={treeErr} />;
  if (!tree) return <Loading label="랙 실장도" />;

  const corps = tree.corps || [];
  const types = tree.types || [];
  const racks = view?.racks || [];
  const legend = legendOf(mode);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
        <label style={lab} htmlFor="rk-corp">법인</label>
        <Select id="rk-corp" style={sel} value={corpId} onChange={(e) => setCorpId(e.target.value)}>
          {!corps.length ? <option value="">볼 수 있는 법인이 없습니다</option> : null}
          {corps.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <label style={lab} htmlFor="rk-site">데이터센터</label>
        <Select id="rk-site" style={sel} value={siteId} onChange={(e) => setSiteId(e.target.value)}>
          {!sites.length ? <option value="">등록된 데이터센터 없음</option> : null}
          {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
        <span style={lab}>전산실</span>
        {rooms.length ? <Seg label="전산실" wrap items={rooms.map((r) => [r.id, `${r.name} · 랙 ${r.racks}`])} value={roomId} onChange={setRoomId} /> : <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>없음</span>}
        <span style={lab}>겹쳐 보기</span>
        <Seg label="겹쳐 보기" items={[['kind', '종류'], ['status', '상태']]} value={mode} onChange={setMode} />
        <Seg label="면" items={[['front', '전면'], ['rear', '후면']]} value={face} onChange={setFace} />
        <SearchBox value={q} onChange={setQ} placeholder="이름 · 시리얼 · 호스트 이름 찾기" style={{ flex: '1 1 160px', minWidth: 120 }} />
        <button type="button" style={btn} onClick={() => { loadTree(); loadRoom(roomId); }}>새로 고침</button>
        {view && canCsv() ? <button type="button" style={btn} onClick={exportXlsx}>엑셀 내보내기</button> : null}
        {corpId ? <button type="button" style={btn} onClick={() => setModal({ kind: 'versions' })}>판 기록</button> : null}
        {tree.canEditTypes ? <button type="button" style={btn} onClick={() => { setModalErr(''); setModal({ kind: 'types' }); }}>랙 종류</button> : null}
        {(canEdit || corpWritable) ? <button type="button" style={edit ? btn : btnPri} aria-pressed={edit} onClick={() => setEdit((x) => !x)}>{edit ? '편집 끝내기' : '배치 편집'}</button> : null}
      </div>

      {edit ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: '10px 14px', border: '1px solid var(--accent)', background: 'rgba(59,130,246,.12)', borderRadius: 10, fontSize: 12 }}>
          <strong style={{ fontSize: 13 }}>배치 편집 중</strong>
          <span style={{ color: 'var(--text-dim)' }}>장비를 끌어 다른 자리 · 다른 랙에 놓으면 <strong style={{ color: 'var(--text)' }}>바로 저장</strong>됩니다(다른 사람이 먼저 바꿨으면 저장하지 않고 최신을 불러옵니다). 끌지 않고 옮기려면 장비를 눌러 ‘고치기’.</span>
          <span style={{ flex: 1 }} />
          {corpWritable ? <button type="button" style={btn} onClick={() => { setModalErr(''); setModal({ kind: 'site' }); }}>+ 데이터센터</button> : null}
          {siteId && corpWritable ? <button type="button" style={btn} onClick={() => { setModalErr(''); setModal({ kind: 'room' }); }}>+ 전산실</button> : null}
          {siteId && corpWritable ? <button type="button" style={btn} onClick={() => { setModalErr(''); setModal({ kind: 'site-edit' }); }}>데이터센터 이름 · 삭제</button> : null}
          {view && canEdit ? <button type="button" style={btn} onClick={() => { setModalErr(''); setModal({ kind: 'room-edit' }); }}>전산실 이름 · 삭제</button> : null}
          {view && canEdit ? <button type="button" style={btn} onClick={() => { setModalErr(''); setModal({ kind: 'rack', init: {} }); }}>+ 랙</button> : null}
          {view && canEdit && racks.length ? <button type="button" style={btn} onClick={() => { setModalErr(''); setModal({ kind: 'place', init: { rackId: racks[0].id, kind: 'other' } }); }}>+ 수동 장비</button> : null}
        </div>
      ) : null}

      {treeErr && tree ? <StaleBanner what="목록을" error={treeErr} onRetry={() => { loadTree(); loadRoom(roomIdRef.current); }} /> : null}
      {note ? (
        <div role={note.tone === 'err' ? 'alert' : 'status'} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 12px', borderRadius: 8, fontSize: 12,
          border: `1px solid ${note.tone === 'ok' ? 'var(--green)' : note.tone === 'warn' ? 'var(--amber)' : 'var(--red)'}`,
          background: note.tone === 'ok' ? 'rgba(34,197,94,.10)' : note.tone === 'warn' ? 'rgba(245,158,11,.12)' : 'rgba(239,68,68,.12)' }}>
          <span style={{ flex: 1, minWidth: 0 }}>{note.text}</span>
          <button type="button" style={{ ...btn, height: 26 }} onClick={() => setNote(null)}>닫기</button>
        </div>
      ) : null}

      {!corps.length ? (
        <div style={{ ...card, padding: 18, fontSize: 13, color: 'var(--text-dim)' }}>이 계정이 볼 수 있는 법인이 없습니다(법인에 할당된 vCenter 가 범위 안에 있어야 합니다).</div>
      ) : !sites.length || !rooms.length ? (
        <div style={{ ...card, padding: 18, display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
          <strong>{!sites.length ? `${corp?.name || ''} 에 등록된 데이터센터가 없습니다.` : '이 데이터센터에 전산실이 없습니다.'}</strong>
          <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{corpWritable ? '‘배치 편집’ 을 켜고 데이터센터 · 전산실 · 랙을 추가하세요.' : '관리자가 데이터센터 · 전산실 · 랙을 등록하면 여기에 실장도가 나옵니다.'}</span>
          {corpWritable ? <button type="button" style={btnPri} onClick={() => { setEdit(true); setModalErr(''); setModal({ kind: !sites.length ? 'site' : 'room' }); }}>{!sites.length ? '데이터센터 추가' : '전산실 추가'}</button> : null}
        </div>
      ) : viewErr && !view ? <ErrorBox error={viewErr} /> : !view ? <Loading label="전산실" /> : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 10 }}>
            <Tile k="랙" n={sum.racks} s={sum.heightsText || '—'} />
            <Tile k="사용 U" n={`${sum.usedU} / ${sum.totalU}U`} s={sum.usePct == null ? '—' : `${sum.usePct}% · 빈 자리 ${sum.freeU}U`} />
            <Tile k="배치된 장비" n={sum.devices} s={`서버 ${sum.servers} · 그 밖 ${sum.manual}`} />
            <Tile k="미배치 서버" n={sum.unplaced} s="iDRAC 등록 · 원장에 없음" color={sum.unplaced ? '#fcd34d' : undefined} />
            <Tile k="서버 장애 · 경고" n={`${sum.crit} · ${sum.warn}`} s={`못 읽음 ${sum.unknown} · 연결 안 됨 ${sum.nolink}`} color={sum.crit ? '#fca5a5' : undefined} />
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-start' }}>
            <div style={{ ...card, flex: '999 1 560px' }}>
              {loadingRoom ? <div style={{ padding: '6px 14px', fontSize: 11, color: 'var(--text-dim)' }}>불러오는 중…</div> : null}
              {viewErr ? <div style={{ padding: '6px 14px' }}><StaleBanner what="전산실을" error={viewErr} onRetry={() => loadRoom(roomIdRef.current)} /></div> : null}
              {!racks.length ? (
                <div style={{ padding: 18, fontSize: 13, color: 'var(--text-dim)' }}>이 전산실에 랙이 없습니다.{canEdit ? ' ‘배치 편집’ › ‘+ 랙’ 으로 추가하세요.' : ''}</div>
              ) : (
                <div style={{ display: 'flex', gap: 14, overflowX: 'auto', padding: 12, alignItems: 'flex-end' }}>
                  {racks.map((r) => (
                    <div key={r.id} style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '0 0 auto' }}>
                      <RackColumn rack={r} places={placesByRack.get(r.id) || []} mode={mode} face={face} q={q} selId={selId} onPick={setSelId}
                        edit={edit && canEdit} drag={{ ...drag, ...(dragInfo || {}) }} onDragOverRack={onDragOverRack} onDropRack={onDropRack} preview={preview} />
                      {edit && canEdit ? <button type="button" style={{ ...btn, height: 26, alignSelf: 'flex-start' }} onClick={() => { setModalErr(''); setModal({ kind: 'rack', init: r }); }}>랙 고치기</button> : null}
                    </div>
                  ))}
                </div>
              )}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, padding: '8px 14px', borderTop: '1px solid var(--border-soft)', fontSize: 11.5, color: '#aebbd0' }}>
                {legend.map((l) => <span key={l.k} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 18, height: 12, borderRadius: 3, background: l.bg, border: `1px solid ${l.bd}` }} />{l.label}</span>)}
                {face === 'rear' ? <span>후면 보기 — 회색 = 앞에서 꽂은 전체 깊이 장비의 뒷면</span> : null}
                <span>랙 옆 세로 띠 = 세로 PDU(A · B 계통 수 — 측정값 연결은 다음 차수)</span>
              </div>
            </div>

            <div style={{ flex: '1 1 300px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={card}>
                <Detail p={selected} rack={selRack} edit={edit && canEdit} onEdit={() => { setModalErr(''); setModal({ kind: 'place', init: { ...selected } }); }} />
              </div>
              <div style={card}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px' }}>
                  <strong>미배치 서버</strong><span style={{ color: 'var(--text-dim)' }}>{q.trim() ? `${unplacedHit.length} / ${view.unplacedTotal}` : view.unplacedTotal}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-dim)' }}>{edit && canEdit ? '랙으로 끌어 놓기' : 'iDRAC 등록 · 원장에 없음'}</span>
                </div>
                <div style={{ maxHeight: 360, overflowY: 'auto' }}>
                {unplacedHit.slice(0, unplacedShow).map((u) => (
                  <div key={u.serverId}
                    draggable={edit && canEdit}
                    onDragStart={edit && canEdit ? (e) => { try { e.dataTransfer.setData('text/plain', u.serverId); } catch { /* */ } setDragInfo({ type: 'server', size: 1, face: 'full', ...u }); } : undefined}
                    onDragEnd={edit && canEdit ? () => drag.end() : undefined}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderTop: '1px solid var(--border-soft)', minHeight: 44, boxSizing: 'border-box', cursor: edit && canEdit ? 'grab' : 'default' }}>
                    <span style={{ fontSize: 10, fontWeight: 700, border: '1px solid var(--border)', borderRadius: 5, padding: '1px 6px', color: '#c3cee0' }}>서버</span>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ ...mono, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{u.name || u.hostname || u.serverId}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{[u.model, u.serviceTag].filter(Boolean).join(' · ') || '—'}</div>
                    </div>
                    {edit && canEdit && racks.length ? <button type="button" style={{ ...btn, height: 26 }} onClick={() => { setModalErr(''); setModal({ kind: 'place', init: { rackId: racks[0].id, kind: 'server', label: u.name || '', model: u.model || '', serial: u.serviceTag || '' } }); }}>놓기</button> : null}
                  </div>
                ))}
                </div>
                {q.trim() && !unplacedHit.length && (view.unplaced || []).length ? <div style={{ padding: '8px 14px', fontSize: 12, color: 'var(--text-dim)', borderTop: '1px solid var(--border-soft)' }}>검색어와 맞는 미배치 서버가 없습니다.</div> : null}
                {unplacedHit.length > unplacedShow ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', padding: '8px 14px', fontSize: 11, color: 'var(--text-dim)', borderTop: '1px solid var(--border-soft)' }}>
                    <span style={{ flex: 1, minWidth: 0 }}>{unplacedShow}대를 보여 줍니다({unplacedHit.length - unplacedShow}대 더 있음) — 검색 칸에 이름 · 모델 · 서비스 태그를 넣어 좁힐 수 있습니다.</span>
                    <button type="button" style={{ ...btn, height: 26 }} onClick={() => setUnplacedShow((n) => n + UNPLACED_PAGE)}>더 보기</button>
                  </div>
                ) : null}
                {view.unplacedTotal > (view.unplaced || []).length ? <div style={{ padding: '8px 14px', fontSize: 11, color: 'var(--text-dim)', borderTop: '1px solid var(--border-soft)' }}>서버가 많아 앞 {(view.unplaced || []).length}대만 받았습니다(전체 {view.unplacedTotal}대) — 검색은 받은 목록 안에서만 됩니다.</div> : null}
                {view.serversNoTag ? <div style={{ padding: '8px 14px', fontSize: 11, color: 'var(--text-dim)', borderTop: '1px solid var(--border-soft)' }}>서비스 태그를 못 읽은 서버 {view.serversNoTag}대는 미배치로 셀 수 없어 뺐습니다.</div> : null}
              </div>
              <div style={card}>
                <div style={{ padding: '10px 14px', display: 'flex', gap: 8, alignItems: 'center' }}><strong>변경 이력</strong><span style={{ fontSize: 11, color: 'var(--text-dim)' }}>최근 {view.logs.length}건</span></div>
                {view.logs.length ? (
                  <ul style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: 300, overflowY: 'auto', borderTop: '1px solid var(--border-soft)' }}>
                    {view.logs.map((l, i) => (
                      <li key={`${l.ts}-${i}`} style={{ padding: '7px 14px', borderBottom: '1px solid var(--border-soft)', fontSize: 12, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                        <span style={{ display: 'flex', flexWrap: 'wrap', gap: '0 8px', color: 'var(--text-dim)', fontSize: 11 }}>
                          <span style={mono}>{new Date(l.ts).toLocaleString()}</span>
                          <span style={{ color: 'var(--text)', fontWeight: 600 }}>{ACTION_LABEL[l.action] || l.action}</span>
                          {l.user ? <span>{l.user}</span> : null}
                        </span>
                        <span style={{ overflowWrap: 'anywhere' }}>{l.detail}</span>
                      </li>
                    ))}
                  </ul>
                ) : <div style={{ padding: '0 14px 12px', fontSize: 12, color: 'var(--text-dim)' }}>아직 변경이 없습니다.</div>}
              </div>
            </div>
          </div>
        </>
      )}

      {modal?.kind === 'place' ? (
        <PlaceModal init={modal.init} racks={racks} busy={busy} error={modalErr} onClose={() => setModal(null)} onSave={savePlace}
          onRemove={async () => {
            if (!window.confirm(`‘${modal.init.label || modal.init.serial || '이름 없음'}’ 을(를) 랙에서 뺄까요? 판 기록에서 되돌릴 수 있습니다.`)) return;
            const r = await run({ op: 'place.remove', id: modal.init.id, rev: view.rev }, { okText: '장비를 뺐습니다.' }); if (r) setSelId(''); afterRoomWrite(r);
          }} />
      ) : null}
      {modal?.kind === 'rack' ? (
        <RackModal init={modal.init} types={types} busy={busy} error={modalErr} onClose={() => setModal(null)}
          onSave={async (f) => {
            const rack = { name: f.name, row: f.row, role: f.role, pduA: f.pduA, pduB: f.pduB, typeId: f.typeId, ...(f.typeId ? {} : { heightU: f.heightU }) };
            const r = modal.init.id ? await run({ op: 'rack.update', id: modal.init.id, rev: view.rev, rack }) : await run({ op: 'rack.add', roomId: view.room.id, rev: view.rev, rack }, { okText: '랙을 추가했습니다.' });
            afterRoomWrite(r);
          }}
          onRemove={async () => {
            if (!window.confirm(`랙 ‘${modal.init.name || ''}’ 을(를) 지울까요? 판 기록에서 되돌릴 수 있습니다.`)) return;
            afterRoomWrite(await run({ op: 'rack.remove', id: modal.init.id, rev: view.rev }, { okText: '랙을 지웠습니다.' }));
          }} />
      ) : null}
      {modal?.kind === 'site' ? (
        <NameModal title={`데이터센터 추가 — ${corp?.name || ''}`} busy={busy} error={modalErr} onClose={() => setModal(null)}
          onSave={async (name) => { const r = await run({ op: 'site.add', corpId, name }, { okText: '데이터센터를 추가했습니다.' }); if (r) { await loadTree(); setSiteId(r.id); } }} />
      ) : null}
      {modal?.kind === 'site-edit' ? (
        <NameModal title="데이터센터 이름 · 삭제" init={sites.find((s) => s.id === siteId)?.name || ''} busy={busy} error={modalErr} onClose={() => setModal(null)}
          onSave={async (name) => { if (await run({ op: 'site.rename', id: siteId, name })) await loadTree(); }}
          onRemove={async () => { if (!window.confirm('이 데이터센터를 지울까요? 판 기록에서 되돌릴 수 있습니다.')) return; if (await run({ op: 'site.remove', id: siteId }, { okText: '데이터센터를 지웠습니다.' })) await loadTree(); }} removeLabel="데이터센터 지우기(전산실이 없을 때만)" />
      ) : null}
      {modal?.kind === 'room' ? (
        <NameModal title="전산실 추가" busy={busy} error={modalErr} onClose={() => setModal(null)}
          onSave={async (name) => { const r = await run({ op: 'room.add', siteId, name }, { okText: '전산실을 추가했습니다.' }); if (r) { await loadTree(); setRoomId(r.id); } }} />
      ) : null}
      {modal?.kind === 'room-edit' ? (
        <NameModal title="전산실 이름 · 삭제" init={view?.room?.name || ''} busy={busy} error={modalErr} onClose={() => setModal(null)}
          onSave={async (name) => { if (await run({ op: 'room.rename', id: roomId, name })) { await loadTree(); await loadRoom(roomId); } }}
          onRemove={async () => { if (!window.confirm('이 전산실을 지울까요? 판 기록에서 되돌릴 수 있습니다.')) return; if (await run({ op: 'room.remove', id: roomId }, { okText: '전산실을 지웠습니다.' })) await loadTree(); }} removeLabel="전산실 지우기(랙이 없을 때만)" />
      ) : null}
      {modal?.kind === 'versions' ? (
        <VersionsModal corpId={corpId} corpName={corp?.name || corpId} onClose={() => setModal(null)}
          onRestored={async (text) => { setModal(null); say('ok', text); await loadTree(); await loadRoom(roomId); }} />
      ) : null}
      {modal?.kind === 'types' ? (
        <TypesModal types={types} busy={busy} error={modalErr} onClose={() => setModal(null)}
          onAdd={async (name, heightU) => { const r = await run({ op: 'type.add', name, heightU }, { okText: '랙 종류를 추가했습니다.', closeModal: false }); if (r) await loadTree(); return !!r; }}
          onRemove={async (id) => { if (!window.confirm(`랙 종류 ‘${types.find((t) => t.id === id)?.name || ''}’ 을(를) 지울까요?`)) return; if (await run({ op: 'type.remove', id }, { okText: '랙 종류를 지웠습니다.', closeModal: false })) await loadTree(); }} />
      ) : null}
    </div>
  );
}
