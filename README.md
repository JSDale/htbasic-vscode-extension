# HTBasic Language Support for VS Code

Syntax highlighting, bracket matching, and basic syntax checking for **HTBasic** (HP-style BASIC for instrument control and data acquisition).

## Features

- **Syntax highlighting** – Line numbers, comments (`!`, `REM`), strings, keywords (control flow, I/O, graphics), built-in functions, and ISC constants (e.g. `CRT`, `KBD`, `PRT`, `MSI`)
- **Language configuration** – Comment toggling, auto-closing pairs for `()` and `""`
- **Basic validation** – Unclosed strings, `IF` without `THEN`, `FOR`/`NEXT` and `SUB`/`END SUB` balance

## Using the HTBasic manual (PDF)

The **htbasic-manual.pdf** in this directory is the language reference. Use it to:

1. **Extend the grammar** – Add more keywords and statements in `syntaxes/htbasic.tmLanguage.json` (see the `keywords`, `builtinFunctions`, and `iscConstants` sections).
2. **Improve validation** – In `src/extension.ts`, `validateDocument()` can be extended with rules from the manual (e.g. `SELECT`/`CASE`/`ENDSELECT`, `FUNCTION`/`END FUNCTION`, or statement-specific checks).
3. **Refine language config** – If the manual specifies more bracket or quote rules, add them to `language-configuration.json`.

Keyword and statement names from the manual can be added to the grammar as literal words in the `match` patterns (pipe-separated, e.g. `\b(NEW_KEYWORD|ANOTHER)\b`).

## Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Compile**
   ```bash
   npm run compile
   ```

3. **Run from VS Code**
   - Open this folder in VS Code.
   - Press `F5` or use **Run > Start Debugging** to launch an Extension Development Host with the extension loaded.

4. **Try it**
   - Create or open a file with extension `.htb` to get HTBasic language support.

## Packaging

To create a `.vsix` for installation or sharing:

```bash
npm install -g @vscode/vsce
vsce package
```

## Project layout

| Path | Purpose |
|------|--------|
| `package.json` | Extension manifest (language, grammar, activation) |
| `language-configuration.json` | Comments, brackets, auto-closing pairs |
| `syntaxes/htbasic.tmLanguage.json` | TextMate grammar for highlighting |
| `src/extension.ts` | Validation logic (diagnostics) |
| `htbasic-manual.pdf` | Language reference (use to extend grammar & validation) |

## References

- [TransEra HTBasic Help](https://transera.com/help/welcome_to_htbasic.htm)
- [VS Code Language Extension Guide](https://code.visualstudio.com/api/language-extensions/overview)
