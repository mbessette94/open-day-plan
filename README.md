# open-day-plan

An Electron application with React and TypeScript

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

## Project Setup

### Install

```bash
$ npm install
```

### Development

```bash
$ npm run dev
```

### Build

```bash
# For windows
$ npm run build:win

# For macOS
$ npm run build:mac

# For Linux
$ npm run build:linux
```

## Run with Nix

```sh
nix run github:mbessette94/open-day-plan --
```

As an alias:

```sh
alias open-day-plan='nix run github:mbessette94/open-day-plan --'
```

The flake builds the app and runs it with nixpkgs' Electron. Your data lives in
`~/Library/Application Support/open-day-plan` (macOS), the same place `npm run dev` uses.
Pass Electron flags after `--`, e.g. `--user-data-dir=/some/folder` to try it without touching your data.

`opendayplan://` links and "launch at login" only work in a packaged build (`npm run build:unpack`),
not under `nix run`, because they need the app's own Info.plist.

After changing dependencies, refresh the hash in `flake.nix`:

```sh
nix run nixpkgs#prefetch-npm-deps -- package-lock.json
```
