"use strict";
const { performance } = require("node:perf_hooks");
function timing(scope, emit = (row) => console.error(JSON.stringify(row))) {
  const timings = {};
  async function run(stage, task) {
    const start = performance.now();
    emit({ event: "startup.stage", scope, stage, state: "started" });
    const heartbeat = setInterval(
      () =>
        emit({
          event: "startup.stage",
          scope,
          stage,
          state: "waiting",
          elapsed_ms: Math.round(performance.now() - start),
        }),
      5000,
    );
    heartbeat.unref();
    let state = "failed";
    try {
      const result = await task();
      state = "completed";
      return result;
    } finally {
      clearInterval(heartbeat);
      const elapsed_ms = Math.round(performance.now() - start);
      timings[stage] = (timings[stage] || 0) + elapsed_ms;
      emit({ event: "startup.stage", scope, stage, state, elapsed_ms });
    }
  }
  return { run, timings };
}
module.exports = { timing };
