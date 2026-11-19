import path from 'node:path';
import {createRequire} from 'node:module';

export function parcelExecutable(workspace) {
  const requireWorkspace = createRequire(path.join(workspace, 'package.json'));
  const requireParcel = createRequire(requireWorkspace.resolve('@parcel/parcel3/package.json'));
  const platformPackage = `@parcel/parcel3-darwin-${process.arch}`;
  return path.join(path.dirname(requireParcel.resolve(`${platformPackage}/package.json`)), 'parcel');
}
