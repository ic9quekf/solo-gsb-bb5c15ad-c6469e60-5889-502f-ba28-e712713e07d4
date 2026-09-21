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

// ---------- 规则优先级冲突策略 ----------

test('优先级：最高优先级规则唯一胜出时不报冲突，仅它参与转移', () => {
  const result = run(base(
    [intVar('x', 0, 10)],
    { x: 0 },
    [
      { id: 'low', name: '低优先级', priority: 1, condition: leaf('x', '==', 0), assignments: [assign('x', 'set', 1)] },
      { id: 'high', name: '高优先级', priority: 5, condition: leaf('x', '==', 0), assignments: [assign('x', 'set', 2)] },
    ],
  ));
  assert.equal(result.counts.conflict, 0);
  assert.equal(result.counts.suppressed, 1);
  const f = result.findings.suppressed[0];
  assert.equal(f.depth, 0);
  assert.equal(f.priority, 5);
  assert.equal(f.winner.id, 'high');
  assert.deepEqual(f.suppressed.map((r) => r.id), ['low']);
  assert.equal(f.suppressed[0].priority, 1);
  // 低优先级规则被抑制：{x:1} 不可达，只有 {x:2} 成为后继并死锁
  assert.equal(result.counts.deadlock, 1);
  assert.deepEqual(result.findings.deadlock[0].state, { x: 2 });
  assert.equal(result.stats.statesExplored, 2);
});

test('优先级：最高优先级并列仍报冲突，低优先级规则列入 suppressed', () => {
  const result = run(base(
    [intVar('x', 0, 10)],
    { x: 0 },
    [
      { id: 'a', name: 'A', priority: 5, condition: leaf('x', '==', 0), assignments: [assign('x', 'set', 1)] },
      { id: 'b', name: 'B', priority: 5, condition: leaf('x', '==', 0), assignments: [assign('x', 'set', 2)] },
      { id: 'c', name: 'C', priority: 1, condition: leaf('x', '==', 0), assignments: [assign('x', 'set', 3)] },
    ],
  ));
  assert.equal(result.counts.conflict, 1);
  assert.equal(result.counts.suppressed, 0);
  const f = result.findings.conflict[0];
  assert.equal(f.priority, 5);
  assert.deepEqual(f.ruleIds.slice().sort(), ['a', 'b']);
  assert.deepEqual(f.effective.map((r) => r.id).sort(), ['a', 'b']);
  assert.deepEqual(f.suppressed.map((r) => r.id), ['c']);
  assert.equal(f.suppressed[0].priority, 1);
  // 被抑制的 c 不产生转移：{x:3} 不可达；并列的 a、b 各自转移后死锁
  assert.equal(result.counts.deadlock, 2);
  assert.equal(result.stats.statesExplored, 3);
});

test('优先级：抑制是正常裁决结果，不影响安全判定', () => {
  const result = run(base(
    [intVar('x', 0, 1)],
    { x: 0 },
    [
      { id: 'low', name: '低', priority: 0, condition: leaf('x', '==', 0), assignments: [assign('x', 'set', 1)] },
      { id: 'high', name: '高', priority: 9, condition: leaf('x', '==', 0), assignments: [assign('x', 'set', 1)] },
      { id: 'back', name: '回', condition: leaf('x', '==', 1), assignments: [assign('x', 'set', 0)] },
    ],
  ));
  assert.equal(result.counts.suppressed, 1);
  assert.equal(result.counts.conflict, 0);
  assert.equal(result.verdict, 'safe');
  assert.equal(result.complete, true);
});

test('优先级：被抑制规则的越界赋值不判定为非法转移', () => {
  const result = run(base(
    [intVar('x', 0, 5)],
    { x: 4 },
    [
      { id: 'boom', name: '越界但被抑制', priority: 0, condition: leaf('x', '==', 4), assignments: [assign('x', 'add', 4)] },
      { id: 'ok', name: '合法且优先', priority: 1, condition: leaf('x', '==', 4), assignments: [assign('x', 'set', 0)] },
    ],
  ));
  // boom 被抑制不参与转移，其越界赋值不计入非法转移
  assert.equal(result.counts.invalidTransition, 0);
  assert.equal(result.counts.suppressed, 1);
  assert.equal(result.findings.suppressed[0].winner.id, 'ok');
});

test('优先级：缺省 priority 为 0，旧规则集行为不变（全部并列即冲突）', () => {
  const { data, errors } = validateInput(base(
    [intVar('x')],
    { x: 0 },
    [{ id: 'r', name: 'r', condition: null, assignments: [] }],
  ));
  assert.deepEqual(errors, []);
  assert.equal(data.rules[0].priority, 0);

  // 两条无 priority 的规则同时命中 -> 与引入优先级前一样报冲突
  const result = run(base(
    [intVar('x')],
    { x: 0 },
    [
      { id: 'a', name: 'A', condition: null, assignments: [assign('x', 'set', 1)] },
      { id: 'b', name: 'B', condition: null, assignments: [assign('x', 'set', 2)] },
    ],
  ));
  assert.equal(result.counts.conflict >= 1, true);
  assert.equal(result.counts.suppressed, 0);
  assert.equal(result.findings.conflict[0].suppressed.length, 0);
});

test('校验：非法 priority 被拒绝，合法值原样保留', () => {
  const mk = (priority) => base(
    [intVar('x')],
    { x: 0 },
    [{ id: 'r', name: 'r', priority, condition: null, assignments: [] }],
  );
  for (const bad of [1.5, '2', NaN, Infinity, {}, [], true, 1_000_001, -1_000_001]) {
    const { data, errors } = validateInput(mk(bad));
    assert.equal(data, null);
    assert.ok(errors.some((e) => /priority/.test(e)), `priority=${String(bad)} 应被拒绝`);
  }
  for (const good of [0, 3, -7, 1_000_000, -1_000_000]) {
    const { data, errors } = validateInput(mk(good));
    assert.deepEqual(errors, []);
    assert.equal(data.rules[0].priority, good);
  }
  // null / undefined 视为未设置，回退默认 0
  for (const unset of [null, undefined]) {
    const { data, errors } = validateInput(mk(unset));
    assert.deepEqual(errors, []);
    assert.equal(data.rules[0].priority, 0);
  }
});
