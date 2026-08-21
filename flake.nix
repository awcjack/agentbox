{
  description = "Agentbox — self-contained AI coding-agent sandbox (Nix OCI image + NixOS / nix-darwin modules)";

  # Ships the sandbox with Claude Code, Codex, OpenCode and Pi; any further
  # agents are NOT inputs here — a consumer bakes their own builds in via
  # `.override` (see README.md).
  #
  # Pinned to 26.05 because the image closure includes google-cloud-sdk +
  # gke-gcloud-auth-plugin, whose prebuilt component archive Google prunes for
  # older SDK releases; 26.05's gcloud is recent enough that it still resolves.
  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-26.05";
    # Pi evolves quickly and the release channel can lag far enough to break
    # provider authentication. Keep only Pi on current nixpkgs.
    nixpkgs-unstable.url = "github:nixos/nixpkgs/nixos-unstable";
  };

  outputs =
    {
      self,
      nixpkgs,
      nixpkgs-unstable,
    }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      pkgsFor =
        system:
        import nixpkgs {
          inherit system;
          config.allowUnfree = true; # google-cloud-sdk is unfree
        };
      piPackageFor = system: nixpkgs-unstable.legacyPackages.${system}.pi-coding-agent;
      packageSetFor =
        system:
        import ./packages.nix {
          pkgs = pkgsFor system;
          pi-coding-agent = piPackageFor system;
        };
    in
    {
      # Adds `agentbox`, `agentbox-neovim`, `agentboxImage` to a pkgs set. The
      # modules below default `package`/`image` to these, so a consumer just
      # needs this overlay on their nixpkgs.
      overlays.default =
        final: _prev:
        import ./packages.nix {
          pkgs = final;
          pi-coding-agent = piPackageFor final.stdenv.hostPlatform.system;
        };

      # Direct builds: `nix build .#agentboxImage`, `nix build .#agentbox`.
      packages = forAllSystems packageSetFor;

      # Platform modules. Both import the shared option schema from
      # ./modules/common-options.nix and add only their platform-specific
      # top-level options + config. `.default` is the conventional attr;
      # `.agentbox` is a friendlier alias.
      #
      # This is the clean standalone sandbox: Claude Code + Codex + OpenCode + Pi, no private
      # agents bundled. Advanced users can still bake extra agents into the
      # image via .override and wire them through the generic extension surface
      # (services.agentbox.extraEnvironment / extraVolumes / extraActivation).
      nixosModules.agentbox = ./modules/nixos.nix;
      nixosModules.default = self.nixosModules.agentbox;

      darwinModules.agentbox = ./modules/darwin.nix;
      darwinModules.default = self.darwinModules.agentbox;

      # Convenience builder for an image with extra agents baked in:
      #   agentbox.lib.mkAgentboxImage {
      #     pkgs = pkgs;
      #     my-agent = myAgentPackage;
      #   }
      # Equivalent to `pkgs.agentboxImage.override { … }` once the overlay is on.
      lib.mkAgentboxImage =
        { pkgs, ... }@args:
        pkgs.callPackage ./image.nix (
          {
            pi-coding-agent = piPackageFor pkgs.stdenv.hostPlatform.system;
          }
          // builtins.removeAttrs args [ "pkgs" ]
        );

      formatter = forAllSystems (system: (pkgsFor system).nixfmt-rfc-style);
    };
}
