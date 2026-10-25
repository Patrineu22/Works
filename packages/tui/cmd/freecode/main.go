// Command freecode prints the FreeCode banner.
//
// FreeCode's full agent loop lives in the Node CLI at the repository root
// (`node bin/freecode.mjs`); this Go package exists so the logo and palette can
// be reused by any Go TUI without pulling dependencies.
package main

import (
	"fmt"
	"os"

	"github.com/freecode/freecode/packages/tui/assets"
)

func main() {
	if len(os.Args) > 1 && (os.Args[1] == "--version" || os.Args[1] == "-v") {
		fmt.Printf("freecode %s\n", assets.Version)
		return
	}
	if len(os.Args) > 1 && (os.Args[1] == "--logo" || os.Args[1] == "-l") {
		fmt.Println(assets.RenderLogo())
		return
	}
	fmt.Print(assets.RenderBanner())
	fmt.Println("  Run the agent CLI from the repository root instead:")
	fmt.Println("    node bin/freecode.mjs --help")
	fmt.Println()
}
