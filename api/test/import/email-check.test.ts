import { describe, expect, it } from "vitest";
import { distance, domainTypo, lookAlikes } from "../../src/lib/import/email-check.js";

describe("spotting mistyped addresses (R30)", () => {
  it("counts typos, including swapped letters", () => {
    expect(distance("gmail.com", "gmail.com")).toBe(0);
    expect(distance("gmial.com", "gmail.com")).toBe(1);
    expect(distance("gmai.com", "gmail.com")).toBe(1);
    expect(distance("abc", "xyz123456", 2)).toBe(3);
  });

  it("suggests the common domain a typo was meant to be", () => {
    expect(domainTypo("pat@gmial.com")).toBe("pat@gmail.com");
    expect(domainTypo("pat@gmail.con")).toBe("pat@gmail.com");
    expect(domainTypo("pat@gmail.co")).toBe("pat@gmail.com");
    expect(domainTypo("pat@yaho.com")).toBe("pat@yahoo.com");
    expect(domainTypo("pat@hotmial.com")).toBe("pat@hotmail.com");
    expect(domainTypo("pat@gmail.com")).toBeNull();
    expect(domainTypo("pat@me.com")).toBeNull();
    expect(domainTypo("pat@a5volleyball.org")).toBeNull();
    expect(domainTypo("pat@company.co")).toBeNull();
  });

  it("finds near-identical addresses, but not the same one", () => {
    expect(lookAlikes("jsmith@example.com", ["jsmlth@example.com", "jsmith@example.com", "kim@example.com"])).toEqual(["jsmlth@example.com"]);
  });
});
