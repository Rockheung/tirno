import type { Command } from 'commander';
import { buildSchema } from '../core/schema.js';

export function registerSchemaCommand(program: Command): void {
  program
    .command('schema')
    .description('Print the whole command tree as machine-readable JSON (The CLI Spec v0.3) — for agents and scripts, so nothing has to scrape --help')
    .option('--pretty', 'Indent the output')
    .action((opts) => {
      const schema = buildSchema(program);
      console.log(JSON.stringify(schema, null, opts.pretty ? 2 : 0));
    });
}
