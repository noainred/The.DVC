/**
 * audit2731g1.test.jsx — 점검 1회차(v2.731) G1: 설정 › 장비 신뢰 화면의 다중 지문(A1-01)·승인 노드 안내(A1-02).
 * 서버 계약: server/src/security/peerTrust.js listPeers 의 trustedList · approvePeer replace · GET 응답 node·trustedMax.
 * 회귀 서버 쪽은 server/test/audit2731g1.test.js.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import PeerTrustSettings from './PeerTrustSettings.jsx';
import {
  trustedListOf, stateText, approveChoice, approveConfirmText, approveOkText, revokeConfirmText, multiFpNote, nodeNoteText, filterPeers,
} from './peerTrustText.js';

const h = React.createElement;
const FP = (c) => 'SHA256:' + c.repeat(43);
const NOW = 1_780_000_000_000;

describe('A1-01 다중 지문 — 판정·문구', () => {
  it('trustedListOf: 서버 trustedList 우선, 없으면(구버전 응답) trusted 하나, 지문 없는 원소는 뺀다', () => {
    expect(trustedListOf({ trustedList: [{ fp: FP('A') }, null, { fp: '' }, { fp: FP('B') }], trusted: { fp: FP('A') } }).map((t) => t.fp)).toEqual([FP('A'), FP('B')]);
    expect(trustedListOf({ trusted: { fp: FP('C'), state: 'approved' } }).map((t) => t.fp)).toEqual([FP('C')]);
    expect(trustedListOf({})).toEqual([]);
    expect(trustedListOf(null)).toEqual([]);
  });
  it('stateText: 신뢰 지문이 둘 이상이면 개수를 붙인다', () => {
    expect(stateText({ state: 'approved', trustedList: [{ fp: FP('A') }, { fp: FP('B') }] })).toBe('승인됨 · 지문 2개');
    expect(stateText({ state: 'approved', trusted: { fp: FP('A') } })).toBe('승인됨');
    expect(stateText({ state: 'pending', pending: { reason: 'changed' }, trustedList: [{ fp: FP('A') }, { fp: FP('B') }] })).toBe('승인 대기 · 지문이 바뀜 · 지문 2개');
  });
  it('approveChoice: 이미 신뢰 지문이 있으면 추가/교체를 나눈다 · 처음 보는 장비·관찰 하나뿐이면 승인 하나', () => {
    expect(approveChoice({ pending: { fp: FP('B') }, trustedList: [{ fp: FP('A'), state: 'approved' }] })).toEqual({ candidate: FP('B'), others: 1, mode: 'add-or-replace' });
    expect(approveChoice({ pending: { fp: FP('C') } })).toEqual({ candidate: FP('C'), others: 0, mode: 'single' });
    expect(approveChoice({ trustedList: [{ fp: FP('D'), state: 'observed' }] })).toEqual({ candidate: FP('D'), others: 0, mode: 'single' });
    expect(approveChoice({ trustedList: [{ fp: FP('D'), state: 'observed' }, { fp: FP('E'), state: 'approved' }] }).mode).toBe('add-or-replace');
    expect(approveChoice({ trustedList: [{ fp: FP('E'), state: 'approved' }] }).candidate).toBe('');
  });
  it('approveConfirmText: 추가 승인은 기존 지문을 계속 신뢰한다고, 교체 승인은 신뢰하지 않게 된다고 말한다 · 별표 없음', () => {
    const peer = { kind: 'tls', host: 'hz.corp', port: 443, pending: { fp: 'X', reason: 'changed' }, trustedList: [{ fp: 'A' }, { fp: 'B' }] };
    const add = approveConfirmText(peer, 'X');
    expect(add).toMatch(/추가 승인 — 이 장비에서 이미 신뢰하는 지문 2개도 계속 신뢰합니다/);
    expect(add).toMatch(/로드밸런서/);
    expect(add).not.toContain('**');
    const rep = approveConfirmText(peer, 'X', { replace: true });
    expect(rep).toMatch(/교체 승인할 지문: X/);
    expect(rep).toMatch(/지금 신뢰하는 지문 2개를 더는 신뢰하지 않습니다/);
    expect(rep).not.toContain('**');
    // 기존 지문이 없으면 추가/교체 구분을 말하지 않는다
    expect(approveConfirmText({ kind: 'ssh', host: 's', port: 22, pending: { fp: 'Z', reason: 'unknown' } }, 'Z')).not.toMatch(/추가 승인|교체 승인/);
  });
  it('approveOkText: 서버 응답(trustedCount·already)으로 말한다', () => {
    const p = { host: 'h', port: 22 };
    expect(approveOkText(p, { trustedCount: 3 })).toMatch(/신뢰 지문 3개를 모두 신뢰합니다/);
    expect(approveOkText(p, { trustedCount: 1 })).toMatch(/이 지문을 신뢰합니다/);
    expect(approveOkText(p, { already: true, trustedCount: 2 })).toMatch(/이미 승인된/);
    expect(approveOkText(p, { trustedCount: 1 }, { replace: true })).toMatch(/이 지문만 신뢰합니다/);
    expect(approveOkText(p, {})).not.toMatch(/NaN|undefined/);
  });
  it('revokeConfirmText: 다른 신뢰 지문은 그대로 · 마지막 지문이면 그 결과를 말한다', () => {
    const peer = { kind: 'ssh', host: 'lb', port: 22, trustedList: [{ fp: 'A' }, { fp: 'B' }, { fp: 'C' }] };
    expect(revokeConfirmText(peer, 'B')).toMatch(/다른 신뢰 지문 2개는 그대로/);
    expect(revokeConfirmText({ ...peer, trustedList: [{ fp: 'A' }] }, 'A')).toMatch(/신뢰 지문이 더 없습니다/);
  });
  it('multiFpNote: 상한은 서버 값이 있을 때만 · filterPeers 는 두 번째 신뢰 지문으로도 찾는다', () => {
    expect(multiFpNote(8)).toMatch(/장비당 최대 8개/);
    expect(multiFpNote(undefined)).not.toMatch(/최대/);
    const rows = [{ kind: 'ssh', host: 'lb', port: 22, state: 'approved', trustedList: [{ fp: FP('A') }, { fp: FP('Q') }] }];
    expect(filterPeers(rows, { q: 'qqqq' }).length).toBe(1);
  });
});

describe('A1-02 승인 노드 안내', () => {
  it('nodeNoteText: 엣지(이름 있음·없음)·중앙·구버전(node 없음)', () => {
    expect(nodeNoteText({ edge: true, name: 'Edge-Seoul' })).toMatch(/엣지 ‘Edge-Seoul’/);
    expect(nodeNoteText({ edge: true, name: 'Edge-Seoul' })).toMatch(/중앙 포탈과 공유하지 않습니다/);
    expect(nodeNoteText({ edge: true, name: null })).toMatch(/\*\*엣지\*\*/);
    expect(nodeNoteText({ edge: false, name: null })).toMatch(/엣지 포탈의 설정 › 장비 신뢰/);
    expect(nodeNoteText(null)).toBe('');
    for (const t of [nodeNoteText({ edge: true, name: 'x' }), nodeNoteText({ edge: false }), multiFpNote(8)]) expect(t).not.toContain('`');
  });
});

describe('렌더 — 신뢰 지문 목록 · 회수 · 노드 배너', () => {
  const DATA = {
    ok: true,
    status: { loadError: null, kinds: { ssh: { policy: { mode: 'enforce', source: 'file' }, counts: { approved: 1 } }, tls: { policy: { mode: 'enforce' }, counts: {} } } },
    peers: [
      { kind: 'ssh', host: 'lb.corp', port: 22, state: 'approved', trusted: { fp: FP('A'), state: 'approved', at: NOW, by: 'admin' },
        trustedList: [{ fp: FP('A'), state: 'approved', at: NOW, by: 'admin' }, { fp: FP('B'), state: 'approved', at: NOW, by: 'noainred' }], firstSeen: NOW, lastSeen: NOW },
      { kind: 'ssh', host: 'lb2.corp', port: 22, state: 'pending', trusted: { fp: FP('C'), state: 'approved', at: NOW, by: 'admin' },
        trustedList: [{ fp: FP('C'), state: 'approved', at: NOW, by: 'admin' }], pending: { fp: FP('D'), reason: 'changed', at: NOW }, firstSeen: NOW, lastSeen: NOW },
    ],
    kinds: ['ssh', 'tls'], modes: ['enforce', 'observe'], trustedMax: 8, node: { edge: true, name: 'Edge-Busan' }, tls: null, tlsError: null,
  };
  it('두 지문을 모두 보이고 지문마다 회수 버튼 · 기존 지문이 있는 대기 행은 추가/교체 승인 · 엣지 배너', () => {
    const html = renderToStaticMarkup(h(PeerTrustSettings, { initialData: DATA, initialKind: 'ssh' }));
    expect(html).toContain(FP('A'));
    expect(html).toContain(FP('B'));
    expect(html).toContain('승인됨 · 지문 2개');
    expect((html.match(/>회수<\/button>/g) || []).length).toBe(3); // lb A·B + lb2 C
    expect(html).toContain('>추가 승인</button>');
    expect(html).toContain('>교체 승인</button>');
    expect(html).toContain('<b>엣지 ‘Edge-Busan’</b>');
    expect(html).toContain('<b>추가 승인</b>');
    expect(html).toContain('장비당 최대 8개');
    expect(html).not.toContain('**');
    expect(html).not.toMatch(/>(null|undefined|NaN)</);
  });
  it('구버전 응답(trustedList·node 없음)도 그린다', () => {
    const old = { ...DATA, node: undefined, trustedMax: undefined, peers: DATA.peers.map(({ trustedList, ...r }) => r) };
    const html = renderToStaticMarkup(h(PeerTrustSettings, { initialData: old, initialKind: 'ssh' }));
    expect(html).toContain(FP('A'));
    expect(html).not.toContain(FP('B'));
    expect(html).not.toContain('Edge-Busan');
    expect(html).not.toMatch(/최대/);
    expect(html).not.toMatch(/>(null|undefined|NaN)</);
  });
});
