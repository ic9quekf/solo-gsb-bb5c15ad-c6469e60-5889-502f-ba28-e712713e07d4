// 核心验证器：从初始状态做广度优先探索。
//
// 在每个状态下：
//   - 没有任何规则可执行            -> deadlock（死锁 / 无规则可执行）
//   - 多于一条规则同时可执行        -> conflict（互斥规则同时触发）
//   - 某条可执行规则的赋值越界      -> invalidTransition（非法转移）
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

    if (matches.length > 1) {
      addFinding('conflict', {
        depth: node.depth,
        state: { ...node.state },
        ruleIds: matches.map((r) => r.id),
        ruleNames: matches.map((r) => r.name),
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

    // 即便存在冲突，仍沿每条可执行规则继续探索（每个后继独立检查合法性）
    for (const rule of matches) {
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
