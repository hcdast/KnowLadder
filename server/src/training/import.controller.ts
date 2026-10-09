import {
  Controller,
  Get,
  Post,
  Param,
  Req,
  Body,
  HttpCode,
} from "@nestjs/common";
import { ApiRequest } from "../errors";
import { ImportService } from "./import.service";
@Controller("api/v1/admin/textbook-editions/:ownerId/imports")
export class ImportController {
  @Get("provenance") provenance(
    @Req() req: ApiRequest,
    @Param("ownerId") ownerId: string,
  ) {
    return this.result(req, this.imports.provenance(req, ownerId));
  }

  @Get("requests/:key") receipt(
    @Req() req: ApiRequest,
    @Param("ownerId") ownerId: string,
    @Param("key") key: string,
  ) {
    return this.result(req, this.imports.receipt(req, ownerId, key));
  }
  constructor(readonly imports: ImportService) {}
  private async result(req: ApiRequest, promise: Promise<unknown>) {
    return { data: await promise, request_id: req.requestId };
  }
  @Post() @HttpCode(200) create(
    @Req() req: ApiRequest,
    @Param("ownerId") ownerId: string,
    @Body() body: unknown,
  ) {
    return this.result(req, this.imports.create(req, ownerId, body));
  }
  @Get() list(@Req() req: ApiRequest, @Param("ownerId") ownerId: string) {
    return this.result(req, this.imports.list(req, ownerId));
  }
  @Get(":jobId") read(
    @Req() req: ApiRequest,
    @Param("ownerId") ownerId: string,
    @Param("jobId") jobId: string,
  ) {
    return this.result(req, this.imports.read(req, ownerId, jobId));
  }
  @Post(":jobId/cancel") @HttpCode(200) cancel(
    @Req() req: ApiRequest,
    @Param("ownerId") ownerId: string,
    @Param("jobId") jobId: string,
    @Body() body: unknown,
  ) {
    return this.result(req, this.imports.cancel(req, ownerId, jobId, body));
  }
  @Post(":jobId/apply") @HttpCode(200) apply(
    @Req() req: ApiRequest,
    @Param("ownerId") ownerId: string,
    @Param("jobId") jobId: string,
    @Body() body: unknown,
  ) {
    return this.result(req, this.imports.apply(req, ownerId, jobId, body));
  }
}
