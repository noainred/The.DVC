/**
 * InspectSources — ⑤ 점검 주기 · 근거(설계 시안 ⑤). 서버 카탈로그(/tools/ps-inspect/catalog) 그대로 — 주간 20항목 · 월간 · 분기 세부 점검 · 참고 자료와 확인 수준 · 실제로 보내는 명령.
 */
import React from 'react';
import { STable } from '../../../components/STable.jsx';
import { GROUP_KO } from './psInspectText.js';

const CAD_KO = { month: '월간', quarter: '분기' };
export default function InspectSources({ cat }) {
  if (!cat) return <div className="psi-note">불러오는 중…</div>;
  return (
    <div className="psi-body">
      <div className="psi-main" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="psi-panel">
          <h3>주간 자동 점검 20항목 <span className="psi-muted" style={{ fontWeight: 400 }}>· 포탈이 읽고 판정</span></h3>
          <div className="psi-tablewrap">
            <STable minWidth={760}>
              <thead><tr><th style={{ textAlign: 'right' }}>#</th><th>구분</th><th>항목</th><th>기준</th><th>읽는 방법</th><th data-nosort="1">근거</th></tr></thead>
              <tbody>{cat.items.map((i) => (
                <tr key={i.id}><td className="psi-num" data-sort={String(i.no)}>{i.no}</td><td>{GROUP_KO[i.group]}</td><td><b>{i.label}</b></td><td>{i.basis}</td>
                  <td className="psi-mono" style={{ fontSize: 11 }}>{i.how}{i.syntaxUnverified ? ' (문법 미확인)' : ''}</td><td data-nosort="1"><span className="psi-ref">{i.refs.map((n) => `[${n}]`).join('')}</span></td></tr>
              ))}</tbody>
            </STable>
          </div>
        </div>
        <div className="psi-panel">
          <h3>월간 · 분기 세부 점검 <span className="psi-muted" style={{ fontWeight: 400 }}>· 사람이 검토(자동 판정하지 않음)</span></h3>
          <div className="psi-tablewrap">
            <STable minWidth={520}>
              <thead><tr><th>주기</th><th>점검 내용</th><th data-nosort="1">근거</th></tr></thead>
              <tbody>{cat.review.map((r) => <tr key={r.id}><td>{CAD_KO[r.cadence] || r.cadence}</td><td>{r.label}</td><td data-nosort="1"><span className="psi-ref">{r.refs.map((n) => `[${n}]`).join('')}</span></td></tr>)}</tbody>
            </STable>
          </div>
          <div className="psi-note">Dell 점검표 [1] 는 일 · 월 · 분기 세 주기이고 ‘주간’ 은 Dell 지원 동영상 [2] 의 설명입니다. 주간 20항목은 이 둘에 KB 의 점검 명령을 더해 포탈이 묶었습니다. 일일 항목(경보 · 용량)은 지금도 수집 주기마다 화면 · 알림에 있습니다.</div>
        </div>
        <div className="psi-panel">
          <h3>실제로 보내는 명령 <span className="psi-muted" style={{ fontWeight: 400 }}>· 전부 조회 · 설정을 바꾸지 않음</span></h3>
          <div className="psi-note">SSH 로 수집하는 장비 — 세션 하나에 차례로(장비당 시한 {Math.round(cat.timeoutMs / 1000)}초 · 세션 예산 {Math.round(cat.sshBudgetMs / 1000)}초 · 모자라면 뒤 명령을 건너뛰고 확인 불가로 적습니다):</div>
          <div className="psi-mono" style={{ fontSize: 11, lineHeight: 1.6, overflowWrap: 'anywhere' }}>{cat.commands.ssh.map((c) => <div key={c.key}>{c.cmd}{c.fallback ? `  (안 되면 ${c.fallback})` : ''}</div>)}</div>
          <div className="psi-note">REST 로 수집하는 장비 — {Object.values(cat.commands.rest).flat().length}개 경로(앞의 것부터 시도). 그룹(쿼럼) · 부트 미러는 REST 경로가 없어 확인 불가로 남습니다.</div>
          <div className="psi-mono" style={{ fontSize: 11, lineHeight: 1.6, overflowWrap: 'anywhere' }}>{Object.entries(cat.commands.rest).map(([k, v]) => <div key={k}>{v.join(' → ')}</div>)}</div>
        </div>
      </div>
      <div className="psi-side" style={{ flexBasis: 420 }}>
        <div className="psi-panel">
          <h3>참고 자료 {cat.refs.length}건과 확인 수준</h3>
          <div className="psi-tablewrap">
            <STable minWidth={380}>
              <thead><tr><th style={{ textAlign: 'right' }}>#</th><th>자료</th><th>확인 수준</th></tr></thead>
              <tbody>{cat.refs.map((r) => (
                <tr key={r.n}><td className="psi-num" data-sort={String(r.n)}>[{r.n}]</td>
                  <td><a href={r.url} target="_blank" rel="noopener noreferrer">{r.title}</a><div className="psi-muted" style={{ fontSize: 11 }}>{r.kind}</div></td>
                  <td>{cat.refLevelKo[r.level] || r.level}</td></tr>
              ))}</tbody>
            </STable>
          </div>
          <div className="psi-note">{cat.sourcesNote}</div>
        </div>
      </div>
    </div>
  );
}
