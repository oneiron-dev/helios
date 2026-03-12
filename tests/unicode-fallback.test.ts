import { describe, it, expect, beforeEach } from "bun:test";
import { setUnicodeFallback, glyph, statusGlyph } from "../src/ui/theme.js";

describe("unicode fallback", () => {
  beforeEach(() => {
    setUnicodeFallback(false);
    delete process.env.HELIOS_ASCII;
  });

  it("glyph() returns unicode by default", () => {
    expect(glyph("◈", "[*]")).toBe("◈");
  });

  it("glyph() returns ascii after setUnicodeFallback(true)", () => {
    setUnicodeFallback(true);
    expect(glyph("◈", "[*]")).toBe("[*]");
  });

  it("glyph() returns ascii when HELIOS_ASCII=1", () => {
    process.env.HELIOS_ASCII = "1";
    expect(glyph("◈", "[*]")).toBe("[*]");
  });

  it("statusGlyph() returns unicode by default", () => {
    expect(statusGlyph("accepted")).toBe("✓");
    expect(statusGlyph("running")).toBe("▸");
  });

  it("statusGlyph() returns fallback after setUnicodeFallback(true)", () => {
    setUnicodeFallback(true);
    expect(statusGlyph("accepted")).toBe("[OK]");
    expect(statusGlyph("running")).toBe("[>]");
    expect(statusGlyph("error")).toBe("[!]");
  });

  it("setUnicodeFallback(false) restores unicode", () => {
    setUnicodeFallback(true);
    expect(glyph("◈", "[*]")).toBe("[*]");
    setUnicodeFallback(false);
    expect(glyph("◈", "[*]")).toBe("◈");
  });

  it("statusGlyph() returns ? for unknown status", () => {
    expect(statusGlyph("nonexistent")).toBe("?");
  });
});
