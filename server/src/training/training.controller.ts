import {TrainingPhase2Service} from './phase2.service';
import {TrainingReportService} from './report.service';
import { CourseworkFilesService } from "./coursework-files.service";
import type { Response } from "express";
import { Put, Res } from "@nestjs/common";
import {
  Body,
  Query,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import { ApiCookieAuth, ApiHeader, ApiTags } from "@nestjs/swagger";
import { ApiRequest, fail } from "../errors";
import { TrainingService } from "./training.service";
import { TrainingAiService } from "./ai.service";
@ApiTags("培训课程、任务、作业与AI")
@ApiCookieAuth("session")
@ApiHeader({ name: "X-Org-Id", required: true })
@Controller("api/v1/training")
export class TrainingController {
  constructor(
    readonly service: TrainingService,
    readonly phase2:TrainingPhase2Service,
    readonly reports: TrainingReportService,
    readonly ai: TrainingAiService,
    readonly courseworkFiles: CourseworkFilesService,
  ) {}
  @Get('reports') reportsList(@Req() r:ApiRequest){return this.result(r,this.reports.list(r));}
  @Get('reports/:id') reportGet(@Req() r:ApiRequest,@Param('id') id:string){return this.result(r,this.reports.get(r,id));}
  @Post('reports') @HttpCode(200) reportCreate(@Req() r:ApiRequest,@Body() b:unknown){return this.result(r,this.reports.create(r,b));}
  @Post('reports/:id/actions') @HttpCode(200) reportAction(@Req() r:ApiRequest,@Param('id') id:string,@Body() b:unknown){return this.result(r,this.reports.action(r,id,b));}

 @Post('phase2/receipts/query') @HttpCode(200) phase2Receipt(@Req() r:ApiRequest,@Body() b:unknown){return this.result(r,this.phase2.receipt(r,b));}
 @Get('phase2/:kind') phase2List(@Req() r:ApiRequest,@Param('kind') k:string){return this.result(r,this.phase2.list(r,k));}
 @Post('phase2/locations') @HttpCode(200) phase2Location(@Req() r:ApiRequest,@Body() b:unknown){return this.result(r,this.phase2.createLocation(r,b));}
 @Post('phase2/schedule') @HttpCode(200) phase2Schedule(@Req() r:ApiRequest,@Body() b:unknown){return this.result(r,this.phase2.createSchedule(r,b));}
 @Post('phase2/schedule/:id/actions') @HttpCode(200) phase2ScheduleAction(@Req() r:ApiRequest,@Param('id') id:string,@Body() b:unknown){return this.result(r,this.phase2.scheduleAction(r,id,b));}
 @Post('phase2/schedule/:id/attendance') @HttpCode(200) phase2Attendance(@Req() r:ApiRequest,@Param('id') id:string,@Body() b:unknown){return this.result(r,this.phase2.attendance(r,id,b));}
 @Post('phase2/leave') @HttpCode(200) phase2Leave(@Req() r:ApiRequest,@Body() b:unknown){return this.result(r,this.phase2.createLeave(r,b));}
 @Post('phase2/leave/:id/actions') @HttpCode(200) phase2LeaveAction(@Req() r:ApiRequest,@Param('id') id:string,@Body() b:unknown){return this.result(r,this.phase2.leaveAction(r,id,b));}
 @Post('phase2/paths') @HttpCode(200) phase2Path(@Req() r:ApiRequest,@Body() b:unknown){return this.result(r,this.phase2.createPath(r,b));}
 @Post('phase2/paths/:id/actions') @HttpCode(200) phase2PathAction(@Req() r:ApiRequest,@Param('id') id:string,@Body() b:unknown){return this.result(r,this.phase2.pathAction(r,id,b));}
 @Get('phase2/completions/:id') phase2Completion(@Req() r:ApiRequest,@Param('id') id:string){return this.result(r,this.phase2.completion(r,id));}
 @Post('phase2/certificates') @HttpCode(200) phase2Issue(@Req() r:ApiRequest,@Body() b:unknown){return this.result(r,this.phase2.issueCertificate(r,b));}
 @Post('phase2/certificates/:id/revoke') @HttpCode(200) phase2Revoke(@Req() r:ApiRequest,@Param('id') id:string,@Body() b:unknown){return this.result(r,this.phase2.revokeCertificate(r,id,b));}
 @Post('phase2/notifications/:id/read') @HttpCode(200) phase2Read(@Req() r:ApiRequest,@Param('id') id:string,@Body() b:unknown){return this.result(r,this.phase2.readNotification(r,id,b));}
 @Get('phase2-catalog') phase2Catalog(@Req() r:ApiRequest){return this.result(r,this.phase2.catalog(r));}
 @Get('phase2-overview') phase2Overview(@Req() r:ApiRequest){return this.result(r,this.phase2.overview(r));}

  async result(req: ApiRequest, p: Promise<unknown>) {
    return { data: await p, request_id: req.requestId };
  }
  @Post("receipts/query") @HttpCode(200) receipt(
    @Req() r: ApiRequest,
    @Body() b: unknown,
  ) {
    return this.result(r, this.service.receipt(r, b));
  }
  @Get("catalog") catalog(@Req() r: ApiRequest) {
    return this.result(r, this.service.catalog(r));
  }
  @Get("courses") courses(@Req() r: ApiRequest) {
    return this.result(r, this.service.listCourses(r));
  }
  @Get("courses/:id") course(@Req() r: ApiRequest, @Param("id") id: string, @Query("mode") mode?:string) {
    if(mode!==undefined && mode!=="learner")fail(422,"INVALID_INPUT","课程视图模式无效");
    return this.result(r, this.service.course(r, id, mode === "learner"));
  }
  @Post("courses") @HttpCode(200) create(
    @Req() r: ApiRequest,
    @Body() b: unknown,
  ) {
    return this.result(r, this.service.createCourse(r, b));
  }
  @Post("courses/:id/actions") @HttpCode(200) change(
    @Req() r: ApiRequest,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return this.result(r, this.service.changeCourse(r, id, b));
  }
  @Post("courses/:id/assignments/preview") @HttpCode(200) previewAssignments(@Req() r:ApiRequest,@Param("id") id:string,@Body() b:unknown){return this.result(r,this.service.previewAssignments(r,id,b));}
  @Post("courses/:id/assign") @HttpCode(200) assign(
    @Req() r: ApiRequest,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return this.result(r, this.service.assignCourse(r, id, b));
  }
  @Post("courses/:id/progress") @HttpCode(200) progress(
    @Req() r: ApiRequest,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return this.result(r, this.service.progress(r, id, b));
  }
  @Get("tasks") tasks(@Req() r: ApiRequest) {
    return this.result(r, this.service.tasks(r));
  }
  @Post("tasks") @HttpCode(200) createTask(
    @Req() r: ApiRequest,
    @Body() b: unknown,
  ) {
    return this.result(r, this.service.createTask(r, b));
  }
  @Post("tasks/:id/actions") @HttpCode(200) changeTask(
    @Req() r: ApiRequest,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return this.result(r, this.service.changeTask(r, id, b));
  }
  @Get("tasks/:id/coursework") coursework(
    @Req() r: ApiRequest,
    @Param("id") id: string,
  ) {
    return this.result(r, this.service.coursework(r, id));
  }
  @Post("tasks/:id/coursework") @HttpCode(200) write(
    @Req() r: ApiRequest,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return this.result(r, this.service.writeCoursework(r, id, b));
  }
  @Get("tasks/:id/submissions") submissions(
    @Req() r: ApiRequest,
    @Param("id") id: string,
  ) {
    return this.result(r, this.service.submissions(r, id));
  }
  @Post("tasks/:id/feedback") @HttpCode(200) feedback(
    @Req() r: ApiRequest,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return this.result(r, this.service.feedback(r, id, b));
  }
  @Post("tasks/:id/files") @HttpCode(200) registerCourseworkFile(
    @Req() r: ApiRequest,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return this.result(r, this.courseworkFiles.register(r, id, b));
  }
  @Get("tasks/:id/files") courseworkFileList(
    @Req() r: ApiRequest,
    @Param("id") id: string,
  ) {
    return this.result(r, this.courseworkFiles.list(r, id));
  }
  @Get("coursework-files/:id") courseworkFile(
    @Req() r: ApiRequest,
    @Param("id") id: string,
  ) {
    return this.result(r, this.courseworkFiles.status(r, id));
  }
  @Put("coursework-files/:id/content") @HttpCode(200) uploadCourseworkFile(
    @Req() r: ApiRequest,
    @Param("id") id: string,
  ) {
    return this.result(r, this.courseworkFiles.upload(r, id));
  }
  @Get("coursework-files/:id/content") downloadCourseworkFile(
    @Req() r: ApiRequest,
    @Param("id") id: string,
    @Res() res: Response,
  ) {
    return this.courseworkFiles.download(r, id, res);
  }
  @Get("ai/status") status(@Req() r: ApiRequest) {
    return this.result(r, this.ai.status(r));
  }
  @Post("ai/config") @HttpCode(200) config(
    @Req() r: ApiRequest,
    @Body() b: unknown,
  ) {
    return this.result(r, this.ai.configure(r, b));
  }
  @Post("ai/jobs") @HttpCode(200) job(
    @Req() r: ApiRequest,
    @Body() b: unknown,
  ) {
    return this.result(r, this.ai.create(r, b));
  }
  @Get("ai/jobs") listJobs(@Req() r: ApiRequest) {
    return this.result(r, this.ai.list(r));
  }
  @Get("ai/recovery") recoveryQueue(@Req() r: ApiRequest) {
    return this.result(r, this.ai.recoveryQueue(r));
  }
  @Post("ai/jobs/:id/recover") @HttpCode(200) recover(
    @Req() r: ApiRequest,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return this.result(r, this.ai.recover(r, id, b));
  }
  @Post("ai/jobs/:id/accept-report") @HttpCode(200) acceptReport(@Req() r:ApiRequest,@Param("id") id:string,@Body() b:unknown){return this.result(r,this.ai.acceptReport(r,id,b));}
  @Post("ai/jobs/:id/accept") @HttpCode(200) accept(
    @Req() r: ApiRequest,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return this.result(r, this.ai.accept(r, id, b));
  }
  @Post("ai/jobs/:id/accept-question") @HttpCode(200) acceptQuestion(
    @Req() r: ApiRequest,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return this.result(r, this.ai.acceptQuestion(r, id, b));
  }
  @Get("ai/jobs/:id") get(@Req() r: ApiRequest, @Param("id") id: string) {
    return this.result(r, this.ai.get(r, id));
  }
  @Post("ai/jobs/:id/dispatch") @HttpCode(200) dispatch(
    @Req() r: ApiRequest,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return this.result(r, this.ai.dispatch(r, id, b));
  }
  @Post("ai/jobs/:id/cancel") @HttpCode(200) cancel(
    @Req() r: ApiRequest,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return this.result(r, this.ai.cancel(r, id, b));
  }
}
