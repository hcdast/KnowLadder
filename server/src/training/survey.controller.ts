import {
  Controller,
  Get,
  Post,
  Put,
  Param,
  Query,
  Req,
  Body,
  HttpCode,
} from "@nestjs/common";
import { ApiCookieAuth, ApiHeader, ApiTags } from "@nestjs/swagger";
import { ApiRequest, fail } from "../errors";
import { SurveyService } from "./survey.service";
@ApiTags("课程实名反馈")
@ApiCookieAuth("session")
@ApiHeader({ name: "X-Org-Id", required: true })
@Controller("api/v1/training/surveys")
export class SurveyController {
  constructor(readonly service: SurveyService) {}
  private mode(value?: string) {
    if (value !== undefined && value !== "manage" && value !== "learner")
      fail(422, "INVALID_INPUT", "视图模式无效");
    return value === "manage";
  }
  private async result(req: ApiRequest, p: Promise<unknown>) {
    return { data: await p, request_id: req.requestId };
  }
  @Get() list(
    @Req() r: ApiRequest,
    @Query("course_id") id: string,
    @Query("mode") mode?: string,
  ) {
    return this.result(r, this.service.list(r, id, this.mode(mode)));
  }
  @Post() @HttpCode(200) create(@Req() r: ApiRequest, @Body() b: unknown) {
    return this.result(r, this.service.create(r, b));
  }
  @Post("receipts/query") @HttpCode(200) receipt(
    @Req() r: ApiRequest,
    @Body() b: unknown,
  ) {
    return this.result(r, this.service.receipt(r, b));
  }
  @Get(":id/results") results(
    @Req() r: ApiRequest,
    @Param("id") id: string,
    @Query("cursor") cursor?: string,
  ) {
    return this.result(r, this.service.results(r, id, cursor));
  }
  @Get(":id") read(
    @Req() r: ApiRequest,
    @Param("id") id: string,
    @Query("mode") mode?: string,
  ) {
    return this.result(r, this.service.read(r, id, this.mode(mode)));
  }
  @Put(":id") edit(
    @Req() r: ApiRequest,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return this.result(r, this.service.edit(r, id, b));
  }
  @Post(":id/actions") @HttpCode(200) action(
    @Req() r: ApiRequest,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return this.result(r, this.service.action(r, id, b));
  }
  @Post(":id/responses") @HttpCode(200) submit(
    @Req() r: ApiRequest,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return this.result(r, this.service.submit(r, id, b));
  }
}
