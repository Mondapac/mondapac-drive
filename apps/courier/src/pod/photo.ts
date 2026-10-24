import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import type { PhotoFile } from '../api/client';

/** Long edge and JPEG quality of an uploaded proof photo: readable, and small on mobile data. */
export const PROOF_PHOTO_MAX_WIDTH = 1280;
export const PROOF_PHOTO_QUALITY = 0.6;

/**
 * Resizes and re-encodes a camera photo. Re-encoding also drops the EXIF block, so no GPS
 * position or device data leaves the phone with the photo.
 */
export async function compressProofPhoto(uri: string, width: number): Promise<PhotoFile> {
  const context = ImageManipulator.manipulate(uri);
  if (width > PROOF_PHOTO_MAX_WIDTH) context.resize({ width: PROOF_PHOTO_MAX_WIDTH });
  const image = await context.renderAsync();
  const saved = await image.saveAsync({ compress: PROOF_PHOTO_QUALITY, format: SaveFormat.JPEG });
  return { uri: saved.uri, mimeType: 'image/jpeg' };
}
