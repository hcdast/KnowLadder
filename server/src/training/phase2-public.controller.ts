import { Controller, Get, HttpException, Param, Req, Res } from "@nestjs/common";
import type { Response } from "express";
import { ApiRequest } from "../errors";
import { AuthService } from "../auth.service";
import { TrainingPhase2Service } from "./phase2.service";
@Controller("api/v1/training-public")
export class TrainingPhase2PublicController {
  constructor(readonly service: TrainingPhase2Service, readonly auth: AuthService) {}
  @Get("verification/:token") async verify(@Req() req: ApiRequest, @Param("token") token: string, @Res({passthrough:true}) res: Response) {
    res.setHeader("Cache-Control", "no-store");
    try { await this.auth.rate("certificate-verification", req.ip || "unknown", 20, 60000); }
    catch (error) { if (error instanceof HttpException && error.getStatus() === 429) res.setHeader("Retry-After", "60"); throw error; }
    return {data: await this.service.verifyCertificate(token), request_id: req.requestId};
  }
}
