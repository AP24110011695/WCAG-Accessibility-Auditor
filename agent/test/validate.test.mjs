import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAuditInput, ALLOWED_LEVELS } from "../src/validate.ts";

const limits = { maxPages: 5, allowedHosts: ["example.com", "sunflower-audit.github.io"] };

test("valid input produces no errors", () => {
  const errors = validateAuditInput(
    { urls: ["https://example.com/a", "https://sunflower-audit.github.io/demo/form.html"], target_level: "WCAG2.2-AA" },
    limits
  );
  assert.deepEqual(errors, []);
});

test("non-object body is rejected", () => {
  const errors = validateAuditInput(null, limits);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, "body");
});

test("invalid target_level is rejected with the allowed set", () => {
  const errors = validateAuditInput({ urls: ["https://example.com/"], target_level: "WCAG3.0-AAA" }, limits);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, "target_level");
  assert.ok(errors[0].message.includes("WCAG2.2-AA"));
});

test("malformed URL is rejected per field", () => {
  const errors = validateAuditInput({ urls: ["not-a-url"], target_level: "WCAG2.2-AA" }, limits);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, "urls[0]");
});

test("non-allowlisted host is rejected", () => {
  const errors = validateAuditInput({ urls: ["https://evil.example.org/x"], target_level: "WCAG2.2-AA" }, limits);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].message.includes("not allowlisted"));
});

test("page cap is enforced", () => {
  const urls = Array.from({ length: 6 }, (_, i) => `https://example.com/p${i}`);
  const errors = validateAuditInput({ urls, target_level: "WCAG2.2-AA" }, limits);
  assert.ok(errors.some((e) => e.field === "urls" && e.message.includes("At most 5")));
});

test("duplicate URLs are rejected", () => {
  const errors = validateAuditInput(
    { urls: ["https://example.com/a", "https://example.com/a"], target_level: "WCAG2.2-AA" },
    limits
  );
  assert.ok(errors.some((e) => e.field === "urls[1]" && e.message.includes("Duplicate")));
});

test("non-http protocols are rejected", () => {
  const errors = validateAuditInput({ urls: ["file:///path/to/x.html"], target_level: "WCAG2.2-AA" }, limits);
  assert.ok(errors.some((e) => e.message.includes("Only http(s)")));
});

test("empty URL list is rejected", () => {
  const errors = validateAuditInput({ urls: [], target_level: "WCAG2.2-AA" }, limits);
  assert.ok(errors.some((e) => e.field === "urls"));
});

test("every allowed level passes validation", () => {
  for (const level of ALLOWED_LEVELS) {
    assert.deepEqual(validateAuditInput({ urls: ["https://example.com/"], target_level: level }, limits), []);
  }
});
