<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import {
  demo,
  faults,
  resetDemo,
  type Fault,
  type Role,
} from "../services/core";

const router = useRouter();
const selectedFault = ref<Fault>(demo.fault);

function enter(scenario: "first" | "returning", role: Role) {
  if (
    demo.dirty &&
    !window.confirm("开始新场景会清除当前未保存的演示输入，是否继续？")
  )
    return;
  resetDemo(scenario, role, selectedFault.value);
  void router.push(role === "student" ? "/student" : "/admin");
}
</script>

<template>
  <div class="landing">
    <section class="hero" aria-labelledby="landing-title">
      <div class="hero-copy">
        <p class="kicker">知阶 KNOWLADDER · 初中数学交互原型</p>
        <h1 id="landing-title" tabindex="-1">读懂一节。<br />向前一步。</h1>
        <p class="hero-description">
          从课本出发，在练习中理解，再带着反馈回到学习。<br
            class="wide-only"
          />每一步，都算数。
        </p>
        <div class="actions">
          <button
            class="button"
            type="button"
            @click="enter('first', 'student')"
          >
            开始首次学习 <span aria-hidden="true">→</span>
          </button>
          <button
            class="button secondary"
            type="button"
            @click="enter('returning', 'student')"
          >
            体验继续学习
          </button>
        </div>
        <p class="muted hero-note">选择的是演示场景，不是注册或登录。</p>
      </div>
      <aside class="learning-path" aria-labelledby="path-title">
        <p id="path-title" class="eyebrow">一条完整的学习路径</p>
        <ol class="flow-steps">
          <li>
            <span class="step-number" aria-hidden="true">01</span>
            <div>
              <h2>课本里，找到起点</h2>
              <p>选择章节，阅读原创数学示例。</p>
            </div>
          </li>
          <li>
            <span class="step-number" aria-hidden="true">02</span>
            <div>
              <h2>动手做，再看解析</h2>
              <p>自主练习与测验，保留各自的规则。</p>
            </div>
          </li>
          <li>
            <span class="step-number" aria-hidden="true">03</span>
            <div>
              <h2>看懂反馈，回到学习</h2>
              <p>从已公开的结果回顾章节与错题。</p>
            </div>
          </li>
        </ol>
        <p class="path-footnote">
          阅读位置不等于掌握程度；没有作答证据，不虚构学习结论。
        </p>
      </aside>
    </section>

    <section class="scenario-section" aria-labelledby="scenario-title">
      <div class="section-heading">
        <div>
          <p class="eyebrow">演示设置</p>
          <h2 id="scenario-title">也看见不顺利的那一步</h2>
        </div>
        <span class="tag">内存演示 · 非生产系统</span>
      </div>
      <div class="scenario-settings">
        <div class="field">
          <label for="landing-fault">选择演示条件</label>
          <select
            id="landing-fault"
            v-model="selectedFault"
            aria-describedby="fault-help"
          >
            <option
              v-for="fault in faults"
              :key="fault.value"
              :value="fault.value"
            >
              {{ fault.label }}
            </option>
          </select>
          <p id="fault-help" class="muted">
            选择后，从上方学生入口或下方内容入口开始。异常在对应业务步骤触发；进入后也可用原型工具切换。
          </p>
        </div>
        <div class="scenario-explanation">
          <h3>不是把所有状态都写成“成功”</h3>
          <p>
            体验保存断网、多设备冲突、交卷响应丢失、成绩待发布等情况，观察输入如何保留、状态如何确认，以及下一步如何恢复。
          </p>
        </div>
      </div>
    </section>

    <section class="content-entry" aria-labelledby="content-title">
      <div>
        <p class="eyebrow">内容工作台</p>
        <h2 id="content-title">好内容，也有清晰的来路</h2>
        <p class="muted">
          教材与题目从草稿、送审到发布。编辑与审核职责分开，发布后的版本只读。
        </p>
      </div>
      <div class="content-entry-actions">
        <button
          class="button secondary"
          type="button"
          @click="enter('first', 'editor')"
        >
          以内容编辑身份体验 <span aria-hidden="true">→</span>
        </button>
        <button
          class="button ghost"
          type="button"
          @click="enter('first', 'reviewer')"
        >
          以内容审核身份体验 <span aria-hidden="true">→</span>
        </button>
      </div>
    </section>

    <aside class="prototype-boundary" aria-labelledby="boundary-title">
      <h2 id="boundary-title">使用前，请了解演示边界</h2>
      <p>
        全部教材、题目、批改与学习记录均为演示数据，仅保存在当前页面的内存中；刷新页面或重新开始场景会重置，不会写入真实账户或服务器。
      </p>
      <p>
        角色切换用于交互评审，不代表真实身份认证或生产权限。这里没有正式后端、真实文件上传、智能诊断或云端保存，请勿输入个人信息及未授权内容。
      </p>
    </aside>
  </div>
</template>
