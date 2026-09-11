import { execFileSync } from 'node:child_process';

const staged = execFileSync('git', ['diff', '--cached', '--no-ext-diff', '--unified=0'], { encoding: 'utf8' });
const findings = [];
const highRiskPatterns = [
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/
];
const configuredCredential = /^\+[^+].*\b(?:password|secret|api[_-]?key|token)\b\s*[:=]\s*['"]?([^'"\s#]+)['"]?/i;
const safePlaceholder = /^(?:<[^>]+>|\$\{[^}]+\}|\*{3,}|example|placeholder)$/i;

for (const [index, line] of staged.split('\n').entries()) {
  if (!line.startsWith('+') || line.startsWith('+++')) {
    continue;
  }
  const value = line.slice(1);
  const credential = value.match(configuredCredential)?.[1];
  const explicitSecret = highRiskPatterns.some(pattern => pattern.test(value));

  if (explicitSecret || (credential && !safePlaceholder.test(credential))) {
    findings.push(index + 1);
  }
}

if (findings.length > 0) {
  console.error(`Refusing commit: possible credential material in staged diff (diff lines: ${findings.join(', ')}).`);
  console.error('Move the value to local secret storage, rotate it if it was exposed, then stage the sanitized change.');
  process.exit(1);
}
