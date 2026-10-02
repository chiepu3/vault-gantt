import { readFileSync, writeFileSync } from "fs";

// Standard Obsidian plugin version-bump script (official sample plugin
// pattern): invoked via package.json's "version" npm lifecycle script, so
// `npm version patch|minor|major` bumps package.json AND keeps
// manifest.json/versions.json in sync in the same commit, instead of the
// three files silently drifting apart.
const targetVersion = process.env.npm_package_version;

let manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");

let versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");
