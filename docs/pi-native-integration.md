# Native Pi integration

Agentbox reuses Pi 1.5.2 where the native APIs preserve the managed contract. This
is a migration of shared plumbing, not removal of Agentbox's security layer.

## MCP protocol client

`runtime/pi-mcp.mjs` now uses `@earendil-works/pi-mcp` **1.5.2** (`McpClient`,
`StdioTransport`, and `StreamableHttpTransport`). The separate
`@modelcontextprotocol/sdk` dependency is removed. `runtime/package-lock.json`
and `runtime/default.nix` pin the complete replacement dependency graph; no
package installation or dependency lifecycle scripts run at session startup.

The existing `settings.piConfig.mcpServers` configuration does not change. The
adapter still owns:

- the declarative runtime configuration, without loading user/project `mcp.json`;
- existing tool names, bounded discovery, per-server allow/deny patterns and
  fail-closed human/workflow approval;
- the minimal POSIX environment plus explicitly referenced variables, using the
  native stdio transport's `inheritEnv: false`;
- HTTPS/public-address checks, DNS pinning, same-origin redirect checks and
  response-size limits through the existing secure fetch implementation;
- absolute deadlines independent of progress notifications, cancellation,
  bounded output and idempotent shutdown;
- single-dispatch tool calls: no retries after authentication errors, expired
  sessions, server errors, dropped response streams or network failures.

Raw native `request()` calls retain managed pagination and progress limits.
Native `listTools()` would aggregate pages before those limits could be checked.
Background HTTP GET streams, resumption and authentication recovery are disabled.
After a failed call the managed connection is closed; another call does not
implicitly reconnect or repeat the operation.

Pi's stock MCP manager/UI is **not enabled**. The wrapper retains
`--no-extensions` and explicitly loads the managed extension. The stock manager
has different naming, configuration precedence, environment inheritance and
retry behavior. Adopting that manager requires a separate compatibility/security
change, not merely adding `-e builtin:mcp`.

## Skills

Ordinary `/skill:name args` input passes through to Pi's native skill expansion,
including frontmatter removal, source/relative-path guidance and argument
appending. Agentbox does not build a second expanded instruction block for these
skills. It still inspects the discovered skill to determine whether compatibility
handling is needed; it does not scan additional directories or bypass Pi trust.

The small compatibility adapter retains:

- literal `$ARGUMENTS` / `$ARGUMENT` replacement for Claude-derived skill bodies;
- `/skill:commit` delegation through the managed `simple-task` role;
- tab/newline argument separators, normalized into Pi's native space syntax;
- fail-closed file-read errors and guidance not to reread an embedded skill.

## Decisions: deliberately unchanged

The Browser Decisions adapter remains custom. The native classifier API does not
expose typed refusal results or cache-read/write token details, and its answer
parser does not reject every duplicate answer rejected by the managed adapter.
Removing the existing parser would change error handling and accounting.

The opt-in setting, bounded action menu, confidence threshold, per-action managed
policy checks, cancellation and handoff behavior are unchanged. This migration
does not enable codemode, `tool_search`, OAuth, or any new model/network access.

## Verification

From `agentbox/`, with Nix's `nix-command` and `flakes` features enabled:

```sh
nix build \
  'path:.#pi-agentbox-mcp-runtime' \
  'path:.#pi-mcp-runtime-test' \
  'path:.#pi-agentbox-extension-test' \
  'path:.#pi-policy-extension-test' \
  'path:.#pi-workflow-extension-test' \
  'path:.#pi-browser-extension-test' \
  --no-link --print-build-logs --no-update-lock-file
```

`pi-mcp-runtime-test` is the fast adapter/policy suite. The packaged
`pi-agentbox-mcp-runtime` check additionally requires and tests the actual native
dependency, including synthetic HTTP and stdio fixtures; it does not silently
skip those tests when the dependency is missing. No live server or credentials
are required.

For a local Node 22 run (22.19.0 or later):

```sh
(cd runtime && npm ci --ignore-scripts && npm test)
node --experimental-strip-types tests/pi-agentbox.ts
node --experimental-strip-types --test tests/browser-decisions.ts tests/pi-browser.ts
```

These verify local Agentbox, not `nix-config/`'s pinned Agentbox input. Build the
image separately and restart Pi processes when deploying; these commands do not
activate a host or container.
