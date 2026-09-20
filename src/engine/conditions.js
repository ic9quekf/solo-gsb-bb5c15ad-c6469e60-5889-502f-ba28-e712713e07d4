// 条件树求值。节点类型：
//   { kind: 'all', children: [...] }  全部成立（AND）
//   { kind: 'any', children: [...] }  任一成立（OR）
//   { kind: 'not', child: node }      逻辑非
//   { kind: 'leaf', var, op, value }  原子比较
// null / undefined 表示“无条件”，始终成立。

const COMPARATORS = {
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
};

export function evalCondition(node, state) {
  if (node === null || node === undefined) return true;
  switch (node.kind) {
    case 'all':
      return node.children.every((child) => evalCondition(child, state));
    case 'any':
      return node.children.some((child) => evalCondition(child, state));
    case 'not':
      return !evalCondition(node.child, state);
    case 'leaf': {
      const fn = COMPARATORS[node.op];
      if (!fn) throw new Error(`未知比较运算符: ${node.op}`);
      return fn(state[node.var], node.value);
    }
    default:
      throw new Error(`未知条件节点类型: ${node.kind}`);
  }
}
