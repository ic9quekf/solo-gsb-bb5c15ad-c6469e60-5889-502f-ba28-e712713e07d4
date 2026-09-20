/* 桌游回合规则验证器 —— 原生 JS 前端 */
'use strict';

// ---------- 应用状态 ----------
const model = {
  variables: [],
  initialState: {},
  rules: [],
  maxSteps: 12,
  maxStates: 5000,
};
let uid = 0;
const esc = (v) =>
  String(v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );

const INT_OPS = [['==', '='], ['!=', '≠'], ['>', '>'], ['>=', '≥'], ['<', '<'], ['<=', '≤']];
const BOOL_OPS = [['==', '='], ['!=', '≠']];
const INT_ASSIGN = [['set', '= 设为'], ['add', '+= 增加'], ['sub', '−= 减少']];

const varsList = document.getElementById('varsList');
const initialForm = document.getElementById('initialStateForm');
const rulesList = document.getElementById('rulesList');
const resultPanel = document.getElementById('resultPanel');

// ---------- 条件树工具 ----------
function makeLeaf() {
  const v = model.variables[0];
  return { kind: 'leaf', var: v ? v.name : '', op: '==', value: v && v.type === 'bool' ? false : 0 };
}
function makeGroup(kind) {
  return { kind, children: [makeLeaf()] };
}
function getNode(root, path) {
  let node = root;
  for (const i of path) node = node.kind === 'not' ? node.children[0] : node.children[i];
  return node;
}
function getParent(root, path) {
  if (path.length === 0) return null;
  return getNode(root, path.slice(0, -1));
}
// 导出规范化：not 节点在后端使用 child 单字段；删除后变空的分组整体剔除
function conditionOut(node) {
  if (!node) return null;
  if (node.kind === 'leaf') return { kind: 'leaf', var: node.var, op: node.op, value: node.value };
  if (node.kind === 'not') {
    const child = conditionOut(node.children[0]);
    return child ? { kind: 'not', child } : null;
  }
  const children = node.children.map(conditionOut).filter(Boolean);
  return children.length ? { kind: node.kind, children } : null;
}
// 导入规范化：后端 not.child -> 前端 children
function conditionIn(node) {
  if (!node) return null;
  if (node.kind === 'leaf') return { ...node };
  if (node.kind === 'not') return { kind: 'not', children: [conditionIn(node.child)].filter(Boolean) };
  return { kind: node.kind, children: (node.children || []).map(conditionIn) };
}
// 变量删除/类型变化后修正引用
function defaultValue(v) {
  if (!v) return 0;
  if (v.type === 'bool') return false;
  const d = v.domain;
  if (0 >= d.min && 0 <= d.max) return 0;
  return d.min;
}
function fixConditionRefs(node, varName, typeChanged) {
  if (!node) return;
  if (node.kind === 'leaf') {
    if (node.var === varName && typeChanged) node.value = defaultValue(model.variables.find((v) => v.name === varName));
    return;
  }
  if (node.kind === 'not') fixConditionRefs(node.children[0], varName, typeChanged);
  else node.children.forEach((c) => fixConditionRefs(c, varName, typeChanged));
}
function pruneVariable(varName) {
  delete model.initialState[varName];
  const pruneNode = (node) => {
    if (!node) return null;
    if (node.kind === 'leaf') return node.var === varName ? null : node;
    if (node.kind === 'not') {
      const c = pruneNode(node.children[0]);
      return c ? { kind: 'not', children: [c] } : null;
    }
    const children = node.children.map(pruneNode).filter(Boolean);
    return children.length ? { kind: node.kind, children } : null;
  };
  for (const rule of model.rules) {
    rule.condition = pruneNode(rule.condition);
    rule.assignments = rule.assignments.filter((a) => a.target !== varName);
  }
}

// ---------- 渲染：变量 ----------
function renderVariables() {
  if (model.variables.length === 0) {
    varsList.innerHTML = '<p class="muted">尚未定义变量，点击右上角添加。</p>';
  } else {
    varsList.innerHTML = model.variables
      .map((v, i) => {
        const dom =
          v.type === 'int'
            ? `<span class="dom">定义域
                <input class="narrow" data-act="var-input" data-idx="${i}" data-field="min" type="number" value="${esc(v.domain.min)}"> ~
                <input class="narrow" data-act="var-input" data-idx="${i}" data-field="max" type="number" value="${esc(v.domain.max)}"></span>`
            : '<span class="muted">布尔型 (true / false)</span>';
        return `<div class="var-row">
          <input class="wide" data-act="var-input" data-idx="${i}" data-field="name" value="${esc(v.name)}" placeholder="变量名">
          <select data-act="var-input" data-idx="${i}" data-field="type">
            <option value="int" ${v.type === 'int' ? 'selected' : ''}>整数 int</option>
            <option value="bool" ${v.type === 'bool' ? 'selected' : ''}>布尔 bool</option>
          </select>
          ${dom}
          <button type="button" class="btn small danger-text" data-act="var-remove" data-idx="${i}">删除</button>
        </div>`;
      })
      .join('');
  }
  renderInitialState();
}

function renderInitialState() {
  if (model.variables.length === 0) {
    initialForm.innerHTML = '<p class="muted">请先添加变量</p>';
    return;
  }
  initialForm.innerHTML = model.variables
    .map((v) => {
      const val = model.initialState[v.name];
      const input =
        v.type === 'bool'
          ? `<input type="checkbox" data-act="init" data-name="${esc(v.name)}" ${val ? 'checked' : ''}>`
          : `<input class="narrow" type="number" data-act="init" data-name="${esc(v.name)}" value="${esc(val ?? 0)}">`;
      return `<div class="field"><span class="fname">${esc(v.name)}</span>${input}</div>`;
    })
    .join('');
}

// ---------- 渲染：条件树 ----------
function varOptions(selected) {
  return model.variables
    .map((v) => `<option value="${esc(v.name)}" ${v.name === selected ? 'selected' : ''}>${esc(v.name)}</option>`)
    .join('');
}
function opOptions(v, selected) {
  const ops = v && v.type === 'bool' ? BOOL_OPS : INT_OPS;
  return ops.map(([o, label]) => `<option value="${o}" ${o === selected ? 'selected' : ''}>${label}</option>`).join('');
}

function renderConditionNode(ruleIdx, node, path, isRoot) {
  const p = path.join('.');
  if (node.kind === 'leaf') {
    const v = model.variables.find((x) => x.name === node.var);
    const valueCtrl =
      v && v.type === 'bool'
        ? `<input type="checkbox" data-cond="leaf-input" data-idx="${ruleIdx}" data-path="${p}" data-field="value" ${node.value ? 'checked' : ''}>`
        : `<input class="narrow" type="number" data-cond="leaf-input" data-idx="${ruleIdx}" data-path="${p}" data-field="value" value="${esc(node.value)}">`;
    return `<div class="cond-node">
      <div class="cond-leaf">
        <select data-cond="leaf-input" data-idx="${ruleIdx}" data-path="${p}" data-field="var">${varOptions(node.var)}</select>
        <select data-cond="leaf-input" data-idx="${ruleIdx}" data-path="${p}" data-field="op">${opOptions(v, node.op)}</select>
        ${valueCtrl}
        <button type="button" class="btn small danger-text" data-cond="remove" data-idx="${ruleIdx}" data-path="${p}">✕</button>
      </div>
    </div>`;
  }

  const isNot = node.kind === 'not';
  const kindLabel = { all: '全部满足 (AND)', any: '任一满足 (OR)', not: '逻辑非 (NOT)' }[node.kind];
  const addBtns = isNot
    ? ''
    : `<button type="button" class="btn small" data-cond="add-leaf" data-idx="${ruleIdx}" data-path="${p}">＋ 条件</button>
       <button type="button" class="btn small" data-cond="add-all" data-idx="${ruleIdx}" data-path="${p}">＋ AND 分组</button>
       <button type="button" class="btn small" data-cond="add-any" data-idx="${ruleIdx}" data-path="${p}">＋ OR 分组</button>`;
  const removeBtn = isRoot
    ? `<button type="button" class="btn small" data-cond="clear" data-idx="${ruleIdx}">清除条件（规则始终触发）</button>`
    : `<button type="button" class="btn small danger-text" data-cond="remove" data-idx="${ruleIdx}" data-path="${p}">删除分组</button>`;

  const kids = isNot ? node.children.slice(0, 1) : node.children;
  return `<div class="cond-node group-kind-${esc(node.kind)}">
    <div class="cond-row">
      <span class="cond-badge badge-${esc(node.kind)}">${esc(kindLabel)}</span>
      <select data-cond="kind" data-idx="${ruleIdx}" data-path="${p}">
        <option value="all" ${node.kind === 'all' ? 'selected' : ''}>全部满足 AND</option>
        <option value="any" ${node.kind === 'any' ? 'selected' : ''}>任一满足 OR</option>
        <option value="not" ${node.kind === 'not' ? 'selected' : ''}>逻辑非 NOT</option>
      </select>
      ${addBtns}
      ${removeBtn}
    </div>
    <div class="cond-children">
      ${kids.map((child, i) => renderConditionNode(ruleIdx, child, [...path, i], false)).join('')}
    </div>
  </div>`;
}

// ---------- 渲染：规则 ----------
function renderAssignments(rule, ruleIdx) {
  const rows = rule.assignments
    .map((a, ai) => {
      const v = model.variables.find((x) => x.name === a.target);
      const opSelect =
        v && v.type === 'bool'
          ? '<select disabled><option>设为</option></select>'
          : `<select data-act="assign-input" data-idx="${ruleIdx}" data-ai="${ai}" data-field="op">
              ${INT_ASSIGN.map(([o, label]) => `<option value="${o}" ${a.op === o ? 'selected' : ''}>${label}</option>`).join('')}
            </select>`;
      const valueCtrl =
        v && v.type === 'bool'
          ? `<input type="checkbox" data-act="assign-input" data-idx="${ruleIdx}" data-ai="${ai}" data-field="value" ${a.value ? 'checked' : ''}>`
          : `<input class="narrow" type="number" data-act="assign-input" data-idx="${ruleIdx}" data-ai="${ai}" data-field="value" value="${esc(a.value ?? 0)}">`;
      return `<div class="assign-row">
        <select data-act="assign-input" data-idx="${ruleIdx}" data-ai="${ai}" data-field="target">${varOptions(a.target)}</select>
        ${opSelect}
        ${valueCtrl}
        <button type="button" class="btn small danger-text" data-act="assign-remove" data-idx="${ruleIdx}" data-ai="${ai}">✕</button>
      </div>`;
    })
    .join('');
  return `<div class="rule-section-title">赋值（规则触发后顺序执行）</div>
    ${rows || '<p class="muted">无赋值（状态不变）</p>'}
    <button type="button" class="btn small" data-act="assign-add" data-idx="${ruleIdx}">＋ 添加赋值</button>`;
}

function renderRules() {
  if (model.rules.length === 0) {
    rulesList.innerHTML = '<p class="muted">尚未添加规则。</p>';
    return;
  }
  rulesList.innerHTML = model.rules
    .map((rule, i) => {
      const cond = rule.condition
        ? renderConditionNode(i, rule.condition, [], true)
        : `<div class="cond-node"><div class="cond-row">
             <span class="muted">无条件 —— 该规则在任何状态下都可执行</span>
             <button type="button" class="btn small" data-cond="add-leaf" data-idx="${i}" data-path="">添加触发条件</button>
           </div></div>`;
      return `<div class="rule-card">
        <div class="rule-head">
          <span class="rid">规则 ID</span>
          <input class="wide" data-act="rule-input" data-idx="${i}" data-field="id" value="${esc(rule.id)}">
          <span class="muted">名称</span>
          <input class="wide" data-act="rule-input" data-idx="${i}" data-field="name" value="${esc(rule.name)}">
          <button type="button" class="btn small danger-text" data-act="rule-remove" data-idx="${i}">删除规则</button>
        </div>
        <div class="rule-section-title">触发条件</div>
        ${cond}
        ${renderAssignments(rule, i)}
      </div>`;
    })
    .join('');
}

// ---------- 事件：变量区 ----------
varsList.addEventListener('change', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const idx = Number(el.dataset.idx);
  const v = model.variables[idx];
  const field = el.dataset.field;
  if (field === 'name') {
    const old = v.name;
    const next = el.value.trim();
    if (!next || next === old) return el.value = old;
    if (model.variables.some((x) => x.name === next)) {
      alert(`变量名 ${next} 已存在`);
      return (el.value = old);
    }
    renameVariable(old, next);
  } else if (field === 'type') {
    v.type = el.value;
    if (v.type === 'bool') v.domain = null;
    else v.domain = { min: 0, max: 10 };
    model.initialState[v.name] = defaultValue(v);
    for (const r of model.rules) {
      fixConditionRefs(r.condition, v.name, true);
      r.assignments.forEach((a) => { if (a.target === v.name) a.value = defaultValue(v); });
    }
  } else if (field === 'min' || field === 'max') {
    v.domain[field] = Number(el.value);
  }
  renderAll();
});

function renameVariable(oldName, newName) {
  const v = model.variables.find((x) => x.name === oldName);
  v.name = newName;
  model.initialState[newName] = model.initialState[oldName];
  delete model.initialState[oldName];
  const renameIn = (node) => {
    if (!node) return;
    if (node.kind === 'leaf') { if (node.var === oldName) node.var = newName; return; }
    if (node.kind === 'not') renameIn(node.children[0]);
    else node.children.forEach(renameIn);
  };
  model.rules.forEach((r) => {
    renameIn(r.condition);
    r.assignments.forEach((a) => { if (a.target === oldName) a.target = newName; });
  });
}

varsList.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  if (el.dataset.act === 'var-remove') {
    const name = model.variables[Number(el.dataset.idx)].name;
    if (!confirm(`删除变量 ${name}？相关条件与赋值会一并移除。`)) return;
    model.variables.splice(Number(el.dataset.idx), 1);
    pruneVariable(name);
    renderAll();
  }
});

initialForm.addEventListener('change', (e) => {
  const el = e.target.closest('[data-act="init"]');
  if (!el) return;
  const v = model.variables.find((x) => x.name === el.dataset.name);
  model.initialState[v.name] = v.type === 'bool' ? el.checked : Number(el.value);
});

// ---------- 事件：规则区 ----------
rulesList.addEventListener('change', (e) => {
  const el = e.target.closest('[data-act],[data-cond]');
  if (!el) return;

  if (el.dataset.act === 'rule-input') {
    const rule = model.rules[Number(el.dataset.idx)];
    rule[el.dataset.field] = el.value;
    return;
  }
  if (el.dataset.act === 'assign-input') {
    const rule = model.rules[Number(el.dataset.idx)];
    const a = rule.assignments[Number(el.dataset.ai)];
    const field = el.dataset.field;
    if (field === 'target') {
      a.target = el.value;
      const v = model.variables.find((x) => x.name === a.target);
      a.op = 'set';
      a.value = defaultValue(v);
    } else if (field === 'op') {
      a.op = el.value;
    } else {
      a.value = el.type === 'checkbox' ? el.checked : Number(el.value);
    }
    renderRules();
    return;
  }

  // ---- 条件树 ----
  const condAction = el.dataset.cond;
  if (!condAction) return;
  const ruleIdx = Number(el.dataset.idx);
  const rule = model.rules[ruleIdx];
  const path = el.dataset.path === '' ? [] : el.dataset.path.split('.').map(Number);

  if (condAction === 'leaf-input') {
    const node = getNode(rule.condition, path);
    const field = el.dataset.field;
    if (field === 'var') {
      node.var = el.value;
      node.op = '==';
      node.value = defaultValue(model.variables.find((x) => x.name === node.var));
    } else if (field === 'op') {
      node.op = el.value;
    } else {
      node.value = el.type === 'checkbox' ? el.checked : Number(el.value);
    }
    renderRules();
    return;
  }
  if (condAction === 'kind') {
    const node = path.length === 0 ? rule.condition : getNode(rule.condition, path);
    node.kind = el.value;
    if (node.kind === 'not') {
      node.children = node.children.slice(0, 1);
      if (node.children.length === 0) node.children = [makeLeaf()];
    }
    renderRules();
    return;
  }
  if (condAction === 'add-leaf' || condAction === 'add-all' || condAction === 'add-any') {
    if (!rule.condition) {
      rule.condition = makeLeaf();
    } else {
      const parent = getNode(rule.condition, path);
      parent.children.push(condAction === 'add-leaf' ? makeLeaf() : makeGroup(condAction === 'add-all' ? 'all' : 'any'));
    }
    renderRules();
    return;
  }
  if (condAction === 'remove') {
    if (path.length === 0) {
      rule.condition = null;
    } else {
      const parent = getParent(rule.condition, path);
      const idx = path[path.length - 1];
      if (parent.kind === 'not') parent.children = [];
      else parent.children.splice(idx, 1);
    }
    renderRules();
    return;
  }
  if (condAction === 'clear') {
    rule.condition = null;
    renderRules();
  }
});

rulesList.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const idx = Number(el.dataset.idx);
  if (act === 'rule-remove') {
    if (!confirm('删除该规则？')) return;
    model.rules.splice(idx, 1);
    renderRules();
  } else if (act === 'assign-add') {
    const v = model.variables[0];
    model.rules[idx].assignments.push({ target: v ? v.name : '', op: 'set', value: v ? defaultValue(v) : 0 });
    renderRules();
  } else if (act === 'assign-remove') {
    model.rules[idx].assignments.splice(Number(el.dataset.ai), 1);
    renderRules();
  }
});

// ---------- 顶部按钮 ----------
document.getElementById('addVarBtn').addEventListener('click', () => {
  let name = `var${++uid}`;
  let n = 1;
  while (model.variables.some((v) => v.name === name)) name = `var${++uid}`;
  model.variables.push({ type: 'int', name, domain: { min: 0, max: 10 } });
  model.initialState[name] = 0;
  renderAll();
});

document.getElementById('addRuleBtn').addEventListener('click', () => {
  let n = model.rules.length + 1;
  while (model.rules.some((r) => r.id === `R${n}`)) n++;
  model.rules.push({
    id: `R${n}`,
    name: `规则 ${n}`,
    condition: model.variables[0] ? makeLeaf() : null,
    assignments: [],
  });
  renderRules();
});

document.getElementById('maxSteps').addEventListener('change', (e) => {
  model.maxSteps = Number(e.target.value);
});
document.getElementById('maxStates').addEventListener('change', (e) => {
  model.maxStates = Number(e.target.value);
});

// ---------- 序列化 / 导入导出 ----------
function buildPayload() {
  model.maxSteps = Number(document.getElementById('maxSteps').value);
  model.maxStates = Number(document.getElementById('maxStates').value);
  return {
    variables: model.variables.map((v) =>
      v.type === 'bool'
        ? { name: v.name, type: 'bool', domain: null }
        : { name: v.name, type: 'int', domain: { min: Number(v.domain.min), max: Number(v.domain.max) } },
    ),
    initialState: { ...model.initialState },
    rules: model.rules.map((r) => ({
      id: r.id,
      name: r.name,
      condition: conditionOut(r.condition),
      assignments: r.assignments.map((a) => ({ ...a })),
    })),
    maxSteps: model.maxSteps,
    maxStates: model.maxStates,
  };
}

document.getElementById('exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(buildPayload(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'ruleset.json';
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById('importBtn').addEventListener('click', () => {
  document.getElementById('importFile').click();
});
document.getElementById('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    loadPayload(data);
  } catch (err) {
    alert(`导入失败：${err.message}`);
  }
  e.target.value = '';
});

function loadPayload(data) {
  if (!data || !Array.isArray(data.variables) || !Array.isArray(data.rules)) {
    alert('JSON 格式不正确：需要 variables、rules 等字段（可先导出一份参考）。');
    return;
  }
  model.variables = data.variables.map((v) => ({
    name: String(v.name),
    type: v.type === 'bool' ? 'bool' : 'int',
    domain: v.type === 'bool' ? null : { min: Number(v.domain?.min ?? 0), max: Number(v.domain?.max ?? 10) },
  }));
  model.initialState = {};
  for (const v of model.variables) {
    const val = data.initialState?.[v.name];
    model.initialState[v.name] = v.type === 'bool' ? Boolean(val) : Number(val ?? defaultValue(v));
  }
  model.rules = data.rules.map((r) => ({
    id: String(r.id),
    name: String(r.name ?? r.id),
    condition: conditionIn(r.condition ?? null),
    assignments: (r.assignments ?? []).map((a) => ({
      target: String(a.target),
      op: String(a.op ?? 'set'),
      value: a.value,
    })),
  }));
  model.maxSteps = Number(data.maxSteps ?? 12);
  model.maxStates = Number(data.maxStates ?? 5000);
  document.getElementById('maxSteps').value = model.maxSteps;
  document.getElementById('maxStates').value = model.maxStates;
  renderAll();
  resultPanel.hidden = true;
}

// ---------- 运行验证 ----------
document.getElementById('runBtn').addEventListener('click', async () => {
  if (model.variables.length === 0) return alert('请至少定义一个变量');
  if (model.rules.length === 0) return alert('请至少添加一条规则');
  const btn = document.getElementById('runBtn');
  btn.disabled = true;
  btn.textContent = '探索中…';
  try {
    const res = await fetch('/api/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPayload()),
    });
    const json = await res.json();
    if (!res.ok || !json.ok) renderErrors(json.errors || ['请求失败']);
    else renderResult(json.result);
    resultPanel.hidden = false;
    resultPanel.scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    renderErrors([err.message]);
  } finally {
    btn.disabled = false;
    btn.textContent = '▶ 运行验证（广度优先探索）';
  }
});

// ---------- 结果渲染 ----------
const stateText = (state) =>
  Object.entries(state)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(', ');

const VERDICT_META = {
  safe: { cls: 'verdict-safe', icon: '✅', title: '安全：探索范围内未发现问题状态',
    detail: '所有可达状态均恰好有一条规则可执行，且赋值结果均在定义域内。' },
  issues: { cls: 'verdict-issues', icon: '⛔', title: '发现问题状态',
    detail: '存在死锁、互斥规则冲突或越界赋值（探索已完整覆盖可达状态空间）。' },
  issues_incomplete: { cls: 'verdict-incomplete', icon: '⚠️', title: '发现问题状态，但结果不完备',
    detail: '已发现下列问题；但因达到状态上限，部分状态未被探索，可能还存在更多问题。不可据此判定安全。' },
  unknown_incomplete: { cls: 'verdict-incomplete', icon: '⚠️', title: '结果不完备：不能判定安全',
    detail: '已探索的状态中没有发现问题，但达到状态上限后探索被截断，未探索的状态可能存在问题。请调大 maxStates 后重试。' },
};

function renderErrors(errors) {
  resultPanel.hidden = false;
  document.getElementById('verdict').innerHTML =
    `<div class="verdict-box verdict-errors"><div>❌ 输入校验失败（未开始探索）</div>
      <div class="detail"><ul>${errors.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div></div>`;
  document.getElementById('stats').innerHTML = '';
  document.getElementById('findings').innerHTML = '';
}

function renderResult(result) {
  const meta = VERDICT_META[result.verdict];
  let banner = `<div class="verdict-box ${meta.cls}"><div>${meta.icon} ${meta.title}</div>
    <div class="detail">${meta.detail}</div>`;
  if (result.truncated) {
    const reasons = [];
    if (result.stats.truncatedTransitions > 0)
      reasons.push(`${result.stats.truncatedTransitions} 个转移指向的新状态超过状态上限而未入队`);
    if (result.stats.stepCutFrontier > 0)
      reasons.push(`${result.stats.stepCutFrontier} 个状态已处于步数边界（深度 ${result.stats.maxSteps}），其后继未展开`);
    banner += `<div class="detail">🔕 完备性标记：<b>truncated = true（不完备）</b>，${reasons.join('；')}。</div>`;
  }
  document.getElementById('verdict').innerHTML = banner + '</div>';

  const s = result.stats;
  const stat = (num, label, cls = '') => `<div class="stat ${cls}"><div class="num">${num}</div><div class="label">${label}</div></div>`;
  document.getElementById('stats').innerHTML =
    stat(s.statesExplored, '已探索去重状态数') +
    stat(s.maxDepthReached, '实际到达最大深度') +
    stat(s.maxSteps, '步数上限 maxSteps') +
    stat(s.maxStates, '状态上限 maxStates', result.truncated ? 'warn' : '') +
    stat(s.transitions, '合法转移次数') +
    stat(result.counts.deadlock, '死锁状态（无规则可执行）', result.counts.deadlock ? 'bad' : '') +
    stat(result.counts.conflict, '冲突状态（多规则互斥）', result.counts.conflict ? 'bad' : '') +
    stat(result.counts.invalidTransition, '越界/非法转移', result.counts.invalidTransition ? 'bad' : '');

  const groups = [
    ['deadlock', '🚫 死锁：以下状态没有任何规则可执行', renderDeadlock],
    ['conflict', '⚔️ 互斥冲突：以下状态有多个规则同时可执行', renderConflict],
    ['invalidTransition', '💥 非法转移：规则赋值结果超出变量定义域', renderInvalid],
  ];
  document.getElementById('findings').innerHTML = groups
    .filter(([type]) => result.findings[type].length > 0)
    .map(([type, title, fn]) => `
      <div class="findings-group">
        <h3>${title} <span class="count-chip">${result.counts[type]} 条最短路径</span></h3>
        ${result.findings[type].map((f) => fn(f)).join('')}
      </div>`)
    .join('') || '<p class="muted">已探索范围内未发现问题状态。</p>';
}

function pathHtml(finding) {
  const rows = [`<li>🕐 初始状态<span class="state-chip">${finding.path.length ? esc(stateText(finding.path[0].state)) : esc(stateText(finding.state))}</span></li>`];
  finding.path.forEach((step, i) => {
    const shown = i === finding.path.length - 1 ? finding.state : finding.path[i + 1].state;
    rows.push(
      `<li><span class="step-tag">第 ${step.step} 步</span> [${esc(step.ruleId)}] ${esc(step.ruleName)} → <span class="state-chip">${esc(stateText(shown))}</span></li>`,
    );
  });
  return `<ul class="path-list">${rows.join('')}
    <li class="target-state">🎯 问题状态（深度 ${finding.depth}）<span class="state-chip">${esc(stateText(finding.state))}</span></li></ul>`;
}

function renderDeadlock(f) {
  return `<div class="finding-card">
    <div><b>深度 ${f.depth}</b>：状态下没有任何规则的触发条件成立。</div>
    ${pathHtml(f)}</div>`;
}
function renderConflict(f) {
  return `<div class="finding-card">
    <div><b>深度 ${f.depth}</b>：同时可执行的规则 —— ${f.ruleIds.map((id, i) => `[${esc(id)}] ${esc(f.ruleNames[i])}`).map(esc).join(' ／ ')}</div>
    ${pathHtml(f)}</div>`;
}
function renderInvalid(f) {
  return `<div class="finding-card">
    <div><b>深度 ${f.depth}</b>：执行 [${esc(f.ruleId)}] ${esc(f.ruleName)}</div>
    <div class="reason">原因：${esc(f.reason)}</div>
    ${pathHtml(f)}</div>`;
}

// ---------- 示例 ----------
const SAFE_PRESET = {
  variables: [
    { name: 'phase', type: 'int', domain: { min: 0, max: 2 } },
    { name: 'active', type: 'int', domain: { min: 0, max: 1 } },
  ],
  initialState: { phase: 0, active: 0 },
  rules: [
    { id: 'draw', name: '抽牌阶段 -> 行动阶段', condition: { kind: 'leaf', var: 'phase', op: '==', value: 0 },
      assignments: [{ target: 'phase', op: 'set', value: 1 }] },
    { id: 'act', name: '行动阶段 -> 结束阶段', condition: { kind: 'leaf', var: 'phase', op: '==', value: 1 },
      assignments: [{ target: 'phase', op: 'set', value: 2 }] },
    { id: 'end', name: '结束阶段 -> 换手牌抽牌',
      condition: { kind: 'leaf', var: 'phase', op: '==', value: 2 },
      assignments: [
        { target: 'phase', op: 'set', value: 0 },
        { target: 'active', op: 'set', value: 0 },
      ] },
    { id: 'switch', name: '（冗余演示，永不可达）切换活跃玩家',
      condition: { kind: 'leaf', var: 'active', op: '==', value: 1 },
      assignments: [{ target: 'active', op: 'set', value: 0 }] },
  ],
  maxSteps: 12,
  maxStates: 5000,
};

const BUGGY_PRESET = {
  variables: [
    { name: 'phase', type: 'int', domain: { min: 0, max: 2 } },
    { name: 'energy', type: 'int', domain: { min: 0, max: 5 } },
  ],
  initialState: { phase: 0, energy: 5 },
  rules: [
    { id: 'play', name: '出牌（耗能 1，进入行动阶段）',
      condition: { kind: 'all', children: [
        { kind: 'leaf', var: 'phase', op: '==', value: 0 },
        { kind: 'leaf', var: 'energy', op: '>', value: 0 },
      ] },
      assignments: [
        { target: 'energy', op: 'sub', value: 1 },
        { target: 'phase', op: 'set', value: 1 },
      ] },
    { id: 'skip', name: '跳过回合（进入阶段 2，再无规则可执行）',
      condition: { kind: 'all', children: [
        { kind: 'leaf', var: 'phase', op: '==', value: 0 },
        { kind: 'leaf', var: 'energy', op: '>=', value: 0 },
      ] },
      assignments: [{ target: 'phase', op: 'set', value: 2 }] },
    { id: 'recharge', name: '行动后回蓝 1，回到阶段 0',
      condition: { kind: 'leaf', var: 'phase', op: '==', value: 1 },
      assignments: [
        { target: 'energy', op: 'add', value: 1 },
        { target: 'phase', op: 'set', value: 0 },
      ] },
    { id: 'overcharge', name: '过载：回蓝 4（高能量时越界！）',
      condition: { kind: 'leaf', var: 'phase', op: '==', value: 1 },
      assignments: [
        { target: 'energy', op: 'add', value: 4 },
        { target: 'phase', op: 'set', value: 0 },
      ] },
  ],
  maxSteps: 12,
  maxStates: 5000,
};

document.getElementById('loadSafePresetBtn').addEventListener('click', () => loadPayload(SAFE_PRESET));
document.getElementById('loadBuggyPresetBtn').addEventListener('click', () => loadPayload(BUGGY_PRESET));

function renderAll() {
  renderVariables();
  renderRules();
}

// 初始载入缺陷示例，打开即可体验
loadPayload(BUGGY_PRESET);
