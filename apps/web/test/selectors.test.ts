import { describe, expect, it } from "vitest";
import { dayLabel, initials, inr, listTime } from "../src/state/selectors.ts";

const tz = "Asia/Kolkata";
const now = "2026-10-07T06:30:00.000Z"; // Wed 7 Oct 2026, 12:00 IST

describe("time labels (G1)", () => {
  it("formats the list time like WhatsApp", () => {
    expect(listTime("2026-10-07T04:32:00.000Z", now, tz)).toBe("10:02");
    expect(listTime("2026-10-06T13:10:00.000Z", now, tz)).toBe("Yesterday");
    expect(listTime("2026-10-05T04:45:00.000Z", now, tz)).toBe("Monday");
    expect(listTime("2026-09-20T04:45:00.000Z", now, tz)).toBe("20/09/2026");
  });
  it("labels chat days", () => {
    expect(dayLabel("2026-10-07T01:00:00.000Z", now, tz)).toBe("Today");
    expect(dayLabel("2026-10-06T13:10:00.000Z", now, tz)).toBe("Yesterday");
    expect(dayLabel("2026-10-05T04:45:00.000Z", now, tz)).toBe("Monday, 5 October 2026");
  });
});

describe("formatting", () => {
  it("initials and rupees", () => {
    expect(initials("Employee 12")).toBe("E12");
    expect(initials("Theseus")).toBe("T");
    expect(initials("Ariadne Nestor")).toBe("AN");
    expect(inr(1234567)).toBe("₹12,34,567");
  });
});
