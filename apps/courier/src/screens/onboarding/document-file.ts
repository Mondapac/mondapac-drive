import { getDocumentAsync } from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import type { DocumentFile } from '../../api/client';

/** The most fleet takes per document (`POST /fleet/courier/me/documents`). */
export const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;

/** Long edge and JPEG quality of a document image: small print stays readable for the operator. */
export const DOCUMENT_IMAGE_MAX_WIDTH = 2048;
export const DOCUMENT_IMAGE_QUALITY = 0.8;

/** The file types fleet accepts; the server checks the bytes again. */
const PICKABLE = ['application/pdf', 'image/jpeg', 'image/png'] as const;

/** The cache folder the document picker copies a chosen file into. */
const PICKER_CACHE_FOLDER = 'DocumentPicker';

export type PickResult =
  | { kind: 'picked'; file: DocumentFile }
  | { kind: 'cancelled' }
  | { kind: 'too-large' }
  | { kind: 'unsupported' };

/**
 * Re-encodes a document image as JPEG, which also drops its EXIF block (GPS position, device), so
 * only the picture of the document leaves the phone. The original is deleted.
 */
export async function encodeDocumentImage(uri: string, width?: number): Promise<DocumentFile> {
  try {
    let image = await ImageManipulator.manipulate(uri).renderAsync();
    // A picked file's width is known only once it is decoded; only a larger one is scaled down.
    if ((width ?? image.width) > DOCUMENT_IMAGE_MAX_WIDTH) {
      image = await ImageManipulator.manipulate(uri)
        .resize({ width: DOCUMENT_IMAGE_MAX_WIDTH })
        .renderAsync();
    }
    const saved = await image.saveAsync({
      compress: DOCUMENT_IMAGE_QUALITY,
      format: SaveFormat.JPEG,
    });
    return { uri: saved.uri, name: 'document.jpg', mimeType: 'image/jpeg' };
  } finally {
    discardDocumentFile(uri);
  }
}

/** Lets the courier choose a PDF or an image from the phone's files. */
export async function pickDocumentFile(): Promise<PickResult> {
  const picked = await getDocumentAsync({
    type: [...PICKABLE],
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (picked.canceled) return { kind: 'cancelled' };
  const asset = picked.assets[0];
  if (!asset) return { kind: 'cancelled' };
  const mimeType = PICKABLE.find((type) => type === asset.mimeType);
  if (!mimeType) {
    discardDocumentFile(asset.uri);
    return { kind: 'unsupported' };
  }
  if (mimeType === 'application/pdf') {
    if (asset.size === undefined || asset.size > DOCUMENT_MAX_BYTES) {
      discardDocumentFile(asset.uri);
      return { kind: 'too-large' };
    }
    return { kind: 'picked', file: { uri: asset.uri, name: 'document.pdf', mimeType } };
  }
  // An image is re-encoded, which keeps it far under the limit and strips its metadata.
  return { kind: 'picked', file: await encodeDocumentImage(asset.uri) };
}

/**
 * Deletes a document file from the device (as proof photos, security review L2): a licence or
 * insurance certificate stays on the phone no longer than it takes to upload it. A file already
 * gone is not an error.
 */
export function discardDocumentFile(uri: string): void {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // Nothing to delete, or no file system (the web preview); the cache sweep catches the rest.
  }
}

/** Empties the picker's cache folder, for a file left behind by a crash or a kill. */
export function purgeDocumentCache(): void {
  try {
    const folder = new Directory(Paths.cache, PICKER_CACHE_FOLDER);
    if (folder.exists) folder.delete();
  } catch {
    // As above: the sweep never blocks onboarding.
  }
}
