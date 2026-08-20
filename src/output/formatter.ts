import chalk from 'chalk';

export interface FormatOptions {
  json?: boolean;
  ndjson?: boolean;
}


export function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => (r[i] ?? '').length))
  );

  const sep = widths.map(w => '─'.repeat(w + 2)).join('┼');
  const headerLine = headers.map((h, i) => ` ${h.padEnd(widths[i])} `).join('│');
  const dataLines = rows.map(row =>
    row.map((cell, i) => ` ${(cell ?? '').padEnd(widths[i])} `).join('│')
  );

  return [
    chalk.bold(headerLine),
    sep,
    ...dataLines,
  ].join('\n');
}

export function info(msg: string): void {
  console.log(chalk.cyan('→'), msg);
}

export function success(msg: string): void {
  console.log(chalk.green('✓'), msg);
}

export function warn(msg: string): void {
  console.log(chalk.yellow('⚠'), msg);
}

export function error(msg: string): void {
  console.error(chalk.red('✗'), msg);
}
