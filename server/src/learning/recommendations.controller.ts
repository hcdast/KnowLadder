import { Body, Controller, Get, Header, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { ApiRequest } from '../errors';
import { RecommendationsService } from './recommendations.service';
@ApiTags('学习推荐')
@ApiCookieAuth('session')
@ApiHeader({name:'X-Org-Id',required:true})
@Controller('api/v1')
export class RecommendationsController {
  constructor(readonly recommendations:RecommendationsService){}
  @Get('me/recommendations') @Header('Cache-Control','private, no-store')
  async list(@Req() req:ApiRequest,@Query() query:unknown){return {data:await this.recommendations.list(req,query),request_id:req.requestId};}
  @Post('me/recommendations/:id/practice-sessions') @HttpCode(200) @Header('Cache-Control','private, no-store')
  async accept(@Req() req:ApiRequest,@Param('id') id:string,@Body() body:unknown){return {data:await this.recommendations.accept(req,id,body),request_id:req.requestId};}
}
