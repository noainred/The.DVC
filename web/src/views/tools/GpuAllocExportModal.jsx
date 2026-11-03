/**
 * GpuAllocExportModal — GPU 할당 계층 '엑셀로 내보내기' 창(v2.855 — 승인 시안 https://claude.ai/artifact/GQKnG775UijSAU7aUSFFeB
 *   '계층 표 엑셀 내보내기' · 사용자 요청 "만들어줘").
 *
 * v2.869(승인 시안 https://claude.ai/artifact/6LcrjcPjNw5n5jinDCHppa · docs/design/gpu-alloc-corp-sheets):
 *   · 창은 화면의 법인 선택과 무관하게 **모든 법인을 고른 채** 시작한다(사용자 지시 "엑셀 export 할때 기본적으로 모든 vcenter 를 선택").
 *     창 안 법인 칩으로 줄이고, '화면 선택대로' 로 화면 칩 선택을 가져온다. 범위 계정은 자기 범위의 법인만 칩으로 보인다(서버가 조회 범위를 먼저 자른다).
 *   · 시트에 '법인별 시트'(목차 + 법인마다 계층 표 한 장 — 기본 켬). 시트 이름은 서버 export-meta 가 엑셀과 같은 함수로 준다.
 * 화면이 특정 법인 하나(scope)로 열려 있으면 그 범위 그대로다(칩을 보이지 않는다).
 * 범위 글자 · 호스트·GPU 수 · 파일 이름은 서버 /tools/gpu-alloc/export-meta 가 준다(내려받기와 같은 함수 — 이름을 화면에서 지어내지 않는다).
 * 실패(409 동시 내보내기 · 403 · 400)는 파일로 저장하지 않고 창 안에 말한다(downloadFailText).
 */
import React, { useEffect, useState } from 'react';
import { useLatest } from '../../hooks/useLatest.js';
import { fetchJson, downloadFile, canCsv } from '../../api.js';
import { downloadFailText } from '../downloadFailText.js';
import { Modal, ErrorBox } from '../../components/ui.jsx';
import { EXPORT_DEPTHS, EXPORT_SHEETS, allocExportQuery, exportPick, exportFileName } from './gpuAllocText.js';

const FORMATS = [
  '맨 위 요약 칸(전체 · 할당 · 예비 · 할당률 · 꺼진 VM) — 법인 시트는 그 법인 값',
  '머리글 고정 · 평면 표 자동 필터 · 목차 ↔ 법인 시트 링크',
  '단계별 색 띠 · 할당률 막대(90% 이상 주황) · 법인 시트 탭 색(90% 이상 주황)',
  '숫자는 숫자 서식 — 합계·피벗을 바로 낼 수 있음',
  '인쇄: A4 가로 한 쪽 너비 맞춤 · 머리글 반복',
];

export function GpuAllocExportModal({ scope = '', vcSel = null, chips = [], onClose }) {
  const run = useLatest();
  const [meta, setMeta] = useState(null);
  const [metaErr, setMetaErr] = useState(null);
  const [depth, setDepth] = useState('vm');
  const [sheets, setSheets] = useState(() => EXPORT_SHEETS.map((s) => s.key));
  // null = 모든 법인(기본). 칩 목록이 늦게 와도 '모두' 가 유지된다.
  const [sel, setSel] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const showCorps = !scope && chips.length > 0;
  const pick = scope ? null : exportPick(sel, chips);
  const noneSel = !!pick && pick.size === 0;
  const rangeQ = allocExportQuery({ scope, vcSel: pick });
  // 파일 내보내기는 data.csv 권한(v2.643 — 소스 스윕 csvGate2643 가 이 파일에도 요구한다). 부모도 막지만 창 스스로 한 번 더 막는다.
  const allowed = canCsv();
  useEffect(() => {
    if (!allowed) return;
    setMeta(null); setMetaErr(null);
    if (noneSel) return;   // 고른 법인이 없으면 묻지 않는다(빈 vcenterIds 는 '전체' 로 읽히므로 보내지 않는다)
    run(fetchJson(`/tools/gpu-alloc/export-meta${rangeQ}`), setMeta, setMetaErr);
  }, [rangeQ, run, allowed, noneSel]);
  const toggleSheet = (k) => setSheets((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));
  const isOn = (id) => sel == null || sel.has(id);
  const toggleCorp = (id) => setSel((prev) => {
    const n = new Set(prev == null ? chips.map((c) => c.id) : prev);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const fromScreen = () => setSel(vcSel && vcSel.size ? new Set(vcSel) : null);
  const noSheet = sheets.length === 0;
  const percorp = sheets.includes('corp');
  const fileName = exportFileName(meta, depth, percorp);
  const cs = meta?.corpSheets || null;
  const nSheets = sheets.filter((k) => k !== 'corp').length + (percorp && cs ? 1 + cs.sheets.length : 0);
  const download = async () => {
    setMsg(''); setBusy(true);
    try { await downloadFile(`/tools/gpu-alloc.xlsx${allocExportQuery({ scope, vcSel: pick, depth, sheets })}`); onClose?.(); }
    catch (e) { setMsg(downloadFailText(e)); }
    finally { setBusy(false); }
  };
  if (!allowed) return null;   // 훅 아래 — 조기 return 이 훅 개수를 바꾸지 않게
  const picked = chips.filter((c) => isOn(c.id));
  return (
    <Modal title="계층 표 엑셀로 내보내기" onClose={onClose} width={600}>
      <div className="gpu-alloc-export">
        {showCorps ? (
          <section className="card gpu-alloc-export-sec" data-gpu-alloc-export-corps="">
            <div className="flex gap wrap" style={{ alignItems: 'center' }}>
              <span className="muted lbl">법인(vCenter)</span>
              <span className="gpu-alloc-export-badge">기본 — 모두 선택</span>
              <span className="flex gap wrap" style={{ marginLeft: 'auto', gap: 6 }}>
                <button type="button" className="qn-btn" onClick={() => setSel(null)} title="범위 안 법인을 모두 넣습니다.">모두</button>
                <button type="button" className="qn-btn" onClick={() => setSel(new Set())}>모두 해제</button>
                <button type="button" className="qn-btn" onClick={fromScreen} title={vcSel && vcSel.size ? `화면에서 고른 법인 ${vcSel.size}곳을 가져옵니다.` : '화면에서 고른 법인이 없어 모든 법인이 됩니다.'}>화면 선택대로</button>
              </span>
            </div>
            <div className="flex gap wrap gpu-alloc-export-corps" role="group" aria-label="넣을 법인">
              {chips.map((c) => {
                const on = isOn(c.id);
                return (
                  <button key={c.id} type="button" className={`qn-btn${on ? ' on' : ''}${c.hosts === 0 ? ' down' : ''}`} aria-pressed={on} onClick={() => toggleCorp(c.id)}
                    title={`${c.name} — GPU 호스트 ${c.hosts}대 · GPU ${c.gpus}장${c.hosts === 0 ? '(시트 없이 목차에만)' : ''}`}>
                    <span className="qn-dot" style={{ background: c.hosts ? 'var(--green)' : 'var(--text-faint)' }} />{c.id}
                  </button>
                );
              })}
            </div>
            <div className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
              {noneSel ? '고른 법인 없음' : metaErr ? '—' : meta ? <b style={{ color: 'var(--text)' }}>{sel == null ? `모든 법인 ${meta.corpSheets?.corps ?? chips.length}곳` : `법인 ${picked.length}곳`} · 호스트 {meta.hosts}대 · GPU {meta.gpus}장</b> : '불러오는 중…'}
              {' '}— 화면에서 법인을 골라 두었어도 이 창은 모든 법인으로 시작합니다.
            </div>
            {noneSel && <div className="gpu-alloc-export-warn">법인을 하나 이상 고르세요.</div>}
          </section>
        ) : (
          <div className="muted" style={{ fontSize: 13, lineHeight: 1.6 }}>
            범위: {metaErr ? <span>—</span> : meta ? <b style={{ color: 'var(--text)' }}>{meta.scopeText} · 호스트 {meta.hosts}대 · GPU {meta.gpus}장</b> : '불러오는 중…'}
          </div>
        )}
        {metaErr && <ErrorBox error={metaErr} />}

        <section className="card gpu-alloc-export-sec">
          <div className="muted lbl">행을 어디까지 넣을까요</div>
          <div className="flex gap wrap" role="group" aria-label="넣을 단계">
            {EXPORT_DEPTHS.map((d) => (
              <button key={d.key} type="button" className={`qn-btn${depth === d.key ? ' on' : ''}`} aria-pressed={depth === d.key} onClick={() => setDepth(d.key)}>{d.label}</button>
            ))}
          </div>
          <div className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>고른 단계까지 계층 표 행을 만들고 엑셀의 <b>행 그룹(개요)</b>으로 묶습니다. 파일을 연 뒤 왼쪽 위 숫자 단추로 접고 펼 수 있습니다. <b>법인별 시트에도 같은 단계</b>가 적용됩니다. 평면 표는 단계와 무관하게 GPU·VM 한 줄씩입니다.</div>
        </section>

        <section className="card gpu-alloc-export-sec">
          <div className="muted lbl">시트</div>
          {EXPORT_SHEETS.map((s) => (
            <label key={s.key} className="gpu-alloc-export-chk">
              <input type="checkbox" checked={sheets.includes(s.key)} onChange={() => toggleSheet(s.key)} />
              <span><b>{s.label}</b> <span className="muted">— {s.sub}</span></span>
            </label>
          ))}
          {percorp && cs && !noneSel && (
            <div className="gpu-alloc-export-corpbox" data-gpu-alloc-corp-sheets="">
              <div>고른 법인 {cs.corps}곳 가운데 GPU 호스트가 있는 {cs.withGpu}곳 → <b>시트 {cs.sheets.length}장</b>{cs.corps - cs.withGpu > 0 ? `. 없는 ${cs.corps - cs.withGpu}곳은 목차에만 적습니다(빈 시트를 만들지 않음).` : '.'}{cs.withGpu > cs.sheets.length ? ` 시트 상한을 넘은 ${cs.withGpu - cs.sheets.length}곳은 목차에만 있습니다.` : ''}</div>
              {cs.sheets.length > 0 && (
                <div className="flex gap wrap" style={{ gap: 6 }}>
                  {cs.sheets.map((x) => <span key={x.id} className={`gpu-alloc-export-sheet${x.renamed ? ' renamed' : ''}`} title={x.renamed ? `원래 이름 ${x.name} — 엑셀 시트 이름 제한(31자 · 일부 기호 금지)에 맞춰 바꿈` : x.name}>{x.sheet}</span>)}
                </div>
              )}
              {cs.sheets.some((x) => x.renamed) && <div className="muted">주황은 엑셀 시트 이름 제한(31자 · 일부 기호 금지)에 맞춰 바꾼 이름입니다 — 원래 이름은 목차와 시트 첫 줄에 있습니다.</div>}
            </div>
          )}
          {noSheet && <div className="gpu-alloc-export-warn">시트를 하나 이상 고르세요.</div>}
        </section>

        <section className="card gpu-alloc-export-sec">
          <div className="muted lbl">파일에 들어가는 서식</div>
          <ul className="gpu-alloc-export-list">{FORMATS.map((f) => <li key={f}>{f}</li>)}</ul>
        </section>

        <div className="flex gap wrap" style={{ alignItems: 'baseline' }}>
          <div className="gpu-alloc-export-file" title="내려받을 파일 이름" style={{ flex: '1 1 260px', minWidth: 0 }}>{noneSel ? '—' : fileName || '—'}</div>
          {meta && !noneSel && !noSheet && <span className="muted" style={{ fontSize: 12 }}>시트 {nSheets}장</span>}
        </div>
        {msg && <div className="error-box">{msg}</div>}
        <div className="flex gap wrap" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="logout-btn" style={{ flex: 'none', padding: '8px 14px' }} onClick={onClose}>닫기</button>
          <button type="button" className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} disabled={busy || noSheet || noneSel || !!metaErr} onClick={download}>{busy ? '만드는 중…' : '⬇ 엑셀 내려받기'}</button>
        </div>
      </div>
    </Modal>
  );
}

export default GpuAllocExportModal;
