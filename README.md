# Static MCP registry demo

A connector repo that generates a v0.1 MCP registry on every push and publishes it to GitHub Pages.
No server, no hosting, no secrets.

```
connectors/            source of truth: plugin.json + mcp.json per connector
generator/             build-registry.mjs — the only build step, Node stdlib only
test/verify.mjs        acceptance checks against the generated tree
.github/workflows/     generate -> verify -> publish to Pages -> curl the live site
```

## What happens on push

1. `build` generates `dist/registry` from `connectors/`, runs the acceptance checks and verifies
   the output is byte-identical on a second run.
2. `deploy` publishes `dist/registry` as the Pages site, so the site root **is** the registry root.
3. `smoke` curls the live URL, including the URL-encoded server path, and prints status lines and
   headers into the workflow log.

The generated tree is never committed — it is rebuilt from the connectors every time.

## Setup

1. Upload everything except `.github/` (drag and drop works; the generator accepts `mcp.json`
   as well as `.mcp.json`, so no dot-files are needed).
2. Create the workflow by hand: Add file -> Create new file -> name it
   `.github/workflows/registry.yml` and paste the contents of `registry-workflow.yml`.
   The web uploader skips dot-directories, so this one file has to be typed in.
3. Settings -> Pages -> Source: **GitHub Actions**.

## The registry URL

```
https://USER.github.io/REPO
```

Clients append `/v0.1/servers` themselves, so the configured URL carries no suffix.

## Try it

```bash
# list
curl -i --path-as-is "https://USER.github.io/REPO/v0.1/servers"

# one server — note the encoded slash in the name, which is what clients send
curl -i --path-as-is "https://USER.github.io/REPO/v0.1/servers/com.example%2Fmcp-ghec/versions/latest"
```

Change a version in `connectors/mcp-ghec/plugin.json`, push, and the live registry reflects it
after the workflow finishes.

## Fixtures

| Connector | Source shape | Result |
| --- | --- | --- |
| `mcp-prodcon` | OAuth, plain `url` | published, no headers |
| `mcp-ghec` | `Authorization: Bearer ${env:…}` | published, `isSecret: true` on the header |
| `mcp-elastic` | `${input:…}` + `inputs[]` | published, API key secret, cluster URL not secret |
| `mcp-local` | `command` (stdio) | skipped and logged |
| `mcp-private` | no opt-in flag | absent |

## Known limits of static hosting

- **`Content-Type` is wrong.** `text/html` on the list, `application/octet-stream` on the detail
  files, because Pages derives the type from the file extension and offers no way to set headers.
  Clients that parse the body regardless are unaffected.
- **`Allow-Methods` / `Allow-Headers` are absent** and `OPTIONS` isn't handled.
  `Access-Control-Allow-Origin: *` is returned automatically.
- **Query parameters are ignored.** The list is always complete, carries no `nextCursor`, and holds
  only the latest version of each server.

The shim variant serves this same tree with correct headers; see the separate shim demo.
