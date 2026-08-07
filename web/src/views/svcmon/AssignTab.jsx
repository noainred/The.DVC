import React, { useEffect, useState } from 'react';
import { fetchJson, putJson, delJson, postJson } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';

/**
 * 엣지 배정 — '어느 엣지가 어느 대상을 점검하는가'를 중앙에서 관리한다.
 *
 * 흐름: 중앙이 트리 범위를 잘라 배정 저장 → 엣지가 5분 주기(또는 즉시)로 받아 적용 →
 * 적용 결과를 ack 로 회신 → **수가 정확히 일치해야 '활성'** 이 된다. 배포만으로 성공을
 * 단정하지 않는 이유: 엣지의 등록 함수는 상한·검증 실패에 예외를 던지지 않고 조용히
 * 0건을 돌려줄 수 있어, ack 없이는 '배포했는데 아무것도 없는' 무음 공백이 성립한다.
 *
 * 이 인스턴스가 SVCMON_ROLE=central 이면 점검을 직접 실행하지 않는다 — 이 화면이
 * 그 사실을 명시해 "왜 결과가 없지?"라는 혼란을 막는다.
 */

const STATE_BADGE = {
  pending: ['배포 대기', 'gray'],
  active: ['활성', 'green'],
  mismatch: ['수 불일치', 'amber'],
  error: ['적용 오류', 'red'],
};

export default function AssignTab({ canEdit }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [done, setDone] = useState('');
  const [form, setForm] = useState({ agent: '', kind: 'infra', path: '', includeSub: true, exceptTrace: true, exceptDomain: true, note: '' });
  const [preview, setPreview] = useState(null);
  const [probe, setProbe] = useState(null);        // { agent, ...결과 } — 통신 진단

  const load = async () => {
    setErr('');
    try { setData(await fetchJson('/svcmon/assign')); }
    catch (e) { setErr(e.message); }
  };
  useEffect(() => { load(); }, []);

  if (!data && !err) return <Loading />;
  const role = data?.role || {};
  const assignments = data?.assignments || [];
  const reporting = data?.reporting || [];

  const exceptTypes = () => [
    ...(form.exceptTrace ? ['trace'] : []),
    ...(form.exceptDomain ? ['domain'] : []),
  ];

  const doPreview = async () => {
    if (!form.agent.trim()) { setErr('엣지를 선택하세요. 목록이 비어 있으면 먼저 설정 > 엣지 토큰에서 개별 토큰을 발급하세요.'); return; }
    setBusy('preview'); setErr(''); setDone('');
    try {
      const r = await putJson(`/svcmon/assign/${encodeURIComponent(form.agent.trim())}`, {
        mode: 'preview', kind: form.kind, path: form.path.trim(), includeSub: form.includeSub, exceptTypes: exceptTypes(),
      });
      if (r.error) { setErr(r.error); return; }
      setPreview(r);
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };

  const doSave = async () => {
    setBusy('save'); setErr('');
    try {
      const r = await putJson(`/svcmon/assign/${encodeURIComponent(form.agent.trim())}`, {
        kind: form.kind, path: form.path.trim(), includeSub: form.includeSub, exceptTypes: exceptTypes(), note: form.note,
      });
      if (r.error) { setErr(r.error); return; }
      setDone(`배정 저장 — ${form.agent} 에 대상 ${r.assignment?.counts?.targets}개 · 점검 ${r.assignment?.counts?.tests}개 (엣지가 다음 주기에 받아 적용하면 '활성'이 됩니다).`);
      setPreview(null);
      await load();
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };

  const doProbe = async (agent) => {
    setBusy(`probe:${agent}`); setErr(''); setProbe(null);
    try {
      const r = await postJson(`/svcmon/edges/${encodeURIComponent(agent)}/probe`, {});
      setProbe({ agent, ...r });
      if (r.error || (r.ok === false)) setErr(r.error || r.reason || '진단 실패');
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };

  const remove = async (agent) => {
    if (!window.confirm(`'${agent}' 배정을 삭제할까요?\n\n엣지에 이미 적용된 대상은 이 삭제로 지워지지 않습니다 — 엣지가 다음 pull 에서 '배정 없음'을 받아도 기존 정의를 유지합니다(감시를 원격에서 임의로 끊지 않습니다).`)) return;
    setBusy('del'); setErr('');
    try {
      const r = await delJson(`/svcmon/assign/${encodeURIComponent(agent)}`);
      if (r.error) { setErr(r.error); return; }
      await load();
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };

  return (
    <div className="flex col gap">
      {err && <ErrorBox message={err} />}
      {done && <div className="svc-ok">{done}</div>}

      <div className={`svc-cap ${role.executes ? 'warn' : 'ok'}`}>
        <b>이 인스턴스의 역할: {role.role === 'central' ? '중앙(실행 안 함)' : role.role === 'edge' ? '엣지(실행)' : '단독(실행+수신)'}</b>
        <div className="svc-cap-why">
          {role.role === 'central'
            ? '이 서버는 점검을 직접 실행하지 않습니다. 여기서 배정한 정의를 엣지가 받아 실행하고 결과를 보고합니다.'
            : role.role === 'edge'
              ? '이 서버는 엣지입니다 — 중앙에서 정의를 받아 실행하고 결과를 보고합니다. 배정 관리는 중앙에서 하세요.'
              : '단독 모드입니다(직접 실행). 모든 점검을 엣지로 옮기려면 중앙에 SVCMON_ROLE=central, 각 엣지에 SVCMON_ROLE=edge 를 설정하세요.'}
        </div>
      </div>

      {canEdit && role.role !== 'edge' && (
        <div className="card" style={{ padding: 14 }}>
          <b>배정 만들기 / 갱신</b>
          <div className="muted" style={{ fontSize: 12, margin: '4px 0 10px' }}>
            중앙 트리의 범위를 잘라 엣지 몫으로 굳힙니다(스냅샷). 같은 엣지에 다시 저장하면 교체됩니다.
          </div>
          <div className="flex gap wrap" style={{ alignItems: 'flex-end' }}>
            <label className="flex col" style={{ gap: 4 }}>
              <span className="muted" style={{ fontSize: 11 }}>엣지 선택 — 토큰이 발급된 엣지만</span>
              {/* 자유 입력을 없앤 이유: 토큰의 agent 이름과 대소문자 하나만 달라도 엣지 pull 이
                  영원히 '배정 없음'을 받는다(조회 키 불일치). 오타가 곧 무음 감시 공백이다. */}
              <select className="select" style={{ minWidth: 220 }} value={form.agent}
                onChange={(e) => { setForm({ ...form, agent: e.target.value }); setPreview(null); }}>
                <option value="">엣지를 선택하세요</option>
                {(data?.candidates || []).map((c) => (
                  <option key={c.agent} value={c.agent}>
                    {c.agent}{c.reporting ? ' · 보고 중' : c.hasToken ? ' · 토큰만 발급됨' : ' · 토큰 없음'}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex col" style={{ gap: 4 }}>
              <span className="muted" style={{ fontSize: 11 }}>구분</span>
              <select className="select" value={form.kind} onChange={(e) => { setForm({ ...form, kind: e.target.value }); setPreview(null); }}>
                <option value="">전체</option><option value="infra">인프라</option><option value="service">서비스</option>
              </select>
            </label>
            <label className="flex col" style={{ gap: 4, flex: 1, minWidth: 240 }}>
              <span className="muted" style={{ fontSize: 11 }}>경로 (비우면 그 구분 전체)</span>
              <input className="input" value={form.path} onChange={(e) => { setForm({ ...form, path: e.target.value }); setPreview(null); }}
                placeholder={'예: A.Infra\\PL (폴란드 대역)'} />
            </label>
            <label className="flex gap" style={{ alignItems: 'center', fontSize: 12 }}>
              <input type="checkbox" checked={form.includeSub} onChange={(e) => { setForm({ ...form, includeSub: e.target.checked }); setPreview(null); }} />
              하위 포함
            </label>
          </div>
          <div className="flex gap wrap" style={{ alignItems: 'center', marginTop: 8, fontSize: 12 }}>
            <span className="muted">엣지로 보내지 않을 유형:</span>
            <label className="flex gap" style={{ alignItems: 'center' }}>
              <input type="checkbox" checked={form.exceptTrace} onChange={(e) => { setForm({ ...form, exceptTrace: e.target.checked }); setPreview(null); }} />
              trace <span className="muted">(traceroute 가 없는 컨테이너·Windows 에서 전면 실패)</span>
            </label>
            <label className="flex gap" style={{ alignItems: 'center' }}>
              <input type="checkbox" checked={form.exceptDomain} onChange={(e) => { setForm({ ...form, exceptDomain: e.target.checked }); setPreview(null); }} />
              domain <span className="muted">(whois 는 외부 인터넷 필요 — 폐쇄망 엣지에서 실패)</span>
            </label>
          </div>
          <div className="flex gap" style={{ marginTop: 10 }}>
            <button className="login-btn" disabled={busy === 'preview'} onClick={doPreview}>
              {busy === 'preview' ? '계산 중…' : '미리보기'}
            </button>
            {preview && (
              <button className="login-btn" disabled={busy === 'save'} onClick={doSave}>
                {busy === 'save' ? '저장 중…' : `대상 ${preview.counts.targets}개 배정`}
              </button>
            )}
          </div>
          {preview && (
            <div className="svc-warn" style={{ marginTop: 8 }}>
              배정될 것: 대상 {preview.counts.targets}개 · 점검 {preview.counts.tests}개
              {preview.exceptTypes?.length ? ` · 제외 유형 ${preview.exceptTypes.join(', ')}` : ''}
              {preview.sample?.some((s) => s.excluded > 0) && ' — 일부 대상의 제외 유형 점검은 엣지로 보내지 않습니다(중앙 정의에는 남습니다).'}
            </div>
          )}
        </div>
      )}

      {probe && probe.ok && (
        <div className="card" style={{ padding: 14 }}>
          <div className="flex between wrap gap" style={{ alignItems: 'center' }}>
            <b>통신 진단 — {probe.agent}</b>
            <button className="tab" onClick={() => setProbe(null)}>닫기</button>
          </div>
          <div className="muted" style={{ fontSize: 11, margin: '4px 0 8px' }}>
            대상 주소는 <b>마지막 보고가 도착한 소스 IP</b> 입니다(엣지가 프록시/NAT 뒤면 그 장비의
            주소). 이 진단이 실패해도 <b>보고가 정상이면 위임은 동작합니다</b> — Active 방식은
            중앙→엣지 접속을 요구하지 않습니다. 살아있음의 진실은 '보고가 오는가'입니다.
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>검사</th><th style={{ width: 90 }}>결과</th><th style={{ width: 100, textAlign: 'right' }}>RTT</th><th>비고</th></tr></thead>
              <tbody>
                <tr>
                  <td>보고 수신 (진실의 원천)</td>
                  <td><span className={`badge ${probe.reporting?.silent ? 'red' : 'green'}`}>{probe.reporting?.silent ? '무보고' : '정상'}</span></td>
                  <td style={{ textAlign: 'right' }}>—</td>
                  <td className="muted">마지막 보고 {probe.reporting?.ageMs != null ? `${Math.round(probe.reporting.ageMs / 1000)}초 전` : '—'}
                    {probe.reporting?.skewMs ? ` · 시계 오차 추정 ≤${Math.round(Math.abs(probe.reporting.skewMs) / 1000)}초` : ''}</td>
                </tr>
                <tr>
                  <td>ping — {probe.sourceIp}</td>
                  <td><span className={`badge ${probe.ping?.status === 'ok' ? 'green' : 'red'}`}>{probe.ping?.status === 'ok' ? '응답' : '무응답'}</span></td>
                  <td style={{ textAlign: 'right' }}>{probe.ping?.ms != null ? `${probe.ping.ms} ms` : '—'}</td>
                  <td className="muted">{probe.ping?.reply || ''}</td>
                </tr>
                <tr>
                  <td>TCP 포트 {probe.portalPort || '—'}</td>
                  {probe.tcp ? (<>
                    <td><span className={`badge ${probe.tcp.status === 'ok' ? 'green' : 'red'}`}>{probe.tcp.status === 'ok' ? '열림' : '닫힘'}</span></td>
                    <td style={{ textAlign: 'right' }}>{probe.tcp?.ms != null ? `${probe.tcp.ms} ms` : '—'}</td>
                    <td className="muted">{probe.tcp?.reply || ''}</td>
                  </>) : (<>
                    <td><span className="badge gray">생략</span></td>
                    <td style={{ textAlign: 'right' }}>—</td>
                    <td className="muted">{probe.tcpNote || ''}</td>
                  </>)}
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card" style={{ padding: 14 }}>
        <div className="flex between wrap gap" style={{ alignItems: 'center', marginBottom: 8 }}>
          <b>배정 목록 ({assignments.length})</b>
          <button className="tab" onClick={load}>새로 고침</button>
        </div>
        <div className="table-wrap" style={{ maxHeight: '40vh' }}>
          <table>
            <thead>
              <tr>
                <th>엣지</th><th style={{ width: 88 }}>상태</th><th>범위</th>
                <th style={{ width: 120, textAlign: 'right' }}>대상 / 점검</th>
                <th style={{ width: 170 }}>엣지 적용(ack)</th><th style={{ width: 140 }}>수정</th><th style={{ width: 70 }} />
              </tr>
            </thead>
            <tbody>
              {assignments.length === 0 && <tr><td colSpan={7} className="center muted" style={{ padding: 22 }}>배정이 없습니다.</td></tr>}
              {assignments.map((a) => {
                const [label, cls] = STATE_BADGE[a.state] || [a.state, 'gray'];
                return (
                  <tr key={a.agent}>
                    <td><b>{a.agent}</b>{!reporting.includes(a.agent) && <span className="badge gray" style={{ marginLeft: 6 }} title="이 엣지의 결과 보고가 아직 없습니다">무보고</span>}</td>
                    <td><span className={`badge ${cls}`}>{label}</span></td>
                    <td>
                      <code style={{ fontSize: 11 }}>{a.scope?.kind || '전체'}{a.scope?.path ? ` · ${a.scope.path}` : ''}</code>
                      {a.exceptTypes?.length > 0 && <div className="muted" style={{ fontSize: 10 }}>제외: {a.exceptTypes.join(', ')}</div>}
                    </td>
                    <td style={{ textAlign: 'right' }}>{a.counts?.targets} / {a.counts?.tests}</td>
                    <td className="muted" style={{ fontSize: 11 }}>
                      {a.ack
                        ? `${a.ack.added}/${a.counts?.targets} 대상 · ${a.ack.tests}/${a.counts?.tests} 점검${a.ack.errors?.length ? ` · 오류 ${a.ack.errors.length}` : ''}`
                        : (a.pulledAt ? '받음 · 적용 회신 대기' : '아직 안 받아감')}
                    </td>
                    <td className="muted" style={{ fontSize: 11 }}>
                      {a.updatedAt ? new Date(a.updatedAt).toLocaleString('ko-KR', { hour12: false }) : '—'}
                      {a.updatedBy && <div>{a.updatedBy}</div>}
                    </td>
                    <td>
                      {canEdit && (
                        <div className="flex gap">
                          <button className="tab" disabled={busy === `probe:${a.agent}`}
                            onClick={() => doProbe(a.agent)}
                            title="마지막 보고의 소스 IP 로 ping·TCP 연결(RTT)을 찍습니다">
                            {busy === `probe:${a.agent}` ? '진단 중…' : '통신 진단'}
                          </button>
                          <button className="tab" disabled={busy === 'del'} onClick={() => remove(a.agent)}>삭제</button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
          '활성'은 엣지가 정의를 받아 적용했고 <b>적용 수가 배정 수와 정확히 일치</b>한다는 뜻입니다.
          '수 불일치'·'적용 오류'는 엣지 쪽 상한·검증에 걸린 것이므로 그대로 두면 그 차이만큼 감시 공백입니다.
        </div>
      </div>
    </div>
  );
}
