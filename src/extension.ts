import * as vscode from 'vscode';
import * as yauzl from 'yauzl';

type NpyHeader = {
  shape: string;
  dtype: string;
  dataOffset: number;
};

type PreviewPlan = {
  byteOrder: string;
  typeChar: string;
  sizeBytes: number;
  totalElements: number;
  previewCount: number;
};

const LARGE_ENTRY_THRESHOLD = 8 * 1024 * 1024;

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
    case 'b': typeName = 'bool'; break;
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
    // booleans and strings don't use standard int sizes
    if (typeChar === 'b') {
      humanReadable = 'bool';
    } else {
      humanReadable = `string(${sizeBytes})`;
    }
  } else if (typeChar === 'U') {
    humanReadable = `unicode(${sizeBytes})`;
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

function parseNpyHeader(buffer: Buffer): NpyHeader {
  try {
    if (buffer.length < 10) {
      return { shape: '?', dtype: 'too short', dataOffset: 0 };
    }

    // Check magic bytes: \x93NUMPY (0x93 0x4E 0x55 0x4D 0x50 0x59)
    const expectedMagic = [0x93, 0x4E, 0x55, 0x4D, 0x50, 0x59];
    for (let i = 0; i < 6; i++) {
      if (buffer[i] !== expectedMagic[i]) {
        return { shape: '?', dtype: `magic mismatch at ${i}: got ${buffer[i]}, expected ${expectedMagic[i]}`, dataOffset: 0 };
      }
    }

    // Check version
    const major = buffer[6];
    const minor = buffer[7];

    let headerLen: number;
    let headerStart: number;
    let headerEncoding: BufferEncoding;

    if (major === 1) {
      // .npy v1.0: header length is 2 bytes (uint16) at offset 8
      headerLen = buffer.readUInt16LE(8);
      headerStart = 10;
      headerEncoding = 'latin1';
    } else if (major === 2 || major === 3) {
      // .npy v2.0/v3.0: header length is 4 bytes (uint32) at offset 8
      headerLen = buffer.readUInt32LE(8);
      headerStart = 12;
      headerEncoding = major === 3 ? 'utf8' : 'latin1';
    } else {
      return { shape: '?', dtype: `unknown v${major}.${minor}`, dataOffset: 0 };
    }

    if (buffer.length < headerStart + headerLen) {
      return { shape: '?', dtype: `header too long: need ${headerStart + headerLen}, got ${buffer.length}`, dataOffset: 0 };
    }

    // Read header string using the version-appropriate encoding.
    const headerStr = buffer.slice(headerStart, headerStart + headerLen).toString(headerEncoding);

    // Parse Python dict-like header using regex.
    // Format: {'descr': '<f8', 'fortran_order': False, 'shape': (10, 28, 28), }

    // Parse dtype - extract from "descr: '<dtype>'" or "descr: \"<dtype>\""
    let dtype = 'unknown';
    const descrMatch = headerStr.match(/descr['"]\s*:\s*['"]([^'"]+)['"]/);
    if (descrMatch) {
      dtype = descrMatch[1].trim();
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

    return { shape: `[${shape}]`, dtype: parseDtype(dtype), dataOffset: headerStart + headerLen };
  } catch (error) {
    return { shape: '?', dtype: 'parse error', dataOffset: 0 };
  }
}

function parsePreviewPlan(header: NpyHeader, buffer: Buffer): PreviewPlan | null {
  const dtypeMatch = header.dtype.match(/^([<>|=|])([ifuScVOdb])(\d+)?/);
  if (!dtypeMatch) return null;

  const [, byteOrder, typeChar, sizeStr] = dtypeMatch;
  const sizeBytes = sizeStr ? parseInt(sizeStr) : 8;

  const shapeParts = header.shape.match(/\[(.*?)\]/)?.[1]?.split(',').map(s => s.trim()).filter(s => s !== '') || ['scalar'];
  const isScalar = shapeParts.length === 1 && shapeParts[0] === 'scalar';
  const totalElements = isScalar ? 1 : shapeParts.reduce((acc: number, dim: string) => acc * parseInt(dim), 1);

  return {
    byteOrder,
    typeChar,
    sizeBytes,
    totalElements,
    previewCount: Math.min(totalElements, 100),
  };
}

function getNpyPreviewByteCount(header: NpyHeader, buffer: Buffer): number | null {
  const plan = parsePreviewPlan(header, buffer);
  if (!plan) return null;
  return header.dataOffset + (plan.previewCount * plan.sizeBytes);
}

async function readNpyEntryPreview(zipFile: yauzl.ZipFile, entry: yauzl.Entry): Promise<{ buffer: Buffer; header: NpyHeader; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }

      if (!stream) {
        reject(new Error(`Unable to read ZIP entry ${entry.fileName}`));
        return;
      }

      const chunks: Buffer[] = [];
      let totalLength = 0;
      let header: NpyHeader | null = null;
      let previewByteCount = 0;
      let resolved = false;

      const finish = (buffer: Buffer, currentHeader: NpyHeader, truncated: boolean) => {
        if (resolved) return;
        resolved = true;
        resolve({ buffer, header: currentHeader, truncated });
      };

      const fail = (err: unknown) => {
        if (resolved) return;
        resolved = true;
        reject(err);
      };

      stream.on('data', (chunk: Buffer | Uint8Array) => {
        if (resolved) return;

        const buf = Buffer.from(chunk);
        chunks.push(buf);
        totalLength += buf.length;

        if (!header) {
          const probe = Buffer.concat(chunks, totalLength);
          const parsed = parseNpyHeader(probe);
          if (parsed.dtype !== 'too short' && !parsed.dtype.startsWith('header too long') && !parsed.dtype.startsWith('magic mismatch') && !parsed.dtype.startsWith('unknown v') && parsed.dtype !== 'parse error') {
            header = parsed;
            previewByteCount = getNpyPreviewByteCount(header, probe) ?? 0;
          }
        }

        if (header && previewByteCount > 0 && totalLength >= previewByteCount && entry.uncompressedSize > LARGE_ENTRY_THRESHOLD) {
          stream.destroy();
          finish(Buffer.concat(chunks, totalLength), header, true);
        }
      });

      stream.on('error', fail);
      stream.on('end', () => {
        if (resolved) return;
        const probe = Buffer.concat(chunks, totalLength);
        const parsed = header ?? parseNpyHeader(probe);
        finish(probe, parsed, entry.uncompressedSize > 0 && totalLength < entry.uncompressedSize);
      });
    });
  });
}

function openZipFile(filePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      filePath,
      {
        lazyEntries: true,
        autoClose: true,
      },
      (error: Error | null, zipFile: yauzl.ZipFile | undefined) => {
        if (error) {
          reject(error);
          return;
        }

        if (!zipFile) {
          reject(new Error('Unable to open ZIP archive'));
          return;
        }

        resolve(zipFile);
      }
    );
  });
}

function readZipEntryBuffer(zipFile: yauzl.ZipFile, entry: yauzl.Entry): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }

      if (!stream) {
        reject(new Error(`Unable to read ZIP entry ${entry.fileName}`));
        return;
      }

      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer | Uint8Array) => {
        chunks.push(Buffer.from(chunk));
      });
      stream.on('error', reject);
      stream.on('end', () => {
        resolve(Buffer.concat(chunks));
      });
    });
  });
}

async function readNpzEntries(filePath: string): Promise<Array<{ entryName: string; buffer: Buffer }>> {
  const zipFile = await openZipFile(filePath);

  return new Promise((resolve, reject) => {
    const entries: Array<{ entryName: string; buffer: Buffer }> = [];

    zipFile.on('error', reject);

    zipFile.on('entry', (entry: yauzl.Entry) => {
      if (entry.fileName.endsWith('/') || !entry.fileName.endsWith('.npy')) {
        zipFile.readEntry();
        return;
      }

      readZipEntryBuffer(zipFile, entry)
        .then((buffer) => {
          entries.push({ entryName: entry.fileName, buffer });
          zipFile.readEntry();
        })
        .catch((error) => {
          zipFile.close();
          reject(error);
        });
    });

    zipFile.on('end', () => {
      resolve(entries);
    });

    zipFile.readEntry();
  });
}

function generateDataPreview(
  buffer: Buffer,
  header: { shape: string; dtype: string },
  varName: string,
  options?: { includeStats?: boolean }
): { html: string; stats?: any } {
  try {
    // Parse dtype to get type info
    const dtypeMatch = header.dtype.match(/^([<>|=|])([ifuScVOdUb])(\d+)?/);
    if (!dtypeMatch) return { html: '<p>Unable to parse data: invalid dtype</p>' };

    const [_, byteOrder, typeChar, sizeStr] = dtypeMatch;
    const dtypeSize = sizeStr ? parseInt(sizeStr) : 8;
    const itemSizeBytes = typeChar === 'U' ? dtypeSize * 4 : dtypeSize;

    // Get data offset
    let dataOffset = 0;
    const major = buffer[6];
    if (major === 1) {
      dataOffset = 10 + buffer.readUInt16LE(8);
    } else if (major === 2) {
      dataOffset = 12 + buffer.readUInt32LE(8);
    }

    const dataView = new DataView(buffer.buffer, buffer.byteOffset + dataOffset);

    // Parse shape to get total elements
    const shapeParts = header.shape.match(/\[(.*?)\]/)?.[1]?.split(',').map(s => s.trim()) || ['scalar'];
    const isScalar = shapeParts.length === 1 && shapeParts[0] === 'scalar';
    const totalElements = isScalar ? 1 : shapeParts.reduce((acc: number, dim: string) => acc * parseInt(dim), 1);

    // Calculate statistics for numeric types
    let statsHtml = '';
    if (options?.includeStats !== false && (['i', 'u', 'f'].includes(typeChar) || typeChar === 'd' || typeChar === 'e')) {
      const stats = calculateStats(dataView, byteOrder, typeChar, itemSizeBytes, totalElements);
      if (stats) {
        statsHtml = `
          <div class="stats">
            <strong>Statistics:</strong><br>
            Min: ${stats.min}<br>
            Max: ${stats.max}<br>
            Mean: ${stats.mean}${stats.std !== undefined ? `<br>Std Dev: ${stats.std}` : ''}
          </div>
        `;
      }
    }

    // Get first 100 values
    const maxPreview = 100;
    const previewCount = Math.min(totalElements, maxPreview);
    const values: any[] = [];

    for (let i = 0; i < previewCount; i++) {
      const val = readDataValue(dataView, byteOrder, typeChar, itemSizeBytes, i);
      values.push(val);
    }

    // Format values for display
    let valuesHtml = '';
    if (previewCount > 20) {
      // Show as table for larger arrays
      const chunkSize = 10;
      const chunks: string[][] = [];
      for (let i = 0; i < values.length; i += chunkSize) {
        chunks.push(values.slice(i, i + chunkSize).map(v => formatValue(v)));
      }
      valuesHtml = chunks.map(chunk => `<div class="value-row">${chunk.join(' ')}</div>`).join('');
    } else {
      valuesHtml = values.map(v => formatValue(v)).join(', ');
    }

    const moreIndicator = totalElements > maxPreview ? `<br><em>(showing first ${maxPreview} of ${totalElements.toLocaleString()} values)</em>` : '';

    return {
      html: `
        <div class="data-preview">
          ${statsHtml}
          <div class="values">
            ${valuesHtml}
          </div>
          ${moreIndicator}
        </div>
      `,
      stats: options?.includeStats === false ? undefined : { min: 0, max: 0, mean: 0 }
    };
  } catch (error) {
    return { html: `<p>Error generating preview: ${error instanceof Error ? error.message : String(error)}</p>` };
  }
}

function calculateStats(dataView: DataView, byteOrder: string, typeChar: string, sizeBytes: number, count: number): { min: number; max: number; mean: number; std?: number } | null {
  if (count === 0 || count > 1000000) return null; // Skip min/max/mean for very large arrays (>1M elements)

  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  const sampleSize = Math.min(count, 10000); // Sample up to 10,000 values for min/max/mean

  for (let i = 0; i < sampleSize; i++) {
    const val = readDataValue(dataView, byteOrder, typeChar, sizeBytes, i);
    if (typeof val === 'number') {
      min = Math.min(min, val);
      max = Math.max(max, val);
      sum += val;
    }
  }

  if (min === Infinity) return null;

  const mean = sum / sampleSize;

  // Calculate standard deviation (only for smaller samples)
  let std = undefined;
  if (count <= 100) {
    const stdSampleSize = Math.min(count, 100);
    let sumSquares = 0;
    for (let i = 0; i < stdSampleSize; i++) {
      const val = readDataValue(dataView, byteOrder, typeChar, sizeBytes, i);
      if (typeof val === 'number') {
        const diff = val - mean;
        sumSquares += diff * diff;
      }
    }
    std = Math.sqrt(sumSquares / stdSampleSize);
  }

  return { min, max, mean, std };
}

function readDataValue(dataView: DataView, byteOrder: string, typeChar: string, sizeBytes: number, index: number): any {
  const offset = index * sizeBytes;

  switch (typeChar) {
    case 'i': // signed integer
      switch (sizeBytes) {
        case 1: return dataView.getInt8(offset);
        case 2: return byteOrder === '<' ? dataView.getInt16(offset, true) : byteOrder === '>' ? dataView.getInt16(offset, false) : dataView.getInt16(offset);
        case 4: return byteOrder === '<' ? dataView.getInt32(offset, true) : byteOrder === '>' ? dataView.getInt32(offset, false) : dataView.getInt32(offset);
        case 8:
          // Int64 not natively supported in DataView, approximate with number
          const low = byteOrder === '<' ? dataView.getUint32(offset, true) : byteOrder === '>' ? dataView.getUint32(offset, false) : dataView.getUint32(offset);
          const high = byteOrder === '<' ? dataView.getInt32(offset + 4, true) : byteOrder === '>' ? dataView.getInt32(offset + 4, false) : dataView.getInt32(offset + 4);
          return (high * 0x100000000) + (low >>> 0);
      }
      break;
    case 'u': // unsigned integer
      switch (sizeBytes) {
        case 1: return dataView.getUint8(offset);
        case 2: return byteOrder === '<' ? dataView.getUint16(offset, true) : byteOrder === '>' ? dataView.getUint16(offset, false) : dataView.getUint16(offset);
        case 4: return byteOrder === '<' ? dataView.getUint32(offset, true) : byteOrder === '>' ? dataView.getUint32(offset, false) : dataView.getUint32(offset);
        case 8:
          // Uint64 not natively supported in DataView, approximate with number
          const low = byteOrder === '<' ? dataView.getUint32(offset, true) : byteOrder === '>' ? dataView.getUint32(offset, false) : dataView.getUint32(offset);
          const high = byteOrder === '<' ? dataView.getUint32(offset + 4, true) : byteOrder === '>' ? dataView.getUint32(offset + 4, false) : dataView.getUint32(offset + 4);
          return (high * 0x100000000) + low;
      }
      break;
    case 'f': // float
      switch (sizeBytes) {
        case 2: return 'float16'; // Float16 not natively supported
        case 4: return byteOrder === '<' ? dataView.getFloat32(offset, true) : byteOrder === '>' ? dataView.getFloat32(offset, false) : dataView.getFloat32(offset);
        case 8: return byteOrder === '<' ? dataView.getFloat64(offset, true) : byteOrder === '>' ? dataView.getFloat64(offset, false) : dataView.getFloat64(offset);
      }
      break;
    case 'd': // double (float64)
      return byteOrder === '<' ? dataView.getFloat64(offset, true) : byteOrder === '>' ? dataView.getFloat64(offset, false) : dataView.getFloat64(offset);
    case 'e': // float16 placeholder
      return 'float16';
    case 'b': // bytes
    case 'S': // string
      return dataView.getUint8(offset);
    case 'U': {
      const charCount = Math.floor(sizeBytes / 4);
      let text = '';
      for (let i = 0; i < charCount; i++) {
        const codePointOffset = offset + (i * 4);
        const codePoint = byteOrder === '>'
          ? dataView.getUint32(codePointOffset, false)
          : dataView.getUint32(codePointOffset, true);
        if (codePoint === 0) continue;
        text += String.fromCodePoint(codePoint);
      }
      return text;
    }
  }

  return '?';
}

function formatValue(val: any): string {
  if (typeof val === 'number') {
    // Format for readability
    if (Number.isInteger(val) && Math.abs(val) > 1000) {
      return val.toLocaleString();
    }
    return parseFloat(val.toFixed(4)).toString();
  }
  return String(val);
}

class NpzContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    try {
      const isNpz = uri.path.endsWith('.npz');
      const rows: string[] = [];

      if (isNpz) {
        // Handle .npz files (ZIP archives with multiple .npy files)
        const zipFile = await openZipFile(uri.fsPath);

        await new Promise<void>((resolve, reject) => {
          zipFile.on('error', reject);

          zipFile.on('entry', (entry: yauzl.Entry) => {
            if (entry.fileName.endsWith('/') || !entry.fileName.endsWith('.npy')) {
              zipFile.readEntry();
              return;
            }

            readNpyEntryPreview(zipFile, entry)
              .then(({ buffer, header, truncated }) => {
                const safeShape = header.shape.replace(/</g, '&lt;').replace(/>/g, '&gt;');
                const safeDtype = header.dtype.replace(/</g, '&lt;').replace(/>/g, '&gt;');
                const varName = entry.fileName.replace(/\.npy$/i, '');
                const dataPreview = generateDataPreview(buffer, header, varName, { includeStats: !truncated });

                rows.push(`
                  <tr class="clickable-row">
                    <td>
                      <details>
                        <summary style="cursor: pointer; outline: none;">${varName}</summary>
                        <div class="preview-content">
                          ${dataPreview.html}
                        </div>
                      </details>
                    </td>
                    <td>${safeShape}</td>
                    <td>${safeDtype}</td>
                  </tr>
                `);

                zipFile.readEntry();
              })
              .catch((error) => {
                zipFile.close();
                reject(error);
              });
          });

          zipFile.on('end', () => resolve());
          zipFile.readEntry();
        });
      } else {
        // Handle .npy files (single array file)
        const fs = await import('fs');
        const buffer = Buffer.from(await fs.promises.readFile(uri.fsPath));
        const header = parseNpyHeader(buffer);

        const safeShape = header.shape.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const safeDtype = header.dtype.replace(/</g, '&lt;').replace(/>/g, '&gt;');

        // Generate data preview
        const dataPreview = generateDataPreview(buffer, header, 'array');

        rows.push(`
          <tr class="clickable-row">
              <td>
                <details>
                    <summary style="cursor: pointer; outline: none;">array ⬇</summary>
                    <div class="preview-content">
                      ${dataPreview.html}
                    </div>
                </details>
              </td>
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
              table-layout: fixed;
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
              vertical-align: top;
              overflow-wrap: anywhere;
            }
            tr:hover {
              background-color: var(--vscode-editor-inactiveSelectionBackground);
            }
            summary:hover {
              background-color: var(--vscode-editor-inactiveSelectionBackground);
            }
            details {
              width: 100%;
            }
            details > summary {
              white-space: nowrap;
              overflow: hidden;
              text-overflow: ellipsis;
            }
            .data-preview {
              margin-top: 20px;
              margin-bottom: 30px;
              padding: 15px;
              background-color: var(--vscode-editor-inactiveSelectionBackground);
              border-radius: 4px;
              max-width: 100%;
              overflow-x: auto;
            }
            .stats {
              margin-bottom: 15px;
              padding: 10px;
              background-color: var(--vscode-editor-background);
              border-radius: 3px;
            }
            .values {
              font-family: monospace;
              font-size: 13px;
              background-color: var(--vscode-editor-background);
              padding: 10px;
              border-radius: 3px;
              white-space: pre-wrap;
              word-break: break-all;
              max-width: 100%;
              overflow-x: auto;
            }
            .value-row {
              margin-bottom: 5px;
            }
          </style>
        </head>
        <body>
          <h1>NPZ Contents: ${uri.path.split('/').pop()}</h1>
          <table>
            <colgroup>
              <col style="width: 46%;">
              <col style="width: 22%;">
              <col style="width: 22%;">
              <col style="width: 10%;">
            </colgroup>
            <thead><tr><th>Variable</th><th>Shape</th><th>Dtype</th><th></th></tr></thead>
            <tbody>${rows.join('')}</tbody>
          </table>
        </body>
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
