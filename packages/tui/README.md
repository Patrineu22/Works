# FreeCode TUI (Go)

Terminal identity package: the green ASCII logo, header band and palette, ready
to embed in any Go TUI.

```go
import "github.com/freecode/freecode/packages/tui/assets"

fmt.Print(assets.RenderBanner()) // logo + "FREECODE - AI CODING AGENT - GREEN"
```

Build and run (no external modules, works offline):

```bash
cd packages/tui
go build ./...
go run ./cmd/freecode
```

The interactive agent itself is the Node CLI at the repo root — see the main
[README](../../README.md).
