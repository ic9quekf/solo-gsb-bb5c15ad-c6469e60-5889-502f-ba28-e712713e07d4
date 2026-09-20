import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateInput } from '../src/engine/validate.js';
import { analyze, canonicalKey } from '../src/engine/validator.js';
import { evalCondition } from '../src/engine/conditions.js';

function run(raw) {
  const { data, errors } = validateInput(raw);
  assert.deepEqual(errors, [], `输入校验应当通过: ${errors.join('; ')}`);
  return analyze(data);
}

const intVar = (name, min = 0, max = 10) => ({ name, type: 'int', domain: { min, max } });
const leaf = (v, op, value) => ({ kind: 'leaf', var: v, op, value });
const assign = (target, op, value) => ({ target, op, value });
const base = (variables, initialState, rules, maxSteps = 12, maxStates = 5000) => ({
  variables, initialState, rules, maxSteps, maxStates,
});

test('互斥的回合切换规则集判定为安全且完备', () => {
  const result = run(base(
    [intVar('phase', 0, 1)],
    { phase: 0 },
    [
      { id: 'to1', name: '到1', condition: leaf('phase', '==', 0), assignments: [assign('phase', 'set', 1)] },
      { id: 'to0', name: '到0', condition: leaf('phase', '==', 1), assignments: [assign('phase', 'set', 0)] },
    ],
  ));
  assert.equal(result.verdict, 'safe');
  assert.equal(result.truncated, false);
  assert.equal(result.complete, true);
  assert.equal(result.stats.statesExplored, 2);
  assert.equal(result.counts.deadlock + result.counts.conflict, 0);
});

test('无规则可执行时报告死锁并给出最短路径', () => {
  const result = run(base(
    [intVar('phase', 0, 1)],
    { phase: 0 },
    [{ id: 'go', name: '推进', condition: leaf('phase', '==', 0), assignments: [assign('phase', 'set', 1)] }],
  ));
  assert.equal(result.verdict, 'issues');
  assert.equal(result.counts.deadlock, 1);
  const f = result.findings.deadlock[0];
  assert.equal(f.depth, 1);
  assert.deepEqual(f.state, { phase: 1 });
  assert.equal(f.path.length, 1);
  assert.equal(f.path[0].ruleId, 'go');
});

test('初始状态即有多个规则同时可执行 -> 深度 0 冲突', () => {
  const result = run(base(
    [intVar('x')],
    { x: 0 },
    [
      { id: 'a', name: 'A', condition: null, assignments: [assign('x', 'set', 1)] },
      { id: 'b', name: 'B', condition: null, assignments: [assign('x', 'set', 2)] },
    ],
  ));
  // 根状态冲突，且后继 {x:1}、{x:2} 同样两条无条件规则都可执行，共 3 个冲突状态
  assert.ok(result.counts.conflict >= 1);
  assert.deepEqual(result.findings.conflict[0].ruleIds.sort(), ['a', 'b']);
  assert.equal(result.findings.conflict[0].depth, 0);
  assert.equal(result.findings.conflict[0].path.length, 0);
});

test('赋值超出定义域报告非法转移', () => {
  const result = run(base(
    [intVar('energy', 0, 5)],
    { energy: 4 },
    [{ id: 'charge', name: '充能+2', condition: leaf('energy', '>', 0), assignments: [assign('energy', 'add', 2)] }],
  ));
  assert.equal(result.counts.invalidTransition, 1);
  assert.match(result.findings.invalidTransition[0].reason, /超出定义域/);
});

test('自循环规则通过状态去重终止探索，不会死循环', () => {
  const result = run(base(
    [{ name: 'flag', type: 'bool', domain: null }],
    { flag: true },
    [{ id: 'noop', name: '空转', condition: leaf('flag', '==', true), assignments: [] }],
    20,
  ));
  assert.equal(result.verdict, 'safe');
  assert.equal(result.stats.statesExplored, 1);
  assert.equal(result.stats.transitions, 1);
});

test('同一死锁状态有长/短两条路径时报告最短路径', () => {
  const result = run(base(
    [intVar('x', 0, 2)],
    { x: 0 },
    [
      { id: 'fast', name: '直达2', condition: leaf('x', '==', 0), assignments: [assign('x', 'set', 2)] },
      { id: 'slow', name: '先到1', condition: leaf('x', '==', 0), assignments: [assign('x', 'set', 1)] },
      { id: 'then', name: '再到2', condition: leaf('x', '==', 1), assignments: [assign('x', 'set', 2)] },
    ],
  ));
  assert.equal(result.counts.deadlock, 1);
  const f = result.findings.deadlock[0];
  assert.equal(f.depth, 1);
  assert.equal(f.path[0].ruleId, 'fast');
});

test('达到状态上限且未发现问题时标记不完备，不得误报安全', () => {
  const result = run(base(
    [intVar('x', 0, 5)],
    { x: 0 },
    [{ id: 'inc', name: '递增', condition: leaf('x', '<', 5), assignments: [assign('x', 'add', 1)] }],
    12, 2,
  ));
  assert.equal(result.truncated, true);
  assert.equal(result.verdict, 'unknown_incomplete');
  assert.notEqual(result.verdict, 'safe');
  assert.ok(result.stats.truncatedTransitions >= 1);
});

test('达到状态上限且已发现问题时判定为 issues_incomplete', () => {
  const result = run(base(
    [intVar('x', 0, 5)],
    { x: 0 },
    [
      { id: 'inc', name: '递增', condition: leaf('x', '<', 5), assignments: [assign('x', 'add', 1)] },
      { id: 'inc2', name: '另一条递增（互斥冲突）', condition: leaf('x', '<', 5), assignments: [assign('x', 'set', 1)] },
    ],
    12, 1,
  ));
  assert.equal(result.truncated, true);
  assert.equal(result.counts.conflict, 1);
  assert.equal(result.verdict, 'issues_incomplete');
});

test('maxSteps 限制探索深度，边界层仍有可执行规则时标记不完备', () => {
  const result = run(base(
    [intVar('x', 0, 10)],
    { x: 0 },
    [{ id: 'inc', name: '递增', condition: leaf('x', '<', 10), assignments: [assign('x', 'add', 1)] }],
    2, 5000,
  ));
  assert.equal(result.verdict, 'unknown_incomplete');
  assert.equal(result.truncated, true);
  assert.equal(result.stats.stepCutFrontier, 1);
  assert.equal(result.stats.maxDepthReached, 2);
  assert.equal(result.stats.statesExplored, 3);
});

test('规范状态键与变量声明顺序无关', () => {
  const s = { a: 1, b: true };
  const k1 = canonicalKey(s, [intVar('a'), { name: 'b', type: 'bool' }]);
  const k2 = canonicalKey(s, [{ name: 'b', type: 'bool' }, intVar('a')]);
  assert.equal(k1, k2);
});

test('条件树 all/any/not 求值正确', () => {
  const state = { x: 3 };
  assert.equal(evalCondition(null, state), true);
  assert.equal(evalCondition({ kind: 'not', child: leaf('x', '==', 3) }, state), false);
  assert.equal(
    evalCondition({ kind: 'any', children: [leaf('x', '>', 5), leaf('x', '==', 3)] }, state),
    true,
  );
  assert.equal(
    evalCondition({ kind: 'all', children: [leaf('x', '>', 2), { kind: 'not', child: leaf('x', '>', 4) }] }, state),
    true,
  );
});

test('校验：初始值超出定义域被拒绝', () => {
  const { errors } = validateInput(base(
    [intVar('x', 0, 2)],
    { x: 9 },
    [{ id: 'r', name: 'r', condition: null, assignments: [] }],
  ));
  assert.ok(errors.some((e) => /超出定义域/.test(e)));
});

test('校验：重复的规则 ID 被拒绝', () => {
  const { errors } = validateInput(base(
    [intVar('x')],
    { x: 0 },
    [
      { id: 'dup', name: 'a', condition: null, assignments: [] },
      { id: 'dup', name: 'b', condition: null, assignments: [] },
    ],
  ));
  assert.ok(errors.length > 0);
});
