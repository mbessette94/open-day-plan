{
  description = "Open Day Plan: a simple, opinionated day planner (Electron + SQLite)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (
        pkgs:
        let
          inherit (pkgs) lib;
          pkg = builtins.fromJSON (builtins.readFile ./package.json);
        in
        {
          default = pkgs.buildNpmPackage {
            pname = pkg.name;
            version = pkg.version;

            src = lib.cleanSourceWith {
              src = ./.;
              filter =
                path: type:
                !(builtins.elem (baseNameOf path) [
                  "node_modules"
                  "out"
                  "dist"
                  "result"
                  ".git"
                  ".eslintcache"
                ])
                && lib.cleanSourceFilter path type;
            };

            # Update with: nix run nixpkgs#prefetch-npm-deps -- package-lock.json
            npmDepsHash = "sha256-TE7D9c5lbgjvSSgDEI+fXu793/s/w4/mr9v+DOkb3ys=";

            # No install scripts: electron would try to download its binary (we use nixpkgs'
            # electron) and better-sqlite3 ships portable N-API prebuilds, so nothing needs compiling.
            npmFlags = [ "--ignore-scripts" ];
            npmRebuildFlags = [ "--ignore-scripts" ];
            env.ELECTRON_SKIP_BINARY_DOWNLOAD = "1";

            nativeBuildInputs = [ pkgs.makeWrapper ];

            # leave the better-sqlite3 prebuilds (linux ELF files included) exactly as shipped
            dontPatchELF = true;
            dontStrip = true;

            buildPhase = ''
              runHook preBuild
              npx --no-install electron-vite build
              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall
              npm prune --omit=dev --ignore-scripts
              mkdir -p $out/lib/${pkg.name} $out/bin
              cp -r out resources package.json node_modules $out/lib/${pkg.name}/
              makeWrapper ${lib.getExe pkgs.electron} $out/bin/${pkg.name} \
                --add-flags "$out/lib/${pkg.name}" \
                ${lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''--add-flags "--ozone-platform-hint=auto --enable-features=WaylandWindowDecorations"''}
              runHook postInstall
            '';

            meta = {
              description = "A simple, opinionated day planner";
              mainProgram = pkg.name;
              platforms = systems;
            };
          };
        }
      );

      apps = forAllSystems (pkgs: {
        default = {
          type = "app";
          program = "${self.packages.${pkgs.stdenv.hostPlatform.system}.default}/bin/open-day-plan";
        };
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell { packages = [ pkgs.nodejs ]; };
      });
    };
}
