import { Controller, Get, Param, Req, Res } from "@nestjs/common";
import type { Response } from "express";
import { ApiRequest, fail } from "../errors";
import { TrainingPhase2Service } from "./phase2.service";
@Controller("api/v1/training-public")
export class TrainingPhase2PublicController {
  private readonly rates = new Map<string, { count: number; until: number }>();
  constructor(readonly service: TrainingPhase2Service) {}
  @Get("verification/:token") async verify(
    @Req() req: ApiRequest,
    @Param("token") token: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader("Cache-Control", "no-store");
    const now = Date.now();
    for (const [key, value] of this.rates)
      if (value.until <= now) this.rates.delete(key);
    const key = req.ip || "unknown";
    const row = this.rates.get(key) ?? { count: 0, until: now + 60000 };
    if (row.count >= 20 || (this.rates.size >= 1000 && !this.rates.has(key)))
      fail(429, "RATE_LIMITED", "验证请求过多");
    row.count++;
    this.rates.set(key, row);
    return {
      data: await this.service.verifyCertificate(token),
      request_id: req.requestId,
    };
  }
}
