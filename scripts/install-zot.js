#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, chmod, copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const REPO = "patriceckhart/zot";
const VERSION = process.env.ZOT_VERSION || "latest";
const SKIP = process.env.ZOT_SKIP_INSTALL === "1" || process.env.ZOT_SKIP_INSTALL === "true";
const FORCE = process.env.ZOT_FORCE_INSTALL === "1" || process.env.ZOT_FORCE_INSTALL === "true";
const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..");
const vendorDir = join(packageRoot, "vendor");
const binDir = join(packageRoot, "bin");
const isWindows = process.platform === "win32";
const vendorBinary = join(vendorDir, isWindows ? "zot.exe" : "zot");
const binShim = join(binDir, "zot");

main().catch((error) => {
  console.warn(`[zot-sdk] zot binary install skipped: ${error.message}`);
  console.warn("[zot-sdk] Install zot manually from https://www.zot.sh or set ZOT_BINARY to its path.");
});

async function main() {
  if (SKIP) return;
  if (!FORCE && (await commandExists("zot"))) {
    console.log("[zot-sdk] found zot on PATH");
    await writeShim("zot");
    return;
  }

  const platform = mapPlatform(process.platform);
  const arch = mapArch(process.arch);
  const release = await getRelease(VERSION);
  const version = release.tag_name.replace(/^v/, "");
  const ext = platform === "windows" ? "zip" : "tar.gz";
  const assetName = `zot_${version}_${platform}_${arch}.${ext}`;
  const asset = release.assets.find((candidate) => candidate.name === assetName);
  if (!asset) throw new Error(`no zot release asset for ${platform}/${arch}: ${assetName}`);

  await mkdir(vendorDir, { recursive: true });
  await mkdir(binDir, { recursive: true });

  const tempDir = await makeTempDir();
  const archivePath = join(tempDir, assetName);
  const checksumsPath = join(tempDir, "checksums.txt");
  const checksumAsset = release.assets.find((candidate) => candidate.name === "checksums.txt");

  console.log(`[zot-sdk] downloading ${assetName}`);
  await download(asset.browser_download_url, archivePath);

  if (checksumAsset) {
    await download(checksumAsset.browser_download_url, checksumsPath);
    await verifyChecksum(archivePath, checksumsPath, assetName);
  }

  await extractBinary(archivePath, tempDir, platform);
  await chmod(vendorBinary, 0o755).catch(() => undefined);
  await writeShim(vendorBinary);
  await rm(tempDir, { recursive: true, force: true });
  console.log(`[zot-sdk] installed zot ${release.tag_name}`);
}

function mapPlatform(platform) {
  if (platform === "darwin") return "darwin";
  if (platform === "linux") return "linux";
  if (platform === "win32") return "windows";
  throw new Error(`unsupported OS: ${platform}`);
}

function mapArch(arch) {
  if (arch === "x64") return "amd64";
  if (arch === "arm64") return "arm64";
  throw new Error(`unsupported CPU architecture: ${arch}`);
}

async function getRelease(version) {
  const url = version === "latest"
    ? `https://api.github.com/repos/${REPO}/releases/latest`
    : `https://api.github.com/repos/${REPO}/releases/tags/${version}`;
  const response = await fetch(url, { headers: { "user-agent": "zot-sdk-javascript installer" } });
  if (!response.ok) throw new Error(`GitHub release lookup failed: ${response.status} ${response.statusText}`);
  return response.json();
}

async function download(url, path) {
  const response = await fetch(url, { headers: { "user-agent": "zot-sdk-javascript installer" } });
  if (!response.ok || !response.body) throw new Error(`download failed: ${response.status} ${response.statusText}`);
  await pipeline(response.body, createWriteStream(path));
}

async function verifyChecksum(archivePath, checksumsPath, assetName) {
  const checksums = await readFile(checksumsPath, "utf8");
  const line = checksums.split(/\r?\n/).find((candidate) => candidate.includes(assetName));
  if (!line) throw new Error(`checksum missing for ${assetName}`);
  const expected = line.trim().split(/\s+/)[0];
  const actual = createHash("sha256").update(await readFile(archivePath)).digest("hex");
  if (actual !== expected) throw new Error(`checksum mismatch for ${assetName}`);
}

async function extractBinary(archivePath, tempDir, platform) {
  if (platform === "windows") {
    await run("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath ${quotePowerShell(archivePath)} -DestinationPath ${quotePowerShell(tempDir)} -Force`,
    ]);
  } else {
    await run("tar", ["-xzf", archivePath, "-C", tempDir]);
  }

  const extracted = await findExtractedBinary(tempDir);
  await copyFile(extracted, vendorBinary);
}

async function findExtractedBinary(dir) {
  const entries = await import("node:fs/promises").then((fs) => fs.readdir(dir, { withFileTypes: true }));
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await findExtractedBinary(path).catch(() => undefined);
      if (nested) return nested;
    } else if (basename(entry.name).toLowerCase() === (isWindows ? "zot.exe" : "zot")) {
      return path;
    }
  }
  throw new Error("zot binary not found in archive");
}

async function writeShim(_target) {
  await mkdir(binDir, { recursive: true });
  await chmod(binShim, 0o755).catch(() => undefined);
}

async function commandExists(command) {
  const extensions = isWindows ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = join(dir, isWindows ? `${command}${ext.toLowerCase()}` : command);
      try {
        await access(candidate);
        return true;
      } catch {
        // keep searching
      }
    }
  }
  return false;
}

async function makeTempDir() {
  const fs = await import("node:fs/promises");
  return fs.mkdtemp(join(tmpdir(), "zot-sdk-"));
}

function quotePowerShell(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}
