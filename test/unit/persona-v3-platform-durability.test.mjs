import test from "node:test";
import assert from "node:assert/strict";

import { fsyncDirectory as fsyncAcquisitionDirectory } from "../../mcp/lib/personas-v3/source-acquisition.mjs";
import { fsyncDirectory as fsyncAdjudicationDirectory } from "../../mcp/lib/personas-v3/source-adjudication.mjs";
import {
  fsyncDirectoryStrictly,
  privateKeyPermissionPolicy,
} from "../../mcp/lib/personas-v3/platform-durability.mjs";

function codedError(code) {
  const error = new Error(`fixture ${code}`);
  error.code = code;
  return error;
}

test("directory fsync tolerates only documented Windows capability errors after a successful open", () => {
  for (const code of ["EPERM", "EINVAL", "ENOTSUP"]) {
    let closed = 0;
    assert.equal(fsyncDirectoryStrictly("directory", {
      platform: "win32",
      openImpl: () => 41,
      fsyncImpl: () => { throw codedError(code); },
      closeImpl: (descriptor) => { assert.equal(descriptor, 41); closed += 1; },
    }), "windows_directory_fsync_unsupported");
    assert.equal(closed, 1);
  }
});

test("directory fsync never hides other failures or an open failure", () => {
  for (const platform of ["linux", "darwin", "win32"]) {
    assert.throws(() => fsyncDirectoryStrictly("directory", {
      platform,
      openImpl: () => 42,
      fsyncImpl: () => { throw codedError("EIO"); },
      closeImpl: () => {},
    }), (error) => error.code === "EIO");
  }
  assert.throws(() => fsyncDirectoryStrictly("directory", {
    platform: "win32",
    openImpl: () => { throw codedError("EPERM"); },
    fsyncImpl: () => { throw new Error("must not run"); },
    closeImpl: () => { throw new Error("must not run"); },
  }), (error) => error.code === "EPERM");
  assert.throws(() => fsyncDirectoryStrictly("directory", {
    platform: "linux",
    openImpl: () => 42,
    fsyncImpl: () => { throw codedError("EPERM"); },
    closeImpl: () => {},
  }), (error) => error.code === "EPERM");
});

test("source acquisition and adjudication retain the same bounded directory-fsync policy", () => {
  for (const fsyncDirectory of [fsyncAcquisitionDirectory, fsyncAdjudicationDirectory]) {
    assert.equal(fsyncDirectory("directory", {
      platform: "win32",
      openImpl: () => 43,
      fsyncImpl: () => { throw codedError("EINVAL"); },
      closeImpl: () => {},
    }), "windows_directory_fsync_unsupported");
    assert.throws(() => fsyncDirectory("directory", {
      platform: "win32",
      openImpl: () => 43,
      fsyncImpl: () => { throw codedError("EBADF"); },
      closeImpl: () => {},
    }), (error) => error.code === "EBADF");
  }
});

test("private-key policy is strict on POSIX and explicit rather than fictitious on Windows", () => {
  assert.deepEqual(privateKeyPermissionPolicy(0o600, { platform: "linux" }), {
    policy: "posix_owner_only", posix_mode_checked: true,
  });
  assert.throws(() => privateKeyPermissionPolicy(0o640, { platform: "darwin" }), /deny group and other access/);
  assert.deepEqual(privateKeyPermissionPolicy(0o666, { platform: "win32" }), {
    policy: "windows_acl_not_verified", posix_mode_checked: false,
  });
});
