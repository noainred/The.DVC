/**
 * 서버 상세 ‘용도’ 탭(리눅스 성능 4단계 · 아트보드 ⑥ Profiles.dc.html 의 서버 예시 ① ②) — 감지(OS · 기능 · 근거 · 수동 태그) → 프로파일별 점검 표 · 요구값 표 → 근거 문서 → 정직 기록.
 * ⚠ 판정은 서버(`profiles/match.js`) — 그리기만. 미수집 · 확인 불가는 정상이 아니다(서버 code 그대로).
 * ⚠ 수동 태그(기능 · 역할) 편집은 관리자만(서버가 다시 검사 — 조회 밖 404 · 쓰기 밖 403). 태그는 판정 기준이고 서버에 아무것도 쓰지 않는다.
 */
import React, { useState } from 'react';
import { putJson, hasRole } from '../../api.js';
import Select from '../../components/Select.jsx';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import { toneVar } from './toneVar.js';
import { OpsError, useOpsLoad, Grade, GradeLegend } from './BmTuningTab.jsx';
import { perfPath } from './bmPerfUrl.js'; // 다음 점검 ①: 서버 = (법인, 키) 쌍 — 요청에 법인을 싣는다
import {
  PROFILE_STATUS_TEXT, CHECK_STATUS_TEXT, APP_LABEL, ROLE_LABEL, evidenceText, checkView, tuningStatusView, devicesText, sourceById, factsNotes, PROFILE_HONEST,
} from './bmOpsText.js';
import './bmOps.css';

function SourceLinks({ ids = [], list = [] }) {
  if (!ids.length) return <span style={{ color: 'var(--muted)' }}>—</span>;
  return <span>{ids.map((id, i) => { const s = sourceById(list, id); return <React.Fragment key={id}>{i > 0 && ' · '}{s ? <a href={s.url} target="_blank" rel="noopener noreferrer" title={s.title}>{id}</a> : id}</React.Fragment>; })}</span>;
}

function TagEditor({ itemKey, vc = '', manual, onSaved }) {
  const [apps, setApps] = useState(() => (Array.isArray(manual?.apps) ? manual.apps : null));
  const [role, setRole] = useState(manual?.role || '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const save = async (clear = false) => {
    setBusy(true); setMsg('');
    try {
      const who = { key: itemKey, ...(vc ? { vcenterId: vc } : {}) };   // 다음 점검 ①: 대상 = (법인, 키) 쌍
      const r = await putJson('/tools/bm-usage/purpose', clear ? { ...who, clear: true } : { ...who, ...(apps ? { apps } : {}), role });
      if (r?.ok === false) setMsg(r.reason || '저장하지 못했습니다.');
      else { setMsg(clear ? '수동 태그를 지웠습니다 — 자동 감지로 돌아갑니다.' : '저장했습니다.'); onSaved?.(); }
    } catch (e) { setMsg(String(e?.message || e)); } finally { setBusy(false); }
  };
  const toggle = (id) => setApps((p) => { const cur = p || []; return cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]; });
  return (
    <div className="bmo-card">
      <h5 className="bmo-h">수동 태그(관리자) — 자동 감지보다 우선</h5>
      <div className="bmo-tagrow">
        <label className="bmo-check"><input type="checkbox" checked={apps === null} onChange={(e) => setApps(e.target.checked ? null : [])} /> 기능은 자동 감지 따름</label>
        {apps !== null && Object.keys(APP_LABEL).filter((k) => k !== 'none').map((k) => (
          <label key={k} className="bmo-check"><input type="checkbox" checked={apps.includes(k)} onChange={() => toggle(k)} /> {APP_LABEL[k]}</label>
        ))}
        <label className="bmo-check">역할{' '}
          <Select sort={false} className="select select-sm" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="">지정 안 함(일반)</option>
            {Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </label>
        <button className="btn btn-sm bmp-touch" disabled={busy || (apps === null && !role)} onClick={() => save(false)}>저장</button>
        <button className="btn btn-sm bmp-touch" disabled={busy || !manual} onClick={() => save(true)}>태그 지우기</button>
      </div>
      <div className="bmo-sub">기능 목록에 없는 것(Ubuntu · Windows · Hadoop)은 프로파일이 없어 태그할 수 없습니다. 빈 기능 목록은 ‘기능 없음’ 확정입니다.</div>
      {msg && <div className="bmo-note">{msg}</div>}
    </div>
  );
}

export function ProfileView({ resp, itemKey = '', vc = '', onReload = null, canTag = false, showReadOnly = false }) {
  const det = resp?.detection || {};
  const st = PROFILE_STATUS_TEXT[resp?.status] || PROFILE_STATUS_TEXT.unknown;
  const notes = factsNotes(resp || {});
  return (
    <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
      <div className="bmo-band">
        <div><span className="bmo-k">용도 판정</span> <b style={{ color: toneVar(st.tone) }}>{st.label}</b></div>
        <div style={{ fontSize: 12 }}>
          <span className="bmo-k">OS</span> {det.os?.label || '미확인'} · 프로파일 {det.os?.profile || <b>없음</b>}
          {' · '}<span className="bmo-k">기능</span> {(det.activeApps || []).map((a) => APP_LABEL[a] || a).join(' · ') || '없음'}
          {' · '}<span className="bmo-k">역할</span> {ROLE_LABEL[det.role] || det.role}{det.roleManual ? '(수동)' : '(기본)'}
          {det.manualApplied && <span className="bmp-chip" style={{ marginLeft: 6 }}>수동 태그 적용</span>}
        </div>
        <div style={{ fontSize: 12 }}>
          {(det.apps || []).map((a) => <div key={a.id}><span className="bmo-k">{APP_LABEL[a.id] || a.id} 감지</span> {a.detected ? '됨' : '안 됨'} — {evidenceText(a.evidence)}{a.gpRole ? ` · 역할 추정 ${a.gpRole}` : ''}</div>)}
        </div>
      </div>
      {notes.map((x, i) => <p key={i} className="bmo-note"><BoldText text={x} /></p>)}
      {resp?.osProfileMissing && <p className="bmo-note"><BoldText text={`이 OS(${det.os?.label || '미확인'})에는 프로파일이 없습니다 — **점검하지 않습니다**(Rocky 9 만 만들었습니다 · 틀린 판정보다 낫습니다).`} /></p>}
      {canTag && <TagEditor itemKey={itemKey} vc={vc} manual={resp?.manual || null} onSaved={onReload} />}
      {/* 반증 W4: 관리자라도 쓰기 범위 밖(조회만 되는 법인)이면 태그 칸 대신 이유(서버도 PUT 403). */}
      {!canTag && showReadOnly && resp?.writable === false && <p className="bmo-note">이 서버의 법인에 쓰기 권한이 없어 수동 태그를 바꿀 수 없습니다(조회 전용).</p>}
      {(resp?.profiles || []).map((p) => {
        const ps = PROFILE_STATUS_TEXT[p.status] || PROFILE_STATUS_TEXT.unknown;
        return (
          <section key={p.id} className="bmo-card">
            <h5 className="bmo-h">{p.title} <span className="bmp-chip">{p.id}</span> <span style={{ color: toneVar(ps.tone) }}>{ps.label}</span></h5>
            {!!p.checks.length && (
              <STable minWidth={900} className="bmo-t" style={{ fontSize: 12 }}>
                <thead><tr><th>점검</th><th>방법(읽기 전용)</th><th>결과</th><th>근거 — 문서 요지</th><th>출처</th></tr></thead>
                <tbody>
                  {p.checks.map((c) => {
                    const v = checkView(c);
                    return (
                      <tr key={c.id}>
                        <td data-sort={c.title} className="bmo-name">{c.title}</td>
                        <td data-sort={c.how} className="bmo-wrap bmo-mono">{c.how}</td>
                        <td data-sort={v.rank} className="bmo-wrap"><span style={{ color: toneVar(v.tone), fontWeight: 600 }}>{v.label}</span>{v.value && ` · ${v.value}`}{v.reason && <div className="bmo-sub">{v.reason}</div>}</td>
                        <td data-nosort className="bmo-wrap bmo-ev"><Grade grade={c.grade} /> {c.evidence}</td>
                        <td data-sort={(c.sources || []).join(',')}><SourceLinks ids={c.sources} list={resp.sources} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </STable>
            )}
            {!!p.tunings.length && (
              <>
                <div className="bmo-reads" style={{ marginTop: 8 }}>{p.kind === 'app' && p.id === 'gpdb' ? 'OS 요구값 — 기능 프로파일이 OS 기본 · 역할 권장값을 덮어씁니다(튜닝 탭의 같은 항목도 ‘용도 gpdb’ 로 표시)' : '기능 튜닝'}</div>
                <STable minWidth={900} className="bmo-t" style={{ fontSize: 12 }}>
                  <thead><tr><th>항목</th><th>현재</th><th>요구(문서값)</th><th>근거 — 문서 요지</th><th>상태</th></tr></thead>
                  <tbody>
                    {p.tunings.map((x) => {
                      const v = tuningStatusView(x);
                      const cur = x.devices ? devicesText(x.devices) : (x.current ?? '');
                      return (
                        <tr key={x.key}>
                          <td data-sort={x.title} className="bmo-name">{x.title}</td>
                          <td data-sort={cur || ''} className="bmo-wrap bmo-cur">{cur || '—'}</td>
                          <td data-sort={x.rec || ''} className="bmo-wrap">{x.rec || '—'}</td>
                          <td data-nosort className="bmo-wrap bmo-ev"><Grade grade={x.grade} /> {x.evidence} <span className="bmo-sub"><SourceLinks ids={x.sources} list={resp.sources} /></span></td>
                          <td data-sort={v.rank} className="bmo-wrap"><span style={{ color: toneVar(v.tone), fontWeight: 600 }}>{v.label}</span>{v.reason && <div className="bmo-sub">{v.reason}</div>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </STable>
              </>
            )}
          </section>
        );
      })}
      <section className="bmo-card">
        <h5 className="bmo-h">근거 문서 — 이 화면이 인용한 것</h5>
        <div className="bmo-reads">확인일 {resp?.sourcesCheckedAt || '—'} · <GradeLegend /> · 점검 결과: {Object.values(CHECK_STATUS_TEXT).map((s) => s.label).join(' · ')}</div>
        <STable minWidth={560} className="bmo-t" style={{ fontSize: 12 }}>
          <thead><tr><th>#</th><th>문서</th><th>확인</th></tr></thead>
          <tbody>
            {(resp?.sources || []).map((s) => (
              <tr key={s.id}><td data-sort={s.id}>{s.id}</td><td data-sort={s.title} className="bmo-wrap"><a href={s.url} target="_blank" rel="noopener noreferrer">{s.title}</a></td><td data-sort={s.grade}><Grade grade={s.grade} /> {s.how}</td></tr>
            ))}
          </tbody>
        </STable>
      </section>
      <section className="bmo-card bmo-honest">
        <h5 className="bmo-h">정직하게 적어 둘 것</h5>
        {PROFILE_HONEST.map((x, i) => <p key={i} className="bmo-note"><BoldText text={x} /></p>)}
      </section>
    </div>
  );
}

export default function BmProfileTab({ itemKey, vc = '' }) {
  const { resp, err, loading, reload } = useOpsLoad((k, v) => perfPath(k, v, '/profile'), itemKey, vc);
  return (
    <div style={{ minWidth: 0 }}>
      <div className="bmo-bar">
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>프로파일 1개 = 파일 1개 · 우선순위 기능 &gt; 역할 &gt; OS · 감지는 1단계 SSH 1회의 구획(유닛 · 프로세스 이름 · 포트 · 계정)</span>
        <span style={{ flex: '1 1 auto' }} />
        <button className="btn btn-sm bmp-touch" onClick={reload} disabled={loading}>{loading ? '읽는 중…' : '다시 읽기'}</button>
      </div>
      <OpsError err={err} />
      {!resp && !err && <p className="bmo-note">용도 판정을 불러오는 중…</p>}
      {resp && <ProfileView resp={resp} itemKey={itemKey} vc={vc} onReload={reload} canTag={!!resp.canTag && hasRole('admin')} showReadOnly={hasRole('admin')} />}
    </div>
  );
}
