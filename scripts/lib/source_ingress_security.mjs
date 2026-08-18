import dns from "node:dns/promises";
import { constants as fsConstants, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import https from "node:https";
import net from "node:net";
import path from "node:path";

const AUTHORITY_PATH = new URL("../../assets/source-ingress-authority-v1.json", import.meta.url);
const AUTHORITY_DOCUMENT = JSON.parse(readFileSync(AUTHORITY_PATH, "utf8"));
if (
  AUTHORITY_DOCUMENT.schema_version !== "source-ingress-authority/1.0" ||
  typeof AUTHORITY_DOCUMENT.authority_id !== "string" ||
  AUTHORITY_DOCUMENT.authority_id.length === 0 ||
  AUTHORITY_DOCUMENT.local_sources?.root_owner !== "controller" ||
  !Array.isArray(AUTHORITY_DOCUMENT.remote_sources?.allowed_domains) ||
  AUTHORITY_DOCUMENT.remote_sources.allowed_domains.length === 0 ||
  new Set(AUTHORITY_DOCUMENT.remote_sources.allowed_domains).size !== AUTHORITY_DOCUMENT.remote_sources.allowed_domains.length ||
  !Number.isInteger(AUTHORITY_DOCUMENT.remote_sources.max_redirects) ||
  AUTHORITY_DOCUMENT.remote_sources.max_redirects < 0 ||
  !Number.isInteger(AUTHORITY_DOCUMENT.remote_sources.max_bytes) ||
  AUTHORITY_DOCUMENT.remote_sources.max_bytes <= 0 ||
  !Number.isInteger(AUTHORITY_DOCUMENT.remote_sources.timeout_ms) ||
  AUTHORITY_DOCUMENT.remote_sources.timeout_ms <= 0
) throw new Error("Source-ingress authority is malformed.");

export const DEFAULT_REMOTE_INGRESS_AUTHORITY = Object.freeze({
  authority_id: AUTHORITY_DOCUMENT.authority_id,
  allowed_domains: Object.freeze([...AUTHORITY_DOCUMENT.remote_sources.allowed_domains]),
  max_redirects: AUTHORITY_DOCUMENT.remote_sources.max_redirects,
  max_bytes: AUTHORITY_DOCUMENT.remote_sources.max_bytes,
  timeout_ms: AUTHORITY_DOCUMENT.remote_sources.timeout_ms,
});

function withinRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export async function resolveApprovedRegularFile({ candidate, approvedRoots, label = "Local source" }) {
  if (!Array.isArray(approvedRoots) || approvedRoots.length === 0) {
    throw new Error(`${label} has no controller-approved local root.`);
  }
  const lexical = path.resolve(String(candidate));
  const lexicalRoots = approvedRoots.map((suppliedRoot) => path.resolve(String(suppliedRoot)));
  const roots = [];
  for (const suppliedRoot of approvedRoots) {
    const root = await fs.realpath(path.resolve(String(suppliedRoot)));
    const stats = await fs.stat(root);
    if (!stats.isDirectory()) throw new Error(`${label} approved root is not a directory: ${root}`);
    roots.push(root);
  }
  const linkStats = await fs.lstat(lexical);
  if (linkStats.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link.`);
  const canonical = await fs.realpath(lexical);
  // macOS exposes stable system aliases such as /var -> /private/var. Either
  // the artifact or approved root can retain the alias spelling. Accept that
  // spelling difference only when the already-resolved artifact remains
  // inside the canonical approved root. The terminal-link rejection above,
  // canonical containment below and O_NOFOLLOW open remain fail closed.
  const beginsInsideApprovedRoot =
    lexicalRoots.some((root) => withinRoot(lexical, root)) ||
    roots.some((root) => withinRoot(lexical, root)) ||
    roots.some((root) => withinRoot(canonical, root));
  if (!beginsInsideApprovedRoot) {
    throw new Error(`${label} leaves its controller-approved local roots.`);
  }
  if (!roots.some((root) => withinRoot(canonical, root))) {
    throw new Error(`${label} resolves outside its controller-approved local roots.`);
  }
  const handle = await fs.open(canonical, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error(`${label} must be a regular file.`);
  } finally {
    await handle.close();
  }
  return canonical;
}

export async function readApprovedRegularFile(options) {
  const canonical = await resolveApprovedRegularFile(options);
  const handle = await fs.open(canonical, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error(`${options.label ?? "Local source"} must be a regular file.`);
    return { path: canonical, bytes: await handle.readFile() };
  } finally {
    await handle.close();
  }
}

export function hostAllowed(hostname, allowedDomains) {
  const host = String(hostname).toLowerCase().replace(/\.$/, "");
  return allowedDomains.some((domain) => {
    const allowed = String(domain).toLowerCase().replace(/\.$/, "");
    return host === allowed || host.endsWith(`.${allowed}`);
  });
}

function ipv4IsPublic(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts;
  return !(
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function ipv6Groups(address) {
  let value = address;
  const tail = value.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (tail) {
    const octets = tail.split(".").map(Number);
    value = value.slice(0, -tail.length) +
      `${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...left, ...Array(missing).fill("0"), ...right]
    .map((group) => Number.parseInt(group || "0", 16));
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff)
    ? groups
    : null;
}

export function addressIsPublic(address) {
  const value = String(address).toLowerCase().split("%")[0];
  const family = net.isIP(value);
  if (family === 4) return ipv4IsPublic(value);
  if (family !== 6) return false;
  const groups = ipv6Groups(value);
  if (!groups) return false;
  if (groups.slice(0, 5).every((group) => group === 0) && [0, 0xffff].includes(groups[5])) {
    const mapped = `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
    return groups[5] === 0xffff && ipv4IsPublic(mapped);
  }
  const first = groups[0];
  return !(
    groups.every((group) => group === 0) ||
    (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xff00) === 0xff00 ||
    first === 0x2002 ||
    (groups[0] === 0x2001 && (groups[1] === 0 || groups[1] === 0x0db8))
  );
}

export function validateOfficialUrl(rawUrl, authority = DEFAULT_REMOTE_INGRESS_AUTHORITY) {
  const target = new URL(rawUrl);
  if (
    target.protocol !== "https:" || target.username || target.password ||
    (target.port && target.port !== "443") ||
    !hostAllowed(target.hostname, authority.allowed_domains)
  ) {
    throw new Error(`Declared filing URL is outside controller-owned HTTPS authority: ${target.href}`);
  }
  if (net.isIP(target.hostname)) throw new Error("Declared filing URL must use an approved DNS hostname, not an IP literal.");
  return target;
}

async function resolvePublicAddresses(hostname, lookupFn) {
  const records = await lookupFn(hostname, { all: true, verbatim: true });
  const normalized = (Array.isArray(records) ? records : [records])
    .map((record) => ({ address: record.address, family: Number(record.family) }))
    .filter((record) => record.address && (record.family === 4 || record.family === 6));
  if (normalized.length === 0) throw new Error(`Official filing host ${hostname} did not resolve.`);
  if (normalized.some((record) => !addressIsPublic(record.address))) {
    throw new Error(`Official filing host ${hostname} resolved to a private, local, metadata or non-routable address.`);
  }
  return normalized;
}

function headerValue(headers, name) {
  if (typeof headers?.get === "function") return headers.get(name);
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value ?? null;
}

async function secureHttpsRequest({ url, addresses, maxBytes, timeoutMs }) {
  return await new Promise((resolve, reject) => {
    let settled = false;
    const allowedAddresses = new Set(addresses.map((record) => record.address.toLowerCase()));
    const request = https.request(url, {
      method: "GET",
      headers: { "user-agent": "Excel-Inflow-Filings/1.0 controlled-evidence-fetch" },
      lookup(_hostname, _options, callback) {
        const selected = addresses[0];
        if (_options?.all) callback(null, addresses);
        else callback(null, selected.address, selected.family);
      },
    }, (response) => {
      const chunks = [];
      let byteLength = 0;
      const declaredLength = Number(response.headers["content-length"]);
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        request.destroy(new Error(`Declared filing response exceeds ${maxBytes} bytes.`));
        return;
      }
      response.on("data", (chunk) => {
        byteLength += chunk.length;
        if (byteLength > maxBytes) {
          request.destroy(new Error(`Declared filing response exceeds ${maxBytes} bytes.`));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          statusCode: response.statusCode,
          headers: response.headers,
          bytes: Buffer.concat(chunks),
          remoteAddress: response.socket?.remoteAddress,
        });
      });
    });
    request.on("socket", (socket) => socket.once("secureConnect", () => {
      const peer = String(socket.remoteAddress ?? "").toLowerCase();
      if (!addressIsPublic(peer) || !allowedAddresses.has(peer)) {
        request.destroy(new Error("Official filing connection peer differs from the validated public DNS answer."));
      }
    }));
    request.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    const timer = setTimeout(() => request.destroy(new Error(`Declared filing fetch exceeded ${timeoutMs}ms.`)), timeoutMs);
    request.end();
  });
}

function assertRemoteContent(bytes, contentType, declaredMediaType) {
  const actual = String(contentType ?? "").split(";", 1)[0].trim().toLowerCase();
  const expected = String(declaredMediaType ?? "").toLowerCase();
  if (!expected || actual !== expected) {
    throw new Error(`Declared filing response content-type ${actual || "<missing>"} does not match ${expected || "<missing declaration>"}.`);
  }
  if (expected === "application/pdf" && !bytes.subarray(0, 1024).includes(Buffer.from("%PDF-"))) {
    throw new Error("Declared filing response does not have PDF magic bytes.");
  }
  if (
    [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ].includes(expected) && !bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
  ) {
    throw new Error("Declared filing response does not have OOXML zip magic bytes.");
  }
}

async function withinTime(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchOfficialFile({
  rawUrl,
  declaredMediaType,
  authority = DEFAULT_REMOTE_INGRESS_AUTHORITY,
  lookupFn = dns.lookup,
  requestOnce = secureHttpsRequest,
}) {
  let current = validateOfficialUrl(rawUrl, authority);
  const deadline = Date.now() + authority.timeout_ms;
  let totalBytes = 0;
  for (let redirect = 0; redirect <= authority.max_redirects; redirect += 1) {
    const remainingTime = deadline - Date.now();
    if (remainingTime <= 0) throw new Error(`Declared filing fetch exceeded ${authority.timeout_ms}ms.`);
    const addresses = await withinTime(
      resolvePublicAddresses(current.hostname, lookupFn),
      remainingTime,
      `Declared filing fetch exceeded ${authority.timeout_ms}ms during DNS validation.`,
    );
    const response = await requestOnce({
      url: current,
      addresses,
      maxBytes: authority.max_bytes - totalBytes,
      timeoutMs: remainingTime,
    });
    totalBytes += response.bytes.length;
    const peer = String(response.remoteAddress ?? "").toLowerCase();
    if (!addressIsPublic(peer) || !addresses.some((record) => record.address.toLowerCase() === peer)) {
      throw new Error("Official filing connection peer differs from the validated public DNS answer.");
    }
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      const location = headerValue(response.headers, "location");
      if (!location) throw new Error(`Declared filing URL returned redirect ${response.statusCode} without Location.`);
      current = validateOfficialUrl(new URL(location, current).href, authority);
      continue;
    }
    if (response.statusCode < 200 || response.statusCode > 299) {
      throw new Error(`Declared filing URL returned HTTP ${response.statusCode}.`);
    }
    if (totalBytes > authority.max_bytes) {
      throw new Error(`Declared filing response exceeds ${authority.max_bytes} bytes.`);
    }
    assertRemoteContent(response.bytes, headerValue(response.headers, "content-type"), declaredMediaType);
    return { bytes: response.bytes, final_url: current.href };
  }
  throw new Error(`Declared filing URL exceeded ${authority.max_redirects} controlled redirects.`);
}

export default {
  DEFAULT_REMOTE_INGRESS_AUTHORITY,
  addressIsPublic,
  fetchOfficialFile,
  hostAllowed,
  readApprovedRegularFile,
  resolveApprovedRegularFile,
  validateOfficialUrl,
};
