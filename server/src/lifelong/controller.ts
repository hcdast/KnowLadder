import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { ApiCookieAuth, ApiTags } from "@nestjs/swagger";
import { ApiRequest, fail } from "../errors";
import { LifelongService } from "./service";

@ApiTags("个人终身学习")
@ApiCookieAuth("session")
@Controller("api/v1/personal")
export class LifelongController {
  constructor(readonly lifelong: LifelongService) {}
  private async result(req: ApiRequest, work: Promise<unknown>) {
    return { data: await work, request_id: req.requestId };
  }
  @Get("capabilities") capabilities(@Req() r: ApiRequest) {
    return this.result(r, this.lifelong.capabilities(r));
  }
  @Get("courses") courses(@Req() r: ApiRequest, @Query() q: unknown) {
    return this.result(r, this.lifelong.courses(r, q));
  }
  @Get("study-items") studyItems(@Req() r: ApiRequest, @Query() q: unknown) {
    return this.result(r, this.lifelong.studyItems(r, q));
  }
  @Get("agenda") agenda(@Req() r: ApiRequest, @Query() q: unknown) {
    return this.result(r, this.lifelong.agenda(r, q));
  }
  @Post("agenda") @HttpCode(200) createAgenda(@Req() r: ApiRequest, @Body() b: unknown) {
    return this.result(r, this.lifelong.saveAgenda(r, b));
  }
  @Patch("agenda/:id") updateAgenda(@Req() r: ApiRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.result(r, this.lifelong.saveAgenda(r, b, id));
  }
  @Post("agenda/:id/state") @HttpCode(200) agendaState(@Req() r: ApiRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.result(r, this.lifelong.agendaState(r, id, b));
  }
  @Post("agenda/:id/remove") @HttpCode(200) removeAgenda(@Req() r: ApiRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.result(r, this.lifelong.removeAgenda(r, id, b));
  }
  @Get("week-overview") weekOverview(@Req() r: ApiRequest, @Query() q: unknown) {
    return this.result(r, this.lifelong.weekOverview(r, q));
  }
  @Get("week-reviews") weekReviews(@Req() r: ApiRequest, @Query() q: unknown) {
    return this.result(r, this.lifelong.weekReviews(r, q));
  }
  @Post("week-reviews") @HttpCode(200) saveWeekReview(@Req() r: ApiRequest, @Body() b: unknown) {
    return this.result(r, this.lifelong.saveWeekReview(r, b));
  }
  @Post("week-reviews/:id/remove") @HttpCode(200) removeWeekReview(@Req() r: ApiRequest, @Param("id") id: string, @Body() b: unknown) {
    return this.result(r, this.lifelong.removeWeekReview(r, id, b));
  }
  @Get("review-history") reviewHistory(@Req() r: ApiRequest, @Query() q: unknown) {
    return this.result(r, this.lifelong.reviewHistory(r, q));
  }
  @Get("study-items/:id/reviews") studyReviews(@Req() r: ApiRequest, @Param("id") id: string, @Query() q: unknown) {
    return this.result(r, this.lifelong.reviewHistory(r, q, id));
  }
  @Post("study-items") @HttpCode(200) createStudy(
    @Req() r: ApiRequest,
    @Body() b: unknown,
  ) {
    return this.result(r, this.lifelong.saveStudyItem(r, b));
  }
  @Patch("study-items/:id") updateStudy(
    @Req() r: ApiRequest,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return this.result(r, this.lifelong.saveStudyItem(r, b, id));
  }
  @Post("study-items/:id/review") @HttpCode(200) reviewStudy(
    @Req() r: ApiRequest,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return this.result(r, this.lifelong.reviewStudyItem(r, id, b));
  }
  @Post("study-items/:id/remove") @HttpCode(200) removeStudy(
    @Req() r: ApiRequest,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return this.result(r, this.lifelong.removeStudyItem(r, id, b));
  }
  @Get("courses/:course") course(
    @Req() r: ApiRequest,
    @Param("course") course: string,
  ) {
    return this.result(r, this.lifelong.courseDetail(r, course));
  }
  @Post("courses/:course/enroll") @HttpCode(200) enroll(
    @Req() r: ApiRequest,
    @Param("course") course: string,
    @Body() b: unknown,
  ) {
    return this.result(r, this.lifelong.enrollCourse(r, course, b));
  }
  @Post("courses/:course/units/:unit/complete") @HttpCode(200) completeUnit(
    @Req() r: ApiRequest,
    @Param("course") course: string,
    @Param("unit") unit: string,
    @Body() b: unknown,
  ) {
    return this.result(r, this.lifelong.completeCourseUnit(r, course, unit, b));
  }
  @Get("operations/:key") receipt(
    @Req() r: ApiRequest,
    @Param("key") key: string,
  ) {
    return this.result(r, this.lifelong.receipt(r, key));
  }
  @Post("operations/:key/cancel") @HttpCode(200) cancel(
    @Req() r: ApiRequest,
    @Param("key") key: string,
    @Body() b: unknown,
  ) {
    return this.result(r, this.lifelong.cancel(r, key, b));
  }
  @Get("supports") supports(@Req() r: ApiRequest, @Query() q: unknown) {
    return this.result(r, this.lifelong.supports(r, q));
  }
  @Post("supports") @HttpCode(200) createSupport(
    @Req() r: ApiRequest,
    @Body() b: unknown,
  ) {
    return this.result(r, this.lifelong.createSupport(r, b));
  }
  @Post("support-invitation/preview") @HttpCode(200) preview(
    @Req() r: ApiRequest,
    @Body() b: unknown,
  ) {
    return this.result(r, this.lifelong.invitation(r, b, false));
  }
  @Post("support-invitation/accept") @HttpCode(200) accept(
    @Req() r: ApiRequest,
    @Body() b: unknown,
  ) {
    return this.result(r, this.lifelong.invitation(r, b, true));
  }
  @Post("supports/:id/revoke") @HttpCode(200) revoke(
    @Req() r: ApiRequest,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return this.result(r, this.lifelong.revoke(r, id, b));
  }
  @Get("supports/:id/records") shared(
    @Req() r: ApiRequest,
    @Param("id") id: string,
  ) {
    return this.result(r, this.lifelong.shared(r, id));
  }
  @Get("supports/:id/invitation") code(
    @Req() r: ApiRequest,
    @Param("id") id: string,
  ) {
    return this.result(r, this.lifelong.invitationCode(r, id));
  }
  @Post("supports/:id/feedback") @HttpCode(200) feedback(
    @Req() r: ApiRequest,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return this.result(r, this.lifelong.feedback(r, id, b));
  }
  @Get("assurances") assurances(@Req() r: ApiRequest, @Query() q: unknown) {
    return this.result(r, this.lifelong.assurances(r, q));
  }
  @Get("institutions/:org/assurances") queue(
    @Req() r: ApiRequest,
    @Param("org") org: string,
    @Query() q: unknown,
  ) {
    return this.result(r, this.lifelong.reviewQueue(r, org, q));
  }
  @Get("institutions/:org/participants") participants(
    @Req() r: ApiRequest,
    @Param("org") org: string,
    @Query() q: unknown,
  ) {
    return this.result(r, this.lifelong.participants(r, org, q));
  }
  @Post("assurances") @HttpCode(200) propose(
    @Req() r: ApiRequest,
    @Body() b: unknown,
  ) {
    return this.result(r, this.lifelong.proposeAssurance(r, b));
  }
  @Post("assurances/:id/review") @HttpCode(200) review(
    @Req() r: ApiRequest,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return this.result(r, this.lifelong.reviewAssurance(r, id, b));
  }
  // Explicit allowlists keep arbitrary collection names out of the persistence layer.
  private records(kind: string): "goals" | "activities" | "feedback" {
    if (kind !== "goals" && kind !== "activities" && kind !== "feedback")
      fail(404, "NOT_FOUND", "页面不存在");
    return kind;
  }
  @Get(":kind") list(
    @Req() r: ApiRequest,
    @Param("kind") kind: string,
    @Query() q: unknown,
  ) {
    return this.result(r, this.lifelong.list(r, this.records(kind), q));
  }
  @Post(":kind") @HttpCode(200) create(
    @Req() r: ApiRequest,
    @Param("kind") kind: string,
    @Body() b: unknown,
  ) {
    if (kind !== "goals" && kind !== "activities")
      fail(404, "NOT_FOUND", "页面不存在");
    return this.result(
      r,
      kind === "goals"
        ? this.lifelong.saveGoal(r, b)
        : this.lifelong.saveActivity(r, b),
    );
  }
  @Patch(":kind/:id") save(
    @Req() r: ApiRequest,
    @Param("kind") kind: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    if (kind !== "goals" && kind !== "activities")
      fail(404, "NOT_FOUND", "页面不存在");
    return this.result(
      r,
      kind === "goals"
        ? this.lifelong.saveGoal(r, b, id)
        : this.lifelong.saveActivity(r, b, id),
    );
  }
  @Post(":kind/:id/remove") @HttpCode(200) remove(
    @Req() r: ApiRequest,
    @Param("kind") kind: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return this.result(r, this.lifelong.remove(r, this.records(kind), id, b));
  }
}
