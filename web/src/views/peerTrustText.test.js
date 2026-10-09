// peerTrustText.test.js — 설정 › 장비 신뢰(SSH 호스트키·TLS 인증서) 화면의 판정·문구(2026-10-09 검토 S-01·S-02, 그룹 H).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  stateTone, stateText, sortPeers, filterPeers, policyNote, countsText, approveConfirmText,
  bulkConfirmText, rejectConfirmText, policyConfirmText, certMetaText, whenText, manualIssue,
  TLS_MODE_LABEL, tlsReasonText, rejectApprovable, caBundleView, subsystemModesText, tlsCountsText,
  exceptionBannerText, rejectAsPeer,
} from './peerTrustText.js';
import { stripComments } from '../test/_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FP_SSH = 'SHA256:' + 'A'.repeat(43);
const FP_TLS = Array.from({ length: 32 }, () => 'AB').join(':');

describe('상태 배지·정렬 — 바뀐 지문이 맨 위, 관찰은 초록이 아니다', () => {
  it('stateTone: 바뀐 지문 대기 = 빨강, 그 밖의 대기·관찰 = 주황, 승인 = 초록', () => {
    expect(stateTone({ state: 'pending', pending: { reason: 'changed' } })).toBe('red');
    expect(stateTone({ state: 'pending', pending: { reason: 'unknown' } })).toBe('amber');
    expect(stateTone({ state: 'observed' })).toBe('amber');
    expect(stateTone({ state: 'approved' })).toBe('green');
    expect(stateTone({ state: 'rejected' })).toBe('gray');
    expect(stateTone(null)).toBe('gray');
  });
  it('stateText 는 대기 사유를 붙인다', () => {
    expect(stateText({ state: 'pending', pending: { reason: 'changed' } })).toBe('승인 대기 · 지문이 바뀜');
    expect(stateText({ state: 'observed' })).toBe('관찰(미승인)');
    expect(stateText({})).toBe('기록만');
  });
  it('sortPeers: 바뀐 지문 → 대기 → 관찰 → 거부 → 승인(호스트 순보다 바뀐 지문이 먼저), 같은 등급은 호스트(숫자 인식) 순', () => {
    const rows = [
      { kind: 'ssh', host: 'h10', port: 22, state: 'approved' },
      { kind: 'ssh', host: 'h2', port: 22, state: 'observed' },
      { kind: 'ssh', host: 'h1', port: 22, state: 'pending', pending: { reason: 'unknown' } },
      { kind: 'ssh', host: 'h9', port: 22, state: 'pending', pending: { reason: 'changed' } },
      { kind: 'ssh', host: 'h3', port: 22, state: 'rejected' },
      { kind: 'ssh', host: 'h2', port: 22, state: 'approved' },
    ];
    expect(sortPeers(rows).map((r) => `${r.state}:${r.host}`)).toEqual([
      'pending:h9', 'pending:h1', 'observed:h2', 'rejected:h3', 'approved:h2', 'approved:h10',
    ]);
    expect(sortPeers(null)).toEqual([]);
  });
  it('filterPeers: 종류·상태·검색어(호스트·신뢰 지문·대기 지문)', () => {
    const rows = [
      { kind: 'ssh', host: 'sw1', port: 22, state: 'approved', trusted: { fp: FP_SSH } },
      { kind: 'tls', host: 'vc1', port: 443, state: 'pending', pending: { fp: FP_TLS, reason: 'changed' } },
    ];
    expect(filterPeers(rows, { kind: 'ssh' }).map((r) => r.host)).toEqual(['sw1']);
    expect(filterPeers(rows, { state: 'pending' }).map((r) => r.host)).toEqual(['vc1']);
    expect(filterPeers(rows, { q: 'ab:ab' }).map((r) => r.host)).toEqual(['vc1']);
    expect(filterPeers(rows, { q: 'sw1:22' }).map((r) => r.host)).toEqual(['sw1']);
    expect(filterPeers(rows, { q: 'aaaa' }).map((r) => r.host)).toEqual(['sw1']);
  });
});

describe('정책 설명 — 왜 이 정책인지', () => {
  it('환경변수 강제 · 손상 · 업그레이드 관찰 · 관찰 · 승인만', () => {
    expect(policyNote('ssh', { source: 'env', envKey: 'SSH_HOSTKEY_POLICY', mode: 'observe' })).toMatch(/SSH_HOSTKEY_POLICY/);
    expect(policyNote('tls', { origin: 'load-error', mode: 'enforce' })).toMatch(/읽지 못해/);
    expect(policyNote('ssh', { origin: 'upgrade-migration', mode: 'observe' })).toMatch(/업그레이드/);
    expect(policyNote('ssh', { mode: 'observe' })).toMatch(/관찰 모드/);
    expect(policyNote('ssh', { mode: 'enforce' })).toMatch(/비밀번호를 보내지 않습니다/);
  });
  it('countsText: 바뀐 지문이 있을 때만 그 칸을 말한다', () => {
    expect(countsText({ approved: 3, observed: 1, pending: 0 })).toBe('승인 3 · 관찰(미승인) 1 · 대기 0');
    expect(countsText({ approved: 0, observed: 0, pending: 2, pendingChanged: 1, rejected: 1 })).toMatch(/⚠ 바뀐 지문 1 · 거부 1$/);
    expect(countsText({})).toBe('승인 0 · 관찰(미승인) 0 · 대기 0');
  });
});

describe('확인 대화상자 — 별도 경로 대조를 묻는다', () => {
  it('승인 확인: 지문·별도 경로 질문·바뀐 지문 경고·별표 없음', () => {
    const t = approveConfirmText({ kind: 'ssh', host: 'sw1', port: 22, pending: { fp: FP_SSH, reason: 'changed' } }, FP_SSH);
    expect(t).toContain(FP_SSH);
    expect(t).toMatch(/이 포탈이 아닌 경로/);
    expect(t).toMatch(/지문이 바뀌었습니다/);
    expect(t).not.toContain('**');
  });
  it('승인 확인: 장비가 내민 지문과 다른 값을 미리 등록하면 그 사실을 말한다', () => {
    const t = approveConfirmText({ kind: 'ssh', host: 'sw1', port: 22, pending: { fp: FP_SSH, reason: 'unknown' } }, 'SHA256:' + 'B'.repeat(43));
    expect(t).toMatch(/마지막으로 내민 지문과 다른 값/);
  });
  it('일괄·거부·정책 문구', () => {
    expect(bulkConfirmText('ssh', 4)).toMatch(/관찰 지문 4개/);
    expect(rejectConfirmText({ kind: 'tls', host: 'vc1', port: 443 }, FP_TLS)).toMatch(/정책과 무관하게 연결하지 않습니다/);
    expect(policyConfirmText('ssh', 'observe')).toMatch(/확인 없이 통과/);
    expect(policyConfirmText('ssh', 'enforce')).toMatch(/승인 전까지 연결되지 않습니다/);
  });
});

describe('부속 문구·직접 등록 검사', () => {
  it('certMetaText·whenText — 값이 없으면 빈 문자열·—', () => {
    expect(certMetaText({ subject: 'vc1', issuer: 'CA', validTo: 'Jan 1 2030' })).toBe('주체 vc1 · 발급 CA · 만료 Jan 1 2030');
    expect(certMetaText({})).toBe('');
    expect(whenText(null)).toBe('—');
    expect(whenText('')).toBe('—');
    expect(whenText(0)).toBe('—');
    expect(whenText(Date.UTC(2026, 9, 9))).not.toBe('—');
  });
  it('manualIssue: 서버와 같은 형식 규칙', () => {
    expect(manualIssue({ kind: 'ssh', host: 'sw1', port: 22, fp: FP_SSH })).toBeNull();
    expect(manualIssue({ kind: 'ssh', host: 'sw1', port: 22, fp: 'A'.repeat(43) })).toBeNull();
    expect(manualIssue({ kind: 'tls', host: 'vc1', port: 443, fp: FP_TLS })).toBeNull();
    expect(manualIssue({ kind: 'tls', host: 'vc1', port: 443, fp: FP_TLS.replace(/:/g, '') })).toBeNull();
    expect(manualIssue({ kind: 'x', host: 'a', port: 1, fp: FP_SSH })).toMatch(/종류/);
    expect(manualIssue({ kind: 'ssh', host: 'a b', port: 22, fp: FP_SSH })).toMatch(/호스트/);
    expect(manualIssue({ kind: 'ssh', host: 'a|b', port: 22, fp: FP_SSH })).toMatch(/호스트/);
    expect(manualIssue({ kind: 'ssh', host: 'a', port: 0, fp: FP_SSH })).toMatch(/포트/);
    expect(manualIssue({ kind: 'ssh', host: 'a', port: '', fp: FP_SSH })).toMatch(/포트/);
    expect(manualIssue({ kind: 'ssh', host: 'a', port: 22, fp: 'SHA256:short' })).toMatch(/SSH 지문/);
    expect(manualIssue({ kind: 'tls', host: 'a', port: 443, fp: 'AB:CD' })).toMatch(/TLS 지문/);
  });
});

describe('TLS 탭 — tlsTrustStatus() 를 그린다', () => {
  it('거부 사유 문구 — 모르는 사유는 원문, CA 오류는 덧붙인다', () => {
    expect(tlsReasonText({ reason: 'unknown', chainError: 'DEPTH_ZERO_SELF_SIGNED_CERT' })).toBe('승인된 지문 없음 · CA: 자체서명');
    expect(tlsReasonText({ reason: 'chain', chainError: 'CERT_HAS_EXPIRED' })).toBe('CA 체인 검증 실패(엄격 모드) · 인증서 만료');
    expect(tlsReasonText({ reason: 'weird' })).toBe('weird');
    expect(tlsReasonText({})).toBe('—');
  });
  it('rejectApprovable: 지문 없음·엄격 모드는 승인 버튼을 주지 않는다(사유를 말한다)', () => {
    expect(rejectApprovable({ host: 'vc1', port: 443, fingerprint: FP_TLS, mode: 'verify', reason: 'unknown' })).toEqual({ ok: true, why: '' });
    expect(rejectApprovable({ host: 'vc1', port: 443, fingerprint: null, mode: 'verify' }).ok).toBe(false);
    const s = rejectApprovable({ host: 'vc1', port: 443, fingerprint: FP_TLS, mode: 'strict' });
    expect(s.ok).toBe(false);
    expect(s.why).toMatch(/사설 CA/);
    expect(rejectApprovable({ host: '', port: 443, fingerprint: FP_TLS, mode: 'verify' }).ok).toBe(false);
  });
  it('rejectAsPeer: 승인 대화상자가 지문·바뀜 여부를 말할 수 있는 모양', () => {
    const p = rejectAsPeer({ host: 'vc1', port: 443, fingerprint: FP_TLS, reason: 'changed' });
    expect(p).toEqual({ kind: 'tls', host: 'vc1', port: 443, pending: { fp: FP_TLS, reason: 'changed' } });
    expect(approveConfirmText(p, FP_TLS)).toMatch(/지문이 바뀌었습니다/);
  });
  it('caBundleView: 없음·오류·정상·경고를 구분한다(값을 지어내지 않는다)', () => {
    expect(caBundleView(null).title).toMatch(/읽지 못했습니다/);
    const none = caBundleView({ present: false, file: '/etc/x/tls-ca-bundle.pem' });
    expect(none.tone).toBe('gray');
    expect(none.lines[0]).toBe('파일: /etc/x/tls-ca-bundle.pem');
    const err = caBundleView({ present: true, file: 'f', error: '크기 상한' });
    expect(err.tone).toBe('red');
    expect(err.lines).toContain('사유: 크기 상한');
    const ok = caBundleView({ present: true, file: 'f', certs: 2, expired: 0, notCa: 0, errors: [], otherBlocks: 0 });
    expect(ok.tone).toBe('green');
    expect(ok.lines).toContain('인증서 2개');
    const warn = caBundleView({ present: true, file: 'f', certs: 3, expired: 1, notCa: 1, errors: [{ index: 2, reason: 'x' }], otherBlocks: 1, truncated: true });
    expect(warn.tone).toBe('amber');
    expect(warn.lines.join('\n')).toMatch(/만료된 인증서 1개[\s\S]*CA 가 아닌 인증서 1개[\s\S]*읽지 못한 블록 1개[\s\S]*인증서가 아닌 블록 1개/);
    expect(warn.lines[1]).toMatch(/상한으로 일부만/);
    expect(caBundleView({ present: true, file: 'f', certs: 0, errors: [] }).tone).toBe('amber');
  });
  it('수집기 모드·횟수·예외 배너', () => {
    expect(subsystemModesText({ modes: ['verify', 'insecure'] })).toBe(`${TLS_MODE_LABEL.verify} · ${TLS_MODE_LABEL.insecure}`);
    expect(subsystemModesText({})).toBe('—');
    expect(tlsCountsText({ chain: 1, pin: 2, observed: 0, rejected: 3 })).toBe('CA 체인 1 · 승인 지문 2 · 관찰 통과 0 · 거부 3');
    expect(tlsCountsText({ insecure: 5 })).toMatch(/검증 안 함 5$/);
    expect(exceptionBannerText([])).toBeNull();
    expect(exceptionBannerText(null)).toBeNull();
    const b = exceptionBannerText([{ subsystem: 'vcenter', label: 'vCenter', envKey: 'VCENTER_TLS_VERIFY' }, null]);
    expect(b).toMatch(/^\*\*예외 사용 중\*\*/);
    expect(b).toContain('vCenter(VCENTER_TLS_VERIFY)');
  });
});

describe('문구 규약 — 백틱 없음(BoldText 는 굵게만 해석)', () => {
  it('문구 모듈과 화면 파일에 백틱 문자열 리터럴이 아닌 화면 문구용 백틱이 새지 않는다', () => {
    const src = stripComments(fs.readFileSync(path.join(HERE, 'peerTrustText.js'), 'utf8'));
    // 템플릿 리터럴 자체는 허용 — 문구 안에 '이스케이프된 백틱'(화면에 글자로 보이는 것)이 없어야 한다.
    expect(/(^|[^\\])(\\\\)*\\`/.test(src)).toBe(false);
    const jsx = stripComments(fs.readFileSync(path.join(HERE, 'PeerTrustSettings.jsx'), 'utf8'));
    expect(/(^|[^\\])(\\\\)*\\`/.test(jsx)).toBe(false);
  });
  it('화면은 날 select·table 을 쓰지 않는다(공용 Select·STable — 정렬·최소폭 규약)', () => {
    const jsx = stripComments(fs.readFileSync(path.join(HERE, 'PeerTrustSettings.jsx'), 'utf8'));
    expect(jsx).not.toMatch(/<select[\s>]/);
    expect(jsx).not.toMatch(/<table[\s>]/);
    expect(jsx).toMatch(/<STable[^>]*minWidth=/);
    expect(jsx).toMatch(/export default function PeerTrustSettings/);
  });
});
