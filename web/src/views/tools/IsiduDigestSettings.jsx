/**
 * 설정 › 수집 서버 › 아이실론 디렉터리 사용량 › **종합 메일** 탭(v2.742) — Claude Design 시안 ② '종합 메일 설정'.
 *
 * 사용자 요청: 전 법인 결과를 모아 정한 요일·시각에 한 통으로 보낸다. 선택: 시안 그대로 · 전체 검증.
 *  · 저장은 종합 메일 설정만 바꾼다(`PUT /tools/isilon-dirusage/digest` — 대상 목록 저장과 서로 지우지 않는다).
 *  · 형식 판정은 서버가 한다(400 이 칸을 짚는다) — 이 화면은 입력 중 미리 알려 줄 뿐이다(`isiduDigestText.formIssues`).
 *  · 설정 파일을 읽지 못했으면 편집을 잠근다(조회 실패 → 저장 = 데이터 소거 경로 — v2.618 WEB-2).
 *  · '지금 한 번 보내기' 는 **저장된** 설정으로 보낸다 — 바뀐 칸이 있으면 먼저 저장하라고 말하고 버튼을 잠근다.
 *  · 미리보기는 저장하지 않은 화면 값으로 만든다(서버가 보내지 않고 본문만 돌려준다). 본문은 스크립트가 없는 메일 HTML 이라
 *    `sandbox` iframe(srcDoc) 에 그린다 — 스크립트·폼·링크 이동을 막는다.
 *  · 폴링하지 않는다(설정 화면이다). 저장·보내기 뒤에만 다시 읽는다.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchJson, postJson, putJson } from '../../api.js';
import { Loading, ErrorBox, Modal } from '../../components/ui.jsx';
import Select from '../../components/Select.jsx';
import { requireChanged } from '../changeResult.js';
import {
  DAY_LABELS, DAY_ORDER, DAY_PRESETS, HOURS, TOPN_CHOICES, formFromDigest, digestBody, minuteChoices, toggleDay, presetActive,
  recipientsOf, formIssues, nextSlots, slotText, untilText, scheduleText, historyLine, sendResultText, mailReadyNote,
} from './isiduDigestText.js';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export default function IsiduDigestSettings({ locked: lockedOuter = false }) {
  const [srv, setSrv] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [form, setForm] = useState(null);
  const [saved, setSaved] = useState(null);     // 저장된 값의 폼(바뀐 칸 판정)
  const [bad, setBad] = useState(null);          // 서버 400 의 field
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState('');          // 'save' | 'send' | 'preview'
  const [preview, setPreview] = useState(null);  // { subject, html, recipients, targets, demoIncluded }
  const [now, setNow] = useState(() => Date.now());

  const apply = useCallback((d) => {
    setSrv(d);
    const f = formFromDigest(d.digest);
    setForm(f); setSaved(f); setBad(null);
  }, []);
  const load = useCallback(() => {
    let alive = true;
    fetchJson('/tools/isilon-dirusage/digest').then((d) => { if (alive) { apply(d); setLoadErr(null); setNow(Date.now()); } }, (e) => { if (alive) setLoadErr(e); });
    return () => { alive = false; };
  }, [apply]);
  useEffect(() => load(), [load]);

  const off = srv?.offsetMin ?? 540;
  const adminTo = useMemo(() => srv?.adminTo || [], [srv]);
  const locked = lockedOuter || !srv || !!srv.loadError;
  const dirty = !!form && !!saved && !same(form, saved);
  const rc = form ? recipientsOf(form, adminTo) : null;
  const issues = form ? formIssues(form, adminTo) : {};
  const slots = form ? nextSlots(form, now, 3, off) : [];
  const hasIssue = !!(issues.days || issues.to);

  if (loadErr && !srv) return <ErrorBox error={loadErr} />;
  if (!srv || !form) return <Loading />;

  const set = (patch) => { setForm((f) => ({ ...f, ...patch })); setBad(null); setMsg(null); };
  const badField = (k) => bad === k;

  const save = async () => {
    setBusy('save'); setMsg(null);
    try {
      const r = requireChanged(await putJson('/tools/isilon-dirusage/digest', { digest: digestBody(form) }));
      apply(r); setNow(Date.now());
      setMsg({ tone: 'ok', text: r.digest?.enabled ? `저장했습니다 — ${scheduleText(r.digest.days, r.digest.time)}(KST)에 보냅니다.` : '저장했습니다 — 종합 메일은 꺼져 있습니다.' });
    } catch (e) {
      setBad(e?.body?.field || null);
      setMsg({ tone: 'bad', text: e?.message || String(e) });
    } finally { setBusy(''); }
  };

  const sendNow = async () => {
    if (!window.confirm('저장된 설정으로 종합 메일을 지금 한 통 보낼까요? 정기 발송 일정은 바뀌지 않습니다.')) return;
    setBusy('send'); setMsg(null);
    try {
      const r = await postJson('/tools/isilon-dirusage/digest/send-now', {});
      setMsg(sendResultText(r));
      load();
    } catch (e) { setMsg({ tone: 'bad', text: e?.message || String(e) }); } finally { setBusy(''); }
  };

  const openPreview = async () => {
    setBusy('preview'); setMsg(null);
    try {
      const r = requireChanged(await postJson('/tools/isilon-dirusage/digest/preview', { digest: digestBody(form) }));
      setPreview(r);
    } catch (e) {
      setBad(e?.body?.field || null);
      setMsg({ tone: 'bad', text: e?.message || String(e) });
    } finally { setBusy(''); }
  };

  const st = srv.status || {};
  const hist = Array.isArray(st.history) ? st.history : [];
  const ready = mailReadyNote(srv.mailReady);
  const mins = minuteChoices(form.minute);

  return (
    <div className="isd-digest">
      {srv.loadError ? <div className="result bad">저장된 설정 파일을 읽지 못했습니다 — 편집을 잠갔습니다. 설정 › 서비스 점검에서 기본값으로 확정하거나 손상 보존본을 복구하세요.</div> : null}
      {st.edge ? <div className="result warn">이 포탈은 엣지입니다 — 종합 메일은 메인(중앙) 포탈만 보냅니다. 여기서 저장해도 이 포탈은 보내지 않습니다.</div> : null}
      {ready ? <div className="result warn">{ready}</div> : null}

      <div className="isd-digest-grid">
        <div className="isd-digest-main">
          <div className="hint" style={{ fontSize: 12.5 }}>등록된 모든 법인의 디렉터리 사용량을 한 통으로 모아 정한 요일·시각에 보냅니다. 법인별 결과 메일(대상마다 조사가 끝날 때 보냄)과는 따로 동작합니다.</div>

          <label className="isd-switch">
            <input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} disabled={locked} />
            <span><b>종합 메일 보내기</b> <span className={`isd-tag ${form.enabled ? 'ok' : 'muted'}`}>{form.enabled ? '켜짐' : '꺼짐'}</span></span>
          </label>

          <fieldset disabled={locked}>
            <legend>발송 요일</legend>
            <div className="row" role="group" aria-label="요일 빠른 선택">
              {DAY_PRESETS.map((p) => (
                <button key={p.key} type="button" className={`btn2 small${presetActive(form.days, p) ? ' on' : ''}`} aria-pressed={presetActive(form.days, p)} onClick={() => set({ days: [...p.days] })}>{p.label}</button>
              ))}
            </div>
            <div className="isd-days" role="group" aria-label="발송 요일">
              {DAY_ORDER.map((d) => {
                const on = form.days.includes(d);
                return (
                  <button key={d} type="button" className={`isd-day${on ? ' on' : ''}${d === 0 ? ' sun' : d === 6 ? ' sat' : ''}`} aria-pressed={on} onClick={() => set({ days: toggleDay(form.days, d) })}>
                    <span>{DAY_LABELS[d]}</span><i aria-hidden="true">{on ? '✓' : ''}</i>
                  </button>
                );
              })}
            </div>
            {issues.days || badField('digest.days') ? <span className="hint bad">{issues.days || '요일을 하나 이상 고르세요.'}</span> : null}
          </fieldset>

          <fieldset disabled={locked}>
            <legend>발송 시각</legend>
            <div className="row">
              <label className="fld inline">시
                <Select sort={false} value={form.hour} onChange={(e) => set({ hour: e.target.value })} aria-invalid={badField('digest.time') || undefined}>
                  {HOURS.map((h) => <option key={h} value={h}>{h}</option>)}
                </Select>
              </label>
              <span aria-hidden="true" style={{ marginTop: 18 }}>:</span>
              <label className="fld inline">분
                <Select sort={false} value={form.minute} onChange={(e) => set({ minute: e.target.value })} aria-invalid={badField('digest.time') || undefined}>
                  {mins.map((m) => <option key={m} value={m}>{m}</option>)}
                </Select>
              </label>
              <span className="isd-tag muted" style={{ marginTop: 18 }}>한국 시각(KST)</span>
            </div>
            <span className="hint">정한 시각에 그때까지 모인 <b>마지막 성공 조사</b>로 메일을 만듭니다. 조사를 새로 돌리지는 않습니다 — 조사 시각은 대상별 수집 주기를 따릅니다.</span>
          </fieldset>

          <fieldset disabled={locked}>
            <legend>받는 사람</legend>
            <label className="radio">
              <input type="checkbox" checked={form.includeAdmin} onChange={(e) => set({ includeAdmin: e.target.checked })} />
              <span>통합 관리자 — 메일 설정의 기본 받는 사람 <span className="hint">(지금 {adminTo.length}명{adminTo.length ? '' : ' — 설정 › 메일 발송에서 정합니다'})</span></span>
            </label>
            <label className="fld">추가 주소 — 쉼표·줄바꿈으로 구분
              <textarea className={`mono${issues.to || badField('digest.to') ? ' bad' : ''}`} rows={3} value={form.to} onChange={(e) => set({ to: e.target.value })} placeholder="storage-lead@corp.example" aria-invalid={!!issues.to || undefined} />
            </label>
            <span className={`hint${issues.to ? ' bad' : ''}`}>
              {issues.to || (rc.count
                ? `받는 사람 ${rc.count}명(통합 관리자 ${rc.fromAdmin} · 추가 ${rc.fromExtra}${rc.dupes ? ` · 겹친 주소 ${rc.dupes}개는 한 번만` : ''}) · 같은 주소는 한 번만 보냅니다.`
                : '받는 사람이 없습니다 — 통합 관리자를 넣거나 주소를 적으세요.')}
            </span>
          </fieldset>

          <fieldset disabled={locked}>
            <legend>담을 내용</legend>
            <div className="row">
              <span className="hint" style={{ fontSize: 12.5 }}>전 법인 폴더 순위</span>
              <div className="isd-seg" role="group" aria-label="전 법인 폴더 순위 개수">
                {TOPN_CHOICES.map((n) => <button key={n} type="button" className={form.topN === n ? 'on' : ''} aria-pressed={form.topN === n} onClick={() => set({ topN: n })}>Top {n}</button>)}
              </div>
            </div>
            <label className="radio"><input type="checkbox" checked={form.includeWatch} onChange={(e) => set({ includeWatch: e.target.checked })} /><span>수집 실패·오래된 대상을 ‘먼저 볼 것’ 에 싣기</span></label>
            <label className="radio"><input type="checkbox" checked={form.includeTargets} onChange={(e) => set({ includeTargets: e.target.checked })} /><span>수집 대상별 표 싣기</span></label>
            <label className="radio"><input type="checkbox" checked={form.skipIfNoNew} onChange={(e) => set({ skipIfNoNew: e.target.checked })} /><span>직전 발송 뒤 새로 성공한 조사가 하나도 없으면 보내지 않기</span></label>
          </fieldset>

          {msg ? <div className={`result ${msg.tone}`}>{msg.text}</div> : null}
          <div className="row" style={{ borderTop: '1px solid var(--border-soft)', paddingTop: 12 }}>
            <button type="button" className="btn2 primary" onClick={save} disabled={locked || !!busy || hasIssue || !dirty}>{busy === 'save' ? '저장 중…' : '저장'}</button>
            <button type="button" className="btn2" onClick={sendNow} disabled={locked || !!busy || dirty || st.edge} title={dirty ? '바뀐 칸을 먼저 저장하세요 — 지금 보내기는 저장된 설정으로 보냅니다.' : undefined}>{busy === 'send' ? '보내는 중…' : '지금 한 번 보내기'}</button>
            <button type="button" className="btn2" onClick={openPreview} disabled={!!busy || !!issues.to}>{busy === 'preview' ? '만드는 중…' : '메일 미리보기 열기'}</button>
            {dirty ? <span className="hint" style={{ marginLeft: 'auto' }}>저장하지 않은 변경이 있습니다{form.enabled && !saved.enabled ? ' — 켠 뒤 처음 맞는 회차부터 보냅니다(오늘 이미 지난 시각은 보내지 않습니다)' : ''}.</span> : null}
          </div>
        </div>

        <aside className="isd-digest-side" aria-label="다음 발송과 최근 기록">
          <div className="isd-card">
            <div className="isd-cardhead"><h3>다음 발송</h3></div>
            {slots.length ? (
              <>
                <div className="isd-next0">{slotText(slots[0], off)}<span className="hint"> · {untilText(slots[0], now)}</span></div>
                {slots.slice(1).map((s) => <div key={s} className="hint" style={{ fontFamily: 'var(--mono)' }}>{slotText(s, off)}</div>)}
                <div className="hint">{scheduleText(form.days, `${form.hour}:${form.minute}`)}(KST){dirty ? ' — 저장하면 이 일정으로 바뀝니다' : ''}</div>
              </>
            ) : (
              <div className="hint">{!form.enabled ? '종합 메일이 꺼져 있습니다.' : '요일을 고르면 다음 발송 시각이 보입니다.'}</div>
            )}
          </div>

          <div className="isd-card">
            <div className="isd-cardhead"><h3>최근 발송</h3><span className="hint">최근 {hist.length}건</span></div>
            {hist.length ? hist.slice(0, 8).map((h, i) => {
              const v = historyLine(h, off);
              return (
                <div key={`${h.at}-${i}`} className="isd-hist">
                  <span className={`isd-tag ${v.tone}`}>{v.tag}</span>
                  <div><div style={{ fontFamily: 'var(--mono)', fontSize: 12.5 }}>{v.when}</div><div className="hint">{v.text}</div></div>
                </div>
              );
            }) : <div className="hint">아직 기록이 없습니다. 보낸 결과·생략·실패·놓친 회차가 여기 남습니다(주소는 남기지 않고 개수만).</div>}
          </div>

          <div className="isd-card">
            <div className="isd-cardhead"><h3>알아 둘 것</h3></div>
            <ul className="isd-nudge">
              <li>중앙 포탈만 보냅니다. 엣지 법인의 결과는 중앙이 이미 받아 둔 값을 씁니다.</li>
              <li>포탈이 정한 시각에 꺼져 있었다면 그 회차는 ‘놓침’ 으로 남기고 몰아서 보내지 않습니다(정한 시각부터 {srv.graceMin ?? 30}분 안에 확인하면 보냅니다).</li>
              <li>데모 대상은 실제 메일에 싣지 않습니다(미리보기에는 넣고 그 사실을 밝힙니다).</li>
              <li>메일 서버와 ‘아이실론 디렉터리 사용량’ 종류는 설정 › 메일 발송에서 켭니다.</li>
            </ul>
          </div>
        </aside>
      </div>

      {preview ? (
        <Modal title="종합 메일 미리보기" onClose={() => setPreview(null)} width={900}>
          <div className="isd-form">
            <div className="hint">제목: <b style={{ color: 'var(--text)' }}>{preview.subject}</b></div>
            <div className="hint">받는 사람 {preview.recipients}명 · 대상 {preview.targets}개{preview.demoIncluded ? ` · 데모 대상 ${preview.demoIncluded}개 포함(실제 발송에서는 빠집니다)` : ''} · 저장하지 않은 화면 값으로 만들었습니다(보내지 않았습니다).</div>
            <iframe title="종합 메일 미리보기 본문" className="isd-mailframe" sandbox="" srcDoc={preview.html} />
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
