#!/usr/bin/env node
import fs from "node:fs";
import { createRunner } from "./lib/test_harness.mjs";

const run = createRunner({ name: "architecture_ownership_tests", importMetaUrl: import.meta.url });
const ownership = JSON.parse(
  fs.readFileSync(new URL("../assets/architecture-ownership-v2.json", import.meta.url), "utf8"),
);

run.eq(ownership.schema_version, "architecture-ownership/2.0");
run.eq(ownership.owners.length, 7);
run.eq(new Set(ownership.owners.map((owner) => owner.owner_id)).size, 7, "owner_id must be unique");
run.eq(new Set(ownership.owners.map((owner) => owner.canonical)).size, 7, "canonical must be unique");
run.eq(
  ownership.owners.find((owner) => owner.owner_id === "product_identity_vocabulary")?.canonical,
  "assets/product-identity-v2.schema.json",
);
run.ok(
  !ownership.owners.some((owner) => owner.canonical === "release-manifest.json"),
  "mutable release manifest still claims canonical identity ownership",
);

run.finish();
