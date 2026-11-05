/**
 * views/vcd/VcInfoParts.jsx — vCenter 알람 · 최근 작업 · 권한 목록 카드(v2.897). vCenter 상세(모니터 · 사용 권한)와 VM · 호스트 개체 보기가 함께 쓴다.
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
} from './vcInfo.js';

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
      {d.error && <div className="vcd-note" style={{ color: 'var(--amber, #b45309)' }}>{`마지막 갱신 실패: ${d.error}${d.at ? ' — 아래는 직전에 읽은 값입니다.' : ''}`}</div>}
      {d.notCollected && <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>{d.notCollected}</div>}
      {d.omitted > 0 && <Note>{`상한을 넘어 ${d.omitted}건은 받지 않았습니다.`}</Note>}
    </>
  );
}

/** vCenter 트리거된 알람(rootFolder.triggeredAlarmState — 하위 개체 전부). 포탈 규칙 알람과 다른 표다. */
export function VcAlarmsCard({ vcenterId, entityType = null, entity = null, embedded = false }) {
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
  return <Card title={`vCenter 알람${q.data && !q.data.notCollected ? ` ${c.total}` : ''}`} badge={c.red ? <span className="badge red">경보 {c.red}</span> : null} sub={q.data ? vcInfoHeadText(q.data) : null}
    more={<button type="button" className="vcd-more" onClick={q.reload} disabled={q.loading}>{q.loading ? '불러오는 중…' : '다시 읽기'}</button>}>{body}{note}</Card>;
}

/** 최근 작업(TaskManager.recentTask + 포탈이 모아 둔 24시간 버퍼). entity 를 주면 그 개체 대상만. */
export function VcTasksCard({ vcenterId, entityType = null, entity = null, embedded = false }) {
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
            <STable className="v3-table" minWidth={880} limit={200}>
              <thead><tr><th>작업</th>{!entity && <th>대상</th>}<th>상태</th><th>시작한 사용자</th><th>대기</th><th>시작</th><th>완료</th><th>걸린 시간</th></tr></thead>
              <tbody>
                {rows.map((t) => {
                  const [b, s] = TASK_STATE[t.state] || ['gray', '—'];
                  return (
                    <tr key={t.key}>
                      <td className="mono" style={{ whiteSpace: 'normal', minWidth: 180, overflowWrap: 'anywhere' }}>{t.op || '—'}{t.error && <div style={{ fontFamily: 'inherit', fontSize: 12, color: 'var(--red, #b91c1c)' }}>{t.error}</div>}</td>
                      {!entity && <td><Target vcenterId={vcenterId} type={t.entityType} mref={t.entity} name={t.entityName} /></td>}
                      <td data-sort={t.state || ''}><span className={`badge ${b}`}>{s}{t.state === 'running' && t.progress != null ? ` ${t.progress}%` : ''}</span></td>
                      <td style={{ overflowWrap: 'anywhere' }}>{t.user || (t.reason && t.reason !== 'user' ? <span className="muted">{TASK_REASON[t.reason]}</span> : '—')}</td>
                      <td className="mono" data-sort={t.queued == null ? '' : String(t.queued)}>{shortTs(t.queued)}</td>
                      <td className="mono" data-sort={t.started == null ? '' : String(t.started)}>{shortTs(t.started)}</td>
                      <td className="mono" data-sort={t.completed == null ? '' : String(t.completed)}>{shortTs(t.completed)}</td>
                      <td>{taskDurText(t)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </STable>
          ) : <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>{entity ? '포탈이 모아 둔 최근 24시간 작업 중 이 개체를 대상으로 한 것이 없습니다.' : '포탈이 모아 둔 최근 24시간 작업이 없습니다.'}</div>)}
          {q.data.userMasked && <Note>작업을 시작한 사용자 이름은 관리자 판본에서만 보입니다.</Note>}
        </>
      );
  const note = <Note>vCenter 의 최근 작업 목록(끝난 뒤 몇 분만 남는다)을 갱신 때마다 모아 최근 24시간 · 200건까지 보관합니다 — 갱신 사이에 시작해 끝난 짧은 작업은 빠질 수 있습니다. 작업 이름은 vCenter 의 작업 식별자(descriptionId)입니다.</Note>;
  if (embedded) return <><Head q={q} title={title} />{body}{note}</>;
  return <Card title={title} badge={c.error ? <span className="badge red">실패 {c.error}</span> : null} sub={q.data ? vcInfoHeadText(q.data) : null}
    more={<button type="button" className="vcd-more" onClick={q.reload} disabled={q.loading}>{q.loading ? '불러오는 중…' : '다시 읽기'}</button>}>{body}{note}</Card>;
}

/** 권한 목록(AuthorizationManager.RetrieveAllPermissions) — 관리자 판본만. entity 를 주면 그 개체에 직접 정의된 것만. */
export function VcPermsCard({ vcenterId, entityType = null, entity = null, what = '이 vCenter' }) {
  const admin = hasRole('admin');
  const q = useOnce('/vcenter-info/perms', { vcenterId }, admin);
  const rows = vcPermRows(q.data?.items, { entityType, entity });
  const roles = Array.isArray(q.data?.roles) ? q.data.roles : [];
  return (
    <Card title={`권한 목록${q.data && !q.data.notCollected ? ` ${rows.length}` : ''}`} badge={<span className="badge amber">관리자 판본</span>} sub={q.data ? vcInfoHeadText(q.data) : null}
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
