import { describe, it, expect } from "vitest";
import { parseScrollStep } from "../jobs/cloudflare";

describe("parseScrollStep", () => {
  it("reads a lone figure as the vertical move", () => {
    expect(parseScrollStep("scroll(800)")).toEqual({ x: 0, y: 800 });
  });

  it("reads two figures as x then y", () => {
    expect(parseScrollStep("scroll(120, 800)")).toEqual({ x: 120, y: 800 });
  });

  it("takes named axes either way round", () => {
    expect(parseScrollStep("scroll(y=800)")).toEqual({ x: 0, y: 800 });
    expect(parseScrollStep("scroll(x:-200)")).toEqual({ x: -200, y: 0 });
    expect(parseScrollStep("scroll(y = 800, x = 120)")).toEqual({ x: 120, y: 800 });
  });

  it("ignores case and surrounding space", () => {
    expect(parseScrollStep("  Scroll( 0 , 99999 ) ")).toEqual({ x: 0, y: 99999 });
  });

  it("rounds a fractional figure", () => {
    expect(parseScrollStep("scroll(0, 800.6)")).toEqual({ x: 0, y: 801 });
  });

  it("rejects a mix of named and bare figures, which reads either way", () => {
    expect(parseScrollStep("scroll(x=10, 20)")).toBeNull();
  });

  it("rejects malformed steps", () => {
    expect(parseScrollStep("scroll()")).toBeNull();
    expect(parseScrollStep("scroll(down)")).toBeNull();
    expect(parseScrollStep("scroll(1, 2, 3)")).toBeNull();
    expect(parseScrollStep("scroll 800")).toBeNull();
  });

  it("leaves other steps alone", () => {
    expect(parseScrollStep("delay(2500)")).toBeNull();
    expect(parseScrollStep("{aiBtn}")).toBeNull();
    expect(parseScrollStep("css:#checkin")).toBeNull();
    expect(parseScrollStep(undefined)).toBeNull();
  });
});
