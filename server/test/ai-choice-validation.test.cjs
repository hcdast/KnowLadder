'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const {pack,validate,requestCase}=require('../../ops/ai-evaluation/choice-validation.cjs');
function candidate(c){return {question_type:c.question_type,prompt:c.prompt,options:c.options,answer:c.expected,explanation:c.basis,scoring_rule:{version:1,strategy:c.question_type==='single'?'single_exact':'multiple_exact_set',max_score:'1'}};}
test('选择题原创标准答案通过正式契约和评分器，标准答案不发给模型',()=>{for(const c of pack.cases){assert.equal(validate(c,JSON.stringify(candidate(c))).status,'pass');assert.ok(!JSON.stringify(requestCase(c)).includes(c.basis));}});
test('多选允许答案顺序变化，但少选、多选及重复答案拒绝',()=>{const c=pack.cases[2];for(const [answer,status] of [['C,A','pass'],['A','fail'],['A,B,C','fail'],['A,A,C','fail']])assert.equal(validate(c,JSON.stringify({...candidate(c),answer})).status,status);});
test('错误单选、来源被改、未知字段及策略错配拒绝',()=>{const c=pack.cases[0];for(const patch of [{answer:'A'},{prompt:'新题干'},{options:[...c.options,{id:'D',text:'7'}]},{publish:true},{scoring_rule:{version:1,strategy:'multiple_exact_set',max_score:'1'}}])assert.equal(validate(c,JSON.stringify({...candidate(c),...patch})).status,'fail');});
