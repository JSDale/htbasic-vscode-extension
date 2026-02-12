import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {

    const diagnosticCollection = vscode.languages.createDiagnosticCollection("htbasic");

    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(event => {
            validateDocument(event.document, diagnosticCollection);
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(document => {
            validateDocument(document, diagnosticCollection);
        })
    );
}

function validateDocument(document: vscode.TextDocument, collection: vscode.DiagnosticCollection) {
    if (document.languageId !== "htbasic") return;

    const diagnostics: vscode.Diagnostic[] = [];
    const text = document.getText();
    const lines = text.split(/\r?\n/);

    let forStack: number[] = [];
    let subStack: number[] = [];

    lines.forEach((line, index) => {

        // Check for unclosed strings
        const quoteCount = (line.match(/"/g) || []).length;
        if (quoteCount % 2 !== 0) {
            diagnostics.push(new vscode.Diagnostic(
                new vscode.Range(index, 0, index, line.length),
                "Unclosed string literal",
                vscode.DiagnosticSeverity.Error
            ));
        }

        // IF without THEN
        if (/^\s*IF\b/i.test(line) && !/\bTHEN\b/i.test(line)) {
            diagnostics.push(new vscode.Diagnostic(
                new vscode.Range(index, 0, index, line.length),
                "IF statement missing THEN",
                vscode.DiagnosticSeverity.Error
            ));
        }

        // FOR tracking
        if (/^\s*FOR\b/i.test(line)) {
            forStack.push(index);
        }

        if (/^\s*NEXT\b/i.test(line)) {
            if (forStack.length === 0) {
                diagnostics.push(new vscode.Diagnostic(
                    new vscode.Range(index, 0, index, line.length),
                    "NEXT without matching FOR",
                    vscode.DiagnosticSeverity.Error
                ));
            } else {
                forStack.pop();
            }
        }

        // SUB tracking
        if (/^\s*SUB\b/i.test(line)) {
            subStack.push(index);
        }

        if (/^\s*END\s+SUB\b/i.test(line)) {
            if (subStack.length === 0) {
                diagnostics.push(new vscode.Diagnostic(
                    new vscode.Range(index, 0, index, line.length),
                    "END SUB without matching SUB",
                    vscode.DiagnosticSeverity.Error
                ));
            } else {
                subStack.pop();
            }
        }

    });

    collection.set(document.uri, diagnostics);
}

export function deactivate() {}
