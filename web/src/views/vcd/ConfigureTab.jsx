/**
 * views/vcd/ConfigureTab.jsx — vCenter › 구성(승인 시안 ③ · 기본값 3·5).
 *   기존 특수 기능의 데이터를 이 vCenter 로 거른 표 + '도구에서 열기 →'. 판정 · 문구는 그 도구의 순수 모듈을 그대로 쓴다(재판정 금지).
 *   도구 권한이 없으면 부르지 않고 권한 안내 — 숨기지 않는다. 고급 설정은 수집하지 않는다(2차).
 */
import React from 'react';
import { toolAllowed } from '../../api.js';
import { ErrorBox, Loading } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { useOnce, toolDenied } from './useOnce.js';
import { KV, Note, SubNav, ToolLink, NotCollected } from './VcdParts.jsx';
import { CertBadge } from './SummaryTab.jsx';
import { CONFIGURE_SUBS, maskLicenseKey, licenseUsePct, licenseExpiryText } from './vcdTabs.js';
import { CLUSTER_TEXT, SEV_LABEL as CL_SEV_LABEL, SEV_BADGE as CL_SEV_BADGE, haText, drsText, evcText, clusterHostsText } from '../clustercfg/clusterCfgText.js';
import { HOST_CFG_TEXT, SEV_BADGE as HC_SEV_BADGE } from '../hostcfg/hostCfgText.js';

const TOOL_LABEL = { licenses: '라이선스 한눈에', 'cluster-check': '클러스터 HA·DRS 점검', 'vm-tags': '태그·사용자 지정 속성 점검', 'cert-expiry': '인증서 만료 감시', 'host-hygiene': 'ESXi 호스트 구성 점검' };

export default function ConfigureTab({ vcenterId, sub, onSub }) {
  const cur = CONFIGURE_SUBS.find((s) => s.k === sub) || CONFIGURE_SUBS[0];
  const allowed = cur.tool ? toolAllowed(cur.tool) : false;
  return (
    <div className="vcd-pane card" style={{ marginTop: 10 }}>
      <SubNav items={CONFIGURE_SUBS} value={cur.k} onChange={onSub} label="구성 하위 칸" />
      <div style={{ minWidth: 0 }}>
        {cur.tool && !allowed && <div style={{ padding: 12 }}><ErrorBox error={toolDenied(TOOL_LABEL[cur.tool] || cur.label)} /></div>}
        {cur.k === 'licenses' && allowed && <LicensesPane vcenterId={vcenterId} />}
        {cur.k === 'clusters' && allowed && <ClustersPane vcenterId={vcenterId} />}
        {cur.k === 'tags' && allowed && <TagsPane vcenterId={vcenterId} />}
        {cur.k === 'certs' && allowed && <CertsPane vcenterId={vcenterId} />}
        {cur.k === 'hostcfg' && allowed && <HostCfgPane vcenterId={vcenterId} />}
        {cur.k === 'advanced' && (
          <div style={{ padding: 14 }}>
            <NotCollected title="고급 설정 · 예약 작업">
              vCenter 고급 설정(OptionManager)과 예약 작업(ScheduledTaskManager)은 포탈이 읽지 않습니다. 추가한다면 읽기 전용 · 탭을 열 때만 조회 · 키 목록은 관리자 판본에서만 보입니다.
            </NotCollected>
          </div>
        )}
      </div>
    </div>
  );
}

function Gate({ q, label, children }) {
  if (q.error && !q.data) return <div style={{ padding: 12 }}><ErrorBox error={q.error} /></div>;
  if (!q.data) return <Loading label={label} />;
  return children(q.data);
}

function Head({ title, sub, tool, toolText }) {
  return (
    <div className="vcd-card-h" style={{ flexWrap: 'wrap', rowGap: 6 }}>
      <b>{title}</b>{sub && <span className="muted" style={{ fontSize: 11.5 }}>{sub}</span>}
      <span style={{ marginLeft: 'auto' }}><ToolLink tool={tool}>{toolText}</ToolLink></span>
    </div>
  );
}

function LicensesPane({ vcenterId }) {
  const q = useOnce('/tools/licenses', { vcenterId });
  return (
    <>
      <Head title="라이선스" sub="LicenseManager · 주기 수집" tool="licenses" toolText="라이선스 도구에서 열기 →" />
      <Gate q={q} label="라이선스">{(d) => {
        const unread = (d.unread || []).find((u) => u.vcenterId === vcenterId);
        const items = (d.items || []).filter((l) => l.vcenterId === vcenterId);
        return (
          <>
            {unread && <div style={{ padding: '8px 14px' }}><span className="badge amber">이 vCenter 의 라이선스를 읽지 못했습니다 — 확인 불가{unread.error ? ` · ${unread.error}` : ''}</span></div>}
            {items.length ? (
              <STable className="v3-table" minWidth={820}>
                <thead><tr><th>이름</th><th>에디션</th><th>키</th><th>단위</th><th>사용 / 총</th><th>사용률</th><th>만료</th></tr></thead>
                <tbody>
                  {items.map((l, i) => {
                    const pct = licenseUsePct(l);
                    const ex = licenseExpiryText(l.expires);
                    return (
                      <tr key={`${l.name}-${i}`}>
                        <td><b>{l.name || '—'}</b></td>
                        <td>{l.edition || '—'}</td>
                        <td className="mono" data-nosort="">{maskLicenseKey(l.key)}</td>
                        <td>{l.costUnit || '—'}</td>
                        <td data-sort={l.used == null ? '' : String(l.used)}>{l.used == null ? '—' : Number(l.used).toLocaleString()} / {l.total == null ? '—' : Number(l.total).toLocaleString()}</td>
                        <td data-sort={pct == null ? '' : String(pct)}>{pct == null ? '—' : `${pct}%`}</td>
                        <td><span className={`badge ${ex.sev === 'expired' || ex.sev === 'crit' ? 'red' : ex.sev === 'warn' ? 'amber' : ex.sev === 'ok' ? 'green' : 'gray'}`}>{ex.text}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </STable>
            ) : !unread && <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>이 vCenter 가 보고한 라이선스가 없습니다.</div>}
            <Note>키는 뒤 5자만 보입니다. 사용 · 총량은 vCenter 가 보고하지 않을 수 있는 값이라 못 읽으면 ‘—’ 입니다(0 이 아닙니다).</Note>
          </>
        );
      }}</Gate>
    </>
  );
}

function ClustersPane({ vcenterId }) {
  const q = useOnce('/tools/cluster-check', { vcenterId });
  return (
    <>
      <Head title="클러스터 HA · DRS" sub="clustercfg · 주기 수집" tool="cluster-check" toolText="클러스터 점검 도구에서 열기 →" />
      <Gate q={q} label="클러스터 구성">{(d) => {
        const rows = (d.rows || []).filter((r) => r.vcenterId === vcenterId);
        return (
          <>
            <div className="muted" style={{ padding: '6px 14px', fontSize: 12 }}>
              클러스터 {d.coverage?.clusters ?? '—'} · HA 켜짐 {d.totals?.haOn ?? '—'} · DRS 켜짐 {d.totals?.drsOn ?? '—'} · 규칙 {d.totals?.rules ?? '—'}(위반 {d.totals?.rulesViolated ?? '—'}){d.coverage?.notCollected ? ` · 아직 읽지 않은 클러스터 ${d.coverage.notCollected}` : ''}
            </div>
            {rows.length ? (
              <STable className="v3-table" minWidth={980}>
                <thead><tr><th>클러스터</th><th>데이터센터</th><th>호스트</th><th>HA</th><th>DRS</th><th>EVC</th><th>규칙</th><th>점검</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.ref || r.name}>
                      <td><b>{r.name}</b></td>
                      <td>{r.vcDatacenter || '—'}</td>
                      <td>{clusterHostsText(r)}</td>
                      <td style={{ whiteSpace: 'normal' }}>{r.collected === false ? '—' : haText(r.ha)}</td>
                      <td>{r.collected === false ? '—' : drsText(r.drs)}</td>
                      <td>{r.collected === false ? '—' : evcText(r.evc)}</td>
                      <td>{r.rulesTotal == null ? '—' : r.rulesTotal}</td>
                      <td style={{ whiteSpace: 'normal' }}>
                        {(r.findings || []).length ? (r.findings || []).map((f) => (
                          <span key={f.code} className={`badge ${CL_SEV_BADGE[f.sev] || 'gray'}`} style={{ marginRight: 4 }} title={CLUSTER_TEXT[f.code]?.fix || ''}>{CL_SEV_LABEL[f.sev] || f.sev} · {CLUSTER_TEXT[f.code]?.title || f.code}</span>
                        )) : r.collected === false ? <span className="muted">아직 읽지 않음</span> : <span className="badge green">정상</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </STable>
            ) : <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>이 vCenter 에 클러스터가 없거나 아직 읽지 않았습니다.</div>}
            <Note>HA · DRS 를 못 읽은 클러스터는 ‘—’ 입니다(꺼짐으로 세지 않습니다). 판정은 도구 ‘클러스터 HA·DRS 점검’ 과 같은 서버 판정입니다.</Note>
          </>
        );
      }}</Gate>
    </>
  );
}

function TagsPane({ vcenterId }) {
  const q = useOnce('/tools/vm-tags', { vcenterId });
  return (
    <>
      <Head title="태그 · 사용자 지정 속성" sub="tagInv · 주기 수집" tool="vm-tags" toolText="태그 점검 도구에서 열기 →" />
      <Gate q={q} label="태그">{(d) => {
        const vc = (d.vcenters || []).find((v) => v.vcenterId === vcenterId) || null;
        const missing = Object.entries(d.missingByCategory || {});
        return (
          <>
            <KV rows={[
              ['상태', !vc ? '—' : vc.tagsError || vc.customError ? <span className="badge amber">일부 읽지 못함{d.errorsHidden ? '' : ` · ${vc.tagsError || vc.customError}`}</span> : vc.state === 'ok' ? <span className="badge green">읽음</span> : (vc.state || '—')],
              ['태그 범주 · 태그', vc ? `${vc.categories ?? '—'} 범주 · ${vc.tags ?? '—'} 태그` : '—'],
              ['필수 범주', (d.policy?.requiredCategories || []).join(' · ') || '없음'],
              ['필수 태그가 빠진 VM', vc ? `${vc.withMissing ?? '—'} / ${vc.vms ?? '—'}` : '—'],
              ['빠진 범주별', missing.length ? missing.map(([k, n]) => `${k} ${n}`).join(' · ') : '없음'],
              ['사용자 지정 속성', (d.fields || []).length ? (d.fields || []).map((f) => `${f.name} ${f.filled}/${f.checked}`).join(' · ') : '없음'],
            ]} />
            <Note>필수 범주 정책은 도구 ‘태그·사용자 지정 속성 점검’ 의 설정을 그대로 씁니다. VM 별 목록은 그 도구에서 봅니다.</Note>
          </>
        );
      }}</Gate>
    </>
  );
}

function CertsPane({ vcenterId }) {
  const q = useOnce('/tools/report/certs', { vcenterId });
  return (
    <>
      <Head title="인증서" sub="포탈이 주기적으로 443 을 읽은 값" tool="cert-expiry" toolText="인증서 만료 도구에서 열기 →" />
      <Gate q={q} label="인증서">{(d) => {
        const c = (d.items || []).find((x) => x.kind === 'vcenter' && x.id === vcenterId) || null;
        if (!c) return <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>아직 이 vCenter 의 인증서를 확인하지 않았습니다{d.running ? '(확인 중)' : ''}.</div>;
        return (
          <>
            <KV rows={[
              ['상태', <CertBadge key="b" c={c} />],
              ['대상', <span className="mono" key="h">{c.hostPort || `${c.host || ''}${c.port ? `:${c.port}` : ''}` || '—'}</span>],
              ['CN', c.cn || '—'],
              ['발급자', c.issuer || '—'],
              ['유효 기간', c.validTo ? `${c.validFrom ? new Date(c.validFrom).toISOString().slice(0, 10) : '—'} ~ ${new Date(c.validTo).toISOString().slice(0, 10)}` : '—'],
              ['자체 서명', c.selfSigned == null ? '—' : c.selfSigned ? '예' : '아니오'],
              c.error ? ['확인 실패', c.error] : null,
            ]} />
            <Note>읽지 못했으면 ‘확인 실패 — 사유’ 이고 만료로 단정하지 않습니다. vCenter 내부의 STS · 머신 · 솔루션 사용자 인증서는 수집하지 않습니다.</Note>
          </>
        );
      }}</Gate>
    </>
  );
}

function HostCfgPane({ vcenterId }) {
  const q = useOnce('/tools/host-hygiene', { vcenterId });
  return (
    <>
      <Head title="호스트 구성 점검" sub="hcfg · 오래된 호스트부터 나눠 읽은 값" tool="host-hygiene" toolText="ESXi 호스트 구성 점검에서 열기 →" />
      <Gate q={q} label="호스트 구성">{(d) => {
        const codes = Object.entries(d.byCode || {}).filter(([, v]) => (v?.hosts || 0) > 0)
          .sort((a, b) => ({ crit: 0, warn: 1, info: 2 }[a[1].sev] ?? 9) - ({ crit: 0, warn: 1, info: 2 }[b[1].sev] ?? 9) || b[1].hosts - a[1].hosts);
        return (
          <>
            <div className="muted" style={{ padding: '6px 14px', fontSize: 12 }}>
              호스트 {d.coverage?.hosts ?? '—'} · 읽음 {d.coverage?.cfg ?? '—'}{d.coverage?.notCollected ? ` · 아직 읽지 않음 ${d.coverage.notCollected}` : ''}{d.coverage?.disconnected ? ` · 끊김(판정 안 함) ${d.coverage.disconnected}` : ''}
            </div>
            {codes.length ? (
              <STable className="v3-table" minWidth={620}>
                <thead><tr><th>항목</th><th>호스트 수</th><th>조치</th></tr></thead>
                <tbody>
                  {codes.map(([code, v]) => (
                    <tr key={code}>
                      <td><span className={`badge ${HC_SEV_BADGE[v.sev] || 'gray'}`} style={{ marginRight: 6 }}>{v.sev === 'crit' ? '위험' : v.sev === 'warn' ? '주의' : '참고'}</span>{HOST_CFG_TEXT[code]?.title || code}</td>
                      <td data-sort={String(v.hosts)}>{v.hosts}</td>
                      <td style={{ whiteSpace: 'normal', minWidth: 240 }} className="muted">{HOST_CFG_TEXT[code]?.fix || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </STable>
            ) : <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>읽은 값에서 확인할 항목이 없습니다.</div>}
            <Note>판정은 도구 ‘ESXi 호스트 구성 점검’ 과 같은 서버 판정입니다. 호스트별 목록 · 클러스터 간 드리프트는 그 도구에서 봅니다.</Note>
          </>
        );
      }}</Gate>
    </>
  );
}


