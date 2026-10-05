/**
 * VM DNS 설정 확인 — 특수 기능 `vm-dns`(v2.696, 사용자 승인 시안 '개요 · DNS 서버 상세 · 승인 DNS 정책').
 *
 * 게스트 OS 가 VMware Tools 로 보고한 DNS 설정(v2.695 수집)을 vCenter 별로 모아, 주소마다 '누구인지'(IP 대장 대조)·
 * 승인 정책·마지막 도달성 점검을 함께 본다. 탭: 개요 / DNS 서버 상세 / 정책 · 도달성 / 변경 이력(`useHashTab`).
 *
 * ⚠ 판정은 서버(`server/src/vmdns/analyze.js`)가 한다 — 이 화면은 조립만 하고 문구·표지는 `vmDnsText.js`(순수)가 갖는다.
 * ⚠ **폴링하지 않는다** — 마운트 1회 + 새로고침 버튼(v2.508 V4 규약). vCenter 를 바꾸면 그때 다시 부른다.
 * ⚠ 늦게 온 이전 응답은 버린다(세대 번호) — vCenter 를 빠르게 바꾸면 앞 요청이 뒤 요청 결과를 덮는다.
 * ⚠ 정책 저장·도달성 점검은 **전체 범위 관리자**에게만 보인다(서버가 adminOnly + fullScopeOnly 로 집행한다 — 이것은 표시 게이팅).
 * ⚠ 훅은 전부 조기 return 위에(React #310) — 이 파일의 컴포넌트는 조기 return 을 훅 뒤에만 둔다.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, postJson, putJson, downloadFile, canCsv, hasRole, getCurrentUser } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import ScopeOmitBanner from '../ScopeOmitBanner.jsx';
import { useHashTab } from '../../hooks/useHashTab.js';
import { agoText } from './relTime.js';
import {
  TABS, TAB_LABEL, nText, tsMs, dateTimeText, whenText, ipSortKey, ipsText,
  kindLabel, kindBadge, policyLabel, policyBadge, POLICY_TITLE, whoText, reachText, TONE_COLOR, probeSummaryCards,
  kpiCards, KPI_TONE_COLOR, vcChips, emptyReason, corpsText, barPct, serversFootText,
  MATRIX_LEGEND, legendBg, matrixView, barList, modeSplit, checkRows, CHANGE_TONE, changeTone, changesNote,
  flagChips, isFirstFor, powerText, modeText, SERVER_FILTERS, vmMatches, filterCounts, searchVms, ipBadge,
  mismatchNote, serverHeadDesc, policyHeadText, vmListFoot, previewPolicyInput, normPolicy, samePolicy,
  invalidText, policyRows, violText, scopeOf, qnameText, skippedByText, historyNote,
} from './vmDnsText.js';

/** 동작(점검·저장·내려받기) 실패 — 403 은 접근 제어 안내(ErrorBox → AccessDenied), 그 밖은 사유 문장(5xx 를 '서비스 중단' 으로 말하지 않는다). */
const isDenied = (e) => !!e && e.status === 403;
// 하위 컴포넌트는 렌더 스모크 테스트(vmDnsRender.test.jsx)가 계약 모양의 응답으로 직접 그린다 — 그래서 named export 다.

const MONO = 'var(--mono)';
const PANEL = { padding: 0, minWidth: 0, display: 'flex', flexDirection: 'column' };
const HEAD = { padding: '14px 18px', borderBottom: '1px solid var(--border-soft)', display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 8 };
const FOOT = { padding: '10px 18px', borderTop: '1px solid var(--border-soft)', fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 };
const CHECK_TONE = { purple: 'var(--purple)', warn: 'var(--amber)', neutral: 'var(--text)', plain: 'var(--text-dim)' };

/** 표 안의 클릭 가능한 글자 — 링크 파랑이 아니라 inherit + 점선 밑줄(v2.527 규약). 키보드로도 연다. */
function ClickText({ onClick, title, children, style }) {
  return (
    <span
      role="button" tabIndex={0} title={title} onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      style={{ cursor: 'pointer', color: 'inherit', textDecoration: 'underline dotted', textUnderlineOffset: 3, ...(style || {}) }}
    >{children}</span>
  );
}

function Badge({ tone, children, title, mono }) {
  return <span className={`badge ${tone || 'gray'}`} title={title} style={{ whiteSpace: 'nowrap', ...(mono ? { fontFamily: MONO, fontWeight: 500 } : null) }}>{children}</span>;
}

function SectionTitle({ title, sub, right }) {
  return (
    <div style={HEAD}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{title}</div>
        {sub && <div className="muted" style={{ fontSize: 12 }}>{sub}</div>}
      </div>
      {right}
    </div>
  );
}

export function KpiRow({ cards }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(170px, 100%), 1fr))', gap: 12 }}>
      {cards.map((k) => (
        <div key={k.key} className="card" style={{ padding: '14px 16px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="muted" style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: k.dot, display: 'inline-block', flex: 'none' }} />{k.label}
          </div>
          <div style={{ fontFamily: MONO, fontSize: 28, fontWeight: 600, color: KPI_TONE_COLOR[k.tone] || 'var(--text)' }}>{k.value}</div>
          <div className="muted" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{k.sub}</div>
        </div>
      ))}
    </div>
  );
}

// ── 개요: DNS 서버 표 ────────────────────────────────────────────────────────
export function ServerSection({ data, onPick }) {
  const [all, setAll] = useState(false);
  const servers = useMemo(() => (Array.isArray(data?.servers) ? data.servers.filter((s) => s && s.ip) : []), [data]);
  const max = servers.reduce((m, s) => Math.max(m, Number(s.vms) || 0), 0);
  const LIMIT = 20;
  const shown = all ? servers.length : Math.min(LIMIT, servers.length);
  return (
    <section className="card" style={{ ...PANEL, flex: '999 1 640px' }}>
      <SectionTitle
        title="DNS 서버"
        sub="주소마다 '누구인지' 를 IP 대장에서 찾고, 승인 정책과 마지막 도달성 점검을 함께 봅니다"
        right={<span className="muted" style={{ fontSize: 12 }}>처음 순서: 사용 VM 많은 순 · 제목을 누르면 정렬</span>}
      />
      {servers.length === 0 ? (
        <div className="muted" style={{ padding: 16, fontSize: 13 }}>표시할 DNS 서버가 없습니다.</div>
      ) : (
        <STable minWidth={900} limit={all ? 0 : LIMIT}>
          <thead>
            <tr><th>DNS 서버</th><th>정체(IP 대장 대조)</th><th>정책</th><th className="right">사용 VM</th><th>쓰는 법인</th><th>도달성(53)</th></tr>
          </thead>
          <tbody>
            {servers.map((s) => {
              const reach = reachText(s.probe);
              return (
                <tr key={s.ip}>
                  <td data-sort={ipSortKey(s.ip) ?? ''} style={{ fontFamily: MONO, fontWeight: 600 }}>
                    <ClickText onClick={() => onPick(s.ip)} title="이 주소를 쓰는 VM 보기">{s.ip}</ClickText>
                  </td>
                  <td data-sort={whoText(s)} style={{ maxWidth: 320 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                      <Badge tone={kindBadge(s.kind)}>{kindLabel(s.kind)}</Badge>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }} title={whoText(s)}>{whoText(s)}</span>
                    </div>
                  </td>
                  <td data-sort={policyLabel(s.policy)}><Badge tone={policyBadge(s.policy)} title={POLICY_TITLE[s.policy]}>{policyLabel(s.policy)}</Badge></td>
                  <td className="right" data-sort={s.vms ?? ''}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10 }}>
                      <div style={{ width: 80, height: 6, borderRadius: 3, background: 'var(--panel-deep)', overflow: 'hidden' }}>
                        <div style={{ height: 6, width: `${barPct(s.vms, max)}%`, background: s.policy === 'unapproved' || s.kind === 'public' ? 'var(--red)' : s.policy === 'approved' ? 'var(--accent)' : 'var(--text-faint)' }} />
                      </div>
                      <span style={{ fontFamily: MONO, fontWeight: 600, minWidth: 44 }}>{nText(s.vms)}</span>
                    </div>
                  </td>
                  <td data-sort={Array.isArray(s.corps) ? s.corps.length : ''} title={(Array.isArray(s.corps) ? s.corps : []).map((c) => `${c.name || c.id} ${nText(c.vms)}대`).join(' · ')}>{corpsText(s.corps)}</td>
                  <td style={{ color: TONE_COLOR[reach.tone], fontSize: 12 }} title={reach.where || undefined}>{reach.text}</td>
                </tr>
              );
            })}
          </tbody>
        </STable>
      )}
      <div style={{ ...FOOT, display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
        <span>{serversFootText(data, shown)}{servers.length > LIMIT && !all ? ` · 처음 ${LIMIT}개만 보입니다` : ''}</span>
        {servers.length > LIMIT && <button className="btn btn-sm" onClick={() => setAll((x) => !x)}>{all ? `처음 ${LIMIT}개만` : `전체 ${servers.length}개 보기`}</button>}
        <span>정체는 이 포탈의 IP 대장(VM·호스트·잘 알려진 공인 DNS·대장 분류)에서 찾습니다 — 찾지 못하면 '대장에 없음' 이라 말하고 지어내지 않습니다.</span>
      </div>
    </section>
  );
}

// ── 개요: 법인 × DNS 매트릭스 ────────────────────────────────────────────────
export function MatrixSection({ matrix, servers }) {
  const m = useMemo(() => matrixView(matrix, servers), [matrix, servers]);
  return (
    <section className="card" style={{ ...PANEL, flex: '1 1 440px' }}>
      <SectionTitle title="법인 × DNS 서버" sub="칸 = 그 법인 VM 중 그 DNS 를 쓰는 대수 · 짙을수록 그 법인 안에서 비중이 큼" />
      {m.empty ? (
        <div className="muted" style={{ padding: 16, fontSize: 13 }}>매트릭스로 보일 데이터가 없습니다.</div>
      ) : (
        <div style={{ padding: '10px 12px' }}>
          <STable minWidth={Math.max(420, 90 + (m.cols.length + 1) * 64)} style={{ borderCollapse: 'separate', borderSpacing: 4 }}>
            <thead>
              <tr>
                <th style={{ padding: '4px 6px' }}>법인</th>
                {m.cols.map((c) => (
                  <th key={c.ip} title={c.title} style={{ padding: '4px 6px', textAlign: 'center', fontFamily: MONO, fontSize: 11, color: c.tone === 'bad' ? 'var(--red)' : undefined }}>{c.label}</th>
                ))}
                <th style={{ padding: '4px 6px', textAlign: 'center' }} title="상위 열 밖의 주소를 쓰는 VM 수">기타</th>
              </tr>
            </thead>
            <tbody>
              {m.rows.map((r) => (
                <tr key={r.vcenterId || r.name}>
                  <td title={`VM ${nText(r.total)}대`} style={{ padding: '4px 6px', fontWeight: 500, borderBottom: 0 }}>{r.name}</td>
                  {r.cells.map((c, i) => (
                    <td key={i} data-sort={c.v ?? ''} title={c.title}
                      style={{ padding: 0, borderBottom: 0, height: 32, minWidth: 52, textAlign: 'center', borderRadius: 6, background: c.bg, fontFamily: MONO, fontSize: 12, color: c.strong ? 'var(--text)' : 'var(--text-faint)' }}>
                      {c.text}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </STable>
        </div>
      )}
      <div style={{ ...FOOT, marginTop: 'auto', display: 'flex', flexWrap: 'wrap', gap: 14 }}>
        {MATRIX_LEGEND.map((l) => (
          <span key={l.tone} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: legendBg(l.tone), flex: 'none' }} />{l.label}
          </span>
        ))}
      </div>
    </section>
  );
}

// ── 개요: 아래 3장 ───────────────────────────────────────────────────────────
export function DomainsCard({ domains, search }) {
  const [which, setWhich] = useState('domain');
  const rows = barList(which === 'domain' ? domains : search, 6);
  return (
    <section className="card" style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>도메인 · 검색 접미사</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {[['domain', '도메인'], ['search', '검색 접미사']].map(([k, l]) => (
            <button key={k} className={`tab${which === k ? ' active' : ''}`} aria-pressed={which === k} onClick={() => setWhich(k)} style={{ fontSize: 12 }}>{l}</button>
          ))}
        </div>
      </div>
      {rows.length === 0 ? <div className="muted" style={{ fontSize: 13 }}>보고된 값이 없습니다.</div> : rows.map((d) => (
        <div key={d.name} style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13 }}>
            <span style={{ fontFamily: MONO, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.name}>{d.name}</span>
            <span className="muted" style={{ fontFamily: MONO }}>{d.text}</span>
          </div>
          <div style={{ height: 6, borderRadius: 3, background: 'var(--panel-deep)' }}><div style={{ height: 6, borderRadius: 3, width: `${d.pct}%`, background: 'var(--accent-2)' }} /></div>
        </div>
      ))}
      <div className="muted" style={{ fontSize: 12 }}>상위 6개 · 단위 VM 대수</div>
    </section>
  );
}

export function ModeCard({ kpis, checks }) {
  const split = modeSplit(kpis);
  const rows = checkRows(checks);
  return (
    <section className="card" style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>설정 방식 · 정합성</div>
        <span className="muted" style={{ fontSize: 12 }}>{split ? `방식을 읽은 ${split.baseText}대 기준` : '방식을 읽지 못했습니다'}</span>
      </div>
      {split && split.base > 0 && (
        <div style={{ display: 'flex', height: 14, borderRadius: 7, overflow: 'hidden', background: 'var(--panel-deep)' }}>
          <div style={{ flex: split.static || 0, background: 'var(--accent)' }} />
          <div style={{ flex: split.dhcp || 0, background: 'var(--accent-2)' }} />
        </div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, fontSize: 13 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: 3, background: 'var(--accent)' }} />고정 설정 <b style={{ fontFamily: MONO }}>{split ? split.staticText : '—'}</b></span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: 3, background: 'var(--accent-2)' }} />DHCP <b style={{ fontFamily: MONO }}>{split ? split.dhcpText : '—'}</b></span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--border-soft)' }}>
        {rows.map((c) => (
          <div key={c.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingTop: 10 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
              <span style={{ fontSize: 13 }}>{c.label}</span>
              <span className="muted" style={{ fontSize: 12 }}>{c.sub}</span>
            </div>
            <span style={{ fontFamily: MONO, fontSize: 14, fontWeight: 600, padding: '4px 12px', borderRadius: 8, background: 'var(--panel-deep)', color: CHECK_TONE[c.tone] || 'var(--text)' }}>{c.n}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function ChangeLine({ ch, kindOf, now }) {
  const tone = CHANGE_TONE[changeTone(ch, kindOf)] || CHANGE_TONE.info;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '14px minmax(0, 1fr)', gap: 10 }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <span title={tone.label} style={{ width: 10, height: 10, borderRadius: '50%', marginTop: 4, background: tone.color, flex: 'none' }} />
        <span style={{ flex: 1, width: 1, background: 'var(--border)' }} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, paddingBottom: 12, minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13 }}>
          <b style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={ch.vmName || ch.vmId}>{ch.vmName || ch.vmId || '—'}</b>
          <span className="muted" style={{ fontFamily: MONO, fontSize: 12, whiteSpace: 'nowrap' }}>{whenText(ch.ts, now)}</span>
        </div>
        <div style={{ fontFamily: MONO, fontSize: 12, overflowWrap: 'anywhere' }}>
          {ch.first ? <span className="muted">첫 관측 · {ipsText(ch.after)}</span> : (
            <><span className="muted" style={{ textDecoration: 'line-through' }}>{ipsText(ch.before)}</span> <span style={{ color: 'var(--text-faint)' }}>→</span> <span>{ipsText(ch.after)}</span></>
          )}
        </div>
      </div>
    </div>
  );
}

export function RecentChanges({ changes, kindOf, onMore }) {
  const list = Array.isArray(changes?.recent) ? changes.recent.filter((c) => c && typeof c === 'object') : [];
  const note = changesNote(changes ? { ...changes, changes: list } : null, 0);
  const now = Date.now();
  return (
    <section className="card" style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>최근 DNS 설정 변경</div>
        <span className="muted" style={{ fontSize: 12 }}>바뀐 것만 기록 · 최근 {list.length}건</span>
      </div>
      {!changes ? <div className="muted" style={{ fontSize: 13 }}>—</div>
        : note ? <div style={{ fontSize: 13, color: note.tone === 'warn' ? 'var(--amber)' : 'var(--text-dim)' }}>{note.text}</div>
          : list.map((ch, i) => <ChangeLine key={`${ch.vmId}-${ch.ts}-${i}`} ch={ch} kindOf={kindOf} now={now} />)}
      <div style={{ marginTop: 'auto' }}><button className="btn btn-sm" onClick={onMore}>변경 이력 전체 보기 →</button></div>
    </section>
  );
}

// ── VM 펼침(NIC 별 DNS + 변경 이력) ──────────────────────────────────────────
function VmExpand({ vm }) {
  const [res, setRes] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let on = true;
    setRes(null); setErr(null);
    fetchJson('/tools/vm-dns/vm', { id: vm.id })
      .then((d) => { if (on) setRes(d); })
      .catch((e) => { if (on) setErr(e); });
    return () => { on = false; };
  }, [vm.id]);
  const nics = Array.isArray(vm.nics) ? vm.nics.filter((n) => n && typeof n === 'object') : [];
  const note = mismatchNote(vm);
  const hist = Array.isArray(res?.history) ? res.history.filter((h) => h && typeof h === 'object') : [];
  const info = Array.isArray(res?.vm?.serverInfo) ? res.vm.serverInfo.filter((x) => x && x.ip) : [];
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, padding: '4px 4px 10px', whiteSpace: 'normal' }}>
      <div style={{ flex: '1 1 420px', minWidth: 0, borderRadius: 12, border: '1px solid var(--border)', background: 'var(--panel-deep)', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>NIC 별 DNS</div>
        {nics.length === 0 && <div className="muted" style={{ fontSize: 12 }}>어댑터 설정을 보고하지 않았습니다.</div>}
        {nics.map((n, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.2fr) minmax(0,1.2fr) minmax(0,1.6fr)', gap: 10, fontSize: 12, alignItems: 'center' }}>
            <span style={{ overflowWrap: 'anywhere' }}>{n.network || '—'}{n.dhcp === true ? ' · DHCP' : ''}</span>
            <span className="muted" style={{ fontFamily: MONO, overflowWrap: 'anywhere' }}>{n.mac || '—'}</span>
            <span style={{ fontFamily: MONO, overflowWrap: 'anywhere' }}>{ipsText(n.servers)}</span>
          </div>
        ))}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.2fr) minmax(0,1.2fr) minmax(0,1.6fr)', gap: 10, fontSize: 12, alignItems: 'center', borderTop: '1px solid var(--border-soft)', paddingTop: 8 }}>
          <span>OS 스택(실제 사용)</span><span className="muted">—</span>
          <span style={{ fontFamily: MONO, overflowWrap: 'anywhere' }}>{Array.isArray(vm.osServers) && vm.osServers.length ? ipsText(vm.osServers) : '보고 안 함'}</span>
        </div>
        {note && <div style={{ fontSize: 12, color: 'var(--amber)' }}>{note}</div>}
        {info.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, borderTop: '1px solid var(--border-soft)', paddingTop: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 600 }}>쓰는 서버(순서대로)</div>
            {info.map((x, i) => {
              const r = reachText(x.probe);
              return (
                <div key={`${x.ip}-${i}`} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', fontSize: 12 }}>
                  <span style={{ fontFamily: MONO, minWidth: 110 }}>{i + 1}. {x.ip}</span>
                  <Badge tone={kindBadge(x.kind)}>{kindLabel(x.kind)}</Badge>
                  <span className="muted" style={{ overflowWrap: 'anywhere' }}>{whoText(x)}</span>
                  <Badge tone={policyBadge(x.policy)} title={POLICY_TITLE[x.policy]}>{policyLabel(x.policy)}</Badge>
                  {x.otherCorp && <Badge tone="amber">다른 법인</Badge>}
                  <span style={{ color: TONE_COLOR[r.tone] }} title={r.where || undefined}>{r.text}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div style={{ flex: '1 1 360px', minWidth: 0, borderRadius: 12, border: '1px solid var(--border)', background: 'var(--panel-deep)', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>이 VM 의 DNS 변경 이력</div>
        {err ? <ErrorBox error={err} /> : !res ? <span className="muted" style={{ fontSize: 12 }}>불러오는 중…</span>
          : res.historyAvailable === false ? <span style={{ fontSize: 12, color: 'var(--amber)' }}>변경 이력 저장소를 쓸 수 없습니다 — 기록이 없다는 뜻이 아닙니다{res.historyReason ? `(${String(res.historyReason).slice(0, 160)})` : ''}.</span>
          : hist.length === 0 ? <span className="muted" style={{ fontSize: 12 }}>기록된 변경이 없습니다(첫 관측은 변경으로 세지 않습니다).</span>
            : hist.map((h, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12 }}>
                <span className="muted" style={{ fontFamily: MONO, whiteSpace: 'nowrap' }}>{dateTimeText(h.ts)}</span>
                <span style={{ fontFamily: MONO, textAlign: 'right', overflowWrap: 'anywhere' }}>{h.first ? `첫 관측 · ${ipsText(h.after)}` : `${ipsText(h.before)} → ${ipsText(h.after)}`}</span>
              </div>
            ))}
      </div>
    </div>
  );
}

function IpChips({ list, vm, byIp }) {
  const xs = Array.isArray(list) ? list.filter((x) => typeof x === 'string' && x) : [];
  if (!xs.length) return <span className="muted">—</span>;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {xs.map((ip, i) => <Badge key={`${ip}-${i}`} tone={ipBadge(ip, vm, byIp)} mono>{ip}</Badge>)}
    </div>
  );
}

// ── DNS 서버 상세 탭 ─────────────────────────────────────────────────────────
export function ServerDetail({ ip, vcId, data, byIp, onBack, onPick }) {
  const [res, setRes] = useState(null);
  const [err, setErr] = useState(null);
  const [limit, setLimit] = useState(500);
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState('');
  const [rowsAll, setRowsAll] = useState(false);
  const gen = useRef(0);
  const ROW_CAP = 300;   // 화면에 그리는 행 상한(정렬 뒤 자른다 — STable limit). 수천 행을 한 번에 그리면 화면이 멈춘다(v2.596 PERFWEB-01).
  useEffect(() => { setFilter('all'); setOpen(''); setLimit(500); setRowsAll(false); }, [ip]);
  useEffect(() => {
    if (!ip) { setRes(null); return undefined; }
    const my = ++gen.current;
    setRes(null); setErr(null);
    fetchJson('/tools/vm-dns/server', { ip, vcenterId: vcId || undefined, limit })
      .then((d) => { if (my === gen.current) setRes(d); })
      .catch((e) => { if (my === gen.current) setErr(e); });
    return undefined;
  }, [ip, vcId, limit]);
  const vms = useMemo(() => (Array.isArray(res?.vms) ? res.vms.filter((v) => v && typeof v === 'object' && v.id) : []), [res]);
  const counts = useMemo(() => filterCounts(vms, ip), [vms, ip]);
  const shown = useMemo(() => searchVms(vms.filter((v) => vmMatches(v, filter, ip)), q), [vms, filter, ip, q]);
  const servers = Array.isArray(data?.servers) ? data.servers : [];

  const picker = (
    <label style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 13 }}>
      <span className="muted">DNS 서버</span>
      <select className="select" value={ip || ''} onChange={(e) => onPick(e.target.value)} style={{ maxWidth: '100%', minWidth: 0 }}>
        <option value="">주소를 고르세요</option>
        {servers.map((s) => <option key={s.ip} value={s.ip}>{s.ip} — {kindLabel(s.kind)} · VM {nText(s.vms)}</option>)}
        {ip && !servers.some((s) => s.ip === ip) && <option value={ip}>{ip}</option>}
      </select>
    </label>
  );

  if (!ip) {
    return (
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {picker}
        <div className="muted" style={{ fontSize: 13 }}>개요의 DNS 서버 표에서 주소를 누르거나 위에서 고르면, 그 주소를 쓰는 VM 과 NIC·OS 설정, 변경 이력을 봅니다.</div>
      </div>
    );
  }
  const s = res?.server || servers.find((x) => x.ip === ip) || null;
  const reach = reachText(s?.probe);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr)', gap: 14, minWidth: 0 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
        <button className="btn btn-sm" onClick={onBack}>← DNS 서버 목록</button>
        {picker}
      </div>
      <section className="card" style={{ background: 'linear-gradient(180deg, var(--panel-2), var(--panel))', display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0, flex: '1 1 380px' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
            <span style={{ fontFamily: MONO, fontSize: 28, fontWeight: 600, overflowWrap: 'anywhere' }}>{ip}</span>
            {s && <Badge tone={kindBadge(s.kind)}>{kindLabel(s.kind)} · {whoText(s)}</Badge>}
            {s && <Badge tone={policyBadge(s.policy)} title={POLICY_TITLE[s.policy]}>{policyHeadText(s)}</Badge>}
          </div>
          {s && <div className="muted" style={{ fontSize: 13, lineHeight: 1.6 }}>{serverHeadDesc(s)}</div>}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24 }}>
          {[['사용 VM', nText(s?.vms)], ['법인', s ? nText(Array.isArray(s.corps) ? s.corps.length : null) : '—'], ['첫 DNS 로 사용', nText(s?.firstVms)]].map(([l, v]) => (
            <div key={l} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span className="muted" style={{ fontSize: 12 }}>{l}</span>
              <span style={{ fontFamily: MONO, fontSize: 24, fontWeight: 600 }}>{v}</span>
            </div>
          ))}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span className="muted" style={{ fontSize: 12 }}>마지막 도달성 점검</span>
            <span style={{ fontSize: 14, fontWeight: 500, color: TONE_COLOR[reach.tone], marginTop: 4 }}>{reach.text}</span>
            <span className="muted" style={{ fontSize: 12 }}>{[reach.where, s?.probe?.at ? agoText(tsMs(s.probe.at)) : ''].filter(Boolean).join(' · ') || '—'}</span>
          </div>
        </div>
      </section>

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
        {SERVER_FILTERS.map(([k, l]) => (
          <button key={k} className={`tab${filter === k ? ' active' : ''}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>
            {l} <span style={{ fontFamily: MONO, opacity: 0.75 }}>{res ? nText(counts[k]) : '—'}</span>
          </button>
        ))}
        <span style={{ flex: '1 1 120px' }} />
        <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="VM 이름 · vCenter · 도메인 · 주소" style={{ minWidth: 0, width: 260, maxWidth: '100%' }} />
      </div>

      <section className="card" style={{ ...PANEL }}>
        {err ? (
          <div style={{ padding: 14 }}>
            {err.status === 404 ? <span className="muted" style={{ fontSize: 13 }}>{err.message || '이 주소를 DNS 서버로 쓰는 VM 이 보이는 범위 안에 없습니다.'}{vcId ? ' — 위 vCenter 선택을 ‘전체’ 로 바꿔 보세요.' : ''}</span> : <ErrorBox error={err} />}
          </div>
        ) : !res ? <Loading /> : (
          <STable minWidth={1160} limit={rowsAll ? 0 : ROW_CAP}>
            <thead>
              <tr><th>VM</th><th>vCenter</th><th>전원</th><th>OS 가 쓰는 DNS(순서대로)</th><th>NIC 설정 DNS</th><th>도메인</th><th>방식</th><th>판정</th></tr>
            </thead>
            <tbody>
              {shown.map((vm) => {
                const pw = powerText(vm.powerState);
                const isOpen = open === vm.id;
                const toggle = () => setOpen(isOpen ? '' : vm.id);
                return (
                  <React.Fragment key={vm.id}>
                    <tr style={isOpen ? { background: 'var(--hover)' } : undefined}>
                      <td data-sort={vm.name || ''} style={{ fontWeight: 600, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        <ClickText onClick={toggle} title="NIC 별 설정과 변경 이력 펼치기">{isOpen ? '▾' : '▸'} {vm.name || vm.id}</ClickText>
                        {isFirstFor(vm, ip) && <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>첫 DNS</span>}
                      </td>
                      <td>{vm.vcenterName || vm.vcenterId || '—'}</td>
                      <td data-sort={pw.text}>{pw.badge ? <Badge tone={pw.badge}>{pw.text}</Badge> : '—'}</td>
                      <td data-sort={ipsText(vm.osServers)}><IpChips list={vm.osServers} vm={vm} byIp={byIp} /></td>
                      <td data-sort={ipsText(vm.nicServers)}><IpChips list={vm.nicServers} vm={vm} byIp={byIp} /></td>
                      <td style={{ fontFamily: MONO, fontSize: 12, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }} title={vm.domain || ''}>{vm.domain || '—'}</td>
                      <td>{modeText(vm.dhcp)}</td>
                      <td data-sort={(vm.flags || []).length}>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                          {flagChips(vm.flags).map((f) => <Badge key={f.key} tone={f.badge}>{f.label}</Badge>)}
                          {!flagChips(vm.flags).length && <span className="muted">—</span>}
                        </div>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr><td colSpan={8} style={{ background: 'var(--hover)' }}><VmExpand vm={vm} /></td></tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </STable>
        )}
        <div style={{ ...FOOT, display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: 'space-between', alignItems: 'center' }}>
          <span>
            {res ? vmListFoot(res, shown.length) : '—'}
            {shown.length > ROW_CAP && !rowsAll ? ` · 그중 ${nText(ROW_CAP)}행만 그렸습니다(제목을 누르면 전체를 정렬한 상위 ${nText(ROW_CAP)}행)` : ''}
            {' · 행의 이름을 누르면 NIC 별 설정과 변경 이력이 펼쳐집니다'}
          </span>
          {shown.length > ROW_CAP && <button className="btn btn-sm" onClick={() => setRowsAll((x) => !x)}>{rowsAll ? `${nText(ROW_CAP)}행만` : `${nText(shown.length)}행 모두 그리기`}</button>}
          {res?.truncated && limit < 2000 && <button className="btn btn-sm" onClick={() => setLimit(2000)}>2,000대까지 불러오기</button>}
          <span>꺼진 VM 의 DNS 는 마지막으로 보고된 값입니다</span>
        </div>
      </section>
    </div>
  );
}

// ── 정책 · 도달성 탭 ─────────────────────────────────────────────────────────
function PolicyRow({ row, byIp, canWrite, onAdd, onRemove }) {
  const [text, setText] = useState('');
  const prev = previewPolicyInput(text, row.list);
  const good = prev.filter((x) => x.ok);
  const vt = violText(row);
  const add = () => { if (!good.length) return; onAdd(row.id, good.map((x) => x.value)); setText(''); };
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', padding: '12px 18px', borderTop: '1px solid var(--border-soft)' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: '0 1 160px' }}>
        <b style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{row.name}</b>
        <span className="muted" style={{ fontSize: 12 }}>{row.orphan ? '목록에 없는 vCenter(삭제됐거나 범위 밖) — 저장된 값' : `VM ${nText(row.vms)}대`}</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', minWidth: 0, flex: '999 1 320px' }}>
        {row.list.length === 0 && <span className="muted" style={{ fontSize: 12 }}>승인 목록 없음</span>}
        {row.list.map((v) => {
          const who = byIp.get(v);
          return (
            <span key={v} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, padding: '0 6px 0 10px', borderRadius: 8, background: 'var(--panel-deep)', border: '1px solid var(--border)', fontFamily: MONO, fontSize: 12 }}>
              {v}{who && <span className="muted" style={{ fontFamily: 'inherit' }}>{whoText(who)}</span>}
              {canWrite && <button type="button" aria-label={`${v} 빼기`} title="이 주소 빼기" onClick={() => onRemove(row.id, v)} style={{ width: 20, height: 20, border: 0, borderRadius: 5, background: 'transparent', color: 'var(--text-dim)', cursor: 'pointer', font: 'inherit', lineHeight: 1 }}>×</button>}
            </span>
          );
        })}
        {canWrite && (
          <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            <input className="input" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
              placeholder="+ 주소 · 대역(10.20.0.0/24)" style={{ minWidth: 0, width: 210, height: 30, fontSize: 12 }} />
            <button className="btn btn-sm" onClick={add} disabled={!good.length}>추가</button>
          </span>
        )}
        {text.trim() && prev.length > 0 && (
          <div style={{ flexBasis: '100%', fontSize: 12, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {prev.map((x, i) => (
              <span key={i} style={{ color: x.ok ? (x.warn ? 'var(--amber)' : 'var(--green)') : 'var(--red)' }}>
                {x.ok ? `✓ ${x.value}${x.warn ? ` — ${x.warn}` : ''}` : `✗ ‘${x.raw}’ — ${x.reason}`}
              </span>
            ))}
          </div>
        )}
      </div>
      <div style={{ marginLeft: 'auto', flex: 'none' }}>
        <span title={vt.title} style={{ fontSize: 12, padding: '4px 10px', borderRadius: 8, background: 'var(--panel-deep)', color: TONE_COLOR[vt.tone], whiteSpace: 'nowrap' }}>{vt.text}</span>
      </div>
    </div>
  );
}

export function PolicyPanel({ vcList, servers, byIp, policy, policyErr, canWrite, onSaved, data, onProbe, probeBusy, draft, setDraft, vcId = '' }) {
  // 초안(draft)은 루트가 들고 있다 — 탭을 옮겨 다녀와도 저장하지 않은 편집이 사라지지 않게.
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);
  const [saveErr, setSaveErr] = useState(null);
  const rows = useMemo(() => policyRows(vcList, draft || policy), [vcList, draft, policy]);
  const dirty = !!(draft && policy && !samePolicy(draft, policy));
  const vcName = (id) => (vcList.find((v) => String(v.id) === String(id))?.name) || id;
  const setList = (id, fn) => setDraft((d) => {
    const base = d || normPolicy(policy);
    const cur = Array.isArray(base.corps[id]) ? base.corps[id] : [];
    return { ...base, corps: { ...base.corps, [id]: fn(cur) } };
  });
  const save = async () => {
    if (!draft || saving) return;
    setSaving(true); setSaveMsg(null); setSaveErr(null);
    try {
      const r = await putJson('/tools/vm-dns/policy', { corps: draft.corps, publicUnapproved: draft.publicUnapproved, rev: policy?.rev });
      if (r && r.ok === false) {
        const inv = Array.isArray(r.invalid) ? r.invalid : [];
        setSaveMsg({ tone: 'bad', lines: inv.length ? inv.map((x) => invalidText(x, vcName)) : [`저장하지 못했습니다: ${r.reason || r.error || '알 수 없는 사유'}`] });
      } else {
        const orphan = Array.isArray(r?.orphan) ? r.orphan : [];
        setSaveMsg({ tone: 'ok', lines: ['정책을 저장했습니다 — 다음 화면 조회부터 바로 반영됩니다(vCenter 재수집 없음).', ...(orphan.length ? [`목록에 없는 vCenter 키 ${orphan.length}개도 그대로 저장했습니다: ${orphan.join(', ')}`] : [])] });
        await onSaved();   // 루트가 정책을 다시 읽고 초안을 서버 값으로 맞춘다(서버가 정리한 표기를 그대로 보이게)
      }
    } catch (e) {
      if (isDenied(e)) setSaveErr(e);
      else setSaveMsg({ tone: 'bad', lines: [`저장하지 못했습니다: ${e?.message || e}`] });
    }
    finally { setSaving(false); }
  };
  const probe = data?.probe && typeof data.probe === 'object' ? data.probe : {};
  const cards = probeSummaryCards(probe.summary);
  const nServers = Array.isArray(servers) ? servers.length : 0;
  const savedInvalid = Array.isArray(policy?.invalid) ? policy.invalid : [];

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
      <section className="card" style={{ ...PANEL, flex: '999 1 620px' }}>
        <SectionTitle
          title="법인별 승인 DNS"
          sub="비어 있는 법인은 판정하지 않습니다('정책 없음' — 위반으로 세지 않음)"
          right={(
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: canWrite ? 'pointer' : 'default' }}>
              <input type="checkbox" checked={draft ? draft.publicUnapproved : policy?.publicUnapproved !== false} disabled={!canWrite || !draft}
                onChange={(e) => setDraft((d) => ({ ...(d || normPolicy(policy)), publicUnapproved: e.target.checked }))} />
              공인 DNS 는 어느 법인에서도 비승인
            </label>
          )}
        />
        {policyErr && !policy ? <div style={{ padding: 14 }}><ErrorBox error={policyErr} /></div> : !policy ? <Loading /> : (
          <>
            {savedInvalid.length > 0 && (
              <div style={{ padding: '10px 18px', fontSize: 12, color: 'var(--amber)' }}>
                저장된 항목 중 형식이 틀린 {savedInvalid.length}개는 판정에 쓰지 않습니다: {savedInvalid.slice(0, 6).map((x) => invalidText(x, vcName)).join(' · ')}{savedInvalid.length > 6 ? ' …' : ''}
              </div>
            )}
            {rows.length === 0 && <div className="muted" style={{ padding: 16, fontSize: 13 }}>조회 범위에 vCenter 가 없습니다.</div>}
            {rows.map((r) => (
              <PolicyRow key={r.id} row={r} byIp={byIp} canWrite={canWrite}
                onAdd={(id, vals) => setList(id, (cur) => [...new Set([...cur, ...vals])])}
                onRemove={(id, v) => setList(id, (cur) => cur.filter((x) => x !== v))} />
            ))}
          </>
        )}
        <div style={{ ...FOOT, display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
          <span style={{ flex: '1 1 260px' }}>IP 하나 또는 대역(10.20.0.0/24)으로 넣을 수 있습니다 · 저장하면 다음 화면 조회부터 바로 반영됩니다(vCenter 재수집 없음){!canWrite ? ' · 정책은 전체 범위 관리자만 바꿀 수 있습니다' : ''}</span>
          {canWrite && (
            <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              {dirty && <span style={{ fontSize: 12, color: 'var(--amber)' }}>저장하지 않은 변경이 있습니다</span>}
              <button className="btn" onClick={() => { setDraft(normPolicy(policy)); setSaveMsg(null); }} disabled={!dirty || saving}>변경 취소</button>
              <button className="btn primary" onClick={save} disabled={!dirty || saving}>{saving ? '저장 중…' : '정책 저장'}</button>
            </span>
          )}
        </div>
        {saveErr && <div style={{ padding: '0 18px 14px' }}><ErrorBox error={saveErr} /></div>}
        {saveMsg && (
          <div style={{ padding: '0 18px 14px', fontSize: 12, color: saveMsg.tone === 'ok' ? 'var(--green)' : 'var(--red)', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {saveMsg.lines.map((l, i) => <span key={i}>{l}</span>)}
          </div>
        )}
      </section>

      <section className="card" style={{ ...PANEL, flex: '1 1 460px' }}>
        <SectionTitle
          title="DNS 도달성 점검"
          sub="53번에 실제 질의를 보내 응답을 봅니다 · 누를 때만 실행"
          right={canWrite ? (
            <button className="btn primary" onClick={onProbe} disabled={probeBusy || probe.running === true || !nServers}>
              {probeBusy || probe.running ? '점검 중…' : vcId ? '지금 점검(전 법인 주소)' : `지금 점검 (${nServers}개)`}
            </button>
          ) : <span className="muted" style={{ fontSize: 12 }}>점검 실행은 전체 범위 관리자만</span>}
        />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(110px, 100%), 1fr))', gap: 10, padding: '12px 18px 4px' }}>
          {cards.map((c) => (
            <div key={c.key} style={{ borderRadius: 10, background: 'var(--panel-deep)', padding: '10px 12px', minWidth: 0 }}>
              <div style={{ fontSize: 12, color: TONE_COLOR[c.tone] }}>{c.label}</div>
              <div style={{ fontFamily: MONO, fontSize: 22, fontWeight: 600 }}>{c.value}</div>
            </div>
          ))}
        </div>
        <div className="muted" style={{ padding: '4px 18px', fontSize: 12 }}>
          {probe.lastRunAt ? `마지막 점검 ${dateTimeText(probe.lastRunAt)}(${agoText(tsMs(probe.lastRunAt))}) · 결과는 메모리에만 있어 포탈을 재시작하면 지워집니다` : '아직 점검한 적이 없습니다(재시작하면 결과가 지워집니다)'}
          {skippedByText(probe.summary) ? ` · 건너뜀: ${skippedByText(probe.summary)}` : ''}
        </div>
        {nServers > 0 && (
          <STable minWidth={720} limit={50}>
            <thead><tr><th>서버</th><th>UDP</th><th>TCP</th><th>질의 이름</th><th>잰 곳</th><th>시각</th></tr></thead>
            <tbody>
              {servers.map((s) => {
                const p = s.probe && typeof s.probe === 'object' ? s.probe : null;
                const measured = !!p && p.where !== 'edge-only' && !p.skipped;
                const u = reachText(p ? { ...p, tcp: null } : null);
                const t = reachText(p ? { ...p, udp: null } : null);
                return (
                  <tr key={s.ip}>
                    <td data-sort={ipSortKey(s.ip) ?? ''} style={{ fontFamily: MONO, fontWeight: 600 }}>{s.ip}</td>
                    <td style={{ fontFamily: MONO, color: TONE_COLOR[measured ? u.tone : 'muted'] }}>{measured ? u.text.replace(/^udp /, '') : '—'}</td>
                    <td style={{ fontFamily: MONO, color: TONE_COLOR[measured ? t.tone : 'muted'] }}>{measured ? t.text.replace(/^tcp /, '') : '—'}</td>
                    <td className="muted" style={{ fontFamily: MONO }}>{qnameText(p?.qname)}</td>
                    <td className="muted" style={{ whiteSpace: 'normal', minWidth: 160 }}>{!p ? '점검 안 함' : p.where === 'edge-only' ? '중앙에서 못 잼(엣지 법인만 사용)' : p.skipped ? `중앙 · ${reachText(p).where}` : p.where === 'central' ? '중앙' : '—'}</td>
                    <td className="muted" data-sort={tsMs(p?.at) ?? ''}>{p?.at ? agoText(tsMs(p.at)) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </STable>
        )}
        <div style={FOOT}>
          {vcId ? '아래 표는 위에서 고른 vCenter 의 VM 이 쓰는 주소만입니다 — 점검은 언제나 전 법인 주소를 대상으로 합니다. ' : ''}
          엣지가 수집하는 법인의 사내 DNS 는 중앙에서 닿지 않는 것이 정상일 수 있어 '중앙에서 못 잼' 으로 따로 셉니다 — 실패로 세지 않습니다. 응답 패킷을 받으면 응답 코드와 무관하게 '응답' 입니다.
          {nServers > 50 ? ` · 처음 50개만 보입니다(제목을 누르면 전체를 정렬한 상위 50개).` : ''}
        </div>
      </section>
    </div>
  );
}

// ── 변경 이력 탭 ─────────────────────────────────────────────────────────────
const DAY_CHOICES = [1, 7, 30, 90];
export function ChangesPanel({ vcId, kindOf, onPickIp, history }) {
  const [days, setDays] = useState(7);
  const [res, setRes] = useState(null);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState('');
  const gen = useRef(0);
  const LIMIT = 200;
  const load = useCallback(() => {
    const my = ++gen.current;
    setRes(null); setErr(null);
    fetchJson('/tools/vm-dns/changes', { days, limit: LIMIT, vcenterId: vcId || undefined })
      .then((d) => { if (my === gen.current) setRes(d); })
      .catch((e) => { if (my === gen.current) setErr(e); });
  }, [days, vcId]);
  useEffect(() => { load(); }, [load]);
  const list = useMemo(() => {
    const xs = Array.isArray(res?.changes) ? res.changes.filter((c) => c && typeof c === 'object') : [];
    return vcId ? xs.filter((c) => !c.vcenterId || String(c.vcenterId) === String(vcId)) : xs;
  }, [res, vcId]);
  const note = changesNote(res ? { ...res, changes: list } : null, days);
  const now = Date.now();
  return (
    <section className="card" style={{ ...PANEL }}>
      <SectionTitle
        title="DNS 설정 변경 이력"
        sub="VM 이 쓰는 DNS 서버 주소가 바뀐 순간만 기록합니다(약 10분 주기 · 스냅샷만 읽음)"
        right={(
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {DAY_CHOICES.map((d) => <button key={d} className={`tab${days === d ? ' active' : ''}`} aria-pressed={days === d} onClick={() => setDays(d)}>{d}일</button>)}
            <button className="tab" onClick={load}>다시 읽기</button>
          </div>
        )}
      />
      {err ? <div style={{ padding: 14 }}><ErrorBox error={err} /></div> : !res ? <Loading /> : note ? (
        <div style={{ padding: 16, fontSize: 13, color: note.tone === 'warn' ? 'var(--amber)' : 'var(--text-dim)' }}>{note.text}</div>
      ) : (
        <STable minWidth={900}>
          <thead><tr><th>시각</th><th>VM</th><th>vCenter</th><th>이전</th><th>이후</th><th>구분</th></tr></thead>
          <tbody>
            {list.map((ch, i) => {
              const key = `${ch.vmId}-${ch.ts}-${i}`;
              const tone = CHANGE_TONE[changeTone(ch, kindOf)] || CHANGE_TONE.info;
              const isOpen = open === key;
              return (
                <React.Fragment key={key}>
                  <tr>
                    <td data-sort={tsMs(ch.ts) ?? ''} style={{ fontFamily: MONO, fontSize: 12 }} title={dateTimeText(ch.ts)}>{whenText(ch.ts, now)}</td>
                    <td data-sort={ch.vmName || ''} style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {ch.vmId ? <ClickText onClick={() => setOpen(isOpen ? '' : key)} title="이 VM 의 NIC 별 설정과 변경 이력 펼치기">{isOpen ? '▾' : '▸'} {ch.vmName || ch.vmId}</ClickText> : (ch.vmName || '—')}
                    </td>
                    <td>{ch.vcenterName || ch.vcenterId || '—'}</td>
                    <td style={{ fontFamily: MONO, fontSize: 12, whiteSpace: 'normal' }} className="muted">{ch.first ? '—' : ipsText(ch.before)}</td>
                    <td style={{ fontFamily: MONO, fontSize: 12, whiteSpace: 'normal' }}>
                      {(Array.isArray(ch.after) ? ch.after : []).length === 0 ? ipsText(ch.after) : ch.after.map((ip, j) => (
                        <React.Fragment key={`${ip}-${j}`}>{j > 0 ? ', ' : ''}<ClickText onClick={() => onPickIp(ip)} title="이 주소의 상세 보기">{ip}</ClickText></React.Fragment>
                      ))}
                    </td>
                    <td data-sort={tone.label}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: tone.color, flex: 'none' }} />{tone.label}</span></td>
                  </tr>
                  {isOpen && ch.vmId && (
                    <tr><td colSpan={6} style={{ background: 'var(--hover)' }}><VmHistoryOnly id={ch.vmId} /></td></tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </STable>
      )}
      <div style={FOOT}>
        {res && list.length >= LIMIT ? `최근 ${LIMIT}건까지만 보입니다 — 기간을 줄이면 빠진 것이 없습니다. ` : ''}
        {res?.capped ? '서버가 범위 필터를 위해 읽는 상한(2만 건)에 닿았습니다 — 이 기간의 더 오래된 변경은 빠졌을 수 있습니다. ' : ''}
        {historyNote(history) ? `${historyNote(history)}. ` : ''}
        첫 관측은 변경으로 기록하지 않고, VMware Tools 가 DNS 를 보고하지 않은 순간(모름)은 '빈 DNS 로 바뀜' 으로 기록하지 않습니다.
        {res?.since ? ` · 조회 시작 ${dateTimeText(res.since)}` : ''}
      </div>
    </section>
  );
}

/** 변경 이력 탭의 펼침 — /tools/vm-dns/vm 의 vm 원소를 받아 VmExpand 를 그린다. */
function VmHistoryOnly({ id }) {
  const [res, setRes] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let on = true;
    fetchJson('/tools/vm-dns/vm', { id }).then((d) => { if (on) setRes(d); }).catch((e) => { if (on) setErr(e); });
    return () => { on = false; };
  }, [id]);
  if (err) return <ErrorBox error={err} />;
  if (!res) return <span className="muted" style={{ fontSize: 12 }}>불러오는 중…</span>;
  const vm = res.vm && typeof res.vm === 'object' ? res.vm : { id };
  return <VmExpand vm={{ ...vm, id: vm.id || id }} />;
}

// ── 루트 ─────────────────────────────────────────────────────────────────────
export default function VmDnsTool({ scope = '' } = {}) {
  // ⚠ 훅은 전부 여기(조기 return 없음 — 본문 분기는 JSX 안에서).
  const [tab, setTab] = useHashTab({ base: ['tools', 'vm-dns'], valid: TABS, fallback: 'overview' });
  const [vcId, setVcId] = useState(scope || '');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [vcList, setVcList] = useState([]);
  const [policy, setPolicy] = useState(null);
  const [policyErr, setPolicyErr] = useState(null);
  const [selIp, setSelIp] = useState('');
  const [msg, setMsg] = useState(null);           // { tone, text }
  const [actionErr, setActionErr] = useState(null);
  const [probeBusy, setProbeBusy] = useState(false);
  const [csvBusy, setCsvBusy] = useState(false);
  const [draft, setDraft] = useState(null);      // 정책 편집 초안(저장 전)
  const gen = useRef(0);
  const pgen = useRef(0);
  const syncDraft = useRef(true);                 // 다음 정책 응답으로 초안을 맞출지(첫 로드·저장 직후)

  useEffect(() => { setVcId(scope || ''); }, [scope]);

  const load = useCallback(async (vc) => {
    const my = ++gen.current;
    setLoading(true);
    try {
      const d = await fetchJson('/tools/vm-dns', vc ? { vcenterId: vc } : {});
      if (my !== gen.current) return;              // 늦게 온 이전 응답은 버린다
      setData(d); setError(null);
      const list = Array.isArray(d?.vcenters) ? d.vcenters.filter((v) => v && v.id) : [];
      // 칩은 '전체' 응답의 vCenter 목록을 쓴다 — vCenter 를 고른 응답이 목록을 좁혀 보내도 칩이 사라지지 않게.
      setVcList((prev) => (!vc || list.length >= prev.length ? list : prev));
    } catch (e) {
      if (my === gen.current) setError(e);
    } finally {
      if (my === gen.current) setLoading(false);
    }
  }, []);
  const loadPolicy = useCallback(async () => {
    const my = ++pgen.current;
    try {
      const p = await fetchJson('/tools/vm-dns/policy');
      if (my !== pgen.current) return;
      const pol = p && typeof p === 'object' ? p : null;
      setPolicy(pol); setPolicyErr(null);
      // 편집 중인 초안은 새로고침으로 지우지 않는다 — 첫 로드·저장 직후·초안이 서버 값과 같을 때만 맞춘다.
      setDraft((d) => (syncDraft.current || !d || !pol || samePolicy(d, pol) ? (pol ? normPolicy(pol) : null) : d));
      syncDraft.current = false;
    } catch (e) { if (my === pgen.current) setPolicyErr(e); }
  }, []);

  // vCenter 를 바꾸면 이전 범위 값을 지운다 — 다른 범위의 숫자가 잠깐이라도 새 범위인 척하지 않게.
  useEffect(() => { setData(null); setError(null); load(vcId); }, [vcId, load]);
  useEffect(() => { loadPolicy(); }, [loadPolicy]);

  const servers = useMemo(() => (Array.isArray(data?.servers) ? data.servers.filter((s) => s && s.ip) : []), [data]);
  const byIp = useMemo(() => new Map(servers.map((s) => [s.ip, s])), [servers]);
  const kindOf = useCallback((ip) => byIp.get(ip)?.kind || null, [byIp]);

  const u = getCurrentUser();
  const fullScope = !(u?.scope?.vcenters?.length || u?.scope?.regions?.length);
  const canWrite = hasRole('admin') && fullScope;
  const showCsv = canCsv();

  const refresh = () => { setMsg(null); setActionErr(null); load(vcId); loadPolicy(); };
  const openServer = (ip) => { setSelIp(ip || ''); setTab('server'); };

  const runProbe = async () => {
    if (probeBusy) return;
    setProbeBusy(true); setMsg(null); setActionErr(null);
    try {
      const r = await postJson('/tools/vm-dns/probe', {});
      if (r && r.ok === false) {
        const busy = r.code === 'busy' || r.reason === 'busy' || r.error === 'busy';
        setMsg({ tone: 'warn', text: busy ? '이미 점검이 진행 중입니다 — 끝난 뒤 새로고침하세요.' : `점검을 시작하지 못했습니다: ${r.reason || r.error || '알 수 없는 사유'}` });
      } else {
        const s = r?.summary || {};
        setMsg({ tone: 'ok', text: `점검을 마쳤습니다 — 응답 ${nText(s.answered)} · 응답 없음 ${nText(s.failed)} · 중앙에서 못 잼 ${nText(s.edgeOnly)} · 건너뜀 ${nText(s.skipped)}` });
      }
      await load(vcId);
    } catch (e) {
      if (isDenied(e)) setActionErr(e);
      else setMsg({ tone: 'bad', text: `점검 실패: ${e?.message || e}` });
    } finally { setProbeBusy(false); }
  };

  const exportCsv = async () => {
    if (csvBusy) return;
    setCsvBusy(true); setMsg(null); setActionErr(null);
    try {
      const name = await downloadFile(`/tools/vm-dns.csv${vcId ? `?vcenterId=${encodeURIComponent(vcId)}` : ''}`);
      setMsg({ tone: 'ok', text: `CSV 를 내려받았습니다(${name}).` });
    } catch (e) {
      if (isDenied(e)) setActionErr(e);
      else setMsg({ tone: 'bad', text: `CSV 내려받기 실패: ${e?.message || e}` });
    }
    finally { setCsvBusy(false); }
  };

  const empty = emptyReason(data);
  const showChips = vcList.length > 0;

  let body;
  if (tab === 'policy') {
    body = (
      <PolicyPanel vcList={vcList} servers={servers} byIp={byIp} policy={policy} policyErr={policyErr} canWrite={canWrite}
        onSaved={async () => { syncDraft.current = true; await loadPolicy(); await load(vcId); }} data={data} onProbe={runProbe} probeBusy={probeBusy}
        draft={draft} setDraft={setDraft} vcId={vcId} />
    );
  } else if (tab === 'changes') {
    body = <ChangesPanel vcId={vcId} kindOf={kindOf} onPickIp={openServer} history={data?.history} />;
  } else if (error && !data) {
    body = <ErrorBox error={error} />;
  } else if (!data) {
    body = <Loading />;
  } else if (tab === 'server') {
    body = <ServerDetail ip={selIp} vcId={vcId} data={data} byIp={byIp} onBack={() => setTab('overview')} onPick={(ip) => setSelIp(ip)} />;
  } else {
    body = (
      <>
        <KpiRow cards={kpiCards(data.kpis, {
          vcCount: Array.isArray(data.vcenters) ? data.vcenters.length : null,
          publicUnapproved: data.policy && typeof data.policy.publicUnapproved === 'boolean' ? data.policy.publicUnapproved : policy ? policy.publicUnapproved !== false : null,
          initial: data.initial === true,
        })} />
        {empty && <div className="card" style={{ padding: '10px 14px', fontSize: 13, borderLeft: `3px solid ${empty.tone === 'warn' ? 'var(--amber)' : 'var(--accent)'}` }}><BoldText text={empty.text} /></div>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'stretch', minWidth: 0 }}>
          <ServerSection data={data} onPick={openServer} />
          <MatrixSection matrix={data.matrix} servers={servers} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(340px, 100%), 1fr))', gap: 16 }}>
          <DomainsCard domains={data.domains} search={data.search} />
          <ModeCard kpis={data.kpis} checks={data.checks} />
          <RecentChanges changes={data.changes} kindOf={kindOf} onMore={() => setTab('changes')} />
        </div>
        <div className="muted" style={{ fontSize: 12, lineHeight: 1.7 }}>
          · 대상은 템플릿을 뺀 VM 이고 켜짐·꺼짐을 모두 셉니다 — 꺼진 VM 의 DNS 는 마지막으로 보고된 값입니다.<br />
          · OS 가 실제로 쓰는 값(IP 스택)이 있으면 그것을, 없으면 NIC 설정을 씁니다. ‘모름’ 은 VMware Tools 가 보고하지 않은 VM, ‘미수집’ 은 그 VM 을 보낸 수집기(엣지)가 2.695 이전이라 DNS 를 보내지 않은 VM 입니다 — 둘 다 정상에도 0 에도 넣지 않습니다.
        </div>
      </>
    );
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr)', gap: 16, minWidth: 0 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          <div style={{ fontSize: 17, fontWeight: 700 }}>VM 이 쓰는 DNS 서버</div>
          <div className="muted" style={{ fontSize: 13 }}>
            게스트 OS 가 VMware Tools 로 보고한 DNS 설정을 vCenter 별로 모았습니다 · 스냅샷 {agoText(tsMs(data?.generatedAt))} · vCenter 추가 조회 없음
          </div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {tab !== 'policy' && <button className="btn" onClick={() => setTab('policy')}>🛡 승인 DNS 정책</button>}
          {showCsv && <button className="btn" onClick={exportCsv} disabled={csvBusy}>{csvBusy ? '내려받는 중…' : '⤓ CSV 내보내기'}</button>}
          {canWrite && <button className="btn primary" onClick={runProbe} disabled={probeBusy || data?.probe?.running === true}>{probeBusy ? '점검 중…' : 'DNS 도달성 점검'}</button>}
          <button className="btn" onClick={refresh} disabled={loading}>{loading ? '불러오는 중…' : '새로고침'}</button>
        </div>
      </div>

      <div role="tablist" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {TABS.map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>{TAB_LABEL[k]}</button>
        ))}
      </div>

      {showChips && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
          <span className="muted" style={{ fontSize: 13, marginRight: 4 }}>vCenter</span>
          {vcChips(vcList, vcId).map((c) => (
            <button key={c.id || '(all)'} className={`tab${c.active ? ' active' : ''}`} aria-pressed={c.active} title={c.title} onClick={() => setVcId(c.id)}>
              {c.label} <span style={{ fontFamily: MONO, opacity: 0.75 }}>{c.n}</span>
            </button>
          ))}
        </div>
      )}

      {error && data && <div style={{ fontSize: 12, color: 'var(--amber)' }}>새로고침 실패 — 아래는 직전 값입니다: {String(error?.message || error)}</div>}
      {msg && <div style={{ fontSize: 13, color: TONE_COLOR[msg.tone] || 'var(--text-dim)' }}>{msg.text}</div>}
      {actionErr && <ErrorBox error={actionErr} />}
      {data?.probe?.running === true && <div className="muted" style={{ fontSize: 12 }}>도달성 점검이 진행 중입니다 — 끝난 뒤 새로고침하면 결과가 보입니다.</div>}
      <ScopeOmitBanner data={scopeOf(data)} unit="vCenter" counter="개" why="내 조회 범위 밖" style={{ marginBottom: 0 }} />

      {body}
    </div>
  );
}

