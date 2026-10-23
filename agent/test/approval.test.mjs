import assert from "node:assert/strict";
import test from "node:test";
import { approvePasscode, clearApprovalAttempts } from "../src/approval.ts";
test("approval passcode rejects missing/wrong, accepts correct, and limits attempts", () => {
  clearApprovalAttempts(); assert.equal(approvePasscode(undefined, "secret", "a"), false); assert.equal(approvePasscode("wrong", "secret", "b"), false); assert.equal(approvePasscode("secret", "secret", "c"), true);
  for(let i=0;i<5;i++) assert.equal(approvePasscode("wrong", "secret", "limited", 1), false);
  assert.equal(approvePasscode("secret", "secret", "limited", 2), false);
});
