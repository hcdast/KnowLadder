// Editorial learning directions, not enrolment, age verification or resource counts.
export const learningStages = [
  { id: "early", name: "启蒙成长", description: "在陪伴、故事、游戏和生活体验中发现世界。", activities: "亲子阅读 · 表达与观察 · 游戏与运动", support: "家庭陪伴" },
  { id: "school", name: "学校学习", description: "连接学科理解、阅读探索、动手实践与成长反思。", activities: "学科读练 · 科学探究 · 艺体实践", support: "教师与家庭支持" },
  { id: "university", name: "大学与专业", description: "构建专业基础，在研究、项目与跨学科学习中深化理解。", activities: "专业阅读 · 项目研究 · 实验与实习", support: "教师与导师指导" },
  { id: "career", name: "职业发展", description: "围绕工作问题和职业目标，积累可以应用的知识与技能。", activities: "技能学习 · 实操项目 · 团队协作", support: "导师与组织支持" },
  { id: "life", name: "兴趣生活", description: "从自己的好奇与生活需要出发，持续探索和创造。", activities: "语言与艺术 · 生活技能 · 兴趣作品", support: "自主探索与伙伴共学" },
  { id: "senior", name: "银龄学习", description: "按自己的节奏学习数字技能、文化艺术与生活知识。", activities: "数字生活 · 文化阅读 · 社区共学", support: "社区与本人授权的协助" },
] as const;

export const learningFields = [
  { name: "语言与阅读", examples: "阅读、写作、语言表达" },
  { name: "数学与科学", examples: "数学思考、观察与探究" },
  { name: "人文与社会", examples: "历史、文化与社会理解" },
  { name: "艺术与创造", examples: "音乐、美术、设计与作品" },
  { name: "运动与生活", examples: "运动、家庭生活与安全知识" },
  { name: "数字与技术", examples: "数字素养、编程与 AI" },
  { name: "专业与职业", examples: "专业基础、工作技能与实践" },
  { name: "成长与协作", examples: "学习方法、自我管理与合作" },
] as const;
