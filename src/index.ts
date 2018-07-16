import * as ts_module from "../node_modules/typescript/lib/tsserverlibrary";
import * as server from 'vscode-languageserver';
import * as path from 'path';

const Module = require("module");

// Settings for the plugin section in tsconfig.json
interface Settings {
    alwaysShowRuleFailuresAsWarnings?: boolean;
    ignoreDefinitionFiles?: boolean;
    configFile?: string;
    disableNoUnusedVariableRule?: boolean  // support to enable/disable the workaround for https://github.com/Microsoft/TypeScript/issues/15344
    supressWhileTypeErrorsPresent: boolean;
}

const ESLINT_ERROR_CODE = 200000;

interface ESLintAutoFixEdit {
    range: [number, number];
    text: string;
}

interface ESLintProblem {
    line: number;
    column: number;
    endLine?: number;
    endColumn?: number;
    severity: number;
    ruleId: string;
    message: string;
    fix?: ESLintAutoFixEdit;
}

interface AutoFix {
    label: string;
    documentVersion: number;
    ruleId: string;
    edit: ESLintAutoFixEdit;
}

interface ESLintDocumentReport {
    filePath: string;
    errorCount: number;
    warningCount: number;
    messages: ESLintProblem[];
    output?: string;
}

interface ESLintReport {
    errorCount: number;
    warningCount: number;
    results: ESLintDocumentReport[];
}

interface CLIOptions {
    cwd?: string;
}

let globalPackageManagerPath: Map<string, string> = new Map();  // map stores undefined values to represent failed resolutions

function getGlobalPackageManagerPath(packageManager?: string): string | undefined {
    if (!globalPackageManagerPath.has(packageManager)) {
        let path: string | undefined;
        if (packageManager === 'npm') {
            path = server.Files.resolveGlobalNodePath();
        } else if (packageManager === 'yarn') {
            path = server.Files.resolveGlobalYarnPath();
        } else {
            path = server.Files.resolveGlobalNodePath() || server.Files.resolveGlobalYarnPath();
        }
        globalPackageManagerPath.set(packageManager, path!);
    }
    return globalPackageManagerPath.get(packageManager);
}

function resolve(name: string, extraLookupPaths: string[]) {
    const lookupPaths = extraLookupPaths.concat((<any>module).paths ? (<any>module).paths.concat(Module.globalPaths) : Module.globalPaths)
    const result = Module._findPath(name, lookupPaths);
    if (!result) {
        throw new Error(`Cannot find module '${name}'`);
    }
    return result;
}


function init(modules: {typescript: typeof ts_module}) {
    const ts = modules.typescript;

    let codeFixActions = new Map<string, Map<string, ESLintProblem>>();

    function fixRelativeConfigFilePath(config: Settings, projectRoot: string): Settings {
        if (!config.configFile) {
            return config;
        }
        if (path.isAbsolute(config.configFile)) {
            return config;
        }
        config.configFile = path.join(projectRoot, config.configFile);
        return config;
    }

    function create(info: ts.server.PluginCreateInfo) {
        info.project.projectService.logger.info("eslint-language-service loaded");
        let config: Settings = fixRelativeConfigFilePath(info.config, info.project.getCurrentDirectory());

        function loadLibrary(name: string, fileName: string) {
            let lookupPaths = [
                getGlobalPackageManagerPath(),
            ];
            let directory = fileName;
            let next = path.resolve(fileName);
            do {
                directory = next;
                next = path.dirname(directory);
                lookupPaths.push(path.join(next, 'node_modules'))
            } while(next !== directory);

            let resolved = resolve(name, lookupPaths);
            let library = require(resolved);
            info.project.projectService.logger.info(`${name} library loaded from: ${resolved}`);
            return library;
        }

        // Set up decorator
        const proxy = Object.create(null) as ts.LanguageService;
        const oldLS = info.languageService;
        for (const k in oldLS) {
            (<any>proxy)[k] = function () {
                return (<any>oldLS)[k].apply(oldLS, arguments);
            }
        }

        function makeDiagnostic(problem: ESLintProblem, file: ts.SourceFile): ts.Diagnostic {
            let message = (problem.ruleId != null)
                ? `${problem.message} (${problem.ruleId})`
                : `${problem.message}`;

            let category;
            if (config.alwaysShowRuleFailuresAsWarnings === true) {
                category = ts.DiagnosticCategory.Warning;
            } else if (problem.severity === 1) {
                // Eslint 1 is warning
                category = ts.DiagnosticCategory.Warning;
            } else {
                category = ts.DiagnosticCategory.Error;
            }

            let startLine = Math.max(1, problem.line);
            let startOffset = Math.max(1, problem.column);
            let endLine = problem.endLine != null ? Math.max(1, problem.endLine) : startLine;
            let endOffset = problem.endColumn != null ? Math.max(1, problem.endColumn) : startOffset;
            let scriptInfo = info.project.projectService.getScriptInfo(file.fileName)
            let start = scriptInfo.lineOffsetToPosition(startLine, startOffset)
            let end = scriptInfo.lineOffsetToPosition(endLine, endOffset)

            let diagnostic: ts.Diagnostic = {
                file: file,
                start: start,
                length: end - start,
                messageText: message,
                category: category,
                source: 'eslint',
                code: ESLINT_ERROR_CODE
            };
            return diagnostic;
        }

        function computeKey(start: number, end: number): string {
            return `[${start},${end}]`;
        }

        function recordCodeAction(problem: ESLintProblem, file: ts.SourceFile) {
            let documentAutoFixes: Map<string, ESLintProblem> = codeFixActions.get(file.fileName);
            if (!documentAutoFixes) {
                documentAutoFixes = new Map<string, ESLintProblem>();
                codeFixActions.set(file.fileName, documentAutoFixes);
            }
            let startLine = Math.max(1, problem.line);
            let startOffset = Math.max(1, problem.column);
            let endLine = problem.endLine != null ? Math.max(1, problem.endLine) : startLine;
            let endOffset = problem.endColumn != null ? Math.max(1, problem.endColumn) : startOffset;
            let scriptInfo = info.project.projectService.getScriptInfo(file.fileName)
            let start = scriptInfo.lineOffsetToPosition(startLine, startOffset)
            let end = scriptInfo.lineOffsetToPosition(endLine, endOffset)
            documentAutoFixes.set(computeKey(start, end), problem);
        }

        function convertReplacementToTextChange(editInfo: AutoFix): ts.TextChange {
            return {
                newText: editInfo.edit.text || '',
                span: { start: editInfo.edit.range[0], length: editInfo.edit.range[1] - editInfo.edit.range[0] }
            };
        }

        function getReplacements(problem: ESLintProblem): AutoFix[] {
            return [{
                label: '',
                documentVersion: 0,
                ruleId: problem.ruleId,
                edit: problem.fix,
            }];
        }

        function problemToFileTextChange(problem: ESLintProblem, fileName: string): ts_module.FileTextChanges {
            let replacements: AutoFix[] = getReplacements(problem);

            return {
                fileName: fileName,
                textChanges: replacements.map(each => convertReplacementToTextChange(each)),
            }
        }

        function addRuleFailureFix(fixes: ts_module.CodeAction[], problem: ESLintProblem, fileName: string) {
            fixes.push({
                description: `Fix this ${problem.ruleId} problem`,
                changes: [problemToFileTextChange(problem, fileName)]
            });
        }

        /* Generate a code action that fixes all instances of ruleName.  */
        function addRuleFailureFixAll(fixes: ts_module.CodeAction[], ruleName: string, problems: Map<string, ESLintProblem>, fileName: string) {
            const changes: ts_module.FileTextChanges[] = [];

            for (const problem of problems.values()) {
                if (problem.ruleId === ruleName) {
                    changes.push(problemToFileTextChange(problem, fileName));
                }
            }

            /* No need for this action if there's only one instance.  */
            if (changes.length < 2) {
                return;
            }

            fixes.push({
                description: `Fix all '${ruleName}'`,
                changes: changes,
            });
        }

        function addDisableRuleFix(fixes: ts_module.CodeAction[], problem: ESLintProblem, fileName: string, file: ts_module.SourceFile) {
            fixes.push({
                description: `Disable rule '${problem.ruleId}'`,
                changes: [{
                    fileName: fileName,
                    textChanges: [{
                        newText: `// tslint:disable-next-line:${problem.ruleId}\n`,
                        span: { start: file.getLineStarts()[problem.line], length: 0 }
                    }]
                }]
            });
        }

        function addAllAutoFixable(fixes: ts_module.CodeAction[], documentFixes: Map<string, ESLintProblem>, fileName: string) {
            const allReplacements = getNonOverlappingReplacements(documentFixes);
            fixes.push({
                description: `Fix all auto-fixable tslint problems`,
                changes: [{
                    fileName: fileName,
                    textChanges: allReplacements.map(each => convertReplacementToTextChange(each))
                }]
            });
        }

        function sortProblems(problems: ESLintProblem[]): ESLintProblem[] {
            // The problems are sorted by position, we sort on the position of the first replacement
            return problems.sort((a, b) => {
                return a.fix.range[0] - b.fix.range[0];
            });
        }

        function getNonOverlappingReplacements(documentFixes: Map<string, ESLintProblem>): AutoFix[] {
            function overlaps(a: AutoFix, b: AutoFix): boolean {
                return a.edit.range[1] >= b.edit.range[0];
            }

            let sortedProblems = sortProblems([...documentFixes.values()]);
            let nonOverlapping: AutoFix[] = [];
            for (let i = 0; i < sortedProblems.length; i++) {
                let replacements = getReplacements(sortedProblems[i]);
                if (i === 0 || !overlaps(nonOverlapping[nonOverlapping.length - 1], replacements[0])) {
                    nonOverlapping.push(...replacements)
                }
            }
            return nonOverlapping;
        }

        proxy.getSemanticDiagnostics = (fileName: string) => {
            let prior = oldLS.getSemanticDiagnostics(fileName);

            try {
                info.project.projectService.logger.info(`Computing eslint semantic diagnostics for ${fileName}`);

                if (config.supressWhileTypeErrorsPresent && prior.length > 0) {
                    return prior;
                }

                let report: ESLintReport;

                const file = oldLS.getProgram().getSourceFile(fileName);

                try { // protect against eslint crashes
                    let options = { fix: false };
                    let newOptions: CLIOptions = Object.assign(Object.create(null), options);
                    let directory = path.dirname(fileName);
                    if (directory) {
                        if (path.isAbsolute(directory)) {
                            newOptions.cwd = directory;
                        }
                    }
                    const library = loadLibrary('eslint', fileName);
                    let cli = new library.CLIEngine(newOptions);
                    report = cli.executeOnText(file.text, fileName);
                } catch (err) {
                    let errorMessage = `unknown error`;
                    if (typeof err.message === 'string' || err.message instanceof String) {
                        errorMessage = <string>err.message;
                    }
                    info.project.projectService.logger.info('eslint error ' + errorMessage);
                    return prior;
                }

                if (report && report.results && Array.isArray(report.results) && report.results.length > 0) {
                    let docReport = report.results[0];
                    if (docReport.messages && Array.isArray(docReport.messages)) {
                        const diagnostics = prior ? [...prior] : [];
                        docReport.messages.forEach((problem) => {
                            if (problem) {
                                diagnostics.push(makeDiagnostic(problem, file));
                                recordCodeAction(problem, file);
                            }
                        });
                        return diagnostics;
                    }
                }
            } catch (e) {
                info.project.projectService.logger.info(`eslint-language service error: ${e.toString()}`);
                info.project.projectService.logger.info(`Stack trace: ${e.stack}`);
            }
            return prior;
        };

        proxy.getCodeFixesAtPosition = function (fileName: string, start: number, end: number, errorCodes: ReadonlyArray<number>, formatOptions: ts.FormatCodeSettings, preferences: ts.UserPreferences): ReadonlyArray<ts.CodeFixAction> {
            let prior = oldLS.getCodeFixesAtPosition(fileName, start, end, errorCodes, formatOptions, preferences);
            if (config.supressWhileTypeErrorsPresent && prior.length > 0) {
                return prior;
            }
            info.project.projectService.logger.info("tslint-language-service getCodeFixes " + errorCodes[0]);
            let documentFixes = codeFixActions.get(fileName);

            if (documentFixes) {
                const fixes = prior ? [...prior] : [];

                let problem = documentFixes.get(computeKey(start, end));
                if (problem) {
                    addRuleFailureFix(fixes, problem, fileName);
                    addRuleFailureFixAll(fixes, problem.ruleId, documentFixes, fileName);
                }
                addAllAutoFixable(fixes, documentFixes, fileName);
                if (problem) {
                    addDisableRuleFix(fixes, problem, fileName, oldLS.getProgram().getSourceFile(fileName));
                }

                return fixes;
            }

            return prior;
        }

        return proxy;
    }

    return { create };
}

export = init;
