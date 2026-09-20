// 请求/规则集输入校验，返回 { data, errors }

const LIMITS = {
  VARIABLES_MAX: 30,
  RULES_MAX: 100,
  ASSIGNMENTS_MAX: 50,
  NAME_PATTERN: /^[A-Za-z_][A-Za-z0-9_]*$/,
  MAX_STEPS_MAX: 100,
  MAX_STATES_MAX: 200000,
  DOMAIN_MIN: -1_000_000_000,
  DOMAIN_MAX: 1_000_000_000,
};

const COMPARATORS = new Set(['==', '!=', '>', '>=', '<', '<=']);
const ASSIGN_OPS_INT = new Set(['set', 'add', 'sub']);
const ASSIGN_OPS_BOOL = new Set(['set']);

export function validateInput(raw) {
  const errors = [];
  const push = (message) => errors.push(message);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { data: null, errors: ['请求体必须是 JSON 对象'] };
  }

  // ---- 变量 ----
  const variables = [];
  if (!Array.isArray(raw.variables)) {
    push('variables 必须是数组');
  } else {
    if (raw.variables.length === 0) push('至少需要定义一个变量');
    if (raw.variables.length > LIMITS.VARIABLES_MAX)
      push(`变量数量不能超过 ${LIMITS.VARIABLES_MAX}`);
    const names = new Set();
    for (const [i, v] of raw.variables.entries()) {
      const where = `variables[${i}]`;
      if (!v || typeof v !== 'object') {
        push(`${where} 必须是对象`);
        continue;
      }
      const name = String(v.name ?? '');
      if (!LIMITS.NAME_PATTERN.test(name)) {
        push(`${where}.name 必须匹配 ${LIMITS.NAME_PATTERN}`);
      } else if (names.has(name)) {
        push(`${where}.name "${name}" 重复定义`);
      } else {
        names.add(name);
      }

      if (v.type === 'int') {
        const min = v.domain?.min;
        const max = v.domain?.max;
        if (!Number.isInteger(min) || !Number.isInteger(max)) {
          push(`${where}(${name}) 定义域 min/max 必须为整数`);
        } else if (min < LIMITS.DOMAIN_MIN || max > LIMITS.DOMAIN_MAX) {
          push(`${where}(${name}) 定义域范围超出允许边界`);
        } else if (min > max) {
          push(`${where}(${name}) 定义域 min 不能大于 max`);
        }
        variables.push({ type: 'int', name, domain: { min, max } });
      } else if (v.type === 'bool') {
        variables.push({ type: 'bool', name, domain: null });
      } else {
        push(`${where}(${name}).type 只支持 int 或 bool`);
      }
    }
  }

  const varMap = new Map(variables.map((v) => [v.name, v]));

  // ---- 初始状态 ----
  const initialState = {};
  if (!raw.initialState || typeof raw.initialState !== 'object' || Array.isArray(raw.initialState)) {
    push('initialState 必须是对象');
  } else {
    for (const variable of variables) {
      const value = raw.initialState[variable.name];
      if (variable.type === 'bool') {
        if (typeof value !== 'boolean') {
          push(`初始状态中 ${variable.name} 必须是布尔值`);
        } else {
          initialState[variable.name] = value;
        }
      } else {
        if (!Number.isInteger(value)) {
          push(`初始状态中 ${variable.name} 必须是整数`);
        } else if (
          value < variable.domain.min ||
          value > variable.domain.max
        ) {
          push(`初始状态中 ${variable.name}=${value} 超出定义域`);
        } else {
          initialState[variable.name] = value;
        }
      }
    }
    for (const key of Object.keys(raw.initialState)) {
      if (!varMap.has(key)) push(`初始状态包含未定义变量: ${key}`);
    }
  }

  // ---- 规则 ----
  const rules = [];
  if (!Array.isArray(raw.rules)) {
    push('rules 必须是数组');
  } else {
    if (raw.rules.length === 0) push('至少需要一条规则');
    if (raw.rules.length > LIMITS.RULES_MAX)
      push(`规则数量不能超过 ${LIMITS.RULES_MAX}`);
    const ruleIds = new Set();

    const validateCondition = (node, where) => {
      if (node === null || node === undefined) return;
      if (typeof node !== 'object' || Array.isArray(node)) {
        push(`${where} 必须是条件节点`);
        return;
      }
      switch (node.kind) {
        case 'all':
        case 'any':
          if (!Array.isArray(node.children)) {
            push(`${where}.children 必须是数组`);
          } else {
            node.children.forEach((child, i) =>
              validateCondition(child, `${where}.children[${i}]`),
            );
          }
          break;
        case 'not':
          if (!node.child) push(`${where}.child 不能为空（请使用“非”分组包裹条件）`);
          else validateCondition(node.child, `${where}.child`);
          break;
        case 'leaf': {
          if (!varMap.has(node.var)) {
            push(`${where} 引用了未定义变量: ${node.var}`);
            break;
          }
          if (!COMPARATORS.has(node.op)) {
            push(`${where}.op 必须是 ${[...COMPARATORS].join(' / ')} 之一`);
          }
          const variable = varMap.get(node.var);
          if (variable.type === 'bool') {
            if (typeof node.value !== 'boolean') push(`${where} 布尔变量比较值必须是 true/false`);
          } else if (!Number.isInteger(node.value)) {
            push(`${where} 整数变量比较值必须是整数`);
          }
          break;
        }
        default:
          push(`${where}.kind 必须是 all / any / not / leaf`);
      }
    };

    for (const [i, rule] of raw.rules.entries()) {
      const where = `rules[${i}]`;
      if (!rule || typeof rule !== 'object') {
        push(`${where} 必须是对象`);
        continue;
      }
      const id = String(rule.id ?? '');
      if (!LIMITS.NAME_PATTERN.test(id)) {
        push(`${where}.id 必须匹配 ${LIMITS.NAME_PATTERN}`);
      } else if (ruleIds.has(id)) {
        push(`${where}.id "${id}" 重复`);
      } else {
        ruleIds.add(id);
      }
      const name = typeof rule.name === 'string' && rule.name.trim()
        ? rule.name.trim()
        : id;

      if (!Array.isArray(rule.assignments)) {
        push(`${where}.assignments 必须是数组（无赋值请用 []）`);
      } else if (rule.assignments.length > LIMITS.ASSIGNMENTS_MAX) {
        push(`${where} 赋值数量不能超过 ${LIMITS.ASSIGNMENTS_MAX}`);
      }

      const assignments = [];
      if (Array.isArray(rule.assignments)) {
        for (const [j, a] of rule.assignments.entries()) {
          const aWhere = `${where}.assignments[${j}]`;
          if (!a || typeof a !== 'object') {
            push(`${aWhere} 必须是对象`);
            continue;
          }
          const target = varMap.get(a.target);
          if (!target) {
            push(`${aWhere}.target 引用了未定义变量: ${a.target}`);
            continue;
          }
          let valid = true;
          if (target.type === 'bool') {
            if (!ASSIGN_OPS_BOOL.has(a.op)) {
              push(`${aWhere}: 布尔变量仅支持 set`);
              valid = false;
            }
            if (typeof a.value !== 'boolean') {
              push(`${aWhere}: 布尔赋值必须是 true/false`);
              valid = false;
            }
          } else {
            if (!ASSIGN_OPS_INT.has(a.op)) {
              push(`${aWhere}.op 必须是 set / add / sub`);
              valid = false;
            }
            if (!Number.isInteger(a.value)) {
              push(`${aWhere}.value 必须是整数`);
              valid = false;
            }
          }
          if (valid) assignments.push({ target: a.target, op: a.op, value: a.value });
        }
      }
      validateCondition(rule.condition ?? null, `${where}.condition`);

      rules.push({ id, name, condition: rule.condition ?? null, assignments });
    }
  }

  // ---- 探索参数 ----
  const maxSteps = Number(raw.maxSteps ?? 12);
  const maxStates = Number(raw.maxStates ?? 5000);
  if (!Number.isInteger(maxSteps) || maxSteps < 0 || maxSteps > LIMITS.MAX_STEPS_MAX) {
    push(`maxSteps 必须是 0..${LIMITS.MAX_STEPS_MAX} 之间的整数`);
  }
  if (!Number.isInteger(maxStates) || maxStates < 1 || maxStates > LIMITS.MAX_STATES_MAX) {
    push(`maxStates 必须是 1..${LIMITS.MAX_STATES_MAX} 之间的整数`);
  }

  if (errors.length > 0) return { data: null, errors };
  return { data: { variables, initialState, rules, maxSteps, maxStates }, errors: [] };
}

export { LIMITS };
