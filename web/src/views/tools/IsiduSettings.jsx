/**
 * '아이실론 디렉터리 사용량' 수집 대상 설정 창(v2.736) — 시안 'Settings' 아트보드.
 *
 *  · 대상 = 아이실론(스토리지 등록부에서 고른다 — 주소·담당 엣지·DataCenter 는 등록부가 정한다) + 조사할 디렉터리.
 *    등록부에 없는 장비는 '직접 입력'(주소·계정·담당 노드·DataCenter 를 고른다 — 자유 입력이 아니라 목록에서).
 *  · 인증 = 조사하는 노드의 SSH 키(비밀번호 없음) 또는 스토리지 등록부의 계정. 키 인증이면 그 노드의 공개키를 보여 준다
 *    (메인이면 이 서버 키, 엣지면 그 엣지가 보고한 키 — 보고가 없으면 '보고 없음' 이라 말한다).
 *  · 저장은 목록 전체를 보낸다. 숫자 칸의 빈 값은 보내지 않는다(서버가 이전 값·기본값을 쓴다 — '빈 칸 = 0' 금지).
 *  · 설정을 읽지 못했으면 편집을 잠근다(조회 실패 → 저장 = 데이터 소거 경로 — v2.618 WEB-2).
 *  · 연결 시험은 경로 확인(ls -d)만 한다 — du 는 수십 분 걸릴 수 있어 돌리지 않는다. 엣지 담당 대상은 **그 엣지가** 시험한다
 *    (v2.736 — 메인이 엣지에 요청, iDRAC PUSH 스캔과 같은 길).
 *  · v2.736 실행 노드: 등록부 장비도 '장비 담당 노드 따름' 대신 메인·특정 엣지를 고를 수 있다(등록부 계정 인증은 담당 노드·메인에서만).
 *  · v2.738 결과 메일: 공통 수신자(모든 대상) + 대상별 수신자(여러 명) · 변화 없으면 생략 · 실패 알림(6시간에 한 번). 주소 판정은 서버가 한다
 *    (형식이 틀리면 400 이 칸을 짚는다) — 화면은 입력 중 미리 알려 줄 뿐이다. 메일은 메인만 보낸다(엣지로 주소를 내려보내지 않는다).
 *  · v2.739 '일괄 변경' 탭(IsiduBulk) — 등록된 대상을 골라 설정 항목을 한꺼번에 바꾸고 지금 수집·연결 시험·메일·빼기를 한꺼번에 한다.
 *    개별 편집에 저장하지 않은 변경이 있으면 일괄 적용을 잠근다(적용이 목록을 새로 읽어 그 변경을 지우기 때문이다).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { fetchJson, postJson, putJson } from '../../api.js';
import { Loading, ErrorBox, Modal } from '../../components/ui.jsx';
import Select from '../../components/Select.jsx';
import { requireChanged } from '../changeResult.js';
import IsiduBulk from './IsiduBulk.jsx';
import {
  blankTarget, formFromTarget, targetBody, pathHint, commandText, deviceLabel, keyStatus, INTERVAL_CHOICES, TIMEOUT_CHOICES, everyText,
  RUN_FOLLOW, runSelectValue, runSelectPatch, formRunNode, deviceAuthIssue, testResultText,
  recipientPreview, recipientPreviewText, mailInputIssue, mailReadyText, mailStateText,
} from './isiduText.js';

function KeyBox({ k, agent, reportedAt, onCreate, creating }) {
  const ks = agent && !k ? { text: reportedAt ? '키 정보 없음' : '엣지 보고 없음', tone: 'muted' } : keyStatus(k);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(k.publicKey); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { setCopied(false); }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, borderRadius: 10, background: 'var(--panel-deep)' }}>
      <div className="row" style={{ fontSize: 13 }}>
        <span className={`isd-tag ${ks.tone}`}>{ks.text}</span>
        <span>{agent ? `엣지 ${agent} 의 키` : '메인(이 서버) 의 키'}</span>
        {k?.fingerprint ? <span className="hint" style={{ fontFamily: 'var(--mono)' }}>{k.type} · {k.fingerprint}</span> : null}
      </div>
      {k?.publicKey ? <div className="key">{k.publicKey}</div> : null}
      <div className="row">
        {k?.publicKey ? <button type="button" className="btn2" onClick={copy}>{copied ? '복사했습니다' : '공개키 복사'}</button> : null}
        {!agent && !k?.present ? <button type="button" className="btn2" onClick={onCreate} disabled={creating}>{creating ? '만드는 중…' : '키 만들기'}</button> : null}
        <span className="hint">{agent
          ? (k?.publicKey ? '그 법인 아이실론 계정의 authorized_keys 에 이 공개키를 넣어 두세요.' : '저장하면 엣지가 다음 설정 pull(최대 5분)에 대상을 받고 키를 만든 뒤 공개키를 올립니다.')
          : '아이실론 계정의 authorized_keys 에 이 공개키를 넣어 두세요. 비밀키는 화면에 나오지 않습니다.'}</span>
      </div>
      {k?.error ? <div className="hint bad">{String(k.error)}</div> : null}
    </div>
  );
}

export default function IsiduSettings({ onClose, onSaved, edges = [], mainKey = null, focusId = '', rows = [], initialTab = 'edit' }) {
  const [mtab, setMtab] = useState(initialTab === 'bulk' ? 'bulk' : 'edit');
  const [srv, setSrv] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [forms, setForms] = useState([]);
  const [retention, setRetention] = useState('');
  const [commonTo, setCommonTo] = useState('');   // v2.738 공통 수신자(줄바꿈)
  const [mailing, setMailing] = useState(null);    // { idx, running, result }
  const [sel, setSel] = useState(0);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const [bad, setBad] = useState(null);       // { index, field }
  const [test, setTest] = useState(null);     // { idx, running, result }
  const [key, setKey] = useState(mainKey);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchJson('/tools/isilon-dirusage/settings').then((d) => {
      if (!alive) return;
      setSrv(d); setKey(d.key || mainKey);
      const list = (d.settings?.targets || []).map(formFromTarget);
      setForms(list);
      setRetention(d.settings?.retentionDays ?? '');
      setCommonTo((d.settings?.mail?.commonTo || []).join('\n'));
      const i = list.findIndex((f) => f.id === focusId);
      setSel(i >= 0 ? i : 0);
    }, (e) => { if (alive) setLoadErr(e); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const choices = useMemo(() => srv?.choices || { devices: [], agents: [], datacenters: [] }, [srv]);
  const dcName = useMemo(() => { const m = new Map((choices.datacenters || []).map((d) => [d.id, d.name])); return (id) => m.get(id) || id; }, [choices]);
  const locked = !srv || !!srv.loadError;
  const f = forms[sel] || null;
  const dev = f?.deviceId ? (choices.devices || []).find((d) => d.id === f.deviceId) : null;
  const nodeAgent = formRunNode(f, dev);
  const authIssue = deviceAuthIssue(f, dev);
  const edgeRec = nodeAgent ? (edges || []).find((e) => String(e.agent || '').toLowerCase() === nodeAgent.toLowerCase()) : null;
  const hint = f ? pathHint(f.path) : null;
  const max = srv?.maxTargets || 100;

  const set = (patch) => { setForms((list) => list.map((x, i) => (i === sel ? { ...x, ...patch } : x))); setBad(null); setMsg(null); };
  const add = () => { if (forms.length >= max) return; setForms((l) => [...l, blankTarget()]); setSel(forms.length); setBad(null); setMsg(null); };
  const remove = (i) => {
    const x = forms[i];
    if (!window.confirm(`대상 ‘${x.label || x.path || i + 1}’ 을(를) 목록에서 뺄까요? 저장해야 반영됩니다(이미 쌓인 수집 기록은 보존 기간 동안 남습니다).`)) return;
    setForms((l) => l.filter((_, k) => k !== i)); setSel((s) => Math.max(0, Math.min(s, forms.length - 2))); setBad(null);
  };

  const createKey = async () => {
    setCreating(true);
    try { const r = requireChanged(await postJson('/tools/isilon-dirusage/key', {})); setKey(r.key); } catch (e) { setMsg({ tone: 'bad', text: e?.message || String(e) }); } finally { setCreating(false); }
  };

  const runTest = async () => {
    if (!f) return;
    setTest({ idx: sel, running: true, result: null });
    try {
      // 메일 칸은 연결 시험과 무관하다 — 빼고 보낸다(주소 오타가 시험을 막지 않게. 서버는 없으면 저장값을 쓴다).
      const { mail: _mail, ...body } = targetBody(f);
      const r = await postJson('/tools/isilon-dirusage/test', body);
      setTest({ idx: sel, running: false, result: r });
    } catch (e) {
      setTest({ idx: sel, running: false, result: { ok: false, reason: e?.message || String(e) } });
    }
  };

  // 결과 메일 지금 보내기 — **저장된** 받는 사람에게 보낸다(저장 안 한 입력은 쓰지 않는다 — 화면이 그 사실을 말한다).
  const sendNow = async () => {
    if (!f?.id) return;
    setMailing({ idx: sel, running: true, result: null });
    try {
      const r = await postJson('/tools/isilon-dirusage/mail-now', { id: f.id });
      setMailing({ idx: sel, running: false, result: r });
    } catch (e) {
      setMailing({ idx: sel, running: false, result: { ok: false, reason: e?.message || String(e) } });
    }
  };

  const save = async () => {
    setSaving(true); setMsg(null); setBad(null);
    try {
      const body = { targets: forms.map(targetBody), mail: { commonTo } };
      const n = Number(retention);
      if (String(retention).trim() !== '' && Number.isFinite(n)) body.retentionDays = n;
      const r = await putJson('/tools/isilon-dirusage/settings', body);
      if (r?.ok === false) {
        if (Number.isInteger(r.index)) { setSel(r.index); setBad({ index: r.index, field: r.field || null }); }
        else if (r.field === 'mail.commonTo') setBad({ index: -1, field: 'mail.commonTo' });
        throw new Error(r.reason || '저장하지 못했습니다.');
      }
      requireChanged(r);
      setSrv((cur) => (cur ? { ...cur, settings: r.settings, rev: r.rev ?? cur.rev } : cur));
      setForms((r.settings?.targets || []).map(formFromTarget));
      setRetention(r.settings?.retentionDays ?? retention);
      setCommonTo((r.settings?.mail?.commonTo || []).join('\n'));
      setMsg({ tone: 'ok', text: `저장했습니다(대상 ${r.settings?.targets?.length ?? forms.length}개). 엣지 담당 대상은 그 엣지가 다음 설정 pull 에 받습니다.` });
      onSaved?.();
    } catch (e) {
      setMsg({ tone: 'bad', text: e?.message || String(e) });
    } finally { setSaving(false); }
  };

  const badField = (name) => bad && bad.index === sel && bad.field === name;
  const intervals = [...new Set([...INTERVAL_CHOICES, ...(f && f.intervalHours !== '' ? [Number(f.intervalHours)] : [])])].filter(Number.isFinite).sort((a, b) => a - b);
  const timeouts = [...new Set([...TIMEOUT_CHOICES, ...(f && f.timeoutMin !== '' ? [Number(f.timeoutMin)] : [])])].filter(Number.isFinite).sort((a, b) => a - b);
  const tr = test && test.idx === sel ? test : null;
  const mr = mailing && mailing.idx === sel ? mailing : null;
  const commonIssue = mailInputIssue(commonTo);
  const targetMailIssue = f ? mailInputIssue(f.mailTo) : null;
  const preview = f ? recipientPreview(commonTo, f) : null;
  const readyNote = mailReadyText(srv?.mailReady);
  const failHours = srv?.mailLimits?.failAlertHours ?? 6;
  // 저장하지 않은 변경(개별 편집) — 일괄 적용이 목록을 새로 읽어 그 변경을 지우지 않게 일괄 탭이 이 값을 본다.
  const dirty = useMemo(() => {
    if (!srv) return false;
    const savedT = (srv.settings?.targets || []).map(formFromTarget).map(targetBody);
    if (JSON.stringify(savedT) !== JSON.stringify(forms.map(targetBody))) return true;
    if (String(srv.settings?.retentionDays ?? '') !== String(retention ?? '')) return true;
    return (srv.settings?.mail?.commonTo || []).join('\n') !== commonTo;
  }, [srv, forms, retention, commonTo]);
  const onBulkApplied = (r) => {
    setSrv((cur) => (cur ? { ...cur, settings: r.settings, rev: r.rev } : cur));
    const list = (r.settings?.targets || []).map(formFromTarget);
    setForms(list);
    setSel((i) => Math.max(0, Math.min(i, list.length - 1)));
    setBad(null); setMsg(null);
    onSaved?.();
  };

  return (
    <Modal title="수집 대상 설정 — 아이실론 디렉터리 사용량" onClose={onClose} width={860}>
      {loadErr ? <ErrorBox error={loadErr} /> : null}
      {!srv && !loadErr ? <Loading /> : null}
      {srv ? (
        <div className="isd-form">
          {srv.loadError ? <div className="result bad">저장된 설정 파일을 읽지 못했습니다 — 저장하면 기존 대상이 사라질 수 있어 편집을 잠갔습니다. 설정 › 서비스 점검에서 기본값으로 확정하거나 손상 보존본을 복구하세요.</div> : null}

          <div className="isd-mtabs" role="tablist" aria-label="설정 보기">
            <button type="button" role="tab" aria-selected={mtab === 'edit'} className={mtab === 'edit' ? 'on' : ''} onClick={() => setMtab('edit')}>개별 편집</button>
            <button type="button" role="tab" aria-selected={mtab === 'bulk'} className={mtab === 'bulk' ? 'on' : ''} onClick={() => setMtab('bulk')}>일괄 변경{forms.length ? ` (${forms.length})` : ''}</button>
          </div>
          {mtab === 'bulk' ? <IsiduBulk srv={srv} rows={rows} dirty={dirty} locked={locked} onApplied={onBulkApplied} /> : null}
          {mtab === 'edit' ? (<>

          <div className="tlist" role="list" aria-label="대상 목록">
            {forms.map((x, i) => (
              <div key={x.id || `new-${i}`} role="listitem" className={`titem${i === sel ? ' on' : ''}`}>
                <div className="meta">
                  <b>{x.label || (x.deviceId ? ((choices.devices || []).find((d) => d.id === x.deviceId)?.name || x.deviceId) : x.host) || `새 대상 ${i + 1}`}{x.enabled === false ? ' · 꺼짐' : ''}</b>
                  <span>{x.path || '(경로 없음)'}</span>
                </div>
                <div className="row">
                  <button type="button" className="btn2" onClick={() => { setSel(i); setBad(null); }} disabled={i === sel} aria-pressed={i === sel}>{i === sel ? '편집 중' : '편집'}</button>
                  <button type="button" className="btn2 danger" onClick={() => remove(i)} disabled={locked}>빼기</button>
                </div>
              </div>
            ))}
            <div className="row">
              <button type="button" className="btn2" onClick={add} disabled={locked || forms.length >= max}>+ 대상 추가</button>
              <span className="hint">{forms.length}/{max}개</span>
            </div>
          </div>

          {f ? (
            <>
              <div className="isd-grid2">
                <label className="fld">이름
                  <input type="text" value={f.label} maxLength={80} onChange={(e) => set({ label: e.target.value })} placeholder="예: 본사 사용자 홈" disabled={locked} />
                </label>
                <label className="fld">아이실론(스토리지 등록부)
                  <Select value={f.deviceId} onChange={(e) => set({ deviceId: e.target.value, ...(e.target.value ? {} : { auth: 'key' }) })} disabled={locked} aria-invalid={badField('deviceId') || undefined}>
                    <option value="">직접 입력(등록부에 없는 장비)</option>
                    {(choices.devices || []).map((d) => <option key={d.id} value={d.id}>{deviceLabel(d, dcName)}</option>)}
                    {f.deviceId && !dev ? <option value={f.deviceId}>{f.deviceId} (등록부에 없음)</option> : null}
                  </Select>
                  {!choices.devices?.length ? <span className="hint">스토리지 등록부에 아이실론이 없습니다 — 설정 › 스토리지에서 등록하거나 직접 입력하세요.</span> : null}
                </label>
              </div>

              <div className="result" style={{ background: 'var(--panel-deep)', color: 'var(--text-dim)' }}>
                실행 노드: <span className={`isd-node${nodeAgent ? ' edge' : ''}`}>{nodeAgent ? `엣지 ${nodeAgent}` : '메인'}</span>{' '}
                {f.deviceId && f.runVia !== 'node' ? '— 등록부의 담당 노드를 따릅니다. 엣지 법인 장비는 그 엣지가 접속하고 결과를 메인으로 올립니다.'
                  : f.deviceId ? `— 실행 노드를 지정했습니다(장비 담당 노드는 ${dev?.agent ? `엣지 ${dev.agent}` : '메인'}). 이 노드가 아이실론에 SSH 로 접속합니다.`
                    : '— 직접 입력 장비는 아래에서 고른 노드가 접속합니다.'}
                {nodeAgent ? ' 지금 수집·연결 시험은 메인이 그 엣지에 바로 요청합니다(iDRAC 스캔과 같은 길).' : ''}
              </div>

              {f.deviceId ? (
                <div className="isd-grid2">
                  <label className="fld">SSH 주소
                    <input type="text" className="mono" value={dev?.host || ''} readOnly disabled />
                  </label>
                  <label className="fld">포트
                    <input type="number" className={`mono${badField('port') ? ' bad' : ''}`} value={f.port} min={1} max={65535} placeholder="22" onChange={(e) => set({ port: e.target.value })} disabled={locked} />
                  </label>
                  <label className="fld">계정
                    <input type="text" className={`mono${badField('username') ? ' bad' : ''}`} value={f.username} maxLength={64} placeholder={dev?.username ? `${dev.username} (등록부 계정)` : 'admin'} onChange={(e) => set({ username: e.target.value })} disabled={locked} />
                  </label>
                  <label className="fld">실행 노드
                    <Select value={runSelectValue(f)} onChange={(e) => set(runSelectPatch(e.target.value))} disabled={locked} aria-invalid={badField('agent') || undefined}>
                      <option value={RUN_FOLLOW}>장비 담당 노드 따름({dev?.agent ? `엣지 ${dev.agent}` : '메인'})</option>
                      <option value="">메인(이 서버)</option>
                      {(choices.agents || []).map((a) => <option key={a} value={a}>엣지 {a}</option>)}
                      {f.runVia === 'node' && f.agent && !(choices.agents || []).includes(f.agent) ? <option value={f.agent}>{f.agent} (목록에 없음)</option> : null}
                    </Select>
                  </label>
                </div>
              ) : (
                <>
                  <div className="isd-grid3">
                    <label className="fld">SSH 주소
                      <input type="text" className={`mono${badField('host') ? ' bad' : ''}`} value={f.host} maxLength={253} placeholder="10.20.1.100" onChange={(e) => set({ host: e.target.value })} disabled={locked} />
                    </label>
                    <label className="fld">포트
                      <input type="number" className={`mono${badField('port') ? ' bad' : ''}`} value={f.port} min={1} max={65535} placeholder="22" onChange={(e) => set({ port: e.target.value })} disabled={locked} />
                    </label>
                    <label className="fld">계정
                      <input type="text" className={`mono${badField('username') ? ' bad' : ''}`} value={f.username} maxLength={64} placeholder="admin" onChange={(e) => set({ username: e.target.value })} disabled={locked} />
                    </label>
                  </div>
                  <div className="isd-grid2">
                    <label className="fld">실행 노드(담당 엣지)
                      <Select value={f.agent} onChange={(e) => set({ agent: e.target.value })} disabled={locked} aria-invalid={badField('agent') || undefined}>
                        <option value="">메인(이 서버)</option>
                        {(choices.agents || []).map((a) => <option key={a} value={a}>엣지 {a}</option>)}
                        {f.agent && !(choices.agents || []).includes(f.agent) ? <option value={f.agent}>{f.agent} (목록에 없음)</option> : null}
                      </Select>
                    </label>
                    <label className="fld">DataCenter(법인)
                      <Select value={f.datacenterId} onChange={(e) => set({ datacenterId: e.target.value })} disabled={locked} aria-invalid={badField('datacenterId') || undefined}>
                        <option value="">(지정 안 함)</option>
                        {(choices.datacenters || []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                        {f.datacenterId && !(choices.datacenters || []).some((d) => d.id === f.datacenterId) ? <option value={f.datacenterId}>{f.datacenterId} (목록에 없음)</option> : null}
                      </Select>
                    </label>
                  </div>
                </>
              )}

              <fieldset>
                <legend>인증</legend>
                <label className="radio">
                  <input type="radio" name="isd-auth" checked={f.auth !== 'device'} onChange={() => set({ auth: 'key' })} disabled={locked} />
                  <span><b>SSH 키(비밀번호 없음)</b> — 조사 노드 서비스 계정의 키로 접속합니다.</span>
                </label>
                {f.auth !== 'device' ? (
                  <KeyBox k={nodeAgent ? (edgeRec?.key || null) : key} agent={nodeAgent} reportedAt={edgeRec?.at || null} onCreate={createKey} creating={creating} />
                ) : null}
                <label className="radio" style={{ color: f.deviceId ? undefined : 'var(--text-faint)' }}>
                  <input type="radio" name="isd-auth" checked={f.auth === 'device'} onChange={() => set({ auth: 'device' })} disabled={locked || !f.deviceId} />
                  <span>스토리지 등록부의 계정 정보로 접속{f.deviceId ? '' : '(등록부 장비를 골랐을 때만)'}</span>
                </label>
                {authIssue ? <span className="hint bad" role="alert">{authIssue}</span> : null}
              </fieldset>

              <label className="fld">조사할 디렉터리
                <input type="text" className={`mono${hint || badField('path') ? ' bad' : ''}`} value={f.path} maxLength={1024} onChange={(e) => set({ path: e.target.value })} disabled={locked} aria-invalid={!!hint || undefined} />
                <span className={`hint${hint ? ' bad' : ''}`}>{hint || '/ifs 아래 절대 경로 · 바로 아래 폴더 하나 = 사용자 하나(예: /ifs/data/workspace/users/aaa → 사용자 aaa)'}</span>
              </label>

              <div className="isd-grid3">
                <label className="fld">크기 표기
                  <Select value={f.sizeMode} onChange={(e) => set({ sizeMode: e.target.value })} disabled={locked} sort={false}>
                    <option value="h">-h (사람용 · 반올림)</option>
                    <option value="k">-k (KB · 정확)</option>
                  </Select>
                </label>
                <label className="fld">주기
                  <Select value={f.intervalHours === '' ? '' : String(f.intervalHours)} onChange={(e) => set({ intervalHours: e.target.value })} disabled={locked} sort={false}>
                    {f.intervalHours === '' ? <option value="">(기본값)</option> : null}
                    {intervals.map((h) => <option key={h} value={String(h)}>{everyText(h)}</option>)}
                  </Select>
                </label>
                <label className="fld">시한
                  <Select value={f.timeoutMin === '' ? '' : String(f.timeoutMin)} onChange={(e) => set({ timeoutMin: e.target.value })} disabled={locked} sort={false}>
                    {f.timeoutMin === '' ? <option value="">(기본값)</option> : null}
                    {timeouts.map((m) => <option key={m} value={String(m)}>{m}분{m === 120 ? ' (기본)' : ''}</option>)}
                  </Select>
                </label>
              </div>
              <div className="isd-grid3">
                <label className="fld">Top N
                  <input type="number" className="mono" value={f.topN} min={5} max={50} placeholder="10" onChange={(e) => set({ topN: e.target.value })} disabled={locked} />
                </label>
                <label className="fld">주기 수집
                  <span className="radio"><input type="checkbox" checked={f.enabled !== false} onChange={(e) => set({ enabled: e.target.checked })} disabled={locked} /> 켜기</span>
                </label>
                <label className="fld" title="du 를 아이실론에서 nohup 으로 띄워 SSH 세션과 뗍니다 — 포탈이 업그레이드·재시작해도 du 가 계속 돌고, 다시 뜬 포탈이 그 결과를 이어 받습니다. 장비의 /tmp/dvc-isidu-<uid> 에 작업 파일을 두고 결과를 받으면 지웁니다.">장비에서 분리 실행
                  <span className="radio"><input type="checkbox" checked={f.detach !== false} onChange={(e) => set({ detach: e.target.checked })} disabled={locked} /> 재시작해도 계속</span>
                </label>
              </div>
              {f.detach !== false ? <div className="hint">분리 실행: 아이실론의 /tmp/dvc-isidu-‘계정 uid’ 에 작업 파일(du 출력·종료코드)을 두고, 결과를 받으면 지웁니다. 받지 못한 작업 파일은 다음 실행이 2일 지난 것을 지웁니다. nohup·/tmp 를 쓸 수 없으면 예전처럼 세션에 묶어 실행합니다.</div> : <div className="hint">분리 실행을 끄면 du 가 SSH 세션에 묶입니다 — 포탈이 업그레이드·재시작하면 그 조사는 처음부터 다시 돕니다(자동 재개).</div>}

              <fieldset>
                <legend>결과 메일</legend>
                <label className="fld">이 대상의 받는 사람(여러 명 — 한 줄에 하나)
                  <textarea className={`mono${targetMailIssue || badField('mail.to') ? ' bad' : ''}`} rows={3} value={f.mailTo} onChange={(e) => set({ mailTo: e.target.value })} disabled={locked} placeholder={'owner@corp.example\nteam@corp.example'} aria-invalid={!!targetMailIssue || badField('mail.to') || undefined} />
                  {targetMailIssue ? <span className="hint bad" role="alert">{targetMailIssue}</span> : null}
                </label>
                <label className="radio"><input type="checkbox" checked={f.mailExcludeCommon} onChange={(e) => set({ mailExcludeCommon: e.target.checked })} disabled={locked} /> <span>공통 받는 사람에게는 보내지 않기(이 대상의 받는 사람에게만)</span></label>
                <label className="radio"><input type="checkbox" checked={f.mailOnlyOnChange} onChange={(e) => set({ mailOnlyOnChange: e.target.checked })} disabled={locked} /> <span>변화 없으면 보내지 않기 — 직전 조사와 상위 폴더·전체 합계가 반올림 범위 안에서 같으면 건너뜁니다</span></label>
                <label className="radio"><input type="checkbox" checked={f.mailOnFailure} onChange={(e) => set({ mailOnFailure: e.target.checked })} disabled={locked} /> <span>조사가 실패하면 알리기({failHours}시간에 한 번까지)</span></label>
                <div className="hint">{recipientPreviewText(preview)} · 조사가 성공할 때마다 보냅니다(메인이 보냅니다 — 엣지 담당 대상도 결과가 메인에 들어오면 보냅니다).</div>
                {readyNote ? <div className="hint bad">{readyNote}</div> : null}
                <div className="row">
                  <button type="button" className="btn2" onClick={sendNow} disabled={locked || !f.id || (mr && mr.running)} title={f.id ? '저장된 받는 사람에게 마지막 성공 결과를 지금 보냅니다' : '저장한 뒤에 보낼 수 있습니다'}>{mr && mr.running ? '보내는 중…' : '마지막 결과 지금 보내기'}</button>
                  {mr && mr.result ? (() => { const v = (mr.result.at ? mailStateText(mr.result) : null) || { tone: mr.result.ok ? 'ok' : 'bad', text: mr.result.reason || (mr.result.ok ? '보냈습니다' : '보내지 못했습니다') }; return <span className={`result ${v.tone === 'muted' ? '' : v.tone}`}>{v.text}</span>; })() : (
                    <span className="hint">{f.id ? '저장된 받는 사람에게 보냅니다(지금 고친 내용은 저장한 뒤에 반영됩니다).' : '새 대상은 저장한 뒤에 보낼 수 있습니다.'}</span>
                  )}
                </div>
              </fieldset>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div className="hint">실행할 명령</div>
                <div className="cmd">{commandText({ username: f.username || dev?.username || '', host: f.deviceId ? (dev?.host || '') : f.host, port: f.port, path: f.path, sizeMode: f.sizeMode })}</div>
                <div className="hint">큰 디렉터리는 du 가 오래 걸리고(10분 이상도 흔합니다 — 시한은 기본 2시간 · 최대 3시간) 아이실론에 읽기 부하를 줍니다. 처음에는 긴 주기(하루마다)로 시작하세요.</div>
              </div>

              <div className="row">
                <button type="button" className="btn2" onClick={runTest} disabled={locked || !!hint || (tr && tr.running)}>{tr && tr.running ? '시험 중…' : '연결 시험(경로 확인만)'}</button>
                {tr && tr.result ? (() => { const v = testResultText(tr.result); return <span className={`result ${v.tone}`}>{v.text}</span>; })() : (
                  <span className="hint">{nodeAgent ? `엣지 ‘${nodeAgent}’ 가 자기 키·등록부로 시험합니다(메인이 요청).` : '메인(이 서버)이 시험합니다.'}</span>
                )}
              </div>
            </>
          ) : <div className="hint">대상을 추가하세요.</div>}

          <div className="isd-grid3">
            <label className="fld">기록 보존(일)
              <input type="number" className="mono" value={retention} min={srv.ranges?.retentionDays?.min || 30} max={srv.ranges?.retentionDays?.max || 3650} onChange={(e) => setRetention(e.target.value)} disabled={locked} />
              <span className="hint">비우면 지금 값을 유지합니다. 대상마다 마지막 성공 수집은 기간이 지나도 남깁니다.</span>
            </label>
          </div>

          <label className="fld">결과 메일 — 공통 받는 사람(모든 대상 · 한 줄에 하나)
            <textarea className={`mono${commonIssue || (bad && bad.field === 'mail.commonTo') ? ' bad' : ''}`} rows={3} value={commonTo} onChange={(e) => { setCommonTo(e.target.value); setBad(null); setMsg(null); }} disabled={locked} placeholder="storage-team@corp.example" aria-invalid={!!commonIssue || undefined} />
            <span className={`hint${commonIssue ? ' bad' : ''}`}>{commonIssue || "대상마다 '공통 받는 사람에게는 보내지 않기' 를 고를 수 있습니다. 같은 주소는 한 번만 보냅니다. 메일 서버와 '아이실론 디렉터리 사용량' 종류는 설정 › 메일 발송에서 켭니다."}</span>
          </label>

          {msg ? <div className={`result ${msg.tone}`}>{msg.text}</div> : null}
          <div className="row" style={{ justifyContent: 'flex-end', borderTop: '1px solid var(--border-soft)', paddingTop: 12 }}>
            {dirty ? <span className="hint" style={{ marginRight: 'auto' }}>저장하지 않은 변경이 있습니다.</span> : null}
            <button type="button" className="btn2" onClick={onClose}>닫기</button>
            <button type="button" className="btn2 primary" onClick={save} disabled={locked || saving}>{saving ? '저장 중…' : '저장'}</button>
          </div>
          </>) : (
            <div className="row" style={{ justifyContent: 'flex-end', borderTop: '1px solid var(--border-soft)', paddingTop: 12 }}>
              <button type="button" className="btn2" onClick={onClose}>닫기</button>
            </div>
          )}
        </div>
      ) : null}
    </Modal>
  );
}
