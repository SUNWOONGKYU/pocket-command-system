// audit-paths.cjs 회귀 테스트 — 감사 경로 규칙 SSOT.
//   PO 지시(2026-07-25)로 감사관 전용 원본(vault)은 저장소 "밖"
//   <repo부모>/_audit_vault/<repo이름>/ 에, 작업자용 사본·대응이력은 저장소 "안"
//   <repo>/_audit/ 에 둔다. 세 소비처(audit-integrity-check.js·enqueue-audit.js·
//   worker/agent-runner.ts)가 이 규칙 하나를 공유하므로 어긋나면 해시 체인이 갈라진다.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { vaultDirFor, auditDirFor, posix } = require('../audit-paths.cjs');

test('vaultDirFor: <repo부모>/_audit_vault/<repo이름> 규칙', () => {
  const repoRoot = path.win32.resolve('C:/Dev/pocket-commander');
  const result = vaultDirFor(repoRoot);
  const expected = path.join(path.dirname(path.resolve(repoRoot)), '_audit_vault', 'pocket-commander');
  assert.equal(result, expected);
});

test('auditDirFor: <repo>/_audit 규칙 (저장소 안)', () => {
  const repoRoot = path.resolve('C:/Dev/pocket-commander');
  const result = auditDirFor(repoRoot);
  assert.equal(result, path.join(repoRoot, '_audit'));
});

test('vaultDirFor와 auditDirFor는 서로 다른 위치를 가리킨다(물리 격리)', () => {
  const repoRoot = path.resolve('C:/Dev/pocket-commander');
  const vault = vaultDirFor(repoRoot);
  const audit = auditDirFor(repoRoot);
  assert.notEqual(vault, audit);
  // vault는 repoRoot 하위가 아니어야 한다(저장소 밖 격리가 핵심).
  const rel = path.relative(repoRoot, vault);
  assert.ok(rel.startsWith('..'), `vault(${vault})가 repoRoot(${repoRoot}) 밖에 있어야 한다`);
});

test('vaultDirFor: 상대경로가 들어와도 절대경로로 정규화한다', () => {
  const abs = path.resolve('.');
  const result = vaultDirFor('.');
  const expected = path.join(path.dirname(abs), '_audit_vault', path.basename(abs));
  assert.equal(result, expected);
});

test('posix: 윈도우 백슬래시 경로를 슬래시로 변환한다', () => {
  assert.equal(posix('C:\\Dev\\pocket-commander\\_audit'), 'C:/Dev/pocket-commander/_audit');
});

test('posix: 이미 슬래시인 경로는 그대로 둔다', () => {
  assert.equal(posix('C:/Dev/pocket-commander/_audit'), 'C:/Dev/pocket-commander/_audit');
});

test('posix: 혼합 구분자도 전부 슬래시로 통일한다', () => {
  assert.equal(posix('C:\\Dev/pocket-commander\\_audit'), 'C:/Dev/pocket-commander/_audit');
});
