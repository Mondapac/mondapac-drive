import type { DocumentMediaType } from '../domain/documents';

/** The largest document file: a phone photo or a scanned PDF. */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

/** The media type of a file, read from its first bytes rather than from what the client said. */
export function sniffMediaType(file: Buffer): DocumentMediaType | undefined {
  if (file.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (file.length >= 3 && file[0] === 0xff && file[1] === 0xd8 && file[2] === 0xff) {
    return 'image/jpeg';
  }
  if (file.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  return undefined;
}

/** The object-store prefix of a Market's courier documents; a key adds courier and document. */
export const documentPrefix = (marketId: string): string => `fleet/${marketId}`;

/** A downloaded document: its bytes and the media type sniffed when it was stored. */
export interface DocumentFile {
  readonly documentId: string;
  readonly mediaType: DocumentMediaType;
  readonly bytes: Buffer;
}
