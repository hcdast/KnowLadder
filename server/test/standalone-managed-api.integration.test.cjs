"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { fixture, Browser, status } = require("./helpers.cjs");
const { newId } = require("../dist/database/object-id");
const { MongoClient } = require("mongodb");
const {
  ManagedApiSupervisor,
} = require("../dist/training/managed-api-supervisor");
const { createServer } = require("node:http");
const path = require("node:path");
test(
  "standalone managed API: authorization, real child SIGKILL/recovery, cross-writer refusal",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t, {
      topology: "standalone",
      app: false,
      env: {
        KL_TRAINING_ENABLED: "true",
        KL_STANDALONE_RECOVERY_ENABLED: "true",
        KL_STANDALONE_MANAGED_API_ENABLED: "true",
        KL_TRAINING_PHASE2_ENABLED: "false",
        KL_KNOWLEDGE_ENABLED: "false",
        KL_MANAGED_WRITER_OWNER: "managed-22222222-2222-4222-a222-222222222222",
      },
    });
    const seed =
      await require("../dist/training/managed-invocation").runManagedInvocation(
        {
          owner: process.env.KL_MANAGED_WRITER_OWNER,
          token: "synthetic-seed-token",
          generation: 0,
        },
        async () => {
          const org = (
            await f.ops.createOrganization(f.context, {
              name: "原创单例验收",
              kind: "school",
            })
          ).organization_id;
          const user = await f.user();
          await f.ops.setMembership(f.context, {
            user_id: user.user_id,
            org_id: org,
            roles: ["teacher"],
          });
          const member = await f.db
            .collection("organization_members")
            .findOne({ user_id: user.user_id, org_id: org });
          await f.ops.setCapability(f.context, {
            org_id: org,
            member_id: member._id,
            capability: "course:assign",
            granted: true,
            expected_revision: member.authorization_revision,
            valid_to: new Date(Date.now() + 3600000),
          });
          const subject = newId(),
            course = newId(),
            classes = [newId(), newId(), newId()],
            now = new Date();
          await f.db
            .collection("subjects")
            .insertOne({
              _id: subject,
              code: "synthetic-" + subject,
              name: "原创单例学科",
              created_at: now,
              updated_at: now,
            });
          for (const classId of classes) {
            await f.db
              .collection("classes")
              .insertOne({
                _id: classId,
                org_id: org,
                name: "原创验收班",
                year_label: "2026",
                status: "active",
                revision: 1,
                created_by: user.user_id,
                created_at: now,
                updated_at: now,
              });
            await f.db
              .collection("teaching_assignments")
              .insertOne({
                _id: newId(),
                org_id: org,
                class_id: classId,
                member_id: member._id,
                subject_id: subject,
                status: "active",
                revision: 1,
                valid_from: null,
                valid_to: null,
                created_at: now,
                updated_at: now,
              });
          }
          await f.db
            .collection("courses")
            .insertOne({
              _id: course,
              org_id: org,
              revision: 1,
              created_at: now,
              updated_at: now,
              code: "original-standalone",
              title: "原创单例课程",
              subject_id: subject,
              version_no: 1,
              status: "published",
              author_id: user.user_id,
              contributors: [user.user_id],
              reviewer_id: newId(),
              review_note: "独立审核合成夹具",
              lessons: [
                {
                  key: "original",
                  title: "原创文本",
                  kind: "text",
                  required: true,
                  body: "这是一段原创教学内容。",
                  file_id: null,
                  owner_version_id: null,
                },
              ],
            });
          const student = await f.user();
          await f.ops.setMembership(f.context, {
            user_id: student.user_id,
            org_id: org,
            roles: ["student"],
          });
          const studentMember = await f.db
            .collection("organization_members")
            .findOne({ user_id: student.user_id, org_id: org });
          await f.db
            .collection("class_members")
            .insertOne({
              _id: newId(),
              org_id: org,
              class_id: classes[0],
              member_id: studentMember._id,
              kind: "student",
              status: "active",
              valid_from: null,
              valid_to: null,
              created_at: now,
              updated_at: now,
            });
          return { org, user, member, subject, course, classes, student };
        },
      );
    const { org, user, member, subject, course, classes, student } = seed;
    const client = new MongoClient(f.uri);
    await client.connect();
    const supervisor = new ManagedApiSupervisor(
      client,
      path.resolve(__dirname, "managed-api-fault-child.cjs"),
    );
    let server, browser;
    try {
      await supervisor.initialize();
      assert.equal(
        (
          await fetch(
            "http://127.0.0.1:" + supervisor.internalPort + "/api/v1/auth/csrf",
          )
        ).status,
        403,
      );
      // Minimal real HTTP ingress around the production supervisor; no substituted business service.
      server = createServer(async (req, res) => {
        try {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const headers = {};
          for (const [key, value] of Object.entries(req.headers))
            if (
              typeof value === "string" &&
              !["host", "connection", "content-length"].includes(key)
            )
              headers[key] = value;
          const r = await supervisor.request({
            method: req.method,
            url: req.url,
            headers,
            body: Buffer.concat(chunks).toString("base64"),
          });
          res.writeHead(r.status, r.headers);
          res.end(Buffer.from(r.body, "base64"));
        } catch {
          res.writeHead(503, { "content-type": "application/json" });
          res.end("{}");
        }
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      browser = new Browser("http://127.0.0.1:" + server.address().port);
      await browser.prepare();
      status(await browser.login(user.login_name, user.secret), 200);
      await browser.prepare();
      status(
        await browser.request("/auth/change-password", {
          method: "POST",
          body: {
            current_password: user.secret,
            new_password: require("./helpers.cjs").PASSWORD,
          },
        }),
        204,
      );
      await browser.prepare();
      status(
        await browser.login(user.login_name, require("./helpers.cjs").PASSWORD),
        200,
      );
      await browser.prepare();
      const headers = {
        "X-Org-Id": org,
        "Idempotency-Key": "synthetic-managed-assignment",
      };
      const url = "/training/courses/" + course + "/assign";
      const first = await browser.request(url, {
        method: "POST",
        headers,
        body: { class_id: classes[0] },
      });
      status(first, 200);
      assert.equal(first.data.data.status, "assigned");
      status(
        await browser.request(url, {
          method: "POST",
          headers,
          body: { class_id: classes[0] },
        }),
        200,
      );
      assert.equal(
        await f.db
          .collection("class_courses")
          .countDocuments({ course_id: course, class_id: classes[0] }),
        1,
      );
      status(
        await browser.request("/training/courses", {
          method: "POST",
          headers,
          body: {},
        }),
        503,
      );
      await assert.rejects(
        require("../dist/operations/control").acquireWriter(f.db, "learning"),
        /MANAGED_WRITER_REQUIRED/,
      );
      const captured = f.db.collection("users").updateOne;
      await assert.rejects(
        captured(
          { _id: user.user_id },
          { $set: { display_name: "must not write" } },
        ),
        /MANAGED_WRITER_REQUIRED/,
      );
      const learner = new Browser(browser.base);
      await learner.prepare();
      status(await learner.login(student.login_name, student.secret), 200);
      await learner.prepare();
      status(
        await learner.request("/auth/change-password", {
          method: "POST",
          body: {
            current_password: student.secret,
            new_password: require("./helpers.cjs").PASSWORD,
          },
        }),
        204,
      );
      await learner.prepare();
      status(
        await learner.login(
          student.login_name,
          require("./helpers.cjs").PASSWORD,
        ),
        200,
      );
      await learner.prepare();
      const from = new Date().toISOString(),
        to = new Date(Date.now() + 7 * 86400000).toISOString();
      const workbench = await learner.request(
        "/training/workbench?from=" +
          encodeURIComponent(from) +
          "&to=" +
          encodeURIComponent(to),
        { headers: { "X-Org-Id": org } },
      );
      status(workbench, 200);
      assert.ok(
        workbench.data.data.modules.courses.items.some(
          (row) => row.id === course || row.course_id === course,
        ),
      );
      const prior = await f.client
        .db()
        .collection("training_standalone_writer")
        .findOne({ key: "global" });
      const child = supervisor.child;
      const crashKey = "synthetic-crash-assignment";
      child.send({ kind: "arm-fault", key: crashKey });
      const fault = new Promise((resolve) => {
        const listener = (m) => {
          if (m?.kind === "fault-ready") {
            child.off("message", listener);
            resolve();
          }
        };
        child.on("message", listener);
      });
      const pending = browser.request(url, {
        method: "POST",
        headers: { "X-Org-Id": org, "Idempotency-Key": crashKey },
        body: { class_id: classes[1] },
      });
      await fault;
      let delivered = false;
      const waitingRead = browser
        .request("/training/courses", { headers: { "X-Org-Id": org } })
        .then((r) => {
          delivered = true;
          return r;
        });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(delivered, false);
      const queued = Array.from({ length: 62 }, () =>
        supervisor.request({
          method: "GET",
          url: "/api/v1/no-such-route",
          headers: {},
          body: "",
        }),
      );
      await assert.rejects(
        supervisor.request({
          method: "GET",
          url: "/api/v1/no-such-route",
          headers: {},
          body: "",
        }),
        /MANAGED_QUEUE_FULL/,
      );
      child.kill("SIGKILL");
      const resumed = await pending;
      status(resumed, 200);
      assert.equal(resumed.data.data.status, "assigned");
      status(await waitingRead, 200);
      for (const response of await Promise.all(queued))
        assert.equal(response.status, 404);
      const after = await f.client
        .db()
        .collection("training_standalone_writer")
        .findOne({ key: "global" });
      assert.equal(after.state, "idle");
      assert.ok(after.generation >= prior.generation + 2);
      assert.notEqual(supervisor.child.pid, child.pid);
      assert.equal(
        await f.db
          .collection("class_courses")
          .countDocuments({ class_id: classes[1] }),
        1,
      );
      assert.equal(
        await f.db
          .collection("training_idempotency")
          .countDocuments({ key: crashKey }),
        1,
      );
      assert.equal(
        await f.db
          .collection("audit_events")
          .countDocuments({
            action: "training.course.assign",
            resource_id: course,
          }),
        2,
      );
      assert.equal(
        await f.db
          .collection("operational_writers")
          .countDocuments({ state: "running" }),
        1,
      );
      const unauth = new Browser(browser.base);
      status(
        await unauth.request("/training/courses", {
          headers: { "X-Org-Id": org },
        }),
        401,
      );
      assert.equal(
        (
          await f.client
            .db()
            .collection("training_standalone_writer")
            .findOne({ key: "global" })
        ).state,
        "idle",
      );
    } finally {
      server?.closeAllConnections();
      if (server) await new Promise((resolve) => server.close(resolve));
      await supervisor.close();
    }
    assert.equal(
      await f.db
        .collection("operational_writers")
        .countDocuments({ state: "running" }),
      0,
    );
    const restartedClient = new MongoClient(f.uri);
    await restartedClient.connect();
    const restarted = new ManagedApiSupervisor(
      restartedClient,
      path.resolve(__dirname, "managed-api-fault-child.cjs"),
    );
    const racingClient = new MongoClient(f.uri);
    await racingClient.connect();
    const racing = new ManagedApiSupervisor(
      racingClient,
      path.resolve(__dirname, "managed-api-fault-child.cjs"),
    );
    try {
      const results = await Promise.allSettled([
        restarted.initialize(),
        racing.initialize(),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(
        await f.db
          .collection("operational_writers")
          .countDocuments({ state: "running" }),
        1,
      );
      const winner = results[0].status === "fulfilled" ? restarted : racing,
        child = winner.child,
        key = "synthetic-revoked-recovery";
      child.send({ kind: "arm-fault", key });
      const paused = new Promise((resolve) => {
        const listener = (m) => {
          if (m?.kind === "fault-ready") {
            child.off("message", listener);
            resolve();
          }
        };
        child.on("message", listener);
      });
      const command = {
        method: "POST",
        url: "/api/v1/training/courses/" + course + "/assign",
        headers: {
          origin: require("./helpers.cjs").ORIGIN,
          "x-org-id": org,
          "idempotency-key": key,
          "content-type": "application/json",
          "x-csrf-token": browser.csrf,
          cookie: [...browser.cookies]
            .map(([name, value]) => name + "=" + value)
            .join("; "),
        },
        body: Buffer.from(JSON.stringify({ class_id: classes[2] })).toString(
          "base64",
        ),
      };
      const executing = winner.request(command);
      executing.catch(() => {});
      await paused;
      // Simulated external revocation in a fixed write-before-ack window. Recovery must
      // re-authenticate and quarantine its partial association instead of returning success.
      await f.client
        .db()
        .collection("users")
        .updateOne(
          { _id: new (require("mongodb").ObjectId)(user.user_id) },
          { $set: { status: "disabled" } },
        );
      child.kill("SIGKILL");
      await assert.rejects(executing, /RECOVERY_REQUIRED/);
      assert.equal(
        (
          await f.client
            .db()
            .collection("training_standalone_writer")
            .findOne({ key: "global" })
        ).state,
        "quarantined",
      );
      assert.equal(
        await f.db
          .collection("class_courses")
          .countDocuments({ class_id: classes[2] }),
        1,
      );
      assert.equal(
        await f.db.collection("training_idempotency").countDocuments({ key }),
        0,
      );
      assert.equal(
        await f.db
          .collection("audit_events")
          .countDocuments({
            action: "training.course.assign",
            resource_id: course,
          }),
        2,
      );
      await assert.rejects(
        winner.request({
          method: "GET",
          url: "/api/v1/training/courses",
          headers: {},
          body: "",
        }),
        /PENDING|BLOCKED/,
      );
    } finally {
      await Promise.all([restarted.close(), racing.close()]);
    }
    const unknownClient = new MongoClient(f.uri);
    await unknownClient.connect();
    const unknown = new ManagedApiSupervisor(unknownClient);
    try {
      await assert.rejects(unknown.initialize(), /PENDING|BLOCKED/);
    } finally {
      await unknown.close();
    }
  },
);
