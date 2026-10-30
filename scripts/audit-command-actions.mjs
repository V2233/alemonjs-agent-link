// Static root reachability only: arguments, roles and client behavior still require runtime review.
import ts from 'typescript';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
const root = process.cwd();
const parse = file => ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
const router = parse(join(root, 'src/router.ts'));
const roots = new Map();
const add = (value, source) => roots.set(value.split(/\s+/u)[0], source);
const walk = (node, visit) => { visit(node); ts.forEachChild(node, child => walk(child, visit)); };
walk(router, node => {
  if (ts.isPropertyAssignment(node) && node.name.getText(router) === 'path' && ts.isStringLiteral(node.initializer)) add(node.initializer.text, 'router path');
  if (ts.isForOfStatement(node) && ts.isArrayLiteralExpression(node.expression) && /\bpath\b/u.test(node.initializer.getText(router))) {
    for (const item of node.expression.elements) if (ts.isStringLiteral(item)) add(item.text, 'router loop');
  }
});
// These enter through the explicit pre-command personal-login handler, not commandGroup.
for (const command of ['个人登录', '个人退出']) add(command, 'personal-login event handler; runtime review required');
add('添加钥匙', 'key-intake event handler; actor-bound confirmation ticket');
const files = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : /\.tsx?$/u.test(entry.name) ? [join(dir, entry.name)] : []);
const sourceFiles = files(join(root, 'src')).sort();
const program = ts.createProgram(sourceFiles, { noResolve: true, target: ts.ScriptTarget.Latest });
const checker = program.getTypeChecker();
const heads = (node, seen = new Set()) => {
  if (seen.has(node)) return [null];
  seen.add(node);
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isTemplateExpression(node) && node.head.text.startsWith('/')) return [node.head.text];
  if (ts.isParenthesizedExpression(node)) return heads(node.expression, new Set(seen));
  if (ts.isConditionalExpression(node)) return [...heads(node.whenTrue, new Set(seen)), ...heads(node.whenFalse, new Set(seen))];
  if (ts.isIdentifier(node)) {
    const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer && (declaration.parent.flags & ts.NodeFlags.Const)) return heads(declaration.initializer, seen);
  }
  return [null];
};
const entries = [];
const paginationBases = [];
for (const file of sourceFiles) {
  const ast = program.getSourceFile(file);
  walk(ast, node => {
    if (!ts.isPropertyAssignment(node) || node.name.getText(ast) !== 'command') return;
    const value = node.initializer;
    const choices = heads(value);
    const resolvedRoots = choices.map(text => text?.match(/^\/([^\s$]+)/u)?.[1]);
    const candidates = [...new Set(resolvedRoots.filter(Boolean))];
    const unresolved = resolvedRoots.some(value => !value);
    const commandRoot = candidates[0];
    const entryState = unresolved ? 'dynamic-review-required' : candidates.length ? candidates.every(value => roots.has(value)) ? 'declared-root' : 'missing-root' : 'dynamic-review-required';
    const parent = node.parent.parent;
    if (ts.isPropertyAssignment(parent) && parent.name.getText(ast) === 'page') paginationBases.push({ file: relative(root, file), line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1, command: value.getText(ast), candidates, state: entryState });
    entries.push({
      file: relative(root, file), line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
      command: ts.isStringLiteralLike(value) ? value.text : value.getText(ast),
      root: commandRoot || null, candidates,
      state: entryState
    });
  });
}
const missing = entries.filter(entry => entry.state === 'missing-root');
const data = {
  note: 'Static command property inventory, including some non-bubble properties. Const aliases and both conditional branches are traced; any unresolved branch remains pending. A declared root proves only a matching registration exists; arguments, event scopes, permissions, execution and rendering are not verified. Dynamic builders require review.',
  roots: Object.fromEntries([...roots].sort(([a], [b]) => a.localeCompare(b))), paginationBases, entries
};
writeFileSync(join(root, 'docs/command-entry-audit.json'), JSON.stringify(data, null, 2) + '\n');
console.log(`${entries.length} command properties; ${roots.size} declared roots; ${missing.length} missing roots; ${entries.filter(entry => entry.state === 'dynamic-review-required').length} dynamic entries need review`);
if (missing.length) process.exitCode = 1;
