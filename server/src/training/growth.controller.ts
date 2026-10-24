import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { ApiCookieAuth, ApiHeader, ApiTags } from "@nestjs/swagger";
import { ApiRequest } from "../errors";
import { LearningGrowthService } from "./growth.service";
@ApiTags("成长档案与学习通知")
@ApiCookieAuth("session")
@ApiHeader({ name: "X-Org-Id", required: true })
@Controller("api/v1/training/growth")
export class LearningGrowthController {
  constructor(readonly service: LearningGrowthService) {}
  async result(req: ApiRequest, promise: Promise<unknown>) {
    return { data: await promise, request_id: req.requestId };
  }
  @Get("portfolio/export") exportPortfolio(
    @Req() r: ApiRequest,
    @Query() q: unknown,
  ) {
    return this.result(r, this.service.exportPortfolio(r, q));
  }
  @Get("portfolio") portfolio(@Req() r: ApiRequest, @Query() q: unknown) {
    return this.result(r, this.service.portfolio(r, q));
  }
  @Get("recipients") recipients(@Req() r: ApiRequest, @Query() q: unknown) {
    return this.result(r, this.service.recipients(r, q));
  }
  @Get("shares") shares(@Req() r: ApiRequest, @Query() q: unknown) {
    return this.result(r, this.service.shares(r, q));
  }
  @Get("shares/:id") share(@Req() r: ApiRequest, @Param("id") id: string) {
    return this.result(r, this.service.shareDetail(r, id));
  }
  @Post("shares") @HttpCode(200) create(
    @Req() r: ApiRequest,
    @Body() b: unknown,
  ) {
    return this.result(r, this.service.createShare(r, b));
  }
  @Post("shares/:id/revoke") @HttpCode(200) revoke(
    @Req() r: ApiRequest,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return this.result(r, this.service.revokeShare(r, id, b));
  }
  @Get("inbox") inbox(@Req() r: ApiRequest, @Query() q: unknown) {
    return this.result(r, this.service.notifications(r, q));
  }
  @Post("inbox/:id/read") @HttpCode(200) read(
    @Req() r: ApiRequest,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return this.result(r, this.service.readNotification(r, id, b));
  }
  @Get("preferences") preferences(@Req() r: ApiRequest) {
    return this.result(r, this.service.preferences(r));
  }
  @Post("preferences") @HttpCode(200) savePreferences(
    @Req() r: ApiRequest,
    @Body() b: unknown,
  ) {
    return this.result(r, this.service.savePreferences(r, b));
  }
  @Post("receipts/query") @HttpCode(200) receipt(
    @Req() r: ApiRequest,
    @Body() b: unknown,
  ) {
    return this.result(r, this.service.receipt(r, b));
  }
}
