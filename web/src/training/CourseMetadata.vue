<script setup lang="ts">
type Metadata = { objectives: string; audience: string; prerequisites: string; difficulty: string; estimated_minutes: number; instructor: string; language: string };
defineProps<{ modelValue: Metadata; disabled?: boolean; readonly?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [Metadata] }>();
function update(value: Metadata, key: keyof Metadata, event: Event) {
  const input = event.target as HTMLInputElement;
  emit('update:modelValue', { ...value, [key]: key === 'estimated_minutes' ? Number(input.value) : input.value });
}
const names: Record<string, string> = { introductory: '入门', intermediate: '进阶', advanced: '深入' };
</script>
<template>
  <dl v-if="readonly" class="metadata-read">
    <dt>学习目标</dt><dd>{{ modelValue.objectives }}</dd><dt>适合人群</dt><dd>{{ modelValue.audience }}</dd>
    <dt>难度与投入</dt><dd>{{ names[modelValue.difficulty] }} · 预计 {{ modelValue.estimated_minutes }} 分钟</dd>
    <dt>先修要求</dt><dd>{{ modelValue.prerequisites || '无特别要求' }}</dd><dt>授课者与语言</dt><dd>{{ modelValue.instructor }} · {{ modelValue.language }}</dd>
  </dl>
  <fieldset v-else :disabled="disabled" class="metadata-form"><legend>课程学习说明</legend>
    <label>学习目标<textarea :value="modelValue.objectives" maxlength="2000" required @input="update(modelValue, 'objectives', $event)" /></label>
    <label>适合人群<textarea :value="modelValue.audience" maxlength="1000" required @input="update(modelValue, 'audience', $event)" /></label>
    <label>先修要求<textarea :value="modelValue.prerequisites" maxlength="2000" @input="update(modelValue, 'prerequisites', $event)" /></label>
    <label>难度<select :value="modelValue.difficulty" @change="update(modelValue, 'difficulty', $event)"><option v-for="(name, key) in names" :value="key" :key="key">{{ name }}</option></select></label>
    <label>预计学习分钟<input :value="modelValue.estimated_minutes" type="number" min="1" max="100000" required @input="update(modelValue, 'estimated_minutes', $event)" /></label>
    <label>授课者<input :value="modelValue.instructor" maxlength="200" required @input="update(modelValue, 'instructor', $event)" /></label>
    <label>授课语言<input :value="modelValue.language" maxlength="80" required @input="update(modelValue, 'language', $event)" /></label>
  </fieldset>
</template>
<style scoped>
.metadata-form { display:grid;gap:.8rem;min-width:0; }.metadata-form label {display:grid;gap:.4rem;min-width:0}.metadata-form input,.metadata-form textarea,.metadata-form select{box-sizing:border-box;width:100%;min-height:44px;max-width:100%;font:inherit;padding:.5rem}.metadata-read{overflow-wrap:anywhere}.metadata-read dd{margin:0 0 .7rem;white-space:pre-wrap}.metadata-read dt{font-weight:600}
</style>
