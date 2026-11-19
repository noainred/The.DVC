/**
 * ServerAccessHier.jsx — 설정 › 보안 › 서버 접속의 **계정 계층**(법인 › OS 종류 › 서버) · **공통 계정** 탭(v3.24 · 설계 docs/design/server-access ⑤ ⑥ ⑧).
 *
 *  · 판정(이 서버가 어느 단계 계정을 쓰는가 · 승인이 살아 있는가 · 닿는 서버 수)은 서버가 한다 — 화면은 응답(source · level · pending · affected)을 그린다.
 *  · 바꾸는 것은 전부 본인 OTP(1회용 — 동작마다 새로). 비밀번호는 보내기만 하고 다시 받지 않는다(보낸 뒤 비운다).
 *  · 저장 전 한 대 확인: 서버가 409 need-verify + candidates 를 주면 그 목록에서 고르게 한다(화면이 대상을 지어내지 않는다).
 *  · 무거운 API 를 폴링하지 않는다(부모가 마운트 1회 + 버튼). 쓰기 뒤 부모 reload.
 */
import React, { useMemo, useState } from 'react';
import { postJson, putJson, delJson } from '../api.js';
import { STable } from '../components/STable.jsx';
import Select from '../components/Select.jsx';
import BoldText from '../components/boldText.jsx';
import { toneVar } from './tools/toneVar.js';
import { errText, must, Chip, Otp, FeaturePicker } from './sshAccessParts.jsx';
import { KEY_MODE_TEXT, dateTime, featuresText } from './sshAccessText.js';
import {
  LEVEL_LABEL, OS_LABEL, accountKindText, buildHierTree, nodeAccount, serverSourceText, accountStopText, passwordAgeText,
  assignableAccounts, serversOfNode, loginNamePreview, familyOf, rotateByInput,
} from './serverAccessText.js';

const AUTH_TEXT = Object.freeze({ '': '키 우선(키가 없으면 비밀번호)', password: '비밀번호 고정' });
const STATE_CHIP = Object.freeze({ set: ['정함', 'ok'], inherit: ['물려받음', 'muted'], empty: ['비움', 'muted'], unknown: ['모름', 'bad'] });
const otpOk = (v) => /^\d{6,8}$/.test(String(v || '').trim());

/* ── 계정 계층(법인 › OS 종류 › 서버) ─────────────────────────────── */
export function HierTab({ v, corpName, reload, say }) {
  const corps = useMemo(() => v.corps || [], [v.corps]);
  const servers = useMemo(() => v.servers || [], [v.servers]);
  const accounts = useMemo(() => v.accounts || [], [v.accounts]);
  const accById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const tree = useMemo(() => buildHierTree({ corps, servers, assign: v.assign, accounts }), [corps, servers, v.assign, accounts]);
  const [sel, setSel] = useState(() => (tree.find((n) => n.kind === 'corp' && n.count) || tree[0] || null)?.id || '');
  const [open, setOpen] = useState(() => new Set(tree.filter((n) => n.kind === 'corp' && n.count).slice(0, 1).map((n) => n.corp)));
  const [picked, setPicked] = useState(() => new Set());
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState('');
  const [edit, setEdit] = useState(null);       // { accountId, auth, verifyId, candidates }
  const [verifyId, setVerifyId] = useState('');
  const [verifyCands, setVerifyCands] = useState(null);
  const [osPick, setOsPick] = useState('detected');
  const [own, setOwn] = useState(null);         // { server, accountId }
  const node = tree.find((n) => n.id === sel) || null;
  const stateUnknown = !Array.isArray(v.assign);
  if (!node) return <p className="ssa-note">법인이 없습니다 — 이 노드가 아는 vCenter 가 없으면 계층을 만들 수 없습니다.</p>;
  const level = node.kind === 'corp' ? 'all' : (node.os === 'none' ? '' : node.os);
  const na = nodeAccount(node.kind === 'corp' ? { corp: node.corp } : { corp: node.corp, os: node.os }, v.assign, accById);
  const allNa = nodeAccount({ corp: node.corp }, v.assign, accById);
  const list = serversOfNode(servers, node);
  const central = list.filter((s) => !s.agent);
  const pickedList = central.filter((s) => picked.has(s.id));
  const choosable = level ? assignableAccounts(accounts, node.corp, level) : [];
  const path = node.kind === 'corp' ? corpName(node.corp) : `${corpName(node.corp)} › ${OS_LABEL[node.os]}`;

  const run = async (label, fn) => {
    if (!otpOk(otp)) { say('본인 OTP(6자리)를 넣으세요 — 바꾸는 동작마다 새 번호가 필요합니다.', 'warn'); return; }
    setBusy(label);
    try { await fn(otp.trim()); } catch (e) {
      const body = e?.body || {};
      if (body.code === 'need-verify' && Array.isArray(body.candidates)) { setVerifyCands(body.candidates); setVerifyId(body.candidates[0]?.id || ''); }
      say(errText(e), 'bad');
    } finally { setBusy(''); setOtp(''); }
  };
  const toggle = (id) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleAll = () => setPicked((p) => (central.every((s) => p.has(s.id)) ? new Set() : new Set(central.map((s) => s.id))));
  const pickNode = (id) => { setSel(id); setPicked(new Set()); setEdit(null); setOwn(null); setVerifyCands(null); };

  const saveAssign = (clear) => run('assign', async (code) => {
    // v3.25(3단계): Windows 단계는 접속 방식(SSH · WinRM HTTPS)과 WinRM 포트를 함께 저장한다(설계 D11)
    const winrm = !clear && level === 'windows' && edit?.via === 'winrm';
    const body = { corp: node.corp, level, accountId: clear ? '' : (edit?.accountId || ''), auth: clear ? '' : (edit?.auth || ''), verifyServerId: verifyId, otp: code,
      ...(winrm ? { via: 'winrm', port: Number(edit.port) || 5986 } : {}) };
    const r = must(await putJson('/settings/ssh-access/assign', body));
    say(clear ? `${path} 단계의 지정을 지웠습니다 — 물려받던 서버 ${r.affected}대는 위 단계 또는 미설정으로 갑니다.`
      : `${path} 단계에 계정을 정했습니다 — 지금 물려받는 서버 ${r.willUse}대${r.verified ? ` · ${r.verified.server} 에서 먼저 확인함` : ''}.`, 'ok');
    setEdit(null); setVerifyCands(null); reload();
  });
  const approve = (clearOwn) => run(clearOwn ? 'reset' : 'approve', async (code) => {
    const ids = pickedList.map((s) => s.id);
    const expectAddrs = Object.fromEntries(pickedList.map((s) => [s.id, s.addr]));
    const expectKeys = Object.fromEntries(pickedList.map((s) => [s.id, s.inheritKey]));   // 본 뒤 OS · 법인이 바뀌었으면 서버가 409
    const r = must(await postJson('/settings/ssh-access/servers/inherit', { ids, expectAddrs, expectKeys, clearOwn, verifyServerId: verifyId, otp: code }));
    say(`${r.approved}대를 ${clearOwn ? '물려받기로 되돌렸습니다' : '물려받도록 승인했습니다'}${r.verified ? ` — ${r.verified.server} 에서 먼저 확인함` : ' — 지금 닿는 계정이 없어 확인하지 않았습니다(위 단계에 계정을 정하면 물려받습니다)'}.`, 'ok');
    setPicked(new Set()); reload();
  });
  const revoke = (s) => run(`revoke:${s.id}`, async (code) => {
    must(await delJson(`/settings/ssh-access/servers/${encodeURIComponent(s.id)}/inherit?otp=${encodeURIComponent(code)}&expectAddr=${encodeURIComponent(s.addr)}`));   // DELETE 는 본문이 없다 — 쿼리로(reauth 규약)
    say(`${s.name} — 물려받기 승인을 거뒀습니다(이 서버는 위 단계 계정을 쓰지 않습니다).`, 'ok'); reload();
  });
  const setOs = () => run('os', async (code) => {
    const r = must(await postJson('/settings/ssh-access/servers/os', { ids: pickedList.map((s) => s.id), os: osPick === 'none' ? '' : osPick, otp: code }));
    say(`OS 종류를 ${r.changed}대 바꿨습니다${r.skipped ? ` · ${r.skipped}대는 그대로(같은 값 · 수집이 알아낸 OS 없음)` : ''}${r.inheritLost ? ` · 승인이 풀린 서버 ${r.inheritLost}대(다시 승인하세요)` : ''}.`, r.inheritLost ? 'warn' : 'ok');
    setPicked(new Set()); reload();
  });
  const saveOwn = () => run('own', async (code) => {
    const r = must(await postJson(`/settings/ssh-access/servers/${encodeURIComponent(own.server.id)}/account`, { accountId: own.accountId, expectAddr: own.server.addr, otp: code }));
    say(`${own.server.name} — 따로 정한 계정으로 접속됨(${r.test?.authKind === 'key' ? '키' : '비밀번호'}).`, 'ok'); setOwn(null); reload();
  });

  const curAcc = na.account;
  const curStop = curAcc ? accountStopText(curAcc.stop) : null;
  const verifyChoices = verifyCands || (level ? central.filter((s) => s.inheritApproved && !s.ownCred).map((s) => ({ id: s.id, name: s.name })) : []);
  return (
    <div className="ssa-main">
    <div className="ssa-split">
      <nav className="ssa-tree sah-tree" aria-label="법인 › OS 종류 › 서버">
        {tree.filter((n) => n.kind === 'corp').map((c) => {
          const kids = tree.filter((n) => n.kind === 'os' && n.corp === c.corp && (n.count || n.os !== 'none'));
          const isOpen = open.has(c.corp);
          const [cl, ct] = STATE_CHIP[c.state];
          return (
            <React.Fragment key={c.id}>
              <button type="button" className={`ssa-node${sel === c.id ? ' on' : ''}`} aria-expanded={isOpen}
                onClick={() => { pickNode(c.id); setOpen((p) => { const n = new Set(p); if (n.has(c.corp) && sel === c.id) n.delete(c.corp); else n.add(c.corp); return n; }); }}>
                <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" style={{ fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }}><path d={isOpen ? 'M3 4.5 L6 7.5 L9 4.5' : 'M4.5 3 L7.5 6 L4.5 9'} /></svg>
                <span className="ssa-node-l"><b>{corpName(c.corp)}</b></span><span className="ssa-sub">{c.count}</span><Chip tone={ct}>{cl}</Chip>
              </button>
              {isOpen && kids.map((k) => {
                const [kl, kt] = STATE_CHIP[k.state];
                return (
                  <React.Fragment key={k.id}>
                    <button type="button" className={`ssa-node d1${sel === k.id ? ' on' : ''}`} onClick={() => pickNode(k.id)}>
                      <span className="ssa-node-l">{OS_LABEL[k.os]}</span><span className="ssa-sub">{k.count}</span>{k.os !== 'none' && <Chip tone={kt}>{kl}</Chip>}
                    </button>
                    {sel === k.id && k.leaves.map((s) => {
                      const st = serverSourceText(s);
                      return <span key={s.id} className="ssa-node d2 sah-leaf" title={st.title}><span className="ssa-node-l">{s.name}</span><span className="ssa-sub" style={{ color: toneVar(st.tone) }}>{st.label}</span></span>;
                    })}
                    {sel === k.id && k.more > 0 && <span className="ssa-node d2 ssa-sub">외 {k.more}대 — 아래 표</span>}
                  </React.Fragment>
                );
              })}
            </React.Fragment>
          );
        })}
        <p className="ssa-sub sah-legend">정함 = 이 단계에 계정을 정함 · 물려받음 = 위 단계 계정이 닿음 · 비움 = 이 단계에는 없음</p>
      </nav>

      <div className="ssa-main">
        <div className="ssa-acts">
          <h4 style={{ margin: 0 }}>{path}</h4>
          <Chip>{node.kind === 'corp' ? '법인 단계' : 'OS 종류 단계'}</Chip><Chip>서버 {list.length}대</Chip>
          {list.length !== central.length && <Chip>엣지가 정하는 서버 {list.length - central.length}대</Chip>}
        </div>
        {stateUnknown && <p className="ssa-banner" style={{ color: toneVar('bad') }}>상태 파일(ssh-access-state.json)을 읽지 못해 계층 지정을 모릅니다 — 그동안 물려받는 서버는 접속하지 않습니다. 키 보안 탭에서 파일을 확인한 뒤 다시 읽으세요.</p>}

        {level ? (
          <section className="ssa-sec">
            <div className="ssa-acts"><h4>이 단계의 계정</h4>{!stateUnknown && <Chip tone={STATE_CHIP[na.state][1]}>{STATE_CHIP[na.state][0]}</Chip>}{curStop && <Chip tone={curStop.tone}>{curStop.label}</Chip>}</div>
            {curAcc ? (
              <dl className="sah-dl">
                <dt>계정</dt><dd><b>{curAcc.name}</b> · {accountKindText(curAcc)} · <code>{curAcc.loginName || curAcc.username}</code>{na.state === 'inherit' && <span className="ssa-sub"> — 법인 단계에서 물려받음</span>}</dd>
                {level === 'windows' && <><dt>접속 방식</dt><dd>{na.assign?.via === 'winrm' ? `WinRM HTTPS · 포트 ${na.assign.port || 5986}(NTLM — 인증서는 장비 신뢰에서 승인)` : 'SSH(OpenSSH Server)'}</dd></>}
                <dt>로그인</dt><dd>{AUTH_TEXT[na.assign?.auth || '']}{curAcc.keyRef ? ` · 기본 키 ${(v.keys || []).find((k) => k.id === curAcc.keyRef)?.name || '없음'}` : ''}</dd>
                <dt>비밀번호</dt><dd>{passwordAgeText(curAcc)}</dd>
                <dt>닿는 서버</dt><dd>{central.filter((s) => s.accountId === curAcc.id && (s.source === 'os' || s.source === 'corp')).length}대 물려받음 · 승인 대기 {central.filter((s) => s.pending).length}대</dd>
              </dl>
            ) : <p className="ssa-note">{na.blockedByOs ? '법인 단계 계정의 OS 가 달라 이 단계에는 닿지 않습니다 — 여기에 계정을 정하세요.' : (node.kind === 'corp' ? '이 법인 단계에는 계정이 없습니다. OS 마다 계정이 다르면 비워 두고 OS 종류 단계에 정합니다.' : '이 단계와 위 단계 모두 계정이 없습니다 — 이 아래 서버는 따로 정한 서버만 접속합니다.')}</p>}
            {!edit ? (
              <div className="ssa-acts">
                <button className="btn btn-sm" type="button" disabled={stateUnknown} onClick={() => setEdit({ accountId: na.state === 'set' ? curAcc?.id || '' : '', auth: na.state === 'set' ? na.assign?.auth || '' : '', via: na.state === 'set' ? na.assign?.via || '' : '', port: na.state === 'set' ? na.assign?.port || '' : '' })}>{na.state === 'set' ? '다른 계정으로 바꾸기' : '여기서 정하기'}</button>
                {na.state === 'set' && <button className="btn btn-sm" type="button" disabled={!!busy} onClick={() => saveAssign(true)}>{busy === 'assign' ? '지우는 중…' : (node.kind === 'corp' ? '지우기' : '위에서 물려받기(지우기)')}</button>}
                {na.state === 'set' && <Otp value={otp} onChange={setOtp} />}
              </div>
            ) : (
              <div className="ssa-form">
                <label className="ssa-field">계정 <Select sort={false} className="select select-sm" value={edit.accountId} onChange={(e) => setEdit({ ...edit, accountId: e.target.value })}>
                  <option value="">고르세요</option>
                  {choosable.map((a) => <option key={a.id} value={a.id}>{a.name} — {accountKindText(a)} · {a.loginName || a.username}{a.corp ? '' : ' (전 법인)'}</option>)}
                </Select></label>
                <label className="ssa-field">로그인 방식 <Select sort={false} className="select select-sm" value={edit.auth} onChange={(e) => setEdit({ ...edit, auth: e.target.value })}>
                  {Object.entries(AUTH_TEXT).map(([k, t]) => <option key={k || 'key'} value={k}>{t}</option>)}
                </Select></label>
                {level === 'windows' && (
                  <label className="ssa-field">접속 방식 <Select sort={false} className="select select-sm" value={edit.via || ''} onChange={(e) => setEdit({ ...edit, via: e.target.value })}>
                    <option value="">SSH</option><option value="winrm">WinRM HTTPS</option>
                  </Select></label>
                )}
                {level === 'windows' && edit.via === 'winrm' && <p className="ssa-note">WinRM 은 NTLMv2 · 비밀번호 로그인만(키 없음) · 서버 인증서는 설정 › 보안 › 장비 신뢰에서 승인한 것만 · Windows 단계를 물려받는 서버에만 닿습니다(따로 정한 서버는 SSH).</p>}
                {level === 'windows' && edit.via === 'winrm' && (
                  <label className="ssa-field">WinRM 포트 <input className="input" inputMode="numeric" value={edit.port || ''} placeholder="5986" onChange={(e) => setEdit({ ...edit, port: e.target.value.replace(/[^0-9]/g, '').slice(0, 5) })} /></label>
                )}
                {verifyChoices.length > 0 && (
                  <label className="ssa-field">먼저 확인할 서버 <Select sort={false} className="select select-sm" value={verifyId} onChange={(e) => setVerifyId(e.target.value)}>
                    <option value="">고르세요</option>
                    {verifyChoices.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </Select></label>
                )}
                <Otp value={otp} onChange={setOtp} />
                <div className="ssa-acts">
                  <button className="btn btn-sm primary" type="button" disabled={!edit.accountId || !!busy} onClick={() => saveAssign(false)}>{busy === 'assign' ? '확인 · 저장 중…' : '확인하고 저장'}</button>
                  <button className="btn btn-sm" type="button" onClick={() => { setEdit(null); setVerifyCands(null); }}>취소</button>
                </div>
                <p className="ssa-note">{level === 'all' ? '법인 단계 계정은 그 계정과 OS 계열이 같은 서버에만 닿습니다(OS 미지정 서버는 Linux 로 봅니다).' : `${LEVEL_LABEL[level]} 계정만 고를 수 있습니다.`} 지금 물려받는 서버가 있으면 그중 한 대로 먼저 로그인해 보고, 실패하면 저장하지 않습니다(다시 시도하지 않습니다).</p>
              </div>
            )}
          </section>
        ) : (
          <section className="ssa-sec">
            <h4>OS 미지정 서버</h4>
            <p className="ssa-note">OS 종류를 정하지 않은 서버는 OS 종류 단계를 건너뛰고 법인 단계 계정(Linux 계열일 때)을 물려받습니다{allNa.account ? ` — 지금 법인 단계: ${allNa.account.name}(${accountKindText(allNa.account)})` : ' — 지금 법인 단계에 계정이 없습니다'}. 아래 표에서 서버를 골라 OS 종류를 정하세요(수집이 알아낸 OS 를 그대로 쓸 수 있습니다).</p>
          </section>
        )}

        {node.kind === 'os' && level && (
          <section className="ssa-sec">
            <div className="ssa-acts"><h4>위 단계 — {corpName(node.corp)}</h4><Chip>{allNa.account ? (na.state === 'set' ? '이 아래에는 닿지 않음' : (na.state === 'inherit' ? '이 아래에 닿음' : 'OS 가 달라 닿지 않음')) : '비움'}</Chip></div>
            <p className="ssa-note">{allNa.account ? `${allNa.account.name} · ${accountKindText(allNa.account)} · ${allNa.account.loginName || allNa.account.username}` : '법인 단계에는 계정이 없습니다.'}{na.state === 'set' && allNa.account ? ' — 이 단계에서 따로 정했으므로 법인 단계 계정은 이 아래 서버에 쓰이지 않습니다.' : ''}</p>
            <div className="ssa-acts"><button className="btn btn-sm" type="button" onClick={() => pickNode(`corp:${node.corp}`)}>법인 단계 보기</button></div>
          </section>
        )}

      </div>
    </div>

        {/* 서버 표는 트리 · 상세 아래 전체 폭(1440px 에서 오른쪽 열이 가려지지 않게) */}
        <section className="ssa-sec">
          <div className="ssa-acts"><h4>{path} — 이 단계 아래 서버 {list.length}대</h4>{pickedList.length > 0 && <Chip tone="ok">{pickedList.length}대 고름</Chip>}</div>
          <div className="ssa-form sah-bar">
            <div className="ssa-acts">
              <button className="btn btn-sm" type="button" disabled={!pickedList.length || !!busy} onClick={() => approve(false)}>{busy === 'approve' ? '확인 · 승인 중…' : '물려받기 승인'}</button>
              <button className="btn btn-sm" type="button" disabled={!pickedList.length || !!busy} onClick={() => approve(true)}>{busy === 'reset' ? '되돌리는 중…' : '물려받기로 되돌리기'}</button>
              <label className="ssa-field sah-inline">OS 종류 <Select sort={false} className="select select-sm" value={osPick} onChange={(e) => setOsPick(e.target.value)}>
                <option value="detected">수집이 알아낸 OS(비어 있는 서버만)</option><option value="linux">Linux</option><option value="windows">Windows</option><option value="none">미지정</option>
              </Select></label>
              <button className="btn btn-sm" type="button" disabled={!pickedList.length || !!busy} onClick={setOs}>{busy === 'os' ? '바꾸는 중…' : 'OS 종류 정하기'}</button>
            </div>
            {verifyChoices.length > 0 && !edit && (
              <label className="ssa-field sah-inline">먼저 확인할 서버 <Select sort={false} className="select select-sm" value={verifyId} onChange={(e) => setVerifyId(e.target.value)}>
                <option value="">고른 서버의 첫 대</option>
                {verifyChoices.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select></label>
            )}
            <Otp value={otp} onChange={setOtp} />
            <p className="ssa-note"><BoldText text={'승인 = 위 단계 계정을 이 서버에 묶는 일이라 **설정 소유자 + 본인 OTP** 가 필요합니다. 승인으로 쓰게 되는 계정마다 서버 한 대에서 먼저 로그인해 보고, 실패하면 아무것도 승인하지 않습니다. 승인 뒤 주소 · 포트 · OS · 법인이 바뀌거나 서버에 따로 계정을 정하면 승인은 저절로 풀립니다.'} /></p>
          </div>
          <STable minWidth={760} className="ssa-t sah-t" limit={200}>
            <thead><tr>
              <th data-nosort><input type="checkbox" aria-label="이 단계 서버 모두 고르기" checked={central.length > 0 && central.every((s) => picked.has(s.id))} onChange={toggleAll} /></th>
              <th>서버</th><th>OS</th><th>계정이 오는 곳</th><th>쓰는 계정 · 로그인</th><th data-nosort>바꾸기</th>
            </tr></thead>
            <tbody>
              {list.map((s) => {
                const st = serverSourceText(s);
                return (
                  <tr key={s.id}>
                    <td data-nosort>{s.agent ? null : <input type="checkbox" aria-label={`${s.name} 고르기`} checked={picked.has(s.id)} onChange={() => toggle(s.id)} />}</td>
                    <td data-sort={s.name}><b>{s.name}</b><div className="ssa-sub"><code>{s.host}{s.port !== 22 ? `:${s.port}` : ''}</code>{s.agent ? ` · 엣지 ${s.agent}` : ''}{s.addrOnly ? ' · 주소만 등록' : ''}</div></td>
                    <td data-sort={s.os || ''}>{s.os ? OS_LABEL[s.os] : <span className="ssa-sub">미지정</span>}{!s.os && s.detectedOs && <div className="ssa-sub">수집: {OS_LABEL[s.detectedOs]}</div>}{s.os && s.detectedOs && s.detectedOs !== s.os && <div className="ssa-sub" style={{ color: toneVar('warn') }}>수집과 다름({OS_LABEL[s.detectedOs]})</div>}</td>
                    <td data-sort={st.label}><Chip tone={st.tone} title={st.title}>{st.label}</Chip>{s.inheritApproved && s.inheritAt && <div className="ssa-sub">승인 {dateTime(s.inheritAt)}{s.inheritBy ? ` · ${s.inheritBy}` : ''}</div>}</td>
                    <td data-sort={s.accountName || ''}>{s.accountMissing ? <Chip tone="bad">계정 없음</Chip> : s.accountName ? <><b>{s.accountName}</b><div className="ssa-sub"><code>{s.loginName || s.username}</code></div></> : <span className="ssa-sub">—</span>}
                      <div className="ssa-sub">{s.via === 'winrm' ? `WinRM HTTPS:${s.viaPort || 5986} · 비밀번호` : <>{KEY_MODE_TEXT[s.keyMode] || s.keyMode}{s.keyName && <> · <code>{s.keyName}</code></>}</>}</div></td>
                    <td data-nosort>
                      {s.agent ? <span className="ssa-sub">그 엣지에서</span> : (
                        <div className="ssa-acts sah-stack">
                          <button className="btn btn-sm" type="button" disabled={!!busy} onClick={() => setOwn({ server: s, accountId: s.source === 'own' ? s.accountId : '' })}>따로 정하기</button>
                          {s.inheritApproved && <button className="btn btn-sm" type="button" disabled={!!busy} onClick={() => revoke(s)}>{busy === `revoke:${s.id}` ? '거두는 중…' : '승인 거두기'}</button>}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!list.length && <tr><td colSpan={6} className="ssa-sub">이 단계 아래에 서버가 없습니다(서버 등록에서 법인을 지정한 서버만 여기 보입니다).</td></tr>}
            </tbody>
          </STable>
          {own && (
            <div className="ssa-form">
              <b>{own.server.name} — 따로 정하기</b>
              <label className="ssa-field">공통 계정 <Select sort={false} className="select select-sm" value={own.accountId} onChange={(e) => setOwn({ ...own, accountId: e.target.value })}>
                <option value="">고르세요</option>
                {accounts.filter((a) => (!a.corp || a.corp === (own.server.vcenterId || '')) && (!own.server.os || familyOf(a) === own.server.os)).map((a) => <option key={a.id} value={a.id}>{a.name} — {accountKindText(a)} · {a.loginName || a.username}</option>)}
              </Select></label>
              <Otp value={otp} onChange={setOtp} />
              <div className="ssa-acts">
                <button className="btn btn-sm primary" type="button" disabled={!own.accountId || !!busy} onClick={saveOwn}>{busy === 'own' ? '접속 확인 중…' : '접속해 보고 저장'}</button>
                <button className="btn btn-sm" type="button" onClick={() => setOwn(null)}>취소</button>
              </div>
              <p className="ssa-note">이 서버만 고른 계정을 씁니다(위 단계를 바꿔도 그대로). 한 번 접속해 보고 실패하면 이전 설정으로 되돌립니다. 키를 이름으로 고정하려면 ‘법인 · 서버(키)’ 탭의 키 고르기를 씁니다.</p>
            </div>
          )}
        </section>
    </div>
  );
}

/* ── 공통 계정(Linux · Windows 로컬 · Windows AD) ───────────────────── */
const blankAcc = { id: '', name: '', corp: '', os: 'linux', logon: 'local', domain: '', username: '', keyRef: '', password: '', rotateBy: '', features: null };

export function AccountsTab({ v, corpName, reload, say }) {
  const accounts = v.accounts || [];
  const servers = v.servers || [];
  const [form, setForm] = useState(null);       // blankAcc 모양 + verifyId · cands
  const [ver, setVer] = useState(null);         // { account, serverId }
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState('');
  const usersOf = (a) => servers.filter((s) => !s.agent && s.accountId === a.id && (s.source === 'own' || s.source === 'os' || s.source === 'corp'));
  const activeKeys = (v.keys || []).filter((k) => k.status === 'active' && !k.folderServer);
  const run = async (label, fn) => {
    if (!otpOk(otp)) { say('본인 OTP(6자리)를 넣으세요 — 바꾸는 동작마다 새 번호가 필요합니다.', 'warn'); return; }
    setBusy(label);
    try { await fn(otp.trim()); } catch (e) {
      const body = e?.body || {};
      if (body.code === 'need-verify' && Array.isArray(body.candidates) && form) setForm((f) => ({ ...f, cands: body.candidates, verifyId: body.candidates[0]?.id || '' }));
      say(errText(e), 'bad');
    } finally { setBusy(''); setOtp(''); }
  };
  const save = () => run('save', async (code) => {
    const f = form;
    const body = { ...(f.id ? { id: f.id } : {}), name: f.name.trim(), corp: f.corp, os: f.os, logon: f.os === 'windows' ? f.logon : '', domain: f.os === 'windows' && f.logon === 'ad' ? f.domain.trim() : '',
      username: f.username.trim(), keyRef: f.keyRef, features: f.features, rotateBy: f.rotateBy || '', verifyServerId: f.verifyId || '', otp: code, ...(f.password ? { password: f.password } : {}) };
    const r = must(await postJson('/settings/ssh-access/accounts', body));
    say(`${r.account.name} — 저장했습니다${r.verified ? ` · ${r.verified.server} 에서 새 비밀번호로 먼저 확인함` : ''}${r.droppedSecrets?.length ? ' · 계정 종류 · 법인 · 계정명이 바뀌어 저장 비밀 · 기본 키를 이어 쓰지 않았습니다' : ''}.`, 'ok');
    setForm(null); reload();
  });
  const verify = () => run('verify', async (code) => {
    const r = must(await postJson(`/settings/ssh-access/accounts/${encodeURIComponent(ver.account.id)}/verify`, { serverId: ver.serverId, otp: code }));
    say(`${ver.account.name} — ${r.server} 에서 로그인됨${r.resumed ? ' · 계정 정지를 풀었습니다' : ''}${r.stopKept ? ' · 키로 로그인해 비밀번호는 확인하지 못했습니다 — 계정 정지는 그대로입니다(비밀번호로 쓰는 서버로 다시 확인하거나 ‘정지 풀기’)' : ''}.`, r.stopKept ? 'warn' : 'ok'); setVer(null); reload();
  });
  const resume = (a) => run(`resume:${a.id}`, async (code) => {
    must(await delJson(`/settings/ssh-access/accounts/${encodeURIComponent(a.id)}/stop?otp=${encodeURIComponent(code)}`));
    say(`${a.name} — 계정 정지를 풀었습니다(다음 수집부터 이 계정으로 접속합니다).`, 'ok'); reload();
  });
  const edit = (a) => setForm({ ...blankAcc, id: a.id, name: a.name, corp: a.corp || '', os: a.os === 'windows' ? 'windows' : 'linux', logon: a.logon || 'local', domain: a.domain || '',
    username: a.username, keyRef: a.keyRef || '', rotateBy: rotateByInput(a.rotateBy), features: a.features ?? null, hadPassword: !!a.hasPassword });
  const usersOfForm = form?.id ? usersOf({ id: form.id }) : [];
  return (
    <div className="ssa-main">
      <div className="ssa-acts">
        <button className="btn btn-sm primary" type="button" onClick={() => setForm({ ...blankAcc, features: [] })}>공통 계정 추가</button>
        <span className="ssa-sub">비밀번호 · 개인키는 저장한 뒤 다시 보여 주지 않습니다. 새 비밀번호는 자격증명 저장 방식이 ‘암호화’ 일 때만 받습니다.</span>
      </div>
      {v.policyMode && v.policyMode !== 'encrypted' && <p className="ssa-banner" style={{ color: toneVar('warn') }}>자격증명 저장 방식이 암호화가 아니어서 새 공통 비밀번호를 받지 않습니다(키 · 이름 · 허용 기능만 바꿀 수 있습니다).</p>}
      <STable minWidth={860} className="ssa-t sah-t">
        <thead><tr><th>이름</th><th>종류 · 로그인 이름</th><th>법인</th><th>로그인 · 비밀번호</th><th>쓸 수 있는 기능</th><th>쓰는 서버 · 확인</th><th data-nosort>동작</th></tr></thead>
        <tbody>
          {accounts.map((a) => {
            const stp = accountStopText(a.stop);
            const n = usersOf(a).length;
            return (
              <tr key={a.id}>
                <td data-sort={a.name}><b>{a.name}</b>{stp && <div><Chip tone={stp.tone}>{stp.label}</Chip></div>}{stp && a.stop?.current && <div className="ssa-sub">{a.stop.server} · {dateTime(a.stop.at)}</div>}</td>
                <td data-sort={accountKindText(a)}>{accountKindText(a)}<div className="ssa-sub"><code>{a.loginName || a.username}</code></div></td>
                <td data-sort={a.corp || ''}>{a.corp ? corpName(a.corp) : <span className="ssa-sub">전 법인</span>}</td>
                <td data-sort={a.pwAgeDays ?? ''}>{a.keyRef ? `키 ${(v.keys || []).find((k) => k.id === a.keyRef)?.name || '(없음)'}` : (a.hasPassword ? '비밀번호' : '—')}
                  {(a.hasPassword || a.pwSetAt) && <div className="ssa-sub" style={{ color: a.rotateDue ? toneVar('warn') : undefined }}>{passwordAgeText(a)}</div>}</td>
                <td data-sort={a.features == null ? '' : a.features.length}>{a.features == null ? <span className="ssa-sub">제한 없음(예전 방식)</span> : featuresText(a.features, v.features)}</td>
                <td data-sort={n}>{n}대{a.verifiedAt ? <div className="ssa-sub">확인 {a.verifiedOn} · {dateTime(a.verifiedAt)}</div> : <div className="ssa-sub">{a.hasPassword ? '확인 안 함' : ''}</div>}</td>
                <td data-nosort>
                  <div className="ssa-acts sah-stack">
                    <button className="btn btn-sm" type="button" onClick={() => edit(a)}>수정</button>
                    <button className="btn btn-sm" type="button" disabled={!n} onClick={() => setVer({ account: a, serverId: usersOf(a)[0]?.id || '' })}>한 대로 다시 확인</button>
                    {a.stop?.current && <button className="btn btn-sm" type="button" disabled={!!busy} onClick={() => resume(a)}>{busy === `resume:${a.id}` ? '푸는 중…' : '정지 풀기'}</button>}
                  </div>
                </td>
              </tr>
            );
          })}
          {!accounts.length && <tr><td colSpan={7} className="ssa-sub">OS 공통 계정이 없습니다 — ‘공통 계정 추가’ 로 만듭니다.</td></tr>}
        </tbody>
      </STable>
      {accounts.some((a) => a.stop?.current) && <Otp value={otp} onChange={setOtp} />}

      {ver && (
        <div className="ssa-form">
          <b>{ver.account.name} — 한 대로 다시 확인</b>
          <label className="ssa-field">서버 <Select sort={false} className="select select-sm" value={ver.serverId} onChange={(e) => setVer({ ...ver, serverId: e.target.value })}>
            {usersOf(ver.account).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select></label>
          <Otp value={otp} onChange={setOtp} />
          <div className="ssa-acts">
            <button className="btn btn-sm primary" type="button" disabled={!ver.serverId || !!busy} onClick={verify}>{busy === 'verify' ? '확인 중…' : '한 번 로그인해 보기'}</button>
            <button className="btn btn-sm" type="button" onClick={() => setVer(null)}>닫기</button>
          </div>
          <p className="ssa-note">지금 저장된 자격으로 한 번만 로그인합니다(실패해도 다시 시도하지 않습니다). 성공하면 계정 정지를 풀고 확인 기록을 남깁니다.</p>
        </div>
      )}

      {form && (
        <div className="ssa-form sah-accform">
          <b className="sah-wide">{form.id ? `${form.name} — 수정` : '공통 계정 추가'}</b>
          <label className="ssa-field">이름 <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="예: kr-windows-ad" /></label>
          <label className="ssa-field">법인 <Select sort={false} className="select select-sm" value={form.corp} onChange={(e) => setForm({ ...form, corp: e.target.value })}>
            <option value="">전 법인 공용</option>
            {(v.corps || []).map((c) => <option key={c.id} value={c.id}>{corpName(c.id)}</option>)}
          </Select></label>
          <label className="ssa-field">OS <Select sort={false} className="select select-sm" value={form.os} onChange={(e) => setForm({ ...form, os: e.target.value })}>
            <option value="linux">Linux</option><option value="windows">Windows</option>
          </Select></label>
          {form.os === 'windows' && (
            <label className="ssa-field">Windows 로그인 <Select sort={false} className="select select-sm" value={form.logon} onChange={(e) => setForm({ ...form, logon: e.target.value })}>
              <option value="local">로컬 계정</option><option value="ad">AD(도메인) 계정</option>
            </Select></label>
          )}
          {form.os === 'windows' && form.logon === 'ad' && <label className="ssa-field">도메인 <input className="input" value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} placeholder="corp.example 또는 CORP" /></label>}
          <label className="ssa-field">계정명 <input className="input" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="svc-portal" /></label>
          <p className="ssa-sub sah-wide">서버에 보내는 로그인 이름: <code>{loginNamePreview(form) || '—'}</code></p>
          <label className="ssa-field">기본 키(SSH) <Select sort={false} className="select select-sm" value={form.keyRef} onChange={(e) => setForm({ ...form, keyRef: e.target.value })}>
            <option value="">없음(비밀번호)</option>
            {activeKeys.filter((k) => !k.folderCorp || k.folderCorp === form.corp).map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
          </Select></label>
          <label className="ssa-field">{form.hadPassword ? '새 비밀번호(비우면 그대로)' : '비밀번호'} <input className="input" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
          <label className="ssa-field">교체 예정일(선택) <input className="input" type="date" value={form.rotateBy} onChange={(e) => setForm({ ...form, rotateBy: e.target.value })} /></label>
          <div className="sah-wide"><span className="ssa-sub">쓸 수 있는 기능</span><FeaturePicker catalog={v.features} value={form.features} onChange={(x) => setForm({ ...form, features: x })} allowAll={!!form.id} /></div>
          {(form.cands || usersOfForm).length > 0 && form.password && (
            <label className="ssa-field">먼저 확인할 서버 <Select sort={false} className="select select-sm" value={form.verifyId || ''} onChange={(e) => setForm({ ...form, verifyId: e.target.value })}>
              <option value="">고르세요</option>
              {(form.cands || usersOfForm.map((s) => ({ id: s.id, name: s.name }))).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select></label>
          )}
          <Otp value={otp} onChange={setOtp} />
          <div className="ssa-acts sah-wide">
            <button className="btn btn-sm primary" type="button" disabled={!form.name.trim() || !form.username.trim() || !!busy} onClick={save}>{busy === 'save' ? '확인 · 저장 중…' : (form.password && usersOfForm.length ? '확인하고 저장' : '저장')}</button>
            <button className="btn btn-sm" type="button" onClick={() => setForm(null)}>취소</button>
          </div>
          <p className="ssa-note sah-wide">새 비밀번호를 넣고 이 계정을 쓰는 서버가 있으면 그중 한 대로 저장 전에 한 번 로그인해 봅니다 — 실패하면 저장하지 않습니다. 법인 · OS · 로그인 종류 · 도메인 · 계정명을 바꾸면 저장된 비밀번호 · 기본 키를 이어 쓰지 않습니다(새로 넣어야 합니다).</p>
        </div>
      )}
    </div>
  );
}
