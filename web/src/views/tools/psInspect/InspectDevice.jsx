/**
 * InspectDevice — ② 장비 점검 결과(설계 시안 ②). 20항목 표(결과 · 본 값 · 기준 · 읽는 방법 · 출처) + 조치 안내 + 최근 10회 구분 비교 + 이번 실행.
 *  · 데이터는 서버 판정(/tools/ps-inspect/devices/:id) 그대로 — 화면은 다시 판정하지 않는다.
 */
import React from 'react';
import { STable } from '../../../components/STable.jsx';
import Select from '../../../components/Select.jsx';
import { StatusBadge, Refs } from './InspectParts.jsx';
import { GROUP_KO, GROUP_ORDER, kstText, agoText, METHOD_KO, statusText } from './psInspectText.js';

export default function InspectDevice({ devices, id, detail, busy, err, actions, isAdmin, onPick, onRun, running }) {
  const d = detail && String(detail.id) === String(id) ? detail : null;
  const items = d?.items || [];
  const counts = d?.summary || {};
  const hist = [...(d?.history || [])].reverse();
  const todo = items.filter((i) => i.status === 'bad' || i.status === 'warn');
  // 비교는 장비 항목만(포탈 표본 항목 — 디스크 busy · 편중 — 은 뺀다) → 장비 항목이 없는 구분(성능)은 줄을 그리지 않는다.
  const histGroups = GROUP_ORDER.filter((g) => hist.some((h) => h.groups?.[g]));
  return (
    <>
      <div className="psi-bar">
        <span className="psi-lab">장비</span>
        <Select className="select select-sm" value={id || ''} onChange={(e) => onPick(e.target.value)} aria-label="장비" style={{ minWidth: 240 }}>
          {!id && <option value="">장비를 고르세요</option>}
          {(devices || []).map((x) => <option key={x.id} value={x.id}>{x.corpName} · {x.name}</option>)}
        </Select>
        {busy && <span className="psi-muted">불러오는 중…</span>}
        <span className="psi-grow" />
        {isAdmin && d && <button type="button" className="psi-btn primary" disabled={running} onClick={() => onRun([d.id])} title={d.agent ? '그 법인 엣지가 다음 설정 pull 때 받아 점검합니다' : '이 포탈이 바로 점검합니다'}>{running ? '점검 요청 중…' : '이 장비 다시 점검'}</button>}
      </div>
      {err && <div className="psi-banner amber">점검 결과를 불러오지 못했습니다: {String(err?.message || err)}</div>}
      {!id && <div className="psi-note">법인별 현황에서 장비 이름을 누르거나 위에서 고릅니다.</div>}
      {d && (
        <div className="psi-body">
          <div className="psi-main">
            <div className="psi-head" style={{ marginBottom: 6 }}>
              <span className="psi-title">{d.corpName} › {d.name}</span>
              <span className="psi-pill">{/^onefs/i.test(String(d.version || '')) ? d.version : `OneFS ${d.version || '—'}`} · 노드 {d.nodeCount ?? '—'} · {d.agent ? `엣지 ${d.agent}` : '중앙 직접'} · {METHOD_KO[d.method] || d.method}</span>
              <span className="psi-pill">{d.run ? `점검 ${kstText(d.run.at)} · ${Math.round((d.run.ms || 0) / 1000)}초${d.run.partial ? ' · 일부만' : ''}${d.run.staleDays ? ` · ${d.run.staleDays}일 전 — 판정에 쓰지 않음` : ''}` : '아직 점검하지 않음'}</span>
            </div>
            <div className="psi-tablewrap">
              <STable minWidth={1020}>
                <thead><tr>
                  <th style={{ textAlign: 'right' }}>#</th><th>구분</th><th>항목</th><th>결과</th><th>이번 점검에서 본 값</th><th>기준</th><th>읽는 방법(읽기 전용)</th><th data-nosort="1">출처</th>
                </tr></thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.id}>
                      <td className="psi-num" data-sort={String(i.no)}>{i.no}</td>
                      <td data-sort={String(GROUP_ORDER.indexOf(i.group))}>{GROUP_KO[i.group] || i.group}</td>
                      <td><b>{i.label}</b></td>
                      <td data-sort={String({ bad: 0, warn: 1, unknown: 2, ok: 3, na: 4 }[i.status] ?? 9)}><StatusBadge s={i.status} /></td>
                      <td style={{ minWidth: 200, whiteSpace: 'normal' }}>{i.value}{i.why && <div className="psi-muted" style={{ fontSize: 11.5, marginTop: 2 }}>{i.status === 'na' ? '' : '사유: '}{i.why}</div>}</td>
                      <td style={{ minWidth: 170, whiteSpace: 'normal' }}>{i.basis}</td>
                      <td className="psi-mono" style={{ fontSize: 11, minWidth: 190, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{i.how}{i.syntaxUnverified && <span className="psi-pill" style={{ marginLeft: 4, fontSize: 10 }} title="문서 인용을 찾지 못한 명령 — 실장비에서 확인 필요">문법 미확인</span>}</td>
                      <td data-nosort="1"><Refs refs={i.refs} /></td>
                    </tr>
                  ))}
                </tbody>
              </STable>
            </div>
            <div className="psi-note" style={{ marginTop: 6 }}>기준은 Dell 문서에 숫자 · 상태가 있는 것만 씁니다. 노드 CPU 는 Dell 이 기준 숫자를 주지 않아 판정하지 않고 Top 10 표에 값만 싣습니다. 출처 번호는 ‘점검 주기 · 근거’ 보기의 참고 자료 표와 같습니다.</div>
          </div>
          <div className="psi-side">
            <div className="psi-tiles" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
              <div className="psi-tile"><span className="psi-lab">정상</span><b style={{ color: '#4fd1a5' }}>{counts.ok ?? '—'}</b></div>
              <div className="psi-tile"><span className="psi-lab">주의</span><b style={{ color: '#fcd34d' }}>{counts.warn ?? '—'}</b></div>
              <div className="psi-tile"><span className="psi-lab">이상</span><b style={{ color: '#ff9a9d' }}>{counts.bad ?? '—'}</b></div>
              <div className="psi-tile"><span className="psi-lab">확인 불가</span><b>{counts.unknown ?? '—'}</b></div>
            </div>
            <div className="psi-panel">
              <h3>조치 안내</h3>
              {todo.length ? todo.map((i) => <div key={i.id} className="psi-note"><b style={{ color: i.status === 'bad' ? '#ff9a9d' : '#fcd34d' }}>{i.label}({statusText(i.status)})</b> — {actions?.[i.id] || '원인을 확인합니다'}</div>)
                : <div className="psi-note">이상 · 주의 항목이 없습니다.</div>}
              {items.some((i) => i.status === 'unknown') && <div className="psi-note">확인 불가 {items.filter((i) => i.status === 'unknown').length}건은 표의 사유를 봅니다(권한 · 수집 방식 · 명령 판 차이). 포탈은 장비 설정을 바꾸지 않습니다.</div>}
            </div>
            <div className="psi-panel">
              <h3>최근 {hist.length}회 비교 <span className="psi-muted" style={{ fontWeight: 400 }}>· 구분별 가장 나쁜 상태(장비 항목)</span></h3>
              {hist.length ? (
                <>
                  <div className="psi-hist"><span />{hist.map((h) => <span key={h.at} className="wk" title={kstText(h.at, { withYear: true })}>{kstText(h.at).slice(3, 5)}</span>)}{Array.from({ length: Math.max(0, 10 - hist.length) }, (_, k) => <span key={`e${k}`} />)}</div>
                  {histGroups.map((g) => (
                    <div key={g} className="psi-hist"><span>{GROUP_KO[g]}</span>{hist.map((h) => <i key={h.at} className={`c-${h.groups?.[g] || 'na'}`} title={`${kstText(h.at)} — ${statusText(h.groups?.[g])}`} />)}{Array.from({ length: Math.max(0, 10 - hist.length) }, (_, k) => <span key={`e${k}`} />)}</div>
                  ))}
                </>
              ) : <div className="psi-note">이력이 없습니다.</div>}
              {hist.length > 0 && <div className="psi-note" style={{ marginTop: 4 }}>위 숫자는 점검한 날(일)입니다 — 칸에 마우스를 올리면 시각이 보입니다. 성능(디스크 busy · 편중)은 포탈 표본이라 비교에서 뺍니다.</div>}
            </div>
            <div className="psi-panel">
              <h3>이번 실행</h3>
              {d.run ? (
                <div className="psi-note">{METHOD_KO[d.run.method] || d.run.method} · {kstText(d.run.at, { withYear: true })}({agoText(d.run.at)}) · {Math.round((d.run.ms || 0) / 1000)}초. 실패한 단계 {d.run.errors?.length || 0}개{d.run.errors?.length ? ` — ${d.run.errors.slice(0, 4).map((e) => `${e.step}: ${e.error}`).join(' · ')}` : ''}. 전부 조회 명령이고 원본 출력은 중앙에 싣지 않습니다.</div>
              ) : <div className="psi-note">아직 점검하지 않았습니다.</div>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
