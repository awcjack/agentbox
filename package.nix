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
      pi          Start Pi in a tmux session
      pi-web      Show the Pi browser interface URL
      pi-rpc      Show and check the Pi RPC API endpoint
      claude      Attach to the Claude Code tmux session (starts it if needed)
      restart     Restart the container service
      stop        Stop the container service
      start       Start the container service
      pause       Freeze container processes without losing tmux sessions
      resume      Resume a paused container
      service     List all services or manage an on-demand service

    Examples:
      agentbox shell                    # Interactive tmux shell as agent
      agentbox exec ls -la              # Run command in container
      agentbox logs -f                  # Follow container logs
      agentbox opencode                 # Start opencode in tmux
      agentbox pi                       # Start Pi in tmux
      agentbox pi-web                   # Show Pi browser URL
      agentbox pi-rpc                   # Check Pi RPC API health
      agentbox claude                   # Attach to Claude Code in tmux
      agentbox service start my-service # Start a configured on-demand service
      agentbox pause                    # Freeze Agentbox during a short break
      agentbox resume                   # Continue a paused Agentbox

    The container is managed by systemd (docker-$CONTAINER_NAME.service).
    EOF
        }

        ensure_running() {
          local state
          state=$(docker inspect --format '{{.State.Status}}' "$CONTAINER_NAME" 2>/dev/null || true)
          case "$state" in
            running) ;;
            paused)
              echo "Error: Container '$CONTAINER_NAME' is paused."
              echo "Resume it with: agentbox resume"
              exit 1
              ;;
            *)
              echo "Error: Container '$CONTAINER_NAME' is not running."
              echo "Start it with: agentbox start"
              exit 1
              ;;
          esac
        }

        validate_service_name() {
          case "''${1:-}" in
            ""|*[!A-Za-z0-9._-]*)
              echo "Error: Service names may contain only letters, digits, '.', '_' and '-'." >&2
              exit 2
              ;;
          esac
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

        cmd_claude() {
          ensure_running
          # ENABLE_CLAUDE_CODE=true starts a detached 'claude' session at boot;
          # attach to that one so the headless and interactive views share a
          # single process. Create it on demand when the boot start is disabled.
          if docker exec -u agent "$CONTAINER_NAME" tmux has-session -t claude 2>/dev/null; then
            docker exec -it -u agent -w /workspace "$CONTAINER_NAME" tmux attach-session -t claude
          else
            docker exec -it -u agent -w /workspace "$CONTAINER_NAME" \
              tmux new-session -s claude claude --dangerously-skip-permissions
          fi
        }

        cmd_pi() {
          ensure_running
          if docker exec -u agent "$CONTAINER_NAME" tmux has-session -t pi 2>/dev/null; then
            docker exec -it -u agent -w /workspace "$CONTAINER_NAME" tmux attach-session -t pi
          else
            docker exec -it -u agent -w /workspace "$CONTAINER_NAME" tmux new-session -s pi pi
          fi
        }

        cmd_pi_web() {
          ensure_running
          echo "Pi web interface: http://localhost:4097"
          echo "Basic Auth username: pi"
        }

        cmd_pi_rpc() {
          ensure_running
          local port
          port=$(docker exec "$CONTAINER_NAME" bash -c 'printf %s "''${PI_RPC_PORT:-4098}"')
          echo "Pi RPC API: http://localhost:$port"
          if ! docker exec "$CONTAINER_NAME" curl -fsS "http://127.0.0.1:$port/health/ready"; then
            echo "Pi RPC API is not enabled or healthy." >&2
            return 1
          fi
          echo
        }

        cmd_restart() {
          echo "Restarting agentbox service..."
          sudo systemctl restart "docker-$CONTAINER_NAME.service" 2>/dev/null || \
            sudo systemctl restart "podman-$CONTAINER_NAME.service" 2>/dev/null || \
            { echo "Error: Could not restart service"; exit 1; }
          echo "Service restarted."
        }

        stop_docker_if_unused() {
          if ! systemctl is-active --quiet docker.service; then
            return
          fi

          local running
          running=$(docker ps --format '{{.Names}}')
          if [ -n "$running" ]; then
            echo "Docker remains active because other containers are running:"
            while IFS= read -r container; do
              printf '  %s\n' "$container"
            done <<< "$running"
            return
          fi

          echo "No Docker containers remain; stopping docker.service and docker.socket..."
          sudo systemctl stop docker.service docker.socket
        }

        cmd_stop() {
          echo "Stopping agentbox service..."
          if sudo systemctl stop "docker-$CONTAINER_NAME.service" 2>/dev/null; then
            stop_docker_if_unused
          elif sudo systemctl stop "podman-$CONTAINER_NAME.service" 2>/dev/null; then
            : # Podman is daemonless; there is no backend service to stop.
          else
            echo "Error: Could not stop service"
            exit 1
          fi
          echo "Service stopped."
        }

        cmd_start() {
          echo "Starting agentbox service..."
          sudo systemctl start "docker-$CONTAINER_NAME.service" 2>/dev/null || \
            sudo systemctl start "podman-$CONTAINER_NAME.service" 2>/dev/null || \
            { echo "Error: Could not start service"; exit 1; }
          echo "Service started."
        }

        cmd_pause() {
          local state
          state=$(docker inspect --format '{{.State.Status}}' "$CONTAINER_NAME" 2>/dev/null || true)
          case "$state" in
            running) ;;
            paused)
              echo "Agentbox is already paused."
              return
              ;;
            *)
              echo "Error: Container '$CONTAINER_NAME' is not running."
              echo "Start it with: agentbox start"
              exit 1
              ;;
          esac
          echo "Pausing Agentbox..."
          docker pause "$CONTAINER_NAME" >/dev/null
          if docker inspect agentbox-docker-proxy >/dev/null 2>&1; then
            docker pause agentbox-docker-proxy >/dev/null 2>&1 || true
          fi
          echo "Agentbox paused. Resume it with: agentbox resume"
        }

        cmd_resume() {
          local state
          state=$(docker inspect --format '{{.State.Status}}' "$CONTAINER_NAME" 2>/dev/null || true)
          case "$state" in
            paused)
              if [ "$(docker inspect --format '{{.State.Status}}' agentbox-docker-proxy 2>/dev/null || true)" = "paused" ]; then
                docker unpause agentbox-docker-proxy >/dev/null
              fi
              docker unpause "$CONTAINER_NAME" >/dev/null
              echo "Agentbox resumed."
              ;;
            running)
              echo "Agentbox is already running."
              ;;
            *)
              echo "Error: Container '$CONTAINER_NAME' is not paused or running."
              echo "Start it with: agentbox start"
              exit 1
              ;;
          esac
        }

        cmd_service() {
          local action="''${1:-list}"
          local name="''${2:-}"
          local boot_dir="/home/agent/.agentbox/boot.d"
          local service_dir="/home/agent/.agentbox/on-demand.d"

          ensure_running
          if [ "$action" = "list" ]; then
            local service_name startup status script
            printf '%-32s %-12s %s\n' "SERVICE" "STARTUP" "STATUS"
            while IFS=$'\t' read -r startup service_name; do
              [ -n "$service_name" ] || continue
              case "$startup" in
                boot)
                  script="$boot_dir/$service_name.sh"
                  if docker exec -u agent "$CONTAINER_NAME" bash -lc \
                    'target="$1"; while IFS= read -r command; do [ "$command" = "bash -l $target" ] && exit 0; done < <(ps -C bash -o args=); exit 1' \
                    bash "$script"; then
                    status="active"
                  else
                    status="inactive"
                  fi
                  ;;
                on-demand)
                  if docker exec -u agent "$CONTAINER_NAME" \
                    tmux has-session -t "service-$service_name" 2>/dev/null; then
                    status="active"
                  else
                    status="inactive"
                  fi
                  ;;
              esac
              printf '%-32s %-12s %s\n' "$service_name" "$startup" "$status"
            done < <(
              docker exec -u agent "$CONTAINER_NAME" bash -lc \
                "for script in $boot_dir/*.sh; do [ -f \"\$script\" ] || continue; printf 'boot\\t%s\\n' \"\$(basename \"\$script\" .sh)\"; done; for script in $service_dir/*.sh; do [ -f \"\$script\" ] || continue; printf 'on-demand\\t%s\\n' \"\$(basename \"\$script\" .sh)\"; done"
            )
            return
          fi

          validate_service_name "$name"
          local script="$service_dir/$name.sh"
          local session="service-$name"
          if ! docker exec -u agent "$CONTAINER_NAME" test -x "$script"; then
            echo "Error: Unknown on-demand service '$name'." >&2
            echo "Available services:" >&2
            cmd_service list >&2
            exit 1
          fi

          case "$action" in
            start)
              if docker exec -u agent "$CONTAINER_NAME" tmux has-session -t "$session" 2>/dev/null; then
                echo "Service '$name' is already running."
              else
                docker exec -u agent -w /workspace "$CONTAINER_NAME" \
                  tmux new-session -d -s "$session" "exec bash -l $script"
                echo "Service '$name' started."
              fi
              ;;
            stop)
              if docker exec -u agent "$CONTAINER_NAME" tmux has-session -t "$session" 2>/dev/null; then
                docker exec -u agent "$CONTAINER_NAME" tmux kill-session -t "$session"
                echo "Service '$name' stopped."
              else
                echo "Service '$name' is not running."
              fi
              ;;
            restart)
              docker exec -u agent "$CONTAINER_NAME" tmux kill-session -t "$session" 2>/dev/null || true
              docker exec -u agent -w /workspace "$CONTAINER_NAME" \
                tmux new-session -d -s "$session" "exec bash -l $script"
              echo "Service '$name' restarted."
              ;;
            status)
              if docker exec -u agent "$CONTAINER_NAME" tmux has-session -t "$session" 2>/dev/null; then
                echo "Service '$name' is running."
              else
                echo "Service '$name' is stopped."
                return 3
              fi
              ;;
            *)
              echo "Usage: agentbox service {list|start|stop|restart|status} [name]" >&2
              exit 2
              ;;
          esac
        }

        case "''${1:-help}" in
          status)   cmd_status ;;
          logs)     shift; cmd_logs "$@" ;;
          shell)    cmd_shell ;;
          root)     cmd_root ;;
          exec)     shift; cmd_exec "$@" ;;
          opencode) cmd_opencode ;;
          pi)       cmd_pi ;;
          pi-web)   cmd_pi_web ;;
          pi-rpc)   cmd_pi_rpc ;;
          claude)   cmd_claude ;;
          restart)  cmd_restart ;;
          stop)     cmd_stop ;;
          start)    cmd_start ;;
          pause)    cmd_pause ;;
          resume)   cmd_resume ;;
          service)  shift; cmd_service "$@" ;;
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
