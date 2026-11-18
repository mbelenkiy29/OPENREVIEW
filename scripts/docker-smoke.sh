#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
shopt -s globstar nullglob
public_files=()
for file in "$root"/public/**/*; do
  if [[ -f "$file" ]]; then
    public_files+=("${file#"$root/public/"}")
  fi
done
image="${1:-openreview-docker-smoke:$$}"
if [[ $# -eq 0 ]]; then
  docker build --progress=plain --tag "$image" "$root"
fi
container="$(docker run --detach --network none "$image")"
trap 'docker rm --force "$container" >/dev/null' EXIT

docker exec --interactive "$container" node --input-type=module - "${public_files[@]}" <<'NODE'
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { setTimeout } from "node:timers/promises";

assert.notEqual(process.getuid(), 0, "The web image must run as a non-root user");
const base = "http://127.0.0.1:3000";
let health;
for (let attempt = 0; attempt < 50; attempt++) {
  try {
    health = await fetch(`${base}/api/health`);
    if (health.ok) break;
  } catch {}
  await setTimeout(200);
}
assert.ok(health?.ok, "The web health endpoint did not become ready");
const status = await health.json();
assert.equal(status.status, "ok");
assert.equal(status.service, "openreview");

async function checkAsset(file, url) {
  const response = await fetch(`${base}${url}`);
  assert.equal(response.status, 200, `${url} must be served`);
  const body = Buffer.from(await response.arrayBuffer());
  assert.ok(body.equals(readFileSync(file)), `${url} must match the packaged asset`);
}

const publicFiles = process.argv.slice(2);
assert.ok(publicFiles.length, "The source checkout must include public assets");
for (const file of publicFiles) {
  const url = "/" + file.split("/").map(encodeURIComponent).join("/");
  await checkAsset(path.join("public", file), url);
}

const staticFile = readdirSync(".next/static", { recursive: true, withFileTypes: true })
  .find((entry) => entry.isFile() && entry.name.endsWith(".js"));
assert.ok(staticFile, "The web image must include generated JavaScript");
const file = path.join(staticFile.parentPath, staticFile.name);
await checkAsset(file, "/_next/static/" + path.relative(".next/static", file).split(path.sep).join("/"));
console.log(`Docker smoke passed: non-root runtime, health, ${publicFiles.length} public assets, and generated JavaScript (network disabled).`);
NODE
