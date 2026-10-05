import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { ApiRequest } from "../errors";
import { SiteService } from "./site.service";
@ApiTags("网站内容与咨询")
@Controller("api/v1/site")
export class SiteController {
  constructor(readonly site: SiteService) {}
  async result(r: ApiRequest, p: Promise<unknown>) {
    return { data: await p, request_id: r.requestId };
  }
  @Get("pages/:key") page(@Req() r: ApiRequest, @Param("key") k: string) {
    return this.result(r, this.site.publicPage(k));
  }
  @Post("consultations") @HttpCode(200) consult(
    @Req() r: ApiRequest,
    @Body() b: unknown,
  ) {
    return this.result(r, this.site.consultation(r, b));
  }
  @Get("consultations/:receipt") receipt(
    @Req() r: ApiRequest,
    @Param("receipt") k: string,
  ) {
    return this.result(r, this.site.receipt(r, k));
  }
  @Get("drafts") drafts(@Req() r: ApiRequest) {
    return this.result(r, this.site.drafts(r));
  }
  @Post("drafts") @HttpCode(200) create(
    @Req() r: ApiRequest,
    @Body() b: unknown,
  ) {
    return this.result(r, this.site.create(r, b));
  }
  @Post("drafts/:id/publish") @HttpCode(200) publish(
    @Req() r: ApiRequest,
    @Param("id") k: string,
    @Body() b: unknown,
  ) {
    return this.result(r, this.site.publish(r, k, b));
  }
  @Post("leads/:id/status") @HttpCode(200) updateLead(
    @Req() r: ApiRequest,
    @Param("id") k: string,
    @Body() b: unknown,
  ) {
    return this.result(r, this.site.updateLead(r, k, b));
  }
  @Get("leads") leads(@Req() r: ApiRequest) {
    return this.result(r, this.site.leads(r));
  }
}
