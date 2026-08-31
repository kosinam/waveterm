# WaveTerm Agent Guide

## Workflows

- Use Node.js 22, Go 1.25.6, and Task. Bootstrap all root and docs dependencies with `task init`.
- Use Taskfile targets for builds, generation, and packaging; do not run raw `go build` in arbitrary packages.
- Run the full hot-reload app with `task dev` (`task electron:dev`). `task electron:quickdev` is macOS arm64-only and intentionally skips code generation and `wsh`.
- Use `task preview` for the standalone component preview at `http://localhost:7007`; root `npx vite`, `npm run dev`, and `npm run start` launch or configure the Electron app instead.
- Type-check with `task check:ts`. Run focused frontend tests from the repository root with `npx vitest run path/to/test.ts`; run focused Go tests from the root with `go test ./path/to/package`.
- `docs/` is a separate Docusaurus package (`task docsite`); `tsunami/` is a separate Go module with its own frontend package.

## Architecture And Generation

- Electron main-process entrypoint: `emain/emain.ts`; React renderer: `frontend/`; Go server: `cmd/server/main-server.go`; `wsh` CLI: `cmd/wsh/main-wsh.go`.
- Frontend, Electron, the Go backend, and remote systems communicate through WSH RPC. RPC command types originate in `pkg/wshrpc/wshrpctypes.go` and server handlers live in `pkg/wshrpc/wshserver/`.
- Never manually edit generated `frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts`, or `frontend/app/store/services.ts`. Change their Go sources and run `task generate` after changes to RPC types, `pkg/wconfig/settingsconfig.go`, or `pkg/waveobj/wtypemeta.go`.
- Read the relevant `.kilocode/skills/*/SKILL.md` before adding configuration, RPC, a `wsh` command, an Electron API, a view, a context menu, WaveEnv narrowing, or WPS events.

## Local Conventions

- Use `@/...` imports across frontend directories and relative imports only within the same directory. Use named exports.
- TypeScript has strict null checks disabled: prefer `== null`/`!= null` unless distinguishing `undefined` is required. Writable Jotai atoms must be `PrimitiveAtom<Type>`.
- Use 4-space indentation. Tailwind v4 is preferred for new styling; shared custom styles are in `frontend/tailwindsetup.css`.
- In Go, use string constants rather than custom enum types, `Make...` rather than `New...` constructors, and `Printf` rather than `Println`.

## Local macOS Deploy

- Perform this only when explicitly asked to deploy the local macOS arm64 application. It force-quits Wave and replaces `/Applications/Wave.app`.
- First run `pkill -x "Wave" 2>/dev/null; task package`. If packaging fails, do not reinstall.
- After a successful package, run `rm -rf /Applications/Wave.app && cp -r /Users/mkosina/waveterm/make/mac-arm64/Wave.app /Applications/Wave.app`.
- Verify `make/mac-arm64/Wave.app` was produced and the copy completed; launch `/Applications/Wave.app` only when requested or needed for a sanity check.
