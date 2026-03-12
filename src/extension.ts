import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    const diagnosticCollection = vscode.languages.createDiagnosticCollection('htbasic');

    const validate = (doc: vscode.TextDocument) => validateDocument(doc, diagnosticCollection);

    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(e => validate(e.document)),
        vscode.workspace.onDidOpenTextDocument(validate),
        vscode.workspace.onDidCloseTextDocument(doc => diagnosticCollection.delete(doc.uri)),
        vscode.languages.registerDefinitionProvider({ language: 'htbasic' }, new HTBasicDefinitionProvider())
    );

    // Validate any already-open documents on activation
    vscode.workspace.textDocuments.forEach(validate);
}

// ─── Definition Provider (F12) ───────────────────────────────────────────────

class HTBasicDefinitionProvider implements vscode.DefinitionProvider {
    provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): vscode.Location | undefined {
        const lineText = document.lineAt(position.line).text;
        const lines = document.getText().split(/\r?\n/);

        // ── Numeric literal under cursor → GOTO/GOSUB line number target ──────
        const numRange = document.getWordRangeAtPosition(position, /\d+/);
        if (numRange) {
            const num = document.getText(numRange);
            const before = lineText.substring(0, numRange.start.character);
            if (/\b(GOTO|GOSUB|THEN)\s*$/i.test(before)) {
                return findLineNumberDef(document, lines, num);
            }
        }

        // ── Identifier under cursor ───────────────────────────────────────────
        const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*\$?/);
        if (!wordRange) return undefined;

        const word = document.getText(wordRange);
        const wordUpper = word.toUpperCase();
        const before = lineText.substring(0, wordRange.start.character);

        // After GOTO / GOSUB / THEN → jump to label or line number
        if (/\b(GOTO|GOSUB|THEN)\s*$/i.test(before)) {
            return findLabelDef(document, lines, wordUpper)
                ?? findLineNumberDef(document, lines, word);
        }

        // General: SUB definition → DEF FN → label
        return findSubDef(document, lines, wordUpper)
            ?? findFnDef(document, lines, wordUpper)
            ?? findLabelDef(document, lines, wordUpper);
    }
}

function findLineNumberDef(
    document: vscode.TextDocument,
    lines: string[],
    num: string
): vscode.Location | undefined {
    for (let i = 0; i < lines.length; i++) {
        if (new RegExp(`^\\s*${num}(\\s|$)`).test(lines[i])) {
            return new vscode.Location(document.uri, new vscode.Position(i, 0));
        }
    }
    return undefined;
}

function findLabelDef(
    document: vscode.TextDocument,
    lines: string[],
    labelUpper: string
): vscode.Location | undefined {
    for (let i = 0; i < lines.length; i++) {
        const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/i.exec(lines[i]);
        if (m && m[1].toUpperCase() === labelUpper) {
            return new vscode.Location(
                document.uri,
                new vscode.Position(i, lines[i].indexOf(m[1]))
            );
        }
    }
    return undefined;
}

function findSubDef(
    document: vscode.TextDocument,
    lines: string[],
    nameUpper: string
): vscode.Location | undefined {
    for (let i = 0; i < lines.length; i++) {
        const m = /^\s*SUB\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(lines[i]);
        if (m && m[1].toUpperCase() === nameUpper) {
            return new vscode.Location(
                document.uri,
                new vscode.Position(i, lines[i].indexOf(m[1]))
            );
        }
    }
    return undefined;
}

function findFnDef(
    document: vscode.TextDocument,
    lines: string[],
    nameUpper: string
): vscode.Location | undefined {
    for (let i = 0; i < lines.length; i++) {
        // Matches: DEF FNfoo(...)
        const m = /^\s*DEF\s+FN([A-Za-z_][A-Za-z0-9_$]*)/i.exec(lines[i]);
        if (m) {
            const fn = m[1].toUpperCase();
            // Accept cursor on either "FNfoo" or "foo"
            if (fn === nameUpper || 'FN' + fn === nameUpper) {
                return new vscode.Location(document.uri, new vscode.Position(i, 0));
            }
        }
    }
    return undefined;
}

// ─── Linter ──────────────────────────────────────────────────────────────────

function validateDocument(
    document: vscode.TextDocument,
    collection: vscode.DiagnosticCollection
): void {
    if (document.languageId !== 'htbasic') return;

    const diagnostics: vscode.Diagnostic[] = [];
    const lines = document.getText().split(/\r?\n/);

    // Block-matching stacks — each entry is the line index where the block opened
    const forStack: number[] = [];
    const whileStack: number[] = [];
    const doStack: number[] = [];
    const subStack: number[] = [];
    const defStack: number[] = [];   // DEF FN … FNEND
    const ifStack: number[] = [];    // multi-line IF blocks

    // ── First pass: collect definitions for GOTO/GOSUB/CALL validation ────────
    const definedLabels = new Set<string>();
    const definedLineNums = new Set<string>();
    const definedSubs = new Set<string>();

    for (const raw of lines) {
        const stripped = stripComment(raw).trim();

        const lineNumM = /^(\d+)\s/.exec(stripped);
        if (lineNumM) definedLineNums.add(lineNumM[1]);

        const labelM = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/i.exec(stripped);
        if (labelM) definedLabels.add(labelM[1].toUpperCase());

        const subM = /^\s*SUB\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(stripped);
        if (subM) definedSubs.add(subM[1].toUpperCase());
    }

    // ── Second pass: validate each line ───────────────────────────────────────
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const stripped = stripComment(raw);
        const trimmed = stripped.trim();

        const lineRange = new vscode.Range(i, 0, i, raw.length);
        const err  = (msg: string) => new vscode.Diagnostic(lineRange, msg, vscode.DiagnosticSeverity.Error);
        const warn = (msg: string) => new vscode.Diagnostic(lineRange, msg, vscode.DiagnosticSeverity.Warning);

        // Skip blank / comment-only lines
        if (trimmed === '' || /^!/.test(trimmed) || /^REM\b/i.test(trimmed)) continue;

        // ── Unclosed string literal ───────────────────────────────────────────
        if (hasUnclosedString(stripped)) {
            diagnostics.push(err('Unclosed string literal'));
        }

        // ── IF without THEN ───────────────────────────────────────────────────
        if (/^\s*IF\b/i.test(trimmed) && !/\bTHEN\b/i.test(trimmed)) {
            diagnostics.push(err('IF statement missing THEN'));
        }

        // ── Multi-line block IF (THEN at end-of-line with no statement after) ─
        if (/^\s*IF\b/i.test(trimmed) && /\bTHEN\s*$/i.test(trimmed)) {
            ifStack.push(i);
        }
        if (/^\s*(END\s*IF|ENDIF)\b/i.test(trimmed)) {
            if (ifStack.length === 0) {
                diagnostics.push(err('ENDIF without matching IF'));
            } else {
                ifStack.pop();
            }
        }

        // ── FOR / NEXT ────────────────────────────────────────────────────────
        if (/^\s*FOR\b/i.test(trimmed)) {
            forStack.push(i);
        }
        if (/^\s*NEXT\b/i.test(trimmed)) {
            if (forStack.length === 0) {
                diagnostics.push(err('NEXT without matching FOR'));
            } else {
                forStack.pop();
            }
        }

        // ── WHILE / WEND ──────────────────────────────────────────────────────
        if (/^\s*WHILE\b/i.test(trimmed)) {
            whileStack.push(i);
        }
        if (/^\s*WEND\b/i.test(trimmed)) {
            if (whileStack.length === 0) {
                diagnostics.push(err('WEND without matching WHILE'));
            } else {
                whileStack.pop();
            }
        }

        // ── DO / LOOP ─────────────────────────────────────────────────────────
        if (/^\s*DO\b/i.test(trimmed)) {
            doStack.push(i);
        }
        if (/^\s*LOOP\b/i.test(trimmed)) {
            if (doStack.length === 0) {
                diagnostics.push(err('LOOP without matching DO'));
            } else {
                doStack.pop();
            }
        }

        // ── SUB / SUBEND ──────────────────────────────────────────────────────
        if (/^\s*SUB\b/i.test(trimmed)) {
            subStack.push(i);
        }
        if (/^\s*(SUBEND|END\s+SUB)\b/i.test(trimmed)) {
            if (subStack.length === 0) {
                diagnostics.push(err('SUBEND without matching SUB'));
            } else {
                subStack.pop();
            }
        }

        // ── DEF FN / FNEND ────────────────────────────────────────────────────
        if (/^\s*DEF\s+FN/i.test(trimmed)) {
            defStack.push(i);
        }
        if (/^\s*FNEND\b/i.test(trimmed)) {
            if (defStack.length === 0) {
                diagnostics.push(err('FNEND without matching DEF FN'));
            } else {
                defStack.pop();
            }
        }

        // ── GOTO to undefined target ──────────────────────────────────────────
        const gotoM = /\bGOTO\s+([A-Za-z_]\w*|\d+)/i.exec(trimmed);
        if (gotoM) {
            const target = gotoM[1];
            if (/^\d+$/.test(target)) {
                if (!definedLineNums.has(target)) {
                    diagnostics.push(warn(`GOTO target line ${target} not found in file`));
                }
            } else if (!definedLabels.has(target.toUpperCase())) {
                diagnostics.push(warn(`GOTO label "${target}" not defined`));
            }
        }

        // ── GOSUB to undefined target ─────────────────────────────────────────
        const gosubM = /\bGOSUB\s+([A-Za-z_]\w*|\d+)/i.exec(trimmed);
        if (gosubM) {
            const target = gosubM[1];
            if (/^\d+$/.test(target)) {
                if (!definedLineNums.has(target)) {
                    diagnostics.push(warn(`GOSUB target line ${target} not found in file`));
                }
            } else if (!definedLabels.has(target.toUpperCase())) {
                diagnostics.push(warn(`GOSUB label "${target}" not defined`));
            }
        }

        // ── CALL to undefined SUB ─────────────────────────────────────────────
        const callM = /^\s*CALL\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(trimmed);
        if (callM && !definedSubs.has(callM[1].toUpperCase())) {
            diagnostics.push(warn(`SUB "${callM[1]}" is not defined in this file`));
        }
    }

    // ── Report unclosed blocks (errors on their opening line) ─────────────────
    const reportUnclosed = (stack: number[], kw: string, closing: string) => {
        for (const lineNum of stack) {
            diagnostics.push(new vscode.Diagnostic(
                new vscode.Range(lineNum, 0, lineNum, lines[lineNum].length),
                `${kw} block not closed — missing ${closing}`,
                vscode.DiagnosticSeverity.Error
            ));
        }
    };

    reportUnclosed(forStack,   'FOR',    'NEXT');
    reportUnclosed(whileStack, 'WHILE',  'WEND');
    reportUnclosed(doStack,    'DO',     'LOOP');
    reportUnclosed(subStack,   'SUB',    'SUBEND');
    reportUnclosed(defStack,   'DEF FN', 'FNEND');
    reportUnclosed(ifStack,    'IF',     'ENDIF');

    collection.set(document.uri, diagnostics);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Strip everything from the first unquoted `!` onward (inline comment). */
function stripComment(line: string): string {
    let inString = false;
    for (let i = 0; i < line.length; i++) {
        if (line[i] === '"') inString = !inString;
        if (!inString && line[i] === '!') return line.substring(0, i);
    }
    return line;
}

/** Returns true if the line has an unclosed string literal. */
function hasUnclosedString(line: string): boolean {
    let open = false;
    for (const ch of line) {
        if (ch === '"') open = !open;
    }
    return open;
}

export function deactivate() {}
