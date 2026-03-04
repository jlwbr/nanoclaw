#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

function parseArgs(argv) {
  const args = {
    input: 'cloudflare/migration-export',
    output: 'cloudflare/migration-export/import.sql',
  };
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) continue;
    if (key === '--input') args.input = value;
    if (key === '--output') args.output = value;
  }
  return args;
}

function quote(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${String(value).replaceAll("'", "''")}'`;
}

function tableInsertSql(table, rows) {
  if (!rows.length) return '';
  const columns = Object.keys(rows[0]);
  const values = rows
    .map((row) => `(${columns.map((col) => quote(row[col])).join(', ')})`)
    .join(',\n');
  return `INSERT INTO ${table} (${columns.join(', ')}) VALUES\n${values};\n`;
}

function main() {
  const args = parseArgs(process.argv);
  const inputDir = path.resolve(args.input);
  const outputPath = path.resolve(args.output);

  const tableFiles = [
    'chats.json',
    'messages.json',
    'registered_groups.json',
    'sessions.json',
    'router_state.json',
    'scheduled_tasks.json',
    'task_run_logs.json',
  ];

  let sql = 'PRAGMA foreign_keys = ON;\nBEGIN TRANSACTION;\n';
  for (const file of tableFiles) {
    const fullPath = path.join(inputDir, file);
    if (!fs.existsSync(fullPath)) continue;
    const rows = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    const table = file.replace('.json', '');
    sql += tableInsertSql(table, rows);
  }
  sql += 'COMMIT;\n';

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, sql, 'utf8');
  console.log(`Wrote SQL: ${outputPath}`);
}

main();
