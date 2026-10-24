import { Directory, File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import type { PhotoFile } from '../api/client';

/** Long edge and JPEG quality of an uploaded proof photo: readable, and small on mobile data. */
export const PROOF_PHOTO_MAX_WIDTH = 1280;
export const PROOF_PHOTO_QUALITY = 0.6;

/** The cache folders the camera and the image manipulator write to; only proof photos use them. */
const PHOTO_CACHE_FOLDERS = ['Camera', 'ImageManipulator'] as const;

/**
 * Resizes and re-encodes a camera photo. Re-encoding also drops the EXIF block, so no GPS
 * position or device data leaves the phone with the photo. The full-size original is deleted.
 */
export async function compressProofPhoto(uri: string, width: number): Promise<PhotoFile> {
  try {
    const context = ImageManipulator.manipulate(uri);
    if (width > PROOF_PHOTO_MAX_WIDTH) context.resize({ width: PROOF_PHOTO_MAX_WIDTH });
    const image = await context.renderAsync();
    const saved = await image.saveAsync({ compress: PROOF_PHOTO_QUALITY, format: SaveFormat.JPEG });
    return { uri: saved.uri, mimeType: 'image/jpeg' };
  } finally {
    discardPhoto(uri);
  }
}

/**
 * Deletes a proof photo from the device (security review L2): a photo of a customer's door stays
 * on the phone no longer than it takes to upload it. A file already gone is not an error.
 */
export function discardPhoto(uri: string): void {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // Nothing to delete, or no file system (the web preview); the next start sweeps the cache.
  }
}

/** Empties the photo cache folders at start, for a photo left behind by a crash or a kill. */
export function purgeProofPhotoCache(): void {
  for (const name of PHOTO_CACHE_FOLDERS) {
    try {
      const folder = new Directory(Paths.cache, name);
      if (folder.exists) folder.delete();
    } catch {
      // As above: the sweep never blocks the app from starting.
    }
  }
}
