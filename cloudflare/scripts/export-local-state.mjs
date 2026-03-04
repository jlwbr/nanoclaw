#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

function parseArgs(argv) {
  const args = {
    db: 'store/messages.db',
    out: 'cloudflare/migration-export',
    tenantId: 'legacy-tenant',
  };
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) continue;
    if (key === '--db') args.db = value;
    if (key === '--out') args.out = value;
    if (key === '--tenant-id') args.tenantId = value;
  }
  return args;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function safeSelect(db, sql) {
  try {
    return db.prepare(sql).all();
  } catch {
    return [];
  }
}

function exportDbRows(db, outDir, tenantId) {
  const tables = {
    chats: 'SELECT * FROM chats',
    messages: 'SELECT * FROM messages',
    registered_groups: 'SELECT * FROM registered_groups',
    sessions: 'SELECT * FROM sessions',
    router_state: 'SELECT * FROM router_state',
    scheduled_tasks: 'SELECT * FROM scheduled_tasks',
    task_run_logs: 'SELECT * FROM task_run_logs',
  };

  const exported = {};
  for (const [table, sql] of Object.entries(tables)) {
    const rows = safeSelect(db, sql).map((row) => ({
      tenant_id: tenantId,
      ...row,
    }));
    exported[table] = rows;
    writeJson(path.join(outDir, `${table}.json`), rows);
  }

  return exported;
}

function copyGroups(outDir) {
  const groupsDir = path.resolve('groups');
  if (!fs.existsSync(groupsDir)) return [];

  const manifest = [];
  for (const groupFolder of fs.readdirSync(groupsDir)) {
    const src = path.join(groupsDir, groupFolder);
    if (!fs.statSync(src).isDirectory()) continue;
    const files = fs.readdirSync(src);
    manifest.push({ groupFolder, files });
    const dst = path.join(outDir, 'groups', groupFolder);
    ensureDir(dst);
    for (const name of files) {
      const srcFile = path.join(src, name);
      const dstFile = path.join(dst, name);
      if (fs.statSync(srcFile).isFile()) {
        fs.copyFileSync(srcFile, dstFile);
      }
    }
  }
  writeJson(path.join(outDir, 'groups-manifest.json'), manifest);
  return manifest;
}

function main() {
  const args = parseArgs(process.argv);
  const dbPath = path.resolve(args.db);
  const outDir = path.resolve(args.out);
  ensureDir(outDir);

  if (!fs.existsSync(dbPath)) {
    console.error(`Database not found: ${dbPath}`);
    process.exit(1);
  }

  const db = new Database(dbPath, { readonly: true });
  const exported = exportDbRows(db, outDir, args.tenantId);
  const groups = copyGroups(outDir);
  db.close();

  writeJson(path.join(outDir, 'summary.json'), {
    tenantId: args.tenantId,
    tables: Object.fromEntries(
      Object.entries(exported).map(([name, rows]) => [name, rows.length]),
    ),
    groups: groups.length,
    generatedAt: new Date().toISOString(),
  });

  console.log(`Export complete: ${outDir}`);
}

main();
