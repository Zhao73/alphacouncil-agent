/**
 * Small, explicit filesystem portability boundary for PersonaPack v3 evidence writes.
 *
 * POSIX directory fsync is part of the crash-consistency protocol. Windows does not
 * provide an equivalent directory fsync through Node on every supported filesystem;
 * only that known platform limitation is tolerated. File fsync is deliberately not
 * wrapped here and must continue to fail closed everywhere else.
 */

const WINDOWS_UNSUPPORTED_DIRECTORY_FSYNC = new Set(["EPERM", "EINVAL", "ENOTSUP"]);

export function isUnsupportedWindowsDirectoryFsync(error, platform = process.platform) {
  return platform === "win32" && WINDOWS_UNSUPPORTED_DIRECTORY_FSYNC.has(error?.code);
}

export function fsyncDirectoryStrictly(dir, {
  platform = process.platform,
  openImpl,
  fsyncImpl,
  closeImpl,
} = {}) {
  if (typeof openImpl !== "function" || typeof fsyncImpl !== "function" || typeof closeImpl !== "function") {
    throw new TypeError("fsyncDirectoryStrictly requires filesystem implementations");
  }
  // Opening is intentionally outside the compatibility catch: an inaccessible or
  // non-directory target is not a Windows directory-fsync capability limitation.
  const descriptor = openImpl(dir);
  try {
    fsyncImpl(descriptor);
    return "fsynced";
  } catch (error) {
    if (isUnsupportedWindowsDirectoryFsync(error, platform)) return "windows_directory_fsync_unsupported";
    throw error;
  } finally {
    closeImpl(descriptor);
  }
}

export function privateKeyPermissionPolicy(mode, { platform = process.platform } = {}) {
  if (platform === "win32") {
    return Object.freeze({
      policy: "windows_acl_not_verified",
      posix_mode_checked: false,
    });
  }
  if ((mode & 0o077) !== 0) throw new Error("private-key file permissions must deny group and other access");
  return Object.freeze({
    policy: "posix_owner_only",
    posix_mode_checked: true,
  });
}
