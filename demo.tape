Output demo.gif

Set Shell bash
Set FontSize 15
Set Width 900
Set Height 520
Set Theme "Catppuccin Mocha"
Set TypingSpeed 35ms
Set Padding 15

Hide
Type "cd /tmp/vet-demo && git checkout -- . 2>/dev/null && rm -f CLAUDE.md"
Enter
Sleep 1s
Type "clear"
Enter
Sleep 500ms
Show

# Show the scan
Type "npx @safetnsr/vet --pretty"
Enter
Sleep 3s

Sleep 3s

# Auto-fix
Type "npx @safetnsr/vet --fix --pretty"
Enter
Sleep 3s

Sleep 2s

# Show improved score
Type "npx @safetnsr/vet --pretty"
Enter
Sleep 3s

Sleep 3s
