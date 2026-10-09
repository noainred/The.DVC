import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchJson, sendJson, putJson } from '../api.js';
import { Loading, ErrorBox } from '../components/ui.jsx';
import { STable } from '../components/STable.jsx';
import Select from '../components/Select.jsx';
import BoldText from '../components/boldText.jsx';
import { unitText } from './unitText.js';
import {
  KIND_LABEL, KINDS, MODE_LABEL, STATE_LABEL, stateTone, stateText, filterPeers, policyNote, countsText,
  approveConfirmText, bulkConfirmText, rejectConfirmText, policyConfirmText, certMetaText, whenText, manualIssue,
  tlsReasonText, rejectApprovable, caBundleView, subsystemModesText, tlsCountsText, exceptionBannerText, rejectAsPeer,
} from './peerTrustText.js';

/**
 * 설정 › 장비 신뢰(SSH 호스트키·TLS 인증서) — 2026-10-09 검토 S-01·S-02(그룹 H). 설정 화면 키 'peer-trust'.
 *
 * 포탈은 등록 장비에 비밀번호를 실어 접속한다. 경로·DNS 를 가로챈 쪽이 자기 서버로 접속을 돌리면 그 비밀번호가 넘어간다.
 * 서버(security/peerTrust.js)가 장비마다 신뢰 지문을 들고 연결이 내민 지문과 대조하고, 이 화면은 그 지문을 관리자가
 * **장비 콘솔 등 별도 경로로 확인한 뒤** 승인·거부·삭제하는 곳이다. TLS 탭은 그룹 I(security/tlsTrust.js)의 상태 —
 * 사설 CA 번들·수집기별 모드·예외·최근 거부 — 를 함께 보여 준다(읽기만, 최근 거부 행에서 바로 승인).
 *
 * 원칙: 바뀐 지문(대기·changed)이 맨 위이고 빨강 · 관찰은 초록이 아니다(미승인) · 값이 없으면 '—' · 폴링하지 않는다
 * (마운트 1회 + 새로고침 버튼 — 장비 접속이 없는 조회지만 같은 화면을 오래 열어 두는 일이 많다) · 표는 STable(정렬·최소폭).
 */
const BASE = '/admin/security/peer-trust';

function Badge({ tone, children, title }) {
  return <span className={`badge ${tone || 'gray'}`} title={title} style={{ whiteSpace: 'nowrap' }}>{children}</span>;
}

function Fp({ fp }) {
  if (!fp) return <span className="muted">—</span>;
  return <code style={{ wordBreak: 'break-all', fontSize: 11.5 }}>{fp}</code>;
}

/** 지문 칸 — 지문 + (SSH 는 알고리즘, TLS 는 주체·발급·만료) */
function FpCell({ v, kind }) {
  if (!v || !v.fp) return <span className="muted">—</span>;
  const meta = kind === 'tls' ? certMetaText(v) : (v.algo || '');
  return (
    <div style={{ minWidth: 0 }}>
      <Fp fp={v.fp} />
      {meta && <div className="muted" style={{ fontSize: 11, whiteSpace: 'normal' }}>{meta}</div>}
    </div>
  );
}

const STATE_FILTERS = [
  ['all', '전체 상태'], ['pending', STATE_LABEL.pending], ['observed', STATE_LABEL.observed],
  ['approved', STATE_LABEL.approved], ['rejected', STATE_LABEL.rejected],
];

/** initialData·initialKind 는 렌더 스모크 테스트용(서버 없이 계약 모양 응답으로 그린다) — 화면은 넘기지 않는다(마운트 때 읽는다). */
export default function PeerTrustSettings({ initialData = null, initialKind = 'ssh' } = {}) {
  // ⚠ 훅은 조기 return 위에 — 렌더 간 훅 개수가 달라지면 React #310 으로 화면 전체가 죽는다(v2.202).
  const [data, setData] = useState(initialData);
  const [loadErr, setLoadErr] = useState(null);
  const [kind, setKind] = useState(KINDS.includes(initialKind) ? initialKind : 'ssh');
  const [stateF, setStateF] = useState('all');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);
  const [manual, setManual] = useState({ host: '', port: '', fp: '' });

  const load = useCallback(async () => {
    try {
      const d = await fetchJson(BASE);
      setData(d);
      setLoadErr(null);
    } catch (e) { setLoadErr(e); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const peers = useMemo(() => filterPeers(data?.peers || [], { kind, state: stateF, q }), [data, kind, stateF, q]);
  const kindTotal = useMemo(() => (data?.peers || []).filter((p) => p.kind === kind).length, [data, kind]);

  if (loadErr && !data) return <ErrorBox error={loadErr} />;
  if (!data) return <Loading />;

  const st = data.status || {};
  const k = st.kinds?.[kind] || {};
  const policy = k.policy || {};
  const counts = k.counts || {};
  const tls = data.tls || null;

  /** 변경 공통 — 서버 사유(400·409 본문)를 그대로 말하고, 성공하면 다시 읽는다. */
  const act = async (key, fn, okText) => {
    setBusy(key);
    setMsg(null);
    try {
      const r = await fn();
      if (r && r.ok === false) setMsg({ tone: 'bad', text: r.reason || '처리하지 못했습니다.' });
      else { setMsg({ tone: 'ok', text: okText }); await load(); }
    } catch (e) {
      setMsg({ tone: 'bad', text: String(e?.message || e) });
    } finally { setBusy(''); }
  };

  const approve = (peer, fp) => {
    if (!window.confirm(approveConfirmText(peer, fp))) return;
    act(`a|${peer.kind}|${peer.host}|${peer.port}`,
      () => sendJson(`${BASE}/approve`, 'POST', { kind: peer.kind, host: peer.host, port: peer.port, fp, confirmVerified: true }),
      `${peer.host}:${peer.port} 지문을 승인했습니다 — 다음 연결부터 이 지문만 신뢰합니다.`);
  };
  const reject = (peer, fp) => {
    if (!window.confirm(rejectConfirmText(peer, fp))) return;
    act(`r|${peer.kind}|${peer.host}|${peer.port}`,
      () => sendJson(`${BASE}/reject`, 'POST', { kind: peer.kind, host: peer.host, port: peer.port, fp }),
      `${peer.host}:${peer.port} 지문을 거부했습니다.`);
  };
  const remove = (peer) => {
    if (!window.confirm(`${KIND_LABEL[peer.kind]} ${peer.host}:${peer.port} 항목을 지웁니다.\n\n다음 연결은 처음 보는 장비로 판정합니다(정책이 '승인된 지문만 허용' 이면 승인 전까지 연결되지 않습니다).`)) return;
    act(`d|${peer.kind}|${peer.host}|${peer.port}`,
      () => sendJson(`${BASE}/remove`, 'POST', { kind: peer.kind, host: peer.host, port: peer.port }),
      `${peer.host}:${peer.port} 항목을 지웠습니다.`);
  };
  const bulk = () => {
    if (!window.confirm(bulkConfirmText(kind, counts.observed || 0))) return;
    act('bulk', () => sendJson(`${BASE}/approve-observed`, 'POST', { kind, confirmVerified: true }), '관찰 지문을 승인했습니다.');
  };
  const nextMode = policy.mode === 'enforce' ? 'observe' : 'enforce';
  const changePolicy = () => {
    if (!window.confirm(policyConfirmText(kind, nextMode))) return;
    act('policy', () => putJson(`${BASE}/policy`, { kind, mode: nextMode }), `${KIND_LABEL[kind]} 정책을 '${MODE_LABEL[nextMode]}' 으로 바꿨습니다.`);
  };
  const manualErr = (manual.host || manual.port || manual.fp) ? manualIssue({ kind, ...manual }) : null;
  const manualApprove = () => {
    const err = manualIssue({ kind, ...manual });
    if (err) { setMsg({ tone: 'bad', text: err }); return; }
    const peer = { kind, host: manual.host.trim(), port: Number(manual.port) };
    const existing = (data.peers || []).find((p) => p.kind === kind && p.host === peer.host.toLowerCase() && p.port === peer.port);
    approve(existing || peer, manual.fp.trim());
  };

  const subLabel = (name) => (tls?.subsystems || []).find((s) => s.subsystem === name)?.label || name;

  return (
    <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
      <div className="muted" style={{ whiteSpace: 'normal' }}>
        포탈은 등록 장비에 비밀번호를 실어 접속합니다. 장비가 내민 SSH 호스트키·TLS 인증서 지문이 승인된 값과 다르면 <b>비밀번호를 보내기 전에</b> 연결을 끊습니다.
        지문은 반드시 장비 콘솔·관리 화면 등 이 포탈이 아닌 경로로 대조한 뒤 승인하세요.
      </div>

      {st.loadError && (
        <div className="banner bad" style={{ whiteSpace: 'normal' }}>
          장비 신뢰 파일을 읽지 못했습니다({st.loadError.code}{st.loadError.detail ? ` · ${st.loadError.detail}` : ''}) — 승인 목록이 없으므로 SSH·TLS 모두 승인된 지문만 허용으로 닫았습니다. 손상 원본은 보존했습니다.
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {KINDS.map((x) => {
          const c = st.kinds?.[x]?.counts || {};
          return (
            <button key={x} type="button" className={`tab${kind === x ? ' active' : ''}`} onClick={() => setKind(x)}>
              {KIND_LABEL[x]}{c.pendingChanged ? ` ⚠${c.pendingChanged}` : ''}
            </button>
          );
        })}
        <button type="button" className="btn" style={{ marginLeft: 'auto' }} onClick={() => { setMsg(null); load(); }} disabled={!!busy}>새로고침</button>
      </div>

      {msg && <div className={`banner ${msg.tone}`} style={{ whiteSpace: 'normal' }}>{msg.text}</div>}
      {loadErr && data && <div className="banner warn" style={{ whiteSpace: 'normal' }}>새로 읽지 못했습니다(아래는 직전 값): {String(loadErr?.message || loadErr)}</div>}

      <div className="card" style={{ padding: 12, display: 'grid', gap: 8, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <b>{KIND_LABEL[kind]} 정책</b>
          <Badge tone={policy.mode === 'enforce' ? 'green' : 'amber'}>{MODE_LABEL[policy.mode] || policy.mode || '—'}</Badge>
          {policy.source === 'env' && <Badge tone="gray">환경변수 {policy.envKey}</Badge>}
          <button type="button" className="btn" onClick={changePolicy} disabled={!!busy || policy.source === 'env'}
            title={policy.source === 'env' ? '환경변수가 정책을 정하고 있습니다' : '설정 소유 계정만 바꿀 수 있습니다'}>
            {nextMode === 'observe' ? '관찰 모드로 바꾸기' : '승인된 지문만 허용으로 바꾸기'}
          </button>
        </div>
        <div style={{ whiteSpace: 'normal' }}><BoldText text={policyNote(kind, policy)} /></div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ color: counts.pendingChanged ? 'var(--red)' : 'inherit' }}>{countsText(counts)}</span>
          {(counts.observed || 0) > 0 && (
            <button type="button" className="btn" onClick={bulk} disabled={!!busy}>관찰 지문 {counts.observed}개 일괄 승인</button>
          )}
        </div>
      </div>

      {kind === 'tls' && <TlsPanel tls={tls} tlsError={data.tlsError} busy={busy} onApprove={(r) => approve(rejectAsPeer(r), r.fingerprint)} subLabel={subLabel} />}

      <div className="card" style={{ padding: 12, display: 'grid', gap: 8, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <b>{KIND_LABEL[kind]} 장비</b>
          <Select className="select" value={stateF} onChange={(e) => setStateF(e.target.value)} sort={false} aria-label="상태로 거르기">
            {STATE_FILTERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
          <input className="input" style={{ minWidth: 0, flex: '1 1 180px', maxWidth: 320 }} placeholder="호스트·지문 검색"
            value={q} onChange={(e) => setQ(e.target.value)} />
          <span className="muted">{peers.length} / {kindTotal}개</span>
        </div>
        {kindTotal === 0 ? (
          <div className="muted" style={{ whiteSpace: 'normal' }}>
            아직 기록된 {KIND_LABEL[kind]}가 없습니다 — 수집기가 장비에 처음 접속하면 지문이 기록됩니다{kind === 'tls' ? '(CA 체인으로 검증된 장비는 기록하지 않습니다)' : ''}.
          </div>
        ) : (
          <STable minWidth={960}>
            <thead>
              <tr><th>상태</th><th>장비</th><th>신뢰 지문</th><th>대기 지문(장비가 내민 값)</th><th>확인</th><th data-nosort>작업</th></tr>
            </thead>
            <tbody>
              {peers.map((p) => {
                const key = `${p.kind}|${p.host}|${p.port}`;
                const changed = p.state === 'pending' && p.pending?.reason === 'changed';
                const candidate = p.pending?.fp || (p.trusted?.state === 'observed' ? p.trusted.fp : '');
                return (
                  <tr key={key} style={changed ? { background: 'rgba(239,68,68,.08)' } : undefined}>
                    <td data-sort={changed ? 0 : p.state === 'pending' ? 1 : p.state === 'observed' ? 2 : p.state === 'rejected' ? 3 : 4}>
                      <Badge tone={stateTone(p)}>{changed ? '⚠ ' : ''}{stateText(p)}</Badge>
                    </td>
                    <td style={{ whiteSpace: 'normal' }}>
                      <code>{p.host}:{p.port}</code>
                      {p.note && <div className="muted" style={{ fontSize: 11 }}>{p.note}</div>}
                    </td>
                    <td style={{ whiteSpace: 'normal', maxWidth: 300 }}>
                      <FpCell v={p.trusted} kind={p.kind} />
                      {p.trusted?.state === 'approved' && p.trusted?.by && <div className="muted" style={{ fontSize: 11 }}>승인 {p.trusted.by} · {whenText(p.trusted.at)}</div>}
                    </td>
                    <td style={{ whiteSpace: 'normal', maxWidth: 300 }}>
                      <FpCell v={p.pending} kind={p.kind} />
                      {p.pending?.at && <div className="muted" style={{ fontSize: 11 }}>{whenText(p.pending.at)}</div>}
                    </td>
                    <td data-sort={p.lastSeen || ''} style={{ whiteSpace: 'normal' }}>
                      <div>{whenText(p.lastSeen)}</div>
                      <div className="muted" style={{ fontSize: 11 }}>처음 {whenText(p.firstSeen)}</div>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {candidate && (
                          <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => approve(p, candidate)}>승인</button>
                        )}
                        {candidate && (
                          <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => reject(p, candidate)}>거부</button>
                        )}
                        <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => remove(p)}>삭제</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </STable>
        )}
      </div>

      <div className="card" style={{ padding: 12, display: 'grid', gap: 8, minWidth: 0 }}>
        <b>{KIND_LABEL[kind]} 지문 직접 등록</b>
        <div className="muted" style={{ whiteSpace: 'normal' }}>
          {kind === 'ssh'
            ? '장비 콘솔에서 ssh-keygen -lf (호스트키 공개키 파일) 로 확인한 SHA256 지문을 입력하세요. 교체 예정 장비를 미리 등록할 때도 씁니다.'
            : '장비 관리 화면·인증서 파일에서 확인한 SHA-256 지문(16진 64자리, 콜론 구분 가능)을 입력하세요.'}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input className="input" style={{ minWidth: 0, flex: '2 1 160px' }} placeholder="호스트(이름·IP)" value={manual.host}
            onChange={(e) => setManual((m) => ({ ...m, host: e.target.value }))} />
          <input className="input" style={{ minWidth: 0, flex: '0 1 90px', width: 90 }} placeholder={kind === 'ssh' ? '22' : '443'} inputMode="numeric" value={manual.port}
            onChange={(e) => setManual((m) => ({ ...m, port: e.target.value }))} />
          <input className="input" style={{ minWidth: 0, flex: '3 1 240px' }} placeholder={kind === 'ssh' ? 'SHA256:…' : 'AB:CD:…'} value={manual.fp}
            onChange={(e) => setManual((m) => ({ ...m, fp: e.target.value }))} />
          <button type="button" className="btn primary" disabled={!!busy || !manual.host || !manual.port || !manual.fp || !!manualErr} onClick={manualApprove}>승인</button>
        </div>
        {manualErr && <div style={{ color: 'var(--amber)', whiteSpace: 'normal' }}>{manualErr}</div>}
      </div>
    </div>
  );
}

/** TLS 탭 — 사설 CA 번들 카드 · 예외 배너 · 수집기별 표 · 최근 거부(행에서 바로 승인). */
function TlsPanel({ tls, tlsError, busy, onApprove, subLabel }) {
  if (!tls) {
    return (
      <div className="banner bad" style={{ whiteSpace: 'normal' }}>
        TLS 검증 상태를 읽지 못했습니다{tlsError ? `(${tlsError})` : ''} — 사설 CA 번들·수집기별 모드·최근 거부를 표시할 수 없습니다.
      </div>
    );
  }
  const cb = caBundleView(tls.caBundle);
  const items = Array.isArray(tls.caBundle?.items) ? tls.caBundle.items : [];
  const ex = exceptionBannerText(tls.exceptions);
  const subs = Array.isArray(tls.subsystems) ? tls.subsystems : [];
  const rejects = Array.isArray(tls.recentRejects) ? tls.recentRejects : [];
  const roots = tls.defaultRoots || {};
  return (
    <>
      {ex && <div className="banner warn" style={{ whiteSpace: 'normal' }}><BoldText text={ex} /></div>}

      <div className="card" style={{ padding: 12, display: 'grid', gap: 6, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <b>사설 CA 번들</b><Badge tone={cb.tone}>{cb.title}</Badge>
        </div>
        {cb.lines.map((l, i) => <div key={i} className={i === 0 ? 'muted' : undefined} style={{ whiteSpace: 'normal', wordBreak: 'break-all' }}>{l}</div>)}
        <div className="muted" style={{ whiteSpace: 'normal' }}>
          기본 신뢰 저장소 인증서 {unitText(Number.isFinite(Number(roots.count)) ? Number(roots.count) : null, '개')}{roots.extraEnv ? '(NODE_EXTRA_CA_CERTS 포함)' : ''} — 번들은 이것에 더해집니다(대체하지 않습니다).
        </div>
        {items.length > 0 && (
          <STable minWidth={720}>
            <thead><tr><th>주체</th><th>발급</th><th>만료</th><th>구분</th><th>SHA-256</th></tr></thead>
            <tbody>
              {items.map((c, i) => (
                <tr key={`${c.fingerprint256 || ''}|${i}`}>
                  <td style={{ whiteSpace: 'normal' }}>{c.subject || '—'}</td>
                  <td style={{ whiteSpace: 'normal' }}>{c.issuer || '—'}</td>
                  <td data-sort={c.validTo ? Date.parse(c.validTo) || '' : ''}>{c.validTo || '—'}{c.expired === true && <> <Badge tone="red">만료</Badge></>}</td>
                  <td>{c.ca ? <Badge tone="green">CA</Badge> : <Badge tone="amber">CA 아님</Badge>}</td>
                  <td style={{ whiteSpace: 'normal', maxWidth: 260 }}><Fp fp={c.fingerprint256} /></td>
                </tr>
              ))}
            </tbody>
          </STable>
        )}
      </div>

      <div className="card" style={{ padding: 12, display: 'grid', gap: 6, minWidth: 0 }}>
        <b>수집기별 TLS 검증</b>
        <div className="muted" style={{ whiteSpace: 'normal' }}>수집기가 장비에 처음 TLS 로 접속한 뒤부터 나타납니다. 횟수는 포탈이 다시 시작하면 0 부터 셉니다.</div>
        {subs.length === 0 ? (
          <div className="muted">아직 장비 TLS 연결 기록이 없습니다.</div>
        ) : (
          <STable minWidth={820}>
            <thead><tr><th>수집기</th><th>모드</th><th>환경변수</th><th>판정 횟수</th><th>마지막 거부</th></tr></thead>
            <tbody>
              {subs.map((s) => (
                <tr key={s.subsystem}>
                  <td>{s.label || s.subsystem}{s.exception && <> <Badge tone="amber">예외</Badge></>}</td>
                  <td style={{ whiteSpace: 'normal' }}>{subsystemModesText(s)}</td>
                  <td style={{ whiteSpace: 'normal' }}>
                    {s.envKey ? <code>{s.envKey}{s.envRaw != null && s.envRaw !== '' ? `=${s.envRaw}` : ''}</code> : <span className="muted">—</span>}
                    {s.unknownEnv && <div style={{ color: 'var(--amber)', fontSize: 11 }}>알 수 없는 값 — 기본(검증)으로 읽었습니다</div>}
                  </td>
                  <td style={{ whiteSpace: 'normal' }}>{tlsCountsText(s.counts)}</td>
                  <td data-sort={s.lastRejectAt || ''}>{whenText(s.lastRejectAt)}</td>
                </tr>
              ))}
            </tbody>
          </STable>
        )}
      </div>

      <div className="card" style={{ padding: 12, display: 'grid', gap: 6, minWidth: 0 }}>
        <b>최근 TLS 거부</b>
        <div className="muted" style={{ whiteSpace: 'normal' }}>최근 거부(최대 50건, 포탈 재시작 시 비워짐)입니다. 승인 전에 장비에서 지문을 확인하세요.</div>
        {rejects.length === 0 ? (
          <div className="muted">최근 거부가 없습니다.</div>
        ) : (
          <STable minWidth={900}>
            <thead><tr><th>시각</th><th>수집기</th><th>장비</th><th>사유</th><th>장비가 내민 지문</th><th data-nosort>작업</th></tr></thead>
            <tbody>
              {rejects.map((r, i) => {
                const ap = rejectApprovable(r);
                return (
                  <tr key={`${r.at}|${r.host}|${r.port}|${i}`}>
                    <td data-sort={r.at || ''}>{whenText(r.at)}</td>
                    <td>{subLabel(r.subsystem)}</td>
                    <td><code>{r.host}:{r.port}</code></td>
                    <td style={{ whiteSpace: 'normal' }}>{tlsReasonText(r)}</td>
                    <td style={{ whiteSpace: 'normal', maxWidth: 280 }}><Fp fp={r.fingerprint} /></td>
                    <td style={{ whiteSpace: 'normal', maxWidth: 220 }}>
                      {ap.ok
                        ? <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => onApprove(r)}>승인</button>
                        : <span className="muted" style={{ fontSize: 11 }}>{ap.why}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </STable>
        )}
      </div>
    </>
  );
}
