/**
 * Backup › Summary 도구 줄(v2.837 — 시안 ① '위 도구 줄도 Detail 과 같음 — 선택은 한 법인 안에서만').
 *   트리 표와 '백업 안 된 VM 찾기' 결과에서 고른 VM 에 백업 정책(5범주)을 저장하고, 백업 등록 화면(Veeam 백업 실행 · Bareos 대상 · Bareos 그룹)으로 넘긴다.
 *   저장은 Detail 과 같은 PUT /tools/backup-detail/marks(그 법인 — 서버가 역할 · 조회 범위 404 · 쓰기 범위 403 을 판정한다).
 *   화면의 쓰기 가능 여부는 서버가 법인 줄에 싣는 w(marksWritable 과 같은 판정)로만 정한다 — 버튼을 숨기는 것은 UX 일 뿐이다.
 */
import React, { useState } from 'react';
import { putJson, toolAllowed } from '../../api.js';
import { fmtNum, POLICIES } from './backupViewText.js';
import { saveHandoff } from './backupRunText.js';
import { saveBareosHandoff, HANDOFF_MAX as BAREOS_HANDOFF_MAX } from './bareosViewText.js';
import { saveBareosGroupHandoff } from './backupViewText.js';

/** 정책 아이콘(선 그림 — 색과 글자를 함께 쓴다 · Detail 의 아이콘과 같은 모양). 조기 return 없이 표로. */
const SHAPES = {
  veeam: <circle cx="8" cy="8" r="6" />,
  bareos: <rect x="2.5" y="2.5" width="11" height="11" rx="2" />,
  ssh: <path d="M3 4l4 4-4 4M8 12h5" />,
  none: <><circle cx="8" cy="8" r="6" /><path d="M4 12L12 4" /></>,
  check: <><circle cx="8" cy="8" r="6" /><path d="M6.3 6.5a1.7 1.7 0 1 1 2.4 1.6c-.5.3-.7.6-.7 1.1M8 11.3v.2" /></>,
};
const Icon = ({ k }) => <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{SHAPES[k] || SHAPES.check}</svg>;

export default function BackupSummaryBar({ sel, rows, onClear, onSaved }) {
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);   // { tone, text }
  const ids = [...(sel?.ids || [])];
  const n = ids.length;
  const site = (Array.isArray(rows) ? rows : []).find((r) => r.id === sel?.vc) || null;
  const writable = site?.w === true;
  const save = async (method, text) => {
    if (!n || !sel?.vc) return;
    setSaving(true); setMsg(null);
    try {
      // api.js putJson 은 400·403·409 본문(ok:false)을 돌려준다 — 그 사유를 성공으로 삼키지 않는다(v2.727 E-01 규약)
      const r = await putJson('/tools/backup-detail/marks', { vcenterId: sel.vc, vmIds: ids, method });
      if (r?.ok === false) setMsg({ tone: 'bad', text: r.reason || '저장하지 못했습니다.' });
      else { setMsg({ tone: 'ok', text: `${fmtNum(n)}대를 ${text} 으로 저장했습니다.` }); onSaved?.(); }
    } catch (e) { setMsg({ tone: 'bad', text: e?.status === 403 ? '이 법인은 수정 권한이 없습니다.' : String(e?.message || e).slice(0, 200) }); }
    finally { setSaving(false); }
  };
  const go = (fn, hash) => { fn(sel.vc, ids); window.location.hash = hash; };
  const over = n > BAREOS_HANDOFF_MAX ? `(앞 ${BAREOS_HANDOFF_MAX}대)` : '';

  return (
    <section className="card" aria-label="고른 VM 에 백업 정책 · 백업 등록" data-backup-sumbar="" style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0, fontSize: 12.5 }}>
      <div className="flex wrap" style={{ alignItems: 'center', gap: '6px 10px' }}>
        <b style={{ fontSize: 13 }}>{n ? `선택 ${fmtNum(n)}대` : '선택 없음'}</b>
        <span className="muted" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{n ? `법인 ${site?.name || sel.vc}` : '트리 표나 아래 찾기 결과에서 VM 을 고르세요 — 선택은 한 법인 안에서만'}</span>
        {n > 0 && <button type="button" className="tab" onClick={onClear} style={{ padding: '2px 10px', fontSize: 12 }}>선택 해제</button>}
        {msg && <span role="status" style={{ color: msg.tone === 'bad' ? '#fca5a5' : '#86efac', minWidth: 0, overflowWrap: 'anywhere' }}>{msg.text}</span>}
      </div>
      <div role="group" aria-label="백업 정책 적용" data-backup-policy-bar="" className="flex wrap" style={{ alignItems: 'center', gap: '6px 8px', padding: '7px 10px', border: '1px solid rgba(34,211,238,.45)', borderRadius: 10, background: 'rgba(34,211,238,.06)' }}>
        <b style={{ color: '#67e8f9' }}>백업 정책</b>
        <span className="muted">{!n ? 'VM 을 고른 뒤' : writable ? `고른 VM ${fmtNum(n)}대에 — 누르면 바로 저장` : '이 법인은 수정 권한이 없습니다(조회 전용)'}</span>
        {POLICIES.map((x) => (
          <button key={x.key} type="button" className="tab" disabled={!n || !writable || saving} onClick={() => save(x.key, x.text)} aria-label={`고른 VM 의 백업 정책을 ${x.text} 으로`}
            style={{ padding: '3px 10px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5, color: x.color, borderColor: x.color }}>
            <Icon k={x.key} />{x.text}
          </button>
        ))}
      </div>
      <div className="flex wrap" role="group" aria-label="백업 등록" data-backup-register="" style={{ alignItems: 'center', gap: '6px 10px' }}>
        <span className="muted" style={{ whiteSpace: 'nowrap' }}>백업 등록</span>
        {toolAllowed('backup-run') && <button type="button" className="tab" disabled={!n} onClick={() => go(saveHandoff, '#/tools/backup-run')} title="고른 VM 을 백업 실행 화면으로 가져갑니다 — 거기서 미리보기 · OTP 를 거쳐 실행합니다" style={{ padding: '3px 10px', fontSize: 12, color: '#86efac' }}>Veeam 백업 실행 →</button>}
        <button type="button" className="tab" disabled title="SSH 백업 기능은 아직 없습니다 — 지금은 백업 정책 값(SSH)만 정할 수 있습니다" style={{ padding: '3px 10px', fontSize: 12, color: '#93c5fd' }}>SSH 스크립트 등록(준비 중)</button>
        {toolAllowed('bareos-backup') && <button type="button" className="tab" disabled={!n} onClick={() => go(saveBareosHandoff, '#/tools/bareos-backup/targets')} title="고른 VM 을 Bareos 백업 대상 추가 창으로 가져갑니다 — 거기서 레벨을 고르고 등록합니다" style={{ padding: '3px 10px', fontSize: 12, color: '#fdba74' }}>Bareos 대상 등록{over} →</button>}
        {toolAllowed('bareos-backup') && <button type="button" className="tab" disabled={!n} onClick={() => go(saveBareosGroupHandoff, '#/tools/bareos-backup/groups')} title="고른 VM 으로 Bareos 백업 그룹을 만듭니다 — 그룹 창에서 이름 · 스케줄 · 보관 개수를 정하고 저장합니다" style={{ padding: '3px 10px', fontSize: 12, color: '#fdba74' }}>Bareos 그룹 등록{over} →</button>}
      </div>
    </section>
  );
}
