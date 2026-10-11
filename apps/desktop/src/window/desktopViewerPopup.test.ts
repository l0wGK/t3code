import { assert, describe, it } from "@effect/vitest";

import { isDesktopViewerUrl } from "./desktopViewerPopup.ts";

describe("isDesktopViewerUrl", () => {
  it("accepts the open endpoint and session pages on any environment origin", () => {
    assert.isTrue(isDesktopViewerUrl("http://192.168.1.20:3773/api/desktop/open?wsTicket=x"));
    assert.isTrue(
      isDesktopViewerUrl("https://t3-code.example.ts.net/api/desktop/s/abc.def/t3-viewer.html?x=1"),
    );
  });

  it("rejects other paths, schemes, and malformed URLs", () => {
    assert.isFalse(isDesktopViewerUrl("https://example.com/"));
    assert.isFalse(isDesktopViewerUrl("https://example.com/api/desktop/openx"));
    assert.isFalse(isDesktopViewerUrl("https://example.com/api/desktop/s/token"));
    assert.isFalse(isDesktopViewerUrl("file:///api/desktop/open"));
    assert.isFalse(isDesktopViewerUrl("not a url"));
  });
});
