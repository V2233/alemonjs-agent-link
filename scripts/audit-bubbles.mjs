// Enumerate source sites, including shared renderers and non-command delivery.
// This is a review inventory, never a claim that runtime branches were exercised.
import ts from 'typescript';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
const root = process.cwd();
const walk = dir =>
  readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : /\.tsx?$/u.test(entry.name) ? [join(dir, entry.name)] : []
  );
const sites = [];
const digest = path => (existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null);
const ledgerPath = join(root, 'docs/bubble-review.json');
const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : { files: {} };
const evidence = Object.fromEntries(
  Object.entries(ledger.files).map(([file, entry]) => [
    file,
    {
      ...entry,
      evidenceState:
        digest(join(root, file)) === entry.sourceHash && Object.entries(entry.tests).every(([test, hash]) => digest(join(root, test)) === hash)
          ? 'current-partial'
          : 'stale'
    }
  ])
);
for (const file of walk(join(root, 'src')).sort()) {
  const text = readFileSync(file, 'utf8');
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const visit = node => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(ast);
      const kind = /^(commandBubble|noticeBubble|sectionBubble|detailBubbles)$/u.test(callee)
        ? 'bubble'
        : /\.(send|reply|sendToTarget)$/u.test(callee)
          ? 'delivery'
          : /^(reply|send)$/u.test(callee)
            ? 'local-reply'
            : /\.(addText|addMarkdown|addMarkdownOriginal|createMarkdown|addButtonGroup|createButtonGroup)$/u.test(callee)
              ? 'format'
              : null;
      if (kind)
        sites.push({
          file: relative(root, file),
          line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
          kind,
          callee,
          preview: node.arguments
            .map(arg => arg.getText(ast))
            .join(', ')
            .slice(0, 240),
          review: 'pending'
        });
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
}
const data = {
  scope: 'All src TypeScript files; attached xiuxian-simulator is reference only',
  note: 'Static inventory includes non-user network sends; classify each site. File evidence is partial, hash-bound and never implies that all branches or QQ client display passed.',
  evidence,
  sites
};
writeFileSync(join(root, 'docs/bubble-audit.json'), JSON.stringify(data, null, 2) + '\n');
console.log(`${sites.length} sites across ${new Set(sites.map(site => site.file)).size} files; runtime review pending`);
