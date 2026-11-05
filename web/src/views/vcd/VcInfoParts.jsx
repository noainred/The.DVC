/**
 * views/vcd/VcInfoParts.jsx — vCenter 알람 · 최근 작업 · 권한 목록 카드(v2.898). vCenter 상세(모니터 · 사용 권한)와 VM · 호스트 개체 보기가 함께 쓴다.
 *   값은 서버 캐시(/vcenter-info/*) — 탭을 열 때 1회 + '다시 읽기'(15초 폴링 금지). 판정 · 문구는 vcInfo.js(순수).
 *   권한 목록은 관리자 판본에서만 부른다(아니면 부르지 않고 권한 안내 — 403 을 만들지 않는다).
 */
import React from 'react';
import { can, hasRole, HttpError } from '../../api.js';
import { ErrorBox, Loading } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { useOnce, toolDenied } from './useOnce.js';
import { Card, Note } from './VcdParts.jsx';
import { shortTs } from './vcdTabs.js';
import {
  VC_ALARM_STATUS, TASK_STATE, TASK_REASON, entityTypeText, entityHash, vcAlarmRows, vcAlarmCounts, taskDurText, vcTaskRows, vcTaskCounts, vcPermRows, vcInfoHeadText,
  poolRowsForHost, allocText, SHARE_LEVEL_TEXT, NODE_TYPE_TEXT, UPDATE_STATE, UPDATE_SEVERITY, UPDATE_TYPE, VLCM_STATUS, replicationSummary, vlcmRows, vlcmCounts, vlcmForHost,
} from './vcInfo.js';
import { vcHash } from './vcdRoute.js';
import { dayStamp } from '../../dayStamp.js';

/** 작업 보관 기간 문구 — API 의 limits.keepMs(모르면 '보관 기간'). */
const keepText = (d) => { const ms = d?.limits?.keepMs; return Number.isFinite(ms) && ms > 0 ? `${Math.round(ms / 3_600_000)}시간` : '보관 기간'; };
/** 넓은 표가 든 카드는 격자 한 줄을 다 쓴다(1440px 반폭 카드에서 오른쪽 열이 가려졌다 — Chromium 재판독 · v2.780 과 같은 종류). */
const WIDE = Object.freeze({ gridColumn: '1 / -1' });
const adminOnlyError = () => new HttpError('forbidden', { status: 403, body: { requiredRole: ['admin'], reason: '권한 목록(사용자 · 그룹 · 역할)은 관리자 판본에서만 볼 수 있어 이 칸을 불러오지 않았습니다.' } });

function Target({ vcenterId, type, mref: r, name }) {
  const h = entityHash(vcenterId, type, r);
  const label = name || r || '—';
  return (
    <span style={{ overflowWrap: 'anywhere' }}>
      {h ? <a href={h} className="vcd-more"><b>{label}</b></a> : <b>{label}</b>}
      <span className="muted" style={{ fontSize: 11.5, marginLeft: 6 }}>{entityTypeText(type)}</span>
    </span>
  );
}

function Head({ q, title }) {
  return (
    <div className="vcd-card-h" style={{ flexWrap: 'wrap', rowGap: 6 }}>
      <b>{title}</b><span className="badge blue">vCenter</span>
      {q.data && <span className="muted" style={{ fontSize: 11.5 }}>{vcInfoHeadText(q.data)}</span>}
      <button type="button" className="tab" style={{ flex: 'none', padding: '5px 11px', marginLeft: 'auto' }} onClick={q.reload} disabled={q.loading}>{q.loading ? '불러오는 중…' : '다시 읽기'}</button>
    </div>
  );
}

/** 상태 줄 — 오류(직전 값 유지) · 아직 읽지 않음 · 일부만. */
function Status({ d }) {
  if (!d) return null;
  return (
    <>
      {d.error && d.at && <div className="vcd-note" style={{ color: 'var(--amber, #b45309)' }}>{`마지막 갱신 실패: ${d.error} — 아래는 직전에 읽은 값입니다.`}</div>}
      {d.notCollected && <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>{d.notCollected}</div>}
      {d.omitted > 0 && <Note>{`상한을 넘어 ${d.omitted}건은 받지 않았습니다.`}</Note>}
    </>
  );
}

/** vCenter 트리거된 알람(rootFolder.triggeredAlarmState — 하위 개체 전부). 포탈 규칙 알람과 다른 표다. */
export function VcAlarmsCard({ vcenterId, entityType = null, entity = null, embedded = false, wide = false }) {
  const ok = can('inv.alarms');
  const q = useOnce('/vcenter-info/alarms', { vcenterId }, ok);
  const all = vcAlarmRows(q.data?.items);
  const rows = entity ? all.filter((a) => a.entity === entity && (!entityType || a.entityType === entityType)) : all;
  const c = vcAlarmCounts(rows);
  const body = !ok ? <div style={{ padding: 12 }}><ErrorBox error={toolDenied('알람')} /></div>
    : q.error && !q.data ? <div style={{ padding: 12 }}><ErrorBox error={q.error} /></div>
      : !q.data ? <Loading label="vCenter 알람" /> : (
        <>
          <Status d={q.data} />
          {!q.data.notCollected && (rows.length ? (
            <STable className="v3-table" minWidth={760} limit={200}>
              <thead><tr><th>상태</th><th>알람</th><th>대상</th><th>발생</th><th>확인</th></tr></thead>
              <tbody>
                {rows.map((a, i) => {
                  const [b, t] = VC_ALARM_STATUS[a.status] || ['gray', '—'];
                  return (
                    <tr key={`${a.alarm}-${a.entity}-${i}`}>
                      <td data-sort={a.status || ''}><span className={`badge ${b}`}>{t}</span></td>
                      <td style={{ whiteSpace: 'normal', minWidth: 200 }}>{a.name || <span className="muted mono">{a.alarm || '—'}</span>}</td>
                      <td><Target vcenterId={vcenterId} type={a.entityType} mref={a.entity} name={a.entityName} /></td>
                      <td className="mono" data-sort={a.time == null ? '' : String(a.time)}>{shortTs(a.time)}</td>
                      <td>{a.ack === true ? <span>확인함{a.ackBy ? <span className="muted"> · {a.ackBy}</span> : ''}{a.ackTime ? <span className="muted mono"> · {shortTs(a.ackTime)}</span> : ''}</span> : a.ack === false ? <span className="muted">확인 안 함</span> : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </STable>
          ) : <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>{entity ? '이 개체에 트리거된 vCenter 알람이 없습니다(읽은 시각 기준).' : '트리거된 vCenter 알람이 없습니다(읽은 시각 기준).'}</div>)}
          {q.data.userMasked && <Note>알람을 확인한 사용자 이름은 관리자 판본에서만 보입니다.</Note>}
        </>
      );
  const note = <Note>vCenter 가 스스로 발화한 알람입니다(알람 정의 · 임계값은 vCenter 설정). 포탈 규칙 알람과 별개이고, 확인 · 초기화 같은 동작은 두지 않습니다(조회 전용).</Note>;
  if (embedded) return <>{<Head q={q} title={`vCenter 알람${q.data && !q.data.notCollected ? ` ${c.total}` : ''}`} />}{body}{note}</>;
  return <Card style={wide ? WIDE : undefined} title={`vCenter 알람${q.data && !q.data.notCollected ? ` ${c.total}` : ''}`} badge={c.red ? <span className="badge red">경보 {c.red}</span> : null} sub={q.data ? vcInfoHeadText(q.data) : null}
    more={<button type="button" className="vcd-more" onClick={q.reload} disabled={q.loading}>{q.loading ? '불러오는 중…' : '다시 읽기'}</button>}>{body}{note}</Card>;
}

/** 최근 작업(TaskManager.recentTask + 포탈이 모아 둔 24시간 버퍼). entity 를 주면 그 개체 대상만. */
export function VcTasksCard({ vcenterId, entityType = null, entity = null, embedded = false, wide = false }) {
  const ok = can('inv.alarms');
  const q = useOnce('/vcenter-info/tasks', { vcenterId }, ok);
  const rows = vcTaskRows(q.data?.items, { entityType, entity });
  const c = vcTaskCounts(rows);
  const title = `최근 작업${q.data && !q.data.notCollected ? ` ${c.total}` : ''}`;
  const body = !ok ? <div style={{ padding: 12 }}><ErrorBox error={toolDenied('알람 · 작업')} /></div>
    : q.error && !q.data ? <div style={{ padding: 12 }}><ErrorBox error={q.error} /></div>
      : !q.data ? <Loading label="최근 작업" /> : (
        <>
          <Status d={q.data} />
          {!q.data.notCollected && (rows.length ? (
            <STable className="v3-table" minWidth={entity ? 640 : 780} limit={200}>
              {/* 1440 의 하위 칸 옆 폭(약 950px)에 8열이 넘쳐 '걸린 시간' 이 가려졌다(Chromium 재판독) — 대기 시각은 시작 칸에 합치고 걸린 시간을 상태 옆으로. */}
              <thead><tr><th>작업</th>{!entity && <th>대상</th>}<th>상태</th><th>걸린 시간</th><th>시작한 사용자</th><th>시작</th><th>완료</th></tr></thead>
              <tbody>
                {rows.map((t) => {
                  const [b, s] = TASK_STATE[t.state] || ['gray', '—'];
                  return (
                    <tr key={t.key}>
                      <td className="mono" style={{ whiteSpace: 'normal', minWidth: 150, overflowWrap: 'anywhere' }}>{t.op ? t.op.replace(/\./g, '.\u200b') : '—'}{t.error && <div style={{ fontFamily: 'inherit', fontSize: 12, color: 'var(--red, #b91c1c)' }}>{t.error}</div>}</td>
                      {!entity && <td><Target vcenterId={vcenterId} type={t.entityType} mref={t.entity} name={t.entityName} /></td>}
                      <td data-sort={t.state || ''}>{t.lost ? <span className="badge gray" title="실행 중으로 본 뒤 끝난 모습을 보지 못하고 vCenter 최근 작업에서 사라졌습니다">상태 모름</span> : <span className={`badge ${b}`}>{s}{t.state === 'running' && t.progress != null ? ` ${t.progress}%` : ''}</span>}</td>
                      <td>{taskDurText(t)}</td>
                      <td style={{ overflowWrap: 'anywhere' }}>{t.user || (t.reason && t.reason !== 'user' ? <span className="muted">{TASK_REASON[t.reason]}</span> : '—')}</td>
                      <td className="mono" data-sort={String(t.started ?? t.queued ?? '')} title={t.queued ? `대기 ${shortTs(t.queued)}` : undefined}>
                        {t.started ? shortTs(t.started) : t.queued ? <span className="muted">{`대기 ${shortTs(t.queued)}`}</span> : '—'}
                      </td>
                      <td className="mono" data-sort={t.completed == null ? '' : String(t.completed)}>{shortTs(t.completed)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </STable>
          ) : <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>{`포탈이 모아 둔 최근 ${keepText(q.data)} 작업${entity ? ' 중 이 개체를 대상으로 한 것' : ''}이 없습니다.`}</div>)}
          {q.data.userMasked && <Note>작업을 시작한 사용자 이름은 관리자 판본에서만 보입니다.</Note>}
        </>
      );
  const note = <Note>{`vCenter 의 최근 작업 목록(끝난 뒤 몇 분만 남는다)을 갱신 때마다 모아 최근 ${keepText(q.data)}${q.data?.limits?.max ? ` · ${q.data.limits.max}건` : ''}까지 보관합니다 — 갱신 사이에 시작해 끝난 짧은 작업은 빠질 수 있습니다. 작업 이름은 vCenter 의 작업 식별자(descriptionId)입니다.`}</Note>;
  if (embedded) return <><Head q={q} title={title} />{body}{note}</>;
  return <Card style={wide ? WIDE : undefined} title={title} badge={c.error ? <span className="badge red">실패 {c.error}</span> : null} sub={q.data ? vcInfoHeadText(q.data) : null}
    more={<button type="button" className="vcd-more" onClick={q.reload} disabled={q.loading}>{q.loading ? '불러오는 중…' : '다시 읽기'}</button>}>{body}{note}</Card>;
}

/** 권한 목록(AuthorizationManager.RetrieveAllPermissions) — 관리자 판본만. entity 를 주면 그 개체에 직접 정의된 것만. */
export function VcPermsCard({ vcenterId, entityType = null, entity = null, what = '이 vCenter', wide = false }) {
  const admin = hasRole('admin');
  const q = useOnce('/vcenter-info/perms', { vcenterId }, admin);
  const rows = vcPermRows(q.data?.items, { entityType, entity });
  const roles = Array.isArray(q.data?.roles) ? q.data.roles : [];
  return (
    <Card style={wide ? WIDE : undefined} title={`권한 목록${q.data && !q.data.notCollected ? ` ${rows.length}` : ''}`} badge={<span className="badge amber">관리자 판본</span>} sub={q.data ? vcInfoHeadText(q.data) : null}
      more={admin ? <button type="button" className="vcd-more" onClick={q.reload} disabled={q.loading}>{q.loading ? '불러오는 중…' : '다시 읽기'}</button> : null}>
      {!admin ? <div style={{ padding: 12 }}><ErrorBox error={adminOnlyError()} /></div>
        : q.error && !q.data ? <div style={{ padding: 12 }}><ErrorBox error={q.error} /></div>
          : !q.data ? <Loading label="권한 목록" /> : (
            <>
              <Status d={q.data} />
              {!q.data.notCollected && (rows.length ? (
                <STable className="v3-table" minWidth={720} limit={300}>
                  <thead><tr><th>사용자 · 그룹</th><th>역할</th>{!entity && <th>정의된 개체</th>}<th>하위로 전파</th></tr></thead>
                  <tbody>
                    {rows.map((p, i) => (
                      <tr key={`${p.entity}-${p.principal}-${i}`}>
                        <td style={{ overflowWrap: 'anywhere' }}><b>{p.principal}</b>{p.group === true && <span className="badge gray" style={{ marginLeft: 6 }}>그룹</span>}</td>
                        <td>{p.role || <span className="muted">역할 {p.roleId}</span>}</td>
                        {!entity && <td><Target vcenterId={vcenterId} type={p.entityType} mref={p.entity} name={p.entityName} /></td>}
                        <td>{p.propagate === true ? '예' : p.propagate === false ? '아니요' : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </STable>
              ) : <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>{entity ? `${what}에 직접 정의된 권한이 없습니다 — 상위(폴더 · 데이터센터 · vCenter)에서 전파된 권한은 vCenter › 사용 권한 탭에서 봅니다.` : '정의된 권한이 없다고 보고했습니다.'}</div>)}
              {!entity && roles.length > 0 && (
                <details style={{ padding: '6px 14px 10px' }}>
                  <summary className="muted" style={{ cursor: 'pointer', fontSize: 12.5 }}>{`역할 ${roles.length}개 — 권한 수`}</summary>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                    {roles.map((r) => <span key={r.id} className={`badge ${r.system ? 'gray' : 'blue'}`}>{r.label || r.name || r.id} · {r.privileges}</span>)}
                  </div>
                </details>
              )}
            </>
          )}
      <Note>{entity ? `${what}에 직접 정의된 권한만입니다(상속은 이 목록으로 알 수 없습니다). ` : ''}vCenter 에 정의된 권한(사용자/그룹 · 역할 · 정의 위치 · 전파)입니다. 읽기 전용 — 권한 추가 · 변경은 두지 않습니다.</Note>
    </Card>
  );
}

/* ── ④ Linked Mode · 업데이트 · vLCM(v2.898 — REST 읽기 전용 · 6시간 주기) ─────────────────────────── */
const reloadBtn = (q) => <button type="button" className="vcd-more" onClick={q.reload} disabled={q.loading}>{q.loading ? '불러오는 중…' : '다시 읽기'}</button>;
const gateBody = (ok, q, label) => (!ok ? <div style={{ padding: 12 }}><ErrorBox error={toolDenied(label)} /></div>
  : q.error && !q.data ? <div style={{ padding: 12 }}><ErrorBox error={q.error} /></div> : !q.data ? <Loading label={label} /> : null);

/** 연결된 vCenter Server 시스템(Enhanced Linked Mode) — /api/vcenter/topology/nodes · replication-status. */
export function VcLinkedCard({ vcenterId, wide = false }) {
  const ok = can('inv.hosts');
  const q = useOnce('/vcenter-info/linked', { vcenterId }, ok);
  const d = q.data;
  const nodes = Array.isArray(d?.nodes) ? d.nodes : [];
  const rep = Array.isArray(d?.replication) ? d.replication : [];
  const rs = replicationSummary(rep);
  return (
    <Card style={wide ? WIDE : undefined} title={`연결된 vCenter${d && !d.notCollected ? ` ${nodes.length}` : ''}`} badge={rs.down ? <span className="badge red">복제 파트너 끊김 {rs.down}</span> : null} sub={d ? vcInfoHeadText(d) : null} more={ok ? reloadBtn(q) : null}>
      {gateBody(ok, q, '연결된 vCenter') || (
        <>
          <Status d={d} />
          {!d.notCollected && (
            <>
              {d.domain && <div style={{ padding: '8px 14px 0', fontSize: 12.5 }}>SSO 도메인 <b className="mono">{d.domain}</b></div>}
              {nodes.length ? (
                <STable className="v3-table" minWidth={680}>
                  <thead><tr><th>노드(PNID)</th><th>유형</th><th>포탈 등록</th><th>버전</th><th>복제 파트너</th></tr></thead>
                  <tbody>
                    {nodes.map((n, i) => (
                      <tr key={n.node || `masked-${i}`}>
                        <td className="mono" style={{ overflowWrap: 'anywhere' }}>{n.masked ? <span className="muted" style={{ fontFamily: 'inherit' }}>가려짐(범위 밖 · 미등록)</span> : <b>{n.node}</b>}</td>
                        <td>{NODE_TYPE_TEXT[n.type] || n.type || '—'}</td>
                        <td>{n.portal ? (n.portal.id === vcenterId ? <span className="badge blue">이 vCenter</span> : <a className="vcd-more" href={vcHash(n.portal.id)}>{n.portal.name} →</a>) : <span className="muted">확인 안 됨</span>}</td>
                        <td>{n.portal?.version ? `${n.portal.version}${n.portal.build ? ` · ${n.portal.build}` : ''}` : '—'}</td>
                        <td className="mono" style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{(n.partners || []).map((p) => p || '가려짐').join(' · ') || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </STable>
              ) : <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>구성원을 보고하지 않았습니다.</div>}
              {rep.length > 0 && (
                <div style={{ padding: '8px 14px 0', fontSize: 12.5 }}>
                  {`복제 ${rs.total}쌍 · 파트너 끊김 ${rs.down} · 복제 안 됨 ${rs.notReplicating}${rs.maxLag != null ? ` · 최대 지연 ${rs.maxLag}(변경 수)` : ''}`}
                </div>
              )}
              {d.replError && <Note>{`복제 상태는 읽지 못했습니다: ${d.replError}`}</Note>}
              {d.maskedNodes > 0 && <Note>{`구성원 ${d.maskedNodes}개는 이름을 가렸습니다 — 조회 범위 안 포탈 등록 vCenter 와 짝지어진 노드만 이름을 보입니다(범위 밖 또는 포탈에 등록되지 않은 노드).`}</Note>}
            </>
          )}
        </>
      )}
      <Note>vCenter 가 보고한 같은 SSO 도메인의 구성원입니다. ‘포탈 등록’ 은 노드 이름과 포탈에 등록한 주소가 같을 때만(조회 범위 안) 보이고, 포탈은 발견한 주소로 접속하지 않습니다. 버전 · 빌드는 포탈이 수집한 값입니다(이 API 에는 없습니다).</Note>
    </Card>
  );
}

/** vCenter 어플라이언스 업데이트 — /api/appliance/update · pending?source_type=LAST_CHECK(마지막 확인 결과만 — 새 확인을 일으키지 않는다). */
export function VcUpdatesCard({ vcenterId, wide = false }) {
  const ok = can('inv.hosts');
  const q = useOnce('/vcenter-info/updates', { vcenterId }, ok);
  const d = q.data;
  const pend = Array.isArray(d?.pending) ? d.pending : [];
  const [b, t] = UPDATE_STATE[d?.state] || ['gray', d?.state || '—'];
  return (
    <Card style={wide ? WIDE : undefined} title="vCenter 업데이트" badge={d && !d.notCollected && d.state ? <span className={`badge ${b}`}>{t}</span> : null} sub={d ? vcInfoHeadText(d) : null} more={ok ? reloadBtn(q) : null}>
      {gateBody(ok, q, 'vCenter 업데이트') || (
        <>
          <Status d={d} />
          {!d.notCollected && !(d.error && !d.at) && (
            <>
              <div style={{ padding: '8px 14px 0', fontSize: 12.5 }}>
                {`어플라이언스 버전 ${d.version || '—'} · 저장소 마지막 확인 ${d.lastCheck ? dayStamp(d.lastCheck) : '—'}`}
              </div>
              {pend.length ? (
                <STable className="v3-table" minWidth={720}>
                  <thead><tr><th>버전</th><th>이름</th><th>심각도</th><th>종류</th><th>출시일</th><th>재부팅</th><th>크기</th></tr></thead>
                  <tbody>
                    {pend.map((u) => {
                      const [sb, st] = UPDATE_SEVERITY[u.severity] || ['gray', u.severity || '—'];
                      return (
                        <tr key={u.version}>
                          <td className="mono"><b>{u.version}</b></td>
                          <td style={{ whiteSpace: 'normal', minWidth: 200 }}>{u.name || '—'}</td>
                          <td><span className={`badge ${sb}`}>{st}</span></td>
                          <td>{UPDATE_TYPE[u.type] || u.type || '—'}</td>
                          <td data-sort={u.releaseDate == null ? '' : String(u.releaseDate)}>{u.releaseDate ? dayStamp(u.releaseDate) : '—'}</td>
                          <td>{u.reboot === true ? '필요' : u.reboot === false ? '아니요' : '—'}</td>
                          <td data-sort={u.sizeMB == null ? '' : String(u.sizeMB)}>{u.sizeMB == null ? '—' : `${u.sizeMB.toLocaleString()} MB`}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </STable>
              ) : d.pendingError ? <Note>{`대기 목록을 읽지 못했습니다: ${d.pendingError}`}</Note>
                : <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>마지막 확인에서 적용 가능한 업데이트가 없었습니다.</div>}
            </>
          )}
        </>
      )}
      <Note>vCenter 가 마지막으로 저장소를 확인한 결과만 읽습니다(포탈이 새 확인을 일으키지 않습니다). 이 API 는 vCenter 역할이 아니라 SSO 그룹(읽기 전용 운영 그룹)으로 권한이 정해져, 읽기 전용 수집 계정이면 ‘권한 없음’ 일 수 있습니다. 업데이트 적용은 두지 않습니다(조회 전용).</Note>
    </Card>
  );
}

/** vLCM 이미지 준수 — 클러스터마다 enablement/software(이미지 관리인가) → software/compliance(마지막 스캔 결과). */
export function VcVlcmCard({ vcenterId, wide = false }) {
  const ok = can('inv.hosts');
  const q = useOnce('/vcenter-info/vlcm', { vcenterId }, ok);
  const d = q.data;
  const rows = vlcmRows(d?.items);
  const c = vlcmCounts(rows);
  return (
    <Card style={wide ? WIDE : undefined} title={`vLCM 이미지 준수${d && !d.notCollected ? ` ${c.image}/${c.clusters}` : ''}`} badge={c.nonCompliant ? <span className="badge amber">미준수 {c.nonCompliant}</span> : null} sub={d ? vcInfoHeadText(d) : null} more={ok ? reloadBtn(q) : null}>
      {gateBody(ok, q, 'vLCM 이미지 준수') || (
        <>
          <Status d={d} />
          {!d.notCollected && (rows.length ? (
            <STable className="v3-table" minWidth={760}>
              <thead><tr><th>클러스터</th><th>관리 방식</th><th>준수</th><th>호스트(준수 · 미준수 · 호환 안 됨 · 결과 없음)</th><th>마지막 스캔</th><th>미준수 호스트</th></tr></thead>
              <tbody>
                {rows.map((x) => {
                  const [sb, st] = VLCM_STATUS[x.status] || ['gray', '—'];
                  return (
                    <tr key={x.cluster}>
                      <td><b>{x.name || x.cluster}</b></td>
                      <td>{x.enabled === true ? '이미지' : x.enabled === false ? <span className="muted">베이스라인(이미지 아님)</span> : '—'}</td>
                      <td>{x.error ? <span className="muted" style={{ fontSize: 12 }}>{x.error}</span> : x.enabled === true ? <span className={`badge ${sb}`}>{st}</span> : '—'}</td>
                      <td>{x.counts ? [x.counts.compliant, x.counts.nonCompliant, x.counts.incompatible, x.counts.unavailable].map((n) => (n == null ? '—' : n)).join(' · ') : '—'}</td>
                      <td data-sort={x.scanTime == null ? '' : String(x.scanTime)}>{x.scanTime ? shortTs(x.scanTime) : '—'}</td>
                      <td style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{(x.nc || []).map((h) => h.name || h.id).join(' · ') || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </STable>
          ) : <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>클러스터가 없습니다.</div>)}
          {d?.partial > 0 && <Note>{`이번 갱신은 시한 때문에 클러스터 ${d.partial}개를 읽지 못해 직전 값을 보입니다 — 곧 다시 읽습니다.`}</Note>}
          {d?.omitted > 0 && <Note>{`클러스터 상한을 넘어 ${d.omitted}개는 읽지 않았습니다.`}</Note>}
        </>
      )}
      <Note>마지막 스캔 결과만 읽습니다(포탈이 스캔 · 재조정을 일으키지 않습니다). 베이스라인으로 관리하는 클러스터는 이 API 의 대상이 아닙니다(그 패치 준수는 수집하지 않습니다).</Note>
    </Card>
  );
}

/** 호스트 개체 › 업데이트 — 이 호스트가 속한 클러스터의 이미지 준수 · 이 호스트가 미준수 목록에 있는가. */
export function HostVlcmCard({ vcenterId, host, hostRef }) {
  const ok = can('inv.hosts');
  const q = useOnce('/vcenter-info/vlcm', { vcenterId }, ok);
  const d = q.data;
  const m = d && !d.notCollected ? vlcmForHost(d.items, host, hostRef) : null;
  const [sb, st] = VLCM_STATUS[m?.row?.status] || ['gray', '—'];
  return (
    <Card title="vLCM 이미지 준수" sub={d ? vcInfoHeadText(d) : null} more={ok ? reloadBtn(q) : null}>
      {gateBody(ok, q, 'vLCM 이미지 준수') || (
        <>
          <Status d={d} />
          {!d.notCollected && (!m ? <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>{host?.cluster ? `클러스터 ‘${host.cluster}’ 의 결과가 없습니다.` : '클러스터에 속하지 않은 호스트입니다(vLCM 이미지는 클러스터 단위).'}</div> : (
            <div style={{ padding: '10px 14px', display: 'grid', gap: 6, fontSize: 12.5 }}>
              <div>{`클러스터 ${m.row.name || m.row.cluster} · 관리 방식 ${m.row.enabled === true ? '이미지' : m.row.enabled === false ? '베이스라인(이미지 아님)' : '—'}`}</div>
              {m.row.enabled === true && <div>클러스터 준수 <span className={`badge ${sb}`}>{st}</span>{m.row.scanTime ? <span className="muted"> · 마지막 스캔 {shortTs(m.row.scanTime)}</span> : null}</div>}
              {m.row.enabled === true && <div>{m.nonCompliant ? <span className="badge amber">이 호스트는 미준수 · 호환 안 됨 목록에 있습니다</span> : (m.row.nc || []).length >= (d.limits?.ncMax ?? Infinity) ? <span className="muted">{`미준수 목록이 수집 상한(${d.limits.ncMax})에 걸려 이 호스트를 단정하지 않습니다.`}</span> : '이 호스트는 미준수 목록에 없습니다.'}</div>}
              {m.row.error && <div className="muted">{m.row.error}</div>}
            </div>
          ))}
        </>
      )}
    </Card>
  );
}

/** v2.899: 리소스 풀 예약 · 제한 · 공유(ResourcePool.config — 6시간마다). 호스트 개체 › 리소스 풀. */
export function PoolSettingsCard({ vcenterId, host, poolNames }) {
  const ok = can('inv.hosts');
  const q = useOnce('/vcenter-info/pools', { vcenterId }, ok);
  const d = q.data;
  const r = d && !d.notCollected ? poolRowsForHost(d.items, host, poolNames) : { rows: [], byName: false };
  const sh = (a) => (a ? `${SHARE_LEVEL_TEXT[a.level] || '—'}${a.shares != null ? ` (${a.shares.toLocaleString()})` : ''}` : '—');
  const ex = (a) => (a?.expandable === true ? '예' : a?.expandable === false ? '아니요' : '—');
  return (
    <Card style={WIDE} title={`리소스 풀 설정${d && !d.notCollected ? ` ${r.rows.length}` : ''}`} sub={d ? vcInfoHeadText(d) : null} more={ok ? reloadBtn(q) : null}>
      {gateBody(ok, q, '리소스 풀 설정') || (
        <>
          <Status d={d} />
          {!d.notCollected && (r.rows.length ? (
            <STable className="v3-table" minWidth={860}>
              <thead><tr><th>풀</th><th>CPU 예약</th><th>CPU 제한</th><th>CPU 확장 예약</th><th>CPU 공유</th><th>메모리 예약</th><th>메모리 제한</th><th>메모리 확장 예약</th><th>메모리 공유</th></tr></thead>
              <tbody>
                {r.rows.map((p) => (
                  <tr key={p.ref}>
                    <td><b>{p.name || p.ref}</b>{p.root && <span className="badge gray" style={{ marginLeft: 6 }}>루트</span>}</td>
                    <td data-sort={p.cpu?.res ?? ''}>{allocText(p.cpu?.res, 'MHz')}</td><td data-sort={p.cpu?.limit ?? ''}>{allocText(p.cpu?.limit, 'MHz')}</td><td>{ex(p.cpu)}</td><td>{sh(p.cpu)}</td>
                    <td data-sort={p.mem?.res ?? ''}>{allocText(p.mem?.res, 'GB')}</td><td data-sort={p.mem?.limit ?? ''}>{allocText(p.mem?.limit, 'GB')}</td><td>{ex(p.mem)}</td><td>{sh(p.mem)}</td>
                  </tr>
                ))}
              </tbody>
            </STable>
          ) : <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>이 호스트의 클러스터 · VM 풀 이름과 맞는 리소스 풀이 없습니다.</div>)}
          {r.byName && r.rows.length > 0 && <Note>호스트의 클러스터로 짝짓지 못해 이 호스트 VM 의 풀 이름으로 골랐습니다 — 다른 클러스터의 같은 이름 풀이 섞여 있을 수 있습니다.</Note>}
        </>
      )}
      <Note>vCenter 의 리소스 풀 설정(예약 · 제한 · 공유)입니다. 루트 풀은 클러스터 용량 그 자체라 예약 값이 큽니다. 설정 변경은 두지 않습니다(조회 전용).</Note>
    </Card>
  );
}
