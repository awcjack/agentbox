{
  description = "Agentbox — self-contained AI coding-agent sandbox (Nix OCI image + NixOS / nix-darwin modules)";

  # Deliberately depends on nothing but nixpkgs. Ships the sandbox with Claude
  # Code, Codex and OpenCode; any further agents are NOT inputs here — a consumer
  # bakes their own builds in via `.override` (see README.md). Keeping them out
  # is what makes this flake standalone.
  #
  # Pinned to 26.05 because the image closure includes google-cloud-sdk +
  # gke-gcloud-auth-plugin, whose prebuilt component archive Google prunes for
  # older SDK releases; 26.05's gcloud is recent enough that it still resolves.
  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-26.05";
  };

  outputs =
    { self, nixpkgs }:
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
    in
    {
      # Adds `agentbox`, `agentbox-neovim`, `agentboxImage` to a pkgs set. The
      # modules below default `package`/`image` to these, so a consumer just
      # needs this overlay on their nixpkgs.
      overlays.default = final: _prev: import ./packages.nix { pkgs = final; };

      # Direct builds: `nix build .#agentboxImage`, `nix build .#agentbox`.
      packages = forAllSystems (system: import ./packages.nix { pkgs = pkgsFor system; });

      # Platform modules. Both import the shared option schema from
      # ./modules/common-options.nix and add only their platform-specific
      # top-level options + config. `.default` is the conventional attr;
      # `.agentbox` is a friendlier alias.
      #
      # This is the clean standalone sandbox: Claude Code + Codex, no private
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
        { pkgs, ... }@args: pkgs.callPackage ./image.nix (builtins.removeAttrs args [ "pkgs" ]);

      formatter = forAllSystems (system: (pkgsFor system).nixfmt-rfc-style);
    };
}
