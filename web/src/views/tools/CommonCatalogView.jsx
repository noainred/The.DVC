/**
 * 포탈 점검 › 공통 기능(v3.10 · 시안 docs/design/common-catalog ①~④).
 *
 * 솔루션 전체가 함께 쓰는 공용 모듈 목록 — 새 헬퍼 · 컴포넌트를 만들기 전에 ‘이미 있는가’ 를 찾는 화면이다.
 * 목록은 빌드할 때 `scripts/common-doc.mjs` 가 소스에서 만든 것이고 서버는 읽어 주기만 한다(배포본에 소스가 없다) —
 * 그래서 **마운트 1회만 받는다**(폴링 · ‘다시 만들기’ 없음).
 *
 * ⚠ 훅은 전부 조기 return 위에(React #310 — v2.202 사고). 거르기 · 세기 · 문구는 `commonCatalogText.js`(순수).
 * ⚠ 표는 `STable minWidth`(래퍼까지 함께 만든다) · `limit` 은 정렬 뒤에 자른다(먼저 자르면 정렬이 잘린 것만 본다).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { fetchJson } from '../../api.js';
import { Loading, ErrorBox, Kpi } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import EscClose from '../../components/EscClose.jsx';
import { copyText } from '../../util/copyText.js';
import {
  SCOPE_IDS, scopeLabel, summaryText, baseName, dirName, countText, kpiOf, chipCounts, applyFilter, exportsView,
  areaLabel, areaNote, builtText, footnoteText, statusView, emptyView, filterLabel, shownText,
} from './commonCatalogText.js';
import '../vms/vmHub.css';       // 오른쪽 서랍(.vmh-drawer …)을 그대로 쓴다 — 서랍 스타일을 한 벌 더 만들지 않는다
import './commonCatalog.css';

const PAGE = 50;
const MONO = { fontFamily: 'var(--mono)' };
const TONE = Object.freeze({ red: 'var(--red)', gray: 'var(--muted)' });
const keyOf = (m) => `${m.scope}|${m.file}`;

function Section({ title, children }) {
  return (
    <section className="vmh-sec">
      <h3 style={{ margin: 0, fontSize: 12, fontWeight: 600, color: 'var(--text-dim)' }}>{title}</h3>
      {children}
    </section>
  );
}

/** 모듈 상세 — 오른쪽 서랍(720 미만은 전체 화면). 목록이 뒤에 남는다. */
function ModuleDrawer({ m, onClose }) {
  // 'idle' | 'ok' | 'fail' — HTTP 포탈에서는 Clipboard API 가 없어 폴백으로 복사한다(util/copyText.js). 실패를 조용히 넘기지 않는다.
  const [copied, setCopied] = useState('idle');
  const copy = async () => setCopied((await copyText(m.file)) ? 'ok' : 'fail');
  const exportsAll = Array.isArray(m.exports) ? m.exports : [];
  const tests = Array.isArray(m.testFiles) ? m.testFiles : [];
  const areas = Array.isArray(m.areaCounts) ? m.areaCounts : [];
  return (
    <>
      <div className="vmh-drawer-overlay" onClick={onClose} aria-hidden="true" />
      <aside className="vmh-drawer" role="dialog" aria-modal="true" aria-label={`모듈 상세 — ${baseName(m.file)}`} tabIndex={-1}>
        <EscClose onClose={onClose} />
        <div className="vmh-dh">
          <div className="ttl">
            <h2 style={{ ...MONO, fontWeight: 500 }}>{baseName(m.file)}</h2>
            <span className="grow" />
            <button type="button" className="vmh-icon-btn" aria-label="닫기" title="닫기(Esc)" onClick={onClose}>×</button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px', alignItems: 'center', fontSize: 12, color: 'var(--text-dim)' }}>
            <span className="badge gray">{scopeLabel(m.scope)}</span>
            {m.twin && <span className="badge amber">두 벌</span>}
            <span>사용처 {countText(m.users)} · 영역 {countText(m.areas)} · 테스트 {countText(m.tests)}</span>
          </div>
        </div>
        <div className="vmh-db">
          <Section title="하는 일">
            <div style={{ fontSize: 13.5, lineHeight: 1.65, overflowWrap: 'anywhere' }}>{summaryText(m.summary) || '머리 주석이 없습니다.'}</div>
            <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>그 파일 맨 앞 주석의 첫 단락입니다. 자세한 규칙은 소스의 머리 주석에 있습니다.</div>
          </Section>

          <Section title={`내보내는 이름 ${countText(exportsAll.length)}`}>
            {exportsAll.length === 0
              ? <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{m.scope === 'outside' ? '공용 위치 밖 모듈은 내보내는 이름을 이 목록에 싣지 않았습니다.' : '내보내는 이름이 없습니다(진입점이거나 부수효과만 있는 모듈).'}</div>
              : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, ...MONO, fontSize: 12 }}>
                  {exportsAll.map((e) => <span key={e} className="cc-token">{e}</span>)}
                </div>
              )}
          </Section>

          <Section title="경로">
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <code className="cc-path">{m.file}</code>
              <button type="button" className="btn" onClick={copy}>{copied === 'ok' ? '복사됨' : '복사'}</button>
            </div>
            {copied === 'fail' && <div role="status" style={{ fontSize: 12, color: 'var(--amber)' }}>이 브라우저에서는 복사하지 못했습니다 — 경로를 직접 선택해 복사하십시오.</div>}
            {m.twin && <div style={{ fontSize: 12, color: 'var(--text-dim)', overflowWrap: 'anywhere' }}>같은 이름의 다른 한 벌: <span style={MONO}>{m.twin}</span></div>}
          </Section>

          <Section title={`사용처 ${countText(m.users)}개 파일 · 영역 ${countText(m.areas)}`}>
            {areas.length === 0
              ? <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>이 모듈을 import 하는 파일을 찾지 못했습니다 — 죽은 코드라는 뜻은 아닙니다(동적 import · 워커 진입점일 수 있습니다).</div>
              : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, fontSize: 12 }}>
                  {areas.map(([name, n]) => <span key={name} className="cc-area">{areaLabel(name)} <b className="tabular">{countText(n)}</b></span>)}
                </div>
              )}
            <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{areaNote(m.file)}</div>
          </Section>

          <Section title={`이 모듈을 가리키는 테스트 ${countText(m.tests)}`}>
            {tests.length === 0
              ? <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>경로로 이 모듈을 가리키는 테스트를 찾지 못했습니다 — 검증이 없다는 뜻은 아닙니다(경로를 조각으로 조합하면 세지 못합니다).</div>
              : (
                <div style={{ display: 'grid', gap: 2, ...MONO, fontSize: 12, overflowWrap: 'anywhere' }}>
                  {tests.map((t) => <div key={t}>{t}</div>)}
                  {Number.isFinite(m.tests) && m.tests > tests.length && (
                    <div style={{ fontFamily: 'inherit', color: 'var(--text-dim)' }}>외 {countText(m.tests - tests.length)}개</div>
                  )}
                </div>
              )}
          </Section>
        </div>
      </aside>
    </>
  );
}

export function CommonCatalogView() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [limit, setLimit] = useState(PAGE);
  const [openKey, setOpenKey] = useState('');

  useEffect(() => {
    // 마운트 1회(빌드 시점의 고정 값). 언마운트 뒤 도착한 응답은 버린다.
    let active = true;
    (async () => {
      try {
        const r = await fetchJson('/tools/portal-check/common');
        if (!active) return;
        setData(r); setError(null);
      } catch (e) {
        if (!active) return;
        setError(e);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  const modules = data?.status === 'ok' && Array.isArray(data.modules) ? data.modules : null;
  const kpi = useMemo(() => kpiOf(modules), [modules]);
  const chips = useMemo(() => chipCounts(modules), [modules]);
  const rows = useMemo(() => applyFilter(modules, { filter, q }), [modules, filter, q]);
  const open = useMemo(() => (openKey && modules ? modules.find((m) => keyOf(m) === openKey) || null : null), [modules, openKey]);

  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox error={error} />;

  const sv = statusView(data?.status);
  if (sv) {
    // 못 읽은 것은 0 이 아니다 — 숫자 자리는 ‘—’.
    return (
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'minmax(0, 1fr)', minWidth: 0 }}>
        <div className="card" style={{ borderLeft: `3px solid ${TONE[sv.tone] || TONE.gray}`, display: 'grid', gap: 8 }}>
          <div style={{ fontWeight: 600 }}>{sv.title}</div>
          <div style={{ fontSize: 12.5, lineHeight: 1.6 }}>{sv.body}</div>
        </div>
        <div className="kpis">
          <Kpi label="공용 모듈" value="—" />
          <Kpi label="공용 위치 밖에서 널리 쓰임" value="—" />
        </div>
      </div>
    );
  }

  const pick = (f) => { setFilter((prev) => (prev === f && f !== 'all' ? 'all' : f)); setLimit(PAGE); };
  const onAccent = (f) => (filter === f ? 'var(--accent)' : undefined);
  const shown = Math.min(limit, rows.length);
  const empty = rows.length === 0 ? emptyView({ q, filter, kpi }) : null;
  const pressed = { background: 'var(--accent)', borderColor: 'var(--accent)', color: '#fff' };

  return (
    <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'minmax(0, 1fr)', minWidth: 0 }}>
      <div className="card" style={{ fontSize: 12.5, lineHeight: 1.6, display: 'flex', flexWrap: 'wrap', gap: '4px 18px' }}>
        <span>솔루션 전체가 함께 쓰는 공용 모듈 목록입니다. 새 헬퍼 · 컴포넌트를 만들기 전에 여기서 먼저 찾습니다.</span>
        <span style={{ color: 'var(--text-dim)' }}>{builtText(data)}</span>
      </div>

      <div className="kpis">
        <Kpi label="공용 모듈" value={countText(kpi.common)} meta="공용 위치 5곳" accent={onAccent('common')} onClick={() => pick('common')} title="공용 위치의 모듈만 보기" />
        <Kpi label="공용 위치 밖에서 널리 쓰임" value={countText(kpi.outside)} meta={`서버 ${countText(kpi.outsideServer)} · 웹 ${countText(kpi.outsideWeb)}`} accent={onAccent('outside')} onClick={() => pick('outside')} title="공용 위치 밖 모듈만 보기" />
        <Kpi label="사용처 0" value={countText(kpi.unused)} meta="죽은 코드라는 뜻은 아님" accent={onAccent('unused')} onClick={() => pick('unused')} title="import 사용처가 없는 공용 모듈만 보기" />
        <Kpi label="테스트 0" value={countText(kpi.notest)} meta="살펴볼 후보 · 판정 아님" accent={onAccent('notest')} onClick={() => pick('notest')} title="가리키는 테스트가 없는 공용 모듈만 보기" />
        <Kpi label="서버 · 웹 두 벌" value={countText(kpi.twins)} meta={kpi.twinNames.join(' · ') || undefined} accent={onAccent('twin')} onClick={() => pick('twin')} title="서버와 웹에 같은 이름으로 있는 모듈만 보기" />
      </div>

      <div className="card" style={{ display: 'grid', gap: 10, gridTemplateColumns: 'minmax(0, 1fr)', minWidth: 0 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px 14px', alignItems: 'center', minWidth: 0 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '1 1 300px', minWidth: 0 }}>
            <span style={{ fontSize: 12, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>찾기</span>
            <input type="search" className="input" style={{ flex: 1, minWidth: 0 }} value={q} placeholder="모듈 이름 · 내보내는 이름 · 설명"
              onChange={(e) => { setQ(e.target.value); setLimit(PAGE); }} />
          </label>
          <div className="cc-chips" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <button type="button" className="btn btn-sm" aria-pressed={filter === 'all'} style={filter === 'all' ? pressed : undefined} onClick={() => pick('all')}>전체 {countText(chips.all)}</button>
            {SCOPE_IDS.map((id) => (
              <button key={id} type="button" className="btn btn-sm" aria-pressed={filter === id} style={filter === id ? pressed : undefined} onClick={() => pick(id)}>
                {scopeLabel(id)} {countText(chips[id])}
              </button>
            ))}
          </div>
          <label className="cc-select" style={{ flex: '1 1 100%', minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 12, color: 'var(--text-dim)', marginBottom: 4 }}>구분</span>
            {/* 순서가 곧 뜻(전체 → 공용 위치 → 밖)이라 글자 순으로 섞지 않는다. */}
            <Select className="select" sort={false} style={{ width: '100%' }} value={SCOPE_IDS.includes(filter) ? filter : 'all'} onChange={(e) => pick(e.target.value)}>
              <option value="all">전체 {countText(chips.all)}</option>
              {SCOPE_IDS.map((id) => <option key={id} value={id}>{scopeLabel(id)} {countText(chips[id])}</option>)}
            </Select>
          </label>
        </div>

        {filter !== 'all' && !SCOPE_IDS.includes(filter) && (
          <div style={{ fontSize: 12, color: 'var(--text-dim)', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span>조건: {filterLabel(filter)}</span>
            <button type="button" className="btn btn-sm" onClick={() => pick('all')}>조건 풀기</button>
          </div>
        )}

        {empty ? (
          <div style={{ display: 'grid', gap: 8, justifyItems: 'start', padding: '8px 0' }}>
            <div style={{ fontWeight: 600 }}>{empty.title}</div>
            <div style={{ fontSize: 12.5, lineHeight: 1.6 }}>{empty.body}</div>
            <button type="button" className="btn" onClick={() => { setQ(''); setFilter('all'); setLimit(PAGE); }}>검색어 · 조건 지우기</button>
          </div>
        ) : (
          <STable className="v3-table cc-table" minWidth={980} limit={limit}>
            <thead>
              <tr>
                <th>모듈</th><th className="cc-wide">구분</th><th>하는 일</th><th className="cc-wide">내보내는 이름</th>
                <th className="right">사용처</th><th className="right">영역</th><th className="right">테스트</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => {
                const ex = exportsView(m.exports);
                const noTest = m.scope !== 'outside' && m.tests === 0;
                return (
                  <tr key={keyOf(m)}>
                    <td data-sort={baseName(m.file)} style={{ whiteSpace: 'nowrap' }}>
                      <button type="button" className="cc-link" onClick={() => setOpenKey(keyOf(m))} title="모듈 상세 보기">{baseName(m.file)}</button>
                      {m.twin && <span className="badge amber" style={{ marginLeft: 6 }}>두 벌</span>}
                      <div style={{ ...MONO, fontSize: 11, color: 'var(--text-dim)' }}>{dirName(m.file)}</div>
                    </td>
                    <td className="cc-wide" data-sort={scopeLabel(m.scope)} style={{ whiteSpace: 'nowrap' }}><span className="badge gray">{scopeLabel(m.scope)}</span></td>
                    <td style={{ whiteSpace: 'normal', overflowWrap: 'anywhere', minWidth: 200 }}>{summaryText(m.summary) || <span style={{ color: 'var(--text-dim)' }}>머리 주석 없음</span>}</td>
                    <td className="cc-wide" data-sort={ex.total} style={{ whiteSpace: 'normal', overflowWrap: 'break-word', ...MONO, fontSize: 11.5 }}>
                      {ex.total === 0 ? <span style={{ color: 'var(--text-dim)' }}>—</span> : ex.shown.join(' · ')}
                      {ex.more > 0 && <span style={{ fontFamily: 'inherit', color: 'var(--text-dim)' }}> 외 {ex.more}</span>}
                    </td>
                    <td className="right tabular" data-sort={m.users ?? ''} style={{ fontWeight: 600 }}>{countText(m.users)}</td>
                    <td className="right tabular" data-sort={m.areas ?? ''}>{countText(m.areas)}</td>
                    <td className="right tabular" data-sort={m.tests ?? ''} style={noTest ? { color: 'var(--amber)', fontWeight: 600 } : undefined}>{countText(m.tests)}</td>
                  </tr>
                );
              })}
            </tbody>
          </STable>
        )}

        {!empty && <div className="cc-narrow-hint" style={{ fontSize: 12, color: 'var(--text-dim)' }}>표는 상자 안에서 옆으로 밀어 봅니다 · 구분 · 내보내는 이름은 모듈을 눌러 상세에서 봅니다</div>}
        {!empty && (
          <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-dim)' }}>
            <span>{shownText({ total: kpi.total, matched: rows.length, shown })}</span>
            {shown < rows.length && <button type="button" className="btn" onClick={() => setLimit((n) => n + PAGE)}>더 보기</button>}
          </div>
        )}
      </div>

      <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.7 }}>{footnoteText(data?.dynamicUnknown)}</div>

      {open && <ModuleDrawer key={keyOf(open)} m={open} onClose={() => setOpenKey('')} />}
    </div>
  );
}

export default CommonCatalogView;
