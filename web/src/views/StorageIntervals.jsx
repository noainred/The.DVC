import React, { useEffect, useState } from 'react';
import { fetchJson, putJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';
import { presetsFor, msLabel, effectiveFor, sourceOf, lagText, toBody } from './storageIntervals.js';

/**
 * 스토리지 수집 주기(중앙 → 엣지 배포, v2.409 — 사용자 요구
 * '중앙에서 엣지의 스토리지 수집 주기를 설정할 수 있는 기능 설정에 추가').
 *
 * 구조상 중앙은 엣지에 명령을 밀어넣을 수 없다(엣지는 NAT/폐쇄망 뒤 — 아웃바운드 pull 만).
 * 그래서 여기서 저장한 값은 엣지가 **다음 설정 pull 때 가져가서** 적용한다. 화면에서도 그
 * 지연을 숨기지 않고 표시한다(즉시 적용처럼 보이면 '설정했는데 안 바뀐다'는 오해가 생긴다).
 */
export default function StorageIntervals() {
  // ⚠ 훅은 전부 조기 return 위에 — 조기 반환 뒤에 훅을 추가하면 React #310 으로 화면이
  //   통째로 크래시한다(v2.202 실제 사고, CLAUDE.md 프론트 회귀 방지).
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [globalForm, setGlobalForm] = useState({});
  const [agentForms, setAgentForms] = useState({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const fill = (d) => {
    const str = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, String(v)]));
    setGlobalForm(str(d.config?.global));
    const rows = {};
    for (const a of ['', ...(d.agents || [])]) rows[a] = str(d.config?.agents?.[a]);
    // 파일에만 있고 현재 알려진 엣지 목록엔 없는 이름(연결이 끊긴 엣지)도 보여준다 — 안 보이면
    // 저장 시 조용히 사라진다(전체 교체 저장이므로).
    for (const a of Object.keys(d.config?.agents || {})) if (!(a in rows)) rows[a] = str(d.config.agents[a]);
    setAgentForms(rows);
  };

  const load = async () => {
    try { const d = await fetchJson('/tools/storage/intervals'); setData(d); fill(d); setError(null); }
    catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, []);

  if (error && !data) return <ErrorBox message={error} />;  // 데이터 보유 중 폴링 오류로 화면을 갈아치우지 않음
  if (!data) return <Loading />;

  const spec = data.spec || [];
  const envDefaults = data.central?.env || {};
  const targets = [{ key: '', label: '중앙(직접 수집)', hint: '수집 주체를 지정하지 않은 장비 — 중앙 포탈이 직접 접속해 수집한다. 저장 즉시 적용된다.' },
    ...Object.keys(agentForms).filter((a) => a !== '').sort().map((a) => ({ key: a, label: a, hint: `엣지 '${a}' 가 수집하는 장비. 다음 설정 pull 때 적용된다.` }))];

  const setCell = (target, key, v) => {
    if (target === '__global__') setGlobalForm((p) => ({ ...p, [key]: v }));
    else setAgentForms((p) => ({ ...p, [target]: { ...(p[target] || {}), [key]: v } }));
  };

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await putJson('/tools/storage/intervals', toBody(globalForm, agentForms));
      setData((p) => ({ ...p, ...r }));
      fill({ ...data, ...r });
      setMsg((r.issues?.length ? `저장됨(보정 ${r.issues.length}건: ${r.issues.join(' / ')}). ` : '저장되었습니다. ') + (r.note || ''));
    } catch (e) { setMsg(`저장 실패: ${e.message}`); }
    finally { setBusy(false); }
  };

  const Cell = ({ target, form, s }) => {
    const inheritedFrom = target === '__global__' ? null : globalForm[s.key];
    return (
      <select className="input" style={{ minWidth: 104 }} value={form[s.key] ?? ''}
        onChange={(e) => setCell(target, s.key, e.target.value)}
        title={`${s.label}\n하한 ${msLabel(s.min)} · 기본 ${msLabel(s.def)}\n${s.hint}`}>
        <option value="">
          {target === '__global__'
            ? '미지정(엣지 로컬)'
            : `상속(${inheritedFrom ? msLabel(Number(inheritedFrom)) : '엣지 로컬'})`}
        </option>
        {presetsFor(s.min).map((p) => <option key={p.ms} value={String(p.ms)}>{p.label}</option>)}
      </select>
    );
  };

  return (
    <>
      <div className="section-title" style={{ marginTop: 0 }}>⏱ 스토리지 수집 주기</div>

      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 13, lineHeight: 1.7 }}>
          각 법인(엣지)이 스토리지 장비를 얼마나 자주 수집하고 중앙으로 올릴지를 <b>중앙에서</b> 정합니다.
          예전에는 엣지 서버의 <code>portal.env</code> 를 직접 고치고 재시작해야 했습니다.
          <div className="muted" style={{ marginTop: 6 }}>
            • <b>미지정</b>은 그 엣지의 로컬 설정(portal.env)을 그대로 둔다는 뜻입니다 — 지정한 항목만 배포됩니다.<br />
            • 엣지 반영은 <b>즉시가 아닙니다</b>. 그 엣지의 <b>설정 수신(pull) 주기</b>만큼 걸릴 수 있습니다(중앙은 엣지에 명령을 밀어넣을 수 없는 구조 — 엣지가 가지러 옵니다).<br />
            • 엣지에서 <code>STORAGE_INTERVALS_LOCAL=1</code> 을 켜 두면 그 엣지는 중앙 값을 무시합니다(현장 고정).<br />
            • 하한(수집·push·pull 60초 / 영역 수집 10분)은 서버가 강제합니다. 그 밑으로는 이전 주기가 끝나기 전에 다음 주기가 와서 실효가 없습니다.
          </div>
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th style={{ minWidth: 160 }}>대상</th>
              {spec.map((s) => <th key={s.key} title={s.hint}>{s.label}</th>)}
              <th title="장비 수집 주기 + 중앙 전송(push) 주기 — 장비의 변화가 중앙 화면에 늦어도 이만큼 안에 보인다는 뜻.">중앙 반영 지연(최대)</th>
            </tr>
          </thead>
          <tbody>
            <tr style={{ background: 'var(--panel-2, rgba(127,127,127,.08))' }}>
              <td><b>전역 기본</b><div className="muted" style={{ fontSize: 11 }}>모든 엣지 + 중앙에 적용(개별 지정이 우선)</div></td>
              {spec.map((s) => <td key={s.key}><Cell target="__global__" form={globalForm} s={s} /></td>)}
              <td className="muted">{lagText(effectiveFor(globalForm, {}), envDefaults)}</td>
            </tr>
            {targets.map((t) => {
              const form = agentForms[t.key] || {};
              const eff = effectiveFor(globalForm, form);
              return (
                <tr key={t.key || '__central__'}>
                  <td><b>{t.label}</b><div className="muted" style={{ fontSize: 11 }}>{t.hint}</div></td>
                  {spec.map((s) => (
                    <td key={s.key}>
                      <Cell target={t.key} form={form} s={s} />
                      <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                        {sourceOf(s.key, globalForm, form) === 'inherit' ? '엣지 로컬' : `→ ${msLabel(Number(eff[s.key]))}`}
                      </div>
                    </td>
                  ))}
                  <td className="muted">{lagText(eff, envDefaults, { isEdge: t.key !== '' })}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex gap" style={{ marginTop: 12, alignItems: 'center' }}>
        <button className="login-btn" style={{ flex: 'none', padding: '8px 18px' }} disabled={busy} onClick={save}>
          {busy ? '저장 중…' : '저장'}
        </button>
        <button className="tab" style={{ flex: 'none', padding: '8px 14px' }} disabled={busy} onClick={load}>되돌리기</button>
        {msg && <span className="muted" style={{ fontSize: 12 }}>{msg}</span>}
      </div>

      {/* 중앙 자신이 지금 쓰는 값 — '설정은 했는데 뭐가 먹고 있나'를 확인하는 창구.
          엣지의 실효값은 여기서 알 수 없다(엣지가 스스로 적용) — 스토리지 화면의 장비별
          수집 시각으로 확인해야 한다. 아는 척하지 않고 그대로 적는다. */}
      <div className="card" style={{ marginTop: 14 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>중앙 포탈이 지금 쓰는 값</div>
        <div className="flex gap wrap" style={{ fontSize: 12 }}>
          {(data.central?.effective || []).map((e) => (
            <span key={e.key} className="badge" title={`출처: ${e.from === 'central' ? '중앙 설정' : e.from === 'env' ? 'portal.env' : '코드 기본값'}`}>
              {e.label} <b>{msLabel(e.ms)}</b>
              <span className="muted"> ({e.from === 'central' ? '중앙 설정' : e.from === 'env' ? 'env' : '기본'})</span>
            </span>
          ))}
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
          엣지가 실제로 어떤 주기로 돌고 있는지는 이 화면에서 알 수 없습니다(엣지가 스스로 적용).
          특수기능 › 스토리지 모니터링의 장비별 <b>수집 시각</b> 간격으로 확인하세요.
        </div>
      </div>
    </>
  );
}
