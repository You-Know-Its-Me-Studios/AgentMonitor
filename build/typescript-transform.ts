import ts from 'typescript';

// TypeScript's in-process compiler keeps builds usable on restricted Windows tokens
// where child-process stdio pipes (and esbuild's service) are unavailable.
export function typescriptTransform() {
  return {
    name: 'typescript-in-process',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      const source = /\.[cm]?tsx?(?:\?|$)/.test(id) && !id.replaceAll('\\', '/').includes('/node_modules/');
      const environment = /\.[cm]?[jt]sx?(?:\?|$)/.test(id) && code.includes('process.env.NODE_ENV');
      if (!source && !environment) return null;
      const result = ts.transpileModule(code, {
        fileName: id,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, sourceMap: true, inlineSources: true, esModuleInterop: true, allowJs: true },
        transformers: { before: [context => root => {
          const visit = (node: ts.Node): ts.VisitResult<ts.Node> => {
            if (ts.isPropertyAccessExpression(node) && node.name.text === 'NODE_ENV' && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'env' && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'process') return ts.factory.createStringLiteral('production');
            return ts.visitEachChild(node, visit, context);
          };
          return ts.visitNode(root, visit) as ts.SourceFile;
        }] }
      });
      return { code: result.outputText, map: result.sourceMapText ? JSON.parse(result.sourceMapText) : null };
    }
  };
}
