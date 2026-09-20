import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** Follow static, type-only, re-export, and literal dynamic imports from every entrypoint. */
export function unreachableModules(sourceFiles, entrypoints, compilerOptions = {}) {
  const sourceSet = new Set(sourceFiles.map((file) => resolve(file)));
  const visited = new Set();
  const pending = entrypoints.map((file) => resolve(file));
  while (pending.length > 0) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      let specifier;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        specifier = node.moduleSpecifier;
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        specifier = node.arguments[0];
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
        specifier = node.argument.literal;
      }
      if (specifier && ts.isStringLiteralLike(specifier)) {
        const imported = ts.resolveModuleName(specifier.text, file, {
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          ...compilerOptions,
        }, ts.sys).resolvedModule;
        if (imported && sourceSet.has(resolve(imported.resolvedFileName))) {
          pending.push(resolve(imported.resolvedFileName));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...sourceSet].filter((file) => !visited.has(file)).sort();
}

function sourceFilesIn(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFilesIn(file);
    return [".ts", ".tsx"].includes(extname(file)) && !file.endsWith(".d.ts") ? [file] : [];
  });
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const sources = ["src", "web"].flatMap((directory) => sourceFilesIn(resolve(root, directory)));
  const tests = ["tests", "web"].flatMap((directory) => sourceFilesIn(resolve(root, directory)))
    .filter((file) => /\.test\.tsx?$/.test(file));
  // The application and separately bundled website are runtime roots. qmux has
  // no second webview entry: the global task launcher renders inside the main
  // window's tree, so src/main.tsx already reaches it.
  // Tests are deliberate roots too: helpers supporting independent contracts
  // should not be deleted merely because the current UI does not import them.
  const roots = ["src/main.tsx", "web/server.tsx"]
    .map((file) => resolve(root, file));
  const configPath = resolve(root, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  if (parsed.errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(parsed.errors, {
    getCanonicalFileName: (file) => file,
    getCurrentDirectory: () => root,
    getNewLine: () => "\n",
  }));
  const unused = unreachableModules([...new Set([...sources, ...tests])], [...roots, ...tests], parsed.options);
  if (unused.length > 0) {
    process.stderr.write(`Modules unreachable from app, browser, website, or tests:\n${unused.map((file) => `  ${relative(root, file)}`).join("\n")}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("All first-party TypeScript modules are reachable from an entrypoint or test.\n");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
