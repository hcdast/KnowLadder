"use strict";
const { randomUUID } = require("node:crypto");
const { fixture, Browser, status } = require("./helpers.cjs");
const { newId } = require("../dist/database/object-id");
async function setup(t) {
  const f = await fixture(t, { env: { KL_LIFELONG_ENABLED: "true" } });
  f.person = async (adult = true) => {
    const browser = new Browser(f.browser.base),
      user = await f.authenticated(browser);
    if (adult)
      await f.db
        .collection("auth_admissions")
        .insertOne({
          _id: newId(),
          user_id: user.user_id,
          age_band: "adult",
          source: "invite_activate",
          terms_version: "isolated_trial_v1",
          privacy_notice_version: "isolated_trial_v1",
          policy_basis: "isolated_test_only",
          accepted_at: new Date(),
        });
    return { browser, id: user.user_id };
  };
  f.request = (person, url, body, key = randomUUID(), method) =>
    person.browser.request(`/personal${url}`, {
      method: method || (body === undefined ? "GET" : "POST"),
      body,
      headers: { "Idempotency-Key": key },
    });
  f.good = async (...args) => {
    const r = await f.request(...args);
    status(r, 200);
    return r.data.data;
  };
  f.goal = (title = "观察与表达") => ({
    title,
    stage: "school",
    field: "science",
    outcome: "记录证据与问题",
    due_on: null,
    state: "active",
    template_id: "water-observer",
  });
  f.activity = (goal) => ({
    goal_id: goal,
    kind: "project",
    title: "完成一次观察",
    note: "记录三个变化",
    reflection: "还需控制观察条件",
    occurred_on: new Date().toISOString().slice(0, 10),
    minutes: 20,
  });
  return f;
}
module.exports = { setup };
