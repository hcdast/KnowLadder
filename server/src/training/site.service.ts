import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { ClientSession } from "mongodb";
import { runInTxn } from "../database/txn";
import { assertOperationalAccess } from "../operations/control";
import { ApiRequest, fail } from "../errors";
import { TrainingService } from "./training.service";
import * as v from "./validation";
const PAGES = [
  "home",
  "features",
  "ai-teaching",
  "solutions",
  "help",
  "about",
  "contact",
];
@Injectable()
export class SiteService {
  constructor(readonly training: TrainingService) {}
  async publicPage(key: string) {
    if (!PAGES.includes(key)) fail(404, "NOT_FOUND", "页面不存在");
    if (process.env.KL_TRAINING_ENABLED !== "true")
      return { page: null, consultation_enabled: false };
    await assertOperationalAccess(this.training.db);
    const activeOrg = await this.training.col("organizations").findOne({_id: process.env.KL_SITE_ORG_ID ?? "000000000000000000000000", status:"active"});
    if (!activeOrg) return {page:null, consultation_enabled:false, retention_days:null};
    const page = await this.training.col("site_revisions").findOne(
      {
        org_id: process.env.KL_SITE_ORG_ID ?? "000000000000000000000000",
        page_key: key,
        status: "published",
      },
      {
        sort: { updated_at: -1, _id: -1 },
        projection: { title: 1, body: 1 },
      },
    );
    return {
      page: page ? { title: page.title, body: page.body } : null,
      consultation_enabled: !!(await this.handler()),
      retention_days: (await this.handler())?.days ?? null,
    };
  }
  async handler(session?: ClientSession, write = false) {
    const org = process.env.KL_SITE_ORG_ID,
      member = process.env.KL_SITE_HANDLER_MEMBER_ID,
      days = Number(process.env.KL_SITE_LEAD_RETENTION_DAYS);
    if (
      !org ||
      !member ||
      !/^[a-f0-9]{24}$/.test(org) ||
      !/^[a-f0-9]{24}$/.test(member) ||
      !Number.isInteger(days) ||
      days < 1 ||
      days > 90
    )
      return null;
    const o = await this.training
      .col("organizations")
      .findOne({ _id: org, status: "active" }, { session });
    const m = await this.training
      .col("organization_members")
      .findOne({ _id: member, org_id: org, status: "active" }, { session });
    if (!o || !m) return null;
    const clock = await this.training.db
      .aggregate<{ now: Date }>(
        [{ $documents: [{}] }, { $project: { now: "$$NOW" } }],
        { session },
      )
      .next();
    if (!clock?.now) fail(503, "DATABASE_TIME_UNAVAILABLE", "数据库时间不可用");
    const now = clock.now;
    const g = await this.training.col("member_capability_grants").findOne(
      {
        org_id: org,
        member_id: member,
        capability: "site:lead-read",
        status: "active",
        valid_from: { $lte: now },
        $or: [{ valid_to: null }, { valid_to: { $gt: now } }],
      },
      { session },
    );
    const u = await this.training
      .col("users")
      .findOne(
        { _id: m.user_id, status: "active", privacy_state: "active" },
        { session },
      );
    if (!g || !u) return null;
    if (write) {
      for (const [name, row] of [
        ["organizations", o],
        ["organization_members", m],
        ["users", u],
        ["member_capability_grants", g],
      ] as const)
        await this.training
          .col(name)
          .updateOne(
            { _id: row._id },
            { $set: { updated_at: now } },
            { session },
          );
    }
    return { org, days, now };
  }
  async drafts(req: ApiRequest) {
    return this.training.run(req, false, async (ctx) => {
      this.training.access.requireAny(ctx, ["site:edit", "site:review"]);
      return {
        items: await this.training
          .col("site_revisions")
          .find({ org_id: ctx.orgId }, { session: ctx.session })
          .sort({ updated_at: -1 })
          .limit(100)
          .toArray(),
      };
    });
  }
  async create(req: ApiRequest, input: unknown) {
    const o = v.object(input, ["page_key", "title", "body"]);
    if (!PAGES.includes(o.page_key)) fail(422, "INVALID_PAGE", "页面类型无效");
    const title = v.text(o.title),
      body = v.text(o.body, 12000);
    return this.training.run(req, true, async (ctx) => {
      this.training.require(ctx, "site:edit");
      if (ctx.orgId !== process.env.KL_SITE_ORG_ID)
        fail(403, "SITE_ORGANIZATION_REQUIRED", "未指定为网站管理组织");
      return this.training.idem(
        ctx,
        req,
        "site.create",
        o.page_key,
        o,
        async () => {
          const r = {
            ...(await this.training.base(ctx)),
            page_key: o.page_key,
            title,
            body,
            status: "draft",
            author_id: ctx.userId,
            publisher_id: null,
          };
          await this.training
            .col("site_revisions")
            .insertOne(r, { session: ctx.session });
          await this.training.audit(ctx, "site_revision", r, "site.draft");
          return r;
        },
      );
    });
  }
  async publish(req: ApiRequest, key: string, input: unknown) {
    const o = v.object(input, ["expected_revision"]);
    return this.training.run(req, true, async (ctx) => {
      this.training.require(ctx, "site:review");
      if (ctx.orgId !== process.env.KL_SITE_ORG_ID)
        fail(403, "SITE_ORGANIZATION_REQUIRED", "未指定为网站管理组织");
      const row = await this.training.row(ctx, "site_revisions", key);
      if (row.author_id === ctx.userId)
        fail(403, "INDEPENDENT_REVIEW_REQUIRED", "网站内容需独立审核");
      return this.training.idem(ctx, req, "site.publish", key, o, async () => {
        if (row.status !== "draft") fail(409, "INVALID_STATE", "页面已经发布");
        const r = await this.training.cas(
          ctx,
          "site_revisions",
          row,
          o.expected_revision,
          { status: "published", publisher_id: ctx.userId },
        );
        await this.training.audit(ctx, "site_revision", r, "site.publish");
        return r;
      });
    });
  }
  async leads(req: ApiRequest) {
    return this.training.run(req, false, async (ctx) => {
      this.training.require(ctx, "site:lead-read");
      return {
        items: await this.training
          .col("site_leads")
          .find(
            {
              org_id: ctx.orgId,
              expires_at: { $gt: await this.training.access.now(ctx) },
            },
            { session: ctx.session, projection: { receipt_hash: 0 } },
          )
          .sort({ created_at: -1 })
          .limit(100)
          .toArray(),
      };
    });
  }
  async consultation(req: ApiRequest, input: unknown) {
    if (process.env.KL_TRAINING_ENABLED !== "true")
      fail(503, "SITE_LEADS_DISABLED", "咨询服务暂未开放");
    this.training.access.assessment.auth.origin(req);
    await this.training.access.assessment.auth.rate(
      "site-leads",
      req.ip ?? "anonymous",
      10,
    );
    const handler = await this.handler();
    if (!handler) fail(503, "SITE_LEADS_DISABLED", "咨询服务暂未开放");
    const o = v.object(input, [
      "receipt",
      "contact",
      "name",
      "kind",
      "consent",
    ]);
    if (
      o.consent !== true ||
      !["enterprise", "school", "other"].includes(o.kind)
    )
      fail(422, "CONSENT_REQUIRED", "请选择咨询类型并同意联系信息用途");
    const receipt = v.text(o.receipt, 64);
    if (!/^[a-f0-9]{64}$/.test(receipt))
      fail(422, "INVALID_RECEIPT", "回执编号无效");
    const contact = v.text(o.contact, 200),
      name = v.text(o.name, 80, true),
      receipt_hash = createHash("sha256").update(receipt).digest("hex");
    await assertOperationalAccess(this.training.db);
    return runInTxn(this.training.db.client, async (session) => {
      const current = await this.handler(session, true);
      if (!current) fail(503, "SITE_LEADS_DISABLED", "咨询服务暂未开放");
      const existing = await this.training
        .col("site_leads")
        .findOne({ receipt_hash }, { session });
      if (existing) {
        if (
          existing.contact !== contact ||
          existing.name !== name ||
          existing.kind !== o.kind
        )
          fail(409, "IDEMPOTENCY_CONFLICT", "回执已用于不同咨询");
        return { status: "received" };
      }
      const now = current.now;
      await this.training.col("site_leads").insertOne(
        {
          _id: (await import("../database/object-id")).newId(),
          org_id: current.org,
          revision: 1,
          created_at: now,
          updated_at: now,
          receipt_hash,
          contact,
          name,
          kind: o.kind,
          status: "new",
          consent_at: now,
          policy_revision: "site-leads-v1",
          expires_at: new Date(now.getTime() + current.days * 86400000),
        },
        { session },
      );
      return { status: "received" };
    });
  }
  async updateLead(req: ApiRequest, key: string, input: unknown) {
    const o = v.object(input, ["expected_revision", "status"]);
    if (!["contacted", "closed"].includes(o.status))
      fail(422, "INVALID_STATUS", "咨询状态无效");
    return this.training.run(req, true, async (ctx) => {
      this.training.require(ctx, "site:lead-read");
      const row = await this.training.row(ctx, "site_leads", key);
      if (row.expires_at <= (await this.training.access.now(ctx)))
        fail(404, "NOT_FOUND", "咨询已过期");
      return this.training.idem(
        ctx,
        req,
        "site.lead-status",
        key,
        o,
        async () => {
          const r = await this.training.cas(
            ctx,
            "site_leads",
            row,
            o.expected_revision,
            { status: o.status },
          );
          await this.training.audit(ctx, "site_lead", r, "site.lead-status");
          return { status: r.status, revision: r.revision };
        },
      );
    });
  }
  async receipt(req: ApiRequest, key: string) {
    if (process.env.KL_TRAINING_ENABLED !== "true")
      fail(503, "SITE_LEADS_DISABLED", "咨询服务暂未开放");
    await this.training.access.assessment.auth.rate(
      "site-receipt",
      req.ip ?? "anonymous",
      30,
    );
    if (!/^[a-f0-9]{64}$/.test(key)) fail(404, "NOT_FOUND", "回执不存在");
    const row = await this.training.col("site_leads").findOne({
      receipt_hash: createHash("sha256").update(key).digest("hex"),
      expires_at: { $gt: new Date() },
    });
    if (!row) fail(404, "NOT_FOUND", "回执不存在或已过期");
    return { status: row.status };
  }
}
