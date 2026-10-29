# Portable folder/session API and frontend checks. The full runtime check also
# covers Linux procfs history storage; keep these usable on macOS consumers.
{ pkgs }:
pkgs.runCommand "agentbox-pi-workspace-test"
  {
    nativeBuildInputs = [ pkgs.nodejs_22 ];
    __darwinAllowLocalNetworking = true;
  }
  ''
    cp -r ${./.}/. .
    chmod -R u+w .
    node --check runtime.mjs
    node --check web/app.mjs
    node --test test/folders.test.mjs web/*.test.mjs
    node --test --test-name-pattern='folder sessions|session folder creation|saved history archive' test/runtime.test.mjs
    touch $out
  ''
