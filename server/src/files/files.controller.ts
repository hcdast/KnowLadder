import { allowedFileMimes } from './config';
import { Body, Controller, Get, Post, Put, Param, Query, Req, Res, HttpCode } from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiCookieAuth, ApiOperation, ApiResponse, ApiTags, type OpenAPIObject } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import type { Response } from 'express';
import { ApiRequest } from '../errors';
import { FilesService, type RegisterFile, type ScheduleDeletion } from './files.service';

@ApiTags('私有附件')
@ApiCookieAuth('session')
@Controller('api/v1')
export class FilesController {
  constructor(readonly files: FilesService) {}
  @Post('admin/files')
  @HttpCode(200)
  @ApiOperation({ summary: '幂等登记私有附件并更新草稿revision' })
  @ApiResponse({ status: 200, description: '文件登记状态与owner_revision' })
  async register(@Req() req: ApiRequest, @Body() body: RegisterFile) {
    return { data: await this.files.register(req, body), request_id: req.requestId };
  }
  @Get('admin/files')
  @ApiOperation({ summary: '按归属版本分页恢复附件状态，包括未绑定附件' })
  @ApiResponse({ status: 200, description: '附件列表、下一页游标与owner_revision' })
  async list(@Req() req: ApiRequest, @Query() query: Record<string, unknown>) {
    return { data: await this.files.list(req, query), request_id: req.requestId };
  }
  @Put('admin/files/:id/content')
  @HttpCode(200)
  @ApiConsumes('application/octet-stream')
  @ApiBody({ schema: { type: 'string', format: 'binary' } })
  @ApiOperation({ summary: '上传完整附件至隔离区；失败以原资源和原幂等键恢复，禁止覆盖已完成上传' })
  @ApiResponse({ status: 200, description: '隔离待扫描；必须携带X-Owner-Revision' })
  async upload(@Req() req: ApiRequest, @Param('id') id: string) {
    return { data: await this.files.upload(req, id), request_id: req.requestId };
  }
  @Get('admin/files/:id')
  @ApiResponse({ status: 200, description: '文件元数据与扫描状态，不含存储路径或上传幂等键' })
  async status(@Req() req: ApiRequest, @Param('id') id: string) {
    return { data: await this.files.status(req, id), request_id: req.requestId };
  }
  @Post('admin/files/:id/schedule-deletion')
  @HttpCode(200)
  @ApiOperation({ summary: '显式安排到期清理；要求file:delete能力、无引用且无legal_hold，不立即删除' })
  @ApiResponse({ status: 200, description: '清理计划与更新后的owner_revision' })
  async scheduleDeletion(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: ScheduleDeletion) {
    return { data: await this.files.scheduleDeletion(req, id, body), request_id: req.requestId };
  }
  @Get('admin/files/:id/content')
  @ApiOperation({ summary: '管理读取权预览ready且clean附件；每次重新检查版权授权' })
  @ApiResponse({ status: 200, description: '授权管理附件字节流' })
  async preview(@Req() req: ApiRequest, @Param('id') id: string, @Res() res: Response) {
    await this.files.download(req, id, res, true);
  }
  @Get('files/:id/content')
  @ApiOperation({ summary: '学生下载已发布、授权有效且ready+clean的附件' })
  @ApiResponse({ status: 200, description: '已授权安全附件字节流' })
  async download(@Req() req: ApiRequest, @Param('id') id: string, @Res() res: Response) {
    await this.files.download(req, id, res, false);
  }
}
function envelope(data: SchemaObject): SchemaObject {
  return { type: 'object', required: ['data', 'request_id'], properties: { request_id: { type: 'string' }, data } };
}
export function filesOpenApi(document: OpenAPIObject) {
  const timestamp: SchemaObject = { type: 'string', format: 'date-time', nullable: true };
  const properties: Record<string, SchemaObject> = {
    id: { type: 'string', pattern: '^[0-9a-f]{24}$' },
    owner_type: { type: 'string', enum: ['textbook', 'question'] },
    owner_version_id: { type: 'string', pattern: '^[0-9a-f]{24}$' },
    display_name: { type: 'string' }, size: { type: 'integer', minimum: 1, maximum: 10485760 },
    mime: { type: 'string', enum: [...allowedFileMimes()] },
    checksum: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    status: { type: 'string', enum: ['pending', 'quarantined', 'ready', 'deleting'] },
    scan_status: { type: 'string', enum: ['awaiting_upload', 'queued', 'scanning', 'clean', 'infected', 'failed'] },
    error_code: { type: 'string', nullable: true }, retention_until: timestamp,
    legal_hold: { type: 'boolean' }, deletion_requested_at: timestamp, deleted_at: timestamp,
    upload_in_progress: { type: 'boolean' }, scanned_at: timestamp,
    scan_engine_version: { type: 'string', nullable: true },
    scan_database_version: { type: 'string', nullable: true }, scan_database_updated_at: timestamp,
  };
  const file: SchemaObject = { type: 'object', additionalProperties: false, properties, required: Object.keys(properties) };
  const revision: SchemaObject = { type: 'integer', minimum: 1 };
  const detailed: SchemaObject = { ...file, properties: { ...properties, owner_revision: revision }, required: [...Object.keys(properties), 'owner_revision'] };
  const error: SchemaObject = { type: 'object', required: ['error', 'request_id'], properties: {
    request_id: { type: 'string' }, error: { type: 'object', required: ['code', 'message'], properties: { code: { type: 'string' }, message: { type: 'string' } } },
  } };
  const routes = [
    ['/api/v1/admin/files', 'post'], ['/api/v1/admin/files', 'get'],
    ['/api/v1/admin/files/{id}/content', 'put'], ['/api/v1/admin/files/{id}', 'get'],
    ['/api/v1/admin/files/{id}/schedule-deletion', 'post'],
    ['/api/v1/admin/files/{id}/content', 'get'], ['/api/v1/files/{id}/content', 'get'],
  ] as const;
  for (const [route, method] of routes) {
    const operation = document.paths[route]?.[method];
    if (!operation) continue;
    operation.parameters = [...(operation.parameters ?? []), { in: 'header', name: 'X-Org-Id', required: true, schema: { type: 'string', pattern: '^[0-9a-f]{24}$' } }];
    for (const [status, description] of Object.entries({ 401: '会话失效', 403: '权限或CSRF校验失败', 404: '资源不存在或不可访问', 409: '版本、幂等键、租约、引用、hold或文件状态冲突', 422: '参数或游标无效', 429: '请求频率超限', 503: '存储、扫描、签名库或磁盘容量不可用' })) {
      const scanDisabled = status === '503' && ((route === '/api/v1/admin/files' && method === 'post') || (route === '/api/v1/admin/files/{id}/content' && method === 'put'));
      operation.responses[status] = { description: scanDisabled ? `文件扫描已关闭（FILE_SCAN_DISABLED）；或${description}` : description, content: { 'application/json': { schema: error } } };
    }
    if (method !== 'get') operation.parameters.push(
      { in: 'header', name: 'Idempotency-Key', required: true, schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,128}$' } },
      { in: 'header', name: 'X-CSRF-Token', required: true, schema: { type: 'string' } },
    );
    if (method === 'get' && route.endsWith('/content')) {
      operation.parameters.push({ in: 'header', name: 'Range', required: false, description: '只允许单个bytes范围；每次请求重新鉴权', schema: { type: 'string' } });
      const headers = {
        'Content-Disposition': { schema: { type: 'string' as const }, description: 'attachment；UTF-8文件名' },
        'Cache-Control': { schema: { type: 'string' as const, enum: ['private, no-store'] } },
        'X-Content-Type-Options': { schema: { type: 'string' as const, enum: ['nosniff'] } },
        'Content-Security-Policy': { schema: { type: 'string' as const }, description: "sandbox; default-src 'none'" },
        'Accept-Ranges': { schema: { type: 'string' as const, enum: ['bytes'] } },
        'Content-Length': { schema: { type: 'integer' as const, minimum: 0 } },
      };
      for (const code of ['200', '206']) operation.responses[code] = {
        description: code === '206' ? '授权单Range字节流' : '授权完整字节流',
        headers: code === '206' ? { ...headers, 'Content-Range': { schema: { type: 'string' } } } : headers,
        content: Object.fromEntries(allowedFileMimes().map(mime => [mime, { schema: { type: 'string', format: 'binary' } }])),
      };
      operation.responses['416'] = { description: 'Range无效或为多Range', headers: { 'Content-Range': { schema: { type: 'string' }, description: 'bytes */完整大小' } }, content: { 'application/json': { schema: error } } };
      continue;
    }
    let result = detailed;
    if (method === 'get' && route === '/api/v1/admin/files') {
      operation.parameters.push(
        { in: 'query', name: 'owner_type', required: true, schema: properties.owner_type },
        { in: 'query', name: 'owner_version_id', required: true, schema: properties.owner_version_id },
        { in: 'query', name: 'cursor', required: false, schema: { type: 'string' }, description: '仅能用于相同组织、归属类型和归属版本' },
        { in: 'query', name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 } },
      );
      result = { type: 'object', required: ['items', 'next_cursor', 'owner_revision'], properties: { items: { type: 'array', items: file }, next_cursor: { type: 'string', nullable: true }, owner_revision: revision } };
    } else if (method === 'put') {
      operation.parameters.push({ in: 'header', name: 'X-Owner-Revision', required: true, schema: revision });
      operation.responses['413'] = { description: '附件超过大小上限', content: { 'application/json': { schema: error } } };
      operation.responses['415'] = { description: '不支持的媒体类型、编码或文件魔数', content: { 'application/json': { schema: error } } };
      result = { type: 'object', required: ['id', 'status', 'scan_status', 'owner_revision'], properties: { id: properties.id, status: properties.status, scan_status: properties.scan_status, owner_revision: revision } };
    } else if (method === 'post') {
      const deletion = route.endsWith('/schedule-deletion');
      const body: SchemaObject = deletion
        ? { type: 'object', additionalProperties: false, required: ['expected_owner_revision', 'retention_until', 'reason'], properties: { expected_owner_revision: revision, retention_until: { type: 'string', format: 'date-time' }, reason: { type: 'string', minLength: 1, maxLength: 1000 } } }
        : { type: 'object', additionalProperties: false, required: ['owner_type', 'owner_version_id', 'expected_revision', 'display_name', 'size', 'mime', 'checksum'], properties: { owner_type: properties.owner_type, owner_version_id: properties.owner_version_id, expected_revision: revision, display_name: { type: 'string', minLength: 1, maxLength: 200 }, size: properties.size, mime: properties.mime, checksum: properties.checksum } };
      operation.requestBody = { required: true, content: { 'application/json': { schema: body } } };
    }
    operation.responses['200'] = { description: '私有附件结果', content: { 'application/json': { schema: envelope(result) } } };
  }
}
