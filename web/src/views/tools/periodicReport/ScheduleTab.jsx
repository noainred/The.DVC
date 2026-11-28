/**
 * ScheduleTab — ③ 일정 · 전달(설계 시안 ③). 주기별 시각 · 메일(통합 관리자 · 추가 주소 · 법인 담당자) · 알림 채널 · 공지 · 이슈 · 보관 · 지금 상태 · 지금 만들기.
 * 설정 조회는 전체 범위만(서버 fullScopeOnly — 범위 계정은 403 권한 안내) · 저장 · 만들기는 관리자 · 전체 범위만(서버 fullRwOnly).
 * 비관리자에게 서버는 받는 사람 주소를 수로만 준다(toHidden) — 화면은 그 사실을 말하고 입력을 잠근다. 조회 실패 상태로는 저장 버튼을 열지 않는다.
 * 설정 › 알림 · 연동 › 정기 점검 보고 도 이 화면을 쓴다(standalone).
 * v3.59(시안 §9): '백업 성공 · 실패 현황' 카드 — 실을 주기 · 백업 고르기 · 하루 치 적재 켜기 · 적재 보관 · 적재 상태(서버 status.backup 값 — 주기 · 상한 숫자를 화면에 박지 않는다).
 */
import React, { useEffect, useState } from 'react';
import { STable } from '../../../components/STable.jsx';
import { putJson, postJson, hasRole } from '../../../api.js';
import { ErrorBox } from '../../../components/primitives.jsx';
import Select from '../../../components/Select.jsx';
import { useLoad } from './parts.jsx';
import { KINDS, KIND_LABEL, WEEKDAYS, numText, kstText, scheduleLine, nextText, mailList, statusText, BK_PRODUCTS, BK_PRODUCT_LABEL } from './periodicReportText.js';

const formOf = (s) => ({
  kinds: Object.fromEntries(KINDS.map((k) => [k, { ...(s?.kinds?.[k] || {}) }])),
  mail: { enabled: !!s?.mail?.enabled, includeAdmin: s?.mail?.includeAdmin !== false, to: (s?.mail?.to || []).join(', '), kinds: [...(s?.mail?.kinds || [])], attach: s?.mail?.attach !== false,
    corpTo: Object.fromEntries(Object.entries(s?.mail?.corpTo || {}).map(([k, v]) => [k, (v || []).join(', ')])) },
  chat: { enabled: !!s?.chat?.enabled, kinds: [...(s?.chat?.kinds || [])] },
  notice: { enabled: !!s?.notice?.enabled, kinds: [...(s?.notice?.kinds || [])] },
  issues: { enabled: !!s?.issues?.enabled, dailyMax: s?.issues?.dailyMax ?? 10 },
  retainDays: { ...(s?.retainDays || {}) },
  backup: { kinds: [...(s?.backup?.kinds || [])], products: Object.fromEntries(BK_PRODUCTS.map((p) => [p, s?.backup?.products?.[p] !== false])),
    ledger: s?.backup?.ledger !== false, keepDays: s?.backup?.keepDays ?? '' },
});
const toggleIn = (arr, k) => (arr.includes(k) ? arr.filter((x) => x !== k) : [...arr, k]);

export default function ScheduleTab({ status: given = null, isAdmin = hasRole('admin'), scoped = false, onChanged, onPreview, onOpen, standalone = false }) {
  const st0 = useLoad('/tools/periodic-report/status', !given);
  const status = given || st0.data;
  const set = useLoad('/tools/periodic-report/settings', !scoped);
  const vcs = useLoad('/vcenters', !scoped);
  const s = set.data?.settings || null;
  const [f, setF] = useState(() => formOf(s));
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState('');
  useEffect(() => { setF(formOf(s)); }, [s?.updatedAt, !!s]); // eslint-disable-line react-hooks/exhaustive-deps
  if (scoped) return <div className="prr-banner">일정 · 전달은 전체 범위(vCenter 제한 없는) 계정만 봅니다 — 이 계정은 범위가 지정돼 있습니다. 보관함과 보고서는 내 범위(법인) 분량으로 볼 수 있습니다.</div>;
  if (set.err && !set.data) return <ErrorBox error={set.err} />;
  if (!set.data) return <div className="prr-muted">설정을 불러오는 중…</div>;
  const hidden = !!s?.mail?.toHidden;
  const canSave = isAdmin && !!s && !set.data.settingsUnreadable && !hidden;
  const kv = (k, key) => (e) => setF({ ...f, kinds: { ...f.kinds, [k]: { ...f.kinds[k], [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value } } });
  const save = async () => {
    setBusy('save'); setMsg(null);
    try {
      const kinds = Object.fromEntries(KINDS.map((k) => {
        const x = f.kinds[k];
        return [k, { enabled: !!x.enabled, time: x.time, ...(k === 'daily' ? { skipWeekend: !!x.skipWeekend } : {}), ...(k === 'weekly' ? { weekday: Number(x.weekday) } : {}), ...(k === 'monthly' || k === 'quarterly' ? { monthDay: Number(x.monthDay) } : {}) }];
      }));
      const body = { kinds,
        mail: { enabled: f.mail.enabled, includeAdmin: f.mail.includeAdmin, to: mailList(f.mail.to), kinds: f.mail.kinds, attach: f.mail.attach,
          corpTo: Object.fromEntries(Object.entries(f.mail.corpTo).map(([k, v]) => [k, mailList(v)]).filter(([, v]) => v.length)) },
        chat: f.chat, notice: f.notice, issues: { enabled: f.issues.enabled, dailyMax: Number(f.issues.dailyMax) },
        retainDays: Object.fromEntries(KINDS.map((k) => [k, Number(f.retainDays[k])])),
        backup: { kinds: f.backup.kinds, products: f.backup.products, ledger: f.backup.ledger, keepDays: Number(f.backup.keepDays) } };
      const r = await putJson('/tools/periodic-report/settings', body);
      if (r?.ok === false) setMsg({ ok: false, text: `${r.reason || '저장하지 못했습니다'}${r.field ? ` (${r.field})` : ''}` });
      else { setMsg({ ok: true, text: '저장했습니다 — 켜거나 시각을 바꾼 주기는 지금 이후 회차부터 만듭니다(지난 회차를 소급하지 않습니다).' }); set.reload(); onChanged?.(); }
    } catch (e) { setMsg({ ok: false, text: String(e?.message || e) }); }
    finally { setBusy(''); }
  };
  const run = async (kind, preview) => {
    setBusy(`${kind}:${preview ? 'p' : 'r'}`); setMsg(null);
    try {
      const r = await postJson('/tools/periodic-report/run', { kind, preview });
      if (r?.ok === false) setMsg({ ok: false, text: r.reason || '만들지 못했습니다' });
      else if (preview) onPreview?.({ run: r.run, previewId: r.previewId });
      else { setMsg({ ok: true, text: `만들었습니다 — ${r.id}(정한 경로로 보냈습니다)` }); onChanged?.(); if (onOpen && r.id) onOpen(r.id); }
    } catch (e) { setMsg({ ok: false, text: String(e?.message || e) }); }
    finally { setBusy(''); }
  };
  const vcList = Array.isArray(vcs.data) ? vcs.data : (vcs.data?.vcenters || []);
  const db = status?.db;
  const bks = status?.backup || null;   // 적재 상태(서버 ledgerStatus — 관측 주기 · 보관 상한도 서버 값)
  const bkSet = (patch) => setF({ ...f, backup: { ...f.backup, ...patch } });
  // 일일 시각이 '날 끝 + 확정 지연' 보다 이르면 전날이 아직 확정 전이라 3절이 늘 '적재 0 / 1일' 이다(판정 축 F11 · 지연 시간은 서버 값)
  const minOf = (hhmm) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
  const dailyMin = minOf(f.kinds?.daily?.time);
  const lagMin = Number.isFinite(Number(bks?.sealLagMs)) ? Math.ceil(Number(bks.sealLagMs) / 60_000) + Math.ceil((Number(bks.captureMs) || 0) / 60_000) : null;
  const dailyTooEarly = !!f.kinds?.daily?.enabled && f.backup.kinds.includes('daily') && f.backup.ledger && dailyMin != null && lagMin != null && dailyMin < lagMin;
  return (
    <div className="prr-sched">
      {standalone && <div className="prr-muted">특수 기능 › 리포트 · 점검 › 정기 점검 보고 의 ‘일정 · 전달’ 과 같은 화면입니다 — 보관함 · 보고서는 <a href="#/tools/periodic-report">그 도구</a>에서 봅니다.</div>}
      {set.data.settingsUnreadable && <div className="prr-banner amber">설정 파일을 읽지 못했습니다 — 저장을 막았습니다{set.data.loadError?.readError ? '(읽기 오류 — 원본은 그대로 있습니다)' : '(손상본을 옆에 보존했습니다)'}.</div>}
      {hidden && <div className="prr-muted">받는 사람 주소는 관리자에게만 보입니다(추가 {numText(s?.mail?.toCount)}명 · 법인판 {numText(s?.mail?.corpToCount)}곳).</div>}
      {!isAdmin && <div className="prr-muted">관리자만 저장 · 지금 만들기를 할 수 있습니다.</div>}
      {msg && <div className={`prr-banner${msg.ok ? '' : ' amber'}`}>{msg.text}</div>}
      <div className="prr-grid2">
        <div className="prr-col">
          {KINDS.map((k) => {
            const x = f.kinds[k] || {};
            const ks = status?.kinds?.[k];
            return (
              <div key={k} className="prr-panel">
                <div className="prr-card-h"><b>{KIND_LABEL[k]}</b><label className="prr-check"><input type="checkbox" checked={!!x.enabled} onChange={kv(k, 'enabled')} disabled={!canSave} />켜기</label><span className="prr-grow" /><span className="prr-pill">항목 {numText(ks?.items)}</span></div>
                <div className="prr-form">
                  <label>시각(포탈 시각)<input type="time" value={x.time || ''} onChange={kv(k, 'time')} disabled={!canSave} /></label>
                  {k === 'daily' && <label className="prr-check"><input type="checkbox" checked={!!x.skipWeekend} onChange={kv(k, 'skipWeekend')} disabled={!canSave} />주말 건너뛰기</label>}
                  {k === 'weekly' && <label>요일<Select className="select select-sm" value={String(x.weekday ?? 1)} onChange={kv(k, 'weekday')} disabled={!canSave} aria-label="요일">{WEEKDAYS.map((w) => <option key={w.v} value={String(w.v)}>{w.l}요일</option>)}</Select></label>}
                  {(k === 'monthly' || k === 'quarterly') && <label>{k === 'quarterly' ? '1 · 4 · 7 · 10월의 날짜' : '날짜'}<input type="number" min="1" max="31" value={x.monthDay ?? 1} onChange={kv(k, 'monthDay')} disabled={!canSave} /></label>}
                  <label>보관(일)<input type="number" min="1" value={f.retainDays[k] ?? ''} onChange={(e) => setF({ ...f, retainDays: { ...f.retainDays, [k]: e.target.value } })} disabled={!canSave} /></label>
                </div>
                <div className="prr-note">지금: {scheduleLine(k, ks?.def)} · 다음 {nextText(ks)} · 마지막 {ks?.last ? `${kstText(ks.last.generatedAt)} ${statusText(ks.last.overall)}` : '없음'}</div>
                {isAdmin && (
                  <div className="prr-bar">
                    <button type="button" className="prr-btn" onClick={() => run(k, true)} disabled={!!busy || !!status?.busy}>{busy === `${k}:p` ? '만드는 중…' : '미리보기(보관 · 전달 안 함)'}</button>
                    <button type="button" className="prr-btn" onClick={() => run(k, false)} disabled={!!busy || !!status?.busy}>{busy === `${k}:r` ? '만드는 중…' : '지금 만들어 보내기'}</button>
                  </div>
                )}
              </div>
            );
          })}
          <div className="prr-banner"><b>회차 규칙</b> — 놓친 회차는 몰아서 만들지 않습니다(포탈이 꺼져 있던 동안의 회차는 ‘놓침’ 으로 기록). 시각을 바꿔도 지난 회차를 소급하지 않습니다. 같은 기간의 예약 회차는 한 번만 만들고, 보고서 조립은 서버 전체에서 동시에 하나입니다. 전달이 실패하면 보고서는 보관하고 그 경로만 간격을 늘려 다시 보냅니다.</div>
        </div>
        <div className="prr-col">
          <div className="prr-panel">
            <div className="prr-card-h"><b>메일</b><label className="prr-check"><input type="checkbox" checked={f.mail.enabled} onChange={(e) => setF({ ...f, mail: { ...f.mail, enabled: e.target.checked } })} disabled={!canSave} />보내기</label></div>
            <label className="prr-check"><input type="checkbox" checked={f.mail.includeAdmin} onChange={(e) => setF({ ...f, mail: { ...f.mail, includeAdmin: e.target.checked } })} disabled={!canSave} />통합 관리자(설정 › 메일 발송의 기본 받는 사람)</label>
            <label className="prr-lab">추가 받는 사람(전체판)<textarea value={f.mail.to} onChange={(e) => setF({ ...f, mail: { ...f.mail, to: e.target.value } })} disabled={!canSave} placeholder="ops@example.com, lead@example.com" /></label>
            <div className="prr-checks">{KINDS.map((k) => <label key={k} className="prr-check"><input type="checkbox" checked={f.mail.kinds.includes(k)} onChange={() => setF({ ...f, mail: { ...f.mail, kinds: toggleIn(f.mail.kinds, k) } })} disabled={!canSave} />{KIND_LABEL[k]}</label>)}</div>
            <label className="prr-check"><input type="checkbox" checked={f.mail.attach} onChange={(e) => setF({ ...f, mail: { ...f.mail, attach: e.target.checked } })} disabled={!canSave} />HTML 보고서 첨부(브라우저에서 열어 PDF 로 저장)</label>
            <details>
              <summary className="prr-lab" style={{ cursor: 'pointer' }}>법인 담당자 — 자기 법인판만 받습니다(전 법인 합계 · 포탈 자체 항목은 빠집니다)</summary>
              <div className="prr-form" style={{ marginTop: 8 }}>
                {vcList.map((v) => <label key={v.id}>{v.name || v.id}<input value={f.mail.corpTo[v.id] ?? ''} onChange={(e) => setF({ ...f, mail: { ...f.mail, corpTo: { ...f.mail.corpTo, [v.id]: e.target.value } } })} disabled={!canSave} placeholder="이메일, 이메일" /></label>)}
              </div>
            </details>
            <div className="prr-note">본문은 종합 · 축 요약 · 조치 필요 상위 10 · 확인하지 못한 것 수입니다. 첨부가 메일 첨부 상한을 넘으면 첨부 없이 보냅니다. 메일 설정이 꺼져 있으면 공용 경로가 보내지 않습니다. 데모 데이터뿐이면 보내지 않습니다.</div>
          </div>
          <div className="prr-panel">
            <div className="prr-card-h"><b>알림 채널(Slack · Teams · 웹훅)</b><label className="prr-check"><input type="checkbox" checked={f.chat.enabled} onChange={(e) => setF({ ...f, chat: { ...f.chat, enabled: e.target.checked } })} disabled={!canSave} />보내기</label></div>
            <div className="prr-checks">{KINDS.map((k) => <label key={k} className="prr-check"><input type="checkbox" checked={f.chat.kinds.includes(k)} onChange={() => setF({ ...f, chat: { ...f.chat, kinds: toggleIn(f.chat.kinds, k) } })} disabled={!canSave} />{KIND_LABEL[k]}</label>)}</div>
            <div className="prr-note">설정 › 알림의 채널을 씁니다. 기존 ‘일일 리포트’ 도 켜져 있으면 아침에 두 번 받습니다.</div>
          </div>
          <div className="prr-panel">
            <div className="prr-card-h"><b>공지 · 이슈</b></div>
            <label className="prr-check"><input type="checkbox" checked={f.notice.enabled} onChange={(e) => setF({ ...f, notice: { ...f.notice, enabled: e.target.checked } })} disabled={!canSave} />공지 하나를 갱신 — 판정 · 법인 이름 없이 ‘보고서가 만들어졌다’ 만(공지는 모든 계정에 보입니다)</label>
            <div className="prr-checks">{KINDS.map((k) => <label key={k} className="prr-check"><input type="checkbox" checked={f.notice.kinds.includes(k)} onChange={() => setF({ ...f, notice: { ...f.notice, kinds: toggleIn(f.notice.kinds, k) } })} disabled={!canSave} />{KIND_LABEL[k]}</label>)}</div>
            <label className="prr-check"><input type="checkbox" checked={f.issues.enabled} onChange={(e) => setF({ ...f, issues: { ...f.issues, enabled: e.target.checked } })} disabled={!canSave} />이상 항목을 이슈로 자동 등록(같은 항목 · 법인은 한 번 · 하루 상한)</label>
            <label className="prr-lab">이슈 하루 상한<input type="number" min="1" max="50" value={f.issues.dailyMax} onChange={(e) => setF({ ...f, issues: { ...f.issues, dailyMax: e.target.value } })} disabled={!canSave} /></label>
          </div>
          <div className="prr-panel">
            <div className="prr-card-h"><b>백업 성공 · 실패 현황(보고서 3절)</b><label className="prr-check"><input type="checkbox" checked={f.backup.ledger} onChange={(e) => bkSet({ ledger: e.target.checked })} disabled={!canSave} />하루 치 적재</label></div>
            <div className="prr-lab">실을 주기</div>
            {dailyTooEarly && <div className="prr-banner amber">일일 시각({f.kinds.daily.time})이 전날을 확정하는 시각보다 이릅니다 — 전날이 아직 확정 전이라 일일 3절이 늘 ‘적재 0 / 1일’ 이 됩니다. 일일 시각을 {String(Math.floor(lagMin / 60)).padStart(2, '0')}:{String(lagMin % 60).padStart(2, '0')} 뒤로 두세요.</div>}
            <div className="prr-checks">{KINDS.map((k) => <label key={k} className="prr-check"><input type="checkbox" checked={f.backup.kinds.includes(k)} onChange={() => bkSet({ kinds: toggleIn(f.backup.kinds, k) })} disabled={!canSave} />{KIND_LABEL[k]}</label>)}</div>
            <div className="prr-lab">실을 백업</div>
            <div className="prr-checks">{BK_PRODUCTS.map((p) => <label key={p} className="prr-check"><input type="checkbox" checked={!!f.backup.products[p]} onChange={(e) => bkSet({ products: { ...f.backup.products, [p]: e.target.checked } })} disabled={!canSave} />{BK_PRODUCT_LABEL[p]}</label>)}</div>
            <label className="prr-lab">적재 보관(일{bks?.keep ? ` · ${numText(bks.keep.min)} ~ ${numText(bks.keep.max)}` : ''})<input type="number" min={bks?.keep?.min} max={bks?.keep?.max} value={f.backup.keepDays} onChange={(e) => bkSet({ keepDays: e.target.value })} disabled={!canSave} /></label>
            <div className="prr-note">
              적재 상태: {bks ? <>
                {bks.enabled ? '켜짐' : '꺼짐'}{bks.captureMs ? ` · ${numText(Math.round(bks.captureMs / 60_000))}분마다 관측` : ''}
                {' · '}마지막 관측 {bks.last ? `${kstText(bks.last.at)} ${bks.last.ok ? '성공' : `실패 — ${bks.last.reason || '사유 미상'}`}` : '아직 없음(포탈 시작 뒤 첫 관측 전)'}
                {bks.last?.ok ? ` · 새 결과 ${numText(bks.last.inserted)} · 확정 ${numText(bks.last.sealed)} · 다시 확정 ${numText(bks.last.resealed)}` : ''}
                {bks.busy ? ' · 지금 관측 중' : ''}
                {bks.db ? ` · 적재 시작 ${bks.db.firstDayAt ? kstText(bks.db.firstDayAt, { withYear: true }).slice(0, 10) : '없음'} · 확정 줄 ${numText(bks.db.days)} · 관측 줄 ${numText(bks.db.obs)}` : ' · 보관 DB 를 열지 못했습니다'}
              </> : '—'}
            </div>
            <div className="prr-note">적재는 포탈이 이미 저장한 결과(Veeam 엣지 push · Bareos 원장 · VM 백업 잡 기록)만 읽습니다 — Veeam · Director · 법인 엣지를 새로 부르지 않습니다. 처음 켜기 전 날은 ‘적재 전’ 이고 소급해 채우지 않습니다. 끄거나 포탈이 멈춘 동안의 날은, 다시 켰을 때 원본에 그날 실행 기록이 다 남아 있으면 채우고(Bareos · VM 백업), 다 봤다고 말할 수 없으면 ‘확인 불가’ 로 둡니다(Veeam 은 VM 마다 마지막 결과만 있어 대개 확인 불가). 백업 고르기는 3절에만 적용됩니다 — 항목 판정은 ‘점검 항목’ 에서 켜고 끕니다.</div>
          </div>
          {canSave && <div className="prr-bar"><button type="button" className="prr-btn primary" onClick={save} disabled={!!busy}>{busy === 'save' ? '저장하는 중…' : '저장'}</button><span className="prr-muted">저장은 감사 로그에 남습니다.</span></div>}
          <div className="prr-panel">
            <div className="prr-card-h"><b>지금 상태</b></div>
            <div className="prr-note">보고서 만드는 중: {status?.busy ? `${KIND_LABEL[status.busy.kind]} ${status.busy.id}` : '없음'} · 재시도 대기 {numText(status?.retry)}건 · 보관 회차 {numText(db?.runs)} · DB {db?.size != null ? (db.size < 1024 * 1024 ? `${Math.max(1, Math.round(db.size / 1024))} KB` : `${(db.size / 1024 / 1024).toFixed(1)} MB`) : '—'}{db?.error ? ` · DB 오류: ${db.error}` : ''} · 마지막 틱 {kstText(status?.lastTick?.at)}</div>
            {(status?.history || []).length > 0 && (
              <div className="prr-tablewrap">
                <STable limit={30}>
                  <thead><tr><th>시각</th><th>주기</th><th>회차</th><th>결과</th><th>사유</th></tr></thead>
                  <tbody>{status.history.map((h, i) => <tr key={`${h.at}-${i}`}><td className="prr-mono" data-sort={h.at}>{kstText(h.at)}</td><td>{KIND_LABEL[h.kind] || h.kind}</td><td className="prr-mono">{h.id || '—'}</td><td>{{ done: '만듦', failed: '실패', missed: '놓침' }[h.state] || h.state}</td><td style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{h.reason || (h.overall ? statusText(h.overall) : '—')}</td></tr>)}</tbody>
                </STable>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
