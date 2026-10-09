import { Body, Controller, Get, HttpCode, Post, Req } from "@nestjs/common";
import { ApiCookieAuth, ApiTags } from "@nestjs/swagger";
import { ApiRequest } from "../errors";
import { KnowledgeService } from "./knowledge.service";
@ApiTags("knowledge")
@ApiCookieAuth("kl_session")
@Controller("api/v1/training/knowledge")
export class KnowledgeController {
  constructor(readonly service: KnowledgeService) {}
  @Get("sources") async sources(@Req() req: ApiRequest) {
    return { data: await this.service.options(req), request_id: req.requestId };
  }
  @Post("search") @HttpCode(200) async search(
    @Req() req: ApiRequest,
    @Body() body: unknown,
  ) {
    return {
      data: await this.service.search(req, body),
      request_id: req.requestId,
    };
  }
  @Post("rebuild") @HttpCode(200) async rebuild(
    @Req() req: ApiRequest,
    @Body() body: unknown,
  ) {
    return {
      data: await this.service.rebuild(req, body),
      request_id: req.requestId,
    };
  }
  @Get("status") async status(@Req() req: ApiRequest) {
    return { data: await this.service.status(req), request_id: req.requestId };
  }
}
