import * as vscode from 'vscode';
import * as AdmZip from 'adm-zip';

function parseDtype(dtypeCode: string): string {
  // NumPy dtype format: [byte-order][type][size]
  // byte-order: '<' (little-endian), '>' (big-endian), '=' (native), '|' (not applicable)
  // type: 'i' (int), 'u' (uint), 'f' (float), 'c' (complex), 'b' (bytes), 'S' (string), 'U' (unicode), 'V' (void), 'O' (object)
  // size: number of bytes

  if (!dtypeCode || dtypeCode === 'unknown') return dtypeCode;

  const byteOrder = dtypeCode.charAt(0);
  const typeChar = dtypeCode.charAt(1);
  const sizeMatch = dtypeCode.match(/\d+/);
  const sizeBytes = sizeMatch ? parseInt(sizeMatch[0]) : 0;

  let endianness = '';
  switch (byteOrder) {
    case '<': endianness = 'little-endian'; break;
    case '>': endianness = 'big-endian'; break;
    case '=': endianness = 'native'; break;
    case '|': endianness = 'N/A'; break;
  }

  let typeName = '';
  switch (typeChar) {
    case 'i': typeName = 'int'; break;
    case 'u': typeName = 'uint'; break;
    case 'f': typeName = 'float'; break;
    case 'c': typeName = 'complex'; break;
    case 'b': typeName = 'bytes'; break;
    case 'S': typeName = 'string'; break;
    case 'U': typeName = 'unicode'; break;
    case 'V': typeName = 'void'; break;
    case 'O': typeName = 'object'; break;
    case 'd': typeName = 'float'; break; // for 'd' = float64
    case 'e': typeName = 'float'; break; // for 'e' = float16
    default: return dtypeCode;
  }

  let humanReadable = '';
  if (typeChar === 'b' || typeChar === 'S') {
    // bytes and strings don't use standard int sizes
    if (typeChar === 'b') {
      humanReadable = sizeBytes === 1 ? 'int8' : `bytes${sizeBytes * 8}`;
    } else {
      humanReadable = `string(${sizeBytes})`;
    }
  } else if (typeChar === 'd') {
    humanReadable = 'float64';
  } else if (typeChar === 'e') {
    humanReadable = 'float16';
  } else {
    // Standard numeric types
    const bits = sizeBytes * 8;
    humanReadable = `${typeName}${bits}`;
  }

  if (endianness && endianness !== 'N/A') {
    return `${dtypeCode} (${humanReadable}, ${endianness})`;
  }
  return `${dtypeCode} (${humanReadable})`;
}

function parseNpyHeader(buffer: Buffer): { shape: string; dtype: string } {
  try {
    if (buffer.length < 10) {
      return { shape: '?', dtype: 'too short' };
    }

    // Check magic bytes: \x93NUMPY (0x93 0x4E 0x55 0x4D 0x50 0x59)
    const expectedMagic = [0x93, 0x4E, 0x55, 0x4D, 0x50, 0x59];
    for (let i = 0; i < 6; i++) {
      if (buffer[i] !== expectedMagic[i]) {
        return { shape: '?', dtype: `magic mismatch at ${i}: got ${buffer[i]}, expected ${expectedMagic[i]}` };
      }
    }

    // Check version
    const major = buffer[6];
    const minor = buffer[7];

    let headerLen: number;
    let headerStart: number;

    if (major === 1) {
      // .npy v1.0: header length is 2 bytes (uint16) at offset 8
      headerLen = buffer.readUInt16LE(8);
      headerStart = 10;
    } else if (major === 2) {
      // .npy v2.0: header length is 4 bytes (uint32) at offset 8
      headerLen = buffer.readUInt32LE(8);
      headerStart = 12;
    } else {
      return { shape: '?', dtype: `unknown v${major}.${minor}` };
    }

    if (buffer.length < headerStart + headerLen) {
      return { shape: '?', dtype: `header too long: need ${headerStart + headerLen}, got ${buffer.length}` };
    }

    // Read header string (Latin1 for binary safety)
    const headerStr = buffer.slice(headerStart, headerStart + headerLen).toString('latin1');

    // Parse Python dict-like header using regex
    // Format: {'descr': '<f8', 'fortran_order': False, 'shape': (10, 28, 28), }

    // Parse dtype - extract from "descr': '<dtype>'"
    let dtype = 'unknown';
    const descrIndex = headerStr.indexOf("descr': '");
    if (descrIndex !== -1) {
      const afterDescr = headerStr.substring(descrIndex + "descr': '".length);
      const closeQuoteIndex = afterDescr.indexOf("'");
      if (closeQuoteIndex !== -1) {
        dtype = afterDescr.substring(0, closeQuoteIndex).trim();
      }
    }

    // Parse shape - look for "shape': (dim1, dim2, ...)" or "shape': ()" for scalars
    const shapeMatch = headerStr.match(/shape['"]\s*:\s*\(([^)]*)\)/);
    let shape = '?';
    if (shapeMatch) {
      const shapeContents = shapeMatch[1];
      if (!shapeContents || shapeContents.trim() === '') {
        // Empty shape = scalar
        shape = 'scalar';
      } else {
        // Split by comma, clean up each part, filter empty
        const shapeParts = shapeContents
          .split(',')
          .map(s => s.trim())
          .filter(s => s !== '');
        shape = shapeParts.join(', ');
      }
    }

    return { shape: `[${shape}]`, dtype: parseDtype(dtype) };
  } catch (error) {
    return { shape: '?', dtype: 'parse error' };
  }
}

class NpzContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    try {
      const zip = new AdmZip.default(uri.fsPath);
      const entries = zip.getEntries();

      const rows: string[] = [];

      for (const entry of entries) {
        if (!entry.entryName.endsWith('.npy')) continue;

        const buffer = zip.readFile(entry)!;
        const header = parseNpyHeader(buffer);

        const safeShape = header.shape.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const safeDtype = header.dtype.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        rows.push(`
          <tr>
            <td>${entry.entryName.replace('.npy', '')}</td>
            <td>${safeShape}</td>
            <td>${safeDtype}</td>
          </tr>
        `);
      }

      return `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body {
              font-family: var(--vscode-font-family);
              color: var(--vscode-foreground);
              background-color: var(--vscode-editor-background);
              padding: 20px;
            }
            h1 {
              font-size: 24px;
              margin-bottom: 20px;
              color: var(--vscode-foreground);
            }
            table {
              border-collapse: collapse;
              width: 100%;
              max-width: 800px;
            }
            th {
              text-align: left;
              border-bottom: 2px solid var(--vscode-editor-border);
              padding: 10px;
              font-weight: bold;
              color: var(--vscode-foreground);
            }
            td {
              padding: 10px;
              border-bottom: 1px solid var(--vscode-editor-border);
            }
            tr:hover {
              background-color: var(--vscode-editor-inactiveSelectionBackground);
            }
          </style>
        </head>
        <body>
          <h1>NPZ Contents: ${uri.path.split('/').pop()}</h1>
          <table>
            <thead><tr><th>Variable</th><th>Shape</th><th>Dtype</th></tr></thead>
            <tbody>${rows.join('')}</tbody>
          </table>
        </body>
        </html>
      `;
    } catch (error) {
      return `
        <!DOCTYPE html>
        <html>
        <body style="color: var(--vscode-errorForeground); padding: 20px;">
          <h1>Error reading NPZ file</h1>
          <p>${error instanceof Error ? error.message : String(error)}</p>
        </body>
        </html>
      `;
    }
  }
}

class NpzDocument implements vscode.CustomDocument {
  readonly uri: vscode.Uri;
  readonly dispose: () => void;

  constructor(uri: vscode.Uri) {
    this.uri = uri;
    this.dispose = () => {};
  }
}

class NpzEditor implements vscode.CustomReadonlyEditorProvider<NpzDocument> {
  constructor(private readonly contentProvider: NpzContentProvider) {}

  async openCustomDocument(
    uri: vscode.Uri,
    openContext: vscode.CustomDocumentOpenContext,
    token: vscode.CancellationToken
  ): Promise<NpzDocument> {
    return new NpzDocument(uri);
  }

  async resolveCustomEditor(
    document: NpzDocument,
    webviewPanel: vscode.WebviewPanel,
    token: vscode.CancellationToken
  ): Promise<void> {
    const content = await this.contentProvider.provideTextDocumentContent(document.uri);
    webviewPanel.webview.html = content;
  }
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new NpzContentProvider();
  const editorProvider = new NpzEditor(provider);

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('npz', provider),
    vscode.window.registerCustomEditorProvider('npz.preview', editorProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );
}

export function deactivate() {}
