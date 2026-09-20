// 赋值执行。赋值语句：{ target, op, value }
//   int : set / add / sub，结果必须落在定义域 [domain.min, domain.max]
//   bool: 仅支持 set 布尔值

export function applyAssignment(state, assignment, varMap) {
  const variable = varMap.get(assignment.target);
  if (!variable) {
    return { ok: false, reason: `赋值目标变量不存在: ${assignment.target}` };
  }
  const current = state[assignment.target];
  let next;

  if (variable.type === 'bool') {
    if (assignment.op !== 'set') {
      return { ok: false, reason: '布尔变量只支持直接赋值（set）' };
    }
    next = assignment.value;
    if (typeof next !== 'boolean') {
      return { ok: false, reason: `变量 ${variable.name} 需要布尔值` };
    }
  } else {
    if (!Number.isInteger(assignment.value)) {
      return { ok: false, reason: `变量 ${variable.name} 的赋值必须是整数` };
    }
    if (assignment.op === 'set') next = assignment.value;
    else if (assignment.op === 'add') next = current + assignment.value;
    else if (assignment.op === 'sub') next = current - assignment.value;
    else return { ok: false, reason: `未知赋值操作: ${assignment.op}` };

    if (!Number.isInteger(next) || next < variable.domain.min || next > variable.domain.max) {
      return {
        ok: false,
        reason: `变量 ${variable.name} 赋值结果 ${next} 超出定义域 [${variable.domain.min}, ${variable.domain.max}]`,
      };
    }
  }
  return { ok: true, value: next };
}

// 顺序执行一条规则的全部赋值，返回新状态（不修改原状态）
export function applyRule(state, rule, varMap) {
  const next = { ...state };
  for (const assignment of rule.assignments) {
    const result = applyAssignment(next, assignment, varMap);
    if (!result.ok) return { ok: false, reason: result.reason };
    next[assignment.target] = result.value;
  }
  return { ok: true, state: next };
}
