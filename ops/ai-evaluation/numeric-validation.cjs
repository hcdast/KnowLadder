'use strict';
const path=require('node:path');
const {validateQuestion,object,text}=require('../../server/dist/content/dto');
const {scoreAnswer,scoreCents}=require('../../server/dist/assessment/scoring');
const {Decimal128}=require(path.resolve(__dirname,'../../server/node_modules/mongodb'));
const pack=require('./numeric-cases.json');
function requestCase(c){
  return {id:c.id,kind:'questions',prompt:'生成一条数值题候选，外层仍返回text和source_keys。text必须是可解析JSON字符串，仅含question_type,prompt,options,answer,explanation,scoring_rule。question_type为numeric，options为空数组，answer为纯十进制字符串（可用科学记数法，不带单位），scoring_rule={"version":1,"strategy":"numeric_exact_decimal","max_score":"1"}。题干保留原表达式'+c.expression+'（可增加空格，不改计算条件），解析说明计算步骤。不要生成真实标识、知识点、发布或评分操作。',sources:[{key:'numeric-original',title:'原创精确数值计算',text:'请计算表达式 '+c.expression+' 的精确结果，不作近似；运算符*表示乘法，e表示十进制科学记数法。'}]};
}
function validate(c,raw){
  try{
    const q=JSON.parse(raw);object(q,['question_type','prompt','options','answer','explanation','scoring_rule']);
    if(q.question_type!=='numeric'||!Array.isArray(q.options)||q.options.length)throw Error('NUMERIC_TYPE_REQUIRED');
    text(q.prompt,'prompt',2000);text(q.answer,'answer',100);text(q.explanation,'explanation',4000);
    if(!q.prompt.replace(/\s/g,'').includes(c.expression))throw Error('SOURCE_EXPRESSION_CHANGED');
    const knowledge='000000000000000000000001';
    const candidate={...q,knowledge_point_ids:[knowledge],knowledge_weights:[{knowledge_point_id:knowledge,weight_bps:10000}],difficulty_basis:'原创精确十进制运算专项测试元数据'};
    validateQuestion(candidate);
    if(scoreCents(q.scoring_rule.max_score)!==100n)throw Error('MAX_SCORE_CHANGED');
    const authoritative={...candidate,answer:c.expected};
    const score=scoreAnswer(authoritative,{value:q.answer},Decimal128.fromString('1.00'));
    if(score.verdict!=='correct')throw Error('ORACLE_ANSWER_MISMATCH');
    return {status:'pass',contract:'formal_validateQuestion',answer_check:'formal_scoreAnswer_against_authored_oracle',candidate:q,human_quality:'not_reviewed',saved_to_question_bank:false};
  }catch(e){const known=new Set(['NUMERIC_TYPE_REQUIRED','SOURCE_EXPRESSION_CHANGED','MAX_SCORE_CHANGED','ORACLE_ANSWER_MISMATCH']);return {status:'fail',code:known.has(e.message)?e.message:(e.code||'INVALID_NUMERIC_CANDIDATE'),human_quality:'not_reviewed',saved_to_question_bank:false};}
}
module.exports={pack,requestCase,validate};
