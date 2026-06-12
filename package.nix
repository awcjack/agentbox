# Agentbox - CLI for Nix OCI container management
#
# This package provides a CLI to manage the agentbox OCI container.
# The container is managed via systemd (docker-agentbox.service).
{
  lib,
  stdenvNoCC,
  writeShellScriptBin,
}:

let
  # Script to manage agentbox OCI container
  agentboxScript = writeShellScriptBin "agentbox" ''
        #!/usr/bin/env bash
        set -euo pipefail

        CONTAINER_NAME="agentbox"

        usage() {
          cat <<EOF
    Agentbox - Nix OCI container CLI

    Usage: agentbox <command> [options]

    Commands:
      status      Show container status
      logs        Show container logs (use -f to follow)
      shell       Open a tmux shell as agent user
      root        Open a shell as root user
      exec        Execute a command in the container
      opencode    Start opencode in a tmux session
      restart     Restart the container service
      stop        Stop the container service
      start       Start the container service

    Examples:
      agentbox shell                    # Interactive tmux shell as agent
      agentbox exec ls -la              # Run command in container
      agentbox logs -f                  # Follow container logs
      agentbox opencode                 # Start opencode in tmux

    The container is managed by systemd (docker-$CONTAINER_NAME.service).
    EOF
        }

        ensure_running() {
          if ! docker ps --format '{{.Names}}' | grep -q "^$CONTAINER_NAME$"; then
            echo "Error: Container '$CONTAINER_NAME' is not running."
            echo "Start it with: agentbox start"
            exit 1
          fi
        }

        cmd_status() {
          echo "=== Container Status ==="
          docker ps -a --filter "name=^$CONTAINER_NAME$" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
          echo ""
          echo "=== Service Status ==="
          systemctl status "docker-$CONTAINER_NAME.service" --no-pager 2>/dev/null || \
            systemctl status "podman-$CONTAINER_NAME.service" --no-pager 2>/dev/null || \
            echo "Service not found"
        }

        cmd_logs() {
          ensure_running
          docker logs "''${@}" "$CONTAINER_NAME"
        }

        cmd_shell() {
          ensure_running
          # Check if tmux session exists, attach if so, otherwise create new one
          if docker exec -u agent "$CONTAINER_NAME" tmux has-session -t shell 2>/dev/null; then
            docker exec -it -u agent -w /workspace "$CONTAINER_NAME" tmux attach-session -t shell
          else
            docker exec -it -u agent -w /workspace "$CONTAINER_NAME" tmux new-session -s shell
          fi
        }

        cmd_root() {
          ensure_running
          docker exec -it -w /workspace "$CONTAINER_NAME" bash -l
        }

        cmd_exec() {
          ensure_running
          docker exec -it -u agent -w /workspace "$CONTAINER_NAME" "''${@}"
        }

        cmd_opencode() {
          ensure_running
          # Check if tmux session exists with opencode, attach if so, otherwise create new one
          if docker exec -u agent "$CONTAINER_NAME" tmux has-session -t opencode 2>/dev/null; then
            docker exec -it -u agent -w /workspace "$CONTAINER_NAME" tmux attach-session -t opencode
          else
            docker exec -it -u agent -w /workspace "$CONTAINER_NAME" tmux new-session -s opencode opencode
          fi
        }

        cmd_restart() {
          echo "Restarting agentbox service..."
          sudo systemctl restart "docker-$CONTAINER_NAME.service" 2>/dev/null || \
            sudo systemctl restart "podman-$CONTAINER_NAME.service" 2>/dev/null || \
            { echo "Error: Could not restart service"; exit 1; }
          echo "Service restarted."
        }

        cmd_stop() {
          echo "Stopping agentbox service..."
          sudo systemctl stop "docker-$CONTAINER_NAME.service" 2>/dev/null || \
            sudo systemctl stop "podman-$CONTAINER_NAME.service" 2>/dev/null || \
            { echo "Error: Could not stop service"; exit 1; }
          echo "Service stopped."
        }

        cmd_start() {
          echo "Starting agentbox service..."
          sudo systemctl start "docker-$CONTAINER_NAME.service" 2>/dev/null || \
            sudo systemctl start "podman-$CONTAINER_NAME.service" 2>/dev/null || \
            { echo "Error: Could not start service"; exit 1; }
          echo "Service started."
        }

        case "''${1:-help}" in
          status)   cmd_status ;;
          logs)     shift; cmd_logs "$@" ;;
          shell)    cmd_shell ;;
          root)     cmd_root ;;
          exec)     shift; cmd_exec "$@" ;;
          opencode) cmd_opencode ;;
          restart)  cmd_restart ;;
          stop)     cmd_stop ;;
          start)    cmd_start ;;
          help|--help|-h) usage ;;
          *) echo "Unknown command: $1"; usage; exit 1 ;;
        esac
  '';

in
stdenvNoCC.mkDerivation {
  pname = "agentbox";
  version = "0.3.0";

  dontUnpack = true;
  dontBuild = true;

  installPhase = ''
    runHook preInstall
    mkdir -p $out/bin
    cp ${agentboxScript}/bin/agentbox $out/bin/agentbox
    chmod +x $out/bin/agentbox
    runHook postInstall
  '';

  meta = with lib; {
    description = "CLI for managing agentbox Nix OCI container";
    license = licenses.mit;
    maintainers = [ ];
    platforms = platforms.linux;
  };
}
