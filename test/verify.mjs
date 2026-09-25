#!/usr/bin/env node
// Acceptance checks against the generated tree. Node stdlib only.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.argv[2] ?? 'dist/registry';
let failed = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : ' -> ' + detail}`);
  if (!cond) failed++;
};

const list = JSON.parse(readFileSync(join(ROOT, 'v0.1/servers.html'), 'utf8'));
const names = list.servers.map((e) => e.server.name);

check('opt-in respected: mcp-private absent', !names.includes('com.example/mcp-private'));
check('stdio connector skipped: mcp-local absent', !names.includes('com.example/mcp-local'));
check('three remote archetypes published', list.servers.length === 3, names.join(', '));
check('list carries no nextCursor', !('nextCursor' in (list.metadata ?? {})));
check('one entry per server (latest only)', new Set(names).size === names.length);

const all = [];
(function walk(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    statSync(p).isDirectory() ? walk(p) : all.push(p);
  }
})(ROOT);

const leaked = all.filter((f) => readFileSync(f, 'utf8').includes('${'));
check('no placeholder syntax left anywhere in the output', leaked.length === 0, leaked.join(', '));

const ghec = JSON.parse(readFileSync(join(ROOT, 'v0.1/servers/com.example/mcp-ghec/versions/latest'), 'utf8'));
check('PAT header flagged isSecret', ghec.server.remotes[0].headers[0].isSecret === true);

const es = JSON.parse(readFileSync(join(ROOT, 'v0.1/servers/com.example/mcp-elastic/versions/latest'), 'utf8'));
check('secret input flagged', es.server.remotes[0].headers[0].variables.es_api_key.isSecret === true);
check('non-secret input not flagged', es.server.remotes[0].variables.es_url.isSecret === false);

check('latest alias exists for every server',
  names.every((n) => existsSync(join(ROOT, 'v0.1/servers', n, 'versions/latest'))));
check('exact version file exists for every server',
  list.servers.every((e) => existsSync(join(ROOT, 'v0.1/servers', e.server.name, 'versions', e.server.version))));
check('list sibling file present (answers /v0.1/servers without a 301)',
  existsSync(join(ROOT, 'v0.1/servers.html')) && existsSync(join(ROOT, 'v0.1/servers')));

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
