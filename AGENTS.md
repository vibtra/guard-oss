# Agents working on Guard

- Read [CONTRIBUTING.md](CONTRIBUTING.md) first: where tests go, the licence agreement and the gate checks.
- The Go agent is in `guard/agent-go/`. Do not add `*_test.go` files there; Go tests are vitest tests in `tests/integration/agent-go/`.
- To write or swap an engine, follow [guard/agent-go/engine/README.md](guard/agent-go/engine/README.md). Copy `engine/example`, implement `Decide` and change the one engine line in `main.go`, plus its import. Change no other file.
- Prove an engine works with `engine check`, and its speed with `engine bench`:

```sh
go -C guard/agent-go build -o build/vibtra-guard .
VIBTRA_GUARD_DIR="$(mktemp -d)" guard/agent-go/build/vibtra-guard engine check
```
