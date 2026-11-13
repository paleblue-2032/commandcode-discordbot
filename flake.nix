{
  description = "Command Code Discord bot";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f (import nixpkgs { inherit system; }));
    in
    {
      packages = forAllSystems (pkgs: {
        default = pkgs.buildNpmPackage {
          pname = "commandcode-discordbot";
          version = "0.1.0";
          src = ./.;
          nodejs = pkgs.nodejs_22;
          npmDepsHash = "sha256-QVEUV0s/0M9g+MLjGXTezQlpmkqRtdVFc0gScl/yefs=";
          npmBuildScript = "build";
          nativeBuildInputs = [ pkgs.makeWrapper ];
          installPhase = ''
            runHook preInstall
            mkdir -p $out/lib/commandcode-discordbot
            cp -a dist node_modules package.json $out/lib/commandcode-discordbot/
            mkdir -p $out/bin
            makeWrapper ${pkgs.nodejs_22}/bin/node $out/bin/commandcode-discordbot \
              --add-flags "$out/lib/commandcode-discordbot/dist/index.js"
            runHook postInstall
          '';
        };
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_22
            pkgs.git
          ];
        };
      });

      apps = forAllSystems (pkgs: {
        default = {
          type = "app";
          program = "${self.packages.${pkgs.system}.default}/bin/commandcode-discordbot";
        };
      });
    };
}
