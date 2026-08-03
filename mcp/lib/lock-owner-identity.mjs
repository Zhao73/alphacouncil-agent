import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";

const IDENTITY_VERSION = 1;
const HASH = /^sha256:[0-9a-f]{64}$/;
const SOURCE = /^[a-z0-9_.+-]{1,80}$/;
const REASON = /^[a-z0-9_.+-]{1,80}$/;
const COMPARABLE_CAPABILITIES = new Set(["verified", "coarse"]);

function digest(source, value) {
  return `sha256:${createHash("sha256").update(`${source}\0${value}`, "utf8").digest("hex")}`;
}

function available(capability, source, value, extra = {}) {
  return Object.freeze({ capability, source, fingerprint: digest(source, value), ...extra });
}

function unavailable(source, reason) {
  return Object.freeze({ capability: "unavailable", source, reason });
}

function command(file, args) {
  try {
    return String(execFileSync(file, args, {
      encoding: "utf8",
      env: { ...process.env, LANG: "C", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_500,
      windowsHide: true,
    })).trim();
  } catch {
    return null;
  }
}

function read(path) {
  try {
    const value = readFileSync(path, "utf8").trim();
    return value && value.length <= 512 ? value : null;
  } catch {
    return null;
  }
}

function linuxMachineIdentity() {
  const value = read("/etc/machine-id") || read("/var/lib/dbus/machine-id");
  return value
    ? available("verified", "linux_machine_id", value.toLowerCase())
    : unavailable("linux_machine_id", "not_readable");
}

function linuxBootIdentity() {
  const value = read("/proc/sys/kernel/random/boot_id");
  return value
    ? available("verified", "linux_boot_id", value.toLowerCase())
    : unavailable("linux_boot_id", "not_readable");
}

function darwinMachineIdentity() {
  const output = command("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
  const value = output?.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1];
  return value
    ? available("verified", "darwin_ioplatform_uuid", value.toLowerCase())
    : unavailable("darwin_ioplatform_uuid", "not_readable");
}

function darwinBootIdentity() {
  const output = command("/usr/sbin/sysctl", ["-n", "kern.boottime"]);
  const match = output?.match(/sec\s*=\s*(\d+).*usec\s*=\s*(\d+)/);
  return match
    ? available("verified", "darwin_kern_boottime", `${match[1]}.${match[2].padStart(6, "0")}`)
    : unavailable("darwin_kern_boottime", "not_readable");
}

function windowsMachineIdentity() {
  const output = command("reg.exe", [
    "query",
    "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
    "/v",
    "MachineGuid",
  ]);
  const value = output?.match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/i)?.[1]?.trim();
  return value
    ? available("verified", "windows_machine_guid", value.toLowerCase())
    : unavailable("windows_machine_guid", "not_readable");
}

function windowsTicks(script, source) {
  const output = command("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script]);
  const value = output?.match(/(\d{8,})\s*$/)?.[1];
  return value ? available("verified", source, value) : unavailable(source, "not_readable");
}

function windowsBootIdentity() {
  return windowsTicks(
    "((Get-CimInstance -ClassName Win32_OperatingSystem).LastBootUpTime).ToUniversalTime().Ticks",
    "windows_last_boot_ticks",
  );
}

function localBaseIdentity() {
  if (process.platform === "linux") {
    return { machine: linuxMachineIdentity(), boot: linuxBootIdentity() };
  }
  if (process.platform === "darwin") {
    return { machine: darwinMachineIdentity(), boot: darwinBootIdentity() };
  }
  if (process.platform === "win32") {
    return { machine: windowsMachineIdentity(), boot: windowsBootIdentity() };
  }
  return {
    machine: unavailable("platform_machine_identity", "unsupported_platform"),
    boot: unavailable("platform_boot_identity", "unsupported_platform"),
  };
}

let cachedBaseIdentity;

function baseIdentity() {
  if (!cachedBaseIdentity) cachedBaseIdentity = Object.freeze(localBaseIdentity());
  return cachedBaseIdentity;
}

function linuxProcessBirth(pid, boot) {
  const value = read(`/proc/${pid}/stat`);
  const closingParen = value?.lastIndexOf(")") ?? -1;
  if (closingParen < 0) return unavailable("linux_proc_starttime", "not_readable");
  // /proc/<pid>/stat fields after comm begin at field 3; starttime is field 22.
  const startTicks = value.slice(closingParen + 1).trim().split(/\s+/)[19];
  if (!/^\d+$/.test(startTicks || "")) return unavailable("linux_proc_starttime", "not_readable");
  if (boot.capability !== "verified") return unavailable("linux_proc_starttime", "boot_unverifiable");
  return available("verified", "linux_proc_starttime", `${boot.fingerprint}\0${startTicks}`);
}

function darwinProcessBirth(pid, boot) {
  const output = command("/bin/ps", ["-p", String(pid), "-o", "lstart="]);
  const value = output?.replace(/\s+/g, " ").trim();
  if (!value) return unavailable("darwin_ps_lstart", "not_readable");
  if (boot.capability !== "verified") return unavailable("darwin_ps_lstart", "boot_unverifiable");
  // Darwin's dependency-free ps surface exposes birth time only to whole seconds. A
  // mismatch still proves PID reuse; a match is deliberately treated conservatively.
  return available("coarse", "darwin_ps_lstart", `${boot.fingerprint}\0${value}`, { precision_ms: 1_000 });
}

function windowsProcessBirth(pid, boot) {
  if (boot.capability !== "verified") return unavailable("windows_process_start_ticks", "boot_unverifiable");
  const birth = windowsTicks(
    `((Get-Process -Id ${pid} -ErrorAction Stop).StartTime).ToUniversalTime().Ticks`,
    "windows_process_start_ticks",
  );
  if (birth.capability !== "verified") return birth;
  return available("verified", "windows_process_start_ticks", `${boot.fingerprint}\0${birth.fingerprint}`);
}

function processBirthIdentity(pid, boot) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return unavailable("process_birth", "invalid_pid");
  if (process.platform === "linux") return linuxProcessBirth(pid, boot);
  if (process.platform === "darwin") return darwinProcessBirth(pid, boot);
  if (process.platform === "win32") return windowsProcessBirth(pid, boot);
  return unavailable("process_birth", "unsupported_platform");
}

function normalizePart(part, capabilities) {
  if (!part || typeof part !== "object" || Array.isArray(part) || !capabilities.has(part.capability)) return null;
  if (!SOURCE.test(String(part.source || ""))) return null;
  if (part.capability === "unavailable") {
    if (!REASON.test(String(part.reason || ""))) return null;
    return Object.freeze({ capability: "unavailable", source: part.source, reason: part.reason });
  }
  if (!HASH.test(String(part.fingerprint || ""))) return null;
  if (part.capability === "coarse") {
    if (!Number.isInteger(part.precision_ms) || part.precision_ms < 1 || part.precision_ms > 60_000) return null;
    return Object.freeze({
      capability: "coarse",
      source: part.source,
      fingerprint: part.fingerprint,
      precision_ms: part.precision_ms,
    });
  }
  return Object.freeze({ capability: "verified", source: part.source, fingerprint: part.fingerprint });
}

export function normalizeLockOwnerIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema_version !== IDENTITY_VERSION) return null;
  const exactKeys = Object.keys(value).sort();
  if (exactKeys.join(",") !== "boot,machine,process_birth,schema_version") return null;
  const fixed = new Set(["verified", "unavailable"]);
  const machine = normalizePart(value.machine, fixed);
  const boot = normalizePart(value.boot, fixed);
  const processBirth = normalizePart(value.process_birth, new Set(["verified", "coarse", "unavailable"]));
  if (!machine || !boot || !processBirth) return null;
  return Object.freeze({ schema_version: IDENTITY_VERSION, machine, boot, process_birth: processBirth });
}

function unavailableSnapshot(reason) {
  return Object.freeze({
    schema_version: IDENTITY_VERSION,
    machine: unavailable("identity_probe", reason),
    boot: unavailable("identity_probe", reason),
    process_birth: unavailable("identity_probe", reason),
  });
}

export function defaultLockOwnerIdentity(pid) {
  const base = baseIdentity();
  return Object.freeze({
    schema_version: IDENTITY_VERSION,
    machine: base.machine,
    boot: base.boot,
    process_birth: processBirthIdentity(pid, base.boot),
  });
}

function probeIdentity(pid, probe) {
  try {
    return normalizeLockOwnerIdentity(probe(pid)) || unavailableSnapshot("invalid_result");
  } catch {
    return unavailableSnapshot("probe_failed");
  }
}

export function captureLockOwnerIdentity(pid, options = {}) {
  if (options.ownerIdentity !== undefined) {
    return normalizeLockOwnerIdentity(options.ownerIdentity) || unavailableSnapshot("invalid_override");
  }
  return probeIdentity(pid, options.identityProbe || defaultLockOwnerIdentity);
}

export function defaultPidProbe(pid) {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    // EPERM proves a process exists but is not signalable. Unknown errors fail closed too.
    return error?.code === "EPERM" ? true : null;
  }
}

function relation(expected, observed) {
  if (!expected || !observed) return "unverifiable";
  if (!COMPARABLE_CAPABILITIES.has(expected.capability) || !COMPARABLE_CAPABILITIES.has(observed.capability)) {
    return "unverifiable";
  }
  if (expected.source !== observed.source) return "unverifiable";
  return expected.fingerprint === observed.fingerprint ? "match" : "mismatch";
}

function pidResult(pid, probe) {
  try {
    const result = probe(pid);
    return result === true ? true : result === false ? false : null;
  } catch {
    return null;
  }
}

/**
 * Classify an owner without using hostname as proof of machine identity. Legacy or
 * capability-unavailable locks may prove liveness, but never prove death and therefore
 * cannot be reclaimed automatically.
 */
export function classifyLockOwner(metadata, options = {}) {
  const hostname = String(options.hostname || os.hostname());
  const hostnameMatch = metadata.owner_hostname === hostname;
  const expected = metadata.owner_identity === undefined
    ? null
    : normalizeLockOwnerIdentity(metadata.owner_identity);
  const probe = options.probePid || defaultPidProbe;

  if (!expected) {
    const exists = hostnameMatch ? pidResult(metadata.owner_pid, probe) : null;
    return Object.freeze({
      owner_state: !hostnameMatch ? "foreign_unverifiable" : exists === true ? "alive" : "unknown",
      same_host: hostnameMatch,
      same_machine: null,
      identity_format: "legacy_hostname_pid_v1",
      machine_relation: "unverifiable",
      boot_relation: "unverifiable",
      process_birth_relation: "unverifiable",
      pid_probe_result: exists,
    });
  }

  const observed = probeIdentity(metadata.owner_pid, options.identityProbe || defaultLockOwnerIdentity);
  const machineRelation = relation(expected.machine, observed.machine);
  if (machineRelation === "mismatch") {
    return Object.freeze({
      owner_state: "foreign_unverifiable",
      same_host: hostnameMatch,
      same_machine: false,
      identity_format: "owner_identity_v1",
      machine_relation: machineRelation,
      boot_relation: "unverifiable",
      process_birth_relation: "unverifiable",
      pid_probe_result: null,
    });
  }
  if (machineRelation !== "match") {
    const exists = hostnameMatch ? pidResult(metadata.owner_pid, probe) : null;
    return Object.freeze({
      owner_state: !hostnameMatch ? "foreign_unverifiable" : exists === true ? "alive" : "unknown",
      same_host: hostnameMatch,
      same_machine: null,
      identity_format: "owner_identity_v1",
      machine_relation: machineRelation,
      boot_relation: "unverifiable",
      process_birth_relation: "unverifiable",
      pid_probe_result: exists,
    });
  }

  const bootRelation = relation(expected.boot, observed.boot);
  if (bootRelation === "mismatch") {
    return Object.freeze({
      owner_state: "dead",
      same_host: hostnameMatch,
      same_machine: true,
      identity_format: "owner_identity_v1",
      machine_relation: machineRelation,
      boot_relation: bootRelation,
      process_birth_relation: "unverifiable",
      pid_probe_result: null,
    });
  }

  const exists = pidResult(metadata.owner_pid, probe);
  if (exists !== true) {
    return Object.freeze({
      owner_state: exists === false ? "dead" : "unknown",
      same_host: hostnameMatch,
      same_machine: true,
      identity_format: "owner_identity_v1",
      machine_relation: machineRelation,
      boot_relation: bootRelation,
      process_birth_relation: "unverifiable",
      pid_probe_result: exists,
    });
  }

  const processBirthRelation = relation(expected.process_birth, observed.process_birth);
  return Object.freeze({
    owner_state: processBirthRelation === "mismatch" ? "dead" : "alive",
    same_host: hostnameMatch,
    same_machine: true,
    identity_format: "owner_identity_v1",
    machine_relation: machineRelation,
    boot_relation: bootRelation,
    process_birth_relation: processBirthRelation,
    pid_probe_result: exists,
  });
}
