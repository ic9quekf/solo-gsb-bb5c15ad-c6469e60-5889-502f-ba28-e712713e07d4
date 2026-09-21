// 核心验证器：从初始状态做广度优先探索。
//
// 在每个状态下：
//   - 没有任何规则可执行            -> deadlock（死锁 / 无规则可执行）
//   - 最高优先级的规则多于一条      -> conflict（同级规则同时触发，优先级无法消解）
//   - 某条生效规则的赋值越界        -> invalidTransition（非法转移）
//
// 规则优先级（可选，整数，默认 0）：同一状态命中多条规则时，仅最高优先级
// 规则参与状态转移；低优先级规则被抑制（suppressed），既不触发转移也不
// 参与越界检查。最高优先级出现并列时仍判定为冲突。
// 不设置 priority 的旧规则集所有规则同级（0），行为与引入优先级前完全一致。
//
// 发现状态按 BFS 层级入队，因此每条记录的触发路径均为最短路径。
// 状态使用规范化键去重；达到状态上限时 truncated=true，
// 结果明确标记为不完备（incomplete），不会误报安全。

import { evalCondition } from './conditions.js';
import { applyRule } from './assignments.js';

const FINDING_LIMIT = 200; // 每类问题最多保留的明细数（统计计数始终精确）

// 按变量名顺序序列化，保证同一状态只有一个规范键
export function canonicalKey(state, variables) {
  const names = variables.map((v) => v.name);
  names.sort();
  return JSON.stringify(names.map((name) => [name, state[name]]));
}

function matchingRules(state, rules) {
  const matches = [];
  for (const rule of rules) {
    if (evalCondition(rule.condition, state)) matches.push(rule);
  }
  return matches;
}

// 按优先级分层：最高优先级规则生效（参与转移），其余被抑制。
// priority 缺失时按 0 处理，保证未带 priority 的旧规则集行为不变。
function splitByPriority(matches) {
  let maxPriority = -Infinity;
  for (const rule of matches) {
    const p = rule.priority ?? 0;
    if (p > maxPriority) maxPriority = p;
  }
  const effective = [];
  const suppressed = [];
  for (const rule of matches) {
    if ((rule.priority ?? 0) === maxPriority) effective.push(rule);
    else suppressed.push(rule);
  }
  return { maxPriority, effective, suppressed };
}

function buildPath(node) {
  const path = [];
  let current = node;
  while (current.parent) {
    path.unshift({
      step: current.depth,
      ruleId: current.ruleId,
      ruleName: current.ruleName,
      state: current.snapshot,
    });
    current = current.parent;
  }
  return path;
}

export function analyze(input) {
  const { variables, initialState, rules, maxSteps, maxStates } = input;
  const varMap = new Map(variables.map((v) => [v.name, v]));

  const findings = { deadlock: [], conflict: [], invalidTransition: [] };
  const seen = new Set();
  const queue = [];

  const rootKey = canonicalKey(initialState, variables);
  seen.add(rootKey);
  let head = 0;
  queue.push({
    state: initialState,
    depth: 0,
    parent: null,
    ruleId: null,
    ruleName: null,
    snapshot: { ...initialState },
  });

  let truncated = false;
  let transitions = 0;
  let truncatedTransitions = 0;
  let stepCutFrontier = 0; // 落在步数边界上、仍有可执行规则的状态数
  let maxDepthReached = 0;
  let suppressedTotal = 0; // 被低优先级抑制的规则实例总数（按 状态×规则 计）

  const addFinding = (type, finding) => {
    if (findings[type].length < FINDING_LIMIT) findings[type].push(finding);
  };

  while (head < queue.length) {
    const node = queue[head++];
    if (node.depth > maxDepthReached) maxDepthReached = node.depth;

    let matches;
    try {
      matches = matchingRules(node.state, rules);
    } catch (error) {
      throw new Error(`规则条件求值失败: ${error.message}`);
    }

    if (matches.length === 0) {
      addFinding('deadlock', {
        depth: node.depth,
        state: { ...node.state },
        path: buildPath(node),
      });
      continue;
    }

    // 优先级分层：仅最高优先级规则生效，低优先级规则被抑制
    const { maxPriority, effective, suppressed } = splitByPriority(matches);
    suppressedTotal += suppressed.length;

    if (effective.length > 1) {
      addFinding('conflict', {
        depth: node.depth,
        state: { ...node.state },
        priority: maxPriority,
        ruleIds: effective.map((r) => r.id),
        ruleNames: effective.map((r) => r.name),
        suppressed: suppressed.map((r) => ({
          id: r.id,
          name: r.name,
          priority: r.priority ?? 0,
        })),
        path: buildPath(node),
      });
    }

    // 步数边界：问题检测已完成，但不再扩展后继。
    // 边界上仍有可执行规则，说明视界之外存在未探索状态，结果不完备。
    if (node.depth >= maxSteps) {
      stepCutFrontier++;
      truncated = true;
      continue;
    }

    // 即便存在冲突，仍沿每条生效规则继续探索（每个后继独立检查合法性）；
    // 被抑制的低优先级规则不参与转移，也不做越界检查
    for (const rule of effective) {
      const result = applyRule(node.state, rule, varMap);
      if (!result.ok) {
        addFinding('invalidTransition', {
          depth: node.depth,
          state: { ...node.state },
          ruleId: rule.id,
          ruleName: rule.name,
          reason: result.reason,
          path: buildPath(node),
        });
        continue;
      }
      transitions++;
      const key = canonicalKey(result.state, variables);
      if (seen.has(key)) continue;

      if (seen.size >= maxStates) {
        truncated = true;
        truncatedTransitions++;
        continue;
      }
      seen.add(key);
      queue.push({
        state: result.state,
        depth: node.depth + 1,
        parent: node,
        ruleId: rule.id,
        ruleName: rule.name,
        snapshot: { ...result.state },
      });
    }
  }

  const counts = {
    deadlock: findings.deadlock.length,
    conflict: findings.conflict.length,
    invalidTransition: findings.invalidTransition.length,
    suppressed: suppressedTotal,
  };
  const hasIssue =
    counts.deadlock > 0 || counts.conflict > 0 || counts.invalidTransition > 0;

  let verdict;
  if (hasIssue && truncated) verdict = 'issues_incomplete';
  else if (hasIssue) verdict = 'issues';
  else if (truncated) verdict = 'unknown_incomplete';
  else verdict = 'safe';

  return {
    verdict,
    truncated,
    complete: !truncated,
    stats: {
      statesExplored: seen.size,
      maxStates,
      maxSteps,
      transitions,
      truncatedTransitions,
      stepCutFrontier,
      maxDepthReached,
      findingsDetailLimit: FINDING_LIMIT,
    },
    counts,
    findings,
  };
}
