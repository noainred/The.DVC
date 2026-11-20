/**
 * CatalogTab — ② 점검 항목 · 주기 배치(설계 시안 ②). 항목마다 원천 · 판정 기준(그 기능의 판정 그대로) · 실리는 주기 · 켜기.
 * 바꾸기(주기 · 켜기)는 관리자 · 전체 범위만(서버 fullRwOnly) — 그 밖에는 읽기만. 조회 실패 상태로는 저장 버튼을 열지 않는다.
 */
import React, { useEffect, useState } from 'react';
import { STable } from '../../../components/STable.jsx';
import { putJson } from '../../../api.js';
import { useLoad } from './parts.jsx';
import { AXES, AXIS_LABEL, KINDS, KIND_LABEL, numText } from './periodicReportText.js';

export default function CatalogTab({ isAdmin, scoped }) {
  const cat = useLoad('/tools/periodic-report/catalog');
  const [axis, setAxis] = useState('');
  const [edit, setEdit] = useState({});   // key → { kinds, enabled }
  const [msg, setMsg] = useState(null);
  const [saving, setSaving] = useState(false);
  const items = cat.data?.items || [];
  const sig = JSON.stringify(items.map((x) => [x.key, x.kinds, x.enabled]));
  useEffect(() => { setEdit({}); }, [sig]);
  const canEdit = isAdmin && !scoped && !!cat.data && !cat.err;
  const cur = (it) => edit[it.key] || { kinds: it.kinds, enabled: it.enabled };
  const toggleKind = (it, k) => { const c = cur(it); const kinds = c.kinds.includes(k) ? c.kinds.filter((x) => x !== k) : [...c.kinds, k]; setEdit({ ...edit, [it.key]: { ...c, kinds } }); };
  const toggleOn = (it) => { const c = cur(it); setEdit({ ...edit, [it.key]: { ...c, enabled: !c.enabled } }); };
  const dirty = Object.keys(edit).length > 0;
  const save = async (reset = false) => {
    setSaving(true); setMsg(null);
    try {
      const out = {};
      if (!reset) {
        for (const it of items) {
          const c = cur(it);
          const sameKinds = [...c.kinds].sort().join() === [...it.defaultKinds].sort().join();
          if (!sameKinds || c.enabled === false) out[it.key] = { ...(sameKinds ? {} : { kinds: c.kinds }), ...(c.enabled === false ? { enabled: false } : {}) };
        }
      }
      const r = await putJson('/tools/periodic-report/settings', { items: out });
      if (r?.ok === false) setMsg({ ok: false, text: r.reason || '저장하지 못했습니다' });
      else { setMsg({ ok: true, text: reset ? '기본 배치로 되돌렸습니다' : '저장했습니다 — 다음 회차부터 반영됩니다' }); cat.reload(); }
    } catch (e) { setMsg({ ok: false, text: String(e?.message || e) }); }
    finally { setSaving(false); }
  };
  const shown = items.filter((x) => !axis || x.axis === axis);
  const per = Object.fromEntries(KINDS.map((k) => [k, items.filter((x) => cur(x).enabled && cur(x).kinds.includes(k)).length]));
  return (
    <>
      <div className="prr-banner">주기 열은 <b>그 항목이 어느 보고서에 실리는가</b>입니다(수집 주기가 아닙니다 — 수집은 기존 폴러 · 엣지가 지금 주기대로 합니다). 판정은 각 기능이 이미 쓰는 판정 함수 · 기준 그대로이고 여기서 새 기준을 만들지 않습니다. 원천이 꺼져 있거나 보고가 없는 법인은 그 항목이 <b>확인 불가</b>로 실립니다.</div>
      <div className="prr-bar">
        <div className="prr-seg" role="group" aria-label="축">
          <button type="button" className={axis === '' ? 'on' : ''} aria-pressed={axis === ''} onClick={() => setAxis('')}>전체 {numText(items.length)}</button>
          {AXES.map((a) => <button key={a} type="button" className={axis === a ? 'on' : ''} aria-pressed={axis === a} onClick={() => setAxis(a)}>{AXIS_LABEL[a]} {numText(items.filter((x) => x.axis === a).length)}</button>)}
        </div>
        {KINDS.map((k) => <span key={k} className="prr-pill">{KIND_LABEL[k]} {numText(per[k])}</span>)}
        <span className="prr-grow" />
        {canEdit && <button type="button" className="prr-btn" onClick={() => save(true)} disabled={saving}>기본 배치로 되돌리기</button>}
        {canEdit && <button type="button" className="prr-btn primary" onClick={() => save(false)} disabled={saving || !dirty}>{saving ? '저장하는 중…' : '저장'}</button>}
      </div>
      {!canEdit && <div className="prr-muted">{scoped ? '범위 계정은 읽기만 합니다 — 배치는 전체 범위 관리자가 바꿉니다.' : isAdmin ? '' : '관리자만 배치를 바꿉니다.'}</div>}
      {msg && <div className={`prr-banner${msg.ok ? '' : ' amber'}`}>{msg.text}</div>}
      {cat.err && <div className="prr-banner amber">점검 항목을 불러오지 못했습니다: {String(cat.err?.message || cat.err)}</div>}
      <div className="prr-tablewrap">
        <STable minWidth={1100}>
          <thead><tr>
            <th>축</th><th>항목</th><th>판정 기준(그 기능의 판정 그대로)</th><th>원천</th>
            {KINDS.map((k) => <th key={k} style={{ textAlign: 'center' }}>{KIND_LABEL[k]}</th>)}<th style={{ textAlign: 'center' }}>켜기</th>
          </tr></thead>
          <tbody>{shown.map((it) => {
            const c = cur(it);
            return (
              <tr key={it.key} className={c.enabled ? '' : 'prr-off'}>
                <td>{AXIS_LABEL[it.axis]}</td>
                <td>{it.tool ? <a href={`#/tools/${it.tool}`}>{it.label}</a> : it.label}{it.info ? <span className="prr-muted"> · 정보</span> : null}{it.fleet ? <span className="prr-muted"> · 전체(법인 행 없음)</span> : null}</td>
                <td className="prr-wrap">{it.rule}</td>
                <td className="prr-wrap prr-muted">{it.source}</td>
                {KINDS.map((k) => (
                  <td key={k} style={{ textAlign: 'center' }} data-sort={c.kinds.includes(k) ? 1 : 0}>
                    <input type="checkbox" checked={c.kinds.includes(k)} disabled={!canEdit} onChange={() => toggleKind(it, k)} aria-label={`${it.label} ${KIND_LABEL[k]}`} />
                  </td>
                ))}
                <td style={{ textAlign: 'center' }} data-sort={c.enabled ? 1 : 0}><input type="checkbox" checked={!!c.enabled} disabled={!canEdit} onChange={() => toggleOn(it)} aria-label={`${it.label} 켜기`} /></td>
              </tr>
            );
          })}</tbody>
        </STable>
      </div>
    </>
  );
}
