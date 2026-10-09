import { Controller, Get, Req, Query } from "@nestjs/common";
import { ApiRequest } from "../errors";
import { WorkbenchService } from "./workbench.service";
import { ApiCookieAuth, ApiHeader, ApiTags } from "@nestjs/swagger";
@ApiTags("本人学员工作台")
@ApiCookieAuth("session")
@ApiHeader({ name: "X-Org-Id", required: true })
@Controller("api/v1/training/workbench")
export class WorkbenchController {
  constructor(readonly service: WorkbenchService) {}
  @Get() async read(
    @Req() r: ApiRequest,
    @Query("from") from: string,
    @Query("to") to: string,
  ) {
    return {
      data: await this.service.read(r, from, to),
      request_id: r.requestId,
    };
  }
}
