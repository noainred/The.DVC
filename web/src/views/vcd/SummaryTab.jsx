/**
 * views/vcd/SummaryTab.jsx — vCenter › 요약(승인 시안 ① · 기본값). 새 수집 없음 — 지금 있는 값만 모은다.
 *   vCenter 정보(사이트 about) · 인벤토리(받은 목록에서 셈) · 용량 · 포탈 알람(포탈 규칙) · 라이선스 · 인증서 · 확장 · 최근 변경.
 *   도구 데이터(라이선스 · 인증서 · 확장 · 변경 이력)는 그 도구 권한이 있을 때만 부른다(없으면 권한 안내 — 숨기지 않는다).
 */
import React, { useMemo } from 'react';
import { usePolling, toolAllowed, can } from '../../api.js';
import { ErrorBox, Loading, UsageCell } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { unitText } from '../unitText.js';
import { notCollectedOf, notCollectedOneText } from '../eventCoverageText.js';
import { useOnce, toolDenied } from './useOnce.js';
import { Card, KV, Note, ToolLink } from './VcdParts.jsx';
import {
  inventoryCounts, gbText, alarmCounts, alarmsOf, SEV_LABEL, SEV_BADGE, PORTAL_ALARM_RULE_TEXT,
  licenseUsePct, extensionsState, esxiVersionRows, shortTs,
} from './vcdTabs.js';

const GRID = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(340px, 100%), 1fr))', gap: 12, minWidth: 0 };

export default function SummaryTab({ site, vcenterId, hosts, vms, datastores, networks, hostsOk, vmsOk, dsOk, netOk, onGo }) {
  const m = site.metrics || {};
  const inv = useMemo(() => inventoryCounts({ hosts, vms, datastores, networks, hostsOk, vmsOk, dsOk, netOk }), [hosts, vms, datastores, networks, hostsOk, vmsOk, dsOk, netOk]);
  const alarmsP = usePolling(can('inv.alarms') ? '/alarms' : null, { vcenterId }, 60_000);
  const lic = useOnce('/tools/licenses', { vcenterId }, toolAllowed('licenses'));
  const certs = useOnce('/tools/report/certs', { vcenterId }, toolAllowed('cert-expiry'));
  const sols = useOnce('/tools/solutions', {}, toolAllowed('solutions'));
  const ev = useOnce('/tools/report/changes', { vcenterId, days: 1, limit: 6 }, toolAllowed('change-history'));

  const alarms = alarmsOf(alarmsP.data?.items, vcenterId);
  const ac = alarmCounts(alarms);
  const extRow = (sols.data?.items || []).find((r) => r?.vcenterId === vcenterId) || null;
  const ext = extensionsState(sols.data ? extRow : null);
  const esxi = esxiVersionRows(hostsOk ? hosts : []);
  const cert = (certs.data?.items || []).find((c) => c?.kind === 'vcenter' && c.id === vcenterId) || null;
  const num = (v) => (v == null ? '—' : Number(v).toLocaleString());

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 10, minWidth: 0 }}>
      <div style={GRID}>
        <Card title="vCenter 정보" sub="수집한 about 값">
          <KV rows={[
            ['제품', site.fullName || '—'],
            ['버전 · 빌드', <>{site.version || '—'}{site.build ? <> · <span className="mono">{site.build}</span></> : ''}</>],
            ['인스턴스 UUID', site.instanceUuid ? <span className="mono" style={{ fontSize: 11.5 }}>{site.instanceUuid}</span> : '—'],
            ['포탈 vCenter id', <span className="mono" key="id">{vcenterId}</span>],
            ['위치', [site.location?.city, site.location?.country].filter(Boolean).join(', ') || '—'],
            ['상태', site.status || '—'],
          ]} />
        </Card>

        <Card title="인벤토리" more={<button type="button" className="vcd-more" onClick={() => onGo('datacenter')}>데이터 센터 →</button>}>
          <div className="vcd-nums">
            <div><span>vSphere 데이터센터</span><b>{num(inv.datacenters)}</b>{inv.dcUnknownHosts > 0 && <i>데이터센터 확인 필요 호스트 {inv.dcUnknownHosts}</i>}</div>
            <div><span>클러스터</span><b>{num(inv.clusters)}</b></div>
            <div><span>호스트</span><b>{num(inv.hosts)}</b>{inv.hosts != null && <i>연결 {inv.hostsConnected} · 끊김 {inv.hostsDisconnected} · 유지보수 {inv.hostsMaint}</i>}</div>
            <div><span>VM</span><b>{num(inv.vms)}</b>{inv.vms != null && <i>켜짐 {inv.vmsOn} · 꺼짐 {inv.vmsOff} · 템플릿 {inv.templates}</i>}</div>
            <div><span>데이터스토어</span><b>{num(inv.datastores)}</b>{inv.dsInaccessible > 0 && <i>접근 불가 {inv.dsInaccessible}</i>}</div>
            <div><span>네트워크(포트그룹)</span><b>{num(inv.networks)}</b></div>
          </div>
          <Note>목록을 아직 받지 못한 칸은 ‘—’ 입니다(0 이 아닙니다). VM 수는 꺼진 VM · 템플릿을 포함한 전체입니다.</Note>
        </Card>

        <Card title="용량" more={<button type="button" className="vcd-more" onClick={() => onGo('monitor', 'perf')}>성능(추이) →</button>}>
          <div style={{ padding: '12px 14px', display: 'grid', gap: 9 }}>
            <div className="vcd-line"><span className="muted" style={{ width: 64 }}>CPU</span><UsageCell pct={m.cpuUsagePct} /></div>
            <div className="vcd-line"><span className="muted" style={{ width: 64 }}>메모리</span><UsageCell pct={m.memUsagePct} /></div>
            <div className="vcd-line"><span className="muted" style={{ width: 64 }}>스토리지</span><UsageCell pct={inv.storage?.pct} />
              <span className="muted" style={{ fontSize: 11.5 }}>{inv.storage ? `${gbText(inv.storage.usedGB)} / ${gbText(inv.storage.capGB)}` : ''}</span></div>
          </div>
          <Note>CPU · 메모리는 호스트 실사용률 합, 스토리지는 데이터스토어 용량 합{inv.storage?.unread ? ` — 용량을 읽지 못했거나 접근 불가인 데이터스토어 ${inv.storage.unread}개는 합에서 뺐습니다` : ''}.</Note>
        </Card>

        <Card title="포탈 알람" badge={<span className="badge amber">포탈 규칙</span>} more={<button type="button" className="vcd-more" onClick={() => onGo('monitor', 'alarms')}>모니터 →</button>}>
          {!alarmsP.data && (alarmsP.error || alarmsP.errorInfo) ? <div style={{ padding: 12 }}><ErrorBox error={alarmsP.errorInfo || alarmsP.error} /></div>
            : !alarmsP.data ? <Loading label="알람" /> : (
              <>
                <div className="vcd-nums three">
                  <div><span>심각</span><b style={{ color: ac.critical ? 'var(--red)' : undefined }}>{ac.critical}</b></div>
                  <div><span>경고</span><b style={{ color: ac.warning ? 'var(--amber)' : undefined }}>{ac.warning}</b></div>
                  <div><span>정보</span><b>{ac.info}</b></div>
                </div>
                <div style={{ padding: '0 14px 10px', display: 'grid', gap: 6 }}>
                  {alarms.slice(0, 4).map((a) => (
                    <div key={a.id} className="vcd-line" style={{ fontSize: 12.5 }}>
                      <span className={`badge ${SEV_BADGE[a.severity] || 'gray'}`}>{SEV_LABEL[a.severity] || a.severity || '—'}</span>
                      <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{a.entity} · {a.message}</span>
                    </div>
                  ))}
                  {!alarms.length && <span className="muted" style={{ fontSize: 12.5 }}>지금 발화 중인 포탈 알람이 없습니다.</span>}
                </div>
              </>
            )}
          <Note>{PORTAL_ALARM_RULE_TEXT}</Note>
        </Card>

        <Card title="라이선스 · 인증서" more={<ToolLink tool="licenses">라이선스 →</ToolLink>}>
          {!toolAllowed('licenses') ? <div style={{ padding: 12 }}><ErrorBox error={toolDenied('라이선스 한눈에')} /></div>
            : lic.error && !lic.data ? <div style={{ padding: 12 }}><ErrorBox error={lic.error} /></div>
              : !lic.data ? <Loading label="라이선스" /> : (
                <div style={{ padding: '10px 14px', display: 'grid', gap: 6, fontSize: 12.5 }}>
                  {(lic.data.unread || []).some((u) => u.vcenterId === vcenterId) && <span className="badge amber" style={{ justifySelf: 'start' }}>이 vCenter 의 라이선스를 읽지 못했습니다 — 확인 불가</span>}
                  {(lic.data.items || []).slice(0, 4).map((l, i) => {
                    const pct = licenseUsePct(l);
                    return (
                      <div key={`${l.name}-${i}`} className="vcd-line" style={{ justifyContent: 'space-between' }}>
                        <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{l.name || l.edition || '—'}</span>
                        <span className="muted" style={{ whiteSpace: 'nowrap' }}>{l.used == null ? '—' : Number(l.used).toLocaleString()} / {l.total == null ? '—' : Number(l.total).toLocaleString()}{pct != null ? ` · ${pct}%` : ''}</span>
                      </div>
                    );
                  })}
                  {!(lic.data.items || []).length && !(lic.data.unread || []).length && <span className="muted">이 vCenter 가 보고한 라이선스가 없습니다.</span>}
                </div>
              )}
          <div style={{ borderTop: '1px solid var(--border)', padding: '10px 14px', fontSize: 12.5 }}>
            {!toolAllowed('cert-expiry') ? <span className="muted">인증서 — 특수 기능 ‘인증서 만료 감시’ 권한이 없어 불러오지 않았습니다.</span>
              : certs.error && !certs.data ? <ErrorBox error={certs.error} />
                : !certs.data ? <span className="muted">인증서 불러오는 중…</span>
                  : !cert ? <span className="muted">인증서 — 아직 확인하지 않았습니다(포탈이 주기적으로 443 을 읽습니다).</span>
                    : <div className="vcd-line" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
                      <span>인증서 <span className="mono">{cert.cn || cert.hostPort || '—'}</span></span>
                      <CertBadge c={cert} />
                    </div>}
          </div>
        </Card>

        <Card title="확장 프로그램 · 버전" more={<button type="button" className="vcd-more" onClick={() => onGo('extensions')}>확장 프로그램 →</button>}>
          <KV rows={[
            ['확장 프로그램', !toolAllowed('solutions') ? <span className="muted">권한 없음</span>
              : sols.error && !sols.data ? <span className="muted">불러오지 못함</span>
                : !sols.data ? '…' : ext.state === 'unread' ? <span className="badge amber">확인 불가</span>
                  : ext.state === 'missing' ? '—' : `${ext.items.length}개`],
            ['ESXi 버전', hostsOk ? (esxi.rows.length ? esxi.rows.slice(0, 3).map((r) => `${r.version} ×${r.count}`).join(' · ') + (esxi.rows.length > 3 ? ` · 외 ${esxi.rows.length - 3}` : '') : '—') : '—'],
            ['버전 모름', hostsOk && esxi.unknown ? `${esxi.unknown}대(버전을 보고하지 않음)` : null],
            ['적용 가능 패치', <span className="badge gray" key="p">수집하지 않음</span>],
          ].filter((r) => r[1] != null)} />
          <Note>확장 목록은 주기 수집에 이미 실립니다(ExtensionManager). 패치 · vLCM 준수 상태는 수집하지 않습니다 — 업데이트 탭 참고.</Note>
        </Card>
      </div>

      <Card title="최근 변경" sub="이 vCenter · 최근 1일 · 구성 변경 이력과 같은 출처" more={<button type="button" className="vcd-more" onClick={() => onGo('monitor', 'events')}>모니터 › 이벤트 →</button>}>
        {!toolAllowed('change-history') ? <div style={{ padding: 12 }}><ErrorBox error={toolDenied('구성 변경 이력')} /></div>
          : ev.error && !ev.data ? <div style={{ padding: 12 }}><ErrorBox error={ev.error} /></div>
            : !ev.data ? <Loading label="변경 이벤트" /> : (
              <EventRows data={ev.data} vcenterId={vcenterId} max={6} />
            )}
      </Card>
    </div>
  );
}

export function CertBadge({ c }) {
  const map = { expired: ['red', '만료'], critical: ['red', '위험'], expiring: ['amber', '임박'], ok: ['green', '정상'], unknown: ['gray', '모름'], error: ['gray', '확인 실패'], blocked: ['gray', '차단'] };
  const [b, t] = map[c?.status] || ['gray', c?.status || '—'];
  return <span className={`badge ${b}`}>{t}{c?.daysLeft != null ? ` · D-${c.daysLeft}` : ''}</span>;
}

/** 변경 이벤트 표(요약 · 모니터 · 사용 권한 공용). 받은 행이 없을 때 '수집하지 않는 vCenter' 이면 그 사실을 먼저 말한다. */
export function EventRows({ data, vcenterId, max = 300, empty = '이 기간에 변경 이벤트가 없습니다.' }) {
  const nc = notCollectedOf(data?.notCollected, vcenterId);
  const rows = (data?.rows || []).slice(0, max);
  return (
    <>
      {nc && <div className="muted" style={{ padding: '8px 14px', fontSize: 12.5, color: 'var(--amber)' }}>{notCollectedOneText(nc)}</div>}
      {rows.length ? (
        <STable className="v3-table" minWidth={760}>
          <thead><tr><th>시각</th><th>분류</th><th>유형</th><th>대상</th><th>사용자</th><th>메시지</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.ts}-${i}`}>
                <td className="mono" data-sort={String(r.ts ?? '')}>{shortTs(r.ts)}</td>
                <td><span className="badge blue">{r.category || '—'}</span></td>
                <td>{r.type || '—'}</td>
                <td>{r.entity || '—'}</td>
                <td>{r.user || '—'}</td>
                <td style={{ whiteSpace: 'normal', minWidth: 240 }}>{r.message || '—'}</td>
              </tr>
            ))}
          </tbody>
        </STable>
      ) : <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>{empty}</div>}
      {data?.truncated && <Note>훑은 행이 상한({unitText(data.scanMax, '행')})에 닿았습니다 — 그 앞 시각의 이벤트는 보지 않았습니다.</Note>}
    </>
  );
}
