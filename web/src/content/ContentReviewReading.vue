<script setup lang="ts">
import { computed } from 'vue';
import type { ContentOptions, Version } from './types';
const props = defineProps<{ version: Version; source?: Version; options: ContentOptions }>();
const questionTypes = { single: '单选题', multiple: '多选题', numeric: '数值题' };
const knowledgeNames = (ids: string[] = []) => ids.map(id => props.options.knowledge_points.find(row => row.id === id)?.name || '未提供名称的知识点').join('、');
const changes = computed(() => {
  const previous = props.source, current = props.version;
  if (!previous) return [];
  const rows: { title: string; before: string; after: string }[] = [];
  for (const [field, title] of [['title', '标题'], ['prompt', '题干'], ['answer', '标准答案'], ['explanation', '解析']] as const) {
    if (previous[field] !== current[field]) rows.push({ title, before: previous[field] || '未填写', after: current[field] || '未填写' });
  }
  for (const chapter of current.chapters || []) {
    const old = previous.chapters?.find(row => row.id === chapter.id);
    if (!old || old.title !== chapter.title || old.body !== chapter.body || JSON.stringify(old.knowledge_point_ids) !== JSON.stringify(chapter.knowledge_point_ids) || JSON.stringify(old.resource_ids) !== JSON.stringify(chapter.resource_ids) || old.parent_id !== chapter.parent_id || old.position !== chapter.position) {
      rows.push({ title: chapter.title || '新增章节', before: old ? `${old.title}\n${old.body}` : '源版本无此章节', after: `${chapter.title}\n${chapter.body}` });
    }
  }
  for (const old of previous.chapters || []) if (!current.chapters?.some(row => row.id === old.id)) rows.push({ title: old.title, before: old.body, after: '当前版本已移除此章节' });
  return rows;
});
</script>
<template>
  <section class="stack content-section" aria-label="内容阅读与审核">
    <h3>内容与来源</h3>
    <p>授权来源：{{ version.license.source || '尚未填写' }} · {{ version.license.granted ? '已声明取得授权' : '尚未声明取得授权' }}</p>
    <p v-if="version.license.expires_at">授权截止：{{ new Date(version.license.expires_at).toLocaleString('zh-CN') }}</p>
    <template v-if="version.question_type">
      <p>{{ questionTypes[version.question_type] }} · {{ version.difficulty }} · {{ options.subjects.find(row => row.id === version.subject_id)?.name || '学科名称尚未提供' }}</p>
      <p class="reading-body">{{ version.prompt }}</p>
      <ul><li v-for="option in version.options" :key="option.id">{{ option.id }}. {{ option.text }}</li></ul>
      <p>标准答案：{{ version.answer }}</p><p class="reading-body">解析：{{ version.explanation || '尚未填写' }}</p>
      <p>知识点：{{ knowledgeNames(version.knowledge_point_ids) || '尚未关联' }}</p>
      <p>满分：{{ version.scoring_rule?.max_score || '尚未配置' }}</p><p>难度依据：{{ version.difficulty_basis || '尚未填写' }}</p>
    </template>
    <template v-else>
      <p v-if="!version.chapters?.length">此版本尚无章节。</p>
      <article v-for="(chapter, index) in version.chapters" :key="chapter.id" class="stack content-section">
        <h3>{{ index + 1 }}. {{ chapter.title }}</h3>
        <p v-if="chapter.parent_id" class="field-help">上级：{{ version.chapters?.find(row => row.id === chapter.parent_id)?.title || '未提供名称' }}</p>
        <p class="reading-body">{{ chapter.body || '尚未填写正文' }}</p>
        <p v-if="chapter.knowledge_point_ids.length" class="field-help">关联知识点：{{ knowledgeNames(chapter.knowledge_point_ids) }}</p>
        <p v-if="chapter.resource_ids.length" class="field-help">本章 {{ chapter.resource_ids.length }} 个附件，可在下方附件区查看。</p>
      </article>
    </template>
    <details v-if="source"><summary>与源版本的变更</summary><p v-if="!changes.length">标题、题干与章节未发现变更；完整字段见高级原始记录。</p><article v-for="(change, index) in changes" :key="index" class="content-section stack"><h4>{{ change.title }}</h4><div class="content-columns"><section><h5>源版本</h5><p class="reading-body">{{ change.before }}</p></section><section><h5>当前版本</h5><p class="reading-body">{{ change.after }}</p></section></div></article><p class="field-help">以上为正文/章节变更摘要，授权、评分和其他字段以完整记录为准。</p></details>
  </section>
</template>
