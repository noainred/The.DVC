/**
 * svcmon/TestWizard.jsx — 점검 추가/수정 마법사(1 카테고리 → 2 유형 → 3 파라미터)(v2.295,
 * 1차 감사 확정 #5). SvcMonitor.jsx 398~432행(로직)·1004~1157행(JSX)에서 이동.
 *
 * 원본과의 의도된 차이(그 외 본문 무변):
 *  - busy/err 를 **자체 상태로 완전 이관** — 원본은 셸의 busy/err 하나를 4개 저장 경로가
 *    공유해, 마법사만 분리하면 오류가 엉뚱한 모달에 표시되는 교차 누수가 났다(1차 감사
 *    MEDIUM 리스크의 완화책 그대로).
 *  - 닫기(setWiz(null)) → onClose, 저장 성공(setWiz(null)+refresh) → onSaved 콜백.
 *  - wizTpls 조회는 마운트 시 1회(원본 openWizard 의 신규 추가 분기와 동일 — 수정 모드는 불필요).
 * props: { targetId, targetName, test(수정 대상 점검 | null=추가), onClose, onSaved }
 * ⚠ 이 컴포넌트는 마운트 = 열림이다(셸이 wizFor 상태로 조건 렌더) — 훅이 조건 없이 최상단에
 *   있어야 하는 이유(React #310, CLAUDE.md).
 */
import React, { useEffect, useState } from 'react';
import { fetchJson, postJson, putJson } from '../../api.js';
import { ADD_MENU, ADD_MENU_PLANNED, METHOD, TYPE_META, EMPTY_TEST } from './constants.js';

export function TestWizard({ targetId, targetName, test = null, onClose, onSaved }) {
  // 초기 상태 — 원본 openWizard(398~409행)와 동일 규칙(수정 모드면 3단계로 직행).
  const [wiz, setWiz] = useState(() => {
    if (test) {
      const cat = ADD_MENU.findIndex((g) => g.items.some((i) => i.type === test.type));
      return { targetId, targetName, step: 3, cat: cat < 0 ? 0 : cat, type: test.type, editId: test.id,
        form: { ...EMPTY_TEST, ...test }, mode: 'single', tplId: '' };
    }
    return { targetId, targetName, step: 1, cat: -1, type: '', editId: null, form: { ...EMPTY_TEST }, mode: 'single', tplId: '' };
  });
  const [wizTpls, setWizTpls] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    // '템플릿으로 추가'용 목록 — 마법사를 열 때 최신으로 읽는다(신규 추가 모드만, 원본과 동일).
    if (!test) fetchJson('/svcmon/templates').then((r) => setWizTpls(r.templates || [])).catch(() => setWizTpls([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 선택한 템플릿을 이 대상 하나에 적용(scope.targetIds). 여러 점검을 한 번에 추가한다.
  const applyTplToTarget = async () => {
    if (!wiz?.tplId) return;
    setBusy(true); setErr('');
    try {
      const r = await postJson(`/svcmon/templates/${wiz.tplId}/apply`, { scope: { targetIds: [wiz.targetId] }, mode: 'apply' });
      if (r?.error) { setErr(r.error); return; }
      if ((r?.summary?.error || 0) > 0) { setErr(`오류 ${r.summary.error}건으로 적용하지 않았습니다.`); return; }
      onSaved();
    } catch (e) { setErr(e.message || String(e)); } finally { setBusy(false); }
  };
  const wizSave = async () => {
    setBusy(true); setErr('');
    try {
      const f = wiz.form;
      const body = { ...f, type: wiz.type, intervalSec: Number(f.intervalSec) || 60 };
      // 빈 문자열은 서버가 '미지정'으로 보게 제거한다(포트 0 → 1 클램프 같은 사고 방지).
      for (const k of Object.keys(body)) if (body[k] === '') delete body[k];
      if (wiz.editId) await putJson(`/svcmon/targets/${wiz.targetId}/tests/${wiz.editId}`, body);
      else await postJson(`/svcmon/targets/${wiz.targetId}/tests`, body);
      onSaved();
    } catch (e) { setErr(e.message || String(e)); } finally { setBusy(false); }
  };

  return (
        <div className="pc-overlay" onClick={onClose}>
          <div className="pc-modal pc-wiz" onClick={(e) => e.stopPropagation()}>
            <div className="pc-modal-head">
              <b>{wiz.editId ? '점검 수정' : '점검 추가'}</b>
              <span className="pc-wiz-target">{wiz.targetName}</span>
              <button className="pc-x" onClick={onClose}>✕</button>
            </div>

            {/* 추가 방식 선택 — 템플릿(여러 점검 한 번에) vs 개별 점검(3단계). 수정 모드엔 없음. */}
            {!wiz.editId && (
              <div className="pc-steps" style={{ gap: 8 }}>
                {[['single', '＋ 개별 점검 추가'], ['template', '📋 템플릿으로 추가']].map(([m, label]) => (
                  <button key={m} className={`pc-step ${wiz.mode === m ? 'on' : ''}`} onClick={() => { setWiz({ ...wiz, mode: m }); setErr(''); }}>{label}</button>
                ))}
              </div>
            )}

            {/* 진행 표시 — 완료 단계는 클릭해 되돌아갈 수 있다 (개별 점검 모드에서만) */}
            {wiz.mode !== 'template' && (
            <div className="pc-steps">
              {['카테고리', '점검 유형', '설정'].map((label, i) => {
                const n = i + 1;
                const state = wiz.step === n ? 'on' : (wiz.step > n ? 'done' : '');
                return (
                  <button key={label} className={`pc-step ${state}`} disabled={wiz.step <= n}
                    onClick={() => setWiz({ ...wiz, step: n })}>
                    <span className="pc-step-no">{wiz.step > n ? '✓' : n}</span>{label}
                  </button>
                );
              })}
              <span className="pc-step-count">{wiz.step} / 3</span>
            </div>
            )}

            <div className="pc-wiz-body">
              {wiz.mode === 'template' && !wiz.editId && (
                <>
                  <div className="pc-wiz-lead">이 대상에 적용할 점검 템플릿을 고르세요 — 템플릿의 점검들이 한 번에 추가됩니다.</div>
                  <div className="pc-wiz-form">
                    <label>점검 템플릿
                      <select className="pc-input" value={wiz.tplId} autoFocus onChange={(e) => setWiz({ ...wiz, tplId: e.target.value })}>
                        <option value="">(템플릿 선택)</option>
                        {wizTpls.map((t) => <option key={t.id} value={t.id}>{t.name} — 항목 {(t.items || []).length}개</option>)}
                      </select>
                    </label>
                    {(() => {
                      const t = wizTpls.find((x) => x.id === wiz.tplId);
                      if (!t) return <span className="pc-fhint">템플릿을 고르면 포함된 점검이 여기 표시됩니다. (템플릿 정의·수정은 ‘Monitoring 설정 › 점검 템플릿’)</span>;
                      return <span className="pc-fhint">{(t.items || []).map((x) => `${x.type}${x.port ? `:${x.port}` : ''}`).join(', ') || '항목 없음'} · 점검 {(t.items || []).length}개가 이 대상에 추가됩니다.</span>;
                    })()}
                  </div>
                  {err && <div className="pc-err">{err}</div>}
                </>
              )}
              {wiz.mode !== 'template' && wiz.step === 1 && (
                <>
                  <div className="pc-wiz-lead">무엇을 점검할지 분류를 고르세요.</div>
                  <div className="pc-wiz-grid">
                    {ADD_MENU.map((g, gi) => (
                      <button key={g.label} className={`pc-wiz-card${wiz.cat === gi ? ' sel' : ''}`}
                        onClick={() => setWiz({ ...wiz, cat: gi, step: 2 })}>
                        <b>{g.label}</b>
                        <span>{g.items.map((i) => i.label.split(' (')[0]).join(' · ')}</span>
                      </button>
                    ))}
                  </div>
                  <div className="pc-wiz-planned">
                    <div className="pc-ctx-cap">다음 단계 예정 (엔진 개발 후 선택 가능)</div>
                    {ADD_MENU_PLANNED.map((t) => <span key={t} className="pc-plan-tag">{t}</span>)}
                  </div>
                </>
              )}

              {wiz.step === 2 && (
                <>
                  <div className="pc-wiz-lead">{ADD_MENU[wiz.cat]?.label} — 점검 유형을 고르세요.</div>
                  <div className="pc-wiz-grid">
                    {(ADD_MENU[wiz.cat]?.items || []).map((it) => (
                      <button key={it.type} className={`pc-wiz-card${wiz.type === it.type ? ' sel' : ''}`}
                        onClick={() => setWiz({
                          ...wiz, type: it.type, step: 3,
                          form: { ...wiz.form, name: wiz.form.name || it.label.split(' (')[0] },
                        })}>
                        <b>{it.label}</b>
                        <span>{TYPE_META[it.type]?.desc || METHOD[it.type]}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}

              {wiz.step === 3 && (
                <>
                  <div className="pc-wiz-lead">
                    <b>{METHOD[wiz.type] || wiz.type}</b> — {TYPE_META[wiz.type]?.desc}
                  </div>
                  <div className="pc-wiz-form">
                    <label>점검 이름<input className="pc-input" value={wiz.form.name || ''} autoFocus
                      onChange={(e) => setWiz({ ...wiz, form: { ...wiz.form, name: e.target.value } })}
                      placeholder="2. Ping: 192.168.10.55" /></label>
                    {(TYPE_META[wiz.type]?.fields || []).map((f) => (
                      <label key={f.key}>{f.label}{f.req && <em> *</em>}
                        {f.area
                          ? <textarea className="pc-input" rows={3} value={wiz.form[f.key] || ''}
                              onChange={(e) => setWiz({ ...wiz, form: { ...wiz.form, [f.key]: e.target.value } })}
                              placeholder={f.ph || ''} />
                          : <input className="pc-input" value={wiz.form[f.key] || ''}
                              onChange={(e) => setWiz({ ...wiz, form: { ...wiz.form, [f.key]: e.target.value } })}
                              placeholder={f.ph || ''} />}
                        {f.hint && <span className="pc-fhint">{f.hint}</span>}
                      </label>
                    ))}
                    <label>점검 주기(초)<input className="pc-input" value={wiz.form.intervalSec}
                      onChange={(e) => setWiz({ ...wiz, form: { ...wiz.form, intervalSec: e.target.value } })} />
                      <span className="pc-fhint">최소 10초. 항목이 많으면 주기를 늘리는 것이 서버 부하에 직접 영향.</span></label>
                    {wiz.type === 'http' && (
                      <label className="pc-check">
                        <input type="checkbox" checked={!!wiz.form.insecure}
                          onChange={(e) => setWiz({ ...wiz, form: { ...wiz.form, insecure: e.target.checked } })} />
                        자체서명 인증서 허용(이 점검에만 적용)
                      </label>
                    )}
                  </div>
                  {err && <div className="pc-err">{err}</div>}
                </>
              )}
            </div>

            <div className="pc-wiz-foot">
              {wiz.mode === 'template' && !wiz.editId ? (
                <>
                  <span className="pc-wiz-crumb">템플릿의 점검들을 이 대상에 한 번에 추가</span>
                  <button className="pc-btn accent" disabled={busy || !wiz.tplId}
                    onClick={applyTplToTarget}>{busy ? '적용 중…' : '템플릿 적용'}</button>
                </>
              ) : (
                <>
                  <button className="pc-btn" disabled={wiz.step === 1}
                    onClick={() => setWiz({ ...wiz, step: wiz.step - 1 })}>← 뒤로</button>
                  <span className="pc-wiz-crumb">
                    {wiz.cat >= 0 && ADD_MENU[wiz.cat]?.label}{wiz.type && ` › ${wiz.type}`}
                  </span>
                  {wiz.step < 3
                    ? <button className="pc-btn accent" disabled={wiz.step === 1 ? wiz.cat < 0 : !wiz.type}
                        onClick={() => setWiz({ ...wiz, step: wiz.step + 1 })}>다음 →</button>
                    : <button className="pc-btn accent" disabled={busy || !wiz.form.name}
                        onClick={wizSave}>{busy ? '저장 중…' : (wiz.editId ? '수정 저장' : '점검 추가')}</button>}
                </>
              )}
            </div>
          </div>
        </div>
  );
}
