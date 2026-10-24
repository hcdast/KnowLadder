import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from "@nestjs/common";
import { ApiCookieAuth, ApiHeader, ApiTags } from "@nestjs/swagger";
import { ApiRequest } from "../errors";
import { LearningStudioService } from "./studio.service";
@ApiTags("学习笔记、教师答疑与共学")
@ApiCookieAuth("session")
@ApiHeader({ name: "X-Org-Id", required: true })
@Controller("api/v1/training/studio")
export class LearningStudioController {
  constructor(readonly service: LearningStudioService) {}
  async result(req: ApiRequest, result: Promise<unknown>) { return { data: await result, request_id: req.requestId }; }
  @Get("catalog") catalog(@Req() r: ApiRequest) { return this.result(r, this.service.catalog(r)); }
  @Post("receipts/query") @HttpCode(200) receipt(@Req() r: ApiRequest, @Body() b: unknown) { return this.result(r, this.service.receipt(r, b)); }
  @Get("questions/:id") question(@Req() r: ApiRequest, @Param("id") id: string) { return this.result(r, this.service.questionDetail(r, id)); }
  @Get("meetups/:id") meetup(@Req() r: ApiRequest, @Param("id") id: string, @Query() q: unknown) { return this.result(r, this.service.meetupDetail(r, id, q)); }
  @Get(":kind") list(@Req() r: ApiRequest, @Param("kind") kind: string, @Query() q: unknown) { return this.result(r, this.service.list(r, kind, q)); }
  @Post("notes") @HttpCode(200) noteCreate(@Req() r: ApiRequest, @Body() b: unknown) { return this.result(r, this.service.createNote(r, b)); }
  @Post("notes/:id/actions") @HttpCode(200) noteAction(@Req() r: ApiRequest, @Param("id") id: string, @Body() b: unknown) { return this.result(r, this.service.noteAction(r, id, b)); }
  @Post("questions") @HttpCode(200) questionCreate(@Req() r: ApiRequest, @Body() b: unknown) { return this.result(r, this.service.createQuestion(r, b)); }
  @Post("questions/:id/actions") @HttpCode(200) questionAction(@Req() r: ApiRequest, @Param("id") id: string, @Body() b: unknown) { return this.result(r, this.service.questionAction(r, id, b)); }
  @Post("meetups") @HttpCode(200) meetupCreate(@Req() r: ApiRequest, @Body() b: unknown) { return this.result(r, this.service.createMeetup(r, b)); }
  @Post("meetups/:id/actions") @HttpCode(200) meetupAction(@Req() r: ApiRequest, @Param("id") id: string, @Body() b: unknown) { return this.result(r, this.service.meetupAction(r, id, b)); }
}
