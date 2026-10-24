import * as FileSystem from 'expo-file-system';
import { discardPhoto, purgeProofPhotoCache } from '../src/pod/photo';

const { __files: files, __folders: folders } = FileSystem as unknown as {
  __files: Set<string>;
  __folders: Set<string>;
};

beforeEach(() => {
  files.clear();
  folders.clear();
});

it('deletes a proof photo, and a photo already gone is not an error', () => {
  files.add('file:///cache/ImageManipulator/a.jpg');
  discardPhoto('file:///cache/ImageManipulator/a.jpg');
  expect(files.size).toBe(0);
  expect(() => discardPhoto('file:///cache/ImageManipulator/a.jpg')).not.toThrow();
});

it('sweeps the camera and manipulator caches at start, and nothing else', () => {
  folders.add('file:///cache/Camera');
  folders.add('file:///cache/ImageManipulator');
  files.add('file:///cache/Camera/original.jpg');
  files.add('file:///cache/ImageManipulator/left-by-a-crash.jpg');
  files.add('file:///cache/other/keep.json');
  purgeProofPhotoCache();
  expect([...files]).toEqual(['file:///cache/other/keep.json']);
  expect(folders.size).toBe(0);
});
