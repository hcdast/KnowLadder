"use strict";
const {
  AssignmentRecoveryRunner,
} = require("../dist/training/assignment-recovery-runner");
const run = AssignmentRecoveryRunner.prototype.run;
let armed;
process.on("message", (message) => {
  if (message?.kind === "arm-fault") armed = message.key;
});
AssignmentRecoveryRunner.prototype.run = function (plan, verify, knowledge) {
  return run.call(this, plan, verify, knowledge, async (step) => {
    if (plan.key === armed && step === "assignment") {
      armed = undefined;
      process.send({ kind: "fault-ready" });
      await new Promise(() => {});
    }
  });
};
require("../dist/training/managed-api-child");
