/** KnowLadder original learning prompts. These are activities, not accredited courses or age verification. */
export const LIFELONG_TEMPLATES = [
  {
    id: "story-observer",
    stage: "early",
    field: "language",
    title: "一起观察，一起讲故事",
    outcome: "用自己的话描述三件看见的事物。",
    resource:
      "找一件家中熟悉的物品，观察颜色、形状和用途。轮流说出一个细节，把这些细节连成一个短故事。",
    activity: "creation",
    steps: [
      "选择安全、熟悉的物品",
      "说出三个观察",
      "画下或口述一个故事",
      "记录最喜欢的发现",
    ],
    reflection: "我发现了什么？下次还想问什么？",
    support:
      "幼儿活动由现实中的照护者陪同；平台当前不代建儿童账号或授予监护权限。",
  },
  {
    id: "water-observer",
    stage: "school",
    field: "science",
    title: "一周用水观察",
    outcome: "用记录支持一个节水建议。",
    resource:
      "只观察日常用水，不接触电器、热水或清洁剂。选一种活动，每天记录发生次数；不需要记录家人姓名。",
    activity: "project",
    steps: [
      "确定一种可观察的用水活动",
      "连续记录三至七天",
      "比较次数变化",
      "写出有证据的节水建议",
    ],
    reflection: "我的记录支持了什么？哪些因素没有观察到？",
    support:
      "需要协助时请现实中的教师或照护者参与；本记录为自述活动，不代替学校评分。",
  },
  {
    id: "source-comparison",
    stage: "higher",
    field: "humanities",
    title: "比较两份公开资料",
    outcome: "区分事实、观点和待验证的推断。",
    resource:
      "选择同一主题的两份可合法阅读的公开资料。只摘录必要的短句并标明来源，优先用自己的话比较。",
    activity: "reading",
    steps: [
      "记录资料标题与出处",
      "分别概括主要观点",
      "找出共同点和分歧",
      "列出一个后续验证问题",
    ],
    reflection: "哪些结论有直接证据？我还缺什么资料？",
    support: "不要复制付费资料、机构内部内容或他人个人信息。",
  },
  {
    id: "work-improvement",
    stage: "career",
    field: "career",
    title: "完成一次小型流程改进",
    outcome: "比较改进前后的可观察结果。",
    resource:
      "选择一个不涉及机密的重复任务，记录步骤和耗时，尝试一个小调整。仅在自己有权限的范围内行动。",
    activity: "practice",
    steps: [
      "描述当前步骤",
      "选择一个可逆调整",
      "在相近条件下试做",
      "记录结果和限制",
    ],
    reflection: "变化来自哪里？结果能否重复？",
    support: "不记录客户、同事、账号或工作秘密；自述结果不等同于职业认证。",
  },
  {
    id: "creative-week",
    stage: "life",
    field: "arts",
    title: "七天创作小册",
    outcome: "保留一次创作过程并完成自我回顾。",
    resource:
      "每天从身边找一个主题，写几句文字、画一张小图或练习一个节奏。使用自己的素材，不需要公开作品。",
    activity: "creation",
    steps: [
      "选择一种表达方式",
      "设定可完成的小目标",
      "记录一次练习过程",
      "回顾最满意和想改进的部分",
    ],
    reflection: "我尝试了什么新方法？下一次如何继续？",
    support: "作品可只以文字记录；当前个人空间不接收未经扫描的文件上传。",
  },
  {
    id: "digital-confidence",
    stage: "senior",
    field: "digital",
    title: "练习一次数字生活操作",
    outcome: "独立说明一个常用操作和求助方法。",
    resource:
      "选一个低风险操作，例如调整字体或查找官方使用帮助。练习前确认页面来源；不转账、不提供验证码或身份证照片。",
    activity: "offline",
    steps: [
      "说出要完成的操作",
      "逐步尝试并写下提示",
      "关掉页面后复述步骤",
      "记录遇到问题时向谁求助",
    ],
    reflection: "哪一步已经熟悉？哪一步需要再练？",
    support:
      "成年人的协助关系由本人授权，可随时撤回；不因年龄自动开放账号或学习记录。",
  },
] as const;
