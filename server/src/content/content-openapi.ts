import type { OpenAPIObject, SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
const string:SchemaObject={type:'string'};
const uuid:SchemaObject={type:'string',format:'uuid'};
const ids:SchemaObject={type:'array',items:uuid,maxItems:20,uniqueItems:true};
const ref=(name:string)=>({$ref:`#/components/schemas/${name}`});
const obj=(properties:Record<string,SchemaObject|{$ref:string}>,required:string[]=Object.keys(properties)):SchemaObject=>({type:'object',properties,required});
export function contentOpenApi(document:OpenAPIObject){
  document.components??={};document.components.schemas??={};
  const schemas=document.components.schemas;
  const revision:SchemaObject={type:'integer',minimum:1};
  const timestamp:SchemaObject={type:'string',format:'date-time'};
  const reason:SchemaObject={type:'string',minLength:1,maxLength:1000};
  schemas.ContentLicense=obj({source:{type:'string',maxLength:1000},granted:{type:'boolean'},expires_at:{...timestamp,nullable:true}});
  const chapterProperties={id:uuid,parent_id:{...uuid,nullable:true},position:{type:'integer',minimum:0,maximum:99} as SchemaObject,title:{type:'string',minLength:1,maxLength:200} as SchemaObject,body:{type:'string',maxLength:20000} as SchemaObject,knowledge_point_ids:{...ids,maxItems:100},resource_ids:ids};
  schemas.ContentChapterInput=obj(chapterProperties);
  schemas.ContentChapter=obj({...chapterProperties,org_id:uuid,textbook_edition_id:uuid});
  schemas.ContentStudentChapter={...obj({...chapterProperties,textbook_edition_id:uuid,edition_revision:revision}),additionalProperties:false};
  schemas.ContentStudentEdition={...obj({id:uuid,textbook_id:uuid,title:string,edition_code:string,revision,resource_ids:ids}),additionalProperties:false};
  schemas.ContentTextbookInput=obj({title:{type:'string',minLength:1,maxLength:200},stage_id:uuid,subject_id:uuid,source:{type:'string',maxLength:1000}});
  schemas.ContentTextbookCreate={...obj({title:string,textbook:ref('ContentTextbookInput'),textbook_id:uuid,edition_code:{type:'string',minLength:1,maxLength:64},license:ref('ContentLicense'),resource_ids:ids,source_edition_id:uuid},['edition_code']),description:'textbook 与 textbook_id 二选一；仅提供 source_edition_id 时复制合法已发布版本'};
  schemas.ContentScoringRule={...obj({version:{type:'integer',enum:[1]},strategy:{type:'string',enum:['single_exact','multiple_exact_set','numeric_exact_decimal']},max_score:{type:'string',maxLength:6,pattern:'^(?:(?:[1-9][0-9]?)(?:\\.[0-9]{1,2})?|0\\.(?:0[1-9]|[1-9][0-9]?)|100(?:\\.0{1,2})?)$',description:'正十进制字符串，至多2位小数，最大100'}}),nullable:true,description:'草稿可为null；送审与发布必须与题型匹配'};
  schemas.ContentKnowledgeWeight=obj({knowledge_point_id:uuid,weight_bps:{type:'integer',minimum:1,maximum:10000}});
  const questionProperties={title:{type:'string',minLength:1,maxLength:200} as SchemaObject,subject_id:uuid,question_type:{type:'string',enum:['single','multiple','numeric']} as SchemaObject,prompt:{type:'string',maxLength:20000} as SchemaObject,options:{type:'array',maxItems:12,items:obj({id:{type:'string',pattern:'^[A-Za-z0-9_-]+$',maxLength:32},text:{type:'string',maxLength:2000}})} as SchemaObject,answer:{type:'string',maxLength:2000,description:'单选选项id；多选至少两个选项id英文逗号分隔；数值题为最多100字符的精确十进制文本，指数绝对值不超过100，禁止NaN/Infinity'} as SchemaObject,explanation:{type:'string',maxLength:20000} as SchemaObject,knowledge_point_ids:{...ids,maxItems:100},difficulty:{type:'string',enum:['基础','提升','挑战']} as SchemaObject,scoring_rule:ref('ContentScoringRule'),knowledge_weights:{type:'array',maxItems:100,items:ref('ContentKnowledgeWeight'),description:'送审和发布时知识点集合与knowledge_point_ids完全相同、不重复，基点总和10000'} as SchemaObject,difficulty_basis:{type:'string',maxLength:2000,description:'草稿允许空文本；送审和发布须填写难度依据'} as SchemaObject,license:ref('ContentLicense'),resource_ids:ids};
  schemas.ContentQuestionCreate=obj({...questionProperties,question_id:uuid,source_version_id:uuid},[]);
  schemas.ContentRevision=obj({expected_revision:revision,reason:{type:'string',maxLength:1000}},['expected_revision']);
  schemas.ContentReturn=obj({expected_revision:revision,reason});
  schemas.ContentRetire=obj({expected_revision:revision,reason});
  schemas.ContentRevokeAccess=obj({expected_access_revision:{type:'integer',minimum:0},reason});
  schemas.ContentQuestionPatch=obj({...questionProperties,expected_revision:revision},['expected_revision']);
  schemas.ContentTextbookPatch=obj({title:string,license:ref('ContentLicense'),resource_ids:ids,expected_revision:revision},['expected_revision']);
  schemas.ContentChapterReplace=obj({expected_revision:revision,chapters:{type:'array',maxItems:100,items:ref('ContentChapterInput')}});
  const safe={id:uuid,title:string,status:{type:'string',enum:['draft','review','published','retired']} as SchemaObject,revision,access_revision:{type:'integer',minimum:0} as SchemaObject,access_revoked_at:{...timestamp,nullable:true},access_revoked_by:{...uuid,nullable:true},access_revoked_reason:{...string,nullable:true},retired_at:{...timestamp,nullable:true},retired_by:{...uuid,nullable:true},retired_reason:{...string,nullable:true},created_at:timestamp,updated_at:timestamp};
  const base:Record<string,SchemaObject|{$ref:string}>={...safe,org_id:uuid,created_by:uuid,contributors:{type:'array',items:uuid},submitted_by:{...uuid,nullable:true},submitted_at:{...timestamp,nullable:true},published_by:{...uuid,nullable:true},published_at:{...timestamp,nullable:true},source_version_id:{...uuid,nullable:true},license:ref('ContentLicense'),resource_ids:ids,notes:string};
  const textbookRequired=[...Object.keys(safe),'textbook_id','edition_code'];
  const questionRequired=[...Object.keys(safe),'question_id','version_no'];
  schemas.ContentSafeTextbookVersion={...obj({...safe,textbook_id:uuid,edition_code:string}),additionalProperties:false};
  schemas.ContentSafeQuestionVersion={...obj({...safe,question_id:uuid,version_no:{type:'integer',minimum:1}}),additionalProperties:false};
  schemas.ContentTextbookVersion=obj({...base,textbook_id:uuid,edition_code:string,copy_notice:string},textbookRequired);
  schemas.ContentTextbookDetail={allOf:[ref('ContentTextbookVersion'),obj({textbook:{allOf:[ref('ContentTextbookInput'),obj({id:uuid,org_id:uuid})],nullable:true}},[])],description:'访问撤销后仅返回安全元数据；不包含章树，章树使用分页接口读取'};
  schemas.ContentQuestionDetail=obj({...base,...questionProperties,question_id:uuid,version_no:{type:'integer',minimum:1},copy_notice:string},questionRequired);
  schemas.ContentCatalogueItem={type:'object',properties:{id:uuid,code:string,name:string,subject_id:uuid},required:['id','code','name']};
  schemas.ContentStudentKnowledge={...obj({id:uuid,code:string,name:string,subject_id:uuid,chapters:{type:'array',items:{...obj({id:uuid,title:string,textbook_edition_id:uuid}),additionalProperties:false}}}),additionalProperties:false};
  schemas.ContentOptions=obj(Object.fromEntries(['education_stages','subjects','knowledge_points'].map(key=>[key,{type:'array',items:ref('ContentCatalogueItem')}] )));
  schemas.ContentAudit=obj({id:uuid,actor_id:string,action:string,resource_type:{...string,nullable:true},resource_id:uuid,owner_type:{type:'string',enum:['textbook','question'],nullable:true},owner_version_id:{...uuid,nullable:true},revision_before:{...revision,nullable:true},revision_after:{...revision,nullable:true},access_revision_before:{type:'integer',minimum:0,nullable:true},access_revision_after:{type:'integer',minimum:0,nullable:true},reason:string,request_id:string,created_at:timestamp});
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
      if(path.endsWith('content-options'))data=ref('ContentOptions');
      else if(path.endsWith('audit-events')){data=obj({items:{type:'array',items:ref('ContentAudit')},next_cursor:{type:'string',nullable:true}});operation.parameters.push({in:'query',name:'resource_type',required:true,schema:{type:'string',enum:['textbook','question']}},{in:'query',name:'resource_id',required:true,schema:uuid});}
      else if(path.endsWith('/revoke-access'))data=ref(question?'ContentSafeQuestionVersion':'ContentSafeTextbookVersion');
      else if(list)data=obj({items:{type:'array',items:ref(student?'ContentStudentEdition':question?'ContentSafeQuestionVersion':'ContentSafeTextbookVersion')},next_cursor:{type:'string',nullable:true}});
      else if(chapters)data=obj({items:{type:'array',items:ref(student?'ContentStudentChapter':'ContentChapter')},edition_revision:revision,next_cursor:{type:'string',nullable:true}});
      else if(student&&path.includes('/chapters/{id}'))data=ref('ContentStudentChapter');
      else if(student&&path.includes('/knowledge-points/'))data=ref('ContentStudentKnowledge');
      if(path.endsWith('/revoke-access'))operation.description='撤销后仅返回安全元数据；同幂等键与请求正文返回原安全结果，后续状态变化不改写原结果';
      if(method==='get'&&(list||chapters||path.endsWith('audit-events'))){
        operation.parameters.push({in:'query',name:'cursor',required:false,schema:string},{in:'query',name:'limit',required:false,schema:{type:'integer',minimum:1,maximum:50,default:20}});
        if(list&&!student){operation.parameters.push({in:'query',name:'status',required:false,schema:{type:'string',enum:['draft','review','published','retired']}});if(!question)operation.parameters.push({in:'query',name:'textbook_id',required:false,schema:uuid});}
        if(chapters){operation.parameters.push({in:'query',name:'edition_revision',required:false,schema:revision,description:'后续页必须携带首响应的edition_revision；版本变化返回409'});operation.responses['409']={description:'章树版本发生变化，丢弃已获取页面并重新读取'};}
      }
      if(method!=='get'){const schema=method==='put'?'ContentChapterReplace':method==='patch'?(question?'ContentQuestionPatch':'ContentTextbookPatch'):path.endsWith('/retire')?'ContentRetire':path.endsWith('/revoke-access')?'ContentRevokeAccess':path.endsWith('/return')?'ContentReturn':/\/(submit-review|publish)$/.test(path)?'ContentRevision':question?'ContentQuestionCreate':'ContentTextbookCreate';operation.requestBody={required:true,content:{'application/json':{schema:ref(schema)}}};}
      delete operation.responses['201'];delete operation.responses['204'];operation.responses['200']={description:'成功',content:{'application/json':{schema:obj({data,request_id:string})}}};
    }
  }
}
