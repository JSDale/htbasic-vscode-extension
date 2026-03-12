import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export function activate(context: vscode.ExtensionContext) {
    const diagnosticCollection = vscode.languages.createDiagnosticCollection('htbasic');

    const validate = (doc: vscode.TextDocument) => validateDocument(doc, diagnosticCollection);

    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(e => validate(e.document)),
        vscode.workspace.onDidOpenTextDocument(validate),
        vscode.workspace.onDidCloseTextDocument(doc => diagnosticCollection.delete(doc.uri)),
        vscode.languages.registerDefinitionProvider({ language: 'htbasic' }, new HTBasicDefinitionProvider())
    );

    vscode.workspace.textDocuments.forEach(validate);
}

// ─── LOADSUB / LOAD parser ───────────────────────────────────────────────────

interface LoadedFile {
    /** Resolved absolute path on disk. */
    fsPath: string;
    /** Line index of the LOADSUB/LOAD statement in the parent file. */
    lineIndex: number;
    /** Whether the file actually exists on disk. */
    exists: boolean;
}

/**
 * Scans `lines` for LOADSUB / LOAD statements and resolves the referenced
 * filenames relative to `currentDir`.  If the filename has no extension,
 * `.htb` is assumed.
 */
function parseLoadedFiles(lines: string[], currentDir: string): LoadedFile[] {
    const results: LoadedFile[] = [];
    for (let i = 0; i < lines.length; i++) {
        const stripped = stripComment(lines[i]).trim();
        const m = /^\s*(?:LOADSUB|LOAD)\s+"([^"]+)"/i.exec(stripped);
        if (!m) continue;

        let filename = m[1];
        if (!path.extname(filename)) filename += '.htb';

        const fsPath = path.resolve(currentDir, filename);
        results.push({ fsPath, lineIndex: i, exists: fs.existsSync(fsPath) });
    }
    return results;
}

// ─── Definition Provider (F12) ───────────────────────────────────────────────

class HTBasicDefinitionProvider implements vscode.DefinitionProvider {
    async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Location | undefined> {
        const lineText = document.lineAt(position.line).text;
        const currentLines = document.getText().split(/\r?\n/);
        const currentDir = path.dirname(document.uri.fsPath);

        // ── Determine search kind and target ──────────────────────────────────
        let searchKind: 'linenum' | 'goto-label' | 'symbol' | null = null;
        let searchTarget = '';

        const numRange = document.getWordRangeAtPosition(position, /\d+/);
        if (numRange) {
            const num = document.getText(numRange);
            const before = lineText.substring(0, numRange.start.character);
            if (/\b(GOTO|GOSUB|THEN)\s*$/i.test(before)) {
                searchKind = 'linenum';
                searchTarget = num;
            }
        }

        if (!searchKind) {
            const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*\$?/);
            if (!wordRange) return undefined;

            const word = document.getText(wordRange);
            const before = lineText.substring(0, wordRange.start.character);
            searchTarget = word.toUpperCase();
            searchKind = /\b(GOTO|GOSUB|THEN)\s*$/i.test(before) ? 'goto-label' : 'symbol';
        }

        // ── Search current file first ─────────────────────────────────────────
        const local = searchInLines(document.uri, currentLines, searchKind, searchTarget);
        if (local) return local;

        // Line numbers and labels are local-only — don't cross file boundaries
        if (searchKind === 'linenum' || searchKind === 'goto-label') return undefined;

        // ── Search only files declared with LOADSUB / LOAD ────────────────────
        const loadedFiles = parseLoadedFiles(currentLines, currentDir);

        for (const lf of loadedFiles) {
            if (token.isCancellationRequested) return undefined;
            if (!lf.exists) continue;

            let lines: string[];
            try {
                const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(lf.fsPath));
                lines = new TextDecoder('utf-8').decode(bytes).split(/\r?\n/);
            } catch {
                continue;
            }

            const result = searchInLines(vscode.Uri.file(lf.fsPath), lines, searchKind, searchTarget);
            if (result) return result;
        }

        return undefined;
    }
}

function searchInLines(
    uri: vscode.Uri,
    lines: string[],
    kind: 'linenum' | 'goto-label' | 'symbol',
    target: string
): vscode.Location | undefined {
    if (kind === 'linenum') {
        return findLineNumberDef(uri, lines, target);
    }
    if (kind === 'goto-label') {
        return findLabelDef(uri, lines, target)
            ?? findLineNumberDef(uri, lines, target);
    }
    return findSubDef(uri, lines, target)
        ?? findFnDef(uri, lines, target)
        ?? findLabelDef(uri, lines, target);
}

function findLineNumberDef(uri: vscode.Uri, lines: string[], num: string): vscode.Location | undefined {
    for (let i = 0; i < lines.length; i++) {
        if (new RegExp(`^\\s*${num}(\\s|$)`).test(lines[i])) {
            return new vscode.Location(uri, new vscode.Position(i, 0));
        }
    }
    return undefined;
}

function findLabelDef(uri: vscode.Uri, lines: string[], labelUpper: string): vscode.Location | undefined {
    for (let i = 0; i < lines.length; i++) {
        const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/i.exec(lines[i]);
        if (m && m[1].toUpperCase() === labelUpper) {
            return new vscode.Location(uri, new vscode.Position(i, lines[i].indexOf(m[1])));
        }
    }
    return undefined;
}

function findSubDef(uri: vscode.Uri, lines: string[], nameUpper: string): vscode.Location | undefined {
    for (let i = 0; i < lines.length; i++) {
        const m = /^\s*SUB\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(lines[i]);
        if (m && m[1].toUpperCase() === nameUpper) {
            return new vscode.Location(uri, new vscode.Position(i, lines[i].indexOf(m[1])));
        }
    }
    return undefined;
}

function findFnDef(uri: vscode.Uri, lines: string[], nameUpper: string): vscode.Location | undefined {
    for (let i = 0; i < lines.length; i++) {
        const m = /^\s*DEF\s+FN([A-Za-z_][A-Za-z0-9_$]*)/i.exec(lines[i]);
        if (m) {
            const fn = m[1].toUpperCase();
            if (fn === nameUpper || 'FN' + fn === nameUpper) {
                return new vscode.Location(uri, new vscode.Position(i, 0));
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
    const currentDir = path.dirname(document.uri.fsPath);

    // Block-matching stacks
    const forStack: number[] = [];
    const whileStack: number[] = [];
    const doStack: number[] = [];
    const subStack: number[] = [];
    const defStack: number[] = [];
    const ifStack: number[] = [];

    // ── First pass: collect local definitions and parse LOADSUB/LOAD ──────────
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

    // Collect SUBs from LOADSUB/LOAD declared files (sync read is fine for linting)
    const loadedFiles = parseLoadedFiles(lines, currentDir);
    for (const lf of loadedFiles) {
        if (!lf.exists) continue;
        try {
            const content = fs.readFileSync(lf.fsPath, 'utf8');
            for (const raw of content.split(/\r?\n/)) {
                const subM = /^\s*SUB\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(raw);
                if (subM) definedSubs.add(subM[1].toUpperCase());
            }
        } catch { /* skip unreadable files */ }
    }

    // ── Second pass: validate each line ───────────────────────────────────────
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const stripped = stripComment(raw);
        const trimmed = stripped.trim();

        const lineRange = new vscode.Range(i, 0, i, raw.length);
        const err  = (msg: string) => new vscode.Diagnostic(lineRange, msg, vscode.DiagnosticSeverity.Error);
        const warn = (msg: string) => new vscode.Diagnostic(lineRange, msg, vscode.DiagnosticSeverity.Warning);

        if (trimmed === '' || /^!/.test(trimmed) || /^REM\b/i.test(trimmed)) continue;

        // ── LOADSUB / LOAD file existence check ───────────────────────────────
        const loadM = /^\s*(?:LOADSUB|LOAD)\s+"([^"]+)"/i.exec(trimmed);
        if (loadM) {
            const lf = loadedFiles.find(f => f.lineIndex === i);
            if (lf && !lf.exists) {
                diagnostics.push(err(`File not found: "${loadM[1]}"`));
            }
            continue; // nothing else to check on a LOAD line
        }

        // ── Unclosed string literal ───────────────────────────────────────────
        if (hasUnclosedString(stripped)) {
            diagnostics.push(err('Unclosed string literal'));
        }

        // ── IF without THEN ───────────────────────────────────────────────────
        if (/^\s*IF\b/i.test(trimmed) && !/\bTHEN\b/i.test(trimmed)) {
            diagnostics.push(err('IF statement missing THEN'));
        }

        // ── Multi-line block IF ───────────────────────────────────────────────
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
        if (/^\s*FOR\b/i.test(trimmed)) forStack.push(i);
        if (/^\s*NEXT\b/i.test(trimmed)) {
            if (forStack.length === 0) diagnostics.push(err('NEXT without matching FOR'));
            else forStack.pop();
        }

        // ── WHILE / WEND ──────────────────────────────────────────────────────
        if (/^\s*WHILE\b/i.test(trimmed)) whileStack.push(i);
        if (/^\s*WEND\b/i.test(trimmed)) {
            if (whileStack.length === 0) diagnostics.push(err('WEND without matching WHILE'));
            else whileStack.pop();
        }

        // ── DO / LOOP ─────────────────────────────────────────────────────────
        if (/^\s*DO\b/i.test(trimmed)) doStack.push(i);
        if (/^\s*LOOP\b/i.test(trimmed)) {
            if (doStack.length === 0) diagnostics.push(err('LOOP without matching DO'));
            else doStack.pop();
        }

        // ── SUB / SUBEND ──────────────────────────────────────────────────────
        if (/^\s*SUB\b/i.test(trimmed)) subStack.push(i);
        if (/^\s*(SUBEND|END\s+SUB)\b/i.test(trimmed)) {
            if (subStack.length === 0) diagnostics.push(err('SUBEND without matching SUB'));
            else subStack.pop();
        }

        // ── DEF FN / FNEND ────────────────────────────────────────────────────
        if (/^\s*DEF\s+FN/i.test(trimmed)) defStack.push(i);
        if (/^\s*FNEND\b/i.test(trimmed)) {
            if (defStack.length === 0) diagnostics.push(err('FNEND without matching DEF FN'));
            else defStack.pop();
        }

        // ── GOTO to undefined target ──────────────────────────────────────────
        const gotoM = /\bGOTO\s+([A-Za-z_]\w*|\d+)/i.exec(trimmed);
        if (gotoM) {
            const target = gotoM[1];
            if (/^\d+$/.test(target)) {
                if (!definedLineNums.has(target)) diagnostics.push(warn(`GOTO target line ${target} not found in file`));
            } else if (!definedLabels.has(target.toUpperCase())) {
                diagnostics.push(warn(`GOTO label "${target}" not defined`));
            }
        }

        // ── GOSUB to undefined target ─────────────────────────────────────────
        const gosubM = /\bGOSUB\s+([A-Za-z_]\w*|\d+)/i.exec(trimmed);
        if (gosubM) {
            const target = gosubM[1];
            if (/^\d+$/.test(target)) {
                if (!definedLineNums.has(target)) diagnostics.push(warn(`GOSUB target line ${target} not found in file`));
            } else if (!definedLabels.has(target.toUpperCase())) {
                diagnostics.push(warn(`GOSUB label "${target}" not defined`));
            }
        }

        // ── CALL to undefined SUB (checks current file + all LOADSUB files) ───
        const callM = /^\s*CALL\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(trimmed);
        if (callM && !definedSubs.has(callM[1].toUpperCase())) {
            diagnostics.push(warn(`SUB "${callM[1]}" not found in this file or any LOADSUB file`));
        }
    }

    // ── Unclosed blocks ───────────────────────────────────────────────────────
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

function stripComment(line: string): string {
    let inString = false;
    for (let i = 0; i < line.length; i++) {
        if (line[i] === '"') inString = !inString;
        if (!inString && line[i] === '!') return line.substring(0, i);
    }
    return line;
}

function hasUnclosedString(line: string): boolean {
    let open = false;
    for (const ch of line) {
        if (ch === '"') open = !open;
    }
    return open;
}

export function deactivate() {}
