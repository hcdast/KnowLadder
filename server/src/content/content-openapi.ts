const traceUuid = { type: "string" as const, format: "uuid" };
import type { OpenAPIObject, SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
const string:SchemaObject={type:'string'};
const resourceId:SchemaObject={type:'string',pattern: "^[0-9a-f]{24}$"};
const ids:SchemaObject={type:'array',items:resourceId,maxItems:20,uniqueItems:true};
const ref=(name:string)=>({$ref:`#/components/schemas/${name}`});
const obj=(properties:Record<string,SchemaObject|{$ref:string}>,required:string[]=Object.keys(properties)):SchemaObject=>({type:'object',properties,required});
export function contentOpenApi(document:OpenAPIObject){
  document.components??={};document.components.schemas??={};
  const schemas=document.components.schemas;
  const revision:SchemaObject={type:'integer',minimum:1};
  const timestamp:SchemaObject={type:'string',format:'date-time'};
  const reason:SchemaObject={type:'string',minLength:1,maxLength:1000};
  schemas.ContentLicense=obj({source:{type:'string',maxLength:1000},granted:{type:'boolean'},expires_at:{...timestamp,nullable:true}});
  const chapterProperties={id:resourceId,client_key:{type:"string",maxLength:64},parent_client_key:{type:"string",maxLength:64},parent_id:{...resourceId,nullable:true},position:{type:'integer',minimum:0,maximum:99} as SchemaObject,title:{type:'string',minLength:1,maxLength:200} as SchemaObject,body:{type:'string',maxLength:20000} as SchemaObject,knowledge_point_ids:{...ids,maxItems:100},resource_ids:ids};
  schemas.ContentChapterInput={...obj(chapterProperties,["position","title","body","knowledge_point_ids","resource_ids"]),oneOf:[{required:["id"],not:{required:["client_key"]}},{required:["client_key"],not:{required:["id"]}}]};
  const {client_key: _clientKey, parent_client_key: _parentClientKey, ...persistedChapter} = chapterProperties;
  schemas.ContentChapter=obj({...persistedChapter,org_id:resourceId,textbook_edition_id:resourceId});
  schemas.ContentStudentChapter={...obj({...persistedChapter,textbook_edition_id:resourceId,edition_revision:revision}),additionalProperties:false};
  schemas.ContentStudentEdition={...obj({id:resourceId,textbook_id:resourceId,title:string,edition_code:string,revision,resource_ids:ids}),additionalProperties:false};
  schemas.ContentTextbookInput=obj({title:{type:'string',minLength:1,maxLength:200},stage_id:resourceId,subject_id:resourceId,source:{type:'string',maxLength:1000}});
  schemas.ContentTextbookCreate={...obj({title:string,textbook:ref('ContentTextbookInput'),textbook_id:resourceId,edition_code:{type:'string',minLength:1,maxLength:64},license:ref('ContentLicense'),resource_ids:ids,source_edition_id:resourceId},['edition_code']),description:'textbook 与 textbook_id 二选一；仅提供 source_edition_id 时复制合法已发布版本'};
  schemas.ContentScoringRule={...obj({version:{type:'integer',enum:[1]},strategy:{type:'string',enum:['single_exact','multiple_exact_set','numeric_exact_decimal']},max_score:{type:'string',maxLength:6,pattern:'^(?:(?:[1-9][0-9]?)(?:\\.[0-9]{1,2})?|0\\.(?:0[1-9]|[1-9][0-9]?)|100(?:\\.0{1,2})?)$',description:'正十进制字符串，至多2位小数，最大100'}}),nullable:true,description:'草稿可为null；送审与发布必须与题型匹配'};
  schemas.ContentKnowledgeWeight=obj({knowledge_point_id:resourceId,weight_bps:{type:'integer',minimum:1,maximum:10000}});
  const questionProperties={title:{type:'string',minLength:1,maxLength:200} as SchemaObject,subject_id:resourceId,question_type:{type:'string',enum:['single','multiple','numeric']} as SchemaObject,prompt:{type:'string',maxLength:20000} as SchemaObject,options:{type:'array',maxItems:12,items:obj({id:{type:'string',pattern:'^[A-Za-z0-9_-]+$',maxLength:32},text:{type:'string',maxLength:2000}})} as SchemaObject,answer:{type:'string',maxLength:2000,description:'单选选项id；多选至少两个选项id英文逗号分隔；数值题为最多100字符的精确十进制文本，指数绝对值不超过100，禁止NaN/Infinity'} as SchemaObject,explanation:{type:'string',maxLength:20000} as SchemaObject,knowledge_point_ids:{...ids,maxItems:100},difficulty:{type:'string',enum:['基础','提升','挑战']} as SchemaObject,scoring_rule:ref('ContentScoringRule'),knowledge_weights:{type:'array',maxItems:100,items:ref('ContentKnowledgeWeight'),description:'送审和发布时知识点集合与knowledge_point_ids完全相同、不重复，基点总和10000'} as SchemaObject,difficulty_basis:{type:'string',maxLength:2000,description:'草稿允许空文本；送审和发布须填写难度依据'} as SchemaObject,license:ref('ContentLicense'),resource_ids:ids};
  schemas.ContentQuestionCreate=obj({...questionProperties,question_id:resourceId,source_version_id:resourceId},[]);
  schemas.ContentRevision=obj({expected_revision:revision,reason:{type:'string',maxLength:1000}},['expected_revision']);
  schemas.ContentReturn=obj({expected_revision:revision,reason});
  schemas.ContentRetire=obj({expected_revision:revision,reason});
  schemas.ContentRevokeAccess=obj({expected_access_revision:{type:'integer',minimum:0},reason});
  schemas.ContentQuestionPatch=obj({...questionProperties,expected_revision:revision},['expected_revision']);
  schemas.ContentTextbookPatch=obj({title:string,license:ref('ContentLicense'),resource_ids:ids,expected_revision:revision},['expected_revision']);
  schemas.ContentChapterReplace=obj({expected_revision:revision,chapters:{type:'array',maxItems:100,items:ref('ContentChapterInput')}});
  const safe={id:resourceId,title:string,status:{type:'string',enum:['draft','review','published','retired']} as SchemaObject,revision,access_revision:{type:'integer',minimum:0} as SchemaObject,access_revoked_at:{...timestamp,nullable:true},access_revoked_by:{...resourceId,nullable:true},access_revoked_reason:{...string,nullable:true},retired_at:{...timestamp,nullable:true},retired_by:{...resourceId,nullable:true},retired_reason:{...string,nullable:true},created_at:timestamp,updated_at:timestamp};
  const base:Record<string,SchemaObject|{$ref:string}>={...safe,org_id:resourceId,created_by:resourceId,contributors:{type:'array',items:resourceId},submitted_by:{...resourceId,nullable:true},submitted_at:{...timestamp,nullable:true},published_by:{...resourceId,nullable:true},published_at:{...timestamp,nullable:true},source_version_id:{...resourceId,nullable:true},license:ref('ContentLicense'),resource_ids:ids,notes:string};
  const textbookRequired=[...Object.keys(safe),'textbook_id','edition_code'];
  const questionRequired=[...Object.keys(safe),'question_id','version_no'];
  schemas.ContentSafeTextbookVersion={...obj({...safe,textbook_id:resourceId,edition_code:string}),additionalProperties:false};
  schemas.ContentSafeQuestionVersion={...obj({...safe,question_id:resourceId,version_no:{type:'integer',minimum:1}}),additionalProperties:false};
  schemas.ContentTextbookVersion=obj({...base,textbook_id:resourceId,edition_code:string,copy_notice:string},textbookRequired);
  schemas.ContentTextbookDetail={allOf:[ref('ContentTextbookVersion'),obj({textbook:{allOf:[ref('ContentTextbookInput'),obj({id:resourceId,org_id:resourceId})],nullable:true}},[])],description:'访问撤销后仅返回安全元数据；不包含章树，章树使用分页接口读取'};
  schemas.ContentQuestionDetail=obj({...base,...questionProperties,question_id:resourceId,version_no:{type:'integer',minimum:1},copy_notice:string},questionRequired);
  schemas.ContentCatalogueItem={type:'object',properties:{id:resourceId,code:string,name:string,subject_id:resourceId},required:['id','code','name']};
  schemas.ContentStudentKnowledge={...obj({id:resourceId,code:string,name:string,subject_id:resourceId,chapters:{type:'array',items:{...obj({id:resourceId,title:string,textbook_edition_id:resourceId}),additionalProperties:false}}}),additionalProperties:false};
  schemas.ContentOptions=obj(Object.fromEntries(['education_stages','subjects','knowledge_points'].map(key=>[key,{type:'array',items:ref('ContentCatalogueItem')}] )));
  schemas.ContentAudit=obj({id:resourceId,actor_id:string,action:string,resource_type:{...string,nullable:true},resource_id:resourceId,owner_type:{type:'string',enum:['textbook','question'],nullable:true},owner_version_id:{...resourceId,nullable:true},revision_before:{...revision,nullable:true},revision_after:{...revision,nullable:true},access_revision_before:{type:'integer',minimum:0,nullable:true},access_revision_after:{type:'integer',minimum:0,nullable:true},reason:string,request_id:string,created_at:timestamp});
  for(const [path,item]of Object.entries(document.paths)){
    if(!/\/api\/v1\/(?:admin\/(?:textbook-editions|question-versions|content-options|audit-events)|textbook-editions|chapters|knowledge-points)(?:\/|$)/.test(path))continue;
    for(const method of ['get','post','patch','put']as const){const operation=item[method];if(!operation)continue;
      operation.parameters??=[];
      if(method!=='get')for(const name of ['Idempotency-Key','X-CSRF-Token','Origin'])operation.parameters.push({in:'header',name,required:true,schema:string});
      const question=path.includes('question-versions');
      const student=!path.includes('/admin/');
      const list=method==='get'&&/\/(textbook-editions|question-versions)$/.test(path);
      const chapters=method==='get'&&path.endsWith('/chapters');
      let data:SchemaObject|{$ref:string}=ref(question?'ContentQuestionDetail':'ContentTextbookDetail');
      if(method==='put' && path.endsWith('/chapters'))data={allOf:[ref('ContentTextbookDetail'),obj({chapter_id_map:{type:'array',items:obj({client_key:string,id:resourceId})}})]};
      else if(path.endsWith('content-options'))data=ref('ContentOptions');
      else if(path.endsWith('audit-events')){data=obj({items:{type:'array',items:ref('ContentAudit')},next_cursor:{type:'string',nullable:true}});operation.parameters.push({in:'query',name:'resource_type',required:true,schema:{type:'string',enum:['textbook','question']}},{in:'query',name:'resource_id',required:true,schema:resourceId});}
      else if(path.endsWith('/revoke-access'))data=ref(question?'ContentSafeQuestionVersion':'ContentSafeTextbookVersion');
      else if(list)data=obj({items:{type:'array',items:ref(student?'ContentStudentEdition':question?'ContentSafeQuestionVersion':'ContentSafeTextbookVersion')},next_cursor:{type:'string',nullable:true}});
      else if(chapters)data=obj({items:{type:'array',items:ref(student?'ContentStudentChapter':'ContentChapter')},edition_revision:revision,next_cursor:{type:'string',nullable:true}});
      else if(student&&path.includes('/chapters/{id}'))data=ref('ContentStudentChapter');
      else if(student&&path.includes('/knowledge-points/'))data=ref('ContentStudentKnowledge');
      if(path.endsWith('/revoke-access'))operation.description='撤销后仅返回安全元数据；同幂等键与请求正文返回原安全结果，后续状态变化不改写原结果';
      if(method==='get'&&(list||chapters||path.endsWith('audit-events'))){
        operation.parameters.push({in:'query',name:'cursor',required:false,schema:string},{in:'query',name:'limit',required:false,schema:{type:'integer',minimum:1,maximum:50,default:20}});
        if(list&&!student){operation.parameters.push({in:'query',name:'status',required:false,schema:{type:'string',enum:['draft','review','published','retired']}});if(!question)operation.parameters.push({in:'query',name:'textbook_id',required:false,schema:resourceId});}
        if(chapters){operation.parameters.push({in:'query',name:'edition_revision',required:false,schema:revision,description:'后续页必须携带首响应的edition_revision；版本变化返回409'});operation.responses['409']={description:'章树版本发生变化，丢弃已获取页面并重新读取'};}
      }
      if(method!=='get'){const schema=method==='put'?'ContentChapterReplace':method==='patch'?(question?'ContentQuestionPatch':'ContentTextbookPatch'):path.endsWith('/retire')?'ContentRetire':path.endsWith('/revoke-access')?'ContentRevokeAccess':path.endsWith('/return')?'ContentReturn':/\/(submit-review|publish)$/.test(path)?'ContentRevision':question?'ContentQuestionCreate':'ContentTextbookCreate';operation.requestBody={required:true,content:{'application/json':{schema:ref(schema)}}};}
      delete operation.responses['201'];delete operation.responses['204'];operation.responses['200']={description:'成功',content:{'application/json':{schema:obj({data,request_id:string})}}};
    }
  }
  const receiptOperation=document.paths['/api/v1/admin/content-requests']?.get;
  if(receiptOperation){
    receiptOperation.parameters=[
      {in:'header',name:'X-Org-Id',required:true,schema:resourceId},
      {in:'query',name:'key',required:true,schema:{type:'string',pattern:'^[A-Za-z0-9_-]{8,128}$'}},
    ];
    receiptOperation.responses['200']={description:'当前组织与操作者的受控停止/清理原key回执；未知不表示未执行',content:{'application/json':{schema:obj({
      data:obj({status:{type:'string',enum:['unknown','resolved']},result:obj({id:{...resourceId,nullable:true},revision:{...revision,nullable:true},status:{...string,nullable:true}})},['status']),
      request_id:string,
    })}}};
  }
}
