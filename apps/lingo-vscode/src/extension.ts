// VS Code client for the Lingo language server. The server is bundled into
// this extension at build time (server/server.cjs — see scripts/bundle-server.mjs),
// so the same path works from the repo AND inside the packaged .vsix.
import * as vscode from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from 'vscode-languageclient/node';

let client: LanguageClient | null = null;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const serverPath = vscode.Uri.joinPath(context.extensionUri, 'server', 'server.cjs').fsPath;

  const serverOptions: ServerOptions = {
    run: { module: serverPath, transport: TransportKind.stdio },
    debug: { module: serverPath, transport: TransportKind.stdio, options: { execArgv: ['--inspect=6010'] } },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: 'lingo' }],
  };

  client = new LanguageClient('lingoLsp', 'Lingo Language Server', serverOptions, clientOptions);
  await client.start();

  context.subscriptions.push(
    vscode.commands.registerCommand('lingo.restartServer', async () => {
      await client?.restart();
      vscode.window.showInformationMessage('Lingo language server restarted.');
    }),
  );
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
