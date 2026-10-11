import { assert, describe, it } from "@effect/vitest";

import {
  desktopViewerLocation,
  makeDesktopSessionToken,
  parseDesktopSessionPath,
  parseDesktopViewerConfig,
  verifyDesktopSessionToken,
} from "./DesktopViewerProxy.ts";

const secret = new Uint8Array(32).fill(7);
const otherSecret = new Uint8Array(32).fill(8);

describe("desktop session tokens", () => {
  it("verifies until expiry with the same secret only", () => {
    const token = makeDesktopSessionToken(1_000, secret);
    assert.isTrue(verifyDesktopSessionToken(token, 1_001, secret));
    assert.isFalse(verifyDesktopSessionToken(token, 1_001, otherSecret));
    assert.isFalse(verifyDesktopSessionToken(token, 1_000 + 8 * 60 * 60 * 1000, secret));
  });

  it("rejects malformed and tampered tokens", () => {
    const token = makeDesktopSessionToken(1_000, secret);
    const [payload, signature] = token.split(".");
    assert.isFalse(verifyDesktopSessionToken("", 1_001, secret));
    assert.isFalse(verifyDesktopSessionToken(`${payload}`, 1_001, secret));
    assert.isFalse(verifyDesktopSessionToken(`${token}.extra`, 1_001, secret));
    assert.isFalse(verifyDesktopSessionToken(`${payload}x.${signature}`, 1_001, secret));
  });
});

describe("parseDesktopSessionPath", () => {
  it("splits the token from the upstream path", () => {
    assert.deepStrictEqual(parseDesktopSessionPath("/api/desktop/s/abc.def/core/rfb.js"), {
      token: "abc.def",
      upstreamPath: "/core/rfb.js",
    });
  });

  it("rejects paths outside a session", () => {
    assert.strictEqual(parseDesktopSessionPath("/api/desktop/open"), null);
    assert.strictEqual(parseDesktopSessionPath("/api/desktop/s/abc"), null);
    assert.strictEqual(parseDesktopSessionPath("/api/desktop/s//vnc.html"), null);
  });
});

describe("desktopViewerLocation", () => {
  it("routes the WebSocket through the session and keeps the password in the fragment", () => {
    const location = desktopViewerLocation("tok", "p&w");
    const url = new URL(location, "https://example.test");
    assert.strictEqual(url.pathname, "/api/desktop/s/tok/t3-viewer.html");
    assert.strictEqual(url.searchParams.get("path"), "api/desktop/s/tok/websockify");
    assert.strictEqual(url.searchParams.get("password"), null);
    assert.strictEqual(url.hash, "#&password=p%26w");
  });

  it("passes a theme through when given", () => {
    const url = new URL(desktopViewerLocation("tok", null, "light"), "https://example.test");
    assert.strictEqual(url.searchParams.get("theme"), "light");
  });

  it("omits the fragment without a password", () => {
    assert.notInclude(desktopViewerLocation("tok", null), "#");
  });
});

describe("parseDesktopViewerConfig", () => {
  it("defaults the upstream and reads the password", () => {
    assert.deepStrictEqual(parseDesktopViewerConfig(`{"vncPassword":"pw"}`), {
      upstream: "http://127.0.0.1:6080",
      vncPassword: "pw",
    });
  });

  it("rejects invalid config and non-http upstreams", () => {
    assert.strictEqual(parseDesktopViewerConfig("nope"), null);
    assert.strictEqual(parseDesktopViewerConfig(`{"upstream":"file:///etc"}`), null);
  });
});
