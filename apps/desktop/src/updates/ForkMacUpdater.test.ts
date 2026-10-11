import { assert, describe, it } from "@effect/vitest";

import {
  appBundlePath,
  compareForkVersions,
  parseForkVersion,
  parseUpdateRepository,
  selectForkRelease,
} from "./ForkMacUpdater.ts";

const SHA = "a".repeat(64);

const release = (input: {
  readonly tag: string;
  readonly version: string;
  readonly arch?: string;
  readonly assetName?: string;
  readonly draft?: boolean;
  readonly sha256?: string;
}) => {
  const name = input.assetName ?? "T3-Code-mac-arm64.zip";
  return {
    tag_name: input.tag,
    draft: input.draft ?? false,
    html_url: `https://github.com/l0wGK/t3code/releases/tag/${input.tag}`,
    body: `Built from abc1234.\n\n<!-- fork-update ${JSON.stringify({
      version: input.version,
      assets: { [input.arch ?? "arm64"]: { name, sha256: input.sha256 ?? SHA } },
    })} -->`,
    assets: [{ name, browser_download_url: `https://example.test/${input.tag}/${name}`, size: 42 }],
  };
};

describe("fork versions", () => {
  it("parses upstream and fork versions", () => {
    assert.deepStrictEqual(parseForkVersion("0.0.45"), { core: [0, 0, 45], build: 0 });
    assert.deepStrictEqual(parseForkVersion("0.0.45+l0wgk.12"), { core: [0, 0, 45], build: 12 });
    assert.strictEqual(parseForkVersion("0.0.45-nightly.20261001.1"), null);
    assert.strictEqual(parseForkVersion("nope"), null);
  });

  it("orders by upstream version, then fork build", () => {
    assert.strictEqual(compareForkVersions("0.0.45+l0wgk.2", "0.0.45+l0wgk.1"), 1);
    assert.strictEqual(compareForkVersions("0.0.45+l0wgk.10", "0.0.45+l0wgk.9"), 1);
    assert.strictEqual(compareForkVersions("0.0.45+l0wgk.1", "0.0.45+l0wgk.1"), 0);
    assert.strictEqual(compareForkVersions("0.0.45+l0wgk.1", "0.0.45"), 1);
    assert.strictEqual(compareForkVersions("0.0.46+l0wgk.1", "0.0.45+l0wgk.99"), 1);
    assert.strictEqual(compareForkVersions("0.0.44+l0wgk.99", "0.0.45"), -1);
  });
});

describe("selectForkRelease", () => {
  it("picks the newest release for the architecture that is newer than the current version", () => {
    const selected = selectForkRelease(
      [
        release({ tag: "fork-mac-3", version: "0.0.45+l0wgk.3" }),
        release({ tag: "fork-mac-5", version: "0.0.45+l0wgk.5" }),
        release({ tag: "fork-mac-4", version: "0.0.45+l0wgk.4" }),
      ],
      "arm64",
      "0.0.45+l0wgk.1",
    );
    assert.strictEqual(selected?.version, "0.0.45+l0wgk.5");
    assert.strictEqual(selected?.zipUrl, "https://example.test/fork-mac-5/T3-Code-mac-arm64.zip");
    assert.strictEqual(selected?.sha256, SHA);
    assert.strictEqual(selected?.size, 42);
  });

  it("returns null when nothing is newer", () => {
    assert.strictEqual(
      selectForkRelease(
        [release({ tag: "fork-mac-2", version: "0.0.45+l0wgk.2" })],
        "arm64",
        "0.0.45+l0wgk.2",
      ),
      null,
    );
  });

  it("skips drafts, other tags, other architectures, missing assets, and bad checksums", () => {
    const releases = [
      release({ tag: "fork-mac-9", version: "0.0.45+l0wgk.9", draft: true }),
      release({ tag: "v0.0.46", version: "0.0.46" }),
      release({ tag: "fork-mac-8", version: "0.0.45+l0wgk.8", arch: "x64" }),
      { ...release({ tag: "fork-mac-7", version: "0.0.45+l0wgk.7" }), assets: [] },
      release({ tag: "fork-mac-6", version: "0.0.45+l0wgk.6", sha256: "not-a-hash" }),
      { tag_name: "fork-mac-5", body: "no manifest", assets: [] },
      release({ tag: "fork-mac-2", version: "0.0.45+l0wgk.2" }),
    ];
    assert.strictEqual(
      selectForkRelease(releases, "arm64", "0.0.45+l0wgk.1")?.version,
      "0.0.45+l0wgk.2",
    );
    assert.strictEqual(selectForkRelease("not a list", "arm64", "0.0.45"), null);
  });
});

describe("helpers", () => {
  it("reads the repository from app-update.yml", () => {
    assert.strictEqual(
      parseUpdateRepository(
        "provider: github\nowner: l0wGK\nrepo: t3code\nupdaterCacheDirName: x\n",
      ),
      "l0wGK/t3code",
    );
    assert.strictEqual(parseUpdateRepository("provider: generic\nurl: http://x\n"), null);
  });

  it("finds the app bundle of an executable", () => {
    assert.strictEqual(
      appBundlePath("/Applications/T3 Code (Alpha).app/Contents/MacOS/T3 Code (Alpha)"),
      "/Applications/T3 Code (Alpha).app",
    );
    assert.strictEqual(appBundlePath("/usr/local/bin/node"), null);
  });
});
