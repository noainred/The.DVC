// 특수 기능 › 메뉴 이름·설명·개발 단계 편집기(v2.679 — 사용자 제공 핸드오프 '특수 기능 화면 재구성' §4).
//
// 한 컴포넌트를 두 곳이 쓴다 — 특수 기능 화면의 오른쪽 드로어와 설정 › 특수 기능 카테고리(핸드오프 §5).
// 두 벌을 두면 한쪽만 고쳐지는 날이 온다.
//
// ⚠ 바꾸는 것은 **화면에 보이는 이름·설명·단계뿐**이다. 기능 키·링크(#/tools/키)·권한·사용 횟수는 키 기준 그대로다.
// 저장은 '완료' 한 번에 한다(입력마다 PUT 하지 않는다) — 실패하면 닫지 않고 오류를 보여준다.
import React, { useMemo, useState } from 'react';
import { sendJson } from '../api.js';
import { TOOLS } from './specialToolsList.js';
import { stagesOf, stageIdOf, removeStage, stageCounts, nextStageId, changedToolCount } from './toolSections.js';

const PALETTE_FALLBACK = ['#22c55e', '#22d3ee', '#f59e0b', '#a855f7', '#3b82f6', '#ef4444', '#8b9bb4'];

/** 편집 대상 — 상단 메뉴로 승격된 항목(topTab)은 카드가 없으므로 뺀다. */
const EDIT_TOOLS = TOOLS.filter((t) => !t.topTab);

export function StageDot({ color, size = 8 }) {
  return <i className="st-dot" style={{ width: size, height: size, background: color || 'var(--text-faint)' }} />;
}

export function StageBadge({ label, color }) {
  if (!label) return null;
  return (
    <span className="st-stage-badge" style={{ color: color || 'var(--text-dim)', background: color ? `${color}24` : 'var(--panel-2)' }}>
      <StageDot color={color} size={6} />{label}
    </span>
  );
}

/**
 * @param {{ settings:object, limits?:object, defaultStages?:object[], onSaved:(s:object)=>void, onClose?:()=>void, embedded?:boolean }} p
 */
export default function ToolNamesStages({ settings, limits = {}, defaultStages = [], onSaved, onClose, embedded = false }) {
  const palette = (limits.stageColors && limits.stageColors.length) ? limits.stageColors : PALETTE_FALLBACK;
  const maxStages = limits.maxStages || 12;
  const maxDesc = limits.maxDesc || 300;
  const maxLabel = limits.maxLabel || 40;
  const [tab, setTab] = useState('names');
  const [draft, setDraft] = useState(() => ({
    overrides: structuredClone(settings?.overrides || {}),
    stages: Array.isArray(settings?.stages) ? settings.stages.map((s) => ({ ...s })) : null,
    stageDisplay: settings?.stageDisplay === 'suffix' ? 'suffix' : 'badge',
  }));
  const [q, setQ] = useState('');
  const [chip, setChip] = useState('all');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');

  const stages = stagesOf(draft);
  const counts = useMemo(() => stageCounts(draft, EDIT_TOOLS.map((t) => t.k)), [draft]);
  const changedN = changedToolCount(draft);

  const setOverride = (k, patch) => setDraft((d) => {
    const cur = { ...(d.overrides[k] || {}), ...patch };
    for (const f of Object.keys(cur)) if (cur[f] == null || cur[f] === '') delete cur[f];
    const overrides = { ...d.overrides };
    if (Object.keys(cur).length) overrides[k] = cur; else delete overrides[k];
    return { ...d, overrides };
  });
  const resetRow = (k) => setDraft((d) => { const overrides = { ...d.overrides }; delete overrides[k]; return { ...d, overrides }; });

  const isChanged = (k) => {
    const o = draft.overrides[k];
    return !!(o && (o.label || o.desc || (stages && o.stage && o.stage !== stages[0].id)));
  };

  const ql = q.trim().toLowerCase();
  const rows = EDIT_TOOLS.filter((t) => {
    const o = draft.overrides[t.k] || {};
    if (ql && ![t.k, t.label, t.desc, o.label, o.desc].some((v) => String(v || '').toLowerCase().includes(ql))) return false;
    if (chip === 'changed') return !!(o.label || o.desc);
    if (chip !== 'all') return stageIdOf(draft, t.k) === chip;
    return true;
  });

  const updateStage = (id, patch) => setDraft((d) => ({ ...d, stages: d.stages.map((s) => (s.id === id ? { ...s, ...patch } : s)) }));
  const cycleColor = (s) => {
    const i = palette.indexOf(s.color);
    updateStage(s.id, { color: palette[(i + 1) % palette.length] });
  };
  const addStage = () => setDraft((d) => {
    const list = d.stages || [];
    if (list.length >= maxStages) return d;
    return { ...d, stages: [...list, { id: nextStageId(list), label: `새 단계 ${list.length + 1}`, color: palette[list.length % palette.length] }] };
  });
  const delStage = (id) => setDraft((d) => {
    const r = removeStage(d, id);
    return r.ok ? { ...d, stages: r.cfg.stages, overrides: r.cfg.overrides } : d;
  });
  const startStages = () => setDraft((d) => ({ ...d, stages: (defaultStages.length ? defaultStages : [{ id: 'prod', label: '운영', color: palette[0] }]).map((s) => ({ ...s })) }));
  const stopStages = () => setDraft((d) => ({ ...d, stages: null }));

  const resetAll = () => {
    if (!window.confirm('바꾼 이름·설명·단계 지정을 모두 지우고 기본값으로 되돌립니다. 계속할까요? (저장 버튼을 눌러야 반영됩니다)')) return;
    setDraft((d) => ({ ...d, overrides: {}, stages: d.stages ? (defaultStages.length ? defaultStages.map((s) => ({ ...s })) : d.stages) : null }));
  };

  const save = async () => {
    setBusy(true); setErr(''); setNote('');
    try {
      const r = await sendJson('/admin/tool-categories', 'PUT', { overrides: draft.overrides, stages: draft.stages, stageDisplay: draft.stageDisplay });
      if (!r || r.ok === false) { setErr(r?.reason || '저장하지 못했습니다.'); return; }
      const warn = (r.warnings || []).join(' ');
      setNote(warn);
      onSaved?.(r.settings);
      if (onClose && !warn) onClose();
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`st-editor${embedded ? ' st-editor-embedded' : ''}`}>
      <div className="st-editor-head">
        {!embedded && <div className="st-crumb">설정 › 특수 기능</div>}
        <div className="st-editor-title">메뉴 이름 · 설명 · 개발 단계</div>
        <div className="st-editor-note">
          메뉴 이름·설명·단계를 바꾸면 모든 사용자의 특수 기능 화면에 바로 반영됩니다. 기능 키와 링크(#/tools/키)는 바뀌지 않습니다.
          왼쪽 메뉴(V4·V5·V6)와 검색 팔레트에는 원래 이름이 그대로 보입니다.
        </div>
        <div className="st-seg st-editor-tabs">
          <button className={tab === 'names' ? 'on' : ''} onClick={() => setTab('names')}>기능 이름 · 단계</button>
          <button className={tab === 'stages' ? 'on' : ''} onClick={() => setTab('stages')}>개발 단계 목록</button>
        </div>
      </div>

      <div className="st-editor-body">
        {tab === 'names' && (
          <>
            <div className="st-editor-tools">
              <input className="st-input" placeholder="기능 찾기 — 이름·키·설명" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: '1 1 200px', minWidth: 0 }} />
              <div className="st-chips">
                <button className={`st-chip${chip === 'all' ? ' on' : ''}`} onClick={() => setChip('all')}>전체 <span className="st-n">{EDIT_TOOLS.length}</span></button>
                {(stages || []).map((s) => (
                  <button key={s.id} className={`st-chip${chip === s.id ? ' on' : ''}`} onClick={() => setChip(s.id)}>
                    <StageDot color={s.color} size={7} />{s.label} <span className="st-n">{counts[s.id] || 0}</span>
                  </button>
                ))}
                <button className={`st-chip${chip === 'changed' ? ' on' : ''}`} onClick={() => setChip('changed')}>이름·설명 바꾼 기능 <span className="st-n">{changedN}</span></button>
              </div>
            </div>
            <div className="st-name-grid st-name-head">
              <span>기능</span><span>표시 이름 · 설명</span><span>개발 단계</span><span />
            </div>
            {rows.length === 0 && <div className="st-empty">조건에 맞는 기능이 없습니다.</div>}
            {rows.map((t) => {
              const o = draft.overrides[t.k] || {};
              const sid = stageIdOf(draft, t.k);
              const sc = (stages || []).find((s) => s.id === sid)?.color;
              return (
                <div key={t.k} className={`st-name-grid st-name-row${isChanged(t.k) ? ' changed' : ''}`}>
                  <div className="st-name-tool">
                    <span className="st-ico st-ico-sm">{t.icon}</span>
                    <span style={{ minWidth: 0 }}>
                      <span className="st-ellipsis" style={{ fontWeight: 600 }}>{t.label}</span>
                      <span className="st-key">{t.k}</span>
                    </span>
                  </div>
                  <div className="st-name-edit">
                    <input className={`st-input${o.label ? ' has' : ''}`} value={o.label || ''} maxLength={maxLabel} placeholder={t.label}
                      onChange={(e) => setOverride(t.k, { label: e.target.value })} aria-label={`${t.k} 표시 이름`} />
                    <textarea className={`st-input st-textarea${o.desc ? ' has' : ''}`} rows={2} value={o.desc || ''} maxLength={maxDesc} placeholder={t.desc}
                      onChange={(e) => setOverride(t.k, { desc: e.target.value })} aria-label={`${t.k} 설명`} />
                  </div>
                  <div className="st-name-stage">
                    {stages ? (
                      <span className="st-select-wrap">
                        <StageDot color={sc} />
                        <select className="st-input" value={sid || ''} onChange={(e) => setOverride(t.k, { stage: e.target.value === stages[0].id ? '' : e.target.value })}>
                          {stages.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                        </select>
                      </span>
                    ) : <span className="st-faint">단계 안 씀</span>}
                  </div>
                  <div>
                    {isChanged(t.k) && <button className="st-icon-btn" title="이름·설명·단계를 원래대로" onClick={() => resetRow(t.k)}>↺</button>}
                  </div>
                </div>
              );
            })}
          </>
        )}

        {tab === 'stages' && (
          <>
            {!stages ? (
              <div className="st-stage-off">
                <div>개발 단계를 아직 쓰지 않습니다 — 지금은 모든 기능이 단계 없이 보입니다.</div>
                <div className="st-faint" style={{ marginTop: 6 }}>시작하면 운영 · 검증 중 · 개발중 · 준비 중 네 단계가 생기고, 모든 기능은 첫 단계(운영)로 시작합니다.</div>
                <button className="st-add" style={{ marginTop: 12 }} onClick={startStages}>개발 단계 사용 시작</button>
              </div>
            ) : (
              <>
                {stages.map((s, i) => {
                  const n = counts[s.id] || 0;
                  const first = i === 0;
                  return (
                    <div key={s.id} className="st-stage-row">
                      <button className="st-color" style={{ background: s.color }} title="눌러서 다음 색으로" onClick={() => cycleColor(s)} aria-label={`${s.label} 색 바꾸기`} />
                      <input className="st-input" value={s.label} maxLength={maxLabel} onChange={(e) => updateStage(s.id, { label: e.target.value })} aria-label="단계 이름" style={{ flex: '1 1 140px', minWidth: 0 }} />
                      <span className="st-faint st-nowrap">기능 {n}개</span>
                      <StageBadge label={s.label || s.id} color={s.color} />
                      <button className="st-icon-btn" disabled={first}
                        title={first ? '첫 단계는 기본값이라 지울 수 없습니다' : `삭제 — 기능 ${n}개는 '${stages[0].label}'(으)로 옮겨집니다`}
                        onClick={() => !first && delStage(s.id)}>✕</button>
                    </div>
                  );
                })}
                <button className="st-add" disabled={stages.length >= maxStages} onClick={addStage}
                  title={stages.length >= maxStages ? `단계는 최대 ${maxStages}개입니다` : ''}>+ 단계 추가</button>
                <div className="st-faint" style={{ marginTop: 12, lineHeight: 1.6 }}>
                  첫 단계가 기본값입니다 — 단계를 따로 고르지 않은 기능은 첫 단계로 보입니다. 단계를 지우면 그 단계의 기능은 첫 단계로 옮겨집니다.
                  개발 단계는 화면 표시용이고 접근 권한을 바꾸지 않습니다.
                </div>
                <div className="st-stage-opts">
                  <span className="st-faint">단계 표시 방식</span>
                  <div className="st-seg">
                    <button className={draft.stageDisplay === 'badge' ? 'on' : ''} onClick={() => setDraft((d) => ({ ...d, stageDisplay: 'badge' }))}>색 배지</button>
                    <button className={draft.stageDisplay === 'suffix' ? 'on' : ''} onClick={() => setDraft((d) => ({ ...d, stageDisplay: 'suffix' }))}>이름 뒤에 붙이기</button>
                  </div>
                  <button className="st-link-btn" onClick={stopStages}>개발 단계 사용 안 함</button>
                </div>
              </>
            )}
          </>
        )}
      </div>

      <div className="st-editor-foot">
        <span className="st-faint">이름·설명 바꾼 기능 {changedN}개 · 단계 {stages ? `${stages.length}개` : '안 씀'}</span>
        {err && <span className="st-err">{err}</span>}
        {note && <span className="st-warn">{note}</span>}
        <span style={{ flex: 1 }} />
        <button className="st-btn st-btn-danger" onClick={resetAll} disabled={busy}>기본값으로 되돌리기</button>
        {onClose && <button className="st-btn" onClick={onClose} disabled={busy}>취소</button>}
        <button className="st-btn st-btn-primary" onClick={save} disabled={busy}>{busy ? '저장 중…' : embedded ? '저장' : '완료'}</button>
      </div>
    </div>
  );
}

/** 오른쪽 드로어 — 뒤 화면 클릭·Esc 로 닫힌다. */
export function ToolNamesDrawer({ onClose, ...rest }) {
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="st-drawer-wrap" role="dialog" aria-modal="true" aria-label="메뉴 이름·단계 설정">
      <div className="st-drawer-back" onClick={onClose} />
      <div className="st-drawer"><ToolNamesStages {...rest} onClose={onClose} /></div>
    </div>
  );
}
