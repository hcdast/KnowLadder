import { Body, Controller, Get, Post, Patch, Put, Param, Query, Req, HttpCode } from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiRequest } from '../errors';
import { ContentService } from './content.service';
import { AssessmentService } from '../assessment/assessment.service';
@ApiTags('教材与题库')
@ApiCookieAuth('session')
@ApiHeader({name:'X-Org-Id',required:true})
@ApiResponse({status:200,description:'业务结果，统一data/request_id信封'})
@Controller('api/v1')
export class ContentController {
  constructor(readonly content:ContentService, readonly assessment:AssessmentService){}
  private async result(req:ApiRequest,work:Promise<unknown>){return {data:await work,request_id:req.requestId};}
  @Get('admin/content-options') options(@Req() req:ApiRequest){return this.result(req,this.content.options(req));}
  @Get('admin/textbook-editions') textbooks(@Req() req:ApiRequest,@Query() query:unknown){return this.result(req,this.content.list(req,'textbook',query));}
  @Get('admin/textbook-editions/:id') textbook(@Req() req:ApiRequest,@Param('id') id:string){return this.result(req,this.content.detail(req,'textbook',id));}
  @Get('admin/textbook-editions/:id/chapters') adminChapters(@Req() req:ApiRequest,@Param('id') id:string,@Query() query:unknown){return this.result(req,this.content.chapterPage(req,id,query,false));}
  @Post('admin/textbook-editions') @HttpCode(200) createTextbook(@Req() req:ApiRequest,@Body() body:unknown){return this.result(req,this.content.create(req,'textbook',body));}
  @Patch('admin/textbook-editions/:id') patchTextbook(@Req() req:ApiRequest,@Param('id') id:string,@Body() body:unknown){return this.result(req,this.content.patch(req,'textbook',id,body));}
  @Put('admin/textbook-editions/:id/chapters') chapters(@Req() req:ApiRequest,@Param('id') id:string,@Body() body:unknown){return this.result(req,this.content.chapters(req,id,body));}
  @Post('admin/textbook-editions/:id/submit-review') @HttpCode(200) submitTextbook(@Req() req:ApiRequest,@Param('id') id:string,@Body() body:unknown){return this.result(req,this.content.transition(req,'textbook',id,'submit-review',body));}
  @Post('admin/textbook-editions/:id/return') @HttpCode(200) returnTextbook(@Req() req:ApiRequest,@Param('id') id:string,@Body() body:unknown){return this.result(req,this.content.transition(req,'textbook',id,'return',body));}
  @Post('admin/textbook-editions/:id/publish') @HttpCode(200) publishTextbook(@Req() req:ApiRequest,@Param('id') id:string,@Body() body:unknown){return this.result(req,this.content.transition(req,'textbook',id,'publish',body));}
  @Post('admin/textbook-editions/:id/retire') @HttpCode(200) retireTextbook(@Req() req:ApiRequest,@Param('id') id:string,@Body() body:unknown){return this.result(req,this.content.stop(req,'textbook',id,'retire',body));}
  @Post('admin/textbook-editions/:id/revoke-access') @HttpCode(200) revokeTextbook(@Req() req:ApiRequest,@Param('id') id:string,@Body() body:unknown){return this.result(req,this.content.stop(req,'textbook',id,'revoke-access',body));}
  @Get('admin/question-versions') questions(@Req() req:ApiRequest,@Query() query:unknown){return this.result(req,this.content.list(req,'question',query));}
  @Get('admin/question-versions/:id') question(@Req() req:ApiRequest,@Param('id') id:string){return this.result(req,this.content.detail(req,'question',id));}
  @Post('admin/question-versions') @HttpCode(200) createQuestion(@Req() req:ApiRequest,@Body() body:unknown){return this.result(req,this.content.create(req,'question',body));}
  @Patch('admin/question-versions/:id') patchQuestion(@Req() req:ApiRequest,@Param('id') id:string,@Body() body:unknown){return this.result(req,this.content.patch(req,'question',id,body));}
  @Post('admin/question-versions/:id/submit-review') @HttpCode(200) submitQuestion(@Req() req:ApiRequest,@Param('id') id:string,@Body() body:unknown){return this.result(req,this.content.transition(req,'question',id,'submit-review',body));}
  @Post('admin/question-versions/:id/return') @HttpCode(200) returnQuestion(@Req() req:ApiRequest,@Param('id') id:string,@Body() body:unknown){return this.result(req,this.content.transition(req,'question',id,'return',body));}
  @Post('admin/question-versions/:id/publish') @HttpCode(200) publishQuestion(@Req() req:ApiRequest,@Param('id') id:string,@Body() body:unknown){return this.result(req,this.content.transition(req,'question',id,'publish',body));}
  @Post('admin/question-versions/:id/retire') @HttpCode(200) retireQuestion(@Req() req:ApiRequest,@Param('id') id:string,@Body() body:unknown){return this.result(req,this.content.stop(req,'question',id,'retire',body));}
  @Post('admin/question-versions/:id/revoke-access') @HttpCode(200) revokeQuestion(@Req() req:ApiRequest,@Param('id') id:string,@Body() body:unknown){return this.result(req,this.content.stop(req,'question',id,'revoke-access',body));}
  @Get('admin/audit-events') audit(@Req() req:ApiRequest,@Query() query:unknown){
    const type = query && typeof query === 'object' ? (query as Record<string, unknown>).resource_type : undefined;
    const assessment = typeof type === 'string' && ['quiz','session','submission','grading_run'].includes(type);
    return this.result(req,assessment ? this.assessment.audits(req,query) : this.content.audits(req,query));
  }
  @Get('textbook-editions') readerEditions(@Req() req:ApiRequest,@Query() query:unknown){return this.result(req,this.content.list(req,'textbook',query,true));}
  @Get('textbook-editions/:id/chapters') readerChapters(@Req() req:ApiRequest,@Param('id') id:string,@Query() query:unknown){return this.result(req,this.content.chapterPage(req,id,query,true));}
  @Get('chapters/:id') readerChapter(@Req() req:ApiRequest,@Param('id') id:string){return this.result(req,this.content.studentChapter(req,id));}
  @Get('knowledge-points/:id') readerKnowledge(@Req() req:ApiRequest,@Param('id') id:string){return this.result(req,this.content.studentKnowledge(req,id));}
}
