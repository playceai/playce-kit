/**
 * Minimal tar reader — enough for a GitHub codeload tarball, nothing more.
 *
 * Why hand-rolled: this scaffolder has zero runtime dependencies, and spawning
 * the system `tar` is not portable enough to bet the install on (it exists on
 * macOS/Linux and Windows 10+, but not on every trimmed container image, and
 * its flag handling differs between bsdtar and GNU tar). A tar entry is a
 * 512-byte header plus 512-byte-aligned data; that is the whole format we need.
 *
 * Handles: regular files, directories, GNU long names ('L'), pax extended
 * headers ('x'/'g'). Ignores symlinks/hardlinks/devices — the kit has none, and
 * silently skipping them is safer than materialising them.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const BLOCK = 512;

/** Read a NUL-terminated (or field-length-limited) ASCII field. */
function field(buf, off, len) {
  let end = off;
  const limit = off + len;
  while (end < limit && buf[end] !== 0) end++;
  return buf.toString("utf8", off, end);
}

/** Read an octal numeric field. Empty/garbage reads as 0. */
function octal(buf, off, len) {
  const s = field(buf, off, len).trim();
  if (!s) return 0;
  const n = parseInt(s, 8);
  return Number.isFinite(n) ? n : 0;
}

/** Pull `path=` out of a pax extended header payload ("%d %s=%s\n" records). */
function paxPath(text) {
  for (const line of text.split("\n")) {
    const space = line.indexOf(" ");
    if (space === -1) continue;
    const record = line.slice(space + 1);
    if (record.startsWith("path=")) return record.slice(5);
  }
  return null;
}

function isZeroBlock(buf, off) {
  for (let i = off; i < off + BLOCK; i++) if (buf[i] !== 0) return false;
  return true;
}

/**
 * Extract `tar` (an uncompressed tar Buffer) into `dest`.
 *
 * @param {Buffer} tar
 * @param {string} dest
 * @param {object} [opts]
 * @param {number} [opts.strip]   Leading path components to drop (1 for a GitHub tarball).
 * @param {(relPath: string) => boolean} [opts.exclude]  Return true to skip an entry.
 * @returns {string[]} relative paths of the files written
 */
export function extractTar(tar, dest, opts = {}) {
  const strip = opts.strip ?? 0;
  const exclude = opts.exclude ?? (() => false);
  const written = [];

  let offset = 0;
  let pendingName = null; // from an 'L' or 'x' header that precedes the real entry

  while (offset + BLOCK <= tar.length) {
    if (isZeroBlock(tar, offset)) break; // end-of-archive marker

    const size = octal(tar, offset + 124, 12);
    const typeByte = tar[offset + 156];
    const type = typeByte === 0 ? "0" : String.fromCharCode(typeByte);
    const rawName = field(tar, offset, 100);
    const prefix = field(tar, offset + 345, 155);

    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new Error("tar: truncated archive");
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "L") {
      pendingName = tar.toString("utf8", dataStart, dataEnd).replace(/\0+$/, "");
      continue;
    }
    if (type === "x") {
      pendingName = paxPath(tar.toString("utf8", dataStart, dataEnd)) ?? pendingName;
      continue;
    }
    if (type === "g") continue; // pax_global_header — GitHub puts one first

    const name = pendingName ?? (prefix ? `${prefix}/${rawName}` : rawName);
    pendingName = null;

    const parts = name.split("/").filter((p) => p && p !== ".");
    if (parts.some((p) => p === ".." || p.includes("\0"))) {
      throw new Error(`tar: refusing unsafe path ${name}`);
    }
    if (parts.length <= strip) continue;
    const rel = parts.slice(strip).join("/");
    if (!rel || exclude(rel)) continue;

    const outPath = join(dest, ...rel.split("/"));
    if (type === "5") {
      mkdirSync(outPath, { recursive: true });
      continue;
    }
    if (type !== "0") continue; // links, devices, FIFOs — not in this kit

    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, tar.subarray(dataStart, dataEnd));
    written.push(rel);
  }

  return written;
}
