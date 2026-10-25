// Package assets holds the FreeCode terminal identity: the green ASCII logo.
//
// Deliberately dependency-free (no lipgloss) so it builds offline with a plain
// `go build ./...` and can be dropped into any Go TUI. The colours match the
// desktop assets exactly: #00FF88 on #0A0A0A.
package assets

import "fmt"

const (
	// Primary is the FreeCode green.
	Primary = "#00FF88"
	// PrimaryDim is used for the tagline.
	PrimaryDim = "#00B862"
	// Background is the app background.
	Background = "#0A0A0A"
	// Version is the FreeCode release shown in the tagline.
	Version = "1.0.0"
)

// FreeCodeLogo is the block wordmark plus the >_ tagline.
var FreeCodeLogo = " ███████╗██████╗ ███████╗███████╗ ██████╗ ██████╗ ██████╗ ███████╗\n" +
	" ██╔════╝██╔══██╗██╔════╝██╔════╝██╔════╝██╔═══██╗██╔══██╗██╔════╝\n" +
	" █████╗  ██████╔╝█████╗  █████╗  ██║     ██║   ██║██║  ██║█████╗\n" +
	" ██╔══╝  ██╔══██╗██╔══╝  ██╔══╝  ██║     ██║   ██║██║  ██║██╔══╝\n" +
	" ██║     ██║  ██║███████╗███████╗╚██████╗╚██████╔╝██████╔╝███████╗\n" +
	" ╚═╝     ╚═╝  ╚═╝╚══════╝╚══════╝ ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝\n" +
	"                       >_ freecode v1.0.0 - FreeCode Green"

// Header is the green band shown at the top of the TUI.
const Header = " FREECODE - AI CODING AGENT - GREEN "

const reset = "\x1b[0m"

// RGB wraps text in a 24-bit foreground colour.
func RGB(hex string, text string) string {
	var r, g, b int
	if _, err := fmt.Sscanf(hex, "#%02x%02x%02x", &r, &g, &b); err != nil {
		return text
	}
	return fmt.Sprintf("\x1b[38;2;%d;%d;%dm%s%s", r, g, b, text, reset)
}

// Band renders text on the green background with the dark foreground.
func Band(text string) string {
	return "\x1b[48;2;0;255;136m\x1b[38;2;10;10;10m\x1b[1m" + text + reset
}

// RenderLogo returns the ASCII logo painted in FreeCode green.
func RenderLogo() string {
	return RGB(Primary, FreeCodeLogo)
}

// RenderHeader returns the "FREECODE - AI CODING AGENT - GREEN" band.
func RenderHeader() string {
	return Band(Header)
}

// RenderBanner is the startup view: logo, header and a hint line.
func RenderBanner() string {
	return "\n" + RenderLogo() + "\n\n" + RenderHeader() + "\n\n" +
		RGB(PrimaryDim, "  keyless free forever · agents JIM KAI ALEX") + "\n" +
		RGB("#7A7A7A", "  /help for commands  /exit to quit") + "\n\n"
}
