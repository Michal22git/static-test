#!/usr/bin/env node
// Builds a static MCP registry (v0.1) from connector manifests.
// Node stdlib only. Deterministic output. Supports --check.
//
//   node generator/build-registry.mjs            write dist/registry
//   node generator/build-registry.mjs --check     fail if output differs from disk
//   node generator/build-registry.mjs --out DIR   custom output directory

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';

const NAMESPACE = 'com.example';
const REPO_URL = 'https://github.com/example/connectors';
const WEBSITE_URL = 'https://example.invalid/connectors';
const SCHEMA = 'https://static.modelcontextprotocol.io/schemas/2025-12-18/server.schema.json';
const DESCRIPTION_MAX = 100;
const PUBLISHED_AT = '2026-01-01T00:00:00Z'; // fixed: build-time clocks break determinism

const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const outIdx = args.indexOf('--out');
const OUT = outIdx !== -1 ? args[outIdx + 1] : 'dist/registry';
const CONNECTORS = 'connectors';

const log = [];
const errors = [];

// ---------------------------------------------------------------- transform

/** ${env:VAR} / ${VAR} / ${input:VAR} -> {var} plus a variables descriptor. */
function externaliseSecrets(rawValue, inputsById) {
  const variables = {};
  const value = rawValue.replace(/\$\{(?:env:|input:)?([A-Za-z0-9_.-]+)\}/g, (_m, id) => {
    const key = id.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const declared = inputsById[id];
    variables[key] = {
      description: declared?.description ?? `Value for ${id}`,
      isRequired: true,
      // A declared input is secret only when marked password; an env var is assumed secret.
      isSecret: declared ? declared.password === true : true,
    };
    return `{${key}}`;
  });
  return { value, variables };
}

function toRemote(serverKey, def, inputsById) {
  if (!def.url) {
    log.push(`skip: ${serverKey} is a local (stdio) server, registry holds remotes only`);
    return null;
  }
  const type = def.type === 'sse' ? 'sse' : 'streamable-http';
  const url = externaliseSecrets(def.url, inputsById);
  const remote = { type, url: url.value };
  if (Object.keys(url.variables).length) remote.variables = url.variables;

  const headers = [];
  for (const name of Object.keys(def.headers ?? {}).sort()) {
    const h = externaliseSecrets(def.headers[name], inputsById);
    const entry = { name, value: h.value, isRequired: true };
    const anySecret = Object.values(h.variables).some((v) => v.isSecret);
    if (anySecret) entry.isSecret = true;
    if (Object.keys(h.variables).length) entry.variables = h.variables;
    headers.push(entry);
  }
  if (headers.length) remote.headers = headers;
  return remote;
}

function buildServer(dir) {
  const plugin = JSON.parse(readFileSync(join(CONNECTORS, dir, 'plugin.json'), 'utf8'));
  if (plugin.registry?.visualStudio?.publish !== true) return null; // opt-in, off by default

  // Accept either name: the dotted form is the convention, the plain one survives
  // GitHub's web uploader, which skips dot-files.
  const candidates = [join(CONNECTORS, dir, '.mcp.json'), join(CONNECTORS, dir, 'mcp.json')];
  const mcpPath = candidates.find(existsSync);
  if (!mcpPath) { errors.push(`${dir}: .mcp.json / mcp.json missing`); return null; }
  const mcp = JSON.parse(readFileSync(mcpPath, 'utf8'));

  const inputsById = Object.fromEntries((mcp.inputs ?? []).map((i) => [i.id, i]));
  const servers = mcp.mcpServers ?? mcp.servers ?? {};

  const remotes = [];
  for (const key of Object.keys(servers).sort()) {
    const r = toRemote(`${dir}/${key}`, servers[key], inputsById);
    if (r) remotes.push(r);
  }
  if (!remotes.length) return null; // nothing remote to publish

  if (!/^\d+\.\d+\.\d+$/.test(plugin.version ?? '')) {
    errors.push(`${dir}: version "${plugin.version}" is not an exact semver`);
    return null;
  }
  if ((plugin.description ?? '').length > DESCRIPTION_MAX) {
    errors.push(`${dir}: description is ${plugin.description.length} chars, limit is ${DESCRIPTION_MAX}`);
    return null;
  }

  // Fixed key order keeps the output byte-stable.
  return {
    $schema: SCHEMA,
    name: `${NAMESPACE}/${plugin.name}`,
    title: plugin.title ?? plugin.name,
    description: plugin.description ?? '',
    version: plugin.version,
    repository: { url: REPO_URL, source: 'github', subfolder: `connectors/${dir}` },
    websiteUrl: WEBSITE_URL,
    remotes,
  };
}

function withMeta(server) {
  return {
    server,
    _meta: {
      'io.modelcontextprotocol.registry/official': {
        status: 'active',
        isLatest: true,
        publishedAt: PUBLISHED_AT,
        updatedAt: PUBLISHED_AT,
      },
    },
  };
}

// ---------------------------------------------------------------- emit

const files = new Map(); // relative path -> content

function emit(path, obj) {
  files.set(path, JSON.stringify(obj, null, 2) + '\n');
}

function build() {
  const dirs = readdirSync(CONNECTORS).sort();
  const entries = [];
  for (const dir of dirs) {
    const server = buildServer(dir);
    if (server) entries.push(withMeta(server));
  }
  if (errors.length) {
    for (const e of errors) console.error(`error: ${e}`);
    process.exit(2);
  }

  // The list endpoint. A sibling .html file answers /v0.1/servers directly on GitHub Pages
  // while the directory of the same name still resolves the paths beneath it — no 301.
  // Static hosts ignore ?limit and ?cursor, so the list is always complete and carries no cursor.
  const list = { servers: entries, metadata: { count: entries.length } };
  emit('v0.1/servers.html', list);
  emit('v0.1/servers.json', list); // convenience copy, not part of the contract

  for (const entry of entries) {
    // Clients URL-encode the slash in the name; GitHub Pages decodes %2F, so plain
    // nested directories are what actually serves those requests.
    const base = `v0.1/servers/${entry.server.name}`;
    const versionList = { servers: [entry], metadata: { count: 1 } };
    emit(`${base}/versions.html`, versionList);
    emit(`${base}/versions/latest`, entry);
    emit(`${base}/versions/${entry.server.version}`, entry);
  }
  return entries.length;
}

function writeAll() {
  rmSync(OUT, { recursive: true, force: true }); // full regenerate: removed connectors disappear
  for (const [rel, content] of [...files].sort()) {
    const abs = join(OUT, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

function checkAll() {
  const drift = [];
  for (const [rel, content] of [...files].sort()) {
    const abs = join(OUT, rel);
    if (!existsSync(abs)) { drift.push(`missing: ${rel}`); continue; }
    if (readFileSync(abs, 'utf8') !== content) drift.push(`differs: ${rel}`);
  }
  return drift;
}

const count = build();
for (const line of log) console.log(line);

if (CHECK) {
  const drift = checkAll();
  if (drift.length) {
    console.error('registry output is stale:');
    for (const d of drift) console.error('  ' + d);
    process.exit(1);
  }
  console.log(`--check: up to date (${count} servers, ${files.size} files)`);
} else {
  writeAll();
  console.log(`wrote ${files.size} files for ${count} servers to ${OUT}/`);
}
